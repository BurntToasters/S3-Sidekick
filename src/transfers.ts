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
  operation: "upload" | "download" | "copy" | "move";
  bucket: string;
  fileName: string;
  filePath: string;
  browserFile?: File;
  key: string;
  destination?: string;
  sourceBucket?: string;
  sourceKey?: string;
  sourcePrefix?: string;
  destinationBucket?: string;
  destinationKey?: string;
  destinationPrefix?: string;
  size: number;
  status: "queued" | "uploading" | "done" | "error" | "skipped";
  error?: string;
  progress: number;
  totalBytes: number;
  attempt: number;
  maxAttempts: number;
  verified: boolean;
  conflictResolution: "ask" | "skip" | "replace";
  phase:
    | "running"
    | "retry_wait"
    | "verifying"
    | "paused"
    | "resuming"
    | "finalizing";
  tempPath?: string;
  speedBps: number;
  etaSeconds: number | null;
  paused: boolean;
  resumable: boolean;
  checkpointId?: string;
  completedParts: number;
  totalParts: number;
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

export interface CopyMoveQueueEntry {
  operation: "copy" | "move";
  sourceBucket: string;
  fileName: string;
  sourceKey?: string;
  sourcePrefix?: string;
  destinationBucket: string;
  destinationKey?: string;
  destinationPrefix?: string;
  conflictResolution?: "ask" | "skip" | "replace";
}

export interface TransferRunSummary {
  hadUpload: boolean;
  hadDownload: boolean;
}

interface PersistedTransferManifest {
  version: 2;
  items: PersistedTransferItem[];
}

