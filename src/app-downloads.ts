import { invoke } from "./ipc.ts";
import {
  captureConnectionSnapshot,
  connectionSnapshotChanged,
  invokeS3For,
  type ConnectionSnapshot,
} from "./connection.ts";
import {
  pickDownloadDirectory,
  pickDownloadFile,
  type NativePathGrant,
} from "./path-grants.ts";
import { state } from "./state.ts";
import {
  enqueueDownloads,
  type EnqueueResult,
  type TransferEnqueueTarget,
} from "./transfers.ts";
import { showConfirm } from "./dialogs.ts";
import { logActivity } from "./activity-log.ts";
import {
  formatSize,
  splitNameExt,
  joinPath,
  friendlyError,
  plural,
  safeFileName,
} from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { getSelectedFileKeys } from "./app-selection.ts";
import { resolveDownloadEntriesWithConflicts } from "./app-conflicts.ts";
import type { ConflictPolicy } from "./settings-model.ts";

export interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
  /** Backend grant for the chosen file or folder. */
  destinationToken: string;
  /** File name when the grant is a folder. */
  destinationName?: string;
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

/**
 * Grants are session memory. Remember the last folder's reveal grant so
 * "Open download folder" keeps working without asking again; after a restart
 * the command opens a native picker instead of trusting localStorage.
 */
let rememberedDirectoryGrant: { directory: string; token: string } | null =
  null;

function rememberDirectoryGrant(grant: NativePathGrant): void {
  const directory = grant.directoryPath ?? (grant.isDir ? grant.path : "");
  const token = grant.directoryToken ?? (grant.isDir ? grant.token : null);
  if (!directory || !token) return;
  rememberedDirectoryGrant = { directory, token };
}

