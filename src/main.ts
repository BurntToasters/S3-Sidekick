import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { state, dom } from "./state.ts";
import {
  loadSettings,
  openSettingsModal,
  closeSettingsModal,
  resetSettings,
  setBookmarkSelectHandler,
} from "./settings.ts";
import {
  connect,
  disconnect,
  saveConnection,
  loadConnection,
  refreshBuckets,
  refreshObjects,
  loadMoreObjects,
} from "./connection.ts";
import {
  renderBucketList,
  renderObjectTable,
  renderBreadcrumb,
  navigateToFolder,
  selectBucket,
  showEmptyState,
  handleRowClick,
  handleSelectAll,
  clearSelection,
  updateSelectionUI,
  toggleSort,
} from "./browser.ts";
import { initUpdater, autoCheckUpdates, checkUpdates } from "./updater.ts";
import { addBookmark } from "./bookmarks.ts";
import { openLicensesModal, closeLicensesModal } from "./licenses.ts";
import {
  showContextMenu,
  hideContextMenu,
  type MenuItem,
} from "./context-menu.ts";
import {
  openInfoPanel,
  closeInfoPanel,
  saveInfoPanel,
  switchTab,
} from "./info-panel.ts";
import {
  toggleTransferQueue,
  toggleTransferCollapsed,
  hideTransferQueue,
  clearCompletedTransfers,
  enqueuePaths,
  setTransferCompleteHandler,
  initTransferQueueUI,
  enqueueFiles,
} from "./transfers.ts";
import { basename, formatSize } from "./utils.ts";
import {
  ensureSecurityReady,
  handleSecurityChangePassword,
  handleSecurityToggle,
} from "./security.ts";

function setStatus(text: string): void {
  dom.statusEl.textContent = text;
}

function setConnectionUI(connected: boolean): void {
  const badge = dom.connectionStatus;
  if (connected) {
    badge.textContent = "Connected";
    badge.className = "connection-badge connection-badge--on";
    dom.connectBtn.style.display = "none";
    dom.disconnectBtn.style.display = "";
  } else {
    badge.textContent = "Disconnected";
    badge.className = "connection-badge connection-badge--off";
    dom.connectBtn.style.display = "";
    dom.disconnectBtn.style.display = "none";
  }
}

function getConnectionInputs() {
  const endpoint = (
    document.getElementById("conn-endpoint") as HTMLInputElement
  ).value.trim();
  const region = (
    document.getElementById("conn-region") as HTMLInputElement
  ).value.trim();
  const accessKey = (
    document.getElementById("conn-access-key") as HTMLInputElement
  ).value.trim();
  const secretKey = (
    document.getElementById("conn-secret-key") as HTMLInputElement
  ).value;
  return { endpoint, region, accessKey, secretKey };
}

function setConnectionInputs(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): void {
  (document.getElementById("conn-endpoint") as HTMLInputElement).value =
    endpoint;
  (document.getElementById("conn-region") as HTMLInputElement).value = region;
  (document.getElementById("conn-access-key") as HTMLInputElement).value =
    accessKey;
  (document.getElementById("conn-secret-key") as HTMLInputElement).value =
    secretKey;
}

async function handleConnect(): Promise<void> {
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !region || !accessKey || !secretKey) {
    setStatus("All connection fields are required.");
    return;
  }

  dom.connectBtn.disabled = true;
  setStatus("Connecting...");

  try {
    await connect(endpoint, region, accessKey, secretKey);
    setConnectionUI(true);
    setStatus("Connected.");
    try {
      await saveConnection(endpoint, region, accessKey, secretKey);
    } catch (saveErr) {
      setStatus(`Connected (credentials not saved: ${saveErr}).`);
    }
    await refreshBuckets();
    renderBucketList();
    if (state.buckets.length > 0) {
      await selectBucket(state.buckets[0].name);
    }
  } catch (e) {
    setStatus(`Connection failed: ${e}`);
    setConnectionUI(false);
  } finally {
    dom.connectBtn.disabled = false;
  }
}

async function handleDisconnect(): Promise<void> {
  await disconnect();
  setConnectionUI(false);
  showEmptyState();
  setStatus("Disconnected.");
}

