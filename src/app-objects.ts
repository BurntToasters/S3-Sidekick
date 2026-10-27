import { invoke } from "./ipc.ts";
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
  renderedIndexOfSelection,
  focusObjectTableRow,
  revealRow,
} from "./browser.ts";
import { showConfirm, showPrompt } from "./dialogs.ts";
import { logActivity, exportActivityLogText } from "./activity-log.ts";
import { basename, friendlyError, plural } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { showToast } from "./toast.ts";
import { openDrawer } from "./bottom-drawer.ts";
import {
  addSelection,
  clearAllSelection,
  fileEntry,
  folderEntry,
  getSelectedFileKeys,
  getSelectedPrefixes,
  type SelectionEntry,
} from "./app-selection.ts";
import {
  promptUnguardedWrite,
  resolveAbsentObjectWriteIntent,
  resolveObjectConflict,
  resolveConflictChoice,
  type ConflictPromptSession,
} from "./app-conflicts.ts";
import {
  SMALL_OBJECT_BYTE_LENGTH,
  isCreateOnlyUnsupportedError,
} from "./create-only-capabilities.ts";

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

/** True only for hosts under amazonaws.com; ARNs are an AWS-only concept. */
export function isAwsEndpoint(endpoint: string): boolean {
  const raw = endpoint.trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    ).hostname;
  } catch {
    return false;
  }
  return host === "amazonaws.com" || host.endsWith(".amazonaws.com");
}

/** Plain-language confirmation for a delete; plurals agree with the counts. */
export function deleteConfirmationMessage(
  keys: string[],
  prefixes: string[],
): string {
  const fileCount = keys.length;
  const folderCount = prefixes.length;
  if (folderCount === 0) return `Delete ${plural(fileCount, "file")}?`;
  const folders = plural(folderCount, "folder");
  if (fileCount === 0) {
    return folderCount === 1
      ? `Delete ${folders}? Its contents are deleted too.`
      : `Delete ${folders}? Their contents are deleted too.`;
  }
  const head = `Delete ${plural(fileCount, "file")} and ${folders}?`;
  return folderCount === 1
    ? `${head} The folder's contents are deleted too.`
    : `${head} The folders' contents are deleted too.`;
}

/** Shared rename rules for files and folders; null means the name is usable. */
export function objectNameProblem(
  value: string,
  currentName: string,
  kind: "file" | "folder",
): string | null {
  const name = value.trim();
  if (!name) {
    return kind === "folder"
      ? "Folder name cannot be empty."
      : "Name cannot be empty.";
  }
  if (name.includes("/")) {
    return kind === "folder"
      ? "Folder name cannot contain slashes."
      : 'Name cannot contain "/".';
  }
  if (name === currentName) return "That is already the name.";
  return null;
}

/**
 * Keeps the entries the listing still shows; used after a delete. When more
 * pages exist, an entry missing from the loaded page cannot be checked, so it
 * stays selected (fail closed) instead of being reported as deleted.
 */
