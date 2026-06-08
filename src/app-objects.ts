import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { state } from "./state.ts";
import { refreshObjects, refreshBuckets } from "./connection.ts";
import {
  renderObjectTable,
  renderBreadcrumb,
  renderBucketList,
  navigateToFolder,
  clearSelection,
  updateSelectionUI,
} from "./browser.ts";
import { showConfirm, showPrompt } from "./dialogs.ts";
import { logActivity, exportActivityLogText } from "./activity-log.ts";
import { basename, friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { getSelectedFileKeys, getSelectedPrefixes } from "./app-selection.ts";

export async function handleDelete(): Promise<void> {
  const keys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();

  if (keys.length === 0 && prefixes.length === 0) return;

  const parts: string[] = [];
  if (keys.length > 0)
    parts.push(`${keys.length} file${keys.length === 1 ? "" : "s"}`);
  if (prefixes.length > 0)
    parts.push(
      `${prefixes.length} folder${prefixes.length === 1 ? "" : "s"} and all their contents`,
    );
  const msg = `Delete ${parts.join(" and ")}?`;

  const confirmed = await showConfirm("Delete", msg, {
    okLabel: "Delete",
    okDanger: true,
  });
  if (!confirmed) return;

  let totalDeleted = 0;
  try {
    if (keys.length > 0) {
      setStatus(`Deleting ${keys.length} file(s)...`);
      totalDeleted += await invoke<number>("delete_objects", {
        bucket: state.currentBucket,
        keys,
      });
    }
    for (const prefix of prefixes) {
      setStatus(`Deleting folder "${basename(prefix.replace(/\/$/, ""))}"...`);
      totalDeleted += await invoke<number>("delete_prefix", {
        bucket: state.currentBucket,
        prefix,
      });
    }
    setStatus(`Deleted ${totalDeleted} item(s).`, 5000);
    logActivity(`Deleted ${totalDeleted} object(s).`, "success");
    clearSelection();
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    setStatus(`Delete failed: ${friendlyError(err)}`);
    logActivity(`Delete failed: ${friendlyError(err)}`, "error");
  }
}

export async function handleCopyUrl(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;

  try {
    const urls = await Promise.all(
      keys.map((key) =>
        invoke<string>("build_object_url", {
          bucket: state.currentBucket,
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
  const expiresInSecs = state.currentSettings.presignedUrlExpiration;

  try {
    const url = await invoke<string>("generate_presigned_url", {
      bucket: state.currentBucket,
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

  if (keys.length === 1 && prefixes.length === 0) {
    const oldKey = keys[0];
    const oldName = basename(oldKey);
    const newName = await showPrompt("Rename", "Enter new name:", {
      inputDefault: oldName,
    });
    if (!newName || newName === oldName) return;

    const keyPrefix = oldKey.slice(0, oldKey.length - oldName.length);
    const newKey = keyPrefix + newName;

    try {
      setStatus("Renaming...");
      await invoke("rename_object", {
        bucket: state.currentBucket,
        oldKey,
        newKey,
      });
      setStatus(`Renamed to "${newName}".`, 5000);
      logActivity(`Renamed "${oldName}" to "${newName}".`, "success");
      clearSelection();
      await refreshObjects(state.currentBucket, state.currentPrefix);
      renderObjectTable();
    } catch (err) {
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

    const newPrefix = parentPrefix + newName + "/";

    try {
      setStatus(`Renaming folder "${folderName}"...`);
      await invoke("rename_prefix", {
        bucket: state.currentBucket,
        oldPrefix,
        newPrefix,
      });
      setStatus(`Renamed folder to "${newName}".`, 5000);
      logActivity(`Renamed folder "${folderName}" to "${newName}".`, "success");
      clearSelection();
      await refreshObjects(state.currentBucket, state.currentPrefix);
      renderObjectTable();
    } catch (err) {
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

  const name = await showPrompt("New Folder", "Enter folder name:", {
    inputPlaceholder: "Folder name",
  });
  if (!name) return;

  const trimmed = name.trim();
  if (!trimmed) {
    setStatus("Folder name cannot be empty.");
    return;
  }
  if (trimmed.includes("/")) {
    setStatus('Folder name cannot contain "/".');
    return;
  }

  const key = state.currentPrefix + trimmed;

  try {
    setStatus("Creating folder...");
    await invoke("create_folder", {
      bucket: state.currentBucket,
      key,
    });
    setStatus(`Created folder "${trimmed}".`, 5000);
    logActivity(`Created folder ${trimmed}.`, "success");
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
  } catch (err) {
    setStatus(`Failed to create folder: ${friendlyError(err)}`);
    logActivity(
      `Failed to create folder ${trimmed}: ${friendlyError(err)}`,
      "error",
    );
  }
}

export async function handleRefresh(): Promise<void> {
  if (!state.connected || !state.currentBucket) return;
  setStatus("Refreshing...");
  try {
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
    renderBreadcrumb();
    setStatus("");
  } catch (err) {
    setStatus(`Refresh failed: ${friendlyError(err)}`);
  }
}

export async function handleRefreshBuckets(): Promise<void> {
  if (!state.connected) return;
  try {
    setStatus("Refreshing buckets...");
    await refreshBuckets();
    renderBucketList();
    setStatus("Buckets refreshed.", 3000);
  } catch (err) {
    setStatus(`Failed to refresh buckets: ${friendlyError(err)}`);
    logActivity(`Failed to refresh buckets: ${friendlyError(err)}`, "error");
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
  const raw = await showPrompt("Go To", "Enter key or prefix:", {
    inputPlaceholder: "e.g. folder/file.txt or folder/subfolder/",
  });
  if (!raw) return;

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
