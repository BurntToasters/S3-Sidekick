import { invoke } from "@tauri-apps/api/core";
import { $ } from "./utils.ts";
import { state } from "./state.ts";

export interface TransferItem {
  id: number;
  fileName: string;
  filePath: string;
  key: string;
  size: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

let nextId = 1;
let queue: TransferItem[] = [];
let processing = false;
let onComplete: (() => void) | null = null;

export function setTransferCompleteHandler(handler: () => void): void {
  onComplete = handler;
}

export function showTransferQueue(): void {
  $("transfer-overlay").hidden = false;
  renderQueue();
}

export function hideTransferQueue(): void {
  $("transfer-overlay").hidden = true;
}

export function toggleTransferQueue(): void {
  const overlay = $("transfer-overlay");
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) renderQueue();
}

export function clearCompletedTransfers(): void {
  queue = queue.filter((t) => t.status === "queued" || t.status === "uploading");
  renderQueue();
}

export function enqueueFiles(files: FileList | File[], targetPrefix: string): void {
  for (const file of Array.from(files)) {
    const key = targetPrefix + file.name;
    queue.push({
      id: nextId++,
      fileName: file.name,
      filePath: (file as any).path || "",
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

  while (true) {
    const item = queue.find((t) => t.status === "queued");
    if (!item) break;

    item.status = "uploading";
    renderQueue();

    try {
      const contentType = guessContentType(item.fileName);
      await invoke("upload_object", {
        bucket: state.currentBucket,
        key: item.key,
        filePath: item.filePath,
        contentType,
      });
      item.status = "done";
    } catch (err) {
      item.status = "error";
      item.error = String(err);
    }
    renderQueue();
  }

  processing = false;

  if (onComplete) {
    onComplete();
  }
}

function renderQueue(): void {
  const list = document.getElementById("transfer-list");
  if (!list) return;

  if (queue.length === 0) {
    list.innerHTML = `<div class="transfer-empty">No transfers</div>`;
    updateBadge();
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
        `<span class="transfer-name">${escapeForDisplay(t.fileName)}</span>` +
        `<span class="transfer-arrow">&rarr;</span>` +
        `<span class="transfer-key">${escapeForDisplay(t.key)}</span>` +
        (t.status === "error" ? `<span class="transfer-error" title="${escapeForDisplay(t.error || "")}">${escapeForDisplay(t.error || "Error")}</span>` : "") +
        `</div>`
      );
    })
    .join("");

  updateBadge();
}

function updateBadge(): void {
  const active = queue.filter((t) => t.status === "queued" || t.status === "uploading").length;
  const badge = document.getElementById("transfer-badge");
  if (badge) {
    badge.textContent = active > 0 ? String(active) : "";
    badge.style.display = active > 0 ? "" : "none";
  }
}

function escapeForDisplay(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
