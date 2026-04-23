import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { escapeHtml, twemojiIcon } from "./utils.ts";
import { state } from "./state.ts";
import { logActivity } from "./activity-log.ts";
import {
  openDrawer,
  closeDrawer,
  isDrawerOpen,
  getActiveTab,
  toggleDrawer,
} from "./bottom-drawer.ts";
import { showConfirm } from "./dialogs.ts";

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
  status: "queued" | "uploading" | "done" | "error" | "skipped";
  error?: string;
  progress: number;
  totalBytes: number;
  attempt: number;
  maxAttempts: number;
  verified: boolean;
  conflictResolution: "ask" | "skip" | "replace";
  phase: "running" | "retry_wait" | "verifying";
  tempPath?: string;
}

export interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
  conflictResolution?: "ask" | "skip" | "replace";
  tempPath?: string;
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

interface PersistedTransferManifest {
  version: 1;
  items: PersistedTransferItem[];
}

interface PersistedTransferItem {
  operation: "upload" | "download";
  bucket: string;
  fileName: string;
  filePath: string;
  key: string;
  destination?: string;
  size: number;
  totalBytes: number;
  attempt: number;
  maxAttempts: number;
  conflictResolution: "ask" | "skip" | "replace";
  tempPath?: string;
}

interface HeadObjectSummary {
  content_length: number;
}

const BROWSER_UPLOAD_BYTES_LIMIT = 16 * 1024 * 1024;
const QUEUE_MANIFEST_KEY = "s3-sidekick.transfer-manifest.v1";
let nextId = 1;
let queue: TransferItem[] = [];
let processing = false;
let onComplete: ((summary: TransferRunSummary) => void) | null = null;
let progressUnlisten: UnlistenFn | null = null;
let downloadProgressUnlisten: UnlistenFn | null = null;
let renderQueued = false;
let cancelClickHandler: ((e: Event) => void) | null = null;
let recoveredQueue = false;
let conflictApplyAll: "skip" | "replace" | null = null;
let conflictPromptQueue: Promise<void> = Promise.resolve();

function resetConflictApplyAllWhenIdle(): void {
  const hasActive = queue.some(
    (item) => item.status === "queued" || item.status === "uploading",
  );
  if (!hasActive) {
    conflictApplyAll = null;
  }
}

function normalizeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function buildDownloadTempPath(destination: string): string {
  return `${destination}.s3-sidekick.download.tmp`;
}

function retryCountFromSettings(): number {
  const value = state.currentSettings.transferRetryAttempts;
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function retryBaseMsFromSettings(): number {
  const value = state.currentSettings.transferRetryBaseMs;
  if (!Number.isInteger(value) || value < 50) return 400;
  return value;
}

function maxAttemptsFromSettings(): number {
  return retryCountFromSettings() + 1;
}

function shouldRetryError(err: unknown): boolean {
  const text = normalizeError(err).toLowerCase();
  if (text.includes("cancelled") || text.includes("canceled")) return false;
  if (text.includes("invalid") || text.includes("forbidden")) return false;
  if (text.includes("access denied")) return false;

  const statusMatch = text.match(/\bhttp\s*(\d{3})\b/i);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    if (status === 429 || (status >= 500 && status <= 504)) {
      return true;
    }
    return false;
  }

  return (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("connection reset") ||
    text.includes("connection closed") ||
    text.includes("network") ||
    text.includes("temporar") ||
    text.includes("slowdown") ||
    text.includes("dispatch")
  );
}

