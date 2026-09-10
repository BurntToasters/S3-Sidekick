import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { state } from "./state.ts";
import {
  captureConnectionSnapshot,
  connectionSnapshotChanged,
  invokeS3,
  invokeS3For,
  refreshObjects,
  refreshBuckets,
} from "./connection.ts";
import type { ConnectionSnapshot } from "./connection.ts";
import {
  renderObjectTable,
  renderBreadcrumb,
  renderBucketList,
  navigateToFolder,
  clearSelection,
  updateSelectionUI,
  invalidateInspectorSelectionSync,
} from "./browser.ts";
import { showConfirm, showPrompt } from "./dialogs.ts";
import { logActivity, exportActivityLogText } from "./activity-log.ts";
import { basename, friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { getSelectedFileKeys, getSelectedPrefixes } from "./app-selection.ts";
import {
  resolveAbsentObjectWriteIntent,
  resolveObjectConflict,
  resolveConflictChoice,
  type ConflictPromptSession,
} from "./app-conflicts.ts";

interface DeleteResult {
  deleted: number;
  failed: number;
  incomplete: boolean;
  errors: string[];
}

function normalizeDeleteResult(value: unknown): DeleteResult {
  // Tolerate an older backend during development/hot reload; current backend
  // always returns the structured shape below.
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { deleted: value, failed: 0, incomplete: false, errors: [] };
  }
  if (!value || typeof value !== "object") {
    throw new Error("Delete command returned an invalid result");
  }
  const row = value as Partial<DeleteResult>;
  if (
    !Number.isInteger(row.deleted) ||
    (row.deleted ?? -1) < 0 ||
    !Number.isInteger(row.failed) ||
    (row.failed ?? -1) < 0 ||
    typeof row.incomplete !== "boolean" ||
    !Array.isArray(row.errors) ||
    !row.errors.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Delete command returned an invalid result");
  }
  return row as DeleteResult;
}

