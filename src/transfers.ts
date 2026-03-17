import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { $, escapeHtml, twemojiIcon } from "./utils.ts";
import { state } from "./state.ts";
import { logActivity } from "./activity-log.ts";

export interface TransferItem {
  id: number;
  operation: "upload" | "download";
  bucket: string;
  fileName: string;
  filePath: string;
  browserFile?: File;
  key: string;
  destination?: string;
  size: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
  progress: number;
  totalBytes: number;
}

export interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
}

export interface FolderUploadEntry {
  file_path: string;
  relative_path: string;
  size: number;
}

export interface TransferRunSummary {
  hadUpload: boolean;
  hadDownload: boolean;
}

const MAX_CONCURRENT = 3;
let nextId = 1;
let queue: TransferItem[] = [];
let processing = false;
let onComplete: ((summary: TransferRunSummary) => void) | null = null;
let collapsed = false;
let progressUnlisten: UnlistenFn | null = null;
let renderQueued = false;

export async function initTransferQueueUI(): Promise<void> {
  syncTransferVisibility();
  syncCollapseState();
  updateBadge();
  updateClearButton();

  if (!progressUnlisten) {
    progressUnlisten = await listen<{
      transfer_id: number;
      bytes_sent: number;
      total_bytes: number;
    }>("upload-progress", (event) => {
      const { transfer_id, bytes_sent, total_bytes } = event.payload;
      const item = queue.find((t) => t.id === transfer_id);
      if (item) {
        item.progress = total_bytes > 0 ? (bytes_sent / total_bytes) * 100 : 0;
        item.totalBytes = total_bytes;
        queueRender();
      }
    });
  }
}

export async function disposeTransferQueueUI(): Promise<void> {
  if (progressUnlisten) {
    const unlisten = progressUnlisten;
    progressUnlisten = null;
    await unlisten();
  }
}

