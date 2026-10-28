import { state } from "./state.ts";
import {
  hideContextMenu,
  showContextMenu,
  type MenuItem,
} from "./context-menu.ts";
import { handleCreateFolder, handleRefresh } from "./app-objects.ts";
import { handleUploadButton, handleUploadFolderButton } from "./app-upload.ts";
import {
  registerFilterRenderCanceller,
  renderObjectTableFromLayout,
} from "./layout-render-bridge.ts";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORAGE_KEY = "s3-sidekick.sidebar.width";
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 560;
const INSPECTOR_STORAGE_KEY = "s3-sidekick.inspector.width";
const DESKTOP_BREAKPOINT = 900;
const LISTING_MIN_WIDTH = 360;
const RESIZER_WIDTH_FALLBACK = 8;
export const FILTER_INPUT_DEBOUNCE_MS = 120;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let filterInputDebounce: ReturnType<typeof setTimeout> | undefined;
let modalLayerObserver: MutationObserver | null = null;
let modalLayerActive = false;
let focusBeforeModal: HTMLElement | null = null;
let focusBeforeSidebar: HTMLElement | null = null;
const sidebarBackgroundInert = new Map<HTMLElement, boolean>();

// Stored widths represent the user's preference. Desktop fit adjustments use
// temporary CSS values and leave these preferences untouched so a wider
// window can restore the requested layout.
let preferredSidebarWidth = 240;
let preferredInspectorWidth = 360;

export function clearFilterInputDebounce(): void {
  if (filterInputDebounce !== undefined) {
    clearTimeout(filterInputDebounce);
    filterInputDebounce = undefined;
  }
}

export function disposeFilterInputDebounce(): void {
  clearFilterInputDebounce();
}

registerFilterRenderCanceller(clearFilterInputDebounce);

export function wireObjectFilterInput(): void {
  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement;
  filterInput.addEventListener("input", () => {
    state.filterText = filterInput.value;
    // Do not prune on filter input: selection is retained across filters and
    // only pruned against the full listing inside updateSelectionUI.
    clearFilterInputDebounce();
    filterInputDebounce = setTimeout(() => {
      renderObjectTableFromLayout();
      filterInputDebounce = undefined;
    }, FILTER_INPUT_DEBOUNCE_MS);
  });
}

export function applyPlatformClass(): void {
  const body = document.body;
  body.classList.remove("platform-windows", "platform-macos", "platform-linux");
  if (state.platformName) {
    body.classList.add(`platform-${state.platformName}`);
    body.setAttribute("data-platform", state.platformName);
  } else {
    body.removeAttribute("data-platform");
  }
}

export function updateShortcutChips(): void {
  const isMac = state.platformName === "macos";
  const chips = document.querySelectorAll<HTMLElement>(".shortcut-chip");
  for (const chip of chips) {
    const text = chip.textContent ?? "";
    if (isMac) {
      chip.textContent = text.replace(/^Ctrl\+/i, "⌘").replace(/^⌃/, "⌘");
    } else {
      chip.textContent = text
        .replace(/^⌘/, "Ctrl+")
        .replace(/^⌃/, "Ctrl+")
        .replace(/⇧/, "Shift+");
    }
  }
  updateToolbarShortcutTitles(isMac);
  updateInspectorToggleShortcutLabel();
}

function setTitle(id: string, title: string): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (btn) btn.title = title;
}

function updateToolbarShortcutTitles(isMac: boolean): void {
  const accel = isMac ? "⌘" : "Ctrl+";
  setTitle("btn-new-folder", `New folder (${accel}N)`);
  setTitle("btn-upload", `Upload (${accel}U)`);
  setTitle("palette-hint", `Commands (${accel}K)`);
}

export function updateInspectorToggleShortcutLabel(): void {
  const isMac = state.platformName === "macos";
  const accel = isMac ? "\u2318\u21e7I" : "Ctrl+Shift+I";
  const btn = document.getElementById("btn-inspector");
  if (!btn) return;
  btn.title = `Inspector (${accel})`;
  btn.setAttribute("aria-label", `Toggle inspector (${accel})`);
}

