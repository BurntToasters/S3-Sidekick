import { getIconHtml } from "./utils.ts";

export interface MenuAction {
  label: string;
  action: string;
  separator?: false;
  disabled?: boolean;
  /** Shown under a disabled item so the user learns why it is unavailable. */
  disabledReason?: string;
  /** Display-only keyboard hint; kept out of the accessible name. */
  shortcut?: string;
  /** Leading icon name from the icon registry; decorative only. */
  icon?: string;
  /** Destructive items render with the shared danger styling. */
  danger?: boolean;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuAction | MenuSeparator;

/**
 * Why a menu closed. Action clicks are reported as "action"; Escape, Tab,
 * outside clicks, scroll/resize and programmatic closes report "dismiss".
 * Existing callers that ignore the argument keep working because a zero-arg
 * callback is assignable to this signature.
 */
export type ContextMenuDismissReason = "action" | "dismiss";

let activeMenu: HTMLElement | null = null;
let dismissHandler: ((e: Event) => void) | null = null;
let viewportHandler: ((e: Event) => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let restoreFocusTarget: HTMLElement | null = null;
let dismissCallback: ((reason: ContextMenuDismissReason) => void) | null = null;
let reasonSequence = 0;

function closeContextMenu(reason: ContextMenuDismissReason): boolean {
  const menu = activeMenu;
  const activeElement = document.activeElement;
  const wasOpen = menu !== null;
  const onDismiss = dismissCallback;

  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  dismissCallback = null;
  if (dismissHandler) {
    document.removeEventListener("pointerdown", dismissHandler);
    document.removeEventListener("mousedown", dismissHandler);
    dismissHandler = null;
  }
  if (viewportHandler) {
    window.removeEventListener("resize", viewportHandler);
    window.removeEventListener("scroll", viewportHandler, true);
    viewportHandler = null;
  }
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  // Return focus to the invoker when the menu was dismissed without moving
  // focus somewhere else (click actions own their own focus behavior).
  const target = restoreFocusTarget;
  restoreFocusTarget = null;
  if (
    target &&
    target.isConnected &&
    (activeElement === document.body ||
      activeElement === menu ||
      (menu !== null &&
        activeElement instanceof Node &&
        menu.contains(activeElement)))
  ) {
    target.focus();
  }

  onDismiss?.(reason);

  return wasOpen;
}

export function showContextMenu(
  x: number,
  y: number,
  items: MenuItem[],
  onAction: (action: string) => void,
  onDismiss?: (reason: ContextMenuDismissReason) => void,
): void {
  hideContextMenu();
  restoreFocusTarget =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dismissCallback = onDismiss ?? null;

  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Context menu");
  // Measure while invisible so the first frame never paints at 0,0.
  menu.style.visibility = "hidden";

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu__sep";
      sep.setAttribute("role", "separator");
      sep.setAttribute("aria-orientation", "horizontal");
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu__item";
    btn.setAttribute("role", "menuitem");
    btn.dataset.action = item.action;
    if (item.danger) btn.classList.add("context-menu__item--danger");
    if (item.icon) {
      const icon = document.createElement("span");
      icon.className = "context-menu__icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = getIconHtml(item.icon, {
        className: "lucide-icon",
        decorative: true,
      });
      btn.appendChild(icon);
    }
    const isDisabled = !!item.disabled;
    if (isDisabled) {
      // Keep the item focusable so keyboard and screen-reader users can reach
      // the reason text; aria-disabled carries the state without removing it
      // from the arrow-key order.
      btn.setAttribute("aria-disabled", "true");
      btn.classList.add("context-menu__item--disabled");
      btn.style.opacity = "0.55";
      btn.style.cursor = "not-allowed";
    }
    const label = document.createElement("span");
    label.className = "context-menu__label";
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.shortcut) {
      const hint = document.createElement("span");
      hint.className = "context-menu__shortcut";
      hint.setAttribute("aria-hidden", "true");
      hint.textContent = item.shortcut;
      btn.appendChild(hint);
    }
    btn.disabled = false;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isDisabled) {
        // A disabled item explains itself instead of firing.
        btn.focus();
        return;
      }
      closeContextMenu("action");
      onAction(item.action);
    });
    menu.appendChild(btn);
    if (item.disabled && item.disabledReason) {
      // A disabled button takes no focus, so the reason sits in the menu as
      // visible text and is linked to the item for assistive technology.
      const reason = document.createElement("div");
      reason.className = "context-menu__reason";
      reason.id = `context-menu-reason-${++reasonSequence}`;
      reason.setAttribute("role", "presentation");
      reason.textContent = item.disabledReason;
      btn.setAttribute("aria-describedby", reason.id);
      menu.appendChild(reason);
    }
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // A custom titlebar owns the top strip of the viewport. The offset is
  // published by modals.css; non-titlebar shells fall back to zero.
  const titlebarOffset = Number.parseFloat(
    window.getComputedStyle(menu).getPropertyValue("--context-menu-top-offset"),
  );
  const safeTop =
    Number.isFinite(titlebarOffset) && titlebarOffset > 0
      ? titlebarOffset + 4
      : 4;
  if (x + rect.width > vw) x = vw - rect.width - 4;
  if (y + rect.height > vh) y = vh - rect.height - 4;
  if (x < 4) x = 4;
  if (y < safeTop) y = safeTop;

  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.visibility = "";

  activeMenu = menu;

  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>(
      ".context-menu__item:not(:disabled)",
    ),
  );
  if (buttons.length > 0) buttons[0].focus();

  keyHandler = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu("dismiss");
      return;
    }
    if (e.key === "Tab") {
      // A context menu is a transient layer. Tabbing away dismisses it and
      // returns focus to the element that opened it instead of trapping the
      // user in a menu that has no surrounding document order.
      e.preventDefault();
      closeContextMenu("dismiss");
      return;
    }
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      e.preventDefault();
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? buttons.indexOf(focused as HTMLButtonElement) : -1;
      let next: number;
      if (e.key === "Home") {
        next = 0;
      } else if (e.key === "End") {
        next = buttons.length - 1;
      } else if (e.key === "ArrowDown") {
        next = idx < buttons.length - 1 ? idx + 1 : 0;
      } else {
        next = idx > 0 ? idx - 1 : buttons.length - 1;
      }
      buttons[next]?.focus();
    }
  };

  dismissHandler = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      closeContextMenu("dismiss");
    }
  };
  viewportHandler = (e: Event) => {
    // Scrolling inside a tall menu is not a viewport change.
    if (
      e.type === "scroll" &&
      e.target instanceof Node &&
      menu.contains(e.target)
    ) {
      return;
    }
    closeContextMenu("dismiss");
  };
  const pendingDismiss = dismissHandler;
  const pendingViewport = viewportHandler;
  const pendingKey = keyHandler;
  setTimeout(() => {
    // A later menu (or a hide) supersedes this deferred registration.
    if (activeMenu !== menu) return;
    // pointerdown is the primary dismissal path; mousedown keeps older
    // WebViews (and synthetic tests) working. The first event removes both
    // listeners, so a gesture never hides the same menu twice.
    document.addEventListener("pointerdown", pendingDismiss);
    document.addEventListener("mousedown", pendingDismiss);
    document.addEventListener("keydown", pendingKey);
    window.addEventListener("resize", pendingViewport);
    window.addEventListener("scroll", pendingViewport, true);
  }, 0);
}

export function hideContextMenu(): boolean {
  return closeContextMenu("dismiss");
}

/** Returns whether a transient context menu is currently mounted. */
export function isContextMenuOpen(): boolean {
  return activeMenu !== null;
}
