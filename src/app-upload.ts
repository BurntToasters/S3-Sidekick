import { invoke } from "./ipc.ts";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  pickUploadFiles,
  pickUploadFolder,
  takeDroppedUploadGrants,
  type NativePathGrant,
} from "./path-grants.ts";
import {
  captureConnectionSnapshot,
  connectionSnapshotChanged,
  type ConnectionSnapshot,
} from "./connection.ts";
import { state } from "./state.ts";
import {
  enqueuePaths,
  enqueueFolderEntries,
  type EnqueueResult,
  type TransferEnqueueTarget,
} from "./transfers.ts";
import { logActivity } from "./activity-log.ts";
import { friendlyError, plural } from "./utils.ts";
import { setStatus } from "./app-status.ts";

export interface LocalFolderFileEntry {
  file_path: string;
  relative_path: string;
  size: number;
  file_token: string;
}

export interface LocalFolderScanResult {
  entries: LocalFolderFileEntry[];
  warnings: string[];
  warning_count: number;
}

const LAST_UPLOAD_ROOT_STORAGE_KEY = "s3-sidekick.last-upload-root";

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

/** Last folder used for an upload picker, when the user opted to remember it. */
export function getRememberedUploadRoot(): string {
  try {
    const value = localStorage.getItem(LAST_UPLOAD_ROOT_STORAGE_KEY);
    return value?.trim() ?? "";
  } catch {
    return "";
  }
}

function rememberUploadRoot(path: string, isDir: boolean): void {
  const root = isDir ? path : parentDirectory(path);
  if (!root) return;
  try {
    localStorage.setItem(LAST_UPLOAD_ROOT_STORAGE_KEY, root);
  } catch {
    // Best effort: the picker still works without a remembered root.
  }
}

interface TrackedNativeDrop {
  id: number;
  paths: string[];
  grants: NativePathGrant[];
}

let dropSequence = 0;
let trackedDrop: TrackedNativeDrop | null = null;
let dropDrain: { id: number; promise: Promise<void> } | null = null;
let dropTrackerActive = false;
let dropTrackerRegistration: Promise<void> | null = null;
let escapedNativeDrop = false;

function normalizeDropPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return state.platformName === "windows" || state.platformName === "macos"
    ? normalized.toLowerCase()
    : normalized;
}

function grantBelongsToDrop(
  grant: NativePathGrant,
  dropPaths: readonly string[],
): boolean {
  const grantPath = normalizeDropPath(grant.path);
  return dropPaths.some((path) => normalizeDropPath(path) === grantPath);
}

function discardDropGrants(
  dropId: number,
  grants: readonly NativePathGrant[],
  reason: string,
): void {
  if (grants.length === 0) return;
  logActivity(
    `Discarded ${plural(grants.length, "dropped item")} from drop ${dropId} (${reason}).`,
    "warning",
  );
}

/**
 * The Rust drop command has no drop id and no discard command: it drains one
 * process-wide queue. Track each native drop here, drain that queue as soon as
 * the event arrives, and only hand the grants to the drop that actually
 * produced them. Ignored drops discard their grants immediately so a later
 * accepted drop cannot inherit them.
 */
function handleNativeDropEvent(payload: {
  type: string;
  paths?: string[];
}): void {
  if (payload.type === "enter" || payload.type === "leave") {
    escapedNativeDrop = false;
    return;
  }
  if (payload.type !== "drop") return;

  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  const accepted =
    !escapedNativeDrop &&
    paths.length > 0 &&
    state.connected &&
    Boolean(state.currentBucket) &&
    !document.body.classList.contains("modal-open");
  escapedNativeDrop = false;
  const dropId = ++dropSequence;

  if (trackedDrop) {
    discardDropGrants(
      trackedDrop.id,
      trackedDrop.grants,
      "a newer drop replaced it",
    );
    trackedDrop = null;
  }

  const promise = takeDroppedUploadGrants()
    .then((grants) => {
      // A newer drop arrived while the drain was in flight; its event owns the
      // grants now, so do not publish this older result.
      if (dropId !== dropSequence) {
        discardDropGrants(dropId, grants, "superseded by a newer drop");
        return;
      }
      if (accepted) {
        trackedDrop = { id: dropId, paths, grants };
      } else {
        discardDropGrants(
          dropId,
          grants,
          "ignored drop: escaped, modal open, or not connected",
        );
      }
    })
    .catch((err) => {
      if (accepted && dropId === dropSequence) {
        trackedDrop = { id: dropId, paths, grants: [] };
      }
      logActivity(
        `Could not prepare native drop ${dropId}: ${friendlyError(err)}`,
        "warning",
      );
    });
  dropDrain = { id: dropId, promise };
}

