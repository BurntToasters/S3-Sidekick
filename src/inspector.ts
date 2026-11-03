import {
  basename,
  escapeHtml,
  formatSize,
  friendlyError,
  plural,
} from "./utils.ts";
import { getIconHtml } from "./icons.ts";
import { iconForFileName, type FileIconName } from "./icon-map.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";
import {
  closeSidebarOnMobile,
  handleTabListArrowKey,
  registerMobileSidebarOpenHandler,
  syncPanelWidths,
} from "./app-layout.ts";
import { getSelectionEntries, type SelectionEntry } from "./app-selection.ts";
import { installInspectorHost } from "./inspector-host.ts";
import { restoreTableSelectionFromInspector } from "./layout-render-bridge.ts";
import { canPreview, closePreview, openPreview } from "./preview.ts";
import {
  closeInfoPanel,
  confirmDiscardInfoProperties,
  getInfoPanelEntries,
  hasUnsavedInfoChanges,
  INFO_PANEL_CLOSED_EVENT,
  infoPanelShowsEntries,
  openInfoPanel,
  requestCloseInfoPanel,
  saveInfoPanel,
  showInfoPanelTab,
} from "./info-panel.ts";
import { state } from "./state.ts";
import { setStatus } from "./app-status.ts";

export type InspectorInfoTab = "details" | "permissions" | "metadata";
export type InspectorPaneTab = "preview" | InspectorInfoTab;

type InspectorSyncReason = "selection" | "tab";

/** The container width from which the inspector defaults to open. */
const INSPECTOR_DEFAULT_OPEN_CONTAINER = 1280;

/** Surface a rejected inspector action instead of leaving a floating promise. */
function reportInspectorFailure(label: string, err: unknown): void {
  const message = `${label} failed: ${friendlyError(err)}`;
  console.error(message, err);
  setStatus(message);
}

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
 * Signature of the last selection whose render finished. The open path syncs
 * immediately and the browser's next selection tick carries the same entries;
 * this lets the second sync be skipped without skipping empty selections.
 */
let lastCompletedSelectionSignature: string | null = null;
// Closing the Properties pane removes the content that signature described.
// Invalidate it so an explicit Cancel/reopen resync renders instead of being
// mistaken for the browser's duplicate follow-up tick.
document.addEventListener(INFO_PANEL_CLOSED_EVENT, () => {
  lastCompletedSelectionSignature = null;
});
/**
 * True while the open state came from the wide-container default rather than
 * a stored or explicit choice, so a later shrink can undo it.
 */
let inspectorOpenByDefault = false;

const INFO_PANE_IDS: Record<InspectorInfoTab, string> = {
  details: "inspector-pane-info",
  permissions: "inspector-pane-permissions",
  metadata: "inspector-pane-metadata",
};

const INSPECTOR_OPEN_STORAGE_KEY = "s3-sidekick.inspector.open";
/** The stored open preference, or null when unset or storage is unavailable. */
function readInspectorOpenPreference(): string | null {
  try {
    return window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode); fall back to the default rule.
    return null;
  }
}

function writeInspectorOpenPreference(open: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Storage unavailable (private mode); the choice lasts for this session.
  }
}

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
  const stored = readInspectorOpenPreference();
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
    void syncInspectorFromSelection(undefined, { reason: "tab" }).catch((err) =>
      reportInspectorFailure("Inspector sync", err),
    );
    return;
  }
  inspectorTab = tab;
  syncInspectorPaneVisibility();
  void syncInspectorFromSelection(undefined, { reason: "tab" }).catch((err) =>
    reportInspectorFailure("Inspector sync", err),
  );
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

function getInfoPane(tab: InspectorInfoTab): HTMLElement | null {
  return document.getElementById(INFO_PANE_IDS[tab]);
}

/**
 * Details, Permissions and Metadata own separate tabpanels, but the title,
 * body and footer are one set of nodes. Move them (never clone) into the panel
 * of the active tab so ids stay unique and unsaved edits survive a tab flip.
 */
function moveSharedInfoContent(target: HTMLElement): void {
  const footer = document.querySelector<HTMLElement>(
    "#inspector-pane-info .inspector-panel__footer, " +
      "#inspector-pane-permissions .inspector-panel__footer, " +
      "#inspector-pane-metadata .inspector-panel__footer",
  );
  const shared = [
    document.getElementById("inspector-info-title"),
    document.getElementById("inspector-info-body"),
    footer,
  ];
  if (shared.every((node) => node === null || node.parentElement === target)) {
    return;
  }
  // Append in display order; appendChild moves each node, it does not copy it.
  for (const node of shared) {
    if (node) target.appendChild(node);
  }
}