function isMobileSidebarMode(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(`(max-width: ${DESKTOP_BREAKPOINT}px)`).matches
  );
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  if ("inert" in element) {
    (element as HTMLElement & { inert: boolean }).inert = inert;
  }
}

function getSidebarBackgroundTargets(
  layout: HTMLElement,
  sidebar: HTMLElement,
  backdrop: HTMLElement,
): HTMLElement[] {
  const targets = Array.from(layout.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child !== sidebar && child !== backdrop,
  );
  const parent = layout.parentElement;
  if (parent) {
    for (const sibling of parent.children) {
      if (sibling instanceof HTMLElement && sibling !== layout) {
        targets.push(sibling);
      }
    }
  }
  return targets;
}

function setSidebarBackgroundInert(
  layout: HTMLElement,
  sidebar: HTMLElement,
  backdrop: HTMLElement,
  inert: boolean,
): void {
  if (inert) {
    if (sidebarBackgroundInert.size > 0) return;
    for (const target of getSidebarBackgroundTargets(
      layout,
      sidebar,
      backdrop,
    )) {
      const wasInert =
        "inert" in target
          ? (target as HTMLElement & { inert: boolean }).inert
          : false;
      sidebarBackgroundInert.set(target, wasInert);
      setElementInert(target, true);
    }
    return;
  }

  for (const [target, wasInert] of sidebarBackgroundInert) {
    setElementInert(target, wasInert);
  }
  sidebarBackgroundInert.clear();
}

export function setSidebarOpen(open: boolean): void {
  const layout = document.getElementById("main-layout");
  const sidebar = document.getElementById("bucket-panel");
  const toggle = document.getElementById("sidebar-toggle");
  const backdrop = document.getElementById(
    "sidebar-backdrop",
  ) as HTMLButtonElement | null;
  if (!layout || !sidebar || !backdrop) return;

  const mobile = isMobileSidebarMode();
  const wasOpen = layout.classList.contains("main-layout--sidebar-open");
  if (mobile && open && !wasOpen) {
    const active = document.activeElement;
    focusBeforeSidebar =
      active instanceof HTMLElement && !sidebar.contains(active)
        ? active
        : toggle;
  }

  layout.classList.toggle("main-layout--sidebar-open", open);
  backdrop.hidden = !open;
  toggle?.setAttribute("aria-expanded", String(mobile && open));

  if (mobile) {
    if (open) {
      sidebar.removeAttribute("aria-hidden");
    } else {
      sidebar.setAttribute("aria-hidden", "true");
    }
    setElementInert(sidebar, !open);
    setSidebarBackgroundInert(layout, sidebar, backdrop, open);
  } else {
    sidebar.removeAttribute("aria-hidden");
    setElementInert(sidebar, false);
    setSidebarBackgroundInert(layout, sidebar, backdrop, false);
  }

  if (mobile && open) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !sidebar.contains(active)) {
      const filter = sidebar.querySelector<HTMLInputElement>(
        "#bucket-filter-input",
      );
      (filter ?? sidebar).focus();
    }
  } else if (!open && wasOpen) {
    const restore = focusBeforeSidebar;
    focusBeforeSidebar = null;
    if (restore && document.contains(restore)) {
      restore.focus();
    }
  }

  syncPanelWidths();
}

function toggleSidebar(): void {
  const layout = document.getElementById("main-layout");
  if (!layout) return;
  const open = !layout.classList.contains("main-layout--sidebar-open");
  setSidebarOpen(open);
}

export function closeSidebarOnMobile(): void {
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

export function getActiveModalOverlay(): HTMLElement | null {
  const overlays = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".modal-overlay.active, .dialog-overlay.active, .support-overlay:not([hidden]), .setup-wizard-overlay:not([hidden]), #palette-overlay:not([hidden])",
    ),
  );
  if (overlays.length === 0) return null;
  return overlays.reduce((top, overlay) => {
    const topZ = Number.parseInt(getComputedStyle(top).zIndex, 10) || 0;
    const overlayZ = Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0;
    return overlayZ >= topZ ? overlay : top;
  });
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