function installNativeDropTracker(): void {
  if (dropTrackerRegistration) return;
  dropTrackerRegistration = (async () => {
    try {
      await getCurrentWebview().onDragDropEvent((event) => {
        handleNativeDropEvent(
          event.payload as { type: string; paths?: string[] },
        );
      });
      dropTrackerActive = true;
      if (typeof document !== "undefined") {
        document.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          const overlay = document.getElementById("drop-zone-overlay");
          if (overlay && !(overlay as HTMLElement).hidden) {
            escapedNativeDrop = true;
          }
        });
      }
    } catch {
      // Native drag/drop is unavailable (tests, browser preview). Calls fall
      // back to the backend queue without path filtering.
      dropTrackerActive = false;
    }
  })();
}

void installNativeDropTracker();

async function waitForTrackedDrop(): Promise<TrackedNativeDrop | null> {
  if (!dropTrackerActive) return null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (trackedDrop) return trackedDrop;
    if (dropDrain) {
      await dropDrain.promise.catch(() => undefined);
      if (trackedDrop) return trackedDrop;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return trackedDrop;
}

function filterGrantsToDrop(
  grants: NativePathGrant[],
  dropPaths: readonly string[],
): NativePathGrant[] {
  const matched: NativePathGrant[] = [];
  let leaked = 0;
  for (const grant of grants) {
    if (grantBelongsToDrop(grant, dropPaths)) matched.push(grant);
    else leaked += 1;
  }
  if (leaked > 0) {
    logActivity(
      `Discarded ${plural(leaked, "dropped grant")} that did not belong to the current drop.`,
      "warning",
    );
  }
  return matched;
}

function describeScanWarnings(scan: LocalFolderScanResult): string {
  if (scan.warning_count <= 0) return "";
  const sample = scan.warnings[0] ? ` ${scan.warnings[0]}` : "";
  return ` Skipped ${plural(scan.warning_count, "path")}.${sample}`;
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

function captureUploadSnapshot(): ConnectionSnapshot | null {
  try {
    return captureConnectionSnapshot();
  } catch {
    setStatus("Connect to a bucket first.");
    return null;
  }
}

function destinationChanged(snap: ConnectionSnapshot): boolean {
  return connectionSnapshotChanged(snap);
}

function enqueueFolderTransfers(
  entries: LocalFolderFileEntry[],
  targetPrefix: string,
  target: TransferEnqueueTarget,
): EnqueueResult {
  return enqueueFolderEntries(entries, targetPrefix, target);
}

/** Reports a refused enqueue in the status line; never says "Queued" for it. */
function reportRefusedEnqueue(result: EnqueueResult): void {
  setStatus(result.reason ?? "Upload not queued.", 8000);
}

export async function handleUploadButton(): Promise<void> {
  const snap = captureUploadSnapshot();
  if (!snap) return;

  let selected: NativePathGrant[];
  try {
    selected = await pickUploadFiles(getRememberedUploadRoot());
  } catch (err) {
    setStatus(`Failed to open file picker: ${String(err)}`);
    return;
  }
  if (selected.length === 0) return;
  if (destinationChanged(snap)) {
    setStatus("Upload cancelled because destination changed.", 5000);
    return;
  }
  const firstFile = selected.find((grant) => !grant.isDir);
  if (firstFile) rememberUploadRoot(firstFile.path, false);

  const files = selected
    .filter((grant) => !grant.isDir && grant.token.length > 0)
    .map((grant) => ({
      path: grant.path,
      token: grant.token,
      size: grant.size,
    }));
  if (files.length > 0) {
    const result = enqueuePaths(
      files,
      snap.prefix,
      enqueueTargetFromSnapshot(snap),
    );
    if (!result.accepted) reportRefusedEnqueue(result);
  }
}

export async function handleUploadFolderButton(): Promise<void> {
  const snap = captureUploadSnapshot();
  if (!snap) return;

  let selected: NativePathGrant[];
  try {
    selected = await pickUploadFolder(getRememberedUploadRoot());
  } catch (err) {
    setStatus(`Failed to open folder picker: ${String(err)}`);
    return;
  }
  if (selected.length === 0) return;

  const rootTokens = selected
    .filter((grant) => grant.isDir && grant.token.length > 0)
    .map((grant) => grant.token);
  if (rootTokens.length === 0) return;
  const firstRoot = selected.find(
    (grant) => grant.isDir && grant.token.length > 0,
  );
  if (firstRoot) rememberUploadRoot(firstRoot.path, true);
  if (destinationChanged(snap)) {
    setStatus("Folder upload cancelled because destination changed.", 5000);
    return;
  }

  try {
    setStatus("Scanning folder(s)...");
    const scan = await invoke<LocalFolderScanResult>(
      "list_local_files_recursive",
      { rootTokens },
    );

    if (destinationChanged(snap)) {
      setStatus("Folder upload cancelled because destination changed.", 5000);
      return;
    }

    if (scan.warning_count > 0) {
      logActivity(
        `Folder upload skipped ${plural(scan.warning_count, "path")}: ${scan.warnings.join(" | ")}`,
        "error",
      );
    }

    if (scan.entries.length === 0) {
      setStatus("Selected folder(s) contain no files.", 5000);
      return;
    }

    const target = enqueueTargetFromSnapshot(snap);
    const result = enqueueFolderTransfers(scan.entries, snap.prefix, target);
    if (!result.accepted) {
      reportRefusedEnqueue(result);
      return;
    }
    setStatus(
      `Queued ${plural(result.count, "file")} from folder upload.${describeScanWarnings(scan)}`,
      5000,
    );
  } catch (err) {
    setStatus(`Folder upload failed: ${friendlyError(err)}`);
    logActivity(`Folder upload failed: ${friendlyError(err)}`, "error");
  }
}

export async function queueDroppedPaths(
  targetPrefix: string,
  currentDropPaths?: readonly string[],
): Promise<void> {
  const snap = captureUploadSnapshot();
  if (!snap) return;
  const destPrefix = targetPrefix;

  const targetUnchanged = (): boolean =>
    !destinationChanged(snap) && state.currentPrefix === destPrefix;
  const target = enqueueTargetFromSnapshot(snap);

  try {
    // The backend minted these grants from the native drop event. The paths in
    // the DOM event are display data; using them as authority would let a
    // compromised webview nominate any file.
    let grants: NativePathGrant[];
    let dropPaths: readonly string[] | undefined = currentDropPaths;
    grants = await takeDroppedUploadGrants();
    if (!dropPaths && trackedDrop) {
      // The native drop tracker may have drained part of the same event while
      // this call was in flight. Merge its grants and use its event paths so
      // leftovers from an earlier ignored drop are filtered out.
      dropPaths = trackedDrop.paths;
      grants = [...grants, ...trackedDrop.grants];
      trackedDrop = null;
    }
    if (grants.length === 0) {
      const tracked =
        currentDropPaths && currentDropPaths.length > 0
          ? null
          : await waitForTrackedDrop();
      if (tracked) {
        trackedDrop = null;
        grants = tracked.grants;
        dropPaths = tracked.paths;
      } else if (!currentDropPaths) {
        // The native window event that mints grants and the webview drop event
        // are delivered separately; give the window event one turn to land.
        await new Promise((resolve) => setTimeout(resolve, 50));
        grants = await takeDroppedUploadGrants();
      }
    }
    if (dropPaths && dropPaths.length > 0) {
      grants = filterGrantsToDrop(grants, dropPaths);
    }
    if (grants.length === 0) {
      setStatus("No dropped files detected. Try Upload Files instead.", 5000);
      return;
    }

    const firstRoot = grants.find((grant) => grant.isDir);
    if (firstRoot) rememberUploadRoot(firstRoot.path, true);
    const firstFile = grants.find((grant) => !grant.isDir);
    if (firstFile) rememberUploadRoot(firstFile.path, false);

    setStatus(`Dropped ${grants.length} item(s). Preparing upload...`, 3000);

    const rootTokens = grants
      .filter((grant) => grant.isDir)
      .map((grant) => grant.token);
    const files = grants
      .filter((grant) => !grant.isDir)
      .map((grant) => ({ path: grant.path, token: grant.token }));

    const scan: LocalFolderScanResult =
      rootTokens.length > 0
        ? await invoke<LocalFolderScanResult>("list_local_files_recursive", {
            rootTokens,
          })
        : { entries: [], warnings: [], warning_count: 0 };
    const entries = scan.entries;
    if (!targetUnchanged()) {
      setStatus("Upload cancelled because destination changed.", 5000);
      return;
    }
    if (scan.warning_count > 0) {
      logActivity(
        `Dropped upload skipped ${plural(scan.warning_count, "path")}: ${scan.warnings.join(" | ")}`,
        "error",
      );
    }
    if (entries.length === 0 && files.length === 0) {
      setStatus("Nothing to upload: the dropped items contain no files.", 5000);
      return;
    }
    let queued = 0;
    if (entries.length > 0) {
      const result = enqueueFolderTransfers(entries, destPrefix, target);
      if (!result.accepted) {
        reportRefusedEnqueue(result);
        return;
      }
      queued += result.count;
    }
    if (files.length > 0) {
      const result = enqueuePaths(files, destPrefix, target);
      if (!result.accepted) {
        reportRefusedEnqueue(result);
        return;
      }
      queued += result.count;
    }
    setStatus(
      `Dropped ${plural(grants.length, "item")}. Queued ${plural(queued, "file")} for upload.${describeScanWarnings(scan)}`,
      5000,
    );
  } catch (err) {
    // The scan is also the safety check (case-fold collisions, symlinks,
    // unreadable entries). Queueing the raw paths instead would skip those
    // checks and send dropped folders as single-file uploads that then fail.
    const message = friendlyError(err);
    logActivity(
      `Could not prepare dropped items for upload: ${message}`,
      "error",
    );
    setStatus(`Upload not started: ${message}`, 8000);
  }
}
