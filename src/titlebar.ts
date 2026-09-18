import { getCurrentWindow } from "@tauri-apps/api/window";
import { state } from "./state.ts";

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

function wireWindowsCaptionButtons(): void {
  const win = getCurrentWindow();
  const minimize = document.getElementById("titlebar-minimize");
  const maximize = document.getElementById("titlebar-maximize");
  const close = document.getElementById("titlebar-close");

  minimize?.addEventListener("click", (event) => {
    event.stopPropagation();
    void win.minimize();
  });

  maximize?.addEventListener("click", (event) => {
    event.stopPropagation();
    void win.toggleMaximize();
  });

  close?.addEventListener("click", (event) => {
    event.stopPropagation();
    void win.close();
  });
}