function computeRetryDelayMs(attempt: number): number {
  const base = retryBaseMsFromSettings();
  const expo = Math.max(1, 2 ** (attempt - 1));
  const jitter = Math.floor(
    Math.random() * Math.max(1, Math.round(base * 0.4)),
  );
  return base * expo + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function serializeManifestItem(item: TransferItem): PersistedTransferItem {
  return {
    operation: item.operation,
    bucket: item.bucket,
    fileName: item.fileName,
    filePath: item.filePath,
    key: item.key,
    destination: item.destination,
    size: item.size,
    totalBytes: item.totalBytes,
    attempt: item.attempt,
    maxAttempts: item.maxAttempts,
    conflictResolution: item.conflictResolution,
    tempPath: item.tempPath,
  };
}

function writeQueueManifest(): void {
  try {
    const pending = queue.filter(
      (item) => item.status === "queued" || item.status === "uploading",
    );
    if (pending.length === 0) {
      localStorage.removeItem(QUEUE_MANIFEST_KEY);
      return;
    }

    const payload: PersistedTransferManifest = {
      version: 1,
      items: pending.map(serializeManifestItem),
    };
    localStorage.setItem(QUEUE_MANIFEST_KEY, JSON.stringify(payload));
  } catch {
    // best effort
  }
}

function clearQueueManifest(): void {
  try {
    localStorage.removeItem(QUEUE_MANIFEST_KEY);
  } catch {
    // best effort
  }
}

function parseQueueManifest(
  raw: string | null,
): PersistedTransferManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const version = (parsed as { version?: unknown }).version;
    const items = (parsed as { items?: unknown }).items;
    if (version !== 1 || !Array.isArray(items)) return null;

    const valid: PersistedTransferItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<PersistedTransferItem>;
      if (
        (row.operation !== "upload" && row.operation !== "download") ||
        typeof row.bucket !== "string" ||
        typeof row.fileName !== "string" ||
        typeof row.filePath !== "string" ||
        typeof row.key !== "string" ||
        typeof row.size !== "number" ||
        typeof row.totalBytes !== "number"
      ) {
        continue;
      }
      valid.push({
        operation: row.operation,
        bucket: row.bucket,
        fileName: row.fileName,
        filePath: row.filePath,
        key: row.key,
        destination:
          typeof row.destination === "string" ? row.destination : undefined,
        size: row.size,
        totalBytes: row.totalBytes,
        attempt:
          typeof row.attempt === "number" && Number.isInteger(row.attempt)
            ? Math.max(1, row.attempt)
            : 1,
        maxAttempts:
          typeof row.maxAttempts === "number" &&
          Number.isInteger(row.maxAttempts)
            ? Math.max(1, row.maxAttempts)
            : maxAttemptsFromSettings(),
        conflictResolution:
          row.conflictResolution === "replace"
            ? "replace"
            : row.conflictResolution === "skip"
              ? "skip"
              : "ask",
        tempPath: typeof row.tempPath === "string" ? row.tempPath : undefined,
      });
    }

    return { version: 1, items: valid };
  } catch {
    return null;
  }
}

async function cleanupRecoveredTempFiles(
  items: PersistedTransferItem[],
): Promise<void> {
  const cleanupTargets = items
    .filter((item) => item.operation === "download")
    .map((item) => item.tempPath)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  if (cleanupTargets.length === 0) return;

  await Promise.allSettled(
    cleanupTargets.map((path) => invoke("remove_path_if_exists", { path })),
  );
}

function restoreItemFromManifest(item: PersistedTransferItem): TransferItem {
  return {
    id: nextId++,
    operation: item.operation,
    bucket: item.bucket,
    fileName: item.fileName,
    filePath: item.filePath,
    key: item.key,
    destination: item.destination,
    size: item.size,
    status: "queued",
    progress: 0,
    totalBytes: item.totalBytes,
    attempt: 1,
    maxAttempts: Math.max(maxAttemptsFromSettings(), item.maxAttempts),
    verified: false,
    conflictResolution: item.conflictResolution,
    phase: "running",
    tempPath: item.tempPath,
  };
}

