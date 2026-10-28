import { basename, escapeHtml, formatSize, plural } from "./utils.ts";
import { getIconHtml } from "./icons.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";
import { handleTabListArrowKey, syncPanelWidths } from "./app-layout.ts";
import { getSelectionEntries, type SelectionEntry } from "./app-selection.ts";
import { installInspectorHost } from "./inspector-host.ts";
import { restoreTableSelectionFromInspector } from "./layout-render-bridge.ts";
import { canPreview, closePreview, openPreview } from "./preview.ts";
import {
  closeInfoPanel,
  confirmDiscardInfoProperties,
  getInfoPanelEntries,
  hasUnsavedInfoChanges,
  infoPanelShowsEntries,
  openInfoPanel,
  requestCloseInfoPanel,
  saveInfoPanel,
  showInfoPanelTab,
} from "./info-panel.ts";
import { state } from "./state.ts";

export type InspectorInfoTab = "details" | "permissions" | "metadata";
export type InspectorPaneTab = "preview" | InspectorInfoTab;

type InspectorSyncReason = "selection" | "tab";

/** The container width from which the inspector defaults to open. */
const INSPECTOR_DEFAULT_OPEN_CONTAINER = 1280;

let inspectorOpen = false;
let inspectorTab: InspectorPaneTab = "preview";
/**
 * The pane the user picked by clicking a tab. Selection changes keep it when
 * it applies to the new selection and fall back to Preview/Details only when
 * it does not. Null until the user has chosen a tab.
 */
let preferredPaneTab: InspectorPaneTab | null = null;
let inspectorEmptyActive = true;
let inspectorSyncGeneration = 0;
/**
 * True while the open state came from the wide-container default rather than
 * a stored or explicit choice, so a later shrink can undo it.
 */
let inspectorOpenByDefault = false;

const INSPECTOR_OPEN_STORAGE_KEY = "s3-sidekick.inspector.open";
const INSPECTOR_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let mobileInspectorModalActive = false;
let focusBeforeMobileInspector: HTMLElement | null = null;
const mobileInspectorBackgroundState = new Map<
  HTMLElement,
  { inert: boolean; ariaHidden: string | null }
>();

function setElementInert(element: HTMLElement, inert: boolean): void {
  (element as HTMLElement & { inert: boolean }).inert = inert;
}

function getMobileInspectorBackgroundTargets(
  panel: HTMLElement,
  backdrop: HTMLElement | null,
): HTMLElement[] {
  const targets: HTMLElement[] = [];
  const appRoot = document.getElementById("app");
  let branch: HTMLElement = panel;
  while (branch.parentElement && branch !== appRoot) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (
        sibling instanceof HTMLElement &&
        sibling !== branch &&
        sibling !== backdrop
      ) {
        targets.push(sibling);
      }
    }
    branch = parent;
  }
  return targets;
}

function getMobileInspectorFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(INSPECTOR_FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.closest("[hidden]") &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("disabled"),
  );
}

function hasOverlayAboveInspector(): boolean {
  return (
    document.querySelector(
      ".modal-overlay.active, .dialog-overlay.active, .support-overlay:not([hidden]), .setup-wizard-overlay:not([hidden]), #palette-overlay:not([hidden])",
    ) !== null
  );
}

