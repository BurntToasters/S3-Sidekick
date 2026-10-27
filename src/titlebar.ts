import { getCurrentWindow } from "@tauri-apps/api/window";
import { state } from "./state.ts";
import { getIconHtml } from "./icons.ts";

// Lucide `copy`: the restore glyph for a maximized window.
const RESTORE_ICON_SVG =
  '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

export function usesCustomTitlebar(): boolean {
  return state.platformName === "macos" || state.platformName === "windows";
}

const DRAG_REGION_SELECTOR =
  "[data-tauri-drag-region], .titlebar-drag-handle, .titlebar__traffic-spacer";

function isInteractiveTitlebarTarget(target: HTMLElement): boolean {
  return Boolean(
    target.closest(
      "button, a, input, select, textarea, .bookmark-chip, .titlebar-win-controls",
    ),
  );
}

export function wireTitlebar(): void {
  wireBookmarkBarWheel();
  if (!usesCustomTitlebar()) return;

  document.body.classList.add("titlebar-custom");

  document.querySelectorAll<HTMLElement>(DRAG_REGION_SELECTOR).forEach((el) => {
    if (!el.hasAttribute("data-tauri-drag-region")) {
      el.setAttribute("data-tauri-drag-region", "");
    }
  });

  const header = document.querySelector<HTMLElement>(".header");
  if (header && !header.hasAttribute("data-tauri-drag-region")) {
    header.setAttribute("data-tauri-drag-region", "");
  }

  wireTitlebarPointerDrag(header);

  if (state.platformName === "windows") {
    const controls = document.getElementById("titlebar-win-controls");
    if (controls) controls.hidden = false;
    wireWindowsCaptionButtons();
  }

  header?.addEventListener("dblclick", onTitlebarDoubleClick);
}

/** Fallback when WebKit does not honor -webkit-app-region on layered chrome. */
function wireTitlebarPointerDrag(header: HTMLElement | null): void {
  if (!header) return;
  const win = getCurrentWindow();
  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (isInteractiveTitlebarTarget(target)) return;
    if (!target.closest(".header")) return;
    void win.startDragging();
  });
}

function onTitlebarDoubleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (
    target.closest(
      ".header__actions, .bookmark-bar, .titlebar-win-controls, button, a, input, select, textarea",
    )
  ) {
    return;
  }
  void getCurrentWindow().toggleMaximize();
}

/**
 * The bar is a horizontal list that hides its scrollbar, so a mouse wheel
 * would otherwise do nothing. Vertical wheel motion scrolls it sideways.
 */
function wireBookmarkBarWheel(): void {
  const bar = document.getElementById("bookmark-bar");
  if (!bar) return;
  bar.addEventListener(
    "wheel",
    (event) => {
      if (bar.scrollWidth <= bar.clientWidth) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      bar.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
}

function applyMaximizeState(maximize: HTMLElement, maximized: boolean): void {
  const label = maximized ? "Restore" : "Maximize";
  maximize.innerHTML = maximized
    ? RESTORE_ICON_SVG
    : getIconHtml("square", { className: "lucide-icon", decorative: true });
  maximize.title = label;
  maximize.setAttribute("aria-label", label);
}

function wireWindowsCaptionButtons(): void {
  const win = getCurrentWindow();
  const minimize = document.getElementById("titlebar-minimize");
  const maximize = document.getElementById("titlebar-maximize");
  const close = document.getElementById("titlebar-close");

  const syncMaximize = (): void => {
    if (!maximize || typeof win.isMaximized !== "function") return;
    void win
      .isMaximized()
      .then((maximized) => applyMaximizeState(maximize, maximized))
      .catch(() => undefined);
  };

  minimize?.addEventListener("click", (event) => {
    event.stopPropagation();
    void win.minimize();
  });

  maximize?.addEventListener("click", (event) => {
    event.stopPropagation();
    void Promise.resolve(win.toggleMaximize()).then(syncMaximize, syncMaximize);
  });

  // Maximize also changes from outside the button (title bar double-click,
  // window-manager shortcuts), so follow the window rather than the click.
  if (typeof win.onResized === "function") {
    void win.onResized(syncMaximize).catch(() => undefined);
  }
  syncMaximize();

  close?.addEventListener("click", (event) => {
    event.stopPropagation();
    void win.close();
  });
}
