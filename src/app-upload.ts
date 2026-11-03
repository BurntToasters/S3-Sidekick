import { invoke } from "./ipc.ts";
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
    selected = await pickUploadFiles();
  } catch (err) {
    setStatus(`Failed to open file picker: ${String(err)}`);
    return;
  }
  if (selected.length === 0) return;
  if (destinationChanged(snap)) {
    setStatus("Upload cancelled because destination changed.", 5000);
    return;
  }

  const files = selected
    .filter((grant) => !grant.isDir && grant.token.length > 0)
    .map((grant) => ({ path: grant.path, token: grant.token }));
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
    selected = await pickUploadFolder();
  } catch (err) {
    setStatus(`Failed to open folder picker: ${String(err)}`);
    return;
  }
  if (selected.length === 0) return;

  const rootTokens = selected
    .filter((grant) => grant.isDir && grant.token.length > 0)
    .map((grant) => grant.token);
  if (rootTokens.length === 0) return;
  if (destinationChanged(snap)) {
    setStatus("Folder upload cancelled because destination changed.", 5000);
    return;
  }

  try {
    setStatus("Scanning folder(s)...");
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { rootTokens },
    );

    if (destinationChanged(snap)) {
      setStatus("Folder upload cancelled because destination changed.", 5000);
      return;
    }

    if (entries.length === 0) {
      setStatus("Selected folder(s) contain no files.", 5000);
      return;
    }

    const target = enqueueTargetFromSnapshot(snap);
    const result = enqueueFolderTransfers(entries, snap.prefix, target);
    if (!result.accepted) {
      reportRefusedEnqueue(result);
      return;
    }
    setStatus(
      `Queued ${plural(result.count, "file")} from folder upload.`,
      5000,
    );
  } catch (err) {
    setStatus(`Folder upload failed: ${friendlyError(err)}`);
    logActivity(`Folder upload failed: ${friendlyError(err)}`, "error");
  }
}

export async function queueDroppedPaths(targetPrefix: string): Promise<void> {
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
    let grants = await takeDroppedUploadGrants();
    if (grants.length === 0) {
      // The native window event that mints grants and the webview drop event
      // are delivered separately; give the window event one turn to land.
      await new Promise((resolve) => setTimeout(resolve, 50));
      grants = await takeDroppedUploadGrants();
    }
    if (grants.length === 0) {
      setStatus("No dropped files detected. Try Upload Files instead.", 5000);
      return;
    }

    setStatus(`Dropped ${grants.length} item(s). Preparing upload...`, 3000);

    const rootTokens = grants
      .filter((grant) => grant.isDir)
      .map((grant) => grant.token);
    const files = grants
      .filter((grant) => !grant.isDir)
      .map((grant) => ({ path: grant.path, token: grant.token }));

    const entries =
      rootTokens.length > 0
        ? await invoke<LocalFolderFileEntry[]>("list_local_files_recursive", {
            rootTokens,
          })
        : [];
    if (!targetUnchanged()) {
      setStatus("Upload cancelled because destination changed.", 5000);
      return;
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
      `Dropped ${plural(grants.length, "item")}. Queued ${plural(queued, "file")} for upload.`,
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