function trapMobileInspectorFocus(event: KeyboardEvent): void {
  if (
    !mobileInspectorModalActive ||
    event.key !== "Tab" ||
    hasOverlayAboveInspector()
  ) {
    return;
  }
  const panel = document.getElementById("inspector-panel");
  if (!panel) return;
  const focusable = getMobileInspectorFocusable(panel);
  if (focusable.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (event.shiftKey) {
    if (!active || active === first || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (!active || active === last || !panel.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

function acquireMobileInspectorModal(): void {
  if (mobileInspectorModalActive) return;
  const panel = document.getElementById("inspector-panel");
  if (!panel) return;
  const backdrop = document.getElementById("inspector-backdrop");
  const active = document.activeElement;
  focusBeforeMobileInspector =
    active instanceof HTMLElement && !panel.contains(active) ? active : null;

  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "inspector-header-title");
  panel.removeAttribute("aria-label");
  if (panel.tabIndex < 0) panel.tabIndex = -1;

  for (const target of getMobileInspectorBackgroundTargets(panel, backdrop)) {
    if (mobileInspectorBackgroundState.has(target)) continue;
    mobileInspectorBackgroundState.set(target, {
      inert: Boolean((target as HTMLElement & { inert?: boolean }).inert),
      ariaHidden: target.getAttribute("aria-hidden"),
    });
    setElementInert(target, true);
    target.setAttribute("aria-hidden", "true");
  }

  mobileInspectorModalActive = true;
  document.addEventListener("keydown", trapMobileInspectorFocus, true);
  const activeTab = panel.querySelector<HTMLElement>(
    '.inspector-tab[aria-selected="true"]',
  );
  const close = panel.querySelector<HTMLElement>("#inspector-close");
  (activeTab ?? close ?? panel).focus();
}

function releaseMobileInspectorModal(restoreFocus: boolean): void {
  const panel = document.getElementById("inspector-panel");
  if (panel) {
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "Inspector");
    panel.removeAttribute("aria-modal");
    panel.removeAttribute("aria-labelledby");
  }
  if (!mobileInspectorModalActive) return;
  document.removeEventListener("keydown", trapMobileInspectorFocus, true);
  for (const [target, previous] of mobileInspectorBackgroundState) {
    setElementInert(target, previous.inert);
    if (previous.ariaHidden === null) {
      target.removeAttribute("aria-hidden");
    } else {
      target.setAttribute("aria-hidden", previous.ariaHidden);
    }
  }
  mobileInspectorBackgroundState.clear();
  mobileInspectorModalActive = false;
  const restore = focusBeforeMobileInspector;
  focusBeforeMobileInspector = null;
  if (restoreFocus && restore?.isConnected) restore.focus();
}

/** Opens the docked inspector before preview/properties render (desktop slide-out or narrow overlay). */
export function ensureInspectorOpenForPane(tab: InspectorPaneTab): void {
  inspectorTab = tab;
  // Cancel in-flight selection sync so auto-preview cannot steal an explicit
  // Properties/Preview request after the inspector opens.
  inspectorSyncGeneration += 1;
  if (!inspectorOpen) {
    // Opened by a preview or properties request, not by the user, so the
    // open state is not remembered for the next launch.
    setInspectorOpen(true, { syncSelection: false, persist: false });
  } else {
    syncInspectorPaneVisibility();
  }
}

/**
 * Width of the content container, which is what the default-open rule
 * measures: the inspector only defaults to open when the listing itself has
 * room, not when the window does.
 */
function contentContainerWidth(): number {
  const container = document.querySelector<HTMLElement>(".content-main");
  return container ? container.clientWidth : 0;
}

export function restoreInspectorOpenState(): void {
  if (isMobileInspectorMode()) {
    setInspectorOpen(false);
    return;
  }
  const stored = window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
  if (stored === "1") {
    setInspectorOpen(true);
  } else if (stored === "0") {
    setInspectorOpen(false);
  } else if (contentContainerWidth() >= INSPECTOR_DEFAULT_OPEN_CONTAINER) {
    // No stored choice: default open only on a wide container, and keep the
    // choice unstored so a later shrink can undo it.
    inspectorOpenByDefault = true;
    setInspectorOpen(true, { persist: false });
  }
}

export function isInspectorOpen(): boolean {
  return inspectorOpen;
}

export function getInspectorTab(): InspectorPaneTab {
  return inspectorTab;
}

export function focusInspectorPreviewPane(): void {
  inspectorTab = "preview";
  syncInspectorPaneVisibility();
}

export function focusInspectorInfoPane(tab: InspectorInfoTab): void {
  inspectorTab = tab;
  syncInspectorPaneVisibility();
}

export function setInspectorTab(tab: InspectorPaneTab): void {
  // Only a click reaches here, so this is the user's explicit choice.
  preferredPaneTab = tab;
  if (inspectorTab === tab) {
    syncInspectorPaneVisibility();
    void syncInspectorFromSelection(undefined, { reason: "tab" });
    return;
  }
  inspectorTab = tab;
  syncInspectorPaneVisibility();
  void syncInspectorFromSelection(undefined, { reason: "tab" });
}

export function markInspectorHasContent(): void {
  inspectorEmptyActive = false;
  syncInspectorPaneVisibility();
}

function updatePreviewTabAffordance(previewAvailable: boolean): void {
  const tab = document.querySelector<HTMLButtonElement>(
    '[data-inspector-tab="preview"]',
  );
  if (!tab) return;
  // Truly inert when unavailable: not focusable, no pointer events.
  tab.disabled = !previewAvailable;
  tab.setAttribute("aria-disabled", String(!previewAvailable));
  tab.title = previewAvailable
    ? "Preview"
    : "Preview is not available for this selection";
}

function syncInspectorPaneVisibility(): void {
  const previewPane = document.getElementById("inspector-pane-preview");
  const infoPane = document.getElementById("inspector-pane-info");
  const empty = document.getElementById("inspector-empty");
  if (!previewPane || !infoPane || !empty) return;

  if (!inspectorOpen) {
    empty.hidden = true;
    previewPane.hidden = true;
    infoPane.hidden = true;
    return;
  }

  if (inspectorEmptyActive) {
    empty.hidden = false;
    previewPane.hidden = true;
    infoPane.hidden = true;
  } else {
    const onPreview = inspectorTab === "preview";
    empty.hidden = true;
    previewPane.hidden = !onPreview;
    infoPane.hidden = onPreview;
    if (!onPreview) {
      infoPane.setAttribute("aria-labelledby", `inspector-tab-${inspectorTab}`);
    }
  }

  const tabs = document.querySelectorAll<HTMLElement>("[data-inspector-tab]");
  for (const tab of tabs) {
    const active = tab.dataset.inspectorTab === inspectorTab;
    tab.classList.toggle("inspector-tab--active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
  }
}

export function setInspectorOpen(
  open: boolean,
  options?: { syncSelection?: boolean; persist?: boolean },
): void {
  const panel = document.getElementById("inspector-panel");
  const resizer = document.getElementById("inspector-resizer");
  const backdrop = document.getElementById("inspector-backdrop");
  const layout = document.getElementById("main-layout");
  const toggle = document.getElementById("btn-inspector");
  const mobile = isMobileInspectorMode();

  if (!open) {
    inspectorSyncGeneration += 1;
    releaseMobileInspectorModal(true);
  }
  inspectorOpen = open;
  if (!open) inspectorOpenByDefault = false;
  if (!mobile && options?.persist !== false) {
    window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, open ? "1" : "0");
  }
  if (open && mobile && isDrawerOpen()) {
    closeDrawer();
  }

  if (panel) panel.hidden = !open;
  if (resizer) resizer.hidden = !open || mobile;
  if (backdrop) backdrop.hidden = !open || !mobile;
  layout?.classList.toggle("main-layout--inspector-open", open && mobile);
  layout?.classList.toggle("main-layout--inspector-docked", open && !mobile);
  toggle?.classList.toggle("btn--active", open);
  toggle?.setAttribute("aria-pressed", String(open));
  toggle?.setAttribute("aria-expanded", String(open));
  document.documentElement.dataset.inspectorOpen = open ? "1" : "0";

  if (open && mobile) {
    acquireMobileInspectorModal();
  } else if (open) {
    releaseMobileInspectorModal(false);
  }

  syncInspectorPaneVisibility();
  syncPanelWidths();
  if (open) {
    if (options?.syncSelection !== false) {
      void syncInspectorFromSelection();
    }
  } else {
    inspectorEmptyActive = true;
    renderInspectorEmpty();
    closePreview();
    closeInfoPanel();
  }
}

export function toggleInspector(): void {
  if (inspectorOpen) {
    void requestCloseInspector();
  } else {
    inspectorOpenByDefault = false;
    setInspectorOpen(true);
  }
}

export async function requestCloseInspector(): Promise<boolean> {
  if (!inspectorOpen) return true;
  if (hasUnsavedInfoChanges() && !(await confirmDiscardInfoProperties())) {
    return false;
  }
  setInspectorOpen(false);
  return true;
}

export function isMobileInspectorMode(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 900px)").matches;
}

export function closeInspectorOnMobile(): void {
  if (isMobileInspectorMode()) {
    setInspectorOpen(false);
  }
}

type FileIconName =
  | "folder"
  | "file"
  | "file-text"
  | "file-image"
  | "file-code"
  | "file-archive"
  | "file-video"
  | "file-audio";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "bmp",
]);
const TEXT_DATA_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "htm",
  "log",
]);
const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "sql",
  "rb",
  "php",
  "swift",
  "kt",
  "lua",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "opus",
]);