export function setTransferCompleteHandler(
  handler: (summary: TransferRunSummary) => void,
): void {
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
  const bucket = state.currentBucket;
  const allFiles = Array.from(files);
  for (const file of allFiles) {
    const filePath =
      typeof (file as { path?: unknown }).path === "string"
        ? ((file as { path?: string }).path ?? "")
        : "";
    const key = targetPrefix + file.name;
    queue.push({
      id: nextId++,
      operation: "upload",
      bucket,
      fileName: file.name,
      filePath,
      browserFile: file,
      key,
      size: file.size,
      status: "queued",
      progress: 0,
      totalBytes: file.size,
    });
  }

  if (allFiles.length > 0) {
    logActivity(
      `Queued ${allFiles.length} upload(s) to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  showTransferQueue();
  processQueue();
}

export function enqueuePaths(paths: string[], targetPrefix: string): void {
  const bucket = state.currentBucket;
  for (const filePath of paths) {
    const parts = filePath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1];
    const key = targetPrefix + fileName;
    queue.push({
      id: nextId++,
      operation: "upload",
      bucket,
      fileName,
      filePath,
      key,
      size: 0,
      status: "queued",
      progress: 0,
      totalBytes: 0,
    });
  }

  if (paths.length > 0) {
    logActivity(
      `Queued ${paths.length} upload(s) to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  showTransferQueue();
  processQueue();
}

export function enqueueFolderEntries(
  entries: FolderUploadEntry[],
  targetPrefix: string,
): void {
  const bucket = state.currentBucket;
  for (const entry of entries) {
    const rel = entry.relative_path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) continue;
    const segments = rel.split("/");
    const fileName = segments[segments.length - 1];
    queue.push({
      id: nextId++,
      operation: "upload",
      bucket,
      fileName,
      filePath: entry.file_path,
      key: targetPrefix + rel,
      size: entry.size,
      status: "queued",
      progress: 0,
      totalBytes: entry.size,
    });
  }

  if (entries.length > 0) {
    logActivity(
      `Queued ${entries.length} file(s) for folder upload to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  showTransferQueue();
  processQueue();
}

export function enqueueDownloads(entries: DownloadQueueEntry[]): void {
  for (const entry of entries) {
    const parts = entry.key.split("/");
    const fileName = parts[parts.length - 1] || entry.key;
    queue.push({
      id: nextId++,
      operation: "download",
      bucket: entry.bucket,
      fileName,
      filePath: "",
      key: entry.key,
      destination: entry.destination,
      size: 0,
      status: "queued",
      progress: 0,
      totalBytes: 0,
    });
  }

  if (entries.length > 0) {
    logActivity(`Queued ${entries.length} download(s).`, "info");
  }

  showTransferQueue();
  processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  let completedUploadThisRun = false;
  let completedDownloadThisRun = false;

  const workers: Promise<void>[] = [];
  for (let i = 0; i < MAX_CONCURRENT; i++) {
    workers.push(runWorker());
  }

  async function runWorker() {
    while (true) {
      const item = queue.find((t) => t.status === "queued");
      if (!item) break;

      item.status = "uploading";
      renderQueue();

      try {
        if (item.operation === "download") {
          if (!item.destination) {
            throw new Error("No destination available for download transfer.");
          }
          const size = await invoke<number>("download_object", {
            bucket: item.bucket,
            key: item.key,
            destination: item.destination,
          });
          item.totalBytes = size;
          item.progress = 100;
          completedDownloadThisRun = true;
          logActivity(`Downloaded ${item.fileName}.`, "success");
        } else {
          const contentType = guessContentType(item.fileName);
          if (item.filePath) {
            await invoke("upload_object", {
              bucket: item.bucket,
              key: item.key,
              filePath: item.filePath,
              contentType,
              transferId: item.id,
            });
          } else if (item.browserFile) {
            const bytes = Array.from(
              new Uint8Array(await item.browserFile.arrayBuffer()),
            );
            await invoke("upload_object_bytes", {
              bucket: item.bucket,
              key: item.key,
              bytes,
              contentType,
              transferId: item.id,
            });
            item.browserFile = undefined;
          } else {
            throw new Error("No upload source available for transfer item.");
          }
          item.progress = 100;
          completedUploadThisRun = true;
          logActivity(`Uploaded ${item.fileName} to ${item.key}.`, "success");
        }

        item.status = "done";
      } catch (err) {
        item.status = "error";
        item.error = String(err);
        const opLabel = item.operation === "download" ? "Download" : "Upload";
        logActivity(
          `${opLabel} failed for ${item.fileName}: ${String(err)}`,
          "error",
        );
      }
      renderQueue();
    }
  }

  await Promise.all(workers);
  processing = false;

  if (onComplete && (completedUploadThisRun || completedDownloadThisRun)) {
    onComplete({
      hadUpload: completedUploadThisRun,
      hadDownload: completedDownloadThisRun,
    });
  }
}

function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  const scheduler =
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 16);
  scheduler(() => {
    renderQueued = false;
    renderQueue();
  });
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
        statusIcon = twemojiIcon("23f3", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--queued";
      } else if (t.status === "uploading") {
        statusIcon = twemojiIcon("1f504", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--active";
      } else if (t.status === "done") {
        statusIcon = twemojiIcon("2705", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--done";
      } else {
        statusIcon = twemojiIcon("274c", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--error";
      }

      const progressPct = Math.max(0, Math.min(100, Math.round(t.progress)));
      const progressBar =
        t.totalBytes > 0 &&
        (t.status === "uploading" ||
          t.status === "done" ||
          (t.status === "error" && t.progress > 0))
          ? `<div class="transfer-progress-wrap">` +
            `<div class="transfer-progress"><div class="transfer-progress__bar" style="width:${progressPct}%"></div></div>` +
            `<span class="transfer-progress__label">${progressPct}%</span>` +
            `</div>`
          : "";
      const target = t.operation === "download" ? (t.destination ?? "") : t.key;
      const arrow =
        t.operation === "download"
          ? twemojiIcon("2b05", {
              className: "twemoji-icon twemoji-icon--transfer-arrow",
              decorative: true,
            })
          : twemojiIcon("27a1", {
              className: "twemoji-icon twemoji-icon--transfer-arrow",
              decorative: true,
            });

      return (
        `<div class="transfer-item" data-id="${t.id}">` +
        `<span class="transfer-status ${statusClass}">${statusIcon}</span>` +
        `<div class="transfer-main">` +
        `<div class="transfer-main__row">` +
        `<span class="transfer-name">${escapeHtml(t.fileName)}</span>` +
        (t.status !== "uploading" || t.operation === "download"
          ? `<span class="transfer-arrow">${arrow}</span>` +
            `<span class="transfer-key">${escapeHtml(target)}</span>`
          : "") +
        `</div>` +
        progressBar +
        (t.status === "error"
          ? `<span class="transfer-error" title="${escapeHtml(t.error || "")}">${escapeHtml(t.error || "Error")}</span>`
          : "") +
        `</div>` +
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
    collapseButton.innerHTML = twemojiIcon("27a1", {
      className: "twemoji-icon",
      decorative: true,
    });
    collapseButton.title = "Expand transfers";
    collapseButton.setAttribute("aria-label", "Expand transfers");
    collapseButton.setAttribute("aria-expanded", "false");
  } else {
    collapseButton.innerHTML = twemojiIcon("2b07", {
      className: "twemoji-icon",
      decorative: true,
    });
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
