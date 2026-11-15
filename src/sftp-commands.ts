import { invokeS3For } from "./connection.ts";
import { invoke } from "./ipc.ts";
import { logActivity } from "./activity-log.ts";
import { showToast } from "./toast.ts";
import {
  parseSftpDeleteResult,
  parseSftpEntry,
  parseSftpExists,
  parseSftpListResponse,
  parseSftpPreviewResponse,
  parseSftpRenameOutcome,
  parseSftpVoid,
  parseSshPrivateKeyInfo,
  type SftpDeleteResult,
  type SftpEntry,
  type SftpListResponse,
  type SftpPreviewResponse,
  type SshPrivateKeyInfo,
} from "./sftp.ts";

/*
 * Typed wrappers for the SFTP filesystem commands. Session-scoped calls go
 * through invokeS3For, which adds the live connection id and refuses while
 * encrypted storage is locked. Every result is validated before it is returned.
 */

export async function sftpListDir(
  connectionId: string,
  path: string,
): Promise<SftpListResponse> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_list_dir", {
    path,
  });
  return parseSftpListResponse(raw);
}

export async function sftpStat(
  connectionId: string,
  path: string,
): Promise<SftpEntry> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_stat", { path });
  return parseSftpEntry(raw);
}

export async function sftpExists(
  connectionId: string,
  path: string,
): Promise<boolean> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_exists", { path });
  return parseSftpExists(raw);
}

export async function sftpCreateDir(
  connectionId: string,
  path: string,
): Promise<void> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_create_dir", {
    path,
  });
  return parseSftpVoid(raw);
}

export async function sftpRename(
  connectionId: string,
  fromPath: string,
  toPath: string,
  overwrite: boolean,
): Promise<void> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_rename", {
    fromPath,
    toPath,
    overwrite,
  });
  reportSftpCleanupWarning(parseSftpRenameOutcome(raw));
}

/**
 * Tell the user about a file an SFTP write left on the server: the operation
 * succeeded, but a backup or temporary name could not be removed. It stays in
 * the activity log and as a toast that waits to be dismissed.
 */
export function reportSftpCleanupWarning(warning: string | null): void {
  if (warning === null) return;
  logActivity(warning, "warning");
  showToast(warning, { type: "warning", duration: 0 });
}

export async function sftpDelete(
  connectionId: string,
  paths: string[],
): Promise<SftpDeleteResult> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_delete", {
    paths,
  });
  return parseSftpDeleteResult(raw);
}

/** `transferId` makes the folder delete cancellable; omit it for a plain delete. */
export async function sftpDeleteDir(
  connectionId: string,
  path: string,
  transferId: number | null = null,
): Promise<SftpDeleteResult> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_delete_dir", {
    path,
    transferId,
  });
  return parseSftpDeleteResult(raw);
}

export async function sftpPreview(
  connectionId: string,
  path: string,
): Promise<SftpPreviewResponse> {
  const raw = await invokeS3For<unknown>(connectionId, "sftp_preview", {
    path,
  });
  return parseSftpPreviewResponse(raw);
}

/** Native file dialog for a private key. Resolves to null when cancelled. */
export async function pickSshPrivateKey(): Promise<SshPrivateKeyInfo | null> {
  const raw = await invoke<unknown>("pick_ssh_private_key");
  return parseSshPrivateKeyInfo(raw);
}