function iconForName(name: string): FileIconName {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const dot = trimmed.lastIndexOf(".");
  const ext = dot > 0 ? trimmed.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(ext)) return "file-image";
  if (TEXT_DATA_EXTENSIONS.has(ext)) return "file-text";
  if (CODE_EXTENSIONS.has(ext)) return "file-code";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "file-archive";
  if (VIDEO_EXTENSIONS.has(ext)) return "file-video";
  if (AUDIO_EXTENSIONS.has(ext)) return "file-audio";
  return "file";
}

function typeIconHtml(name: string, kind: "file" | "folder"): string {
  const iconName: FileIconName =
    kind === "folder" ? "folder" : iconForName(name);
  const icon = getIconHtml(iconName, {
    className: "lucide-icon lucide-icon--inline",
    decorative: true,
  });
  if (!icon) return "";
  return `<span class="inspector-title-icon" aria-hidden="true">${icon}</span>`;
}

/**
 * The header names the shown object exactly once, next to its type icon.
 */
function setInspectorHeaderTitle(text: string, iconHtml = ""): void {
  const headerTitle = document.getElementById("inspector-header-title");
  if (!headerTitle) return;
  headerTitle.innerHTML = `${iconHtml}${escapeHtml(text)}`;
}

/** Header title for an object the info pane opened directly, such as Properties. */
function showInspectorTitle(label: string, entry: SelectionEntry | null): void {
  setInspectorHeaderTitle(
    label,
    entry ? typeIconHtml(entry.key, entry.kind) : "",
  );
}

