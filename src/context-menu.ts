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

export function showContextMenu(
  x: number,
  y: number,
  items: MenuItem[],
  onAction: (action: string) => void,
): void {
  hideContextMenu();

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
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? buttons.indexOf(focused as HTMLButtonElement) : -1;
      let next: number;
      if (e.key === "ArrowDown") {
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

export function hideContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (dismissHandler) {
    document.removeEventListener("mousedown", dismissHandler);
    dismissHandler = null;
  }
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
}