function deleteFailureSummary(result: DeleteResult): string | null {
  if (!result.incomplete && result.failed === 0 && result.errors.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (result.failed > 0) parts.push(`${result.failed} object(s) failed`);
  if (result.incomplete) parts.push("operation did not finish");
  if (result.errors.length > 0)
    parts.push(result.errors.slice(0, 3).join("; "));
  return parts.join("; ");
}

let deleteOperation: Promise<void> | null = null;

function setDeleteOperationBusy(busy: boolean): void {
  const button = document.getElementById(
    "batch-delete",
  ) as HTMLButtonElement | null;
  if (!button) return;
  const label = button.querySelector<HTMLElement>(".batch-toolbar__label");
  button.dataset.operationInFlight = String(busy);
  button.setAttribute("aria-busy", String(busy));
  if (label) label.textContent = busy ? "Deleting\u2026" : "Delete";
  if (busy) {
    button.disabled = true;
    button.title = "Delete in progress";
  } else {
    const selectedCount =
      getSelectedFileKeys().length + getSelectedPrefixes().length;
    button.disabled = selectedCount === 0;
    button.title =
      selectedCount > 0
        ? `Delete ${selectedCount} selected item${selectedCount === 1 ? "" : "s"}`
        : "Select items to delete";
  }
}

export function isDeleteInProgress(): boolean {
  return deleteOperation !== null;
}

export function handleDelete(): Promise<void> {
  if (deleteOperation) return deleteOperation;
  if (
    getSelectedFileKeys().length === 0 &&
    getSelectedPrefixes().length === 0
  ) {
    return Promise.resolve();
  }

  setDeleteOperationBusy(true);
  const operation = performDelete().finally(() => {
    if (deleteOperation === operation) {
      deleteOperation = null;
      setDeleteOperationBusy(false);
    }
  });
  deleteOperation = operation;
  return operation;
}

async function performDelete(): Promise<void> {
  const keys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();

  if (keys.length === 0 && prefixes.length === 0) return;

  let target: ConnectionSnapshot;
  try {
    target = captureConnectionSnapshot();
  } catch (err) {
    setStatus(`Delete cancelled: ${friendlyError(err)}`, 5000);
    return;
  }

  const parts: string[] = [];
  if (keys.length > 0)
    parts.push(`${keys.length} file${keys.length === 1 ? "" : "s"}`);
  if (prefixes.length > 0)
    parts.push(
      `${prefixes.length} folder${prefixes.length === 1 ? "" : "s"} and all their contents`,
    );
  // Name what is about to be destroyed (at most 5) and say it cannot be
  // undone; the dialog message preserves line breaks (pre-line).
  const targetNames = [...prefixes, ...keys]
    .map((key) => basename(key.replace(/\/$/, "")) || key)
    .slice(0, 5);
  const remaining = keys.length + prefixes.length - targetNames.length;
  const nameList =
    targetNames.length > 0
      ? `\n${targetNames.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`
      : "";
  const msg = `Delete ${parts.join(" and ")}?${nameList}\nThis cannot be undone.`;

  const confirmed = await showConfirm("Delete", msg, {
    okLabel: "Delete",
    okDanger: true,
  });
  if (!confirmed) return;
  if (
    connectionSnapshotChanged(target) ||
    keys.join("\n") !== getSelectedFileKeys().join("\n") ||
    prefixes.join("\n") !== getSelectedPrefixes().join("\n")
  ) {
    setStatus(
      "Delete cancelled because connection or selection changed.",
      5000,
    );
    return;
  }

  let totalDeleted = 0;
  const failures: string[] = [];
  try {
    if (keys.length > 0) {
      if (connectionSnapshotChanged(target)) {
        failures.push(`${keys.join(", ")}: connection changed`);
      } else {
        setStatus(
          `Deleting ${keys.length} file${keys.length === 1 ? "" : "s"}...`,
        );
        try {
          const result = normalizeDeleteResult(
            await invokeS3For<unknown>(target.connectionId, "delete_objects", {
              bucket: target.bucket,
              keys,
            }),
          );
          totalDeleted += result.deleted;
          const failure = deleteFailureSummary(result);
          if (failure) failures.push(`${keys.join(", ")}: ${failure}`);
        } catch (err) {
          failures.push(`${keys.join(", ")}: ${friendlyError(err)}`);
        }
      }
    }
    for (const prefix of prefixes) {
      if (connectionSnapshotChanged(target)) {
        failures.push(`${prefix}: connection changed`);
        break;
      }
      setStatus(`Deleting folder "${basename(prefix.replace(/\/$/, ""))}"...`);
      try {
        const result = normalizeDeleteResult(
          await invokeS3For<unknown>(target.connectionId, "delete_prefix", {
            bucket: target.bucket,
            prefix,
          }),
        );
        totalDeleted += result.deleted;
        const failure = deleteFailureSummary(result);
        if (failure) failures.push(`${prefix}: ${failure}`);
      } catch (err) {
        failures.push(`${prefix}: ${friendlyError(err)}`);
      }
    }
    if (failures.length > 0) {
      setStatus(
        `Delete failed for ${failures.length} target(s); deleted ${totalDeleted} item(s).`,
        5000,
      );
      logActivity(
        `Delete partially failed after ${totalDeleted} item(s): ${failures.join("; ")}`,
        "warning",
      );
    } else {
      setStatus(`Deleted ${totalDeleted} item(s).`, 5000);
      logActivity(`Deleted ${totalDeleted} object(s).`, "success");
    }
    if (!connectionSnapshotChanged(target)) {
      clearSelection();
      try {
        const committed = await refreshObjects(target.bucket, target.prefix);
        if (committed && !connectionSnapshotChanged(target)) {
          renderObjectTable();
          renderBreadcrumb();
        }
      } catch (err) {
        logActivity(
          `Listing refresh after delete failed: ${friendlyError(err)}`,
          "warning",
        );
      }
    }
  } catch (err) {
    setStatus(`Delete failed: ${friendlyError(err)}`);
    logActivity(`Delete failed: ${friendlyError(err)}`, "error");
  }
}

export async function handleCopyUrl(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;
  const bucket = state.currentBucket;

  try {
    const urls = await Promise.all(
      keys.map((key) =>
        invokeS3<string>("build_object_url", {
          bucket,
          key,
        }),
      ),
    );
    await navigator.clipboard.writeText(urls.join("\n"));
    if (keys.length === 1) {
      setStatus("URL copied to clipboard.", 5000);
      logActivity(`Copied URL for ${basename(keys[0])}.`, "success");
    } else {
      setStatus(`Copied ${keys.length} URLs to clipboard.`, 5000);
      logActivity(`Copied ${keys.length} object URLs.`, "success");
    }
  } catch (err) {
    setStatus(`Failed to copy URL: ${friendlyError(err)}`);
    logActivity(`Failed to copy URL: ${friendlyError(err)}`, "error");
  }
}

function formatExpiration(seconds: number): string {
  const withUnit = (value: number, unit: "minute" | "hour" | "day") =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 3600)
    return withUnit(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86400) return withUnit(Math.round(seconds / 3600), "hour");
  return withUnit(Math.round(seconds / 86400), "day");
}