/**
 * The empty state summarises the folder the listing shows: where it is, how
 * much of it is loaded, and a Copy path action. Without a connected bucket it
 * falls back to the plain hint.
 */
function renderInspectorEmpty(): void {
  const empty = document.getElementById("inspector-empty");
  if (!empty) return;
  if (!state.currentBucket) {
    empty.textContent = "Select an object to inspect.";
    return;
  }
  const prefix = state.currentPrefix;
  const fileCount = state.objects.length;
  const folderCount = state.prefixes.length;
  const loadedBytes = state.objects.reduce((sum, o) => sum + o.size, 0);
  const location = prefix
    ? `${state.currentBucket}/${prefix}`
    : `${state.currentBucket}/`;
  const stats = [
    `<div class="inspector-empty__stat"><dt>Files</dt><dd>${escapeHtml(plural(fileCount, "file"))}</dd></div>`,
    `<div class="inspector-empty__stat"><dt>Folders</dt><dd>${escapeHtml(plural(folderCount, "folder"))}</dd></div>`,
    `<div class="inspector-empty__stat"><dt>Loaded size</dt><dd>${escapeHtml(formatSize(loadedBytes))}</dd></div>`,
  ].join("");
  empty.innerHTML =
    `<div class="inspector-empty__summary">` +
    `<div class="inspector-empty__heading">Current folder</div>` +
    `<div class="inspector-empty__location" title="${escapeHtml(location)}">${escapeHtml(location)}</div>` +
    `<dl class="inspector-empty__stats">${stats}</dl>` +
    `<button type="button" class="btn btn--ghost btn--sm" data-copy-path="${escapeHtml(location)}" aria-label="Copy path">Copy path</button>` +
    `</div>`;
  empty
    .querySelector<HTMLButtonElement>("[data-copy-path]")
    ?.addEventListener("click", () => {
      void navigator.clipboard.writeText(location).then(
        () => undefined,
        () => undefined,
      );
    });
}

function previewUnavailableMessage(fileKeys: string[]): string {
  if (fileKeys.length === 1) {
    return "Preview not available for this file type.";
  }
  if (fileKeys.length === 0) {
    return "Preview is available for files only.";
  }
  return "Preview is available for a single previewable file.";
}

/**
 * Which pane a selection opens. Keeps the user's last explicit tab when it
 * applies; Preview falls back to Details when the selection is not one
 * previewable file.
 */
function paneForSelection(singlePreviewable: boolean): InspectorPaneTab {
  const wanted =
    preferredPaneTab ?? (singlePreviewable ? "preview" : "details");
  if (wanted === "preview") {
    return singlePreviewable ? "preview" : "details";
  }
  return wanted;
}

