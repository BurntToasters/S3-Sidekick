import { escapeHtml, getIconHtml } from "./utils.ts";
import { isActivityPanelVisible, toggleDrawer } from "./bottom-drawer.ts";

export type ActivityType = "info" | "success" | "error" | "warning";

interface ActivityEntry {
  seq: number;
  time: Date;
  message: string;
  type: ActivityType;
}

const MAX_ENTRIES = 200;
let entries: ActivityEntry[] = [];
let renderScheduled = false;
let unseenCount = 0;
let nextSeq = 1;
/** Sequence number of the newest entry already appended to the list. */
let renderedSeq = 0;

export function logActivity(
  message: string,
  type: ActivityType = "info",
): void {
  const capped = message.length > 5000 ? message.slice(0, 5000) + "…" : message;
  entries.push({ seq: nextSeq++, time: new Date(), message: capped, type });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  // Entries written while the user is reading the Activity tab are already
  // seen; counting them would leave a badge that never clears.
  if (!isActivityPanelVisible()) unseenCount++;
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

/**
 * Append only the entries the list has not shown yet. Rebuilding the whole
 * list would make a screen reader re-announce rows it already read.
 */
function renderActivityLog(): void {
  const list = document.getElementById("activity-list");
  if (!list) return;

  if (entries.length === 0) {
    renderedSeq = 0;
    list.innerHTML =
      `<div class="activity-empty">` +
      `${getIconHtml("clipboard-list", { className: "lucide-icon empty-state__icon", decorative: true })}` +
      `<span>No activity yet</span>` +
      `</div>`;
    return;
  }

  const fresh = entries.filter((entry) => entry.seq > renderedSeq);
  if (fresh.length === 0) return;

  if (list.querySelector(":scope > .activity-empty")) list.replaceChildren();
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;

  list.insertAdjacentHTML("beforeend", fresh.map(entryHtml).join(""));
  renderedSeq = entries[entries.length - 1].seq;

  // Drop rows that fell out of the retained history so the DOM stays bounded.
  while (list.children.length > MAX_ENTRIES) {
    list.firstElementChild?.remove();
  }
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function entryHtml(entry: ActivityEntry): string {
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
      return getIconHtml("check-circle", {
        className: "lucide-icon activity-icon-svg",
        decorative: true,
      });
    case "error":
      return getIconHtml("alert-circle", {
        className: "lucide-icon activity-icon-svg",
        decorative: true,
      });
    case "warning":
      return getIconHtml("alert-triangle", {
        className: "lucide-icon activity-icon-svg",
        decorative: true,
      });
    default:
      return getIconHtml("info", {
        className: "lucide-icon activity-icon-svg",
        decorative: true,
      });
  }
}