export async function handleCopyPresignedUrl(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length !== 1) return;
  const bucket = state.currentBucket;
  const expiresInSecs = state.currentSettings.presignedUrlExpiration;

  try {
    const url = await invokeS3<string>("generate_presigned_url", {
      bucket,
      key: keys[0],
      expiresInSecs,
    });
    await navigator.clipboard.writeText(url);
    setStatus(
      `Pre-signed URL copied (expires in ${formatExpiration(expiresInSecs)}).`,
      5000,
    );
    logActivity(`Copied pre-signed URL for ${basename(keys[0])}.`, "success");
  } catch (err) {
    setStatus(`Failed to create pre-signed URL: ${friendlyError(err)}`);
    logActivity(
      `Failed to create pre-signed URL: ${friendlyError(err)}`,
      "error",
    );
  }
}

export async function handleCopyKey(): Promise<void> {
  const fileKeys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();
  const allKeys = [...fileKeys, ...prefixes];
  if (allKeys.length === 0) return;

  try {
    await navigator.clipboard.writeText(allKeys.join("\n"));
    if (allKeys.length === 1) {
      setStatus("Key copied to clipboard.", 5000);
      logActivity(`Copied key: ${allKeys[0]}`, "success");
    } else {
      setStatus(`Copied ${allKeys.length} keys to clipboard.`, 5000);
      logActivity(`Copied ${allKeys.length} keys.`, "success");
    }
  } catch (err) {
    setStatus(`Failed to copy key: ${friendlyError(err)}`);
    logActivity(`Failed to copy key: ${friendlyError(err)}`, "error");
  }
}

export async function handleCopyArn(): Promise<void> {
  const fileKeys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();
  const allKeys = [...fileKeys, ...prefixes];
  if (allKeys.length === 0) return;

  const bucket = state.currentBucket;
  const arns = allKeys.map((key) => `arn:aws:s3:::${bucket}/${key}`);

  try {
    await navigator.clipboard.writeText(arns.join("\n"));
    if (arns.length === 1) {
      setStatus("ARN copied to clipboard.", 5000);
      logActivity(`Copied ARN for ${basename(allKeys[0])}.`, "success");
    } else {
      setStatus(`Copied ${arns.length} ARNs to clipboard.`, 5000);
      logActivity(`Copied ${arns.length} ARNs.`, "success");
    }
  } catch (err) {
    setStatus(`Failed to copy ARN: ${friendlyError(err)}`);
    logActivity(`Failed to copy ARN: ${friendlyError(err)}`, "error");
  }
}

