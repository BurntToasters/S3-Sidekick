import { invoke } from "@tauri-apps/api/core";
import { $, escapeHtml } from "./utils.ts";
import { state } from "./state.ts";

export interface TransferItem {
  id: number;
  fileName: string;
  filePath: string;
  browserFile?: File;
  key: string;
  size: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

let nextId = 1;
let queue: TransferItem[] = [];
let processing = false;
let onComplete: (() => void) | null = null;
let collapsed = false;

export function initTransferQueueUI(): void {
  syncTransferVisibility();
  syncCollapseState();
  updateBadge();
  updateClearButton();
}

export function setTransferCompleteHandler(handler: () => void): void {
  onComplete = handler;
}

export function showTransferQueue(): void {
  if (queue.length === 0) return;
  $("transfer-overlay").hidden = false;
  syncCollapseState();
  renderQueue();
}

export function hideTransferQueue(): void {
  $("transfer-overlay").hidden = true;
}

export function toggleTransferQueue(): void {
  if (queue.length === 0) return;
  const overlay = $("transfer-overlay");
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) {
    syncCollapseState();
    renderQueue();
  }
}

export function toggleTransferCollapsed(): void {
  const overlay = $("transfer-overlay");
  if (overlay.hidden) return;
  collapsed = !collapsed;
  syncCollapseState();
}

export function clearCompletedTransfers(): void {
  queue = queue.filter(
    (t) => t.status === "queued" || t.status === "uploading",
  );
  renderQueue();
}

export function enqueueFiles(
  files: FileList | File[],
  targetPrefix: string,
): void {
  for (const file of Array.from(files)) {
    const filePath =
      typeof (file as { path?: unknown }).path === "string"
        ? ((file as { path?: string }).path ?? "")
        : "";
    const key = targetPrefix + file.name;
    queue.push({
      id: nextId++,
      fileName: file.name,
      filePath,
      browserFile: file,
      key,
      size: file.size,
      status: "queued",
    });
  }

  showTransferQueue();
  processQueue();
}

export function enqueuePaths(paths: string[], targetPrefix: string): void {
  for (const filePath of paths) {
    const parts = filePath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1];
    const key = targetPrefix + fileName;
    queue.push({
      id: nextId++,
      fileName,
      filePath,
      key,
      size: 0,
      status: "queued",
    });
  }

  showTransferQueue();
  processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  let completedThisRun = false;

  while (true) {
    const item = queue.find((t) => t.status === "queued");
    if (!item) break;

    item.status = "uploading";
    renderQueue();

    try {
      const contentType = guessContentType(item.fileName);
      if (item.filePath) {
        await invoke("upload_object", {
          bucket: state.currentBucket,
          key: item.key,
          filePath: item.filePath,
          contentType,
        });
      } else if (item.browserFile) {
        const bytes = Array.from(
          new Uint8Array(await item.browserFile.arrayBuffer()),
        );
        await invoke("upload_object_bytes", {
          bucket: state.currentBucket,
          key: item.key,
          bytes,
          contentType,
        });
        item.browserFile = undefined;
      } else {
        throw new Error("No upload source available for transfer item.");
      }
      item.status = "done";
      completedThisRun = true;
    } catch (err) {
      item.status = "error";
      item.error = String(err);
    }
    renderQueue();
  }

  processing = false;

  if (onComplete && completedThisRun) {
    onComplete();
  }
}

function renderQueue(): void {
  const list = document.getElementById("transfer-list");
  if (!list) return;

  if (queue.length === 0) {
    list.innerHTML = `<div class="transfer-empty">No transfers</div>`;
    updateBadge();
    updateClearButton();
    syncTransferVisibility();
    return;
  }

  list.innerHTML = queue
    .map((t) => {
      let statusIcon = "";
      let statusClass = "";
      if (t.status === "queued") {
        statusIcon = "&#9711;";
        statusClass = "transfer-status--queued";
      } else if (t.status === "uploading") {
        statusIcon = "&#8635;";
        statusClass = "transfer-status--active";
      } else if (t.status === "done") {
        statusIcon = "&#10003;";
        statusClass = "transfer-status--done";
      } else {
        statusIcon = "&#10007;";
        statusClass = "transfer-status--error";
      }

      return (
        `<div class="transfer-item" data-id="${t.id}">` +
        `<span class="transfer-status ${statusClass}">${statusIcon}</span>` +
        `<span class="transfer-name">${escapeHtml(t.fileName)}</span>` +
        `<span class="transfer-arrow">&rarr;</span>` +
        `<span class="transfer-key">${escapeHtml(t.key)}</span>` +
        (t.status === "error"
          ? `<span class="transfer-error" title="${escapeHtml(t.error || "")}">${escapeHtml(t.error || "Error")}</span>`
          : "") +
        `</div>`
      );
    })
    .join("");

  updateBadge();
  updateClearButton();
  syncTransferVisibility();
}

function updateBadge(): void {
  const active = queue.filter(
    (t) => t.status === "queued" || t.status === "uploading",
  ).length;
  const badge = document.getElementById("transfer-badge");
  if (badge) {
    badge.textContent = active > 0 ? String(active) : "";
    badge.style.display = active > 0 ? "" : "none";
  }
}

function updateClearButton(): void {
  const button = document.getElementById(
    "transfer-clear",
  ) as HTMLButtonElement | null;
  if (!button) return;
  const hasCompleted = queue.some(
    (t) => t.status === "done" || t.status === "error",
  );
  button.disabled = !hasCompleted;
}

function syncTransferVisibility(): void {
  const overlay = document.getElementById(
    "transfer-overlay",
  ) as HTMLDivElement | null;
  const toggle = document.getElementById(
    "transfer-toggle",
  ) as HTMLButtonElement | null;
  const shouldShow = queue.length > 0;

  if (toggle) {
    toggle.hidden = !shouldShow;
  }

  if (overlay && !shouldShow) {
    overlay.hidden = true;
  }
}

function syncCollapseState(): void {
  const overlay = document.getElementById("transfer-overlay");
  const collapseButton = document.getElementById(
    "transfer-collapse",
  ) as HTMLButtonElement | null;
  if (!overlay) return;

  overlay.classList.toggle("transfer-popup--collapsed", collapsed);
  if (!collapseButton) return;

  if (collapsed) {
    collapseButton.innerHTML = "&#9656;";
    collapseButton.title = "Expand transfers";
    collapseButton.setAttribute("aria-label", "Expand transfers");
    collapseButton.setAttribute("aria-expanded", "false");
  } else {
    collapseButton.innerHTML = "&#9660;";
    collapseButton.title = "Collapse transfers";
    collapseButton.setAttribute("aria-label", "Collapse transfers");
    collapseButton.setAttribute("aria-expanded", "true");
  }
}

function guessContentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  return map[ext] || "application/octet-stream";
}