function revealTokenForRememberedDirectory(directory: string): string | null {
  if (!rememberedDirectoryGrant) return null;
  return rememberedDirectoryGrant.directory === directory
    ? rememberedDirectoryGrant.token
    : null;
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
  bucket: string,
  destinationToken: string,
): Promise<DownloadQueueEntry[]> {
  const taken = new Set<string>();
  const entries: DownloadQueueEntry[] = [];
  const caseInsensitive =
    state.platformName === "windows" || state.platformName === "macos";
  const dedupeKey = (name: string) =>
    caseInsensitive ? name.normalize("NFC").toLowerCase() : name;

  for (const key of keys) {
    const base = safeFileName(key, state.platformName);
    const { stem, ext } = splitNameExt(base);
    let candidate = base;
    let n = 2;
    while (taken.has(dedupeKey(candidate))) {
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    }
    taken.add(dedupeKey(candidate));
    entries.push({
      bucket,
      key,
      destination: joinPath(destinationDir, candidate, state.platformName),
      destinationToken,
      destinationName: candidate,
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
  connectionId: string,
): Promise<number | null> {
  const known = estimateKnownObjectSize(entry);
  if (known !== null) return known;
  try {
    const head = await invokeS3For<HeadObjectSummary>(
      connectionId,
      "head_object",
      {
        bucket: entry.bucket,
        key: entry.key,
      },
    );
    if (!Number.isFinite(head.content_length) || head.content_length < 0)
      return null;
    return head.content_length;
  } catch {
    // Unknown, not zero: a zero would silently skip the disk preflight below.
    return null;
  }
}

async function preflightDownloadDiskSpace(
  entries: DownloadQueueEntry[],
  connectionId: string,
): Promise<boolean> {
  if (entries.length === 0) return true;

  const estimatedBytes = await Promise.all(
    entries.map((entry) => estimateDownloadEntryBytes(entry, connectionId)),
  );
  if (estimatedBytes.some((bytes) => bytes === null)) {
    // Fail open and say so: proceeding without a preflight is honest, while a
    // zero estimate would pretend small downloads need no disk check.
    logActivity(
      "Disk preflight skipped: could not determine every download size.",
      "warning",
    );
    return true;
  }
  const knownBytes = estimatedBytes as number[];
  const totalEstimatedBytes = knownBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (totalEstimatedBytes < DOWNLOAD_DISK_PREFLIGHT_THRESHOLD_BYTES) {
    return true;
  }

  const requiredByDirectory = new Map<
    string,
    { required: number; token: string }
  >();
  for (let i = 0; i < entries.length; i += 1) {
    const dir = parentDirectory(entries[i].destination);
    if (!dir) continue;
    const size = knownBytes[i];
    if (!Number.isFinite(size) || size <= 0) continue;
    const existing = requiredByDirectory.get(dir);
    requiredByDirectory.set(dir, {
      required: (existing?.required ?? 0) + size,
      token: existing?.token ?? entries[i].destinationToken,
    });
  }
  if (requiredByDirectory.size === 0) return true;

  const shortages: Array<{ dir: string; required: number; available: number }> =
    [];
  for (const [dir, requirement] of requiredByDirectory) {
    const { required, token } = requirement;
    if (!token) continue;
    try {
      const available = await invoke<number>("get_available_disk_bytes", {
        token,
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

function enqueueTargetFromSnapshot(
  snap: ConnectionSnapshot,
): TransferEnqueueTarget {
  return {
    bucket: snap.bucket,
    connectionId: snap.connectionId,
    connectionIdentity: snap.connectionIdentity,
  };
}

function enqueueDownloadTransfers(
  entries: DownloadQueueEntry[],
  target: TransferEnqueueTarget,
): EnqueueResult {
  return enqueueDownloads(entries, target);
}

export async function handleDownload(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;
  let snap: ConnectionSnapshot;
  try {
    snap = captureConnectionSnapshot();
  } catch {
    setStatus("Connect to a bucket first.", 5000);
    return;
  }
  const capturedKeys = [...keys];
  const entries: DownloadQueueEntry[] = [];
  if (capturedKeys.length === 1) {
    const fileName = safeFileName(capturedKeys[0], state.platformName);
    let grant: NativePathGrant | null;
    try {
      grant = await pickDownloadFile(fileName, `Save ${fileName}`);
    } catch (err) {
      setStatus(`Failed to open save dialog: ${friendlyError(err)}`);
      return;
    }
    if (!grant) return;
    if (connectionSnapshotChanged(snap)) {
      setStatus(
        "Download cancelled because connection or location changed.",
        5000,
      );
      return;
    }
    saveRememberedDownloadDir(grant.path);
    rememberDirectoryGrant(grant);
    // The save dialog already asked the user about replacing an existing file,
    // so that answer is the confirmed replace; no second prompt follows.
    entries.push({
      bucket: snap.bucket,
      key: capturedKeys[0],
      destination: grant.path,
      destinationToken: grant.token,
      conflictResolution: "replace",
    });
  } else {
    let grant: NativePathGrant | null;
    try {
      grant = await pickDownloadDirectory();
    } catch (err) {
      setStatus(`Failed to open folder picker: ${friendlyError(err)}`);
      return;
    }
    if (!grant) return;
    if (connectionSnapshotChanged(snap)) {
      setStatus(
        "Download cancelled because connection or location changed.",
        5000,
      );
      return;
    }
    saveRememberedDownloadDirectoryValue(grant.path);
    rememberDirectoryGrant(grant);
    entries.push(
      ...(await uniqueDownloadEntries(
        capturedKeys,
        grant.path,
        snap.bucket,
        grant.token,
      )),
    );
  }

  if (entries.length === 0) return;
  if (connectionSnapshotChanged(snap)) {
    setStatus(
      "Download cancelled because connection or location changed.",
      5000,
    );
    return;
  }
  const resolvedEntries =
    capturedKeys.length === 1
      ? entries
      : await resolveDownloadEntriesWithConflicts(entries);
  if (connectionSnapshotChanged(snap)) {
    setStatus(
      "Download cancelled because connection or location changed.",
      5000,
    );
    return;
  }
  if (resolvedEntries.length === 0) {
    setStatus("No downloads queued (all conflicts were skipped).", 5000);
    return;
  }
  if (!(await preflightDownloadDiskSpace(resolvedEntries, snap.connectionId))) {
    return;
  }
  if (connectionSnapshotChanged(snap)) {
    setStatus(
      "Download cancelled because connection or location changed.",
      5000,
    );
    return;
  }

  // Downloads always go through the transfer queue, which owns transfer ids,
  // progress, cancellation and resume. The direct `download_object` loop that
  // used to follow this was unreachable (its guard could not be false) and had
  // drifted out of sync with the command, omitting the required transfer id.
  // enqueueDownloads logs the accepted count itself.
  const result = enqueueDownloadTransfers(
    resolvedEntries,
    enqueueTargetFromSnapshot(snap),
  );
  if (!result.accepted) {
    setStatus(result.reason ?? "Download not queued.", 8000);
    return;
  }
  setStatus(`Queued ${plural(result.count, "download")}.`, 5000);
}

export async function handleOpenLastDownloadFolder(): Promise<void> {
  const dir = getRememberedDownloadDir();
  if (!dir) {
    setStatus("No remembered download folder.", 5000);
    return;
  }
  try {
    let token = revealTokenForRememberedDirectory(dir);
    if (!token) {
      // Grants end with the session. Ask the user to confirm the remembered
      // folder in a native picker instead of trusting the stored path.
      const grant = await pickDownloadDirectory("Open download folder");
      if (!grant) return;
      rememberDirectoryGrant(grant);
      token = grant.directoryToken ?? grant.token;
    }
    await invoke("open_local_path", { token });
    setStatus("Opened last download folder.", 3000);
  } catch (err) {
    setStatus(`Failed to open folder: ${friendlyError(err)}`);
  }
}