export async function handleRename(): Promise<void> {
  const keys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();
  let target: ConnectionSnapshot;
  try {
    target = captureConnectionSnapshot();
  } catch (err) {
    setStatus(`Rename cancelled: ${friendlyError(err)}`, 5000);
    return;
  }
  const targetBucket = target.bucket;
  const targetPrefix = target.prefix;
  const targetLocationChanged = (): boolean =>
    connectionSnapshotChanged(target) ||
    !state.connected ||
    state.currentBucket !== targetBucket ||
    state.currentPrefix !== targetPrefix;

  if (keys.length === 1 && prefixes.length === 0) {
    const oldKey = keys[0];
    const oldName = basename(oldKey);
    const rawName = await showPrompt("Rename", "Enter new name:", {
      inputDefault: oldName,
    });
    if (!rawName || rawName === oldName) return;
    const newName = rawName.trim();
    if (!newName) {
      setStatus("Name cannot be empty.", 5000);
      return;
    }
    if (newName === oldName) return;
    if (newName.includes("/")) {
      setStatus('Name cannot contain "/".', 5000);
      return;
    }
    if (targetLocationChanged()) {
      setStatus("Rename cancelled because location changed.", 5000);
      return;
    }

    const keyPrefix = oldKey.slice(0, oldKey.length - oldName.length);
    const newKey = keyPrefix + newName;

    const conflictSession: ConflictPromptSession = { applyAll: null };
    const sourceSize =
      state.objects.find((object) => object.key === oldKey)?.size ?? undefined;
    const intent = await resolveObjectConflict(
      target.connectionId,
      targetBucket,
      newKey,
      conflictSession,
      false,
      { operation: "copy", byteLength: sourceSize },
    );
    if (targetLocationChanged()) {
      setStatus("Rename cancelled because location changed.", 5000);
      return;
    }
    if (intent === "skip") {
      setStatus(`Rename skipped: "${newName}" already exists.`, 5000);
      return;
    }
    if (intent === "cancel") {
      setStatus(
        "Rename cancelled: unconditional write was not authorized.",
        5000,
      );
      return;
    }
    if (targetLocationChanged()) {
      setStatus("Rename cancelled because location changed.", 5000);
      return;
    }

    try {
      setStatus("Renaming...");
      await invokeS3For(target.connectionId, "rename_object", {
        bucket: targetBucket,
        oldKey,
        newKey,
        overwrite: intent.overwrite,
      });
      if (targetLocationChanged()) return;
      setStatus(`Renamed to "${newName}".`, 5000);
      logActivity(`Renamed "${oldName}" to "${newName}".`, "success");
      clearSelection();
      if (!targetLocationChanged()) {
        const committed = await refreshObjects(targetBucket, targetPrefix);
        if (committed && !targetLocationChanged()) {
          renderObjectTable();
        }
      }
    } catch (err) {
      if (targetLocationChanged()) return;
      setStatus(`Rename failed for "${oldName}": ${friendlyError(err)}`);
      logActivity(
        `Rename failed for "${oldName}": ${friendlyError(err)}`,
        "error",
      );
    }
  } else if (prefixes.length === 1 && keys.length === 0) {
    const oldPrefix = prefixes[0];
    const folderName = basename(oldPrefix.replace(/\/$/, ""));
    const parentPrefix = oldPrefix.slice(
      0,
      oldPrefix.length - folderName.length - 1,
    );

    const newName = await showPrompt(
      "Rename Folder",
      "Enter new folder name:",
      {
        inputDefault: folderName,
      },
    );
    if (!newName || newName === folderName) return;
    if (newName.includes("/")) {
      setStatus("Folder name cannot contain slashes.", 5000);
      return;
    }
    if (targetLocationChanged()) {
      setStatus("Folder rename cancelled because location changed.", 5000);
      return;
    }

    const newPrefix = parentPrefix + newName + "/";

    let overwrite = false;
    let folderHasConflict = false;
    try {
      const existing = await invokeS3For<{
        objects: Array<{ key: string }>;
        prefixes: string[];
      }>(target.connectionId, "list_objects", {
        bucket: targetBucket,
        prefix: newPrefix,
        delimiter: "",
        continuationToken: "",
      });
      folderHasConflict =
        existing.objects.length > 0 || existing.prefixes.length > 0;
    } catch (err) {
      folderHasConflict = true;
      logActivity(
        `Could not check whether ${targetBucket}/${newPrefix} exists (${friendlyError(err)}). ` +
          "Treating it as a conflict.",
        "warning",
      );
    }

    if (targetLocationChanged()) {
      setStatus("Folder rename cancelled because location changed.", 5000);
      return;
    }

    const conflictSession: ConflictPromptSession = { applyAll: null };
    if (folderHasConflict) {
      const policy = state.currentSettings.conflictPolicy;
      let decision: "replace" | "skip";
      if (policy === "replace") {
        decision = "replace";
      } else if (policy === "skip") {
        setStatus(`Folder rename skipped: "${newName}" already exists.`, 5000);
        return;
      } else {
        decision = await resolveConflictChoice(
          `${targetBucket}/${newPrefix}`,
          conflictSession,
          false,
        );
      }
      if (targetLocationChanged()) {
        setStatus("Folder rename cancelled because location changed.", 5000);
        return;
      }
      if (decision === "skip") {
        setStatus(`Folder rename skipped: "${newName}" already exists.`, 5000);
        return;
      }
      overwrite = true;
    } else if (state.currentSettings.conflictPolicy === "replace") {
      overwrite = true;
    } else {
      const intent = await resolveAbsentObjectWriteIntent(
        conflictSession,
        false,
        { operation: "copy" },
      );
      if (targetLocationChanged()) {
        setStatus("Folder rename cancelled because location changed.", 5000);
        return;
      }
      if (intent === "cancel") {
        setStatus(
          "Folder rename cancelled: unconditional write was not authorized.",
          5000,
        );
        return;
      }
      overwrite = intent.overwrite;
    }

    if (targetLocationChanged()) {
      setStatus("Folder rename cancelled because location changed.", 5000);
      return;
    }

    try {
      setStatus(`Renaming folder "${folderName}"...`);
      await invokeS3For(target.connectionId, "rename_prefix", {
        bucket: targetBucket,
        oldPrefix,
        newPrefix,
        overwrite,
      });
      if (targetLocationChanged()) return;
      setStatus(`Renamed folder to "${newName}".`, 5000);
      logActivity(`Renamed folder "${folderName}" to "${newName}".`, "success");
      clearSelection();
      if (!targetLocationChanged()) {
        const committed = await refreshObjects(targetBucket, targetPrefix);
        if (committed && !targetLocationChanged()) {
          renderObjectTable();
        }
      }
    } catch (err) {
      if (targetLocationChanged()) return;
      setStatus(`Folder rename failed: ${friendlyError(err)}`);
      logActivity(`Folder rename failed: ${friendlyError(err)}`, "error");
    }
  }
}

