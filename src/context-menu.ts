export interface MenuAction {
  label: string;
  action: string;
  separator?: false;
  disabled?: boolean;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuAction | MenuSeparator;

let activeMenu: HTMLElement | null = null;
let dismissHandler: ((e: MouseEvent) => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let restoreFocusTarget: HTMLElement | null = null;
let dismissCallback: (() => void) | null = null;

export function showContextMenu(
  x: number,
  y: number,
  items: MenuItem[],
  onAction: (action: string) => void,
  onDismiss?: () => void,
): void {
  hideContextMenu();
  restoreFocusTarget =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dismissCallback = onDismiss ?? null;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu__sep";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "context-menu__item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideContextMenu();
      onAction(item.action);
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width > vw) x = vw - rect.width - 4;
  if (y + rect.height > vh) y = vh - rect.height - 4;
  if (x < 0) x = 4;
  if (y < 0) y = 4;

  menu.style.left = x + "px";
  menu.style.top = y + "px";

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
      hideContextMenu();
      return;
    }
    if (e.key === "Tab") {
      // A context menu is a transient layer. Tabbing away dismisses it and
      // returns focus to the element that opened it instead of trapping the
      // user in a menu that has no surrounding document order.
      e.preventDefault();
      hideContextMenu();
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

  dismissHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      hideContextMenu();
    }
  };
  const pendingDismiss = dismissHandler;
  const pendingKey = keyHandler;
  setTimeout(() => {
    if (dismissHandler === pendingDismiss && pendingDismiss) {
      document.addEventListener("mousedown", pendingDismiss);
    }
    if (keyHandler === pendingKey && pendingKey) {
      document.addEventListener("keydown", pendingKey);
    }
  }, 0);
}

export function hideContextMenu(): boolean {
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
    document.removeEventListener("mousedown", dismissHandler);
    dismissHandler = null;
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

  onDismiss?.();

  return wasOpen;
}

/** Returns whether a transient context menu is currently mounted. */
export function isContextMenuOpen(): boolean {
  return activeMenu !== null;
}