const MODAL_OVERLAY_SELECTOR =
  ".modal-overlay, .dialog-overlay, .support-overlay, .setup-wizard-overlay, #palette-overlay";
/// Titlebar controls that must stay usable while a modal is open. The drag
/// handle keeps the window movable; the window buttons stay operable under
/// the overlay, and everything else in the header is inert like the page.
const MODAL_BACKDROP_EXEMPT_SELECTOR =
  "#titlebar-win-controls, .titlebar-drag-handle";
/// Most recent focusable control outside the modal layer. WebKit does not
/// focus buttons on click, so a mouse-opened dialog would otherwise lose its
/// opener.
let lastOutsideFocus: HTMLElement | null = null;
let modalInertTargets: HTMLElement[] = [];

function isInsideModalOverlay(node: Element): boolean {
  return node.closest(MODAL_OVERLAY_SELECTOR) !== null;
}

function rememberOutsideFocus(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  if (control && !isInsideModalOverlay(control)) lastOutsideFocus = control;
}

function onModalPointerDown(event: PointerEvent): void {
  rememberOutsideFocus(event.target);
}

function onModalFocusIn(event: FocusEvent): void {
  rememberOutsideFocus(event.target);
}

function resolveModalOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    !isInsideModalOverlay(active)
  ) {
    return active;
  }
  return lastOutsideFocus?.isConnected ? lastOutsideFocus : null;
}

function collectBackgroundRoots(
  container: HTMLElement,
  roots: HTMLElement[],
): void {
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.matches(MODAL_BACKDROP_EXEMPT_SELECTOR)) continue;
    if (child.querySelector(MODAL_BACKDROP_EXEMPT_SELECTOR)) {
      collectBackgroundRoots(child, roots);
    } else {
      roots.push(child);
    }
  }
}

/// Inerts the page behind a modal, leaving the titlebar window controls and
/// drag handle reachable. Only elements this module inerts are released, so
/// inert state owned by sidebar or inspector logic survives a modal.
function setModalBackgroundInert(inert: boolean): void {
  if (!inert) {
    for (const element of modalInertTargets.splice(0)) {
      setElementInert(element, false);
    }
    return;
  }
  const app = document.getElementById("app");
  if (!app) return;
  const roots: HTMLElement[] = [];
  collectBackgroundRoots(app, roots);
  for (const root of roots) {
    if ((root as HTMLElement & { inert?: boolean }).inert) continue;
    setElementInert(root, true);
    modalInertTargets.push(root);
  }
}

function focusFirstInOverlay(overlay: HTMLElement): void {
  // Settings opens on the active tab (or search), not the close button, so
  // keyboard users start where the settings content begins.
  const preferred =
    overlay.id === "settings-overlay"
      ? overlay.querySelector<HTMLElement>(
          ".settings-tab--active, #settings-search",
        )
      : null;
  const focusable = getFocusableElements(overlay);
  const target = preferred ?? focusable[0] ?? overlay;
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
    focusBeforeModal = resolveModalOpener();
    setModalBackgroundInert(true);
  } else if (!hasActiveOverlay && modalLayerActive) {
    // Release inert before restoring focus: focusing a control inside an inert
    // subtree silently does nothing, so the restore would otherwise be lost.
    setModalBackgroundInert(false);
    const restore = focusBeforeModal;
    focusBeforeModal = null;
    const active = document.activeElement;
    const focusLost =
      !(active instanceof HTMLElement) ||
      active === document.body ||
      isInsideModalOverlay(active);
    if (restore?.isConnected && focusLost) {
      restore.focus();
    }
  }
  modalLayerActive = hasActiveOverlay;

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
  // Dialogs run their own trap, which also covers the dialog's buttons.
  if (!overlay || overlay.id === "dialog-overlay") return;

  const focusable = getFocusableElements(overlay);
  e.preventDefault();
  if (focusable.length === 0) {
    if (overlay.tabIndex < 0) overlay.tabIndex = -1;
    overlay.focus();
    return;
  }

  // Cycle explicitly rather than relying on native Tab order: WebKit (the
  // macOS webview) skips checkboxes and some buttons, which let focus leak
  // out of the modal.
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  let nextIndex: number;
  if (index === -1) {
    nextIndex = e.shiftKey ? focusable.length - 1 : 0;
  } else {
    nextIndex =
      (index + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
  }
  focusable[nextIndex].focus();
}