interface PersistedTransferItem {
  operation: "upload" | "download" | "copy" | "move";
  bucket: string;
  fileName: string;
  filePath: string;
  key: string;
  destination?: string;
  sourceBucket?: string;
  sourceKey?: string;
  sourcePrefix?: string;
  destinationBucket?: string;
  destinationKey?: string;
  destinationPrefix?: string;
  size: number;
  totalBytes: number;
  attempt: number;
  maxAttempts: number;
  conflictResolution: "ask" | "skip" | "replace";
  tempPath?: string;
  paused?: boolean;
  resumable?: boolean;
  checkpointId?: string;
  completedParts?: number;
  totalParts?: number;
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
let selectedTransferId: number | null = null;
let queuePaused = false;

interface EffectiveTransferSettings {
  downloadParallelThresholdMb: number;
  downloadPartSizeMb: number;
  downloadPartConcurrency: number;
  uploadPartSizeMb: number;
  uploadPartConcurrency: number;
  enableTransferResume: boolean;
  transferCheckpointTtlHours: number;
  bandwidthLimitMbps: number;
}

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

function buildCheckpointId(item: Pick<TransferItem, "operation" | "bucket" | "key" | "destination">): string {
  const seed = `${item.operation}:${item.bucket}:${item.key}:${item.destination ?? ""}`;
  return btoa(unescape(encodeURIComponent(seed))).replace(/=+$/g, "");
}

function getEffectiveTransferSettings(): EffectiveTransferSettings {
  const preset = state.currentSettings.transferPerformancePreset;
  const fromPreset =
    preset === "safe"
      ? {
          downloadParallelThresholdMb: 256,
          downloadPartSizeMb: 16,
          downloadPartConcurrency: 2,
          uploadPartSizeMb: 16,
          uploadPartConcurrency: 2,
        }
      : preset === "max"
        ? {
            downloadParallelThresholdMb: 64,
            downloadPartSizeMb: 64,
            downloadPartConcurrency: 10,
            uploadPartSizeMb: 64,
            uploadPartConcurrency: 10,
          }
        : {
            downloadParallelThresholdMb: 128,
            downloadPartSizeMb: 32,
            downloadPartConcurrency: 6,
            uploadPartSizeMb: 32,
            uploadPartConcurrency: 6,
          };

  return {
    downloadParallelThresholdMb:
      state.currentSettings.downloadParallelThresholdMb ||
      fromPreset.downloadParallelThresholdMb,
    downloadPartSizeMb:
      state.currentSettings.downloadPartSizeMb || fromPreset.downloadPartSizeMb,
    downloadPartConcurrency:
      state.currentSettings.downloadPartConcurrency ||
      fromPreset.downloadPartConcurrency,
    uploadPartSizeMb:
      state.currentSettings.uploadPartSizeMb || fromPreset.uploadPartSizeMb,
    uploadPartConcurrency:
      state.currentSettings.uploadPartConcurrency ||
      fromPreset.uploadPartConcurrency,
    enableTransferResume: state.currentSettings.enableTransferResume,
    transferCheckpointTtlHours: state.currentSettings.transferCheckpointTtlHours,
    bandwidthLimitMbps: state.currentSettings.bandwidthLimitMbps,
  };
}

function formatSpeedBps(speedBps: number): string {
  if (!Number.isFinite(speedBps) || speedBps <= 0) return "";
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (speedBps >= gb) return `${(speedBps / gb).toFixed(2)} GB/s`;
  if (speedBps >= mb) return `${(speedBps / mb).toFixed(2)} MB/s`;
  if (speedBps >= kb) return `${(speedBps / kb).toFixed(1)} KB/s`;
  return `${Math.round(speedBps)} B/s`;
}

function formatEtaSeconds(etaSeconds: number | null): string {
  if (etaSeconds === null || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
    return "";
  }
  const total = Math.round(etaSeconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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
    sourceBucket: item.sourceBucket,
    sourceKey: item.sourceKey,
    sourcePrefix: item.sourcePrefix,
    destinationBucket: item.destinationBucket,
    destinationKey: item.destinationKey,
    destinationPrefix: item.destinationPrefix,
    size: item.size,
    totalBytes: item.totalBytes,
    attempt: item.attempt,
    maxAttempts: item.maxAttempts,
    conflictResolution: item.conflictResolution,
    tempPath: item.tempPath,
    paused: item.paused,
    resumable: item.resumable,
    checkpointId: item.checkpointId,
    completedParts: item.completedParts,
    totalParts: item.totalParts,
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
      version: 2,
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
    if ((version !== 1 && version !== 2) || !Array.isArray(items)) return null;

    const valid: PersistedTransferItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<PersistedTransferItem>;
      if (
        row.operation !== "upload" &&
        row.operation !== "download" &&
        row.operation !== "copy" &&
        row.operation !== "move" ||
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
        sourceBucket:
          typeof row.sourceBucket === "string" ? row.sourceBucket : undefined,
        sourceKey: typeof row.sourceKey === "string" ? row.sourceKey : undefined,
        sourcePrefix:
          typeof row.sourcePrefix === "string" ? row.sourcePrefix : undefined,
        destinationBucket:
          typeof row.destinationBucket === "string"
            ? row.destinationBucket
            : undefined,
        destinationKey:
          typeof row.destinationKey === "string"
            ? row.destinationKey
            : undefined,
        destinationPrefix:
          typeof row.destinationPrefix === "string"
            ? row.destinationPrefix
            : undefined,
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
        paused: row.paused === true,
        resumable: row.resumable === true,
        checkpointId:
          typeof row.checkpointId === "string" ? row.checkpointId : undefined,
        completedParts:
          typeof row.completedParts === "number" &&
          Number.isInteger(row.completedParts) &&
          row.completedParts >= 0
            ? row.completedParts
            : 0,
        totalParts:
          typeof row.totalParts === "number" &&
          Number.isInteger(row.totalParts) &&
          row.totalParts >= 0
            ? row.totalParts
            : 0,
      });
    }

    return { version: 2, items: valid };
  } catch {
    return null;
  }
}

async function cleanupRecoveredTempFiles(
  items: PersistedTransferItem[],
): Promise<void> {
  const cleanupTargets = items
    .filter((item) => item.operation === "download" && !item.resumable)
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
  const resumable = item.resumable === true;
  const checkpointId =
    typeof item.checkpointId === "string" && item.checkpointId.length > 0
      ? item.checkpointId
      : resumable
        ? buildCheckpointId({
            operation: item.operation,
            bucket: item.bucket,
            key: item.key,
            destination: item.destination,
          })
        : undefined;
  return {
    id: nextId++,
    operation: item.operation,
    bucket: item.bucket,
    fileName: item.fileName,
    filePath: item.filePath,
    key: item.key,
    destination: item.destination,
    sourceBucket: item.sourceBucket,
    sourceKey: item.sourceKey,
    sourcePrefix: item.sourcePrefix,
    destinationBucket: item.destinationBucket,
    destinationKey: item.destinationKey,
    destinationPrefix: item.destinationPrefix,
    size: item.size,
    status: "queued",
    progress: 0,
    totalBytes: item.totalBytes,
    attempt: 1,
    maxAttempts: Math.max(maxAttemptsFromSettings(), item.maxAttempts),
    verified: false,
    conflictResolution: item.conflictResolution,
    phase: item.paused ? "paused" : "running",
    tempPath: item.tempPath,
    speedBps: 0,
    etaSeconds: null,
    paused: item.paused === true,
    resumable,
    checkpointId,
    completedParts:
      typeof item.completedParts === "number" && item.completedParts > 0
        ? item.completedParts
        : 0,
    totalParts:
      typeof item.totalParts === "number" && item.totalParts > 0
        ? item.totalParts
        : 0,
  };
}

