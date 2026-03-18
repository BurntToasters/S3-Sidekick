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
  switchSettingsTab,
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
  navigateUp,
  selectBucket,
  showEmptyState,
  handleRowClick,
  handleSelectAll,
  getSelectableKeys,
  clearSelection,
  updateSelectionUI,
  toggleSort,
} from "./browser.ts";
import {
  initUpdater,
  autoCheckUpdates,
  checkUpdates,
  setUpdateChannel,
} from "./updater.ts";
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
  disposeTransferQueueUI,
} from "./transfers.ts";
import * as transferQueue from "./transfers.ts";
import { basename, formatSize } from "./utils.ts";
import { canPreview, openPreview, closePreview } from "./preview.ts";
import {
  logActivity,
  toggleActivityLog,
  toggleActivityCollapsed,
  hideActivityLog,
  clearActivityLog,
} from "./activity-log.ts";
import {
  ensureSecurityReady,
  handleSecurityChangePassword,
  handleSecurityToggle,
  handleLockNow,
  handleLockTimeoutChange,
  handleBiometricToggle,
} from "./security.ts";
import { showConfirm, showPrompt, isDialogActive } from "./dialogs.ts";

interface LocalFolderFileEntry {
  file_path: string;
  relative_path: string;
  size: number;
}

interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
}

interface TransfersExtensionAPI {
  enqueueDownloads?: (entries: DownloadQueueEntry[]) => void;
  enqueueFolderEntries?: (
    entries: LocalFolderFileEntry[],
    targetPrefix: string,
  ) => void;
  enqueueFolderPaths?: (
    entries: LocalFolderFileEntry[],
    targetPrefix: string,
  ) => void;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORAGE_KEY = "s3-sidekick.sidebar.width";
const FILTER_INPUT_DEBOUNCE_MS = 120;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let filterInputDebounce: ReturnType<typeof setTimeout> | undefined;
let modalLayerObserver: MutationObserver | null = null;
let modalLayerActive = false;
let focusBeforeModal: HTMLElement | null = null;

function setStatus(text: string, autoResetMs?: number): void {
  if (state.statusTimeout !== undefined) {
    clearTimeout(state.statusTimeout);
    state.statusTimeout = undefined;
  }
  dom.statusEl.textContent = text;
  if (autoResetMs && autoResetMs > 0) {
    state.statusTimeout = setTimeout(() => {
      dom.statusEl.textContent = "";
      state.statusTimeout = undefined;
    }, autoResetMs);
  }
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

function transferExtensions(): TransfersExtensionAPI {
  return transferQueue as unknown as TransfersExtensionAPI;
}

function enqueueDownloadTransfers(entries: DownloadQueueEntry[]): boolean {
  const ext = transferExtensions();
  if (!ext.enqueueDownloads) return false;
  ext.enqueueDownloads(entries);
  return true;
}

function enqueueFolderTransfers(
  entries: LocalFolderFileEntry[],
  targetPrefix: string,
): boolean {
  const ext = transferExtensions();
  if (ext.enqueueFolderEntries) {
    ext.enqueueFolderEntries(entries, targetPrefix);
    return true;
  }
  if (ext.enqueueFolderPaths) {
    ext.enqueueFolderPaths(entries, targetPrefix);
    return true;
  }
  return false;
}

function applyPlatformClass(): void {
  const body = document.body;
  body.classList.remove("platform-windows", "platform-macos", "platform-linux");
  if (state.platformName) {
    body.classList.add(`platform-${state.platformName}`);
    body.setAttribute("data-platform", state.platformName);
  } else {
    body.removeAttribute("data-platform");
  }
}

function updateShortcutChips(): void {
  const isMac = state.platformName === "macos";
  const chips = document.querySelectorAll<HTMLElement>(".shortcut-chip");
  for (const chip of chips) {
    const text = chip.textContent ?? "";
    if (isMac) {
      chip.textContent = text
        .replace(/^Ctrl\+/i, "\u2318")
        .replace(/^\u2303/, "\u2318");
    } else {
      chip.textContent = text
        .replace(/^\u2318/, "Ctrl+")
        .replace(/^\u2303/, "Ctrl+")
        .replace(/\u21e7/, "Shift+");
    }
  }
}

function isMobileSidebarMode(): boolean {
  return window.matchMedia("(max-width: 900px)").matches;
}

function setSidebarOpen(open: boolean): void {
  const layout = document.getElementById("main-layout");
  const backdrop = document.getElementById(
    "sidebar-backdrop",
  ) as HTMLButtonElement | null;
  if (!layout || !backdrop) return;

  layout.classList.toggle("main-layout--sidebar-open", open);
  backdrop.hidden = !open;
}

function toggleSidebar(): void {
  const layout = document.getElementById("main-layout");
  if (!layout) return;
  const open = !layout.classList.contains("main-layout--sidebar-open");
  setSidebarOpen(open);
}

function closeSidebarOnMobile(): void {
  if (isMobileSidebarMode()) {
    setSidebarOpen(false);
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width));
}

function applySidebarWidth(width: number): void {
  const px = `${clampSidebarWidth(width)}px`;
  document.documentElement.style.setProperty("--sidebar-width", px);
}

function splitNameExt(fileName: string): { stem: string; ext: string } {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) {
    return { stem: fileName, ext: "" };
  }
  return { stem: fileName.slice(0, idx), ext: fileName.slice(idx) };
}