async function handleBookmarkSave(): Promise<void> {
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !region || !accessKey) {
    setStatus("Fill in endpoint, region, and access key to bookmark.");
    return;
  }

  let name = endpoint;
  try {
    const url = new URL(endpoint);
    name = url.hostname.split(".")[0] || endpoint;
  } catch {
    name = endpoint.replace(/^https?:\/\//, "").split(/[:/]/)[0] || endpoint;
  }

  try {
    await addBookmark({
      name,
      endpoint,
      region,
      access_key: accessKey,
      secret_key: secretKey,
    });
    setStatus(`Bookmarked "${name}".`);
  } catch (err) {
    setStatus(`Failed to save bookmark: ${err}`);
  }
}

function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys).filter((k) => !k.startsWith("prefix:"));
}

async function handleDelete(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;

  const msg =
    keys.length === 1
      ? `Delete "${basename(keys[0])}"?`
      : `Delete ${keys.length} items?`;
  if (!window.confirm(msg)) return;

  try {
    setStatus(`Deleting ${keys.length} item(s)...`);
    const deleted = await invoke<number>("delete_objects", {
      bucket: state.currentBucket,
      keys,
    });
    setStatus(`Deleted ${deleted} item(s).`);
    clearSelection();
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    setStatus(`Delete failed: ${err}`);
  }
}

async function handleDownload(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;

  for (const key of keys) {
    const fileName = basename(key);
    const destination = await save({
      defaultPath: fileName,
      title: `Save ${fileName}`,
    });
    if (!destination) continue;

    try {
      setStatus(`Downloading ${fileName}...`);
      const size = await invoke<number>("download_object", {
        bucket: state.currentBucket,
        key,
        destination,
      });
      setStatus(`Downloaded ${fileName} (${formatSize(size)}).`);
    } catch (err) {
      setStatus(`Download failed: ${err}`);
    }
  }
}

async function handleCopyUrl(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;

  try {
    const url = await invoke<string>("build_object_url", {
      bucket: state.currentBucket,
      key: keys[0],
    });
    await navigator.clipboard.writeText(url);
    setStatus("URL copied to clipboard.");
  } catch (err) {
    setStatus(`Failed to copy URL: ${err}`);
  }
}

async function handleRename(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length !== 1) return;

  const oldKey = keys[0];
  const oldName = basename(oldKey);
  const newName = window.prompt("Rename to:", oldName);
  if (!newName || newName === oldName) return;

  const prefix = oldKey.slice(0, oldKey.length - oldName.length);
  const newKey = prefix + newName;

  try {
    setStatus("Renaming...");
    await invoke("rename_object", {
      bucket: state.currentBucket,
      oldKey,
      newKey,
    });
    setStatus(`Renamed to "${newName}".`);
    clearSelection();
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
  } catch (err) {
    setStatus(`Rename failed: ${err}`);
  }
}

async function handleCreateFolder(): Promise<void> {
  if (!state.connected || !state.currentBucket) {
    setStatus("Connect to a bucket first.");
    return;
  }

  const name = window.prompt("New folder name:");
  if (!name) return;

  const key = state.currentPrefix + name;

  try {
    setStatus("Creating folder...");
    await invoke("create_folder", {
      bucket: state.currentBucket,
      key,
    });
    setStatus(`Created folder "${name}".`);
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
  } catch (err) {
    setStatus(`Failed to create folder: ${err}`);
  }
}

async function handleRefresh(): Promise<void> {
  if (!state.connected || !state.currentBucket) return;
  setStatus("Refreshing...");
  try {
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
    renderBreadcrumb();
    setStatus("");
  } catch (err) {
    setStatus(`Refresh failed: ${err}`);
  }
}

