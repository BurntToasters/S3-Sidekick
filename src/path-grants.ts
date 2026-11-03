import { invoke } from "./ipc.ts";

/**
 * A local path the backend picked through a native dialog.
 *
 * The renderer never invents `token`: only a native dialog command (or the
 * operating system's drag-drop event) mints one. Commands that touch the
 * filesystem spend the token instead of accepting a path, so a compromised
 * webview cannot name an arbitrary file.
 */
export interface NativePathGrant {
  token: string;
  path: string;
  name: string;
  isDir: boolean;
  /** Reveal grant for the containing folder (save dialogs only). */
  directoryToken?: string | null;
  directoryPath?: string | null;
}

/** One dropped item, granted by the native drag-drop window event. */
export type DroppedPathGrant = NativePathGrant;

export async function pickUploadFiles(): Promise<NativePathGrant[]> {
  return invoke<NativePathGrant[]>("pick_upload_files");
}

export async function pickUploadFolder(): Promise<NativePathGrant[]> {
  return invoke<NativePathGrant[]>("pick_upload_folder");
}

export async function pickDownloadFile(
  fileName?: string,
  title?: string,
): Promise<NativePathGrant | null> {
  return invoke<NativePathGrant | null>("pick_download_file", {
    fileName: fileName ?? null,
    title: title ?? null,
  });
}

export async function pickDownloadDirectory(
  title?: string,
): Promise<NativePathGrant | null> {
  return invoke<NativePathGrant | null>("pick_download_directory", {
    title: title ?? null,
  });
}

export async function pickTextExport(
  fileName: string,
  title?: string,
): Promise<NativePathGrant | null> {
  return invoke<NativePathGrant | null>("pick_text_export", {
    fileName,
    title: title ?? null,
  });
}

/**
 * Grants for the most recent native drop. The paths came from the operating
 * system, not from this module, so the caller must not pass paths of its own.
 */
export async function takeDroppedUploadGrants(): Promise<DroppedPathGrant[]> {
  return invoke<DroppedPathGrant[]>("take_dropped_upload_grants");
}