export async function handleCreateFolder(): Promise<void> {
  if (!state.connected || !state.currentBucket) {
    setStatus("Connect to a bucket first.");
    return;
  }
  let target: ConnectionSnapshot;
  try {
    target = captureConnectionSnapshot();
  } catch (err) {
    setStatus(`Folder creation cancelled: ${friendlyError(err)}`, 5000);
    return;
  }
  const targetBucket = target.bucket;
  const targetPrefix = target.prefix;
  const targetLocationChanged = (): boolean =>
    connectionSnapshotChanged(target) ||
    !state.connected ||
    state.currentBucket !== targetBucket ||
    state.currentPrefix !== targetPrefix;

  const name = await showPrompt("New Folder", "Enter folder name:", {
    inputPlaceholder: "Folder name",
  });
  if (!name) return;
  if (targetLocationChanged()) {
    setStatus("Folder creation cancelled because location changed.", 5000);
    return;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    setStatus("Folder name cannot be empty.");
    return;
  }
  if (trimmed.includes("/")) {
    setStatus('Folder name cannot contain "/".');
    return;
  }

  const key = targetPrefix + trimmed;
  const folderKey = key.endsWith("/") ? key : `${key}/`;

  const conflictSession: ConflictPromptSession = { applyAll: null };
  const intent = await resolveObjectConflict(
    target.connectionId,
    targetBucket,
    folderKey,
    conflictSession,
    false,
    { operation: "upload" },
  );
  if (targetLocationChanged()) {
    setStatus("Folder creation cancelled because location changed.", 5000);
    return;
  }
  if (intent === "skip") {
    setStatus(`Folder creation skipped: "${trimmed}" already exists.`, 5000);
    return;
  }
  if (intent === "cancel") {
    setStatus(
      "Folder creation cancelled: unconditional write was not authorized.",
      5000,
    );
    return;
  }

  const createWithOverwrite = (overwrite: boolean): Promise<unknown> =>
    invokeS3For(target.connectionId, "create_folder", {
      bucket: targetBucket,
      key,
      overwrite,
    });

  try {
    setStatus("Creating folder...");
    await createWithOverwrite(intent.overwrite);
    if (targetLocationChanged()) return;
    setStatus(`Created folder "${trimmed}".`, 5000);
    logActivity(`Created folder ${trimmed}.`, "success");
    if (!targetLocationChanged()) {
      const committed = await refreshObjects(targetBucket, targetPrefix);
      if (committed && !targetLocationChanged()) renderObjectTable();
    }
  } catch (err) {
    if (targetLocationChanged()) return;
    const message = friendlyError(err);
    // A create-only probe can lose a race, or the provider may lack atomic
    // create-only support: surface the same overwrite-retry consent used by
    // Put/Copy instead of failing silently.
    const needsOverwriteRetry =
      !intent.overwrite &&
      (/already exists/i.test(message) ||
        /cannot enforce a create-only/i.test(message) ||
        /unconditional write/i.test(message));
    if (needsOverwriteRetry) {
      const replace = await showConfirm(
        "Folder Exists",
        `${targetBucket}/${folderKey} already exists or cannot be created without overwrite. Replace it?`,
        { okLabel: "Replace", cancelLabel: "Cancel", okDanger: true },
      );
      if (targetLocationChanged()) return;
      if (!replace) {
        setStatus(
          `Folder creation skipped: "${trimmed}" already exists.`,
          5000,
        );
        return;
      }
      try {
        setStatus("Creating folder...");
        await createWithOverwrite(true);
        if (targetLocationChanged()) return;
        setStatus(`Created folder "${trimmed}".`, 5000);
        logActivity(`Created folder ${trimmed}.`, "success");
        if (!targetLocationChanged()) {
          const committed = await refreshObjects(targetBucket, targetPrefix);
          if (committed && !targetLocationChanged()) renderObjectTable();
        }
        return;
      } catch (retryErr) {
        if (targetLocationChanged()) return;
        setStatus(`Failed to create folder: ${friendlyError(retryErr)}`);
        logActivity(
          `Failed to create folder ${trimmed}: ${friendlyError(retryErr)}`,
          "error",
        );
        return;
      }
    }
    setStatus(`Failed to create folder: ${message}`);
    logActivity(`Failed to create folder ${trimmed}: ${message}`, "error");
  }
}

