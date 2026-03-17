import { escapeHtml } from "./utils.ts";

export type ActivityType = "info" | "success" | "error" | "warning";

interface ActivityEntry {
  time: Date;
  message: string;
  type: ActivityType;
}

const MAX_ENTRIES = 200;
let entries: ActivityEntry[] = [];
let visible = false;

export function logActivity(
  message: string,
  type: ActivityType = "info",
): void {
  entries.push({ time: new Date(), message, type });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  updateBadge();
  if (visible) renderActivityLog();
}

export function toggleActivityLog(): void {
  const overlay = document.getElementById("activity-overlay");
  if (!overlay) return;
  const nextVisible = overlay.hidden;
  overlay.hidden = !nextVisible;
  visible = nextVisible;
  if (visible) renderActivityLog();
}

export function hideActivityLog(): void {
  const overlay = document.getElementById("activity-overlay");
  if (overlay) overlay.hidden = true;
  visible = false;
}

export function clearActivityLog(): void {
  entries = [];
  updateBadge();
  if (visible) renderActivityLog();
}

function renderActivityLog(): void {
  const list = document.getElementById("activity-list");
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML = `<div class="activity-empty">No activity yet</div>`;
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
  if (!badge) return;
  badge.textContent = entries.length > 0 ? String(entries.length) : "";
  badge.style.display = entries.length > 0 ? "" : "none";
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
      return "&#10003;";
    case "error":
      return "&#10007;";
    case "warning":
      return "&#9888;";
    default:
      return "&#8226;";
  }
}