function syncInspectorPaneVisibility(): void {
  const previewPane = document.getElementById("inspector-pane-preview");
  const infoPane = document.getElementById("inspector-pane-info");
  const empty = document.getElementById("inspector-empty");
  if (!previewPane || !infoPane || !empty) return;

  const infoPanes = Object.values(INFO_PANE_IDS)
    .map((id) => document.getElementById(id))
    .filter((pane): pane is HTMLElement => pane !== null);
  const hasSplitInfoPanes = infoPanes.length > 1;
  const activeInfoPane =
    inspectorTab === "preview" ? null : (getInfoPane(inspectorTab) ?? infoPane);

  if (hasSplitInfoPanes) {
    for (const [tab, id] of Object.entries(INFO_PANE_IDS)) {
      document
        .getElementById(id)
        ?.setAttribute("aria-labelledby", `inspector-tab-${tab}`);
    }
  } else if (inspectorTab !== "preview") {
    // Unit fixtures define only #inspector-pane-info; keep the single panel
    // naming whichever top-level tab owns it.
    infoPane.setAttribute("aria-labelledby", `inspector-tab-${inspectorTab}`);
  }

  if (!inspectorOpen) {
    empty.hidden = true;
    previewPane.hidden = true;
    for (const pane of infoPanes) pane.hidden = true;
    if (activeInfoPane) moveSharedInfoContent(activeInfoPane);
    return;
  }

  if (inspectorEmptyActive) {
    empty.hidden = false;
    previewPane.hidden = true;
  } else {
    const onPreview = inspectorTab === "preview";
    empty.hidden = true;
    previewPane.hidden = !onPreview;
  }
  for (const pane of infoPanes) {
    pane.hidden =
      inspectorEmptyActive ||
      inspectorTab === "preview" ||
      pane !== activeInfoPane;
  }
  if (activeInfoPane) moveSharedInfoContent(activeInfoPane);

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
    lastCompletedSelectionSignature = null;
    releaseMobileInspectorModal(true);
  }
  inspectorOpen = open;
  if (!open) inspectorOpenByDefault = false;
  if (!mobile && options?.persist !== false) {
    writeInspectorOpenPreference(open);
  }
  if (open && mobile) {
    // Only one off-canvas panel may own the screen.
    closeSidebarOnMobile();
    if (isDrawerOpen()) closeDrawer();
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
      void syncInspectorFromSelection().catch((err) =>
        reportInspectorFailure("Inspector sync", err),
      );
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
    void requestCloseInspector().catch((err) =>
      reportInspectorFailure("Close inspector", err),
    );
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

function typeIconHtml(name: string, kind: "file" | "folder"): string {
  const iconName: FileIconName | "folder" =
    kind === "folder" ? "folder" : iconForFileName(name);
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

/**
 * Identity of a selection for duplicate-sync suppression. Connection, bucket
 * and prefix make a reconnect or navigation sync; key/size/modified make an
 * in-place listing refresh sync even when the same keys stay selected.
 */
function selectionSyncSignature(entries: readonly SelectionEntry[]): string {
  // One pass over the listing, not one scan per selected key.
  const objectsByKey = new Map<string, (typeof state.objects)[number]>();
  for (const object of state.objects) {
    if (!object.is_folder) objectsByKey.set(object.key, object);
  }
  const revisions = entries
    .map((entry) => {
      if (entry.kind === "folder") {
        return JSON.stringify(["folder", entry.key]);
      }
      const object = objectsByKey.get(entry.key);
      return JSON.stringify([
        "file",
        entry.key,
        object?.size ?? null,
        object?.last_modified ?? null,
      ]);
    })
    .sort();
  return JSON.stringify([
    state.connectionIdentity,
    state.connectionId,
    state.currentBucket,
    state.currentPrefix,
    revisions,
  ]);
}

/**
 * Record a selection whose render finished. `paneOpenCalls` accounts for the
 * generation bump ensureInspectorOpenForPane() makes while a preview or info
 * pane opens; any further bump means a newer sync superseded this one, so its
 * signature must not overwrite the newer cache entry.
 */
function commitCompletedSelection(
  signature: string,
  syncGen: number,
  paneOpenCalls: number,
): void {
  if (inspectorSyncGeneration !== syncGen + paneOpenCalls) return;
  lastCompletedSelectionSignature = signature;
}

export async function syncInspectorFromSelection(
  selectedEntries?: readonly SelectionEntry[],
  options?: { reason?: InspectorSyncReason },
): Promise<void> {
  if (!inspectorOpen) return;

  const reason: InspectorSyncReason = options?.reason ?? "selection";
  const entries = selectedEntries ?? getSelectionEntries();
  const signature = selectionSyncSignature(entries);

  // Opening the inspector syncs immediately and the browser's following
  // selection tick repeats it. Skip only that duplicate; an empty selection
  // must always sync so Deselect All can show the empty inspector.
  if (
    reason === "selection" &&
    entries.length > 0 &&
    signature === lastCompletedSelectionSignature
  ) {
    return;
  }

  const syncGen = ++inspectorSyncGeneration;

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
    commitCompletedSelection(signature, syncGen, 0);
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
        commitCompletedSelection(signature, syncGen, 1);
        return;
      }
      focusInspectorInfoPane(pane);
      if (syncGen !== inspectorSyncGeneration) return;
      await openInfoPanel(entries, pane);
      commitCompletedSelection(signature, syncGen, 1);
      return;
    }

    // Explicit tab click: respect the chosen tab.
    if (inspectorTab === "preview") {
      if (singlePreviewable) {
        await openPreview(fileKeys[0]);
        commitCompletedSelection(signature, syncGen, 1);
        return;
      }
      showPreviewUnavailable(previewUnavailableMessage(fileKeys));
      commitCompletedSelection(signature, syncGen, 0);
      return;
    }

    if (syncGen !== inspectorSyncGeneration) return;
    if (!infoPanelShowsEntries(entries)) {
      await openInfoPanel(entries, inspectorTab);
      commitCompletedSelection(signature, syncGen, 1);
      return;
    }
    showInfoPanelTab(inspectorTab);
    commitCompletedSelection(signature, syncGen, 0);
  } catch (err) {
    if (syncGen !== inspectorSyncGeneration) return;
    // A failed render is not a completed selection: retry on the next tick.
    lastCompletedSelectionSignature = null;
    console.error("Inspector sync failed:", err);
    // Never leave the failed object's name over the failure summary.
    setInspectorHeaderTitle("Inspector");
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
  registerMobileSidebarOpenHandler(closeInspectorOnMobile);

  document.getElementById("btn-inspector")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleInspector();
  });
  document.getElementById("inspector-close")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void requestCloseInspector().catch((err) =>
      reportInspectorFailure("Close inspector", err),
    );
  });
  document
    .getElementById("inspector-backdrop")
    ?.addEventListener("click", () => {
      void requestCloseInspector().catch((err) =>
        reportInspectorFailure("Close inspector", err),
      );
    });

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
      void saveInfoPanel().catch((err) =>
        reportInspectorFailure("Save properties", err),
      );
    });
  document
    .getElementById("inspector-info-cancel")
    ?.addEventListener("click", () => {
      void (async () => {
        if (await requestCloseInfoPanel()) {
          await syncInspectorFromSelection();
        }
      })().catch((err) => reportInspectorFailure("Close properties", err));
    });

  window.addEventListener("resize", () => {
    const mobile = isMobileInspectorMode();
    const layout = document.getElementById("main-layout");
    if (!layout || !inspectorOpen) return;
    // Narrowing past the breakpoint with a docked inspector closes it. Turning
    // it into a modal here would make the listing inert mid-resize. Unsaved
    // edits are still confirmed first.
    if (mobile && layout.classList.contains("main-layout--inspector-docked")) {
      void requestCloseInspector().catch((err) =>
        reportInspectorFailure("Close inspector", err),
      );
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
      closeSidebarOnMobile();
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
  try {
    const observer = new ResizeObserver(() => {
      if (inspectorOpen) return;
      if (isMobileInspectorMode()) return;
      if (readInspectorOpenPreference() !== null) return;
      if (contentContainerWidth() >= INSPECTOR_DEFAULT_OPEN_CONTAINER) {
        inspectorOpenByDefault = true;
        setInspectorOpen(true, { persist: false });
      }
    });
    observer.observe(container);
  } catch {
    // Observing is an enhancement; its failure must not abort startup.
  }
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
