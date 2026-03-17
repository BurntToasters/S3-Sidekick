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

export function showContextMenu(
  x: number,
  y: number,
  items: MenuItem[],
  onAction: (action: string) => void,
): void {
  hideContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu__sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "context-menu__item";
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

  dismissHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      hideContextMenu();
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", dismissHandler!);
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
}