async function handleUploadButton(): Promise<void> {
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

function handleContextMenu(e: MouseEvent): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
  if (!row) {
    if ((e.target as HTMLElement).closest("#object-panel")) {
      e.preventDefault();
      showContextMenu(
        e.clientX,
        e.clientY,
        [
          { label: "New Folder", action: "new-folder" },
          { separator: true },
          { label: "Refresh", action: "refresh" },
        ],
        (action) => {
          if (action === "new-folder") handleCreateFolder();
          else if (action === "refresh") handleRefresh();
        },
      );
    }
    return;
  }
  e.preventDefault();

  const key = row.dataset.key ?? "";
  const prefix = row.dataset.prefix ?? "";
  const isFolder = row.classList.contains("object-row--folder");
  const itemKey = isFolder ? "prefix:" + prefix : key;

  if (!state.selectedKeys.has(itemKey)) {
    state.selectedKeys.clear();
    state.selectedKeys.add(itemKey);
    updateSelectionUI();
  }

  const selectedCount = state.selectedKeys.size;
  const fileKeys = getSelectedFileKeys();
  const hasFiles = fileKeys.length > 0;

  const items: MenuItem[] = [];

  if (isFolder && selectedCount === 1) {
    items.push({ label: "Open", action: "open-folder" });
    items.push({ separator: true });
  }

  if (hasFiles) {
    if (selectedCount === 1) {
      items.push({ label: "Get Info", action: "info" });
      items.push({ label: "Download", action: "download" });
      items.push({ label: "Copy URL", action: "copy-url" });
      items.push({ label: "Rename", action: "rename" });
    } else {
      items.push({
        label: `Get Info (${fileKeys.length} items)`,
        action: "info",
      });
      items.push({
        label: `Download ${fileKeys.length} items`,
        action: "download",
      });
    }
    items.push({ separator: true });
    items.push({
      label: selectedCount === 1 ? "Delete" : `Delete ${fileKeys.length} items`,
      action: "delete",
    });
  }

  if (items.length === 0) return;

  showContextMenu(e.clientX, e.clientY, items, (action) => {
    if (action === "info") openInfoPanel(fileKeys);
    else if (action === "download") handleDownload();
    else if (action === "copy-url") handleCopyUrl();
    else if (action === "rename") handleRename();
    else if (action === "delete") handleDelete();
    else if (action === "open-folder") navigateToFolder(prefix);
  });
}

