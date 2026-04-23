import { escapeHtml, twemojiIcon } from "./utils.ts";
import {
  toggleDrawer,
  openDrawer,
  closeDrawer,
  isDrawerOpen,
  getActiveTab,
} from "./bottom-drawer.ts";

export type ActivityType = "info" | "success" | "error" | "warning";

interface ActivityEntry {
  time: Date;
  message: string;
  type: ActivityType;
}

const MAX_ENTRIES = 200;
let entries: ActivityEntry[] = [];
let renderScheduled = false;
let unseenCount = 0;

export function logActivity(
  message: string,
  type: ActivityType = "info",
): void {
  const capped = message.length > 5000 ? message.slice(0, 5000) + "…" : message;
  entries.push({ time: new Date(), message: capped, type });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  unseenCount++;
  updateBadge();
  if (!renderScheduled) {
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      renderActivityLog();
    });
  }
}

export function toggleActivityLog(): void {
  toggleDrawer("activity");
}

export function hideActivityLog(): void {
  if (isDrawerOpen() && getActiveTab() === "activity") {
    closeDrawer();
  }
}

export function showActivityLog(): void {
  openDrawer("activity");
}

export function clearActivityLog(): void {
  entries = [];
  unseenCount = 0;
  renderScheduled = false;
  updateBadge();
  renderActivityLog();
}

export function markActivitySeen(): void {
  unseenCount = 0;
  updateBadge();
}

export function exportActivityLogText(): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => {
      const iso = entry.time.toISOString();
      return `[${iso}] [${entry.type.toUpperCase()}] ${entry.message}`;
    })
    .join("\n");
}

function renderActivityLog(): void {
  const list = document.getElementById("activity-list");
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML =
      `<div class="activity-empty">` +
      `<img class="twemoji-icon empty-state__icon" src="/twemoji/1f4cb.svg" alt="" aria-hidden="true" draggable="false" />` +
      `<span>No activity yet</span>` +
      `</div>`;
    return;
  }

  list.innerHTML = entries
    .slice()
    .reverse()
    .map((entry) => {
      const timeStr = formatTime(entry.time);
      const icon = typeIcon(entry.type);
      const iconClass = `activity-icon activity-icon--${entry.type}`;
      return (
        `<div class="activity-entry">` +
        `<span class="activity-time">${timeStr}</span>` +
        `<span class="${iconClass}">${icon}</span>` +
        `<span class="activity-msg">${escapeHtml(entry.message)}</span>` +
        `</div>`
      );
    })
    .join("");
}

function updateBadge(): void {
  const badge = document.getElementById("activity-badge");
  if (badge) {
    badge.textContent = unseenCount > 0 ? String(unseenCount) : "";
    badge.style.display = unseenCount > 0 ? "" : "none";
  }
  const drawerBadge = document.getElementById("drawer-activity-badge");
  if (drawerBadge) {
    drawerBadge.textContent = unseenCount > 0 ? String(unseenCount) : "";
    drawerBadge.style.display = unseenCount > 0 ? "" : "none";
  }
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function typeIcon(type: ActivityType): string {
  switch (type) {
    case "success":
      return twemojiIcon("2705", {
        className: "twemoji-icon twemoji-icon--activity-status",
        decorative: true,
      });
    case "error":
      return twemojiIcon("274c", {
        className: "twemoji-icon twemoji-icon--activity-status",
        decorative: true,
      });
    case "warning":
      return twemojiIcon("26a0", {
        className: "twemoji-icon twemoji-icon--activity-status",
        decorative: true,
      });
    default:
      return twemojiIcon("2139", {
        className: "twemoji-icon twemoji-icon--activity-status",
        decorative: true,
      });
  }
}