export async function syncInspectorFromSelection(
  selectedEntries?: readonly SelectionEntry[],
  options?: { reason?: InspectorSyncReason },
): Promise<void> {
  if (!inspectorOpen) return;

  const reason: InspectorSyncReason = options?.reason ?? "selection";
  const syncGen = ++inspectorSyncGeneration;
  const entries = selectedEntries ?? getSelectionEntries();

  // A selection change replaces the object that the info pane edits.
  // Unsaved edits must be confirmed first. If the user keeps editing, the
  // edited object keeps its header, preview, and details until they choose.
  if (reason === "selection" && !infoPanelShowsEntries(entries)) {
    const discard = await confirmDiscardInfoProperties();
    if (syncGen !== inspectorSyncGeneration) return;
    if (!discard) {
      // Keep editing: the table goes back to the object the pane still shows.
      restoreTableSelectionFromInspector(getInfoPanelEntries());
      return;
    }
  }

  closePreview();
  const previewBody = document.getElementById("inspector-preview-body");
  previewBody?.replaceChildren();
  previewBody?.removeAttribute("aria-busy");
  await Promise.resolve();
  if (syncGen !== inspectorSyncGeneration) return;

  if (entries.length === 0) {
    closeInfoPanel();
    setInspectorHeaderTitle("Inspector");
    renderInspectorEmpty();
    inspectorEmptyActive = true;
    syncInspectorPaneVisibility();
    document.getElementById("inspector-preview-body")?.replaceChildren();
    document.getElementById("preview-body")?.replaceChildren();
    return;
  }

  // Selection exists — never leave the global empty placeholder visible while
  // async preview/properties work loads (or fails mid-flight).
  markInspectorHasContent();

  try {
    const fileKeys = entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.key);
    if (syncGen !== inspectorSyncGeneration) return;

    const singlePreviewable =
      fileKeys.length === 1 && canPreview(basename(fileKeys[0]));
    updatePreviewTabAffordance(singlePreviewable);

    // The header names the selection only once it is committed; Keep editing
    // returned above, so the header always matches the object being shown.
    const single = entries.length === 1 ? entries[0] : null;
    setInspectorHeaderTitle(
      single ? basename(single.key) : `${entries.length} selected`,
      single ? typeIconHtml(single.key, single.kind) : "",
    );

    if (reason === "selection") {
      const pane = paneForSelection(singlePreviewable);
      if (pane === "preview") {
        focusInspectorPreviewPane();
        if (!infoPanelShowsEntries(entries)) closeInfoPanel();
        // Name the file now, before the debounce, so the title never lags the
        // header or waits on a fetch that a newer selection may supersede.
        const previewKey = fileKeys[0];
        const previewTitle = document.getElementById("inspector-preview-title");
        if (previewTitle) previewTitle.textContent = basename(previewKey);
        // Debounce: rapid keyboard/mouse selection would otherwise fetch a
        // preview body for every intermediate row. A newer sync bumps
        // `syncGen`, so the pending fetch is abandoned instead of racing.
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        if (syncGen !== inspectorSyncGeneration) return;
        await openPreview(previewKey);
        return;
      }
      focusInspectorInfoPane(pane);
      if (syncGen !== inspectorSyncGeneration) return;
      await openInfoPanel(entries, pane);
      return;
    }

    // Explicit tab click: respect the chosen tab.
    if (inspectorTab === "preview") {
      if (singlePreviewable) {
        await openPreview(fileKeys[0]);
        return;
      }
      showPreviewUnavailable(previewUnavailableMessage(fileKeys));
      return;
    }

    if (syncGen !== inspectorSyncGeneration) return;
    if (!infoPanelShowsEntries(entries)) {
      await openInfoPanel(entries, inspectorTab);
      return;
    }
    showInfoPanelTab(inspectorTab);
  } catch (err) {
    if (syncGen !== inspectorSyncGeneration) return;
    console.error("Inspector sync failed:", err);
    renderInspectorEmpty();
    inspectorEmptyActive = true;
    syncInspectorPaneVisibility();
  }
}

function showPreviewUnavailable(message: string): void {
  markInspectorHasContent();
  focusInspectorPreviewPane();
  const body = document.getElementById("inspector-preview-body");
  if (body) {
    body.innerHTML = `<p class="inspector-preview-unavailable">${escapeHtml(message)}</p>`;
  }
}