export function handleTabListArrowKey(
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

function clampInspectorWidth(width: number): number {
  return Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, width));
}

function applyInspectorWidth(width: number): void {
  document.documentElement.style.setProperty(
    "--inspector-width",
    `${clampInspectorWidth(width)}px`,
  );
}

function readCssPixelVariable(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readElementWidth(
  element: HTMLElement | null,
  fallback: number,
): number {
  if (!element) return fallback;
  const measured = element.getBoundingClientRect().width;
  if (Number.isFinite(measured) && measured > 0) return measured;
  const declared = Number.parseFloat(getComputedStyle(element).width);
  return Number.isFinite(declared) && declared > 0 ? declared : fallback;
}

function setResizerAria(
  resizer: HTMLElement | null,
  min: number,
  max: number,
  width: number,
): void {
  if (!resizer) return;
  const rounded = Math.round(Math.max(min, Math.min(max, width)));
  resizer.setAttribute("aria-valuemin", String(min));
  resizer.setAttribute("aria-valuemax", String(max));
  resizer.setAttribute("aria-valuenow", String(rounded));
  resizer.setAttribute("aria-valuetext", `${rounded} pixels`);
}

/**
 * Fits the docked panels around a usable object listing on desktop.
 *
 * Automatic fit is deliberately recomputed from the preferred widths on every
 * call. That lets a resize or a panel reopen restore the user's saved values,
 * while the effective CSS widths temporarily shrink the inspector first and
 * then the sidebar when the viewport is tight.
 */
export function syncPanelWidths(): void {
  if (isMobileSidebarMode()) return;

  const layout = document.getElementById("main-layout");
  const sidebar = document.getElementById("bucket-panel");
  if (!layout || !sidebar) return;

  const inspector = document.getElementById("inspector-panel");
  const sidebarResizer = document.getElementById("sidebar-resizer");
  const inspectorResizer = document.getElementById("inspector-resizer");
  const contentMain = document.querySelector<HTMLElement>(".content-main");
  const inspectorOpen = Boolean(inspector && !inspector.hidden);

  const storedSidebar = Number.isFinite(preferredSidebarWidth)
    ? preferredSidebarWidth
    : readCssPixelVariable("--sidebar-width", 240);
  const storedInspector = Number.isFinite(preferredInspectorWidth)
    ? preferredInspectorWidth
    : readCssPixelVariable("--inspector-width", 360);
  const requestedSidebar = clampSidebarWidth(storedSidebar);
  const requestedInspector = clampInspectorWidth(storedInspector);

  // Restore the requested values before measuring. Without this step a
  // temporary fit from a previous narrow viewport would compound on every
  // resize and never recover the saved preference.
  applySidebarWidth(requestedSidebar);
  applyInspectorWidth(requestedInspector);

  const viewportWidth = readElementWidth(
    layout,
    Number.isFinite(window.innerWidth) ? window.innerWidth : 0,
  );
  const sidebarWidth = clampSidebarWidth(
    readElementWidth(sidebar, requestedSidebar),
  );
  const sidebarResizerWidth =
    sidebarResizer && !sidebarResizer.hidden
      ? readElementWidth(sidebarResizer, RESIZER_WIDTH_FALLBACK)
      : 0;
  const inspectorWidth = inspectorOpen
    ? clampInspectorWidth(readElementWidth(inspector, requestedInspector))
    : 0;
  const inspectorResizerWidth =
    inspectorOpen && inspectorResizer && !inspectorResizer.hidden
      ? readElementWidth(inspectorResizer, RESIZER_WIDTH_FALLBACK)
      : 0;

  let effectiveSidebar = sidebarWidth;
  let effectiveInspector = inspectorWidth;
  const calculatedListingWidth =
    viewportWidth -
    effectiveSidebar -
    sidebarResizerWidth -
    effectiveInspector -
    inspectorResizerWidth;
  const measuredListingWidth = contentMain
    ? contentMain.getBoundingClientRect().width
    : 0;
  const listingWidth =
    measuredListingWidth > 0
      ? Math.min(calculatedListingWidth, measuredListingWidth)
      : calculatedListingWidth;
  let deficit = Math.max(0, LISTING_MIN_WIDTH - listingWidth);

  if (deficit > 0 && inspectorOpen) {
    const inspectorReduction = Math.min(
      deficit,
      Math.max(0, effectiveInspector - INSPECTOR_MIN),
    );
    effectiveInspector -= inspectorReduction;
    deficit -= inspectorReduction;
  }

  if (deficit > 0) {
    const sidebarReduction = Math.min(
      deficit,
      Math.max(0, effectiveSidebar - SIDEBAR_MIN),
    );
    effectiveSidebar -= sidebarReduction;
    deficit -= sidebarReduction;
  }

  applySidebarWidth(effectiveSidebar);
  if (inspector) applyInspectorWidth(effectiveInspector || requestedInspector);
  setResizerAria(sidebarResizer, SIDEBAR_MIN, SIDEBAR_MAX, effectiveSidebar);
  setResizerAria(
    inspectorResizer,
    INSPECTOR_MIN,
    INSPECTOR_MAX,
    effectiveInspector || requestedInspector,
  );
}

export function wireInspectorControls(): void {
  const panel = document.getElementById("inspector-panel");
  const resizer = document.getElementById("inspector-resizer");
  if (!panel || !resizer) return;

  const readInspectorWidth = () => panel.getBoundingClientRect().width;
  const savedWidthRaw = window.localStorage.getItem(INSPECTOR_STORAGE_KEY);
  const savedWidth = savedWidthRaw ? Number(savedWidthRaw) : NaN;
  const updateInspectorResizerAria = (width: number) => {
    const rounded = Math.round(clampInspectorWidth(width));
    resizer.setAttribute("aria-valuemin", String(INSPECTOR_MIN));
    resizer.setAttribute("aria-valuemax", String(INSPECTOR_MAX));
    resizer.setAttribute("aria-valuenow", String(rounded));
    resizer.setAttribute("aria-valuetext", `${rounded} pixels`);
  };
  if (Number.isFinite(savedWidth)) {
    preferredInspectorWidth = clampInspectorWidth(savedWidth);
    applyInspectorWidth(savedWidth);
    updateInspectorResizerAria(savedWidth);
  } else {
    preferredInspectorWidth = clampInspectorWidth(
      readInspectorWidth() ||
        readCssPixelVariable("--inspector-width", preferredInspectorWidth),
    );
    updateInspectorResizerAria(preferredInspectorWidth);
  }

  const persistInspectorWidth = (width: number) => {
    preferredInspectorWidth = clampInspectorWidth(width);
    window.localStorage.setItem(
      INSPECTOR_STORAGE_KEY,
      String(clampInspectorWidth(width)),
    );
  };

  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  const onMouseMove = (event: MouseEvent) => {
    if (!dragging) return;
    const delta = dragStartX - event.clientX;
    preferredInspectorWidth = clampInspectorWidth(dragStartWidth + delta);
    syncPanelWidths();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("inspector-resizer--active");
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    // Persist the requested width, rather than the temporarily fitted width
    // shown while the viewport is tight. The next wider layout can restore
    // this preference through syncPanelWidths().
    persistInspectorWidth(preferredInspectorWidth);
    syncPanelWidths();
  };

  resizer.addEventListener("mousedown", (event) => {
    if (isMobileSidebarMode()) return;
    event.preventDefault();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = readInspectorWidth();
    resizer.classList.add("inspector-resizer--active");
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  resizer.addEventListener("keydown", (event) => {
    if (isMobileSidebarMode()) return;
    const currentWidth = readInspectorWidth();
    const step = event.shiftKey ? 40 : 16;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = currentWidth + step;
    } else if (event.key === "ArrowRight") {
      nextWidth = currentWidth - step;
    } else if (event.key === "Home") {
      nextWidth = INSPECTOR_MAX;
    } else if (event.key === "End") {
      nextWidth = INSPECTOR_MIN;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    const clamped = clampInspectorWidth(nextWidth);
    persistInspectorWidth(clamped);
    syncPanelWidths();
  });

  syncPanelWidths();
}

/* Toolbar collapse: labels first (a container query in layout.css), then
   whole buttons into the ⋯ overflow menu, so the toolbar never wraps. */
const TOOLBAR_BREADCRUMB_MIN = 160;
const TOOLBAR_SLACK_PX = 24;
const TOOLBAR_COLLAPSE_ORDER = [
  "btn-new-folder",
  "btn-refresh",
  "btn-upload",
] as const;

let toolbarOverflowObserver: ResizeObserver | null = null;

function fitToolbarButtons(): void {
  const toolbar = document.querySelector<HTMLElement>(".content-toolbar");
  const overflowButton = document.getElementById("btn-toolbar-overflow");
  if (!toolbar || !overflowButton) return;
  if (toolbar.offsetWidth === 0) return;

  const buttons = TOOLBAR_COLLAPSE_ORDER.map((id) =>
    document.getElementById(id),
  ).filter((button): button is HTMLButtonElement => button !== null);

  const nav = toolbar.querySelector<HTMLElement>(".content-toolbar__nav");
  const filter = toolbar.querySelector<HTMLElement>(".filter-control");
  const actions = toolbar.querySelector<HTMLElement>(
    ".content-toolbar__actions",
  );

  const actionsWidth = (): number => {
    if (!actions) return 0;
    const style = getComputedStyle(actions);
    const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
    let width = 0;
    let count = 0;
    for (const child of Array.from(actions.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const box = child.getBoundingClientRect();
      if (box.width > 0) {
        width += box.width;
        count += 1;
      }
    }
    return count > 1 ? width + gap * (count - 1) : width;
  };

  const requiredWidth = (): number =>
    TOOLBAR_SLACK_PX +
    (nav?.getBoundingClientRect().width ?? 0) +
    TOOLBAR_BREADCRUMB_MIN +
    (filter?.getBoundingClientRect().width ?? 0) +
    actionsWidth();

  const available = toolbar.getBoundingClientRect().width;

  // Re-measure from the fully expanded state so widening the window
  // restores buttons in the reverse order they were collapsed.
  for (const button of buttons) button.hidden = false;
  let hiddenCount = 0;
  for (const button of buttons) {
    if (requiredWidth() > available) {
      button.hidden = true;
      hiddenCount += 1;
    }
  }
  overflowButton.hidden = hiddenCount === 0;
}

function wireToolbarOverflow(): void {
  const toolbar = document.querySelector<HTMLElement>(".content-toolbar");
  const overflowButton = document.getElementById("btn-toolbar-overflow");
  if (!toolbar || !overflowButton || toolbarOverflowObserver) return;

  const dismissOverflowMenu = (): void => {
    overflowButton.setAttribute("aria-expanded", "false");
  };
  overflowButton.addEventListener("click", () => {
    if (overflowButton.hidden) return;
    dismissOverflowMenu();
    const items: MenuItem[] = [];
    const collapsed = (id: string): boolean =>
      document.getElementById(id)?.hasAttribute("hidden") ?? false;
    if (collapsed("btn-new-folder")) {
      items.push({ label: "New folder", action: "new-folder" });
    }
    if (collapsed("btn-refresh")) {
      items.push({ label: "Refresh", action: "refresh" });
    }
    if (collapsed("btn-upload")) {
      items.push({ separator: true });
      items.push({ label: "Files\u2026", action: "upload-files" });
      items.push({ label: "Folder\u2026", action: "upload-folder" });
    }
    if (items.length === 0) return;
    const rect = overflowButton.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom,
      items,
      (action) => {
        dismissOverflowMenu();
        if (action === "new-folder") void handleCreateFolder();
        else if (action === "refresh") void handleRefresh();
        else if (action === "upload-files") void handleUploadButton();
        else if (action === "upload-folder") void handleUploadFolderButton();
      },
      dismissOverflowMenu,
    );
    overflowButton.setAttribute("aria-expanded", "true");
  });

  // jsdom and very old webviews lack ResizeObserver; the toolbar then keeps
  // every button visible and the overflow menu simply stays hidden.
  if (typeof ResizeObserver === "function") {
    toolbarOverflowObserver = new ResizeObserver(() => fitToolbarButtons());
    toolbarOverflowObserver.observe(toolbar);
  }
  fitToolbarButtons();
  // Icon injection and font loading change button widths without changing
  // the toolbar's own size, so re-fit once the first frames have painted.
  window.setTimeout(fitToolbarButtons, 300);
}

export function wireLayoutControls(): void {
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
    preferredSidebarWidth = clamped;
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(clamped));
  };
  if (Number.isFinite(savedWidth)) {
    preferredSidebarWidth = clampSidebarWidth(savedWidth);
    applySidebarWidth(savedWidth);
    updateResizerAria(savedWidth);
  } else {
    preferredSidebarWidth = clampSidebarWidth(
      readSidebarWidth() ||
        readCssPixelVariable("--sidebar-width", preferredSidebarWidth),
    );
    updateResizerAria(preferredSidebarWidth);
  }

  const syncSidebarMode = () => {
    const layout = document.getElementById("main-layout");
    if (!layout) return;
    if (isMobileSidebarMode()) {
      setSidebarOpen(layout.classList.contains("main-layout--sidebar-open"));
    } else {
      setSidebarOpen(false);
    }
  };
  syncSidebarMode();

  toggleBtn?.addEventListener("click", toggleSidebar);
  backdrop?.addEventListener("click", () => setSidebarOpen(false));
  window.addEventListener("resize", syncSidebarMode);
  wireToolbarOverflow();

  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  const onMouseMove = (event: MouseEvent) => {
    if (!dragging) return;
    const delta = event.clientX - dragStartX;
    preferredSidebarWidth = clampSidebarWidth(dragStartWidth + delta);
    syncPanelWidths();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("sidebar-resizer--active");
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    // Persist the requested width, rather than the temporarily fitted width
    // shown while the viewport is tight. The next wider layout can restore
    // this preference through syncPanelWidths().
    persistSidebarWidth(preferredSidebarWidth);
    syncPanelWidths();
  };

  resizer.addEventListener("mousedown", (event) => {
    if (isMobileSidebarMode()) return;
    event.preventDefault();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = readSidebarWidth();
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
    persistSidebarWidth(clamped);
    syncPanelWidths();
  });

  resizer.addEventListener("dblclick", () => {
    if (isMobileSidebarMode()) return;
    // Reset to the CSS default (--sidebar-width: 240px in tokens.css).
    window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    preferredSidebarWidth = 240;
    applySidebarWidth(240);
    updateResizerAria(240);
    syncPanelWidths();
  });

  syncPanelWidths();
}

export function initModalLayerObserver(): void {
  if (modalLayerObserver) return;
  modalLayerObserver = new MutationObserver(() => {
    syncModalLayerState();
  });
  document.addEventListener("pointerdown", onModalPointerDown, true);
  document.addEventListener("focusin", onModalFocusIn, true);
  document
    .querySelectorAll<HTMLElement>(MODAL_OVERLAY_SELECTOR)
    .forEach((overlay) => {
      modalLayerObserver!.observe(overlay, {
        attributes: true,
        attributeFilter: ["class", "hidden"],
      });
    });
  document.addEventListener("keydown", trapFocusInModalLayer, true);
  syncModalLayerState();
}

export function disposeModalLayerObserver(): void {
  if (modalLayerObserver) {
    modalLayerObserver.disconnect();
    modalLayerObserver = null;
  }
  document.removeEventListener("keydown", trapFocusInModalLayer, true);
  document.removeEventListener("pointerdown", onModalPointerDown, true);
  document.removeEventListener("focusin", onModalFocusIn, true);
  lastOutsideFocus = null;
}
