import { state } from "./state.ts";
import { hideContextMenu } from "./context-menu.ts";
import { renderObjectTable } from "./browser.ts";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const SIDEBAR_STORAGE_KEY = "s3-sidekick.sidebar.width";
export const FILTER_INPUT_DEBOUNCE_MS = 120;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let filterInputDebounce: ReturnType<typeof setTimeout> | undefined;
let modalLayerObserver: MutationObserver | null = null;
let modalLayerActive = false;
let focusBeforeModal: HTMLElement | null = null;

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

export function setSidebarOpen(open: boolean): void {
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

export function initModalLayerObserver(): void {
  if (modalLayerObserver) return;
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
  syncModalLayerState();
}

export function disposeModalLayerObserver(): void {
  if (modalLayerObserver) {
    modalLayerObserver.disconnect();
    modalLayerObserver = null;
  }
  document.removeEventListener("keydown", trapFocusInModalLayer, true);
}