async function recoverPendingQueueIfNeeded(): Promise<void> {
  if (recoveredQueue) return;
  recoveredQueue = true;

  const manifest = parseQueueManifest(localStorage.getItem(QUEUE_MANIFEST_KEY));
  if (!manifest || manifest.items.length === 0) {
    clearQueueManifest();
    return;
  }

  if (!document.getElementById("dialog-overlay")) {
    clearQueueManifest();
    return;
  }

  await cleanupRecoveredTempFiles(manifest.items);

  const shouldResume = await showConfirm(
    "Resume Transfers",
    `Resume ${manifest.items.length} pending transfer(s) from last session?`,
    { okLabel: "Resume", cancelLabel: "Discard" },
  );

  if (!shouldResume) {
    clearQueueManifest();
    return;
  }

  for (const row of manifest.items) {
    queue.push(restoreItemFromManifest(row));
  }
  renderQueue();
  showTransferQueue();
  writeQueueManifest();

  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export async function initTransferQueueUI(): Promise<void> {
  syncTransferVisibility();
  updateBadge();

  await recoverPendingQueueIfNeeded();

  progressUnlisten ??= await listen<{
    transfer_id: number;
    bytes_sent: number;
    total_bytes: number;
    attempt?: number;
    phase?: "running" | "retry_wait" | "verifying";
  }>("upload-progress", (event) => {
    const { transfer_id, bytes_sent, total_bytes, attempt, phase } =
      event.payload;
    const item = queue.find((t) => t.id === transfer_id);
    if (item) {
      if (
        typeof attempt === "number" &&
        Number.isInteger(attempt) &&
        attempt > 0
      ) {
        item.attempt = Math.max(item.attempt, attempt);
      }
      if (
        phase === "running" ||
        phase === "retry_wait" ||
        phase === "verifying"
      ) {
        item.phase = phase;
      }
      item.progress = total_bytes > 0 ? (bytes_sent / total_bytes) * 100 : 0;
      item.totalBytes = total_bytes;
      queueRender();
      writeQueueManifest();
    }
  });

  downloadProgressUnlisten ??= await listen<{
    transfer_id: number;
    bytes_sent: number;
    total_bytes: number;
    attempt?: number;
    phase?: "running" | "retry_wait" | "verifying";
  }>("download-progress", (event) => {
    const { transfer_id, bytes_sent, total_bytes, attempt, phase } =
      event.payload;
    const item = queue.find((t) => t.id === transfer_id);
    if (item) {
      if (
        typeof attempt === "number" &&
        Number.isInteger(attempt) &&
        attempt > 0
      ) {
        item.attempt = Math.max(item.attempt, attempt);
      }
      if (
        phase === "running" ||
        phase === "retry_wait" ||
        phase === "verifying"
      ) {
        item.phase = phase;
      }
      item.progress = total_bytes > 0 ? (bytes_sent / total_bytes) * 100 : 0;
      item.totalBytes = total_bytes;
      queueRender();
      writeQueueManifest();
    }
  });

  const list = document.getElementById("transfer-list");
  if (list && !cancelClickHandler) {
    cancelClickHandler = (e: Event) => {
      const btn = (e.target as HTMLElement).closest(".transfer-cancel");
      if (!btn) return;
      const row = btn.closest(".transfer-item");
      if (!row) return;
      const id = Number((row as HTMLElement).dataset.id);
      if (!id) return;
      void cancelTransferItem(id);
    };
    list.addEventListener("click", cancelClickHandler);
  }
}

export function disposeTransferQueueUI(): void {
  if (progressUnlisten) {
    const unlisten = progressUnlisten;
    progressUnlisten = null;
    unlisten();
  }
  if (downloadProgressUnlisten) {
    const unlisten = downloadProgressUnlisten;
    downloadProgressUnlisten = null;
    unlisten();
  }
  if (cancelClickHandler) {
    const list = document.getElementById("transfer-list");
    if (list) list.removeEventListener("click", cancelClickHandler);
    cancelClickHandler = null;
  }
}

export function setTransferCompleteHandler(
  handler: (summary: TransferRunSummary) => void,
): void {
  onComplete = handler;
}

export function showTransferQueue(): void {
  if (queue.length === 0) return;
  openDrawer("transfers");
  renderQueue();
}

export function hideTransferQueue(): void {
  if (isDrawerOpen() && getActiveTab() === "transfers") {
    closeDrawer();
  }
}

export function toggleTransferQueue(): void {
  toggleDrawer("transfers");
}

export function clearCompletedTransfers(): void {
  queue = queue.filter(
    (item) => item.status === "queued" || item.status === "uploading",
  );
  renderQueue();
  writeQueueManifest();
  if (queue.length === 0) {
    hideTransferQueue();
  }
  resetConflictApplyAllWhenIdle();
}

export function enqueueFiles(
  files: FileList | File[],
  targetPrefix: string,
): void {
  const bucket = state.currentBucket;
  const allFiles = Array.from(files);
  const maxAttempts = maxAttemptsFromSettings();
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
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution: state.currentSettings.conflictPolicy,
      phase: "running",
    });
  }

  if (allFiles.length > 0) {
    logActivity(
      `Queued ${allFiles.length} upload(s) to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export function enqueuePaths(paths: string[], targetPrefix: string): void {
  const bucket = state.currentBucket;
  const maxAttempts = maxAttemptsFromSettings();
  for (const filePath of paths) {
    const normalizedPath = filePath.trim();
    const parts = normalizedPath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1] ?? "";
    const key = targetPrefix + fileName;
    queue.push({
      id: nextId++,
      operation: "upload",
      bucket,
      fileName,
      filePath: normalizedPath,
      key,
      size: 0,
      status: "queued",
      progress: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution: state.currentSettings.conflictPolicy,
      phase: "running",
    });
  }

  if (paths.length > 0) {
    logActivity(
      `Queued ${paths.length} upload(s) to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export function enqueueFolderEntries(
  entries: FolderUploadEntry[],
  targetPrefix: string,
): void {
  const bucket = state.currentBucket;
  const maxAttempts = maxAttemptsFromSettings();
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
      totalBytes: 0,
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution: state.currentSettings.conflictPolicy,
      phase: "running",
    });
  }

  if (entries.length > 0) {
    logActivity(
      `Queued ${entries.length} file(s) for folder upload to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export function enqueueDownloads(entries: DownloadQueueEntry[]): void {
  const maxAttempts = maxAttemptsFromSettings();
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
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution:
        entry.conflictResolution ?? state.currentSettings.conflictPolicy,
      phase: "running",
      tempPath: entry.tempPath ?? buildDownloadTempPath(entry.destination),
    });
  }

  if (entries.length > 0) {
    logActivity(`Queued ${entries.length} download(s).`, "info");
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

async function processQueue(): Promise<void> {
  if (processing) return;
  const maxConcurrent = state.currentSettings.maxConcurrentTransfers;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    writeQueueManifest();
    return;
  }

  processing = true;
  let completedUploadThisRun = false;
  let completedDownloadThisRun = false;

  const workers: Promise<void>[] = [];
  for (let i = 0; i < maxConcurrent; i += 1) {
    workers.push(runWorker());
  }

  function claimNextItem(): TransferItem | null {
    const item = queue.find((t) => t.status === "queued");
    if (item) {
      item.status = "uploading";
      item.phase = "running";
      item.error = undefined;
    }
    return item ?? null;
  }

  async function runWorker(): Promise<void> {
    while (true) {
      const item = claimNextItem();
      if (!item) break;

      renderQueue();
      writeQueueManifest();

      try {
        const completed = await runItemWithRetry(item);
        if (completed && item.operation === "download") {
          completedDownloadThisRun = true;
        }
        if (completed && item.operation === "upload") {
          completedUploadThisRun = true;
        }

        if (completed) {
          queue = queue.filter((t) => t.id !== item.id);
        }
      } catch (err) {
        item.status = "error";
        item.error = normalizeError(err);
        item.browserFile = undefined;
        const opLabel = item.operation === "download" ? "Download" : "Upload";
        logActivity(
          `${opLabel} failed for ${item.fileName}: ${normalizeError(err)}`,
          "error",
        );
      }

      renderQueue();
      writeQueueManifest();
    }
  }

  await Promise.all(workers);
  processing = false;
  resetConflictApplyAllWhenIdle();

  if (onComplete && (completedUploadThisRun || completedDownloadThisRun)) {
    onComplete({
      hadUpload: completedUploadThisRun,
      hadDownload: completedDownloadThisRun,
    });
  }
}

async function runItemWithRetry(item: TransferItem): Promise<boolean> {
  const maxAttempts = Math.max(1, item.maxAttempts, maxAttemptsFromSettings());
  item.maxAttempts = maxAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    item.attempt = attempt;
    item.phase = "running";
    queueRender();
    writeQueueManifest();

    try {
      const conflictDecision = await resolveConflict(item);
      item.conflictResolution = conflictDecision;

      if (conflictDecision === "skip") {
        item.status = "skipped";
        item.error = "Skipped (destination exists)";
        logActivity(
          `${item.operation === "download" ? "Download" : "Upload"} skipped for ${item.fileName}: destination exists.`,
          "warning",
        );
        return false;
      }

      await executeTransfer(item, attempt, conflictDecision === "replace");
      item.phase = "verifying";
      queueRender();

      if (item.operation === "upload") {
        await verifyUploadedObject(item);
      }

      item.progress = 100;
      item.verified = true;
      item.status = "done";

      if (item.operation === "download") {
        logActivity(`Downloaded ${item.fileName}.`, "success");
      } else {
        logActivity(`Uploaded ${item.fileName} to ${item.key}.`, "success");
      }
      return true;
    } catch (err) {
      if (attempt < maxAttempts && shouldRetryError(err)) {
        const waitMs = computeRetryDelayMs(attempt);
        item.phase = "retry_wait";
        item.error = `Retrying in ${waitMs}ms`;
        queueRender();
        logActivity(
          `${item.operation === "download" ? "Download" : "Upload"} retry ${attempt}/${maxAttempts - 1} for ${item.fileName} in ${waitMs}ms.`,
          "warning",
        );
        await delay(waitMs);
        continue;
      }
      throw err;
    }
  }

  return false;
}

async function executeTransfer(
  item: TransferItem,
  attempt: number,
  overwrite: boolean,
): Promise<void> {
  if (item.operation === "download") {
    if (!item.destination) {
      throw new Error("No destination available for download transfer.");
    }
    const size = await invoke<number>("download_object", {
      bucket: item.bucket,
      key: item.key,
      destination: item.destination,
      transferId: item.id,
      overwrite,
      tempPath: item.tempPath,
      attempt,
    });
    item.totalBytes = size;
    item.progress = 100;
    return;
  }

  const contentType = guessContentType(item.fileName);
  if (item.filePath) {
    await invoke("upload_object", {
      bucket: item.bucket,
      key: item.key,
      filePath: item.filePath,
      contentType,
      transferId: item.id,
      attempt,
    });
  } else if (item.browserFile) {
    if (item.browserFile.size > BROWSER_UPLOAD_BYTES_LIMIT) {
      throw new Error(
        `Browser upload fallback is limited to ${Math.floor(BROWSER_UPLOAD_BYTES_LIMIT / (1024 * 1024))}MB. ` +
          "Use file-path based upload for larger files.",
      );
    }
    const bytes = Array.from(
      new Uint8Array(await item.browserFile.arrayBuffer()),
    );
    await invoke("upload_object_bytes", {
      bucket: item.bucket,
      key: item.key,
      bytes,
      contentType,
      transferId: item.id,
      attempt,
    });
    item.browserFile = undefined;
  } else {
    throw new Error("No upload source available for transfer item.");
  }
}

async function verifyUploadedObject(item: TransferItem): Promise<void> {
  const expected = item.totalBytes > 0 ? item.totalBytes : 0;
  if (expected <= 0) return;

  const head = await invoke<HeadObjectSummary>("head_object", {
    bucket: item.bucket,
    key: item.key,
  });
  if (head.content_length !== expected) {
    throw new Error(
      `Verification failed: expected ${expected} bytes, found ${head.content_length} bytes in bucket.`,
    );
  }
}

function withConflictPromptLock<T>(work: () => Promise<T>): Promise<T> {
  const run = conflictPromptQueue.then(work, work);
  conflictPromptQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function resolveConflict(
  item: TransferItem,
): Promise<"ask" | "skip" | "replace"> {
  const conflictExists = await checkConflictExists(item);
  if (!conflictExists) return "replace";

  const effectivePolicy =
    item.conflictResolution === "replace" || item.conflictResolution === "skip"
      ? item.conflictResolution
      : state.currentSettings.conflictPolicy;

  if (effectivePolicy === "replace") return "replace";
  if (effectivePolicy === "skip") return "skip";

  if (conflictApplyAll) {
    return conflictApplyAll;
  }

  return withConflictPromptLock(async () => {
    if (conflictApplyAll) {
      return conflictApplyAll;
    }

    const target =
      item.operation === "download"
        ? (item.destination ?? item.fileName)
        : `${item.bucket}/${item.key}`;
    const replace = await showConfirm(
      "Transfer Conflict",
      `${target} already exists. Replace it?`,
      {
        okLabel: "Replace",
        cancelLabel: "Skip",
        okDanger: true,
      },
    );

    const decision: "skip" | "replace" = replace ? "replace" : "skip";

    const remaining = queue.filter(
      (entry) => entry.status === "queued" || entry.status === "uploading",
    ).length;
    if (remaining > 1) {
      const applyAll = await showConfirm(
        "Apply Choice",
        `Apply "${decision}" to remaining transfer conflicts in this batch?`,
        { okLabel: "Apply to all", cancelLabel: "This one only" },
      );
      if (applyAll) {
        conflictApplyAll = decision;
      }
    }

    return decision;
  });
}

async function checkConflictExists(item: TransferItem): Promise<boolean> {
  try {
    if (item.operation === "download") {
      if (!item.destination) return false;
      return invoke<boolean>("path_exists", { path: item.destination });
    }
    return invoke<boolean>("object_exists", {
      bucket: item.bucket,
      key: item.key,
    });
  } catch {
    return false;
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
    list.innerHTML =
      `<div class="transfer-empty">` +
      `<img class="twemoji-icon empty-state__icon" src="/twemoji/1f4e5.svg" alt="" aria-hidden="true" draggable="false" />` +
      `<span>No transfers</span>` +
      `</div>`;
    updateBadge();
    syncTransferVisibility();
    writeQueueManifest();
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
      } else if (t.status === "skipped") {
        statusIcon = twemojiIcon("23ed", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--queued";
      } else {
        statusIcon = twemojiIcon("274c", {
          className: "twemoji-icon twemoji-icon--transfer-status",
          decorative: true,
        });
        statusClass = "transfer-status--error";
      }

      const progressPct = Math.max(
        0,
        Math.min(100, Math.round(t.progress) || 0),
      );
      const progressBar =
        t.totalBytes > 0 &&
        (t.status === "uploading" || (t.status === "error" && t.progress > 0))
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

      const attemptLabel =
        t.maxAttempts > 1
          ? `<span class="transfer-attempt">Attempt ${t.attempt}/${t.maxAttempts}</span>`
          : "";

      const phaseLabel =
        t.status === "uploading"
          ? `<span class="transfer-phase">${
              t.phase === "retry_wait"
                ? "Retry wait"
                : t.phase === "verifying"
                  ? "Verifying"
                  : "Running"
            }</span>`
          : "";

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
        (attemptLabel || phaseLabel
          ? `<div class="transfer-meta">${attemptLabel}${phaseLabel}</div>`
          : "") +
        progressBar +
        (t.status === "error" || t.status === "skipped"
          ? `<span class="transfer-error" title="${escapeHtml(t.error ?? "")}">${escapeHtml(t.error ?? "Error")}</span>`
          : "") +
        `</div>` +
        (t.status === "queued" || t.status === "uploading"
          ? `<button class="transfer-cancel btn--ghost" title="Cancel" aria-label="Cancel transfer">&times;</button>`
          : "") +
        `</div>`
      );
    })
    .join("");

  updateBadge();
  syncTransferVisibility();
  writeQueueManifest();
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
  const drawerBadge = document.getElementById("drawer-transfer-badge");
  if (drawerBadge) {
    drawerBadge.textContent = active > 0 ? String(active) : "";
    drawerBadge.style.display = active > 0 ? "" : "none";
  }
}

function syncTransferVisibility(): void {
  const toggle = document.getElementById(
    "transfer-toggle",
  ) as HTMLButtonElement | null;
  const shouldShow = queue.length > 0;

  if (toggle) {
    toggle.hidden = !shouldShow;
    if (!shouldShow) {
      toggle.setAttribute("aria-expanded", "false");
    }
  }
}

async function cancelTransferItem(id: number): Promise<void> {
  const item = queue.find((t) => t.id === id);
  if (!item) return;
  if (item.status === "queued") {
    item.status = "error";
    item.error = "Cancelled";
    renderQueue();
  } else if (item.status === "uploading") {
    try {
      await invoke("cancel_transfer", { transferId: id });
    } catch {
      // best effort
    }
  }
  writeQueueManifest();
}

function guessContentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
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