function wireEvents(): void {
  dom.connectBtn.addEventListener("click", handleConnect);
  dom.disconnectBtn.addEventListener("click", handleDisconnect);

  document
    .getElementById("bookmark-save-btn")!
    .addEventListener("click", handleBookmarkSave);

  document
    .getElementById("settings-btn")!
    .addEventListener("click", openSettingsModal);
  document
    .getElementById("settings-close")!
    .addEventListener("click", () => closeSettingsModal(false));
  document
    .getElementById("settings-cancel")!
    .addEventListener("click", () => closeSettingsModal(false));
  document
    .getElementById("settings-save")!
    .addEventListener("click", () => closeSettingsModal(true));
  document
    .getElementById("settings-reset")!
    .addEventListener("click", resetSettings);
  document
    .getElementById("settings-check-updates")!
    .addEventListener("click", () => {
      closeSettingsModal(false);
      checkUpdates();
    });

  document
    .getElementById("show-licenses")!
    .addEventListener("click", openLicensesModal);
  document
    .getElementById("close-licenses")!
    .addEventListener("click", closeLicensesModal);
  document
    .getElementById("licenses-overlay")!
    .addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeLicensesModal();
    });

  document
    .getElementById("settings-overlay")!
    .addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
        closeSettingsModal(false);
      }
    });

  document
    .getElementById("info-close")!
    .addEventListener("click", closeInfoPanel);
  document
    .getElementById("info-cancel")!
    .addEventListener("click", closeInfoPanel);
  document
    .getElementById("info-save")!
    .addEventListener("click", saveInfoPanel);
  document.getElementById("info-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeInfoPanel();
  });

  document.querySelector(".info-tabs")!.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".info-tab");
    if (tab?.dataset.tab) switchTab(tab.dataset.tab);
  });

  document
    .getElementById("transfer-toggle")!
    .addEventListener("click", toggleTransferQueue);
  document
    .getElementById("transfer-collapse")!
    .addEventListener("click", toggleTransferCollapsed);
  document
    .getElementById("transfer-close")!
    .addEventListener("click", hideTransferQueue);
  document
    .getElementById("transfer-clear")!
    .addEventListener("click", clearCompletedTransfers);
  initTransferQueueUI();

  document.getElementById("security-toggle")!.addEventListener("click", () => {
    void handleSecurityToggle(setStatus);
  });
  document
    .getElementById("security-change-password")!
    .addEventListener("click", () => {
      void handleSecurityChangePassword(setStatus);
    });

  document
    .getElementById("btn-refresh")!
    .addEventListener("click", handleRefresh);
  document
    .getElementById("btn-new-folder")!
    .addEventListener("click", handleCreateFolder);
  document
    .getElementById("btn-upload")!
    .addEventListener("click", handleUploadButton);

  document
    .getElementById("btn-load-more")!
    .addEventListener("click", async () => {
      setStatus("Loading more...");
      await loadMoreObjects();
      renderObjectTable();
      setStatus("");
    });

  document.querySelectorAll<HTMLElement>(".col-sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort as "name" | "size" | "modified";
      if (col) toggleSort(col);
    });
  });

  dom.bucketList.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".list__item");
    if (!item) return;
    const bucket = item.dataset.bucket;
    if (bucket) selectBucket(bucket);
  });

  dom.objectTbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;

    if (
      row.classList.contains("object-row--folder") &&
      !target.closest(".col-check") &&
      !target.classList.contains("row-check")
    ) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) navigateToFolder(prefix);
      return;
    }

    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    handleRowClick(key, e);
  });

  dom.objectTbody.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(
      ".object-row--file",
    );
    if (!row) return;
    const key = row.dataset.key;
    if (key) openInfoPanel([key]);
  });

  dom.objectTbody.addEventListener("contextmenu", handleContextMenu);
  dom.objectPanel.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest(".object-row")) {
      handleContextMenu(e);
    }
  });

  document.getElementById("select-all")!.addEventListener("change", (e) => {
    handleSelectAll((e.target as HTMLInputElement).checked);
  });

  dom.breadcrumb.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>(
      ".breadcrumb__segment",
    );
    if (!seg) return;
    const prefix = seg.dataset.prefix;
    if (prefix !== undefined) navigateToFolder(prefix);
  });

  const objectPanel = dom.objectPanel;
  objectPanel.addEventListener("dragover", (e) => {
    e.preventDefault();
    objectPanel.classList.add("object-panel--dragover");
  });
  objectPanel.addEventListener("dragleave", () => {
    objectPanel.classList.remove("object-panel--dragover");
  });
  objectPanel.addEventListener("drop", (e) => {
    e.preventDefault();
    objectPanel.classList.remove("object-panel--dragover");

    if (!state.connected || !state.currentBucket) {
      setStatus("Connect to a bucket first.");
      return;
    }

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const paths: string[] = [];
      for (const file of Array.from(files)) {
        const maybePath = (file as { path?: unknown }).path;
        if (typeof maybePath === "string" && maybePath.length > 0) {
          paths.push(maybePath);
        }
      }
      if (paths.length > 0) {
        enqueuePaths(paths, state.currentPrefix);
      } else {
        enqueueFiles(files, state.currentPrefix);
      }
    }
  });

  setTransferCompleteHandler(async () => {
    if (state.connected && state.currentBucket) {
      await refreshObjects(state.currentBucket, state.currentPrefix);
      renderObjectTable();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();

      const confirm = document.getElementById("confirm-overlay");
      if (confirm?.classList.contains("active")) return;

      const infoOverlay = document.getElementById("info-overlay");
      if (infoOverlay?.classList.contains("active")) {
        closeInfoPanel();
        return;
      }

      const licensesOverlay = document.getElementById("licenses-overlay");
      if (licensesOverlay?.classList.contains("active")) {
        closeLicensesModal();
        return;
      }

      const transferOverlay = document.getElementById("transfer-overlay");
      if (transferOverlay && !transferOverlay.hidden) {
        hideTransferQueue();
        return;
      }

      const overlay = document.getElementById("settings-overlay");
      if (overlay?.classList.contains("active")) {
        closeSettingsModal(false);
      }
    }

    if (e.key === "Delete" && state.selectedKeys.size > 0) {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
      )
        return;
      if (
        document.querySelector(".modal-overlay.active, .confirm-overlay.active")
      )
        return;
      handleDelete();
    }

    if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
      e.preventDefault();
      handleRefresh();
    }
  });

  setBookmarkSelectHandler((bookmark) => {
    setConnectionInputs(
      bookmark.endpoint,
      bookmark.region,
      bookmark.access_key,
      bookmark.secret_key,
    );
    setStatus(`Loaded bookmark "${bookmark.name}".`);
  });
}

async function init(): Promise<void> {
  const securityReady = await ensureSecurityReady();
  if (!securityReady) {
    setStatus(
      "Secure storage is locked. Saved settings and credentials are unavailable.",
    );
    return;
  }

  await loadSettings();

  state.platformName = await invoke<string>("get_platform_info");
  const version = await getVersion();
  dom.versionLabel.textContent = `v${version}`;

  wireEvents();

  const saved = await loadConnection();
  if (saved) {
    setConnectionInputs(
      saved.endpoint,
      saved.region,
      saved.access_key,
      saved.secret_key,
    );
  }

  await initUpdater();
  autoCheckUpdates();
}

init().catch((err) => {
  console.error("Init error:", err);
});
