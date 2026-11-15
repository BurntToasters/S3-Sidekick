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
  basename,
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

function pathLeaf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const SHELL_STARTUP_NAMES = new Set([
  ".zshenv",
  ".zprofile",
  ".zshrc",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".login",
  ".logout",
  ".cshrc",
  ".tcshrc",
  ".kshrc",
  "config.fish",
  "profile.ps1",
  "microsoft.powershell_profile.ps1",
]);

function isShellStartupOrDotfile(name: string): boolean {
  const normalized = name.normalize("NFC").trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith(".") || SHELL_STARTUP_NAMES.has(normalized);
}

function encodeDotName(name: string): string {
  return name.replace(
    /[.]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Match the backend's child-name rules before deduplication.
 *
 * `path_authority::validate_child_name` trims the name and rejects path
 * separators on every platform, including backslashes that Unix filesystems
 * would otherwise accept. Trim first so a key like `"notes.txt "` cannot
 * dedupe separately from `"notes.txt"` and then collide after the backend
 * trims it. Encode a backslash rather than ever sending a name the backend
 * must reject.
 */
function downloadChildName(key: string, platform: string): string {
  let name = safeFileName(key, platform).normalize("NFC").trim();
  if (!name) name = "unnamed";
  if (name === "." || name === "..") name = encodeDotName(name);
  return name.replace(/\\/g, "%5C");
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
    const base = downloadChildName(key, state.platformName);
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
    // Fail closed (M3): an unknown size is not proof of free space. The old
    // fail-open behaviour let a long queue exhaust the destination mid-way
    // with no warning at all.
    logActivity(
      "Disk preflight refused the queue: could not determine every download size.",
      "error",
    );
    setStatus(
      "Download queue refused: object sizes could not be confirmed, so free space was not verified.",
      8000,
    );
    return false;
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
      // A failed probe is not evidence of free space (M3). Fail closed.
      logActivity(
        `Disk preflight failed for ${dir}: ${friendlyError(err)}`,
        "error",
      );
      setStatus(
        `Download queue refused: free space for ${dir} could not be verified.`,
        8000,
      );
      return false;
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
    "Low disk space",
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
      grant = await pickDownloadFile(
        fileName,
        `Save ${fileName}`,
        getRememberedDownloadDir(),
      );
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
    const destinationName = grant.name || pathLeaf(grant.path);
    if (isShellStartupOrDotfile(destinationName)) {
      const replace = await showConfirm(
        "Replace shell startup file?",
        `${destinationName} is a shell startup file or dotfile. Replacing it can change how your shell or tools start. Download over it?`,
        {
          okLabel: "Download and replace",
          cancelLabel: "Cancel",
          okDanger: true,
        },
      );
      if (!replace) {
        setStatus("Download cancelled: shell startup file not replaced.", 5000);
        return;
      }
    }
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
      grant = await pickDownloadDirectory(
        undefined,
        getRememberedDownloadDir(),
      );
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
  let resolvedEntries =
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
  const sensitiveEntries = resolvedEntries.filter((entry) =>
    isShellStartupOrDotfile(
      entry.destinationName ?? pathLeaf(entry.destination),
    ),
  );
  if (sensitiveEntries.length > 0) {
    const names = sensitiveEntries
      .slice(0, 3)
      .map((entry) => entry.destinationName ?? pathLeaf(entry.destination))
      .join(", ");
    const extra =
      sensitiveEntries.length > 3
        ? ` and ${sensitiveEntries.length - 3} more`
        : "";
    const replace = await showConfirm(
      "Replace shell startup files?",
      `${names}${extra} ${sensitiveEntries.length === 1 ? "is a shell startup file or dotfile" : "are shell startup files or dotfiles"}. Replacing them can change how your shell or tools start. Download them?`,
      {
        okLabel: "Download selected",
        cancelLabel: "Skip them",
        okDanger: true,
      },
    );
    if (!replace) {
      const skipped = new Set(sensitiveEntries);
      resolvedEntries = resolvedEntries.filter((entry) => !skipped.has(entry));
      for (const entry of sensitiveEntries) {
        logActivity(
          `Skipped download for ${basename(entry.key)}: shell startup or dotfile destination was not replaced.`,
          "warning",
        );
      }
      if (resolvedEntries.length === 0) {
        setStatus(
          "No downloads queued: shell startup files were skipped.",
          5000,
        );
        return;
      }
    }
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
      const grant = await pickDownloadDirectory("Open download folder", dir);
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