export async function handleRefresh(): Promise<void> {
  if (!state.connected || !state.currentBucket) return;
  let target: ConnectionSnapshot;
  try {
    target = captureConnectionSnapshot();
  } catch {
    return;
  }
  setStatus("Refreshing...");
  try {
    const committed = await refreshObjects(target.bucket, target.prefix);
    if (committed && !connectionSnapshotChanged(target)) {
      invalidateInspectorSelectionSync();
      renderObjectTable();
      renderBreadcrumb();
      setStatus("");
    }
  } catch (err) {
    if (!connectionSnapshotChanged(target)) {
      setStatus(`Refresh failed: ${friendlyError(err)}`);
    }
  }
}

let bucketRefreshInFlight = false;

export function isBucketRefreshInFlight(): boolean {
  return bucketRefreshInFlight;
}

export async function handleRefreshBuckets(): Promise<void> {
  if (!state.connected || bucketRefreshInFlight) return;
  const connectionId = state.connectionId;
  const bucketList = document.getElementById("bucket-list");
  bucketRefreshInFlight = true;
  try {
    setStatus("Refreshing buckets...");
    bucketList?.setAttribute("aria-busy", "true");
    await refreshBuckets();
    // Ignore stale completions after disconnect/reconnect.
    if (!state.connected || state.connectionId !== connectionId) return;
    renderBucketList();
    setStatus("Buckets refreshed.", 3000);
  } catch (err) {
    if (!state.connected || state.connectionId !== connectionId) return;
    setStatus(`Failed to refresh buckets: ${friendlyError(err)}`);
    logActivity(`Failed to refresh buckets: ${friendlyError(err)}`, "error");
    // Inline retry affordance inside the list (aria-busy cleared).
    if (bucketList) {
      bucketList.setAttribute("aria-busy", "false");
      const retryRow = document.createElement("li");
      retryRow.className = "list__empty";
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn btn--sm";
      retryBtn.textContent = "Retry bucket refresh";
      retryBtn.addEventListener("click", () => {
        void handleRefreshBuckets();
      });
      retryRow.textContent = `Failed to refresh buckets: ${friendlyError(err)} `;
      retryRow.appendChild(retryBtn);
      bucketList.replaceChildren(retryRow);
    }
    return;
  } finally {
    bucketRefreshInFlight = false;
    if (state.connected && state.connectionId === connectionId) {
      bucketList?.setAttribute("aria-busy", "false");
    }
  }
}

