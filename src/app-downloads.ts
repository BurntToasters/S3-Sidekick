import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { state } from "./state.ts";
import { enqueueDownloads } from "./transfers.ts";
import { showConfirm } from "./dialogs.ts";
import { logActivity } from "./activity-log.ts";
import {
  basename,
  formatSize,
  splitNameExt,
  joinPath,
  friendlyError,
} from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { getSelectedFileKeys } from "./app-selection.ts";
import { resolveDownloadEntriesWithConflicts } from "./app-conflicts.ts";
import type { ConflictPolicy } from "./settings-model.ts";

export interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
  conflictResolution?: Exclude<ConflictPolicy, "ask">;
}

interface HeadObjectSummary {
  content_length: number;
}

const LAST_DOWNLOAD_DIR_STORAGE_KEY = "s3-sidekick.last-download-dir";
const RECENT_DOWNLOAD_DIRS_STORAGE_KEY = "s3-sidekick.recent-download-dirs.v1";
const RECENT_DESTINATION_LIMIT = 8;
const DOWNLOAD_DISK_PREFLIGHT_THRESHOLD_BYTES = 128 * 1024 * 1024;

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function readRecentDownloadDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DOWNLOAD_DIRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, RECENT_DESTINATION_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentDownloadDirs(dirs: string[]): void {
  try {
    localStorage.setItem(
      RECENT_DOWNLOAD_DIRS_STORAGE_KEY,
      JSON.stringify(dirs.slice(0, RECENT_DESTINATION_LIMIT)),
    );
  } catch {
    // best effort
  }
}

function rememberDownloadDirectory(dir: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  const normalized = dir.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(LAST_DOWNLOAD_DIR_STORAGE_KEY, normalized);
  } catch {
    // best effort
  }
  const updated = readRecentDownloadDirs().filter(
    (entry) => entry !== normalized,
  );
  updated.unshift(normalized);
  writeRecentDownloadDirs(updated);
}

export function getRememberedDownloadDir(): string {
  try {
    const direct = localStorage.getItem(LAST_DOWNLOAD_DIR_STORAGE_KEY);
    if (direct && direct.trim().length > 0) return direct;
    return readRecentDownloadDirs()[0] ?? "";
  } catch {
    return "";
  }
}

function saveRememberedDownloadDir(path: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  const dir = parentDirectory(path);
  if (!dir) return;
  rememberDownloadDirectory(dir);
}

function saveRememberedDownloadDirectoryValue(dir: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  if (!dir) return;
  rememberDownloadDirectory(dir);
}

async function uniqueDownloadEntries(
  keys: string[],
  destinationDir: string,
): Promise<DownloadQueueEntry[]> {
  const taken = new Set<string>();
  const entries: DownloadQueueEntry[] = [];
  const caseInsensitive =
    state.platformName === "windows" || state.platformName === "macos";
  const dedupeKey = (name: string) =>
    caseInsensitive ? name.toLowerCase() : name;

  for (const key of keys) {
    const base = basename(key);
    const { stem, ext } = splitNameExt(base);
    let candidate = base;
    let n = 2;
    while (taken.has(dedupeKey(candidate))) {
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    }
    taken.add(dedupeKey(candidate));
    entries.push({
      bucket: state.currentBucket,
      key,
      destination: joinPath(destinationDir, candidate, state.platformName),
    });
  }

  return entries;
}

function estimateKnownObjectSize(entry: DownloadQueueEntry): number | null {
  if (entry.bucket !== state.currentBucket) return null;
  const match = state.objects.find((obj) => obj.key === entry.key);
  if (!match) return null;
  return Number.isFinite(match.size) && match.size >= 0 ? match.size : null;
}

async function estimateDownloadEntryBytes(
  entry: DownloadQueueEntry,
): Promise<number> {
  const known = estimateKnownObjectSize(entry);
  if (known !== null) return known;
  try {
    const head = await invoke<HeadObjectSummary>("head_object", {
      bucket: entry.bucket,
      key: entry.key,
    });
    if (!Number.isFinite(head.content_length) || head.content_length < 0)
      return 0;
    return head.content_length;
  } catch {
    return 0;
  }
}

