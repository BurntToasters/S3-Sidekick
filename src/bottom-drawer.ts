import { $ } from "./utils.ts";
import { markActivitySeen } from "./activity-log.ts";
import { handleTabListArrowKey } from "./app-layout.ts";

export type DrawerTab = "activity" | "transfers";

let currentTab: DrawerTab = "activity";
let minimized = false;
let focusBeforeDrawer: HTMLElement | null = null;
function readStoredDrawerHeight(): number {
  try {
    const parsed = parseInt(localStorage.getItem("drawer-height") ?? "240", 10);
    return Number.isFinite(parsed) && parsed >= 120 ? parsed : 240;
  } catch {
    return 240;
  }
}
let drawerHeight = readStoredDrawerHeight();

const STORAGE_KEY = "drawer-height";
const MIN_HEIGHT = 120;
const MAX_RATIO = 0.5;

function maxDrawerHeight(): number {
  return Math.round(window.innerHeight * MAX_RATIO);
}

function effectiveDrawerHeight(): number {
  return Math.min(maxDrawerHeight(), Math.max(MIN_HEIGHT, drawerHeight));
}

function drawerToggle(tab: DrawerTab): HTMLElement | null {
  return document.getElementById(
    tab === "activity" ? "activity-toggle" : "transfer-toggle",
  );
}

function syncMinimizeButton(): void {
  const button = document.getElementById(
    "drawer-minimize",
  ) as HTMLButtonElement | null;
  if (!button) return;
  const expanded = !minimized;
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute(
    "aria-label",
    expanded ? "Minimize panel" : "Restore panel",
  );
  button.title = expanded ? "Minimize" : "Restore";
}

function applyExpandedHeight(drawer: HTMLDivElement): void {
  drawer.style.height = `${effectiveDrawerHeight()}px`;
}

export function initDrawer(): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  applyExpandedHeight(drawer);
  syncMinimizeButton();

  const activityTab = $("drawer-tab-activity");
  const transfersTab = $("drawer-tab-transfers");
  activityTab.addEventListener("click", () => switchDrawerTab("activity"));
  transfersTab.addEventListener("click", () => switchDrawerTab("transfers"));
  drawer
    .querySelector<HTMLElement>(".bottom-drawer__tabs")
    ?.addEventListener("keydown", (event) => {
      handleTabListArrowKey(event, [activityTab, transfersTab], (tab) =>
        switchDrawerTab(tab === activityTab ? "activity" : "transfers"),
      );
    });
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

  if (drawer.hidden) {
    const active = document.activeElement;
    focusBeforeDrawer =
      active instanceof HTMLElement &&
      active !== document.body &&
      !drawer.contains(active)
        ? active
        : drawerToggle(tab);
  }

  minimized = false;
  drawer.classList.remove("bottom-drawer--minimized");
  drawer.hidden = false;
  drawer
    .querySelector<HTMLElement>(".bottom-drawer__resize-handle")
    ?.removeAttribute("hidden");
  applyExpandedHeight(drawer);
  syncMinimizeButton();
  switchDrawerTab(tab);
  syncToggleButtons(true);
}

export function closeDrawer(): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  const active = document.activeElement;
  const focusWasInDrawer =
    active instanceof HTMLElement && drawer.contains(active);
  drawer.hidden = true;
  minimized = false;
  drawer.classList.remove("bottom-drawer--minimized");
  drawer
    .querySelector<HTMLElement>(".bottom-drawer__resize-handle")
    ?.removeAttribute("hidden");
  syncMinimizeButton();
  syncToggleButtons(false);

  const restore = focusBeforeDrawer;
  focusBeforeDrawer = null;
  if (
    restore?.isConnected &&
    (focusWasInDrawer || active === document.body || active === null)
  ) {
    restore.focus();
  }
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

  const active = document.activeElement;
  const body = drawer.querySelector<HTMLElement>(".bottom-drawer__body");
  const handle = drawer.querySelector<HTMLElement>(
    ".bottom-drawer__resize-handle",
  );

  minimized = !minimized;
  drawer.classList.toggle("bottom-drawer--minimized", minimized);
  if (minimized) {
    // The inline expanded height would beat the CSS `height: auto` rule and
    // leave the body-sized drawer visible. Removing it lets the header define
    // the collapsed height while drawerHeight retains the preferred size.
    drawer.style.height = "";
    if (handle) handle.hidden = true;
    if (
      active instanceof HTMLElement &&
      ((body?.contains(active) ?? false) || active === handle)
    ) {
      document
        .getElementById(
          currentTab === "activity"
            ? "drawer-tab-activity"
            : "drawer-tab-transfers",
        )
        ?.focus();
    }
  } else {
    if (handle) handle.hidden = false;
    applyExpandedHeight(drawer);
  }
  syncMinimizeButton();
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
  // Export only exports the activity log; hide it while transfers are shown
  // instead of leaving a button that does nothing.
  const exportBtn = document.getElementById(
    "drawer-export",
  ) as HTMLButtonElement | null;
  if (exportBtn) {
    exportBtn.style.display = currentTab === "activity" ? "" : "none";
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

  const updateHandleAria = () => {
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-valuemin", String(MIN_HEIGHT));
    handle.setAttribute("aria-valuemax", String(maxDrawerHeight()));
    handle.setAttribute("aria-valuenow", String(effectiveDrawerHeight()));
    handle.setAttribute("aria-valuetext", `${effectiveDrawerHeight()} pixels`);
  };

  function onMouseMove(e: MouseEvent) {
    const delta = startY - e.clientY;
    const newHeight = Math.min(
      maxDrawerHeight(),
      Math.max(MIN_HEIGHT, startHeight + delta),
    );
    drawerHeight = Math.round(newHeight);
    if (!minimized) applyExpandedHeight(drawer);
    updateHandleAria();
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    if (!minimized) {
      try {
        localStorage.setItem(STORAGE_KEY, String(drawerHeight));
      } catch {
        // Storage unavailable (private mode); height persistence is best-effort.
      }
    }
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
      nextHeight = maxDrawerHeight();
    }

    if (nextHeight === null) return;
    e.preventDefault();
    drawerHeight = Math.min(
      maxDrawerHeight(),
      Math.max(MIN_HEIGHT, nextHeight),
    );
    if (!minimized) {
      applyExpandedHeight(drawer);
      try {
        localStorage.setItem(STORAGE_KEY, String(drawerHeight));
      } catch {
        // Storage unavailable (private mode); height persistence is best-effort.
      }
    }
    updateHandleAria();
  });

  updateHandleAria();
  window.addEventListener("resize", () => {
    if (!drawer.hidden && !minimized) applyExpandedHeight(drawer);
    updateHandleAria();
  });
}
