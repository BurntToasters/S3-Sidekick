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
  /**
   * Size the backend recorded when it minted the grant. Current native picker
   * payloads do not include this field, so recovery treats it as optional
   * evidence rather than an invariant.
   */
  size?: number;
  /** Reveal grant for the containing folder (save dialogs only). */
  directoryToken?: string | null;
  directoryPath?: string | null;
}

/** One dropped item, granted by the native drag-drop window event. */
export type DroppedPathGrant = NativePathGrant;

/**
 * Native pickers are application-modal. Running two through `invoke` at once
 * can leave one behind the other or return to the wrong recovery row, so every
 * picker request joins this one queue.
 */
let pickerTail: Promise<void> = Promise.resolve();

function withNativePickerLock<T>(work: () => Promise<T>): Promise<T> {
  const run = pickerTail.then(work, work);
  pickerTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Open the upload-file picker. `defaultPath` is a presentation hint; the
 * backend resolves it to a starting directory but still mints grants only for
 * what the user actually selects.
 */
export async function pickUploadFiles(
  defaultPath?: string,
): Promise<NativePathGrant[]> {
  return withNativePickerLock(() =>
    invoke<NativePathGrant[]>("pick_upload_files", {
      defaultPath: defaultPath ?? null,
    }),
  );
}

/** Open the upload-folder picker. See `pickUploadFiles` for `defaultPath`. */
export async function pickUploadFolder(
  defaultPath?: string,
): Promise<NativePathGrant[]> {
  return withNativePickerLock(() =>
    invoke<NativePathGrant[]>("pick_upload_folder", {
      defaultPath: defaultPath ?? null,
    }),
  );
}

/** Open the single-file download save dialog. */
export async function pickDownloadFile(
  fileName?: string,
  title?: string,
  defaultDirectory?: string,
): Promise<NativePathGrant | null> {
  return withNativePickerLock(() =>
    invoke<NativePathGrant | null>("pick_download_file", {
      fileName: fileName ?? null,
      title: title ?? null,
      defaultDirectory: defaultDirectory ?? null,
    }),
  );
}

/** Open the download-folder picker. */
export async function pickDownloadDirectory(
  title?: string,
  defaultDirectory?: string,
): Promise<NativePathGrant | null> {
  return withNativePickerLock(() =>
    invoke<NativePathGrant | null>("pick_download_directory", {
      title: title ?? null,
      defaultDirectory: defaultDirectory ?? null,
    }),
  );
}

export async function pickTextExport(
  fileName: string,
  title?: string,
  defaultDirectory?: string,
): Promise<NativePathGrant | null> {
  return withNativePickerLock(() =>
    invoke<NativePathGrant | null>("pick_text_export", {
      fileName,
      title: title ?? null,
      defaultDirectory: defaultDirectory ?? null,
    }),
  );
}

/**
 * Grants for the most recent native drop. The paths came from the operating
 * system, not from this module, so the caller must not pass paths of its own.
 *
 * The Rust command exposes neither a drop id nor a discard command. Callers
 * therefore drain it immediately for every native drop (including ignored
 * ones) and match the returned paths against the drop event they are handling;
 * see `app-upload.ts`.
 */
export async function takeDroppedUploadGrants(): Promise<DroppedPathGrant[]> {
  return invoke<DroppedPathGrant[]>("take_dropped_upload_grants");
}
