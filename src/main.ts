import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { relaunch } from "@tauri-apps/plugin-process";
import { open, save } from "@tauri-apps/plugin-dialog";
import { state, dom } from "./state.ts";
import {
  loadSettings,
  openSettingsModal,
  closeSettingsModal,
  resetSettings,
  setBookmarkSelectHandler,
  switchSettingsTab,
  incrementLaunchCount,
  markSupportPromptDismissed,
  isSupportPromptDismissed,
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
  getSelectableKeys,
  toggleSort,
  navigateUp,
  navigateBack,
  navigateForward,
  clearNavHistory,
  pruneStaleSelection,
} from "./browser.ts";
import {
  initUpdater,
  autoCheckUpdates,
  checkUpdates,
  setUpdateChannel,
} from "./updater.ts";
import {
  addBookmark,
  renderBookmarkBar,
  loadBookmarks,
  setBookmarkChangeHandler,
  isEndpointBookmarked,
  clearBookmarks,
} from "./bookmarks.ts";
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
  clearCompletedTransfers,
  enqueuePaths,
  setTransferCompleteHandler,
  initTransferQueueUI,
  disposeTransferQueueUI,
  enqueueDownloads,
  enqueueFolderEntries,
  enqueueCopyMoveEntries,
  type CopyMoveQueueEntry,
} from "./transfers.ts";
import {
  basename,
  formatSize,
  splitNameExt,
  joinPath,
  friendlyError,
} from "./utils.ts";
import { wireKeyboardShortcuts } from "./keyboard.ts";
import { canPreview, openPreview, closePreview } from "./preview.ts";
import {
  logActivity,
  toggleActivityLog,
  clearActivityLog,
  exportActivityLogText,
} from "./activity-log.ts";
import { initDrawer, getActiveTab } from "./bottom-drawer.ts";
import {
  ensureSecurityReady,
  handleSecurityChangePassword,
  handleSecurityToggle,
  handleLockNow,
  handleLockTimeoutChange,
  handleBiometricToggle,
} from "./security.ts";
import {
  showConfirm,
  showPrompt,
  showAlert,
  isDialogActive,
} from "./dialogs.ts";
import {
  initPalette,
  registerCommands,
  isPaletteOpen,
} from "./command-palette.ts";
import {
  shouldShowSetupWizard,
  showSetupWizard,
  markSetupComplete,
} from "./setup-wizard.ts";
import type { ConflictPolicy } from "./settings-model.ts";

interface LocalFolderFileEntry {
  file_path: string;
  relative_path: string;
  size: number;
}

interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
  conflictResolution?: Exclude<ConflictPolicy, "ask">;
}

interface HeadObjectSummary {
  content_length: number;
}

