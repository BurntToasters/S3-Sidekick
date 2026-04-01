import { $ } from "./utils.ts";
import { markActivitySeen } from "./activity-log.ts";

export type DrawerTab = "activity" | "transfers";

let currentTab: DrawerTab = "activity";
let minimized = false;
const _parsedHeight = parseInt(
  localStorage.getItem("drawer-height") ?? "240",
  10,
);
let drawerHeight =
  Number.isFinite(_parsedHeight) && _parsedHeight >= 120 ? _parsedHeight : 240;

const STORAGE_KEY = "drawer-height";
const MIN_HEIGHT = 120;
const MAX_RATIO = 0.5;

export function initDrawer(): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  drawer.style.height = `${drawerHeight}px`;

  $("drawer-tab-activity").addEventListener("click", () =>
    switchDrawerTab("activity"),
  );
  $("drawer-tab-transfers").addEventListener("click", () =>
    switchDrawerTab("transfers"),
  );
  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-minimize").addEventListener("click", toggleMinimized);

  const handle = drawer.querySelector(
    ".bottom-drawer__resize-handle",
  ) as HTMLElement;
  if (handle) {
    handle.title = "Drag to resize";
    initResize(handle, drawer);
  }
}

export function openDrawer(tab: DrawerTab): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  minimized = false;
  drawer.classList.remove("bottom-drawer--minimized");
  drawer.hidden = false;
  drawer.style.height = `${drawerHeight}px`;
  switchDrawerTab(tab);
  syncToggleButtons(true);
}

export function closeDrawer(): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  drawer.hidden = true;
  minimized = false;
  drawer.classList.remove("bottom-drawer--minimized");
  syncToggleButtons(false);
}

export function isDrawerOpen(): boolean {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  return drawer ? !drawer.hidden : false;
}

export function getActiveTab(): DrawerTab {
  return currentTab;
}

export function toggleDrawer(tab: DrawerTab): void {
  if (isDrawerOpen() && currentTab === tab) {
    closeDrawer();
  } else {
    openDrawer(tab);
  }
}

function toggleMinimized(): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  minimized = !minimized;
  drawer.classList.toggle("bottom-drawer--minimized", minimized);
}

export function switchDrawerTab(tab: DrawerTab): void {
  currentTab = tab;

  if (tab === "activity") {
    markActivitySeen();
  }

  const activityTab = $("drawer-tab-activity");
  const transfersTab = $("drawer-tab-transfers");
  const activityPanel = $("drawer-panel-activity");
  const transfersPanel = $("drawer-panel-transfers");

  const isActivity = tab === "activity";

  activityTab.classList.toggle("bottom-drawer__tab--active", isActivity);
  transfersTab.classList.toggle("bottom-drawer__tab--active", !isActivity);
  activityTab.setAttribute("aria-selected", String(isActivity));
  transfersTab.setAttribute("aria-selected", String(!isActivity));
  activityTab.tabIndex = isActivity ? 0 : -1;
  transfersTab.tabIndex = isActivity ? -1 : 0;

  activityPanel.hidden = !isActivity;
  transfersPanel.hidden = isActivity;

  updateClearButton();
  syncToggleButtons(isDrawerOpen());
}

export function updateClearButton(): void {
  const btn = document.getElementById(
    "drawer-clear",
  ) as HTMLButtonElement | null;
  if (!btn) return;
  if (currentTab === "activity") {
    btn.textContent = "Clear";
    btn.style.display = "";
  } else {
    btn.textContent = "Clear done";
    btn.style.display = "";
  }
}

function syncToggleButtons(open: boolean): void {
  const activityToggle = document.getElementById(
    "activity-toggle",
  ) as HTMLButtonElement | null;
  const transferToggle = document.getElementById(
    "transfer-toggle",
  ) as HTMLButtonElement | null;
  if (activityToggle)
    activityToggle.setAttribute(
      "aria-expanded",
      String(open && currentTab === "activity"),
    );
  if (transferToggle)
    transferToggle.setAttribute(
      "aria-expanded",
      String(open && currentTab === "transfers"),
    );
}

function initResize(handle: HTMLElement, drawer: HTMLDivElement): void {
  let startY = 0;
  let startHeight = 0;
  const maxHeight = () => Math.round(window.innerHeight * MAX_RATIO);

  const updateHandleAria = () => {
    handle.setAttribute("aria-valuemin", String(MIN_HEIGHT));
    handle.setAttribute("aria-valuemax", String(maxHeight()));
    handle.setAttribute("aria-valuenow", String(Math.round(drawerHeight)));
    handle.setAttribute("aria-valuetext", `${Math.round(drawerHeight)} pixels`);
  };

  function onMouseMove(e: MouseEvent) {
    const delta = startY - e.clientY;
    const newHeight = Math.min(
      window.innerHeight * MAX_RATIO,
      Math.max(MIN_HEIGHT, startHeight + delta),
    );
    drawerHeight = Math.round(newHeight);
    drawer.style.height = `${drawerHeight}px`;
    updateHandleAria();
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    localStorage.setItem(STORAGE_KEY, String(drawerHeight));
    updateHandleAria();
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startHeight = drawer.getBoundingClientRect().height;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 16;
    let nextHeight: number | null = null;

    if (e.key === "ArrowUp") {
      nextHeight = drawerHeight + step;
    } else if (e.key === "ArrowDown") {
      nextHeight = drawerHeight - step;
    } else if (e.key === "Home") {
      nextHeight = MIN_HEIGHT;
    } else if (e.key === "End") {
      nextHeight = maxHeight();
    }

    if (nextHeight === null) return;
    e.preventDefault();
    drawerHeight = Math.min(maxHeight(), Math.max(MIN_HEIGHT, nextHeight));
    drawer.style.height = `${drawerHeight}px`;
    localStorage.setItem(STORAGE_KEY, String(drawerHeight));
    updateHandleAria();
  });

  updateHandleAria();
}