async function preflightDownloadDiskSpace(
  entries: DownloadQueueEntry[],
): Promise<boolean> {
  if (entries.length === 0) return true;

  const estimatedBytes = await Promise.all(
    entries.map((entry) => estimateDownloadEntryBytes(entry)),
  );
  const totalEstimatedBytes = estimatedBytes.reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  if (totalEstimatedBytes < DOWNLOAD_DISK_PREFLIGHT_THRESHOLD_BYTES) {
    return true;
  }

  const requiredByDirectory = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const dir = parentDirectory(entries[i].destination);
    if (!dir) continue;
    const size = estimatedBytes[i];
    if (!Number.isFinite(size) || size <= 0) continue;
    requiredByDirectory.set(dir, (requiredByDirectory.get(dir) ?? 0) + size);
  }
  if (requiredByDirectory.size === 0) return true;

  const shortages: Array<{ dir: string; required: number; available: number }> =
    [];
  for (const [dir, required] of requiredByDirectory) {
    try {
      const available = await invoke<number>("get_available_disk_bytes", {
        path: dir,
      });
      if (!Number.isFinite(available) || available < 0) continue;
      if (available < required) {
        shortages.push({ dir, required, available });
      }
    } catch (err) {
      logActivity(
        `Disk preflight warning for ${dir}: ${friendlyError(err)}`,
        "warning",
      );
    }
  }
  if (shortages.length === 0) return true;

  const lines = shortages
    .slice(0, 3)
    .map(
      (row) =>
        `${row.dir} — need ${formatSize(row.required)}, have ${formatSize(row.available)}`,
    );
  if (shortages.length > 3) {
    lines.push(`+${shortages.length - 3} more destination(s)`);
  }
  const proceed = await showConfirm(
    "Low Disk Space",
    `Destination free space may be insufficient:\n${lines.join("\n")}\n\nQueue downloads anyway?`,
    { okLabel: "Queue anyway", cancelLabel: "Cancel queue", okDanger: true },
  );
  if (!proceed) {
    setStatus("Download queue cancelled by disk-space preflight.", 5000);
  }
  return proceed;
}

function enqueueDownloadTransfers(entries: DownloadQueueEntry[]): boolean {
  enqueueDownloads(entries);
  return true;
}

export async function handleDownload(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;
  const entries: DownloadQueueEntry[] = [];
  const rememberedDir = getRememberedDownloadDir();

  if (keys.length === 1) {
    const fileName = basename(keys[0]);
    const destination = await save({
      defaultPath: rememberedDir
        ? joinPath(rememberedDir, fileName, state.platformName)
        : fileName,
      title: `Save ${fileName}`,
    });
    if (!destination) return;
    saveRememberedDownloadDir(destination);
    entries.push({
      bucket: state.currentBucket,
      key: keys[0],
      destination,
    });
  } else {
    const selected = await open({
      title: "Select destination folder",
      multiple: false,
      directory: true,
      defaultPath: rememberedDir || undefined,
    });
    if (!selected || Array.isArray(selected)) return;
    saveRememberedDownloadDirectoryValue(selected);
    entries.push(...(await uniqueDownloadEntries(keys, selected)));
  }

  if (entries.length === 0) return;
  const resolvedEntries = await resolveDownloadEntriesWithConflicts(entries);
  if (resolvedEntries.length === 0) {
    setStatus("No downloads queued (all conflicts were skipped).", 5000);
    return;
  }
  if (!(await preflightDownloadDiskSpace(resolvedEntries))) {
    return;
  }

  if (enqueueDownloadTransfers(resolvedEntries)) {
    setStatus(`Queued ${resolvedEntries.length} download(s).`, 5000);
    logActivity(`Queued ${resolvedEntries.length} download(s).`, "info");
    return;
  }

  for (const entry of resolvedEntries) {
    try {
      setStatus(`Downloading ${basename(entry.key)}...`);
      const size = await invoke<number>("download_object", {
        bucket: entry.bucket,
        key: entry.key,
        destination: entry.destination,
        overwrite: entry.conflictResolution === "replace",
        tempPath: `${entry.destination}.s3-sidekick.download.tmp`,
        attempt: 1,
        checksumVerification:
          state.currentSettings.enableTransferChecksumVerification,
      });
      setStatus(
        `Downloaded ${basename(entry.key)} (${formatSize(size)}).`,
        5000,
      );
      logActivity(
        `Downloaded ${basename(entry.key)} (${formatSize(size)}).`,
        "success",
      );
    } catch (err) {
      setStatus(
        `Download failed for ${basename(entry.key)}: ${friendlyError(err)}`,
      );
      logActivity(
        `Download failed for ${basename(entry.key)}: ${friendlyError(err)}`,
        "error",
      );
    }
  }
}

export async function handleOpenLastDownloadFolder(): Promise<void> {
  const dir = getRememberedDownloadDir();
  if (!dir) {
    setStatus("No remembered download folder.", 5000);
    return;
  }
  try {
    await invoke("open_local_path", { path: dir });
    setStatus("Opened last download folder.", 3000);
  } catch (err) {
    setStatus(`Failed to open folder: ${friendlyError(err)}`);
  }
}
