import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  captureConnectionSnapshot,
  connectionSnapshotChanged,
  type ConnectionSnapshot,
} from "./connection.ts";
import { state } from "./state.ts";
import {
  enqueuePaths,
  enqueueFolderEntries,
  type TransferEnqueueTarget,
} from "./transfers.ts";
import { logActivity } from "./activity-log.ts";
import { friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";

export interface LocalFolderFileEntry {
  file_path: string;
  relative_path: string;
  size: number;
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
): boolean {
  enqueueFolderEntries(entries, targetPrefix, target);
  return true;
}

export async function handleUploadButton(): Promise<void> {
  const snap = captureUploadSnapshot();
  if (!snap) return;

  const selected = await open({
    title: "Select files to upload",
    multiple: true,
    directory: false,
  });
  if (!selected) return;
  if (destinationChanged(snap)) {
    setStatus("Upload cancelled because destination changed.", 5000);
    return;
  }

  const paths = Array.isArray(selected) ? selected : [selected];
  const filePaths = paths.filter(
    (value): value is string => typeof value === "string",
  );
  if (filePaths.length > 0) {
    enqueuePaths(filePaths, snap.prefix, enqueueTargetFromSnapshot(snap));
  }
}

export async function handleUploadFolderButton(): Promise<void> {
  const snap = captureUploadSnapshot();
  if (!snap) return;

  const selected = await open({
    title: "Select folder(s) to upload",
    multiple: true,
    directory: true,
  });
  if (!selected) return;

  const roots = Array.isArray(selected) ? selected : [selected];
  const folderPaths = roots.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (folderPaths.length === 0) return;
  if (destinationChanged(snap)) {
    setStatus("Folder upload cancelled because destination changed.", 5000);
    return;
  }

  try {
    setStatus("Scanning folder(s)...");
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { roots: folderPaths },
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
    if (enqueueFolderTransfers(entries, snap.prefix, target)) {
      setStatus(`Queued ${entries.length} file(s) from folder upload.`, 5000);
      return;
    }

    enqueuePaths(
      entries.map((entry) => entry.file_path),
      snap.prefix,
      target,
    );
    setStatus(
      `Queued ${entries.length} file(s) (folder structure unavailable).`,
      5000,
    );
  } catch (err) {
    setStatus(`Folder upload failed: ${friendlyError(err)}`);
    logActivity(`Folder upload failed: ${friendlyError(err)}`, "error");
  }
}

export async function queueDroppedPaths(
  paths: string[],
  targetPrefix: string,
): Promise<void> {
  const cleaned = paths.filter((path) => path.trim().length > 0);
  if (cleaned.length === 0) return;

  const snap = captureUploadSnapshot();
  if (!snap) return;
  const destPrefix = targetPrefix;

  setStatus(`Dropped ${cleaned.length} item(s). Preparing upload...`, 3000);

  const targetUnchanged = (): boolean =>
    !destinationChanged(snap) && state.currentPrefix === destPrefix;
  const target = enqueueTargetFromSnapshot(snap);

  try {
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { roots: cleaned },
    );
    if (!targetUnchanged()) {
      setStatus("Upload cancelled because destination changed.", 5000);
      return;
    }
    if (entries.length > 0) {
      enqueueFolderTransfers(entries, destPrefix, target);
      setStatus(
        `Dropped ${cleaned.length} item(s). Queued ${entries.length} file(s) for upload.`,
        5000,
      );
      return;
    }
  } catch (err) {
    logActivity(
      `Folder structure scan failed for dropped files: ${err}`,
      "error",
    );
  }

  if (!targetUnchanged()) {
    setStatus("Upload cancelled because destination changed.", 5000);
    return;
  }

  enqueuePaths(cleaned, destPrefix, target);
  setStatus(`Dropped ${cleaned.length} file(s). Queued for upload.`, 5000);
}