export async function handleExportActivityLog(): Promise<void> {
  const text = exportActivityLogText();
  if (!text) {
    setStatus("No activity entries to export.", 5000);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = await save({
    title: "Export Activity Log",
    defaultPath: `s3-sidekick-activity-${stamp}.txt`,
  });
  if (!destination) return;

  let overwrite = false;
  try {
    const exists = await invoke<boolean>("path_exists", { path: destination });
    if (exists) {
      overwrite = await showConfirm(
        "Overwrite File",
        `${destination} already exists. Replace it?`,
        { okLabel: "Replace", cancelLabel: "Cancel", okDanger: true },
      );
      if (!overwrite) return;
    }
    await invoke("write_text_file", { path: destination, text, overwrite });
    setStatus("Activity log exported.", 5000);
    logActivity(`Exported activity log to ${destination}.`, "success");
  } catch (err) {
    setStatus(`Failed to export activity log: ${friendlyError(err)}`);
    logActivity(
      `Failed to export activity log: ${friendlyError(err)}`,
      "error",
    );
  }
}

export async function handleGoToKeyOrPrefix(): Promise<void> {
  if (!state.connected || !state.currentBucket) return;
  const targetBucket = state.currentBucket;
  const raw = await showPrompt("Go To", "Enter key or prefix:", {
    inputPlaceholder: "e.g. folder/file.txt or folder/subfolder/",
  });
  if (!raw) return;
  if (!state.connected || state.currentBucket !== targetBucket) {
    setStatus("Go To cancelled because connection changed.", 5000);
    return;
  }

  const input = raw.trim().replace(/^\/+/, "");
  if (!input) return;

  try {
    if (input.endsWith("/")) {
      await navigateToFolder(input);
      return;
    }

    const idx = input.lastIndexOf("/");
    const parentPrefix = idx >= 0 ? input.slice(0, idx + 1) : "";
    await navigateToFolder(parentPrefix);

    const targetKey = input;
    if (state.objects.some((obj) => obj.key === targetKey)) {
      state.selectedKeys.clear();
      state.selectedKeys.add(targetKey);
      updateSelectionUI();
      return;
    }

    if (state.prefixes.some((prefix) => prefix === `${input}/`)) {
      await navigateToFolder(`${input}/`);
      return;
    }

    const filterInput = document.getElementById(
      "filter-input",
    ) as HTMLInputElement | null;
    if (filterInput) {
      filterInput.value = basename(input);
      state.filterText = filterInput.value;
      renderObjectTable();
    }
    setStatus(`Not found exactly: ${input}. Applied filter.`, 5000);
  } catch (err) {
    setStatus(`Go to failed: ${friendlyError(err)}`);
  }
}
