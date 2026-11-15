import { $ } from "./utils.ts";
import { markActivitySeen } from "./activity-log.ts";
import { handleTabListArrowKey } from "./app-layout.ts";
import { TRANSFER_TEXT } from "./transfer-render.ts";

export type DrawerTab = "activity" | "transfers";
export type TransferFilter = "all" | "active" | "failed" | "completed";

const DRAWER_OPEN_KEY = "drawer-open";
const DRAWER_TAB_KEY = "drawer-tab";
const DRAWER_MINIMIZED_KEY = "drawer-minimized";
const STORAGE_KEY = "drawer-height";
const MIN_HEIGHT = 120;
const MAX_RATIO = 0.5;

let currentTab: DrawerTab = "activity";
let minimized = false;
let focusBeforeDrawer: HTMLElement | null = null;
let transferFilter: TransferFilter = "all";

const FILTER_STATUSES: Record<TransferFilter, readonly string[] | null> = {
  all: null,
  active: ["queued", "uploading"],
  failed: ["error"],
  completed: ["done"],
};

const FILTER_EMPTY_TEXT: Record<Exclude<TransferFilter, "all">, string> = {
  active: "No active transfers",
  failed: "No failed transfers",
  completed: "No completed transfers",
};

function readStoredDrawerHeight(): number {
  try {
    const parsed = parseInt(localStorage.getItem(STORAGE_KEY) ?? "240", 10);
    return Number.isFinite(parsed) && parsed >= MIN_HEIGHT ? parsed : 240;
  } catch {
    return 240;
  }
}
let drawerHeight = readStoredDrawerHeight();

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remember open/closed, tab and minimized state across reloads. */
function persistDrawerState(): void {
  try {
    localStorage.setItem(DRAWER_OPEN_KEY, String(isDrawerOpen()));
    localStorage.setItem(DRAWER_TAB_KEY, currentTab);
    localStorage.setItem(DRAWER_MINIMIZED_KEY, String(minimized));
  } catch {
    // Storage unavailable (private mode); drawer state is best-effort.
  }
}

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
  if (button) {
    const expanded = !minimized;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute(
      "aria-label",
      expanded ? "Minimize panel" : "Restore panel",
    );
    button.title = expanded ? "Minimize" : "Restore";
  }
  publishDrawerOffset();
}

function applyExpandedHeight(drawer: HTMLDivElement): void {
  drawer.style.height = `${effectiveDrawerHeight()}px`;
  publishDrawerOffset();
}

/** Lift the toast stack above the drawer by publishing the drawer's height. */
function publishDrawerOffset(): void {
  const drawer = document.getElementById("bottom-drawer");
  const offset = drawer && !drawer.hidden ? drawer.offsetHeight : 0;
  document.documentElement.style.setProperty(
    "--bottom-drawer-offset",
    `${offset}px`,
  );
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

  initTransferFilter();
  restoreDrawerState();
}

function restoreDrawerState(): void {
  // Read every flag before opening: openDrawer rewrites them as it runs.
  const tab = readStored(DRAWER_TAB_KEY);
  const wasOpen = readStored(DRAWER_OPEN_KEY) === "true";
  const wasMinimized = readStored(DRAWER_MINIMIZED_KEY) === "true";
  if (tab === "activity" || tab === "transfers") {
    currentTab = tab;
  }
  if (wasOpen) {
    openDrawer(currentTab);
    if (wasMinimized) setMinimized(true);
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
  persistDrawerState();
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
  persistDrawerState();

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

/** True only when the Activity panel's entries are on screen. */
export function isActivityPanelVisible(): boolean {
  return isDrawerOpen() && !minimized && currentTab === "activity";
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
  setMinimized(!minimized);
}

function setMinimized(next: boolean): void {
  const drawer = document.getElementById(
    "bottom-drawer",
  ) as HTMLDivElement | null;
  if (!drawer) return;

  const active = document.activeElement;
  const body = drawer.querySelector<HTMLElement>(".bottom-drawer__body");
  const handle = drawer.querySelector<HTMLElement>(
    ".bottom-drawer__resize-handle",
  );

  minimized = next;
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
  persistDrawerState();
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
  persistDrawerState();
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
    btn.textContent = TRANSFER_TEXT.clearCompleted;
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

/**
 * Filter the transfer rows. The filter lives on the list element as a data
 * attribute so that re-rendering rows never resets it.
 */
export function setTransferFilter(filter: TransferFilter): void {
  transferFilter = filter;
  const list = document.getElementById("transfer-list");
  if (list) list.dataset.filter = filter;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-transfer-filter]",
  )) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.transferFilter === filter),
    );
  }
  updateFilterEmpty();
}

function rowMatchesFilter(row: HTMLElement, filter: TransferFilter): boolean {
  const statuses = FILTER_STATUSES[filter];
  return statuses === null || statuses.includes(row.dataset.status ?? "");
}

function updateFilterEmpty(): void {
  const empty = document.getElementById("transfer-filter-empty");
  const list = document.getElementById("transfer-list");
  if (!empty || !list) return;
  if (transferFilter === "all") {
    empty.hidden = true;
    return;
  }
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".transfer-item"));
  const anyVisible = rows.some((row) => rowMatchesFilter(row, transferFilter));
  empty.hidden = anyVisible || rows.length === 0;
  if (!empty.hidden) {
    empty.textContent = FILTER_EMPTY_TEXT[transferFilter];
  }
}

function initTransferFilter(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-transfer-filter]",
  )) {
    button.addEventListener("click", () => {
      setTransferFilter(button.dataset.transferFilter as TransferFilter);
    });
  }
  const list = document.getElementById("transfer-list");
  if (list) {
    // Rows arrive through the queue's render path; keep the empty message in
    // step with whatever rows are present.
    new MutationObserver(updateFilterEmpty).observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-status"],
    });
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const current = (event.target as HTMLElement).closest<HTMLElement>(
        ".transfer-item",
      );
      if (!current) return;
      const rows = Array.from(
        list.querySelectorAll<HTMLElement>(".transfer-item"),
      ).filter((row) => !row.hidden && rowIsVisible(row));
      const index = rows.indexOf(current);
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
  }
  setTransferFilter(transferFilter);
}

/** A row hidden by the active filter is skipped by arrow-key movement. */
function rowIsVisible(row: HTMLElement): boolean {
  return rowMatchesFilter(row, transferFilter);
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
