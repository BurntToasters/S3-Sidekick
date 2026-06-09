import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { state } from "./state.ts";
import { enqueuePaths, enqueueFolderEntries } from "./transfers.ts";
import { logActivity } from "./activity-log.ts";
import { friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";

export interface LocalFolderFileEntry {
  file_path: string;
  relative_path: string;
  size: number;
}

function enqueueFolderTransfers(
  entries: LocalFolderFileEntry[],
  targetPrefix: string,
): boolean {
  enqueueFolderEntries(entries, targetPrefix);
  return true;
}

export async function handleUploadButton(): Promise<void> {
  if (!state.connected || !state.currentBucket) {
    setStatus("Connect to a bucket first.");
    return;
  }

  const selected = await open({
    title: "Select files to upload",
    multiple: true,
    directory: false,
  });
  if (!selected) return;

  const paths = Array.isArray(selected) ? selected : [selected];
  const filePaths = paths.filter(
    (value): value is string => typeof value === "string",
  );
  if (filePaths.length > 0) {
    enqueuePaths(filePaths, state.currentPrefix);
  }
}

export async function handleUploadFolderButton(): Promise<void> {
  if (!state.connected || !state.currentBucket) {
    setStatus("Connect to a bucket first.");
    return;
  }

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

  try {
    setStatus("Scanning folder(s)...");
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { roots: folderPaths },
    );

    if (entries.length === 0) {
      setStatus("Selected folder(s) contain no files.", 5000);
      return;
    }

    if (enqueueFolderTransfers(entries, state.currentPrefix)) {
      setStatus(`Queued ${entries.length} file(s) from folder upload.`, 5000);
      return;
    }

    enqueuePaths(
      entries.map((entry) => entry.file_path),
      state.currentPrefix,
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

  setStatus(`Dropped ${cleaned.length} item(s). Preparing upload...`, 3000);

  try {
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { roots: cleaned },
    );
    if (entries.length > 0) {
      enqueueFolderTransfers(entries, targetPrefix);
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

  enqueuePaths(cleaned, targetPrefix);
  setStatus(`Dropped ${cleaned.length} file(s). Queued for upload.`, 5000);
}