async function recoverPendingQueueIfNeeded(): Promise<void> {
  if (recoveredQueue) return;
  recoveredQueue = true;

  const effective = getEffectiveTransferSettings();
  await invoke("transfer_checkpoint_gc", {
    ttlHours: effective.transferCheckpointTtlHours,
  }).catch(() => undefined);

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
    await Promise.allSettled(
      manifest.items
        .map((row) => row.checkpointId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((checkpointId) =>
          invoke("transfer_checkpoint_remove", { checkpointId }),
        ),
    );
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

interface TransferProgressPayload {
  transfer_id: number;
  bytes_sent: number;
  total_bytes: number;
  attempt?: number;
  phase?:
    | "running"
    | "retry_wait"
    | "verifying"
    | "paused"
    | "resuming"
    | "finalizing";
  speed_bps?: number;
  eta_seconds?: number;
  completed_parts?: number;
  total_parts?: number;
  checkpoint_id?: string;
  resumable?: boolean;
}

function applyProgressPayload(payload: TransferProgressPayload): void {
  const item = queue.find((t) => t.id === payload.transfer_id);
  if (!item) return;
  if (
    typeof payload.attempt === "number" &&
    Number.isInteger(payload.attempt) &&
    payload.attempt > 0
  ) {
    item.attempt = Math.max(item.attempt, payload.attempt);
  }
  if (
    payload.phase === "running" ||
    payload.phase === "retry_wait" ||
    payload.phase === "verifying" ||
    payload.phase === "paused" ||
    payload.phase === "resuming" ||
    payload.phase === "finalizing"
  ) {
    item.phase = payload.phase;
  }
  item.progress =
    payload.total_bytes > 0 ? (payload.bytes_sent / payload.total_bytes) * 100 : 0;
  item.totalBytes = payload.total_bytes;
  if (typeof payload.speed_bps === "number" && payload.speed_bps >= 0) {
    item.speedBps = payload.speed_bps;
  }
  if (typeof payload.eta_seconds === "number" && payload.eta_seconds >= 0) {
    item.etaSeconds = payload.eta_seconds;
  } else if (payload.eta_seconds === 0) {
    item.etaSeconds = 0;
  }
  if (
    typeof payload.completed_parts === "number" &&
    Number.isInteger(payload.completed_parts)
  ) {
    item.completedParts = payload.completed_parts;
  }
  if (
    typeof payload.total_parts === "number" &&
    Number.isInteger(payload.total_parts)
  ) {
    item.totalParts = payload.total_parts;
  }
  if (typeof payload.checkpoint_id === "string" && payload.checkpoint_id) {
    item.checkpointId = payload.checkpoint_id;
  }
  if (typeof payload.resumable === "boolean") {
    item.resumable = payload.resumable;
  }
}

export async function initTransferQueueUI(): Promise<void> {
  syncTransferVisibility();
  updateBadge();

  await recoverPendingQueueIfNeeded();

  progressUnlisten ??= await listen<TransferProgressPayload>(
    "upload-progress",
    (event) => {
      applyProgressPayload(event.payload);
      queueRender();
      writeQueueManifest();
    },
  );

  downloadProgressUnlisten ??= await listen<TransferProgressPayload>(
    "download-progress",
    (event) => {
      applyProgressPayload(event.payload);
      queueRender();
      writeQueueManifest();
    },
  );

  document
    .getElementById("transfer-pause-all")
    ?.addEventListener("click", pauseAllTransfers);
  document
    .getElementById("transfer-resume-all")
    ?.addEventListener("click", resumeAllTransfers);
  document
    .getElementById("transfer-prioritize")
    ?.addEventListener("click", prioritizeSelectedTransfer);
  document
    .getElementById("transfer-retry-failed")
    ?.addEventListener("click", retryFailedTransfers);
  document
    .getElementById("transfer-retry-skipped")
    ?.addEventListener("click", retrySkippedTransfers);
  document
    .getElementById("transfer-clear-non-active")
    ?.addEventListener("click", clearNonActiveTransfers);

  const list = document.getElementById("transfer-list");
  if (list && !cancelClickHandler) {
    cancelClickHandler = (e: Event) => {
      const target = e.target as HTMLElement;
      const row = target.closest(".transfer-item") as HTMLElement | null;
      if (!row) return;
      const id = Number(row.dataset.id);
      if (!id) return;

      if (target.closest(".transfer-cancel")) {
        void cancelTransferItem(id);
        return;
      }
      if (target.closest(".transfer-pause")) {
        togglePauseTransferItem(id);
        return;
      }
      selectedTransferId = id;
      queueRender();
    };
    list.addEventListener("click", cancelClickHandler);
  }

  queueRender();
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

function pauseAllTransfers(): void {
  queuePaused = true;
  for (const item of queue) {
    if (item.status === "queued" || item.status === "uploading") {
      item.paused = true;
      item.phase = "paused";
      if (item.status === "uploading") {
        void invoke("cancel_transfer", { transferId: item.id }).catch(
          () => undefined,
        );
      }
    }
  }
  queueRender();
  writeQueueManifest();
}

function resumeAllTransfers(): void {
  queuePaused = false;
  for (const item of queue) {
    if (!item.paused) continue;
    item.paused = false;
    if (item.status === "error" && item.error?.toLowerCase().includes("cancel")) {
      item.status = "queued";
      item.error = undefined;
    }
    if (item.status === "queued") {
      item.phase = "resuming";
    }
  }
  queueRender();
  writeQueueManifest();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

function togglePauseTransferItem(id: number): void {
  const item = queue.find((row) => row.id === id);
  if (!item) return;
  if (item.paused) {
    item.paused = false;
    if (item.status === "error" && item.error?.toLowerCase().includes("cancel")) {
      item.status = "queued";
      item.error = undefined;
    }
    if (item.status === "queued") {
      item.phase = "resuming";
      void processQueue().catch((err) =>
        logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
      );
    }
  } else {
    item.paused = true;
    item.phase = "paused";
    if (item.status === "uploading") {
      void invoke("cancel_transfer", { transferId: item.id }).catch(
        () => undefined,
      );
    }
  }
  queueRender();
  writeQueueManifest();
}

export function retryFailedTransfers(): void {
  for (const item of queue) {
    if (item.status !== "error") continue;
    item.status = "queued";
    item.error = undefined;
    item.progress = 0;
    item.speedBps = 0;
    item.etaSeconds = null;
    item.paused = false;
    item.phase = "running";
  }
  queueRender();
  writeQueueManifest();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export function retrySkippedTransfers(): void {
  for (const item of queue) {
    if (item.status !== "skipped") continue;
    item.status = "queued";
    item.error = undefined;
    item.progress = 0;
    item.speedBps = 0;
    item.etaSeconds = null;
    item.phase = "running";
  }
  queueRender();
  writeQueueManifest();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

export function clearNonActiveTransfers(): void {
  queue = queue.filter(
    (item) => item.status === "queued" || item.status === "uploading",
  );
  if (selectedTransferId != null && !queue.some((item) => item.id === selectedTransferId)) {
    selectedTransferId = null;
  }
  queueRender();
  writeQueueManifest();
}

export function prioritizeSelectedTransfer(): void {
  if (selectedTransferId == null) return;
  const index = queue.findIndex((item) => item.id === selectedTransferId);
  if (index <= 0) return;
  const [row] = queue.splice(index, 1);
  queue.unshift(row);
  queueRender();
  writeQueueManifest();
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
  if (selectedTransferId != null && !queue.some((item) => item.id === selectedTransferId)) {
    selectedTransferId = null;
  }
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
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      resumable: false,
      checkpointId: undefined,
      completedParts: 0,
      totalParts: 0,
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
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      resumable: false,
      checkpointId: undefined,
      completedParts: 0,
      totalParts: 0,
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
    const key = targetPrefix + rel;
    queue.push({
      id: nextId++,
      operation: "upload",
      bucket,
      fileName,
      filePath: entry.file_path,
      key,
      size: entry.size,
      status: "queued",
      progress: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution: state.currentSettings.conflictPolicy,
      phase: "running",
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      resumable: false,
      checkpointId: undefined,
      completedParts: 0,
      totalParts: 0,
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
  const effective = getEffectiveTransferSettings();
  for (const entry of entries) {
    const parts = entry.key.split("/");
    const fileName = parts[parts.length - 1] || entry.key;
    const checkpointId = effective.enableTransferResume
      ? buildCheckpointId({
          operation: "download",
          bucket: entry.bucket,
          key: entry.key,
          destination: entry.destination,
        })
      : undefined;
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
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      resumable: effective.enableTransferResume,
      checkpointId,
      completedParts: 0,
      totalParts: 0,
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

export function enqueueCopyMoveEntries(entries: CopyMoveQueueEntry[]): void {
  const maxAttempts = maxAttemptsFromSettings();
  for (const entry of entries) {
    const keyLike = entry.sourceKey ?? entry.sourcePrefix ?? "";
    const destinationLike = entry.destinationKey ?? entry.destinationPrefix ?? "";
    queue.push({
      id: nextId++,
      operation: entry.operation,
      bucket: entry.sourceBucket,
      fileName: entry.fileName,
      filePath: "",
      key: keyLike,
      sourceBucket: entry.sourceBucket,
      sourceKey: entry.sourceKey,
      sourcePrefix: entry.sourcePrefix,
      destinationBucket: entry.destinationBucket,
      destinationKey: entry.destinationKey,
      destinationPrefix: entry.destinationPrefix,
      destination: destinationLike,
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
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      resumable: false,
      completedParts: 0,
      totalParts: 0,
    });
  }

  if (entries.length > 0) {
    logActivity(`Queued ${entries.length} copy/move transfer(s).`, "info");
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
    if (queuePaused) return null;
    const item = queue.find((t) => t.status === "queued" && !t.paused);
    if (item) {
      item.status = "uploading";
      item.phase = item.phase === "resuming" ? "resuming" : "running";
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
          if (selectedTransferId === item.id) {
            selectedTransferId = null;
          }
        }
      } catch (err) {
        const errorText = normalizeError(err);
        if (item.paused && /cancel/i.test(errorText)) {
          item.status = "queued";
          item.phase = "paused";
          item.error = "Paused";
        } else {
          item.status = "error";
          item.error = errorText;
          item.browserFile = undefined;
          const opLabel =
            item.operation === "download"
              ? "Download"
              : item.operation === "upload"
                ? "Upload"
                : item.operation === "copy"
                  ? "Copy"
                  : "Move";
          logActivity(`${opLabel} failed for ${item.fileName}: ${errorText}`, "error");
        }
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
    if (item.paused || queuePaused) {
      item.status = "queued";
      item.phase = "paused";
      return false;
    }
    item.attempt = attempt;
    item.phase = "running";
    item.speedBps = 0;
    item.etaSeconds = null;
    queueRender();
    writeQueueManifest();

    try {
      const conflictDecision = await resolveConflict(item);
      item.conflictResolution = conflictDecision;

      if (conflictDecision === "skip") {
        item.status = "skipped";
        item.error = "Skipped (destination exists)";
        item.speedBps = 0;
        item.etaSeconds = null;
        logActivity(
          `${
            item.operation === "download"
              ? "Download"
              : item.operation === "upload"
                ? "Upload"
                : item.operation === "copy"
                  ? "Copy"
                  : "Move"
          } skipped for ${item.fileName}: destination exists.`,
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
      item.speedBps = 0;
      item.etaSeconds = 0;

      if (item.operation === "download") {
        logActivity(`Downloaded ${item.fileName}.`, "success");
      } else if (item.operation === "upload") {
        logActivity(`Uploaded ${item.fileName} to ${item.key}.`, "success");
      } else if (item.operation === "copy") {
        logActivity(`Copied ${item.fileName}.`, "success");
      } else {
        logActivity(`Moved ${item.fileName}.`, "success");
      }
      if (item.checkpointId) {
        await invoke("transfer_checkpoint_remove", {
          checkpointId: item.checkpointId,
        }).catch(() => undefined);
      }
      return true;
    } catch (err) {
      if (attempt < maxAttempts && shouldRetryError(err)) {
        const waitMs = computeRetryDelayMs(attempt);
        item.phase = "retry_wait";
        item.error = `Retrying in ${waitMs}ms`;
        queueRender();
        logActivity(
          `${
            item.operation === "download"
              ? "Download"
              : item.operation === "upload"
                ? "Upload"
                : item.operation === "copy"
                  ? "Copy"
                  : "Move"
          } retry ${attempt}/${maxAttempts - 1} for ${item.fileName} in ${waitMs}ms.`,
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
  const effective = getEffectiveTransferSettings();

  if (item.operation === "download") {
    if (!item.destination) {
      throw new Error("No destination available for download transfer.");
    }

    const head = await invoke<HeadObjectSummary>("head_object", {
      bucket: item.bucket,
      key: item.key,
    });
    const shouldUseParallel =
      head.content_length >= effective.downloadParallelThresholdMb * 1024 * 1024 &&
      effective.downloadPartConcurrency > 1;
    const checkpointId =
      item.checkpointId ??
      (item.resumable
        ? buildCheckpointId({
            operation: item.operation,
            bucket: item.bucket,
            key: item.key,
            destination: item.destination,
          })
        : undefined);
    item.checkpointId = checkpointId;

    let size = 0;
    if (shouldUseParallel) {
      try {
        size = await invoke<number>("download_object_parallel", {
          bucket: item.bucket,
          key: item.key,
          destination: item.destination,
          transferId: item.id,
          overwrite,
          tempPath: item.tempPath,
          attempt,
          parallelThresholdMb: effective.downloadParallelThresholdMb,
          partSizeMb: effective.downloadPartSizeMb,
          partConcurrency: effective.downloadPartConcurrency,
          bandwidthLimitMbps: effective.bandwidthLimitMbps,
          checkpointId,
          enableResume: item.resumable && effective.enableTransferResume,
        });
      } catch (err) {
        const text = normalizeError(err).toLowerCase();
        if (!text.includes("__range_unsupported__")) {
          throw err;
        }
        size = await invoke<number>("download_object", {
          bucket: item.bucket,
          key: item.key,
          destination: item.destination,
          transferId: item.id,
          overwrite,
          tempPath: item.tempPath,
          attempt,
        });
      }
    } else {
      size = await invoke<number>("download_object", {
        bucket: item.bucket,
        key: item.key,
        destination: item.destination,
        transferId: item.id,
        overwrite,
        tempPath: item.tempPath,
        attempt,
      });
    }
    item.totalBytes = size;
    item.progress = 100;
    item.completedParts = item.totalParts || item.completedParts;
    return;
  }

  if (item.operation === "copy" || item.operation === "move") {
    const srcBucket = item.sourceBucket ?? item.bucket;
    const dstBucket = item.destinationBucket ?? item.bucket;
    if (item.sourceKey && item.destinationKey) {
      await invoke("copy_object_to", {
        srcBucket,
        srcKey: item.sourceKey,
        dstBucket,
        dstKey: item.destinationKey,
      });
      if (item.operation === "move") {
        await invoke("delete_objects", {
          bucket: srcBucket,
          keys: [item.sourceKey],
        });
      }
      item.progress = 100;
      return;
    }
    if (item.sourcePrefix && item.destinationPrefix) {
      await invoke("copy_prefix_to", {
        srcBucket,
        srcPrefix: item.sourcePrefix,
        dstBucket,
        dstPrefix: item.destinationPrefix,
      });
      if (item.operation === "move") {
        await invoke("delete_prefix", {
          bucket: srcBucket,
          prefix: item.sourcePrefix,
        });
      }
      item.progress = 100;
      return;
    }
    throw new Error("Invalid copy/move transfer configuration.");
  }

  const contentType = guessContentType(item.fileName);
  if (item.filePath) {
    item.resumable = false;
    item.checkpointId = undefined;
    await invoke("upload_object_resumable", {
      bucket: item.bucket,
      key: item.key,
      filePath: item.filePath,
      contentType,
      transferId: item.id,
      attempt,
      partSizeMb: effective.uploadPartSizeMb,
      partConcurrency: effective.uploadPartConcurrency,
      bandwidthLimitMbps: effective.bandwidthLimitMbps,
      resumable: false,
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
        : item.operation === "copy" || item.operation === "move"
          ? `${
              item.destinationBucket ?? item.bucket
            }/${item.destinationKey ?? item.destinationPrefix ?? item.fileName}`
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
    if (item.operation === "copy" || item.operation === "move") {
      const bucket = item.destinationBucket ?? item.bucket;
      if (item.destinationKey) {
        return invoke<boolean>("object_exists", {
          bucket,
          key: item.destinationKey,
        });
      }
      if (!item.destinationPrefix) return false;
      const existing = await invoke<{
        objects: Array<{ key: string }>;
        prefixes: string[];
      }>("list_objects", {
        bucket,
        prefix: item.destinationPrefix,
        delimiter: "",
        continuationToken: "",
      });
      return existing.objects.length > 0 || existing.prefixes.length > 0;
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
    updateTransferThroughput();
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
        (t.status === "uploading" ||
          t.status === "queued" ||
          (t.status === "error" && t.progress > 0))
          ? `<div class="transfer-progress-wrap">` +
            `<div class="transfer-progress"><div class="transfer-progress__bar" style="width:${progressPct}%"></div></div>` +
            `<span class="transfer-progress__label">${progressPct}%</span>` +
            `</div>`
          : "";
      const target =
        t.operation === "download"
          ? (t.destination ?? "")
          : t.operation === "copy" || t.operation === "move"
            ? `${t.destinationBucket ?? t.bucket}/${t.destinationKey ?? t.destinationPrefix ?? ""}`
            : t.key;
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
                  : t.phase === "paused"
                    ? "Paused"
                    : t.phase === "resuming"
                      ? "Resuming"
                      : t.phase === "finalizing"
                        ? "Finalizing"
                  : "Running"
            }</span>`
          : "";
      const speedLabel =
        t.status === "uploading" && t.speedBps > 0
          ? `<span class="transfer-phase">${escapeHtml(formatSpeedBps(t.speedBps))}</span>`
          : "";
      const etaLabel =
        t.status === "uploading" && t.etaSeconds !== null
          ? `<span class="transfer-phase">ETA ${escapeHtml(formatEtaSeconds(t.etaSeconds))}</span>`
          : "";
      const partsLabel =
        t.totalParts > 0
          ? `<span class="transfer-phase">Parts ${Math.min(t.completedParts, t.totalParts)}/${t.totalParts}</span>`
          : "";
      const rowClass =
        selectedTransferId === t.id
          ? "transfer-item transfer-item--selected"
          : "transfer-item";
      const pauseButton =
        t.status === "queued" || t.status === "uploading" || t.paused
          ? `<button class="transfer-pause btn--ghost" title="${
              t.paused ? "Resume" : "Pause"
            }" aria-label="${t.paused ? "Resume" : "Pause"} transfer">${
              t.paused ? "▶" : "Ⅱ"
            }</button>`
          : "";

      return (
        `<div class="${rowClass}" data-id="${t.id}">` +
        `<span class="transfer-status ${statusClass}">${statusIcon}</span>` +
        `<div class="transfer-main">` +
        `<div class="transfer-main__row">` +
        `<span class="transfer-name">${escapeHtml(t.fileName)}</span>` +
        (t.status !== "uploading" || t.operation !== "upload"
          ? `<span class="transfer-arrow">${arrow}</span>` +
            `<span class="transfer-key">${escapeHtml(target)}</span>`
          : "") +
        `</div>` +
        (attemptLabel || phaseLabel || speedLabel || etaLabel || partsLabel
          ? `<div class="transfer-meta">${attemptLabel}${phaseLabel}${speedLabel}${etaLabel}${partsLabel}</div>`
          : "") +
        progressBar +
        (t.status === "error" || t.status === "skipped"
          ? `<span class="transfer-error" title="${escapeHtml(t.error ?? "")}">${escapeHtml(t.error ?? "Error")}</span>`
          : "") +
        `</div>` +
        pauseButton +
        (t.status === "queued" || t.status === "uploading"
          ? `<button class="transfer-cancel btn--ghost" title="Cancel" aria-label="Cancel transfer">&times;</button>`
          : "") +
        `</div>`
      );
    })
    .join("");

  updateBadge();
  updateTransferThroughput();
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

function updateTransferThroughput(): void {
  const totalSpeed = queue
    .filter((item) => item.status === "uploading")
    .reduce((sum, item) => sum + Math.max(0, item.speedBps), 0);
  const label = totalSpeed > 0 ? formatSpeedBps(totalSpeed) : "";
  const statusEl = document.getElementById("statusbar-throughput");
  if (statusEl) {
    statusEl.textContent = label ? `Transfers ${label}` : "";
  }
  const drawerEl = document.getElementById("drawer-transfer-throughput");
  if (drawerEl) {
    drawerEl.textContent = label ? `Total ${label}` : "";
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