export function wireInspectorChrome(): void {
  if (document.documentElement.dataset.inspectorChromeWired === "1") return;
  document.documentElement.dataset.inspectorChromeWired = "1";

  document.getElementById("btn-inspector")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleInspector();
  });
  document.getElementById("inspector-close")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void requestCloseInspector();
  });
  document
    .getElementById("inspector-backdrop")
    ?.addEventListener("click", () => void requestCloseInspector());

  const inspectorTabs = Array.from(
    document.querySelectorAll<HTMLElement>("[data-inspector-tab]"),
  );
  inspectorTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab instanceof HTMLButtonElement && tab.disabled) return;
      const id = tab.dataset.inspectorTab as InspectorPaneTab | undefined;
      if (id) setInspectorTab(id);
    });
  });
  document
    .querySelector<HTMLElement>(".inspector-tabs")
    ?.addEventListener("keydown", (e) => {
      // Disabled tabs are skipped by roving focus, like any inert control.
      const selectable = inspectorTabs.filter(
        (tab) => !(tab instanceof HTMLButtonElement && tab.disabled),
      );
      handleTabListArrowKey(e, selectable, (tab) => {
        const id = tab.dataset.inspectorTab as InspectorPaneTab | undefined;
        if (id) setInspectorTab(id);
      });
    });

  document
    .getElementById("inspector-info-save")
    ?.addEventListener("click", () => {
      void saveInfoPanel();
    });
  document
    .getElementById("inspector-info-cancel")
    ?.addEventListener("click", () => {
      void (async () => {
        if (await requestCloseInfoPanel()) {
          void syncInspectorFromSelection();
        }
      })();
    });

  window.addEventListener("resize", () => {
    const mobile = isMobileInspectorMode();
    const layout = document.getElementById("main-layout");
    if (!layout || !inspectorOpen) return;
    // Narrowing past the breakpoint with a docked inspector closes it. Turning
    // it into a modal here would make the listing inert mid-resize. Unsaved
    // edits are still confirmed first.
    if (mobile && layout.classList.contains("main-layout--inspector-docked")) {
      void requestCloseInspector();
      return;
    }
    // A default-open inspector also gives way when the container narrows
    // under the 1280px threshold; an explicit choice is kept.
    if (
      inspectorOpenByDefault &&
      contentContainerWidth() < INSPECTOR_DEFAULT_OPEN_CONTAINER
    ) {
      setInspectorOpen(false, { persist: false });
      return;
    }
    layout.classList.toggle("main-layout--inspector-open", mobile);
    layout.classList.toggle("main-layout--inspector-docked", !mobile);
    const resizer = document.getElementById("inspector-resizer");
    const backdrop = document.getElementById("inspector-backdrop");
    if (resizer) resizer.hidden = !inspectorOpen || mobile;
    if (backdrop) backdrop.hidden = !inspectorOpen || !mobile;
    if (mobile) {
      if (isDrawerOpen()) closeDrawer();
      acquireMobileInspectorModal();
    } else {
      releaseMobileInspectorModal(false);
    }
    syncPanelWidths();
  });

  restoreInspectorOpenState();
  watchInspectorDefaultOpen();
}

/**
 * The default-open rule measures .content-main, which has no width until the
 * connected layout paints. Watch the container so a wide first paint still
 * opens the inspector when the user never made a choice.
 */
function watchInspectorDefaultOpen(): void {
  if (typeof ResizeObserver !== "function") return;
  const container = document.querySelector<HTMLElement>(".content-main");
  if (!container) return;
  const observer = new ResizeObserver(() => {
    if (inspectorOpen) return;
    if (isMobileInspectorMode()) return;
    if (window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) !== null)
      return;
    if (contentContainerWidth() >= INSPECTOR_DEFAULT_OPEN_CONTAINER) {
      inspectorOpenByDefault = true;
      setInspectorOpen(true, { persist: false });
    }
  });
  observer.observe(container);
}

installInspectorHost({
  ensureInspectorOpenForPane,
  focusInspectorPreviewPane,
  focusInspectorInfoPane,
  markInspectorHasContent,
  setInspectorTitle: showInspectorTitle,
});

// Re-export mount helpers for consumers that need them.
export {
  setInfoOverlayActive,
  clearInfoOverlayActive,
} from "./inspector-mount.ts";
