import { state } from "./state.ts";
import { hideContextMenu } from "./context-menu.ts";
import { renderObjectTable } from "./browser.ts";

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
      renderObjectTable();
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
  const accelShift = isMac ? "⌘⇧" : "Ctrl+Shift+";
  setTitle("btn-new-folder", `New Folder (${accel}N)`);
  setTitle("btn-upload", `Upload Files (${accel}U)`);
  setTitle("btn-upload-folder", `Upload Folder (${accelShift}U)`);
  setTitle("btn-palette", `Commands (${accel}K)`);
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
  document
    .querySelectorAll<HTMLElement>(
      ".modal-overlay, .dialog-overlay, .support-overlay, .setup-wizard-overlay, #palette-overlay",
    )
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
}