function stillListed(entries: SelectionEntry[]): SelectionEntry[] {
  const objectKeys = new Set(state.objects.map((object) => object.key));
  const prefixes = new Set(state.prefixes);
  return entries.filter((entry) => {
    const present =
      entry.kind === "folder"
        ? prefixes.has(entry.key)
        : objectKeys.has(entry.key);
    return present || state.hasMore;
  });
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
        ? `Delete ${plural(selectedCount, "selected item")}`
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

/**
 * Keep keyboard focus in the table after a delete removed the focused row.
 * Focus the user moved elsewhere (a dialog, the filter) is left alone.
 */
function restoreFocusAfterDelete(index: number): void {
  if (index < 0) return;
  const active = document.activeElement;
  // The confirm dialog holds focus until it closes; the toolbar button that
  // opened it is disabled while the delete runs, so focus ends up on body.
  const focusWasLost =
    !active ||
    active === document.body ||
    active.closest("#object-tbody, #batch-toolbar, #dialog-overlay") !== null;
  if (focusWasLost) focusObjectTableRow({ logicalIndex: index });
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
  const msg = `${deleteConfirmationMessage(keys, prefixes)}${nameList}\nThis cannot be undone.`;

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

  // Where focus lands once the rows are gone: the row that took the first
  // deleted row's place, so the next Space or Enter acts on what the user saw.
  const focusIndex = renderedIndexOfSelection();
  let totalDeleted = 0;
  const failures: string[] = [];
  // Targets whose delete did not confirm. A failed batch does not say which
  // key failed, so each member stays a candidate until the listing settles it.
  const unresolved: SelectionEntry[] = [];
  try {
    if (keys.length > 0) {
      if (connectionSnapshotChanged(target)) {
        failures.push(`${keys.join(", ")}: connection changed`);
        unresolved.push(...keys.map((key) => fileEntry(key)));
      } else {
        setStatus(`Deleting ${plural(keys.length, "file")}...`);
        try {
          const result = normalizeDeleteResult(
            await invokeS3For<unknown>(target.connectionId, "delete_objects", {
              bucket: target.bucket,
              keys,
            }),
          );
          totalDeleted += result.deleted;
          const failure = deleteFailureSummary(result);
          if (failure) {
            failures.push(`${keys.join(", ")}: ${failure}`);
            unresolved.push(...keys.map((key) => fileEntry(key)));
          }
        } catch (err) {
          failures.push(`${keys.join(", ")}: ${friendlyError(err)}`);
          unresolved.push(...keys.map((key) => fileEntry(key)));
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
        if (failure) {
          failures.push(`${prefix}: ${failure}`);
          unresolved.push(folderEntry(prefix));
        }
      } catch (err) {
        failures.push(`${prefix}: ${friendlyError(err)}`);
        unresolved.push(folderEntry(prefix));
      }
    }
    const succeeded = failures.length === 0;
    if (succeeded) {
      setStatus(`Deleted ${plural(totalDeleted, "item")}.`, 5000);
      logActivity(`Deleted ${plural(totalDeleted, "object")}.`, "success");
    } else {
      logActivity(
        `Delete partially failed after ${plural(totalDeleted, "object")}: ${failures.join("; ")}`,
        "warning",
      );
    }

    let remaining: SelectionEntry[] = unresolved;
    if (!connectionSnapshotChanged(target)) {
      if (succeeded) clearSelection();
      let listingCommitted = false;
      try {
        // A mutation refresh must not supersede an in-flight navigation.
        const committed = await refreshObjects(target.bucket, target.prefix, {
          supersedePending: false,
        });
        if (committed && !connectionSnapshotChanged(target)) {
          listingCommitted = true;
          remaining = stillListed(unresolved);
          renderObjectTable();
          renderBreadcrumb();
        }
      } catch (err) {
        logActivity(
          `Listing refresh after delete failed: ${friendlyError(err)}`,
          "warning",
        );
      }
      if (!succeeded) {
        clearAllSelection();
        for (const entry of remaining) addSelection(entry);
        updateSelectionUI();
        renderObjectTable();
      }
      if (listingCommitted) restoreFocusAfterDelete(focusIndex);
    }

    if (!succeeded) {
      const total = keys.length + prefixes.length;
      setStatus(
        `Delete failed; deleted ${plural(totalDeleted, "item")}. See the notice for details.`,
        8000,
      );
      // Sticky: the user must see which items survived before acting again.
      showToast(
        total === 1
          ? `Couldn't delete "${targetNames[0]}"`
          : `Couldn't delete ${Math.max(1, remaining.length)} of ${plural(total, "item")}`,
        {
          type: "error",
          duration: 0,
          actionLabel: "Details",
          onAction: () => openDrawer("activity"),
        },
      );
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
  if (!isAwsEndpoint(state.endpoint)) {
    setStatus("ARNs are only available for AWS S3 endpoints.", 5000);
    return;
  }

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
      validate: async (value) =>
        objectNameProblem(value, oldName, "file") ?? true,
    });
    if (!rawName) return;
    const newName = rawName.trim();
    if (newName === oldName) return;
    const problem = objectNameProblem(newName, oldName, "file");
    if (problem) {
      setStatus(problem, 5000);
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
        const committed = await refreshObjects(targetBucket, targetPrefix, {
          supersedePending: false,
        });
        if (committed && !targetLocationChanged()) {
          renderObjectTable();
        }
      }
      // Keep the renamed item selected and focused, wherever it sorts now.
      if (!targetLocationChanged()) {
        clearAllSelection();
        addSelection(fileEntry(newKey));
        updateSelectionUI();
        revealRow(newKey, "file");
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

    const enteredName = await showPrompt(
      "Rename Folder",
      "Enter new folder name:",
      {
        inputDefault: folderName,
        validate: async (value) =>
          objectNameProblem(value, folderName, "folder") ?? true,
      },
    );
    if (!enteredName) return;
    const newName = enteredName.trim();
    if (newName === folderName) return;
    const folderProblem = objectNameProblem(newName, folderName, "folder");
    if (folderProblem) {
      setStatus(folderProblem, 5000);
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
        { operation: "copy", byteLength: SMALL_OBJECT_BYTE_LENGTH },
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
      const renamePrefix = (withOverwrite: boolean): Promise<unknown> =>
        invokeS3For(target.connectionId, "rename_prefix", {
          bucket: targetBucket,
          oldPrefix,
          newPrefix,
          overwrite: withOverwrite,
        });
      try {
        await renamePrefix(overwrite);
      } catch (err) {
        // The folder holds an object too large for this provider's
        // create-only copy; the backend rolled back, so ask and retry.
        if (overwrite || !isCreateOnlyUnsupportedError(err)) throw err;
        if (targetLocationChanged()) return;
        const { proceed } = await promptUnguardedWrite();
        if (targetLocationChanged()) return;
        if (!proceed) {
          setStatus(
            "Folder rename cancelled: unconditional write was not authorized.",
            5000,
          );
          return;
        }
        await renamePrefix(true);
      }
      if (targetLocationChanged()) return;
      setStatus(`Renamed folder to "${newName}".`, 5000);
      logActivity(`Renamed folder "${folderName}" to "${newName}".`, "success");
      clearSelection();
      if (!targetLocationChanged()) {
        const committed = await refreshObjects(targetBucket, targetPrefix, {
          supersedePending: false,
        });
        if (committed && !targetLocationChanged()) {
          renderObjectTable();
        }
      }
      if (!targetLocationChanged()) {
        clearAllSelection();
        addSelection(folderEntry(newPrefix));
        updateSelectionUI();
        revealRow(newPrefix, "folder");
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
    // A folder marker is always zero bytes, so only single-PUT create-only
    // support matters (MinIO and others guard it even without multipart).
    { operation: "upload", byteLength: SMALL_OBJECT_BYTE_LENGTH },
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
      const committed = await refreshObjects(targetBucket, targetPrefix, {
        supersedePending: false,
      });
      if (committed && !targetLocationChanged()) renderObjectTable();
    }
  } catch (err) {
    if (targetLocationChanged()) return;
    const message = friendlyError(err);
    // Match the raw backend error: the friendly form can be rewritten by
    // words inside the folder name itself (e.g. "error-500-logs").
    const rawMessage = err instanceof Error ? err.message : String(err);
    // A create-only probe can lose a race, or the provider may lack atomic
    // create-only support: surface the same overwrite-retry consent used by
    // Put/Copy instead of failing silently.
    const unsupported = isCreateOnlyUnsupportedError(err);
    const needsOverwriteRetry =
      !intent.overwrite && (unsupported || /already exists/i.test(rawMessage));
    if (needsOverwriteRetry) {
      const replace = unsupported
        ? (await promptUnguardedWrite()).proceed
        : await showConfirm(
            "Folder Exists",
            `${targetBucket}/${folderKey} already exists. Replace it?`,
            { okLabel: "Replace", cancelLabel: "Cancel", okDanger: true },
          );
      if (targetLocationChanged()) return;
      if (!replace) {
        setStatus(
          unsupported
            ? "Folder creation cancelled: unconditional write was not authorized."
            : `Folder creation skipped: "${trimmed}" already exists.`,
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
          const committed = await refreshObjects(targetBucket, targetPrefix, {
            supersedePending: false,
          });
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
    // Manual refresh must not cancel a navigation the user just started.
    const committed = await refreshObjects(target.bucket, target.prefix, {
      preserveSelection: true,
      supersedePending: false,
    });
    if (committed && !connectionSnapshotChanged(target)) {
      invalidateInspectorSelectionSync();
      renderObjectTable();
      updateSelectionUI();
      renderBreadcrumb();
      setStatus("");
    }
  } catch (err) {
    if (!connectionSnapshotChanged(target)) {
      setStatus(`Refresh failed: ${friendlyError(err)}`);
    }
  }
}

const BUCKET_BANNER_CLASS = "bucket-refresh-banner";

/**
 * Shows a failed bucket refresh above the list. The previous bucket list is
 * kept, so the user can still act on it while retrying.
 */
function showBucketRefreshBanner(
  list: HTMLElement | null,
  message: string,
): void {
  const panel = list?.parentElement;
  if (!list || !panel) return;
  list.setAttribute("aria-busy", "false");
  let banner = panel.querySelector<HTMLElement>(`.${BUCKET_BANNER_CLASS}`);
  if (!banner) {
    banner = document.createElement("div");
    banner.className = `${BUCKET_BANNER_CLASS} table-error`;
    banner.setAttribute("role", "alert");
    panel.insertBefore(banner, list);
  }
  const text = document.createElement("span");
  text.textContent = message;
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn--sm";
  retryBtn.textContent = "Retry bucket refresh";
  retryBtn.addEventListener("click", () => {
    void handleRefreshBuckets();
  });
  banner.replaceChildren(text, retryBtn);
}

function clearBucketRefreshBanner(list: HTMLElement | null): void {
  list?.parentElement?.querySelector(`.${BUCKET_BANNER_CLASS}`)?.remove();
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
    clearBucketRefreshBanner(bucketList);
    setStatus("Buckets refreshed.", 3000);
  } catch (err) {
    if (!state.connected || state.connectionId !== connectionId) return;
    const message = `Failed to refresh buckets: ${friendlyError(err)}`;
    setStatus(message);
    logActivity(message, "error");
    // The last good list stays visible; the banner says it may be stale.
    showBucketRefreshBanner(bucketList, message);
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
  let destination: string | null;
  try {
    destination = await save({
      title: "Export Activity Log",
      defaultPath: `s3-sidekick-activity-${stamp}.txt`,
    });
  } catch (err) {
    setStatus(`Failed to open save dialog: ${friendlyError(err)}`);
    return;
  }
  if (!destination) return;

  // The save dialog already asked about replacing an existing file. A second
  // overwrite prompt would ask the same question twice, so write directly.
  try {
    await invoke("write_text_file", {
      path: destination,
      text,
      overwrite: true,
    });
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
      clearAllSelection();
      addSelection(fileEntry(targetKey));
      updateSelectionUI();
      // Scroll the row into view and move focus to it, not just select it.
      revealRow(targetKey, "file");
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