function pathSeparator(): string {
  if (state.platformName === "windows") return "\\";
  return "/";
}

function joinPath(base: string, leaf: string): string {
  const sep = pathSeparator();
  const trimmed =
    base.endsWith("\\") || base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}${sep}${leaf}`;
}

function hasAccelModifier(e: KeyboardEvent): boolean {
  if (state.platformName === "macos") {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey;
}

function isEditableElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    el.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

function getActiveModalOverlay(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>(
    ".modal-overlay.active, .dialog-overlay.active",
  );
  return overlays.length > 0 ? overlays[overlays.length - 1] : null;
}

function isModalLayerActive(): boolean {
  return getActiveModalOverlay() !== null;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter(
    (node) =>
      !node.hasAttribute("disabled") &&
      node.getAttribute("aria-hidden") !== "true" &&
      (node.offsetWidth > 0 ||
        node.offsetHeight > 0 ||
        node.getClientRects().length > 0),
  );
}

function focusFirstInOverlay(overlay: HTMLElement): void {
  const focusable = getFocusableElements(overlay);
  const target = focusable[0] ?? overlay;
  if (target === overlay && target.tabIndex < 0) {
    target.tabIndex = -1;
  }
  target.focus();
}

function syncModalLayerState(): void {
  const overlay = getActiveModalOverlay();
  const hasActiveOverlay = !!overlay;

  document.body.classList.toggle("modal-open", hasActiveOverlay);
  if (hasActiveOverlay) {
    hideContextMenu();
  }

  if (hasActiveOverlay && !modalLayerActive) {
    focusBeforeModal =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  } else if (!hasActiveOverlay && modalLayerActive) {
    const restore = focusBeforeModal;
    focusBeforeModal = null;
    if (restore && document.contains(restore)) {
      restore.focus();
    }
  }
  modalLayerActive = hasActiveOverlay;

  const appRoot = document.getElementById("app") as HTMLElement | null;
  if (appRoot) {
    if (hasActiveOverlay) {
      appRoot.setAttribute("aria-hidden", "true");
    } else {
      appRoot.removeAttribute("aria-hidden");
    }
    if ("inert" in appRoot) {
      (appRoot as HTMLElement & { inert: boolean }).inert = hasActiveOverlay;
    }
  }

  if (overlay) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !overlay.contains(active)) {
      focusFirstInOverlay(overlay);
    }
  }
}

function trapFocusInModalLayer(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const overlay = getActiveModalOverlay();
  if (!overlay) return;

  const focusable = getFocusableElements(overlay);
  if (focusable.length === 0) {
    e.preventDefault();
    if (overlay.tabIndex < 0) overlay.tabIndex = -1;
    overlay.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  if (!active || !overlay.contains(active)) {
    e.preventDefault();
    first.focus();
    return;
  }

  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function handleTabListArrowKey(
  e: KeyboardEvent,
  tabs: HTMLElement[],
  activate: (tab: HTMLElement) => void,
): void {
  if (tabs.length === 0) return;
  if (
    e.key !== "ArrowRight" &&
    e.key !== "ArrowLeft" &&
    e.key !== "ArrowDown" &&
    e.key !== "ArrowUp" &&
    e.key !== "Home" &&
    e.key !== "End"
  ) {
    return;
  }

  const focused = (e.target as HTMLElement).closest<HTMLElement>(
    '[role="tab"]',
  );
  if (!focused) return;
  const index = tabs.indexOf(focused);
  if (index < 0) return;

  e.preventDefault();

  let nextIndex = index;
  if (e.key === "Home") {
    nextIndex = 0;
  } else if (e.key === "End") {
    nextIndex = tabs.length - 1;
  } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    nextIndex = (index + 1) % tabs.length;
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    nextIndex = (index - 1 + tabs.length) % tabs.length;
  }

  const nextTab = tabs[nextIndex];
  activate(nextTab);
  nextTab.focus();
}

async function uniqueDownloadEntries(
  keys: string[],
  destinationDir: string,
): Promise<DownloadQueueEntry[]> {
  const taken = new Set<string>();
  const entries: DownloadQueueEntry[] = [];
  const caseInsensitive =
    state.platformName === "windows" || state.platformName === "macos";
  const dedupeKey = (name: string) =>
    caseInsensitive ? name.toLowerCase() : name;

  for (const key of keys) {
    const base = basename(key);
    const { stem, ext } = splitNameExt(base);
    let candidate = base;
    let n = 2;
    while (taken.has(dedupeKey(candidate))) {
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    }
    taken.add(dedupeKey(candidate));
    entries.push({
      bucket: state.currentBucket,
      key,
      destination: joinPath(destinationDir, candidate),
    });
  }

  return entries;
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
  ).value.trim();
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
  if (!endpoint || !accessKey || !secretKey) {
    setStatus("Endpoint, access key, and secret key are required.");
    return;
  }

  dom.connectBtn.disabled = true;
  setStatus("Connecting...");

  try {
    const resolvedRegion = await connect(
      endpoint,
      region,
      accessKey,
      secretKey,
    );
    (document.getElementById("conn-region") as HTMLInputElement).value =
      resolvedRegion;
    setConnectionUI(true);
    setStatus("Connected.", 5000);
    logActivity(`Connected to ${endpoint}.`, "success");
    try {
      await saveConnection(endpoint, resolvedRegion, accessKey, secretKey);
    } catch (saveErr) {
      setStatus(`Connected (credentials not saved: ${saveErr}).`, 5000);
      logActivity(
        `Connected, but failed to save credentials: ${saveErr}`,
        "warning",
      );
    }
    await refreshBuckets();
    renderBucketList();
    if (state.buckets.length > 0) {
      await selectBucket(state.buckets[0].name);
    }
  } catch (e) {
    setStatus(`Connection failed: ${e}`);
    setConnectionUI(false);
    logActivity(`Connection failed: ${String(e)}`, "error");
  } finally {
    dom.connectBtn.disabled = false;
  }
}

async function handleDisconnect(): Promise<void> {
  await disconnect();
  setConnectionUI(false);
  showEmptyState();
  setStatus("Disconnected.", 5000);
  logActivity("Disconnected from endpoint.", "info");
}

async function handleBookmarkSave(): Promise<void> {
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !accessKey) {
    setStatus("Fill in endpoint and access key to bookmark.");
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
    const added = await addBookmark({
      name,
      endpoint,
      region,
      access_key: accessKey,
      secret_key: secretKey,
    });
    if (added) {
      setStatus(`Bookmarked "${name}".`, 5000);
    } else {
      setStatus(`Bookmark for this endpoint already exists.`, 5000);
    }
  } catch (err) {
    setStatus(`Failed to save bookmark: ${err}`);
  }
}

function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys).filter((k) => !k.startsWith("prefix:"));
}

async function handleDelete(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) {
    const hasFolders = Array.from(state.selectedKeys).some((k) =>
      k.startsWith("prefix:"),
    );
    if (hasFolders) {
      setStatus(
        "Folder deletion is not supported. Select individual files to delete.",
        5000,
      );
    }
    return;
  }

  const msg =
    keys.length === 1
      ? `Delete "${basename(keys[0])}"?`
      : `Delete ${keys.length} items?`;
  const confirmed = await showConfirm("Delete", msg, {
    okLabel: "Delete",
    okDanger: true,
  });
  if (!confirmed) return;

  try {
    setStatus(`Deleting ${keys.length} item(s)...`);
    const deleted = await invoke<number>("delete_objects", {
      bucket: state.currentBucket,
      keys,
    });
    setStatus(`Deleted ${deleted} item(s).`, 5000);
    logActivity(`Deleted ${deleted} object(s).`, "success");
    clearSelection();
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    setStatus(`Delete failed: ${err}`);
    logActivity(`Delete failed: ${String(err)}`, "error");
  }
}

async function handleDownload(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;
  const entries: DownloadQueueEntry[] = [];

  if (keys.length === 1) {
    const fileName = basename(keys[0]);
    const destination = await save({
      defaultPath: fileName,
      title: `Save ${fileName}`,
    });
    if (!destination) return;
    entries.push({
      bucket: state.currentBucket,
      key: keys[0],
      destination,
    });
  } else {
    const selected = await open({
      title: "Select destination folder",
      multiple: false,
      directory: true,
    });
    if (!selected || Array.isArray(selected)) return;
    entries.push(...(await uniqueDownloadEntries(keys, selected)));
  }

  if (entries.length === 0) return;

  if (enqueueDownloadTransfers(entries)) {
    setStatus(`Queued ${entries.length} download(s).`, 5000);
    logActivity(`Queued ${entries.length} download(s).`, "info");
    return;
  }

  for (const entry of entries) {
    try {
      setStatus(`Downloading ${basename(entry.key)}...`);
      const size = await invoke<number>("download_object", {
        bucket: entry.bucket,
        key: entry.key,
        destination: entry.destination,
      });
      setStatus(
        `Downloaded ${basename(entry.key)} (${formatSize(size)}).`,
        5000,
      );
      logActivity(
        `Downloaded ${basename(entry.key)} (${formatSize(size)}).`,
        "success",
      );
    } catch (err) {
      setStatus(`Download failed: ${err}`);
      logActivity(
        `Download failed for ${basename(entry.key)}: ${String(err)}`,
        "error",
      );
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
    setStatus("URL copied to clipboard.", 5000);
    logActivity(`Copied URL for ${basename(keys[0])}.`, "success");
  } catch (err) {
    setStatus(`Failed to copy URL: ${err}`);
    logActivity(`Failed to copy URL: ${String(err)}`, "error");
  }
}

async function handleCopyPresignedUrl(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length !== 1) return;
  const expiresInSecs = 3600;

  try {
    const url = await invoke<string>("generate_presigned_url", {
      bucket: state.currentBucket,
      key: keys[0],
      expiresInSecs,
    });
    await navigator.clipboard.writeText(url);
    setStatus("Pre-signed URL copied (expires in 1 hour).", 5000);
    logActivity(`Copied pre-signed URL for ${basename(keys[0])}.`, "success");
  } catch (err) {
    setStatus(`Failed to create pre-signed URL: ${err}`);
    logActivity(`Failed to create pre-signed URL: ${String(err)}`, "error");
  }
}

async function handleRename(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length !== 1) return;

  const oldKey = keys[0];
  const oldName = basename(oldKey);
  const newName = await showPrompt("Rename", "Enter new name:", {
    inputDefault: oldName,
  });
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
    setStatus(`Renamed to "${newName}".`, 5000);
    logActivity(`Renamed ${oldName} to ${newName}.`, "success");
    clearSelection();
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
  } catch (err) {
    setStatus(`Rename failed: ${err}`);
    logActivity(`Rename failed for ${oldName}: ${String(err)}`, "error");
  }
}

async function handleCreateFolder(): Promise<void> {
  if (!state.connected || !state.currentBucket) {
    setStatus("Connect to a bucket first.");
    return;
  }

  const name = await showPrompt("New Folder", "Enter folder name:", {
    inputPlaceholder: "Folder name",
  });
  if (!name) return;

  const key = state.currentPrefix + name;

  try {
    setStatus("Creating folder...");
    await invoke("create_folder", {
      bucket: state.currentBucket,
      key,
    });
    setStatus(`Created folder "${name}".`, 5000);
    logActivity(`Created folder ${name}.`, "success");
    await refreshObjects(state.currentBucket, state.currentPrefix);
    renderObjectTable();
  } catch (err) {
    setStatus(`Failed to create folder: ${err}`);
    logActivity(`Failed to create folder ${name}: ${String(err)}`, "error");
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

async function handleRefreshBuckets(): Promise<void> {
  if (!state.connected) return;
  try {
    setStatus("Refreshing buckets...");
    await refreshBuckets();
    renderBucketList();
    setStatus("Buckets refreshed.", 3000);
  } catch (err) {
    setStatus(`Failed to refresh buckets: ${err}`);
    logActivity(`Failed to refresh buckets: ${String(err)}`, "error");
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

async function handleUploadFolderButton(): Promise<void> {
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
    setStatus(`Folder upload failed: ${err}`);
    logActivity(`Folder upload failed: ${String(err)}`, "error");
  }
}

async function queueDroppedPaths(
  paths: string[],
  targetPrefix: string,
): Promise<void> {
  const cleaned = paths.filter((path) => path.trim().length > 0);
  if (cleaned.length === 0) return;

  const ext = transferExtensions();
  if (!ext.enqueueFolderEntries && !ext.enqueueFolderPaths) {
    enqueuePaths(cleaned, targetPrefix);
    return;
  }

  try {
    const entries = await invoke<LocalFolderFileEntry[]>(
      "list_local_files_recursive",
      { roots: cleaned },
    );
    if (entries.length > 0 && enqueueFolderTransfers(entries, targetPrefix)) {
      return;
    }
  } catch (err) {
    logActivity(
      `Folder structure scan failed for dropped files: ${err}`,
      "error",
    );
  }

  enqueuePaths(cleaned, targetPrefix);
}

function handleBucketContextMenu(e: MouseEvent): void {
  if (!state.connected) return;

  const bucketButton = (e.target as HTMLElement).closest<HTMLElement>(
    ".list__item-btn",
  );
  const inBucketPanel = (e.target as HTMLElement).closest("#bucket-panel");
  if (!inBucketPanel) return;

  e.preventDefault();

  if (bucketButton?.dataset.bucket) {
    const bucket = bucketButton.dataset.bucket;
    const menuItems: MenuItem[] = [
      { label: "Open Bucket", action: "open-bucket" },
      { label: "Copy Bucket Name", action: "copy-bucket-name" },
      { separator: true },
      { label: "Refresh Buckets", action: "refresh-buckets" },
    ];

    showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
      if (action === "open-bucket") {
        void selectBucket(bucket)
          .then(() => closeSidebarOnMobile())
          .catch((err) => {
            setStatus(`Failed to open bucket "${bucket}": ${err}`);
            logActivity(
              `Failed to open bucket "${bucket}": ${String(err)}`,
              "error",
            );
          });
      } else if (action === "copy-bucket-name") {
        void navigator.clipboard
          .writeText(bucket)
          .then(() => setStatus(`Copied bucket name "${bucket}".`, 3000))
          .catch((err) => setStatus(`Failed to copy bucket name: ${err}`));
      } else if (action === "refresh-buckets") {
        void handleRefreshBuckets();
      }
    });
    return;
  }

  showContextMenu(
    e.clientX,
    e.clientY,
    [{ label: "Refresh Buckets", action: "refresh-buckets" }],
    () => {
      void handleRefreshBuckets();
    },
  );
}

function wireLayoutControls(): void {
  const toggleBtn = document.getElementById("sidebar-toggle");
  const backdrop = document.getElementById("sidebar-backdrop");
  const sidebar = document.getElementById("bucket-panel");
  const resizer = document.getElementById("sidebar-resizer");
  if (!sidebar || !resizer) return;

  const savedWidthRaw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  const savedWidth = savedWidthRaw ? Number(savedWidthRaw) : NaN;
  const updateResizerAria = (width: number) => {
    const rounded = Math.round(clampSidebarWidth(width));
    resizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
    resizer.setAttribute("aria-valuemax", String(SIDEBAR_MAX));
    resizer.setAttribute("aria-valuenow", String(rounded));
    resizer.setAttribute("aria-valuetext", `${rounded} pixels`);
  };
  const readSidebarWidth = () => sidebar.getBoundingClientRect().width;
  const persistSidebarWidth = (width: number) => {
    const clamped = clampSidebarWidth(width);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(clamped));
  };
  if (Number.isFinite(savedWidth)) {
    applySidebarWidth(savedWidth);
    updateResizerAria(savedWidth);
  } else {
    updateResizerAria(readSidebarWidth());
  }

  const syncSidebarMode = () => {
    if (!isMobileSidebarMode()) {
      setSidebarOpen(false);
    }
  };
  syncSidebarMode();

  toggleBtn?.addEventListener("click", toggleSidebar);
  backdrop?.addEventListener("click", () => setSidebarOpen(false));
  window.addEventListener("resize", syncSidebarMode);

  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  const onMouseMove = (event: MouseEvent) => {
    if (!dragging) return;
    const delta = event.clientX - dragStartX;
    const nextWidth = clampSidebarWidth(dragStartWidth + delta);
    applySidebarWidth(nextWidth);
    updateResizerAria(nextWidth);
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("sidebar-resizer--active");
    document.body.style.cursor = "";
    const width = readSidebarWidth();
    persistSidebarWidth(width);
    updateResizerAria(width);
  };

  resizer.addEventListener("mousedown", (event) => {
    if (isMobileSidebarMode()) return;
    event.preventDefault();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = sidebar.getBoundingClientRect().width;
    resizer.classList.add("sidebar-resizer--active");
    document.body.style.cursor = "col-resize";
  });

  resizer.addEventListener("keydown", (event) => {
    if (isMobileSidebarMode()) return;
    const currentWidth = readSidebarWidth();
    const step = event.shiftKey ? 40 : 16;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = currentWidth - step;
    } else if (event.key === "ArrowRight") {
      nextWidth = currentWidth + step;
    } else if (event.key === "Home") {
      nextWidth = SIDEBAR_MIN;
    } else if (event.key === "End") {
      nextWidth = SIDEBAR_MAX;
    }

    if (nextWidth === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(nextWidth);
    applySidebarWidth(clamped);
    persistSidebarWidth(clamped);
    updateResizerAria(clamped);
  });

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
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
          { label: "Upload Files", action: "upload-files" },
          { label: "Upload Folder", action: "upload-folder" },
          { separator: true },
          { label: "Refresh", action: "refresh" },
        ],
        (action) => {
          if (action === "new-folder") handleCreateFolder();
          else if (action === "upload-files") handleUploadButton();
          else if (action === "upload-folder") handleUploadFolderButton();
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
      const fileName = basename(fileKeys[0]);
      if (canPreview(fileName)) {
        items.push({ label: "Preview", action: "preview" });
      }
      items.push({ label: "Get Info", action: "info" });
      items.push({ label: "Download", action: "download" });
      items.push({ label: "Copy URL", action: "copy-url" });
      items.push({
        label: "Copy Pre-Signed URL",
        action: "copy-presigned-url",
      });
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
    if (action === "preview") void openPreview(fileKeys[0]);
    else if (action === "info") openInfoPanel(fileKeys);
    else if (action === "download") handleDownload();
    else if (action === "copy-url") handleCopyUrl();
    else if (action === "copy-presigned-url") handleCopyPresignedUrl();
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
  const settingsTabs = document.querySelector<HTMLElement>(".settings-tabs");
  settingsTabs!.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".settings-tab");
    if (tab?.dataset.settingsTab) switchSettingsTab(tab.dataset.settingsTab);
  });
  settingsTabs!.addEventListener("keydown", (e) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>(".settings-tab"),
    );
    handleTabListArrowKey(e as KeyboardEvent, tabs, (tab) => {
      if (tab.dataset.settingsTab) {
        switchSettingsTab(tab.dataset.settingsTab);
      }
    });
  });
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
      const persistedChannel = state.lastPersistedSettings.updateChannel;
      const channelSelect = document.getElementById(
        "setting-update-channel",
      ) as HTMLSelectElement | null;
      setUpdateChannel(channelSelect?.value === "beta" ? "beta" : "release");
      closeSettingsModal(false);
      void checkUpdates().finally(() => {
        setUpdateChannel(persistedChannel);
      });
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

  const infoTabs = document.querySelector<HTMLElement>(".info-tabs");
  infoTabs!.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".info-tab");
    if (tab?.dataset.tab) switchTab(tab.dataset.tab);
  });
  infoTabs!.addEventListener("keydown", (e) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>(".info-tab"),
    );
    handleTabListArrowKey(e as KeyboardEvent, tabs, (tab) => {
      if (tab.dataset.tab) {
        switchTab(tab.dataset.tab);
      }
    });
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
  void initTransferQueueUI().catch((err) => {
    console.error("Failed to initialize transfer queue UI:", err);
    logActivity(`Transfer queue events unavailable: ${String(err)}`, "warning");
  });
  window.addEventListener("beforeunload", () => {
    if (filterInputDebounce !== undefined) {
      clearTimeout(filterInputDebounce);
      filterInputDebounce = undefined;
    }
    if (modalLayerObserver) {
      modalLayerObserver.disconnect();
      modalLayerObserver = null;
    }
    document.removeEventListener("keydown", trapFocusInModalLayer, true);
    void disposeTransferQueueUI();
  });

  document
    .getElementById("preview-close")!
    .addEventListener("click", closePreview);
  document.getElementById("preview-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  document
    .getElementById("activity-toggle")!
    .addEventListener("click", toggleActivityLog);
  document
    .getElementById("activity-collapse")!
    .addEventListener("click", toggleActivityCollapsed);
  document
    .getElementById("activity-close")!
    .addEventListener("click", hideActivityLog);
  document
    .getElementById("activity-clear")!
    .addEventListener("click", clearActivityLog);

  document.getElementById("security-toggle")!.addEventListener("click", () => {
    void handleSecurityToggle(setStatus);
  });
  document
    .getElementById("security-change-password")!
    .addEventListener("click", () => {
      void handleSecurityChangePassword(setStatus);
    });
  document
    .getElementById("security-lock-btn")!
    .addEventListener("click", () => {
      void handleLockNow(setStatus);
    });
  document
    .getElementById("security-lock-timeout")!
    .addEventListener("change", () => {
      void handleLockTimeoutChange();
    });
  document.getElementById("biometric-toggle")!.addEventListener("click", () => {
    void handleBiometricToggle(setStatus);
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
    .getElementById("btn-upload-folder")!
    .addEventListener("click", handleUploadFolderButton);

  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement;
  filterInput.addEventListener("input", () => {
    state.filterText = filterInput.value;
    if (filterInputDebounce !== undefined) {
      clearTimeout(filterInputDebounce);
    }
    filterInputDebounce = setTimeout(() => {
      renderObjectTable();
      filterInputDebounce = undefined;
    }, FILTER_INPUT_DEBOUNCE_MS);
  });

  const loadMoreBtn = document.getElementById(
    "btn-load-more",
  ) as HTMLButtonElement;
  loadMoreBtn.addEventListener("click", async () => {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading\u2026";
    setStatus("Loading more...");
    try {
      await loadMoreObjects();
      renderObjectTable();
      setStatus("");
    } finally {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load more";
    }
  });

  document.querySelectorAll<HTMLElement>(".sort-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const th = trigger.closest<HTMLElement>(".col-sortable");
      const col = th?.dataset.sort as "name" | "size" | "modified" | undefined;
      if (col) toggleSort(col);
    });
  });

  dom.bucketList.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      ".list__item-btn",
    );
    if (!button) return;
    const bucket = button.dataset.bucket;
    if (bucket) {
      void selectBucket(bucket)
        .then(() => closeSidebarOnMobile())
        .catch((err) => {
          setStatus(`Failed to open bucket "${bucket}": ${err}`);
          logActivity(
            `Failed to open bucket "${bucket}": ${String(err)}`,
            "error",
          );
        });
    }
  });
  dom.bucketPanel.addEventListener("contextmenu", handleBucketContextMenu);

  dom.objectTbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;
    if (target.closest(".row-check")) return;

    if (
      row.classList.contains("object-row--folder") &&
      !target.closest(".col-check")
    ) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) navigateToFolder(prefix);
      return;
    }

    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    handleRowClick(key, e);
  });

  dom.objectTbody.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(
      ".row-check",
    );
    if (!input) return;
    const row = input.closest<HTMLElement>(".object-row");
    if (!row) return;
    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    if (input.checked) {
      state.selectedKeys.add(key);
    } else {
      state.selectedKeys.delete(key);
    }
    updateSelectionUI();
  });

  dom.objectTbody.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
    if (!row) return;
    if ((e.target as HTMLElement).closest(".row-check")) return;

    if (e.key === " ") {
      e.preventDefault();
      const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
      if (state.selectedKeys.has(key)) {
        state.selectedKeys.delete(key);
      } else {
        state.selectedKeys.add(key);
      }
      updateSelectionUI();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (row.classList.contains("object-row--folder")) {
        const prefix = row.dataset.prefix;
        if (prefix !== undefined) {
          void navigateToFolder(prefix);
        }
        return;
      }

      const key = row.dataset.key;
      if (!key) return;
      if (canPreview(basename(key))) {
        void openPreview(key);
      } else {
        void openInfoPanel([key]);
      }
    }
  });

  dom.objectTbody.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
    if (!row) return;
    if (row.classList.contains("object-row--folder")) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) void navigateToFolder(prefix);
      return;
    }
    const key = row.dataset.key;
    if (!key) return;
    if (canPreview(basename(key))) {
      void openPreview(key);
    } else {
      void openInfoPanel([key]);
    }
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
        void queueDroppedPaths(paths, state.currentPrefix);
      } else {
        enqueueFiles(files, state.currentPrefix);
      }
    }
  });

  setTransferCompleteHandler(async (summary) => {
    if (summary.hadUpload && state.connected && state.currentBucket) {
      await refreshObjects(state.currentBucket, state.currentPrefix);
      renderObjectTable();
    }
  });

  wireLayoutControls();

  if (!modalLayerObserver) {
    modalLayerObserver = new MutationObserver(() => {
      syncModalLayerState();
    });
    document
      .querySelectorAll<HTMLElement>(".modal-overlay, .dialog-overlay")
      .forEach((overlay) => {
        modalLayerObserver!.observe(overlay, {
          attributes: true,
          attributeFilter: ["class", "hidden"],
        });
      });
    document.addEventListener("keydown", trapFocusInModalLayer, true);
  }
  syncModalLayerState();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();

      if (isDialogActive()) return;

      const previewOverlay = document.getElementById("preview-overlay");
      if (previewOverlay?.classList.contains("active")) {
        closePreview();
        return;
      }

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

      const layout = document.getElementById("main-layout");
      if (layout?.classList.contains("main-layout--sidebar-open")) {
        setSidebarOpen(false);
        return;
      }

      const activityOverlay = document.getElementById(
        "activity-overlay",
      ) as HTMLDivElement | null;
      if (activityOverlay && !activityOverlay.hidden) {
        hideActivityLog();
        return;
      }

      const overlay = document.getElementById("settings-overlay");
      if (overlay?.classList.contains("active")) {
        closeSettingsModal(false);
      }
    }

    const inInput = isEditableElement(document.activeElement);
    const modalOpen = isModalLayerActive();
    const accel = hasAccelModifier(e);
    const key = e.key.toLowerCase();

    if (e.key === "Delete" && state.selectedKeys.size > 0) {
      if (inInput || modalOpen) return;
      handleDelete();
    }

    if (e.key === "F5" || (accel && key === "r")) {
      e.preventDefault();
      if (modalOpen) return;
      handleRefresh();
      return;
    }

    if (modalOpen) return;

    if (!inInput) {
      if (e.key === "F2" && state.selectedKeys.size === 1) {
        e.preventDefault();
        handleRename();
      }

      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
        e.preventDefault();
        navigateUp();
      }
    }

    if (accel) {
      if (key === "a" && !inInput) {
        e.preventDefault();
        const allKeys = getSelectableKeys();
        for (const k of allKeys) state.selectedKeys.add(k);
        updateSelectionUI();
      }

      if (key === "u" && !inInput) {
        e.preventDefault();
        if (e.shiftKey) {
          handleUploadFolderButton();
        } else {
          handleUploadButton();
        }
      }

      if (key === "n" && !inInput) {
        e.preventDefault();
        handleCreateFolder();
      }

      if (key === "f") {
        e.preventDefault();
        const filterEl = document.getElementById(
          "filter-input",
        ) as HTMLInputElement | null;
        if (filterEl) {
          filterEl.focus();
          filterEl.select();
        }
      }
    }
  });

  setBookmarkSelectHandler((bookmark) => {
    setConnectionInputs(
      bookmark.endpoint,
      bookmark.region,
      bookmark.access_key,
      bookmark.secret_key,
    );
    setStatus(`Loaded bookmark "${bookmark.name}".`, 5000);
  });
}

async function init(): Promise<void> {
  wireEvents();

  const securityReady = await ensureSecurityReady();
  if (!securityReady) {
    setStatus(
      "Secure storage is locked. Saved settings and credentials are unavailable.",
    );
    logActivity(
      "Secure storage is locked. Saved settings and credentials are unavailable.",
      "warning",
    );
  }

  try {
    await loadSettings();
  } catch (err) {
    setStatus(`Failed to load settings: ${String(err)}`);
    logActivity(`Failed to load settings: ${String(err)}`, "error");
  }

  state.platformName = await invoke<string>("get_platform_info");
  applyPlatformClass();
  updateShortcutChips();
  const version = await getVersion();
  dom.versionLabel.textContent = `v${version}`;

  if (securityReady) {
    try {
      const saved = await loadConnection();
      if (saved) {
        setConnectionInputs(
          saved.endpoint,
          saved.region,
          saved.access_key,
          saved.secret_key,
        );
      }
    } catch (err) {
      setStatus(`Failed to load saved connection: ${String(err)}`);
      logActivity(`Failed to load saved connection: ${String(err)}`, "error");
    }
  }

  await initUpdater();
  autoCheckUpdates();
}

init().catch((err) => {
  console.error("Init error:", err);
});