interface RecentCopyMoveDestination {
  bucket: string;
  path: string;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORAGE_KEY = "s3-sidekick.sidebar.width";
const FILTER_INPUT_DEBOUNCE_MS = 120;
const LAST_DOWNLOAD_DIR_STORAGE_KEY = "s3-sidekick.last-download-dir";
const RECENT_DOWNLOAD_DIRS_STORAGE_KEY = "s3-sidekick.recent-download-dirs.v1";
const RECENT_COPY_MOVE_DESTS_STORAGE_KEY =
  "s3-sidekick.recent-copy-move-destinations.v1";
const RECENT_DESTINATION_LIMIT = 8;
const DOWNLOAD_DISK_PREFLIGHT_THRESHOLD_BYTES = 128 * 1024 * 1024;
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

function updateBookmarkBtn(): void {
  const btn = document.getElementById("bookmark-save-btn");
  if (!btn) return;
  const { endpoint } = getConnectionInputs();
  const active = endpoint ? isEndpointBookmarked(endpoint) : false;
  btn.classList.toggle("bookmark-save-btn--active", active);
}

function refreshBookmarkBar(): void {
  const bar = document.getElementById("bookmark-bar");
  if (!bar) return;
  renderBookmarkBar(
    bar,
    (bookmark) => {
      void switchToBookmark(
        bookmark.name,
        bookmark.endpoint,
        bookmark.region,
        bookmark.access_key,
        bookmark.secret_key,
      );
    },
    state.connected ? state.endpoint : undefined,
    () => {
      void handleNewConnection();
    },
  );
  updateBookmarkBtn();
}

async function handleNewConnection(): Promise<void> {
  if (state.connected) {
    await handleDisconnect();
  }
  setConnectionInputs("", "", "", "");
  (document.getElementById("conn-endpoint") as HTMLInputElement).focus();
  setStatus("Ready for a new connection.", 5000);
}

async function switchToBookmark(
  name: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): Promise<void> {
  const wasConnected = state.connected;
  if (wasConnected) {
    await handleDisconnect();
  }
  setConnectionInputs(endpoint, region, accessKey, secretKey);
  if (wasConnected) {
    await handleConnect();
  } else {
    setStatus(`Loaded bookmark "${name}".`, 5000);
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
  refreshBookmarkBar();
}

function enqueueDownloadTransfers(entries: DownloadQueueEntry[]): boolean {
  enqueueDownloads(entries);
  return true;
}

function enqueueFolderTransfers(
  entries: LocalFolderFileEntry[],
  targetPrefix: string,
): boolean {
  enqueueFolderEntries(entries, targetPrefix);
  return true;
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

function getActiveModalOverlay(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>(
    ".modal-overlay.active, .dialog-overlay.active, .support-overlay:not([hidden])",
  );
  return overlays.length > 0 ? overlays[overlays.length - 1] : null;
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

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

function readRecentDownloadDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DOWNLOAD_DIRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, RECENT_DESTINATION_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentDownloadDirs(dirs: string[]): void {
  try {
    localStorage.setItem(
      RECENT_DOWNLOAD_DIRS_STORAGE_KEY,
      JSON.stringify(dirs.slice(0, RECENT_DESTINATION_LIMIT)),
    );
  } catch {
    // best effort
  }
}

function rememberDownloadDirectory(dir: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  const normalized = dir.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(LAST_DOWNLOAD_DIR_STORAGE_KEY, normalized);
  } catch {
    // best effort
  }
  const updated = readRecentDownloadDirs().filter((entry) => entry !== normalized);
  updated.unshift(normalized);
  writeRecentDownloadDirs(updated);
}

function getRememberedDownloadDir(): string {
  try {
    const direct = localStorage.getItem(LAST_DOWNLOAD_DIR_STORAGE_KEY);
    if (direct && direct.trim().length > 0) return direct;
    return readRecentDownloadDirs()[0] ?? "";
  } catch {
    return "";
  }
}

function saveRememberedDownloadDir(path: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  const dir = parentDirectory(path);
  if (!dir) return;
  rememberDownloadDirectory(dir);
}

function saveRememberedDownloadDirectoryValue(dir: string): void {
  if (!state.currentSettings.rememberDownloadPath) return;
  if (!dir) return;
  rememberDownloadDirectory(dir);
}

function readRecentCopyMoveDestinations(): RecentCopyMoveDestination[] {
  try {
    const raw = localStorage.getItem(RECENT_COPY_MOVE_DESTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const rows: RecentCopyMoveDestination[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const bucket = String((entry as { bucket?: unknown }).bucket ?? "").trim();
      const path = String((entry as { path?: unknown }).path ?? "").trim();
      if (!bucket || !path) continue;
      const key = `${bucket}\n${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ bucket, path });
      if (rows.length >= RECENT_DESTINATION_LIMIT) break;
    }
    return rows;
  } catch {
    return [];
  }
}

function writeRecentCopyMoveDestinations(
  entries: RecentCopyMoveDestination[],
): void {
  try {
    localStorage.setItem(
      RECENT_COPY_MOVE_DESTS_STORAGE_KEY,
      JSON.stringify(entries.slice(0, RECENT_DESTINATION_LIMIT)),
    );
  } catch {
    // best effort
  }
}

function rememberCopyMoveDestination(bucket: string, path: string): void {
  const normalizedBucket = bucket.trim();
  const normalizedPath = path.trim().replace(/^\/+/, "");
  if (!normalizedBucket || !normalizedPath) return;
  const current = readRecentCopyMoveDestinations().filter(
    (entry) =>
      !(entry.bucket === normalizedBucket && entry.path === normalizedPath),
  );
  current.unshift({ bucket: normalizedBucket, path: normalizedPath });
  writeRecentCopyMoveDestinations(current);
}

interface ConflictPromptSession {
  applyAll: Exclude<ConflictPolicy, "ask"> | null;
}

async function resolveConflictChoice(
  label: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<Exclude<ConflictPolicy, "ask">> {
  if (session.applyAll) return session.applyAll;
  const replace = await showConfirm(
    "Conflict",
    `${label} already exists. Replace it?`,
    { okLabel: "Replace", cancelLabel: "Skip", okDanger: true },
  );
  const decision: Exclude<ConflictPolicy, "ask"> = replace ? "replace" : "skip";
  if (hasBatchRemainder) {
    const applyAll = await showConfirm(
      "Apply Choice",
      `Apply "${decision}" to remaining conflicts?`,
      { okLabel: "Apply to all", cancelLabel: "Only this one" },
    );
    if (applyAll) {
      session.applyAll = decision;
    }
  }
  return decision;
}

async function resolveDownloadEntriesWithConflicts(
  entries: DownloadQueueEntry[],
): Promise<DownloadQueueEntry[]> {
  const result: DownloadQueueEntry[] = [];
  const conflictPolicy = state.currentSettings.conflictPolicy;
  const session: ConflictPromptSession = { applyAll: null };
  let remainingConflicts = 0;

  const existingResults = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await invoke<boolean>("path_exists", {
          path: entry.destination,
        });
      } catch {
        return false;
      }
    }),
  );
  for (const exists of existingResults) {
    if (exists) remainingConflicts += 1;
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const exists = existingResults[i];
    if (!exists) {
      result.push({ ...entry });
      continue;
    }

    if (conflictPolicy === "replace") {
      result.push({ ...entry, conflictResolution: "replace" });
      remainingConflicts -= 1;
      continue;
    }
    if (conflictPolicy === "skip") {
      logActivity(
        `Skipped download for ${basename(entry.key)}: destination exists.`,
        "warning",
      );
      remainingConflicts -= 1;
      continue;
    }

    const decision = await resolveConflictChoice(
      entry.destination,
      session,
      remainingConflicts > 1,
    );
    remainingConflicts -= 1;
    if (decision === "replace") {
      result.push({ ...entry, conflictResolution: "replace" });
    } else {
      logActivity(
        `Skipped download for ${basename(entry.key)}: destination exists.`,
        "warning",
      );
    }
  }

  return result;
}

async function resolveObjectConflict(
  bucket: string,
  key: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<Exclude<ConflictPolicy, "ask">> {
  const conflictPolicy = state.currentSettings.conflictPolicy;
  let exists = false;
  try {
    exists = await invoke<boolean>("object_exists", { bucket, key });
  } catch {
    exists = false;
  }
  if (!exists) return "replace";
  if (conflictPolicy === "replace") return "replace";
  if (conflictPolicy === "skip") return "skip";
  return resolveConflictChoice(`${bucket}/${key}`, session, hasBatchRemainder);
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
      destination: joinPath(destinationDir, candidate, state.platformName),
    });
  }

  return entries;
}

function estimateKnownObjectSize(entry: DownloadQueueEntry): number | null {
  if (entry.bucket !== state.currentBucket) return null;
  const match = state.objects.find((obj) => obj.key === entry.key);
  if (!match) return null;
  return Number.isFinite(match.size) && match.size >= 0 ? match.size : null;
}

async function estimateDownloadEntryBytes(
  entry: DownloadQueueEntry,
): Promise<number> {
  const known = estimateKnownObjectSize(entry);
  if (known !== null) return known;
  try {
    const head = await invoke<HeadObjectSummary>("head_object", {
      bucket: entry.bucket,
      key: entry.key,
    });
    if (!Number.isFinite(head.content_length) || head.content_length < 0) return 0;
    return head.content_length;
  } catch {
    return 0;
  }
}

async function preflightDownloadDiskSpace(
  entries: DownloadQueueEntry[],
): Promise<boolean> {
  if (entries.length === 0) return true;

  const estimatedBytes = await Promise.all(
    entries.map((entry) => estimateDownloadEntryBytes(entry)),
  );
  const totalEstimatedBytes = estimatedBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (totalEstimatedBytes < DOWNLOAD_DISK_PREFLIGHT_THRESHOLD_BYTES) {
    return true;
  }

  const requiredByDirectory = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const dir = parentDirectory(entries[i].destination);
    if (!dir) continue;
    const size = estimatedBytes[i];
    if (!Number.isFinite(size) || size <= 0) continue;
    requiredByDirectory.set(dir, (requiredByDirectory.get(dir) ?? 0) + size);
  }
  if (requiredByDirectory.size === 0) return true;

  const shortages: Array<{ dir: string; required: number; available: number }> = [];
  for (const [dir, required] of requiredByDirectory) {
    try {
      const available = await invoke<number>("get_available_disk_bytes", { path: dir });
      if (!Number.isFinite(available) || available < 0) continue;
      if (available < required) {
        shortages.push({ dir, required, available });
      }
    } catch (err) {
      logActivity(
        `Disk preflight warning for ${dir}: ${friendlyError(err)}`,
        "warning",
      );
    }
  }
  if (shortages.length === 0) return true;

  const lines = shortages
    .slice(0, 3)
    .map(
      (row) =>
        `${row.dir} — need ${formatSize(row.required)}, have ${formatSize(row.available)}`,
    );
  if (shortages.length > 3) {
    lines.push(`+${shortages.length - 3} more destination(s)`);
  }
  const proceed = await showConfirm(
    "Low Disk Space",
    `Destination free space may be insufficient:\n${lines.join("\n")}\n\nQueue downloads anyway?`,
    { okLabel: "Queue anyway", cancelLabel: "Cancel queue", okDanger: true },
  );
  if (!proceed) {
    setStatus("Download queue cancelled by disk-space preflight.", 5000);
  }
  return proceed;
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
  updateBookmarkBtn();
}

async function handleConnect(): Promise<void> {
  if (state.connecting) return;
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !accessKey || !secretKey) {
    setStatus("Endpoint, access key, and secret key are required.");
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    setStatus("Endpoint must start with http:// or https://.");
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
    setStatus(`Connection failed: ${friendlyError(e)}`);
    setConnectionUI(false);
    logActivity(`Connection failed: ${friendlyError(e)}`, "error");
  } finally {
    dom.connectBtn.disabled = false;
  }
}

async function handleDisconnect(): Promise<void> {
  if (filterInputDebounce !== undefined) {
    clearTimeout(filterInputDebounce);
    filterInputDebounce = undefined;
  }
  state.filterText = "";
  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  if (filterInput) filterInput.value = "";

  try {
    await disconnect();
  } catch (err) {
    logActivity(`Disconnect error: ${err}`, "error");
  }
  clearNavHistory();
  clearSelection();
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
  updateBookmarkBtn();
}

function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys).filter((k) => !k.startsWith("prefix:"));
}

function getSelectedPrefixes(): string[] {
  return Array.from(state.selectedKeys)
    .filter((k) => k.startsWith("prefix:"))
    .map((k) => k.slice("prefix:".length));
}

async function handleDelete(): Promise<void> {
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

async function handleDownload(): Promise<void> {
  const keys = getSelectedFileKeys();
  if (keys.length === 0) return;
  const entries: DownloadQueueEntry[] = [];
  const rememberedDir = getRememberedDownloadDir();

  if (keys.length === 1) {
    const fileName = basename(keys[0]);
    const destination = await save({
      defaultPath: rememberedDir
        ? joinPath(rememberedDir, fileName, state.platformName)
        : fileName,
      title: `Save ${fileName}`,
    });
    if (!destination) return;
    saveRememberedDownloadDir(destination);
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
      defaultPath: rememberedDir || undefined,
    });
    if (!selected || Array.isArray(selected)) return;
    saveRememberedDownloadDirectoryValue(selected);
    entries.push(...(await uniqueDownloadEntries(keys, selected)));
  }

  if (entries.length === 0) return;
  const resolvedEntries = await resolveDownloadEntriesWithConflicts(entries);
  if (resolvedEntries.length === 0) {
    setStatus("No downloads queued (all conflicts were skipped).", 5000);
    return;
  }
  if (!(await preflightDownloadDiskSpace(resolvedEntries))) {
    return;
  }

  if (enqueueDownloadTransfers(resolvedEntries)) {
    setStatus(`Queued ${resolvedEntries.length} download(s).`, 5000);
    logActivity(`Queued ${resolvedEntries.length} download(s).`, "info");
    return;
  }

  for (const entry of resolvedEntries) {
    try {
      setStatus(`Downloading ${basename(entry.key)}...`);
      const size = await invoke<number>("download_object", {
        bucket: entry.bucket,
        key: entry.key,
        destination: entry.destination,
        overwrite: entry.conflictResolution === "replace",
        tempPath: `${entry.destination}.s3-sidekick.download.tmp`,
        attempt: 1,
        checksumVerification:
          state.currentSettings.enableTransferChecksumVerification,
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
      setStatus(
        `Download failed for ${basename(entry.key)}: ${friendlyError(err)}`,
      );
      logActivity(
        `Download failed for ${basename(entry.key)}: ${friendlyError(err)}`,
        "error",
      );
    }
  }
}

async function handleCopyUrl(): Promise<void> {
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

async function handleCopyPresignedUrl(): Promise<void> {
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

async function handleCopyKey(): Promise<void> {
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

async function handleCopyArn(): Promise<void> {
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

function openCopyMoveDialog(): void {
  const fileKeys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();
  if (fileKeys.length === 0 && prefixes.length === 0) return;

  const overlay = document.getElementById("copy-move-overlay")!;
  const descEl = document.getElementById("copy-move-desc") as HTMLElement;
  const bucketSelect = document.getElementById(
    "copy-move-bucket",
  ) as HTMLSelectElement;
  const pathInput = document.getElementById(
    "copy-move-path",
  ) as HTMLInputElement;
  const pathLabel = document.querySelector(
    'label[for="copy-move-path"]',
  ) as HTMLLabelElement;
  const copyBtn = document.getElementById(
    "copy-move-copy-btn",
  ) as HTMLButtonElement;
  const moveBtn = document.getElementById(
    "copy-move-move-btn",
  ) as HTMLButtonElement;
  const cancelBtn = document.getElementById(
    "copy-move-cancel",
  ) as HTMLButtonElement;
  const closeBtn = document.getElementById(
    "copy-move-close",
  ) as HTMLButtonElement;
  const recentWrap = document.getElementById(
    "copy-move-recent-wrap",
  ) as HTMLElement | null;
  const recentList = document.getElementById(
    "copy-move-recent-list",
  ) as HTMLElement | null;

  // Populate bucket dropdown from known buckets
  bucketSelect.innerHTML = "";
  for (const b of state.buckets) {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    if (b.name === state.currentBucket) opt.selected = true;
    bucketSelect.appendChild(opt);
  }
  // If no buckets in list, add the current one as fallback
  if (bucketSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = state.currentBucket;
    opt.textContent = state.currentBucket;
    bucketSelect.appendChild(opt);
  }

  const isSingleFile = fileKeys.length === 1 && prefixes.length === 0;
  const isSingleFolder = prefixes.length === 1 && fileKeys.length === 0;

  if (isSingleFile) {
    descEl.textContent = `File: ${fileKeys[0]}`;
    pathInput.value = fileKeys[0];
    pathLabel.textContent = "Destination key";
  } else if (isSingleFolder) {
    descEl.textContent = `Folder: ${prefixes[0]}`;
    pathInput.value = prefixes[0];
    pathLabel.textContent = "Destination prefix";
  } else {
    const parts: string[] = [];
    if (fileKeys.length > 0)
      parts.push(`${fileKeys.length} file${fileKeys.length !== 1 ? "s" : ""}`);
    if (prefixes.length > 0)
      parts.push(
        `${prefixes.length} folder${prefixes.length !== 1 ? "s" : ""}`,
      );
    descEl.textContent = `${parts.join(" + ")} — items placed under destination prefix`;
    pathInput.value = state.currentPrefix;
    pathLabel.textContent = "Destination prefix";
  }

  const browserPanel = document.getElementById(
    "copy-move-browser",
  ) as HTMLElement;
  const browserToggle = document.getElementById(
    "copy-move-browse-toggle",
  ) as HTMLButtonElement;
  const browserCrumbs = document.getElementById(
    "copy-move-browser-crumbs",
  ) as HTMLElement;
  const browserList = document.getElementById(
    "copy-move-browser-list",
  ) as HTMLElement;

  function renderRecentDestinations(): void {
    if (!recentWrap || !recentList) return;
    const recent = readRecentCopyMoveDestinations();
    if (recent.length === 0) {
      recentWrap.hidden = true;
      recentList.innerHTML = "";
      return;
    }
    const preferredBucket = bucketSelect.value || state.currentBucket;
    const ordered = [
      ...recent.filter((entry) => entry.bucket === preferredBucket),
      ...recent.filter((entry) => entry.bucket !== preferredBucket),
    ].slice(0, RECENT_DESTINATION_LIMIT);
    if (ordered.length === 0) {
      recentWrap.hidden = true;
      recentList.innerHTML = "";
      return;
    }
    recentWrap.hidden = false;
    recentList.innerHTML = "";
    for (const entry of ordered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-move-recent-item";
      button.textContent = `${entry.bucket}/${entry.path}`;
      button.title = `${entry.bucket}/${entry.path}`;
      button.addEventListener("click", () => {
        bucketSelect.value = entry.bucket;
        pathInput.value = entry.path;
        pathInput.focus();
      });
      recentList.appendChild(button);
    }
  }

  browserPanel.hidden = true;
  browserToggle.textContent = "Browse folders ▶";
  renderRecentDestinations();

  let loadFolderSeq = 0;

  async function loadFolders(prefix: string): Promise<void> {
    const seq = ++loadFolderSeq;
    browserList.innerHTML = "";
    browserList.insertAdjacentHTML(
      "beforeend",
      '<div class="copy-move-browser-loading">Loading…</div>',
    );
    renderBrowserCrumbs(prefix);

    try {
      const bucket = bucketSelect.value;
      const resp = await invoke<{ prefixes: string[] }>("list_objects", {
        bucket,
        prefix,
        delimiter: "/",
        continuationToken: "",
      });

      if (seq !== loadFolderSeq) return;

      browserList.innerHTML = "";

      if (resp.prefixes.length === 0) {
        browserList.insertAdjacentHTML(
          "beforeend",
          '<div class="copy-move-browser-empty">No subfolders</div>',
        );
        return;
      }

      for (const p of resp.prefixes) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-move-folder-item";
        btn.textContent = "\uD83D\uDCC1 " + name;
        btn.addEventListener("dblclick", () => void loadFolders(p));
        btn.addEventListener("click", () => {
          pathInput.value = isSingleFile ? p + basename(fileKeys[0]) : p;
        });
        btn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void loadFolders(p);
        });
        browserList.appendChild(btn);
      }
    } catch {
      browserList.innerHTML =
        '<div class="copy-move-browser-empty">Failed to load folders</div>';
    }
  }

  function renderBrowserCrumbs(prefix: string): void {
    browserCrumbs.innerHTML = "";
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.textContent = "/";
    rootBtn.addEventListener("click", () => void loadFolders(""));
    browserCrumbs.appendChild(rootBtn);

    if (prefix) {
      const parts = prefix.replace(/\/$/, "").split("/");
      let accumulated = "";
      for (let i = 0; i < parts.length; i++) {
        accumulated += parts[i] + "/";
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        browserCrumbs.appendChild(sep);

        if (i === parts.length - 1) {
          const current = document.createElement("span");
          current.className = "crumb-current";
          current.textContent = parts[i];
          browserCrumbs.appendChild(current);
        } else {
          const crumbBtn = document.createElement("button");
          crumbBtn.type = "button";
          crumbBtn.textContent = parts[i];
          const target = accumulated;
          crumbBtn.addEventListener("click", () => void loadFolders(target));
          browserCrumbs.appendChild(crumbBtn);
        }
      }
    }
  }

  browserToggle.onclick = () => {
    const willShow = browserPanel.hidden;
    browserPanel.hidden = !willShow;
    browserToggle.textContent = willShow
      ? "Browse folders ▼"
      : "Browse folders ▶";
    if (willShow) void loadFolders(state.currentPrefix);
  };

  bucketSelect.onchange = () => {
    renderRecentDestinations();
    if (!browserPanel.hidden) void loadFolders("");
  };

  const closeFn = () => {
    overlay.classList.remove("active");
    browserPanel.hidden = true;
  };

  const srcBucket = state.currentBucket;
  const conflictSession: ConflictPromptSession = { applyAll: null };

  const runCopy = async (move: boolean) => {
    const dstBucket = bucketSelect.value;
    const dstPath = pathInput.value.trim();
    if (!dstPath) {
      setStatus("Destination path is required.", 5000);
      pathInput.focus();
      return;
    }
    const action = move ? "move" : "copy";

    try {
      setStatus(`Preparing ${action} transfer(s)...`);
      const queuedEntries: CopyMoveQueueEntry[] = [];
      let skippedFiles = 0;
      let skippedFolders = 0;

      if (isSingleFile) {
        const decision = await resolveObjectConflict(
          dstBucket,
          dstPath,
          conflictSession,
          false,
        );
        if (decision === "skip") {
          setStatus(
            `Skipped "${basename(fileKeys[0])}" (destination exists).`,
            5000,
          );
          return;
        }
        queuedEntries.push({
          operation: move ? "move" : "copy",
          sourceBucket: srcBucket,
          fileName: basename(fileKeys[0]),
          sourceKey: fileKeys[0],
          destinationBucket: dstBucket,
          destinationKey: dstPath,
          conflictResolution: decision,
        });
      } else {
        const prefix = dstPath.endsWith("/") ? dstPath : dstPath + "/";
        for (const key of fileKeys) {
          const dstKey = prefix + basename(key);
          const decision = await resolveObjectConflict(
            dstBucket,
            dstKey,
            conflictSession,
            true,
          );
          if (decision === "skip") {
            skippedFiles += 1;
            continue;
          }
          queuedEntries.push({
            operation: move ? "move" : "copy",
            sourceBucket: srcBucket,
            fileName: basename(key),
            sourceKey: key,
            destinationBucket: dstBucket,
            destinationKey: dstKey,
            conflictResolution: decision,
          });
        }
        for (const srcPrefix of prefixes) {
          const folderName = basename(srcPrefix.replace(/\/$/, ""));
          const dstPrefix = isSingleFolder ? prefix : prefix + folderName + "/";
          let folderHasConflict = false;
          try {
            const existing = await invoke<{
              objects: Array<{ key: string }>;
              prefixes: string[];
            }>("list_objects", {
              bucket: dstBucket,
              prefix: dstPrefix,
              delimiter: "",
              continuationToken: "",
            });
            folderHasConflict =
              existing.objects.length > 0 || existing.prefixes.length > 0;
          } catch {
            folderHasConflict = false;
          }
          if (folderHasConflict) {
            let decision: Exclude<ConflictPolicy, "ask">;
            if (conflictSession.applyAll) {
              decision = conflictSession.applyAll;
            } else if (state.currentSettings.conflictPolicy === "replace") {
              decision = "replace";
            } else if (state.currentSettings.conflictPolicy === "skip") {
              decision = "skip";
            } else {
              decision = await resolveConflictChoice(
                `${dstBucket}/${dstPrefix}`,
                conflictSession,
                true,
              );
            }
            if (decision === "skip") {
              skippedFolders += 1;
              continue;
            }
            queuedEntries.push({
              operation: move ? "move" : "copy",
              sourceBucket: srcBucket,
              fileName: folderName,
              sourcePrefix: srcPrefix,
              destinationBucket: dstBucket,
              destinationPrefix: dstPrefix,
              conflictResolution: decision,
            });
            continue;
          }
          queuedEntries.push({
            operation: move ? "move" : "copy",
            sourceBucket: srcBucket,
            fileName: folderName,
            sourcePrefix: srcPrefix,
            destinationBucket: dstBucket,
            destinationPrefix: dstPrefix,
          });
        }
      }

      if (queuedEntries.length === 0) {
        setStatus("No copy/move transfers queued (all conflicts skipped).", 5000);
        return;
      }

      enqueueCopyMoveEntries(queuedEntries);
      rememberCopyMoveDestination(dstBucket, dstPath);
      const skippedTotal = skippedFiles + skippedFolders;
      const skippedLabel =
        skippedTotal > 0
          ? ` Skipped ${skippedTotal} due to destination conflicts.`
          : "";
      setStatus(
        `Queued ${queuedEntries.length} ${action} transfer(s).${skippedLabel}`,
        5000,
      );
      logActivity(
        `Queued ${queuedEntries.length} ${action} transfer(s) to "${dstBucket}/${dstPath}".${skippedLabel}`,
        "success",
      );
      closeFn();
      clearSelection();
    } catch (err) {
      setStatus(`${move ? "Move" : "Copy"} failed: ${friendlyError(err)}`);
      logActivity(
        `${move ? "Move" : "Copy"} failed: ${friendlyError(err)}`,
        "error",
      );
    }
  };

  copyBtn.onclick = () => void runCopy(false);
  moveBtn.onclick = () => void runCopy(true);
  cancelBtn.onclick = closeFn;
  closeBtn.onclick = closeFn;

  overlay.classList.add("active");
  pathInput.focus();
  pathInput.select();
}

async function handleRename(): Promise<void> {
  const keys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();

  if (keys.length === 1 && prefixes.length === 0) {
    // Rename a single file
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
    // Rename a single folder
    const oldPrefix = prefixes[0]; // e.g. "photos/vacation/"
    const folderName = basename(oldPrefix.replace(/\/$/, "")); // "vacation"
    const parentPrefix = oldPrefix.slice(
      0,
      oldPrefix.length - folderName.length - 1,
    ); // "photos/"

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

async function handleCreateFolder(): Promise<void> {
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

async function handleRefresh(): Promise<void> {
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

async function handleRefreshBuckets(): Promise<void> {
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

async function handleExportActivityLog(): Promise<void> {
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

async function handleOpenLastDownloadFolder(): Promise<void> {
  const dir = getRememberedDownloadDir();
  if (!dir) {
    setStatus("No remembered download folder.", 5000);
    return;
  }
  try {
    await invoke("open_local_path", { path: dir });
    setStatus("Opened last download folder.", 3000);
  } catch (err) {
    setStatus(`Failed to open folder: ${friendlyError(err)}`);
  }
}

async function handleGoToKeyOrPrefix(): Promise<void> {
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
    setStatus(`Folder upload failed: ${friendlyError(err)}`);
    logActivity(`Folder upload failed: ${friendlyError(err)}`, "error");
  }
}

async function queueDroppedPaths(
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
      { label: "Copy Bucket ARN", action: "copy-bucket-arn" },
      { separator: true },
      { label: "Refresh Buckets", action: "refresh-buckets" },
    ];

    showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
      if (action === "open-bucket") {
        void selectBucket(bucket)
          .then(() => closeSidebarOnMobile())
          .catch((err) => {
            setStatus(
              `Failed to open bucket "${bucket}": ${friendlyError(err)}`,
            );
            logActivity(
              `Failed to open bucket "${bucket}": ${friendlyError(err)}`,
              "error",
            );
          });
      } else if (action === "copy-bucket-name") {
        void navigator.clipboard
          .writeText(bucket)
          .then(() => setStatus(`Copied bucket name "${bucket}".`, 3000))
          .catch((err) => setStatus(`Failed to copy bucket name: ${err}`));
      } else if (action === "copy-bucket-arn") {
        const arn = `arn:aws:s3:::${bucket}`;
        void navigator.clipboard
          .writeText(arn)
          .then(() => setStatus(`Copied bucket ARN.`, 3000))
          .catch((err) => setStatus(`Failed to copy ARN: ${err}`));
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
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
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
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
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
          if (action === "new-folder") void handleCreateFolder();
          else if (action === "upload-files") void handleUploadButton();
          else if (action === "upload-folder") void handleUploadFolderButton();
          else if (action === "refresh") void handleRefresh();
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

  const folderKeys = Array.from(state.selectedKeys).filter((k) =>
    k.startsWith("prefix:"),
  );
  const hasFolders = folderKeys.length > 0;
  const items: MenuItem[] = [];

  if (isFolder && selectedCount === 1) {
    items.push({ label: "Open", action: "open-folder" });
    items.push({ label: "Copy Path", action: "copy-key" });
    items.push({ label: "Copy ARN", action: "copy-arn" });
    items.push({ label: "Rename", action: "rename" });
    items.push({ label: "Copy / Move to...", action: "copy-move" });
    items.push({ separator: true });
    items.push({ label: "Delete Folder", action: "delete" });
  } else if (hasFiles) {
    if (selectedCount === 1 && !hasFolders) {
      const fileName = basename(fileKeys[0]);
      if (canPreview(fileName)) {
        items.push({ label: "Preview", action: "preview" });
      }
      items.push({ label: "Properties", action: "info" });
      items.push({ label: "Download", action: "download" });
      items.push({ label: "Copy URL", action: "copy-url" });
      items.push({
        label: "Copy Pre-Signed URL",
        action: "copy-presigned-url",
      });
      items.push({ label: "Copy Key", action: "copy-key" });
      items.push({ label: "Copy ARN", action: "copy-arn" });
      items.push({ label: "Rename", action: "rename" });
      items.push({ label: "Copy / Move to...", action: "copy-move" });
    } else {
      items.push({
        label: `Properties (${fileKeys.length} items)`,
        action: "info",
      });
      items.push({
        label: `Download ${fileKeys.length} items`,
        action: "download",
      });
      items.push({ label: "Copy Keys", action: "copy-key" });
      items.push({ label: "Copy URLs", action: "copy-url" });
      items.push({ label: "Copy ARNs", action: "copy-arn" });
      items.push({ label: "Copy / Move to...", action: "copy-move" });
    }
    items.push({ separator: true });
    const deleteLabel = hasFolders
      ? `Delete ${fileKeys.length} file${fileKeys.length === 1 ? "" : "s"} + ${folderKeys.length} folder${folderKeys.length === 1 ? "" : "s"}`
      : selectedCount === 1
        ? "Delete"
        : `Delete ${fileKeys.length} items`;
    items.push({ label: deleteLabel, action: "delete" });
  }

  if (items.length === 0) return;

  showContextMenu(e.clientX, e.clientY, items, (action) => {
    if (action === "preview") void openPreview(fileKeys[0]);
    else if (action === "info") void openInfoPanel(fileKeys);
    else if (action === "download") void handleDownload();
    else if (action === "copy-url") void handleCopyUrl();
    else if (action === "copy-presigned-url") void handleCopyPresignedUrl();
    else if (action === "copy-key") void handleCopyKey();
    else if (action === "copy-arn") void handleCopyArn();
    else if (action === "rename") void handleRename();
    else if (action === "copy-move") openCopyMoveDialog();
    else if (action === "delete") void handleDelete();
    else if (action === "open-folder") void navigateToFolder(prefix);
  });
}

function wireEvents(): void {
  dom.connectBtn.addEventListener("click", handleConnect);
  dom.disconnectBtn.addEventListener("click", handleDisconnect);

  const secretToggle = document.getElementById(
    "secret-key-toggle",
  ) as HTMLButtonElement | null;
  const secretInput = document.getElementById(
    "conn-secret-key",
  ) as HTMLInputElement | null;
  if (secretToggle && secretInput) {
    secretToggle.addEventListener("click", () => {
      const showing = secretInput.type === "text";
      secretInput.type = showing ? "password" : "text";
      secretToggle.textContent = showing ? "Show" : "Hide";
      secretToggle.setAttribute("aria-pressed", String(!showing));
      secretToggle.setAttribute(
        "aria-label",
        showing ? "Show secret key" : "Hide secret key",
      );
    });
  }

  const providerPreset = document.getElementById(
    "conn-provider-preset",
  ) as HTMLSelectElement | null;
  if (providerPreset) {
    providerPreset.addEventListener("change", () => {
      const endpointInput = document.getElementById(
        "conn-endpoint",
      ) as HTMLInputElement | null;
      const regionInput = document.getElementById(
        "conn-region",
      ) as HTMLInputElement | null;
      const preset = providerPreset.value;
      if (preset === "aws") {
        if (endpointInput) endpointInput.value = "";
        if (regionInput) regionInput.value = "us-east-1";
      } else if (preset === "do") {
        if (endpointInput)
          endpointInput.value = "https://nyc3.digitaloceanspaces.com";
        if (regionInput) regionInput.value = "nyc3";
      } else if (preset === "backblaze") {
        if (endpointInput)
          endpointInput.value = "https://s3.us-west-004.backblazeb2.com";
        if (regionInput) regionInput.value = "us-west-004";
      } else if (preset === "cloudflare") {
        if (endpointInput)
          endpointInput.value = "https://<account-id>.r2.cloudflarestorage.com";
        if (regionInput) regionInput.value = "auto";
      } else if (preset === "minio") {
        if (endpointInput) endpointInput.value = "http://localhost:9000";
        if (regionInput) regionInput.value = "us-east-1";
      } else if (preset === "wasabi") {
        if (endpointInput) endpointInput.value = "https://s3.wasabisys.com";
        if (regionInput) regionInput.value = "us-east-1";
      }
      providerPreset.value = "";
    });
  }

  document
    .getElementById("bookmark-save-btn")!
    .addEventListener("click", handleBookmarkSave);

  (
    document.getElementById("conn-endpoint") as HTMLInputElement
  ).addEventListener("input", updateBookmarkBtn);

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
      void closeSettingsModal(false);
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
        void closeSettingsModal(false);
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

  initDrawer();
  document
    .getElementById("transfer-toggle")!
    .addEventListener("click", toggleTransferQueue);
  document.getElementById("drawer-export")?.addEventListener("click", () => {
    if (getActiveTab() === "activity") {
      void handleExportActivityLog();
    }
  });
  document.getElementById("drawer-clear")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab === "activity") {
      clearActivityLog();
    } else {
      clearCompletedTransfers();
    }
  });
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

  document.getElementById("batch-properties")!.addEventListener("click", () => {
    const keys = getSelectedFileKeys();
    if (keys.length > 1) {
      void openInfoPanel(keys);
    }
  });
  document.getElementById("batch-download")!.addEventListener("click", () => {
    void handleDownload();
  });
  document.getElementById("batch-delete")!.addEventListener("click", () => {
    void handleDelete();
  });
  document.getElementById("batch-copy-urls")!.addEventListener("click", () => {
    void handleCopyUrl();
  });
  document.getElementById("batch-deselect")!.addEventListener("click", () => {
    clearSelection();
  });

  document.getElementById("security-toggle")!.addEventListener("click", () => {
    void (async () => {
      await handleSecurityToggle(setStatus);
      try {
        await loadBookmarks();
        refreshBookmarkBar();
      } catch {
        /* bookmarks unavailable */
      }
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
      } catch {
        /* connection unavailable */
      }
    })();
  });
  document
    .getElementById("security-change-password")!
    .addEventListener("click", () => {
      void handleSecurityChangePassword(setStatus);
    });
  document
    .getElementById("security-lock-btn")!
    .addEventListener("click", () => {
      void (async () => {
        const locked = await handleLockNow(setStatus);
        if (locked) {
          if (state.connected) await handleDisconnect();
          setConnectionInputs("", "", "", "");
          clearBookmarks();
          refreshBookmarkBar();
          await closeSettingsModal(false);
        }
      })();
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
    .getElementById("nav-back")
    ?.addEventListener("click", () => void navigateBack());
  document
    .getElementById("nav-forward")
    ?.addEventListener("click", () => void navigateForward());

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

  const bucketFilterInput = document.getElementById(
    "bucket-filter-input",
  ) as HTMLInputElement | null;
  if (bucketFilterInput) {
    bucketFilterInput.value = state.bucketFilterText;
    bucketFilterInput.addEventListener("input", () => {
      state.bucketFilterText = bucketFilterInput.value;
      renderBucketList();
    });
  }

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
      if (prefix !== undefined) void navigateToFolder(prefix);
      return;
    }

    const key =
      row.dataset.key ??
      (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
    if (key) handleRowClick(key, e);
  });

  dom.objectTbody.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(
      ".row-check",
    );
    if (!input) return;
    const row = input.closest<HTMLElement>(".object-row");
    if (!row) return;
    const key =
      row.dataset.key ??
      (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
    if (!key) return;
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
      const key =
        row.dataset.key ??
        (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
      if (!key) return;
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
    if (prefix !== undefined) void navigateToFolder(prefix);
  });

  const objectPanel = dom.objectPanel;
  const dropOverlay = document.getElementById(
    "drop-zone-overlay",
  ) as HTMLDivElement;
  const dropPath = document.getElementById(
    "drop-zone-path",
  ) as HTMLParagraphElement;

  const suppressDrag = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  objectPanel.addEventListener("dragover", suppressDrag);
  dropOverlay.addEventListener("dragover", suppressDrag);
  objectPanel.addEventListener("drop", suppressDrag);
  dropOverlay.addEventListener("drop", suppressDrag);

  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "enter") {
      if (state.connected && state.currentBucket) {
        dropPath.textContent = `to /${state.currentBucket}/${state.currentPrefix}`;
        dropOverlay.hidden = false;
      }
      objectPanel.classList.add("object-panel--dragover");
    } else if (event.payload.type === "leave") {
      objectPanel.classList.remove("object-panel--dragover");
      dropOverlay.hidden = true;
    } else if (event.payload.type === "drop") {
      objectPanel.classList.remove("object-panel--dragover");
      dropOverlay.hidden = true;

      if (!state.connected || !state.currentBucket) {
        setStatus("Connect to a bucket first.");
        return;
      }

      const paths = event.payload.paths;
      if (paths.length > 0) {
        void queueDroppedPaths(paths, state.currentPrefix);
      } else {
        setStatus("No dropped files detected. Try Upload Files instead.", 5000);
      }
    }
  });

  setTransferCompleteHandler(async (summary) => {
    if (summary.hadUpload && state.connected && state.currentBucket) {
      await refreshObjects(state.currentBucket, state.currentPrefix);
      pruneStaleSelection();
      renderObjectTable();
    }
  });

  wireLayoutControls();

  initPalette();
  const isMac = state.platformName === "macos";
  const accelLabel = isMac ? "⌘" : "Ctrl+";
  registerCommands([
    {
      id: "upload-files",
      label: "Upload Files",
      icon: "1f4e4",
      shortcut: `${accelLabel}U`,
      action: () => void handleUploadButton(),
      available: () => state.connected,
    },
    {
      id: "upload-folder",
      label: "Upload Folder",
      icon: "1f4c1",
      shortcut: `${accelLabel}⇧U`,
      action: () => void handleUploadFolderButton(),
      available: () => state.connected,
    },
    {
      id: "create-folder",
      label: "Create Folder",
      icon: "1f4c2",
      shortcut: `${accelLabel}N`,
      action: () => void handleCreateFolder(),
      available: () => state.connected,
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: "1f504",
      shortcut: "F5",
      action: () => void handleRefresh(),
      available: () => state.connected,
    },
    {
      id: "download",
      label: "Download Selected",
      icon: "1f4e5",
      action: () => void handleDownload(),
      available: () => state.connected && getSelectedFileKeys().length > 0,
    },
    {
      id: "delete",
      label: "Delete Selected",
      icon: "1f5d1",
      action: () => void handleDelete(),
      available: () => state.connected && getSelectedFileKeys().length > 0,
    },
    {
      id: "select-all",
      label: "Select All",
      icon: "2705",
      shortcut: `${accelLabel}A`,
      action: () => {
        const keys = getSelectableKeys();
        keys.forEach((k) => state.selectedKeys.add(k));
        updateSelectionUI();
      },
      available: () => state.connected,
    },
    {
      id: "deselect-all",
      label: "Deselect All",
      icon: "274c",
      action: () => clearSelection(),
      available: () => state.selectedKeys.size > 0,
    },
    {
      id: "filter",
      label: "Filter Objects",
      icon: "1f50d",
      shortcut: `${accelLabel}F`,
      action: () => {
        const f = document.getElementById(
          "filter-input",
        ) as HTMLInputElement | null;
        if (f) f.focus();
      },
      available: () => state.connected,
    },
    {
      id: "go-to-key-prefix",
      label: "Go to Key/Prefix",
      icon: "1f9ed",
      action: () => void handleGoToKeyOrPrefix(),
      available: () => state.connected,
    },
    {
      id: "open-last-download-folder",
      label: "Open Last Download Folder",
      icon: "1f4c2",
      action: () => void handleOpenLastDownloadFolder(),
      available: () =>
        state.currentSettings.rememberDownloadPath &&
        getRememberedDownloadDir().length > 0,
    },
    {
      id: "export-activity-log",
      label: "Export Activity Log",
      icon: "1f4be",
      action: () => void handleExportActivityLog(),
    },
    {
      id: "activity",
      label: "Toggle Activity Log",
      icon: "1f4cb",
      action: () => toggleActivityLog(),
    },
    {
      id: "settings",
      label: "Open Settings",
      icon: "2699",
      action: () => {
        document.getElementById("settings-btn")?.click();
      },
    },
    {
      id: "go-up",
      label: "Go Up (Parent Folder)",
      icon: "2b06",
      action: () => {
        void navigateUp();
      },
      available: () => state.connected && state.currentPrefix.length > 0,
    },
  ]);

  if (!modalLayerObserver) {
    modalLayerObserver = new MutationObserver(() => {
      syncModalLayerState();
    });
    document
      .querySelectorAll<HTMLElement>(
        ".modal-overlay, .dialog-overlay, .support-overlay",
      )
      .forEach((overlay) => {
        modalLayerObserver!.observe(overlay, {
          attributes: true,
          attributeFilter: ["class", "hidden"],
        });
      });
    document.addEventListener("keydown", trapFocusInModalLayer, true);
  }
  syncModalLayerState();

  wireKeyboardShortcuts({
    setSidebarOpen,
    handleDelete,
    handleRefresh,
    handleRename,
    handleUploadButton,
    handleUploadFolderButton,
    handleCreateFolder,
  });

  setBookmarkSelectHandler((bookmark) => {
    void switchToBookmark(
      bookmark.name,
      bookmark.endpoint,
      bookmark.region,
      bookmark.access_key,
      bookmark.secret_key,
    );
  });
}

async function checkSupportPrompt(): Promise<void> {
  try {
    if (isSupportPromptDismissed()) return;
    const count = await incrementLaunchCount();
    if (count < 2) return;

    setTimeout(() => {
      if (isDialogActive() || getActiveModalOverlay() || isPaletteOpen())
        return;
      const overlay = document.getElementById("support-overlay");
      const dismissButton = document.getElementById(
        "support-no",
      ) as HTMLButtonElement | null;
      const confirmButton = document.getElementById(
        "support-yes",
      ) as HTMLButtonElement | null;
      if (!overlay || !dismissButton || !confirmButton) return;

      const persistDismissal = () => {
        void markSupportPromptDismissed().catch((err) => {
          console.warn("Failed to persist support prompt dismissal:", err);
          logActivity("Failed to save support prompt preference.", "warning");
        });
      };

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        overlay.setAttribute("hidden", "");
        document.removeEventListener("keydown", onEsc, true);
        overlay.removeEventListener("click", onOverlayClick);
        dismissButton.removeEventListener("click", onDismiss);
        confirmButton.removeEventListener("click", onConfirm);
      };

      const onDismiss = () => {
        close();
        persistDismissal();
      };

      const onConfirm = () => {
        close();
        persistDismissal();
        void invoke("open_external_url", { url: "https://rosie.run/support" });
      };

      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay) {
          onDismiss();
        }
      };

      const onEsc = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      };

      overlay.removeAttribute("hidden");
      dismissButton.focus();
      dismissButton.addEventListener("click", onDismiss);
      confirmButton.addEventListener("click", onConfirm);
      overlay.addEventListener("click", onOverlayClick);
      document.addEventListener("keydown", onEsc, true);
    }, 1500);
  } catch (err) {
    console.warn("Support prompt unavailable:", err);
    logActivity("Support prompt unavailable this launch.", "warning");
  }
}

async function init(): Promise<void> {
  wireEvents();

  state.platformName = await invoke<string>("get_platform_info");
  applyPlatformClass();

  let settingsValid = true;
  try {
    settingsValid = await loadSettings();
  } catch (err) {
    setStatus(`Failed to load settings: ${String(err)}`);
  }

  if (!settingsValid) {
    await showAlert(
      "Settings Corrupted",
      "The settings file could not be read (it may be from an incompatible version). Settings will be reset to defaults. Your bookmarks and saved connections are unaffected.",
    );
    try {
      await invoke("save_settings", { json: "{}" });
    } catch {
      /* best effort */
    }
    try {
      await relaunch();
    } catch {
      window.location.assign(window.location.href);
    }
    return;
  }

  if (shouldShowSetupWizard()) {
    const result = await showSetupWizard();
    if (result) {
      state.currentSettings.theme = result.theme;
      state.currentSettings.autoCheckUpdates = result.autoCheckUpdates;
      state.currentSettings.updateChannel = result.updateChannel;
      await markSetupComplete();
    }

    try {
      await loadSettings();
    } catch (err) {
      setStatus(`Failed to load settings: ${String(err)}`);
      logActivity(`Failed to load settings: ${String(err)}`, "error");
    }

    const wizardSecurityReady = await ensureSecurityReady();
    if (!wizardSecurityReady) {
      setStatus(
        "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
      );
      logActivity(
        "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
        "warning",
      );
    }

    updateShortcutChips();
    const version = await getVersion();
    dom.versionLabel.textContent = `v${version}`;

    if (wizardSecurityReady) {
      try {
        await loadBookmarks();
        setBookmarkChangeHandler(refreshBookmarkBar);
        refreshBookmarkBar();
      } catch (err) {
        console.warn("Failed to load bookmarks:", err);
        logActivity("Failed to load bookmarks.", "warning");
      }
    }

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
    } catch {
      // no saved connection on first launch
    }

    await initUpdater();
    void autoCheckUpdates();
    return;
  }

  const securityReady = await ensureSecurityReady();
  if (!securityReady) {
    setStatus(
      "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
    );
    logActivity(
      "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
      "warning",
    );
  }

  void checkSupportPrompt();

  updateShortcutChips();
  const version = await getVersion();
  dom.versionLabel.textContent = `v${version}`;

  if (securityReady) {
    try {
      await loadBookmarks();
      setBookmarkChangeHandler(refreshBookmarkBar);
      refreshBookmarkBar();
    } catch (err) {
      console.warn("Failed to load bookmarks:", err);
      logActivity("Failed to load bookmarks.", "warning");
    }

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
  void autoCheckUpdates();
}

init().catch((err) => {
  console.error("Init error:", err);
  const el = document.getElementById("status");
  if (el) el.textContent = `Initialization error: ${String(err)}`;
});
