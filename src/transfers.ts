import { invoke } from "@tauri-apps/api/core";
import { invokeS3For } from "./connection.ts";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { escapeHtml, getIconHtml } from "./utils.ts";
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
import { showContextMenu } from "./context-menu.ts";
import {
  isTransfersHintDismissed,
  markTransfersHintDismissed,
} from "./settings.ts";
import { showToast } from "./toast.ts";

export interface CopyReceipt {
  source_key: string;
  source_etag: string;
  source_fingerprint?: string;
  source_version_id: string | null;
  destination_key: string;
  destination_etag: string;
  destination_version_id: string | null;
}

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
  /**
   * Where a move has got to.
   *
   * A move is a copy followed by a delete, issued as two separate backend calls.
   * Recording the transition means a crash or cancellation between them leaves a
   * durable note that the copy already happened, so recovery can finish the
   * delete instead of either duplicating the object or re-copying it.
   */
  movePhase?: "copied";
  receipts?: CopyReceipt[];
  connectionId?: string;
  connectionIdentity?: string;
  /** Transient user intent; never written to the recovery manifest. */
  cancelRequested?: boolean;
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
  uploadCount: number;
  downloadCount: number;
  errorCount: number;
  skippedCount: number;
}

interface PersistedTransferManifest {
  version: 4;
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
  movePhase?: "copied";
  receipts?: CopyReceipt[];
  connectionId?: string;
  connectionIdentity?: string;
}

interface HeadObjectSummary {
  content_length: number;
}

const BROWSER_UPLOAD_BYTES_LIMIT = 16 * 1024 * 1024;
const LEGACY_QUEUE_MANIFEST_KEY = "s3-sidekick.transfer-manifest.v1";
const TRANSFER_ID_SEQUENCE_KEY = "s3-sidekick.transfer-id-sequence.v1";
const TRANSFER_ERROR_PREFIX = "__S3_SIDEKICK_TRANSFER_ERROR__";

/// Transfer ids are the handle the backend uses to cancel a running transfer.
///
/// They must not restart at 1 when the webview reloads: the backend process
/// outlives the page, so a fresh transfer could otherwise be handed an id that
/// still has meaning to the backend. Persisting the sequence keeps ids unique for
/// as long as the backend can remember any of them.
let nextId = readPersistedTransferIdSequence();

function readPersistedTransferIdSequence(): number {
  try {
    const raw = localStorage.getItem(TRANSFER_ID_SEQUENCE_KEY);
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // Storage unavailable; fall back to a fresh sequence.
  }
  return 1;
}

function allocateTransferId(): number {
  // The backend stores ids as u32, so wrap well below that ceiling rather than
  // overflowing into an id it would reject.
  if (nextId >= 0xffffffff) {
    nextId = 1;
  }
  const id = nextId++;
  try {
    localStorage.setItem(TRANSFER_ID_SEQUENCE_KEY, String(nextId));
  } catch {
    // Non-fatal: ids stay unique for this page's lifetime regardless.
  }
  return id;
}
let queue: TransferItem[] = [];
let processing = false;
let onComplete: ((summary: TransferRunSummary) => void) | null = null;
let progressUnlisten: UnlistenFn | null = null;
let downloadProgressUnlisten: UnlistenFn | null = null;
let renderQueued = false;
let cancelClickHandler: ((e: Event) => void) | null = null;
let recoveredQueue = false;
let recoveryInFlight: Promise<void> | null = null;
let conflictApplyAll: "skip" | "replace" | null = null;
let conflictPromptQueue: Promise<void> = Promise.resolve();
let selectedTransferId: number | null = null;
let queuePaused = false;
let manifestHydrated = false;
let manifestWriteTail: Promise<void> = Promise.resolve();
let normalManifestWritePending = false;
let normalManifestClearRequested = false;

interface EffectiveTransferSettings {
  downloadParallelThresholdMb: number;
  downloadPartSizeMb: number;
  downloadPartConcurrency: number;
  uploadPartSizeMb: number;
  uploadPartConcurrency: number;
  enableTransferResume: boolean;
  enableTransferChecksumVerification: boolean;
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
  const structured = parseStructuredTransferError(err);
  if (structured) return structured.message;
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

interface StructuredTransferError {
  code: string;
  retryable: boolean;
  http_status?: number;
  message: string;
}

function parseStructuredTransferError(
  err: unknown,
): StructuredTransferError | null {
  const text =
    typeof err === "string"
      ? err
      : err &&
          typeof err === "object" &&
          "message" in err &&
          typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "";
  if (!text.startsWith(TRANSFER_ERROR_PREFIX)) return null;
  const json = text.slice(TRANSFER_ERROR_PREFIX.length);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Partial<StructuredTransferError>;
    if (
      typeof row.code !== "string" ||
      typeof row.retryable !== "boolean" ||
      typeof row.message !== "string"
    ) {
      return null;
    }
    return {
      code: row.code,
      retryable: row.retryable,
      http_status:
        typeof row.http_status === "number" && Number.isInteger(row.http_status)
          ? row.http_status
          : undefined,
      message: row.message,
    };
  } catch {
    return null;
  }
}

function buildDownloadTempPath(destination: string): string {
  return `${destination}.s3-sidekick.download.tmp`;
}

function buildCheckpointId(
  item: Pick<TransferItem, "operation" | "bucket" | "key" | "destination">,
): string {
  const seed = `${item.operation}:${item.bucket}:${item.key}:${item.destination ?? ""}`;
  // Base64-encode UTF-8 bytes without the deprecated unescape(): map each byte
  // of the encoded string through String.fromCharCode for btoa's latin1 input.
  const utf8 = new TextEncoder().encode(seed);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, "");
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
    enableTransferChecksumVerification:
      state.currentSettings.enableTransferChecksumVerification,
    transferCheckpointTtlHours:
      state.currentSettings.transferCheckpointTtlHours,
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
  const structured = parseStructuredTransferError(err);
  if (structured) return structured.retryable;
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
    movePhase: item.movePhase,
    receipts: item.receipts,
    connectionId: item.connectionId,
    connectionIdentity: item.connectionIdentity,
  };
}

function buildQueueManifestJson(): string | null {
  // Uploads are not resumable, so an in-flight upload that survives an app kill
  // would restart from byte 0. We drop active uploads from the manifest; queued
  // uploads that never started are still safe to persist.
  const pending = queue.filter(
    (item) =>
      (item.status === "queued" || item.status === "uploading") &&
      !(item.operation === "upload" && item.status === "uploading"),
  );
  if (pending.length === 0) return null;
  const payload: PersistedTransferManifest = {
    version: 4,
    items: pending.map(serializeManifestItem),
  };
  return JSON.stringify(payload);
}

function persistLegacyQueueManifest(forceClear = false): void {
  if (forceClear) {
    localStorage.removeItem(LEGACY_QUEUE_MANIFEST_KEY);
    return;
  }
  const json = buildQueueManifestJson();
  if (json) {
    localStorage.setItem(LEGACY_QUEUE_MANIFEST_KEY, json);
  } else {
    localStorage.removeItem(LEGACY_QUEUE_MANIFEST_KEY);
  }
}

async function persistQueueManifestNow(forceClear = false): Promise<void> {
  if (!manifestHydrated) {
    persistLegacyQueueManifest(forceClear);
    return;
  }
  if (forceClear) {
    await invoke("clear_transfer_manifest");
    return;
  }
  const json = buildQueueManifestJson();
  if (json) {
    await invoke("save_transfer_manifest", { json });
  } else {
    await invoke("clear_transfer_manifest");
  }
}

function enqueueQueueManifestOperation(
  operation: () => Promise<void>,
): Promise<void> {
  const write = manifestWriteTail.then(operation);
  // Keep later writes moving after a failure without changing the promise
  // returned to the caller that owns this operation.
  manifestWriteTail = write.catch(() => undefined);
  return write;
}

function logQueueManifestWriteError(err: unknown): void {
  logActivity(
    `Failed to persist transfer queue: ${normalizeError(err)}`,
    "error",
  );
}

function scheduleQueueManifestWrite(forceClear = false): void {
  if (forceClear) {
    normalManifestClearRequested = true;
  }
  if (normalManifestWritePending) return;

  normalManifestWritePending = true;
  const write = enqueueQueueManifestOperation(() => {
    const shouldClear = normalManifestClearRequested;
    normalManifestClearRequested = false;
    // Calls made while this operation is in flight should schedule one trailing
    // write, while calls made before it starts can share this latest snapshot.
    normalManifestWritePending = false;
    return persistQueueManifestNow(shouldClear);
  });
  void write.catch(logQueueManifestWriteError);
}

function persistQueueManifestCritical(): Promise<void> {
  if (!manifestHydrated) {
    return Promise.reject(
      new Error(
        "Secure transfer recovery storage is unavailable; source deletion was refused.",
      ),
    );
  }
  return enqueueQueueManifestOperation(() => persistQueueManifestNow());
}

function writeQueueManifest(): void {
  scheduleQueueManifestWrite();
}

function clearQueueManifest(): void {
  scheduleQueueManifestWrite(true);
}

function parseCopyReceipts(value: unknown): CopyReceipt[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const receipts: CopyReceipt[] = [];
  for (const valueItem of value) {
    if (
      !valueItem ||
      typeof valueItem !== "object" ||
      Array.isArray(valueItem)
    ) {
      return undefined;
    }
    const receipt = valueItem as Record<string, unknown>;
    if (
      typeof receipt.source_key !== "string" ||
      typeof receipt.source_etag !== "string" ||
      (receipt.source_version_id !== null &&
        typeof receipt.source_version_id !== "string") ||
      typeof receipt.destination_key !== "string" ||
      typeof receipt.destination_etag !== "string" ||
      (receipt.destination_version_id !== null &&
        typeof receipt.destination_version_id !== "string")
    ) {
      return undefined;
    }
    receipts.push({
      source_key: receipt.source_key,
      source_etag: receipt.source_etag,
      source_fingerprint:
        typeof receipt.source_fingerprint === "string"
          ? receipt.source_fingerprint
          : "",
      source_version_id: receipt.source_version_id,
      destination_key: receipt.destination_key,
      destination_etag: receipt.destination_etag,
      destination_version_id: receipt.destination_version_id,
    });
  }
  return receipts;
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
    if (
      (version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
      !Array.isArray(items)
    ) {
      return null;
    }

    const valid: PersistedTransferItem[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<PersistedTransferItem>;
      if (
        (row.operation !== "upload" &&
          row.operation !== "download" &&
          row.operation !== "copy" &&
          row.operation !== "move") ||
        typeof row.bucket !== "string" ||
        typeof row.fileName !== "string" ||
        typeof row.filePath !== "string" ||
        typeof row.key !== "string" ||
        typeof row.size !== "number" ||
        typeof row.totalBytes !== "number"
      ) {
        continue;
      }
      const receipts = parseCopyReceipts(row.receipts);
      const movePhase =
        row.operation === "move" &&
        row.movePhase === "copied" &&
        receipts !== undefined
          ? "copied"
          : undefined;
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
        sourceKey:
          typeof row.sourceKey === "string" ? row.sourceKey : undefined,
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
        movePhase,
        receipts,
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
        connectionId:
          typeof row.connectionId === "string" && row.connectionId.length > 0
            ? row.connectionId
            : undefined,
        connectionIdentity:
          typeof row.connectionIdentity === "string" &&
          row.connectionIdentity.length > 0
            ? row.connectionIdentity
            : undefined,
      });
    }

    return { version: 4, items: valid };
  } catch {
    return null;
  }
}

async function cleanupRecoveredTempFiles(
  items: PersistedTransferItem[],
): Promise<string[]> {
  const destinations = [
    ...new Set(
      items
        .filter((item) => item.operation === "download" && !item.resumable)
        .map((item) => item.destination)
        .filter(
          (destination): destination is string =>
            typeof destination === "string" && destination.length > 0,
        ),
    ),
  ];
  const failures: string[] = [];

  for (const destination of destinations) {
    try {
      await invoke("discard_download_scratch", { destination });
    } catch (err) {
      failures.push(`${destination}: ${normalizeError(err)}`);
    }
  }
  return failures;
}

async function discardTransferRecoveryState(
  item: Pick<
    PersistedTransferItem,
    "operation" | "destination" | "checkpointId"
  >,
): Promise<void> {
  // Scratch first. If it cannot be removed, retain its checkpoint/manifest so
  // next startup still has a durable path back to the file and can retry.
  if (item.operation === "download" && item.destination) {
    await invoke("discard_download_scratch", {
      destination: item.destination,
    });
  }
  if (item.checkpointId) {
    await invoke("transfer_checkpoint_remove", {
      checkpointId: item.checkpointId,
    });
  }
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
    id: allocateTransferId(),
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
    cancelRequested: false,
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
    // Preserve only receipt-backed move markers; the parser deliberately drops
    // old phase-only markers so those moves copy again safely.
    movePhase: item.movePhase,
    receipts: item.receipts,
    connectionId: item.connectionId,
    connectionIdentity: item.connectionIdentity,
  };
}

async function recoverPendingQueueIfNeeded(): Promise<void> {
  if (recoveredQueue) return;

  const manifestRaw = await invoke<string>("load_transfer_manifest");
  const backendManifestAvailable = true;
  const legacyManifestRaw = localStorage.getItem(LEGACY_QUEUE_MANIFEST_KEY);
  let manifest = parseQueueManifest(
    backendManifestAvailable ? manifestRaw : legacyManifestRaw,
  );
  let legacyManifestMigrated = false;
  if (!manifest) {
    manifest = parseQueueManifest(legacyManifestRaw);
    if (manifest && backendManifestAvailable) {
      legacyManifestMigrated = await invoke("save_transfer_manifest", {
        json: JSON.stringify(manifest),
      })
        .then(() => true)
        .catch(() => false);
    }
  }
  if (backendManifestAvailable) {
    const backendHasManifest = manifestRaw.trim().length > 0;
    if (backendHasManifest || legacyManifestMigrated || !legacyManifestRaw) {
      try {
        persistLegacyQueueManifest(true);
      } catch (err) {
        logQueueManifestWriteError(err);
      }
    }
  }
  manifestHydrated = backendManifestAvailable;

  // Collect the checkpoints the manifest still refers to *before* running the
  // collector. Running GC first (as this used to) let it delete the resume state
  // of a queued transfer purely because the checkpoint file was older than the
  // TTL, forcing a full re-download. The backend also reclaims the scratch file
  // recorded inside each expiring checkpoint, so this ordering is what keeps
  // live transfers' scratch files from being deleted underneath them.
  const liveCheckpointIds = (manifest?.items ?? [])
    .map((row) => row.checkpointId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const effective = getEffectiveTransferSettings();
  await invoke("transfer_checkpoint_gc", {
    ttlHours: effective.transferCheckpointTtlHours,
    keepCheckpointIds: liveCheckpointIds,
  });
  if (!manifest || manifest.items.length === 0) {
    clearQueueManifest();
    recoveredQueue = true;
    return;
  }

  if (!document.getElementById("dialog-overlay")) {
    clearQueueManifest();
    recoveredQueue = true;
    return;
  }

  const tempCleanupFailures = await cleanupRecoveredTempFiles(manifest.items);
  if (tempCleanupFailures.length > 0) {
    const message = `Could not clean ${tempCleanupFailures.length} interrupted download(s); recovery state was retained.`;
    logActivity(`${message} ${tempCleanupFailures.join("; ")}`, "error");
    showToast(message, { type: "error", duration: 0 });
    return;
  }

  const shouldResume = await showConfirm(
    "Resume Transfers",
    `Resume ${manifest.items.length} pending transfer(s) from last session?`,
    { okLabel: "Resume", cancelLabel: "Discard" },
  );

  if (!shouldResume) {
    const failures: string[] = [];
    for (const row of manifest.items) {
      try {
        await discardTransferRecoveryState(row);
      } catch (err) {
        failures.push(`${row.fileName}: ${normalizeError(err)}`);
      }
    }
    if (failures.length > 0) {
      const message = `Could not discard ${failures.length} transfer(s); recovery state was retained.`;
      logActivity(`${message} ${failures.join("; ")}`, "error");
      showToast(message, { type: "error", duration: 0 });
      return;
    }
    clearQueueManifest();
    recoveredQueue = true;
    return;
  }

  for (const row of manifest.items) {
    queue.push(restoreItemFromManifest(row));
  }
  renderQueue();
  showTransferQueue();
  writeQueueManifest();
  recoveredQueue = true;

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
    payload.total_bytes > 0
      ? (payload.bytes_sent / payload.total_bytes) * 100
      : 0;
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

export function recoverPendingTransfers(): Promise<void> {
  if (recoveredQueue) return Promise.resolve();
  recoveryInFlight ??= recoverPendingQueueIfNeeded().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

export async function initTransferQueueUI(): Promise<void> {
  syncTransferVisibility();
  updateBadge();

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

  document.getElementById("transfer-more")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      [
        { label: "Prioritize selected", action: "prioritize" },
        { label: "Retry failed", action: "retry-failed" },
        { label: "Retry skipped", action: "retry-skipped" },
        { label: "Clear finished", action: "clear-non-active" },
      ],
      (action) => {
        if (action === "prioritize") prioritizeSelectedTransfer();
        else if (action === "retry-failed") retryFailedTransfers();
        else if (action === "retry-skipped") retrySkippedTransfers();
        else if (action === "clear-non-active") clearNonActiveTransfers();
      },
    );
  });

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
    if (item.status !== "queued" && item.status !== "uploading") continue;
    // In-flight uploads would have to restart from zero if interrupted, so let
    // them run to completion. Downloads resume cleanly, so cancelling them to
    // pause is safe; queued items simply stay queued.
    if (item.operation === "upload" && item.status === "uploading") continue;
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

function resumeAllTransfers(): void {
  queuePaused = false;
  for (const item of queue) {
    if (!item.paused) continue;
    item.paused = false;
    item.cancelRequested = false;
    if (
      item.status === "error" &&
      item.error?.toLowerCase().includes("cancel")
    ) {
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
    item.cancelRequested = false;
    if (
      item.status === "error" &&
      item.error?.toLowerCase().includes("cancel")
    ) {
      item.status = "queued";
      item.error = undefined;
    }
    if (item.status === "queued") {
      item.phase = "resuming";
      void processQueue().catch((err) =>
        logActivity(
          `Transfer processing error: ${normalizeError(err)}`,
          "error",
        ),
      );
    }
  } else {
    // In-flight uploads would have to restart from zero if interrupted, so
    // leave a running upload alone. The pause control is already hidden for
    // these in the queue UI; this guards other entry points too.
    if (item.operation === "upload" && item.status === "uploading") {
      return;
    }
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
    item.cancelRequested = false;
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
    item.cancelRequested = false;
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
  if (
    selectedTransferId != null &&
    !queue.some((item) => item.id === selectedTransferId)
  ) {
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
  if (state.currentSettings.openTransferDrawerOnStart) {
    openDrawer("transfers");
  }
  maybeShowTransfersHintToast();
  renderQueue();
}

function maybeShowTransfersHintToast(): void {
  if (isTransfersHintDismissed()) return;
  void markTransfersHintDismissed();
  showToast("View progress in Transfers (status bar icon).", {
    type: "info",
    duration: 6000,
  });
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
  if (
    selectedTransferId != null &&
    !queue.some((item) => item.id === selectedTransferId)
  ) {
    selectedTransferId = null;
  }
  renderQueue();
  writeQueueManifest();
  if (queue.length === 0) {
    hideTransferQueue();
  }
  resetConflictApplyAllWhenIdle();
}

export interface TransferEnqueueTarget {
  bucket: string;
  connectionId: string;
  connectionIdentity: string;
}

function transferConnectionFields(): {
  connectionId: string;
  connectionIdentity: string;
} {
  if (!state.connectionId || !state.connectionIdentity) {
    throw new Error("Not connected");
  }
  return {
    connectionId: state.connectionId,
    connectionIdentity: state.connectionIdentity,
  };
}

function resolveEnqueueTarget(
  target?: TransferEnqueueTarget,
): TransferEnqueueTarget {
  if (target) {
    if (!target.bucket || !target.connectionId || !target.connectionIdentity) {
      throw new Error("Not connected");
    }
    return target;
  }
  return {
    bucket: state.currentBucket,
    ...transferConnectionFields(),
  };
}

function bindTransferConnection(item: TransferItem): string {
  if (!state.connectionId || !state.connectionIdentity) {
    throw new Error("Not connected");
  }
  if (!item.connectionIdentity) {
    throw new Error(
      "Transfer is missing connection identity; refusing to run against the current account.",
    );
  }
  if (item.connectionIdentity !== state.connectionIdentity) {
    throw new Error("Connection changed");
  }
  // Rebind the session for this attempt so queued work can continue after a
  // same-account reconnect. Every command in the attempt uses this frozen ID.
  item.connectionId = state.connectionId;
  return item.connectionId;
}

export function enqueueFiles(
  files: FileList | File[],
  targetPrefix: string,
  target?: TransferEnqueueTarget,
): void {
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const allFiles = Array.from(files);
  const maxAttempts = maxAttemptsFromSettings();
  for (const file of allFiles) {
    const filePath =
      typeof (file as { path?: unknown }).path === "string"
        ? ((file as { path?: string }).path ?? "")
        : "";
    const key = targetPrefix + file.name;
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
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
      cancelRequested: false,
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

export function enqueuePaths(
  paths: string[],
  targetPrefix: string,
  target?: TransferEnqueueTarget,
): void {
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const maxAttempts = maxAttemptsFromSettings();
  for (const filePath of paths) {
    const normalizedPath = filePath.trim();
    const parts = normalizedPath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1] ?? "";
    const key = targetPrefix + fileName;
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
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
      cancelRequested: false,
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
  target?: TransferEnqueueTarget,
): void {
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const maxAttempts = maxAttemptsFromSettings();
  for (const entry of entries) {
    const rel = entry.relative_path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) continue;
    const segments = rel.split("/");
    const fileName = segments[segments.length - 1];
    const key = targetPrefix + rel;
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
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
      cancelRequested: false,
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

export function enqueueDownloads(
  entries: DownloadQueueEntry[],
  target?: TransferEnqueueTarget,
): void {
  const enqueueTarget = resolveEnqueueTarget(target);
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
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
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
      cancelRequested: false,
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

export function enqueueCopyMoveEntries(
  entries: CopyMoveQueueEntry[],
  target?: TransferEnqueueTarget,
): void {
  const enqueueTarget = resolveEnqueueTarget(target);
  const maxAttempts = maxAttemptsFromSettings();
  for (const entry of entries) {
    const keyLike = entry.sourceKey ?? entry.sourcePrefix ?? "";
    const destinationLike =
      entry.destinationKey ?? entry.destinationPrefix ?? "";
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
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
      cancelRequested: false,
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
  let attemptedUploadThisRun = false;
  let attemptedDownloadThisRun = false;
  let uploadCount = 0;
  let downloadCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

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

      if (item.operation === "upload") attemptedUploadThisRun = true;
      if (item.operation === "download") attemptedDownloadThisRun = true;

      renderQueue();
      writeQueueManifest();

      try {
        const completed = await runItemWithRetry(item);
        if (completed && item.operation === "download") {
          completedDownloadThisRun = true;
          downloadCount += 1;
        }
        if (completed && item.operation === "upload") {
          completedUploadThisRun = true;
          uploadCount += 1;
        }
        if (item.status === "skipped") skippedCount += 1;

        if (completed) {
          queue = queue.filter((t) => t.id !== item.id);
          if (selectedTransferId === item.id) {
            selectedTransferId = null;
          }
        }
      } catch (err) {
        const errorText = normalizeError(err);
        if (item.cancelRequested) {
          try {
            await discardTransferRecoveryState(item);
            item.status = "error";
            item.phase = "finalizing";
            item.error = "Cancelled";
            item.browserFile = undefined;
          } catch (cleanupErr) {
            const cleanupMessage = `Cancellation cleanup failed: ${normalizeError(cleanupErr)}`;
            // Keep this item recoverable and cancellable. Excluding it from the
            // manifest here would orphan scratch/checkpoint state.
            item.status = "queued";
            item.phase = "paused";
            item.paused = true;
            item.cancelRequested = false;
            item.error = cleanupMessage;
            logActivity(
              `Cancellation cleanup failed for ${item.fileName}: ${normalizeError(cleanupErr)}`,
              "error",
            );
            showToast(cleanupMessage, { type: "error", duration: 0 });
          }
          errorCount += 1;
        } else if (item.paused && /cancel/i.test(errorText)) {
          item.status = "queued";
          item.phase = "paused";
          item.error = "Paused";
        } else {
          item.status = "error";
          item.error = errorText;
          item.browserFile = undefined;
          errorCount += 1;
          const opLabel =
            item.operation === "download"
              ? "Download"
              : item.operation === "upload"
                ? "Upload"
                : item.operation === "copy"
                  ? "Copy"
                  : "Move";
          logActivity(
            `${opLabel} failed for ${item.fileName}: ${errorText}`,
            "error",
          );
        }
      }

      renderQueue();
      writeQueueManifest();
    }
  }

  await Promise.all(workers);
  processing = false;
  resetConflictApplyAllWhenIdle();

  if (
    onComplete &&
    (attemptedUploadThisRun ||
      attemptedDownloadThisRun ||
      errorCount > 0 ||
      skippedCount > 0)
  ) {
    onComplete({
      hadUpload: completedUploadThisRun,
      hadDownload: completedDownloadThisRun,
      uploadCount,
      downloadCount,
      errorCount,
      skippedCount,
    });
  }
}

function ensureTransferActive(item: TransferItem): void {
  if (item.paused || item.cancelRequested) {
    throw new Error("Cancelled");
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
      const connectionId = bindTransferConnection(item);
      const conflictDecision = await resolveConflict(item, connectionId);
      ensureTransferActive(item);
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

      await executeTransfer(
        item,
        attempt,
        conflictDecision === "replace",
        connectionId,
      );
      ensureTransferActive(item);
      item.phase = "verifying";
      queueRender();

      if (item.operation === "upload") {
        await verifyUploadedObject(item, connectionId);
      }
      ensureTransferActive(item);

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
  connectionId: string,
): Promise<void> {
  const effective = getEffectiveTransferSettings();
  ensureTransferActive(item);

  if (item.operation === "download") {
    if (!item.destination) {
      throw new Error("No destination available for download transfer.");
    }

    const head = await invokeS3For<HeadObjectSummary>(
      connectionId,
      "head_object",
      {
        bucket: item.bucket,
        key: item.key,
      },
    );
    ensureTransferActive(item);
    const shouldUseParallel =
      head.content_length >=
        effective.downloadParallelThresholdMb * 1024 * 1024 &&
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
        size = await invokeS3For<number>(
          connectionId,
          "download_object_parallel",
          {
            bucket: item.bucket,
            key: item.key,
            destination: item.destination,
            transferId: item.id,
            overwrite,
            attempt,
            parallelThresholdMb: effective.downloadParallelThresholdMb,
            partSizeMb: effective.downloadPartSizeMb,
            partConcurrency: effective.downloadPartConcurrency,
            bandwidthLimitMbps: effective.bandwidthLimitMbps,
            checkpointId,
            enableResume: item.resumable && effective.enableTransferResume,
            checksumVerification: effective.enableTransferChecksumVerification,
          },
        );
      } catch (err) {
        const text = normalizeError(err).toLowerCase();
        if (!text.includes("__range_unsupported__")) {
          throw err;
        }
        ensureTransferActive(item);
        size = await invokeS3For<number>(connectionId, "download_object", {
          bucket: item.bucket,
          key: item.key,
          destination: item.destination,
          transferId: item.id,
          overwrite,
          attempt,
          checksumVerification: effective.enableTransferChecksumVerification,
        });
      }
    } else {
      size = await invokeS3For<number>(connectionId, "download_object", {
        bucket: item.bucket,
        key: item.key,
        destination: item.destination,
        transferId: item.id,
        overwrite,
        attempt,
        checksumVerification: effective.enableTransferChecksumVerification,
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
    const hasObjectPair = Boolean(item.sourceKey && item.destinationKey);
    const hasPrefixPair = Boolean(item.sourcePrefix && item.destinationPrefix);
    if (!hasObjectPair && !hasPrefixPair) {
      throw new Error("Invalid copy/move transfer configuration.");
    }

    // Only a receipt-backed marker can skip the copy. Restored phase-only
    // markers from older manifests are deliberately discarded by the parser.
    const alreadyCopied =
      item.operation === "move" &&
      item.movePhase === "copied" &&
      item.receipts !== undefined &&
      item.receipts.length > 0;

    if (!alreadyCopied) {
      if (item.paused || item.cancelRequested) {
        throw new Error("Cancelled");
      }

      let receipts: CopyReceipt[];
      if (item.sourceKey && item.destinationKey) {
        const receipt = await invokeS3For<CopyReceipt>(
          connectionId,
          "copy_object_to",
          {
            srcBucket,
            srcKey: item.sourceKey,
            dstBucket,
            dstKey: item.destinationKey,
            transferId: item.id,
          },
        );
        receipts = [receipt];
      } else if (item.sourcePrefix && item.destinationPrefix) {
        receipts = await invokeS3For<CopyReceipt[]>(
          connectionId,
          "copy_prefix_to",
          {
            srcBucket,
            srcPrefix: item.sourcePrefix,
            dstBucket,
            dstPrefix: item.destinationPrefix,
            transferId: item.id,
            collectReceipts: item.operation === "move",
          },
        );
      } else {
        throw new Error("Invalid copy/move transfer configuration.");
      }

      if (item.operation === "copy") {
        item.progress = 100;
        return;
      }

      if (receipts.length === 0) {
        item.progress = 100;
        return;
      }

      item.receipts = receipts;
      item.movePhase = "copied";
      try {
        // Deletion is forbidden until this exact set of copy identities is
        // durable. A failed write leaves the source untouched and forces a
        // later attempt to copy again rather than trusting volatile state.
        await persistQueueManifestCritical();
      } catch (err) {
        item.receipts = undefined;
        item.movePhase = undefined;
        throw err;
      }
    }

    const receipts = item.receipts;
    if (!receipts) {
      throw new Error("Move copy receipts are unavailable.");
    }
    // Pause/cancel can arrive while the copy or manifest write is in flight.
    // Re-check after the durable marker so it cannot fall through to deletion.
    if (item.paused || item.cancelRequested) {
      throw new Error("Cancelled");
    }
    await invokeS3For(connectionId, "delete_copied_objects", {
      srcBucket,
      dstBucket,
      receipts,
      transferId: item.id,
    });
    item.movePhase = undefined;
    item.receipts = undefined;
    item.progress = 100;
    return;
  }

  const contentType = guessContentType(item.fileName);
  if (item.filePath) {
    item.resumable = false;
    item.checkpointId = undefined;
    await invokeS3For(connectionId, "upload_object", {
      bucket: item.bucket,
      key: item.key,
      filePath: item.filePath,
      contentType,
      transferId: item.id,
      attempt,
      partSizeMb: effective.uploadPartSizeMb,
      partConcurrency: effective.uploadPartConcurrency,
      bandwidthLimitMbps: effective.bandwidthLimitMbps,
      checksumVerification: effective.enableTransferChecksumVerification,
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
    ensureTransferActive(item);
    await invokeS3For(connectionId, "upload_object_bytes", {
      bucket: item.bucket,
      key: item.key,
      bytes,
      contentType,
      transferId: item.id,
      attempt,
      checksumVerification: effective.enableTransferChecksumVerification,
    });
    item.browserFile = undefined;
  } else {
    throw new Error("No upload source available for transfer item.");
  }
}

async function verifyUploadedObject(
  item: TransferItem,
  connectionId: string,
): Promise<void> {
  const expected = item.totalBytes > 0 ? item.totalBytes : 0;
  if (expected <= 0) return;

  const head = await invokeS3For<HeadObjectSummary>(
    connectionId,
    "head_object",
    {
      bucket: item.bucket,
      key: item.key,
    },
  );
  ensureTransferActive(item);
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
  connectionId: string,
): Promise<"ask" | "skip" | "replace"> {
  let conflictExists: boolean;
  try {
    conflictExists = await checkConflictExists(item, connectionId);
  } catch (err) {
    // The probe failed, so we do not know whether the destination is occupied.
    // Assume it is and let the normal conflict handling below decide, rather
    // than overwriting on the strength of a failed check.
    logActivity(
      `Could not verify whether the destination for ${item.fileName} already exists ` +
        `(${normalizeError(err)}). Treating it as a conflict.`,
      "warning",
    );
    conflictExists = true;
  }
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

/**
 * Determine whether a transfer's destination already exists.
 *
 * Errors are deliberately *not* swallowed. Treating a failed probe as "does not
 * exist" (the previous behaviour) meant a transient 503, a throttle, or a 403 on
 * HeadObject silently became permission to overwrite without ever asking the
 * user. Propagating the error makes the caller prompt instead.
 */
async function checkConflictExists(
  item: TransferItem,
  connectionId: string,
): Promise<boolean> {
  if (item.operation === "download") {
    if (!item.destination) return false;
    return invoke<boolean>("path_exists", { path: item.destination });
  }
  if (item.operation === "copy" || item.operation === "move") {
    const bucket = item.destinationBucket ?? item.bucket;
    if (item.destinationKey) {
      return invokeS3For<boolean>(connectionId, "object_exists", {
        bucket,
        key: item.destinationKey,
      });
    }
    if (!item.destinationPrefix) return false;
    const existing = await invokeS3For<{
      objects: Array<{ key: string }>;
      prefixes: string[];
    }>(connectionId, "list_objects", {
      bucket,
      prefix: item.destinationPrefix,
      delimiter: "",
      continuationToken: "",
    });
    return existing.objects.length > 0 || existing.prefixes.length > 0;
  }
  return invokeS3For<boolean>(connectionId, "object_exists", {
    bucket: item.bucket,
    key: item.key,
  });
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
      `${getIconHtml("download", { className: "lucide-icon empty-state__icon", decorative: true })}` +
      `<span>No transfers</span>` +
      `</div>`;
    updateBadge();
    updateTransferThroughput();
    updateQueueSummary();
    syncTransferVisibility();
    writeQueueManifest();
    return;
  }

  list.innerHTML = queue
    .map((t) => {
      let statusIcon = "";
      let statusClass = "";
      if (t.status === "queued") {
        statusIcon = getIconHtml("clock", {
          className: "lucide-icon transfer-icon-svg",
          decorative: true,
        });
        statusClass = "transfer-status--queued";
      } else if (t.status === "uploading") {
        statusIcon = getIconHtml("refresh-cw", {
          className: "lucide-icon transfer-icon-svg",
          decorative: true,
        });
        statusClass = "transfer-status--active";
      } else if (t.status === "done") {
        statusIcon = getIconHtml("check-circle", {
          className: "lucide-icon transfer-icon-svg",
          decorative: true,
        });
        statusClass = "transfer-status--done";
      } else if (t.status === "skipped") {
        statusIcon = getIconHtml("skip-forward", {
          className: "lucide-icon transfer-icon-svg",
          decorative: true,
        });
        statusClass = "transfer-status--queued";
      } else {
        statusIcon = getIconHtml("alert-circle", {
          className: "lucide-icon transfer-icon-svg",
          decorative: true,
        });
        statusClass = "transfer-status--error";
      }

      const progressPct = Math.max(
        0,
        Math.min(100, Math.round(t.progress) || 0),
      );
      const showDeterminate =
        t.totalBytes > 0 &&
        (t.status === "uploading" ||
          t.status === "queued" ||
          (t.status === "error" && t.progress > 0));
      const showIndeterminate =
        !showDeterminate &&
        (t.status === "uploading" ||
          t.status === "queued" ||
          t.operation === "copy" ||
          t.operation === "move");
      const progressBar = showDeterminate
        ? `<div class="transfer-progress-wrap">` +
          `<div class="transfer-progress" role="progressbar" aria-label="${escapeHtml(t.fileName)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPct}"><div class="transfer-progress__bar" style="width:${progressPct}%"></div></div>` +
          `<span class="transfer-progress__label">${progressPct}%</span>` +
          `</div>`
        : showIndeterminate
          ? `<div class="transfer-progress-wrap transfer-progress-wrap--indeterminate">` +
            `<div class="transfer-progress transfer-progress--indeterminate" role="progressbar" aria-label="${escapeHtml(t.fileName)} progress" aria-busy="true"><div class="transfer-progress__bar"></div></div>` +
            `</div>`
          : "";
      const opLabel =
        t.operation === "download"
          ? "Download"
          : t.operation === "copy"
            ? "Copy"
            : t.operation === "move"
              ? "Move"
              : "Upload";
      const target =
        t.operation === "download"
          ? (t.destination ?? "")
          : t.operation === "copy" || t.operation === "move"
            ? `${t.destinationBucket ?? t.bucket}/${t.destinationKey ?? t.destinationPrefix ?? ""}`
            : t.key;
      const arrow =
        t.operation === "download"
          ? getIconHtml("arrow-left", {
              className: "lucide-icon transfer-arrow-svg",
              decorative: true,
            })
          : getIconHtml("arrow-right", {
              className: "lucide-icon transfer-arrow-svg",
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
      // In-flight uploads would have to restart from zero if interrupted, so
      // only expose pause for downloads or transfers not yet running.
      const canPause =
        !(t.operation === "upload" && t.status === "uploading" && !t.paused) &&
        (t.status === "queued" || t.status === "uploading" || t.paused);
      const pauseButton = canPause
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
        `<span class="transfer-op">${escapeHtml(opLabel)}</span>` +
        `<span class="transfer-name">${escapeHtml(t.fileName)}</span>` +
        (target
          ? `<span class="transfer-arrow">${arrow}</span>` +
            `<span class="transfer-key">${escapeHtml(target)}</span>`
          : "") +
        `</div>` +
        (attemptLabel || phaseLabel || speedLabel || etaLabel || partsLabel
          ? `<div class="transfer-meta">${attemptLabel}${phaseLabel}${speedLabel}${etaLabel}${partsLabel}</div>`
          : "") +
        progressBar +
        (t.status === "error" || t.status === "skipped" || (t.paused && t.error)
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
  updateQueueSummary();
  syncTransferVisibility();
  writeQueueManifest();
}

function updateQueueSummary(): void {
  const el = document.getElementById("transfer-queue-summary");
  if (!el) return;

  const active = queue.filter(
    (t) => t.status === "queued" || t.status === "uploading",
  ).length;
  const failed = queue.filter((t) => t.status === "error").length;
  const skipped = queue.filter((t) => t.status === "skipped").length;
  const totalSpeed = queue
    .filter((item) => item.status === "uploading")
    .reduce((sum, item) => sum + Math.max(0, item.speedBps), 0);

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (totalSpeed > 0) parts.push(formatSpeedBps(totalSpeed));
  el.textContent = parts.length > 0 ? parts.join(" · ") : "No active transfers";
}

function updateBadge(): void {
  const active = queue.filter(
    (t) => t.status === "queued" || t.status === "uploading",
  ).length;
  const attention = queue.filter(
    (t) => t.status === "error" || t.status === "skipped",
  ).length;
  const badgeText = active > 0 ? String(active) : attention > 0 ? "!" : "";
  const badge = document.getElementById("transfer-badge");
  if (badge) {
    badge.textContent = badgeText;
    badge.style.display = active > 0 || attention > 0 ? "" : "none";
    badge.classList.toggle(
      "transfer-badge--alert",
      active === 0 && attention > 0,
    );
  }
  const drawerBadge = document.getElementById("drawer-transfer-badge");
  if (drawerBadge) {
    drawerBadge.textContent = badgeText;
    drawerBadge.style.display = active > 0 || attention > 0 ? "" : "none";
    drawerBadge.classList.toggle(
      "drawer-badge--alert",
      active === 0 && attention > 0,
    );
  }
  const toggle = document.getElementById("transfer-toggle");
  if (toggle && (active > 0 || attention > 0)) {
    const speedLabel =
      queue
        .filter((item) => item.status === "uploading")
        .reduce((sum, item) => sum + Math.max(0, item.speedBps), 0) > 0
        ? formatSpeedBps(
            queue
              .filter((item) => item.status === "uploading")
              .reduce((sum, item) => sum + Math.max(0, item.speedBps), 0),
          )
        : "";
    toggle.title = speedLabel
      ? `Transfers (${active} active, ${speedLabel})`
      : `Transfers (${active} active)`;
  } else if (toggle) {
    toggle.title = "Transfers";
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
  const hasQueue = queue.length > 0;

  if (toggle) {
    toggle.hidden = false;
    toggle.classList.toggle("statusbar__transfer--idle", !hasQueue);
    if (!hasQueue) {
      toggle.setAttribute("aria-expanded", "false");
    }
  }
}

async function cancelTransferItem(id: number): Promise<void> {
  const item = queue.find((t) => t.id === id);
  if (!item) return;
  item.cancelRequested = true;
  if (item.status === "queued") {
    try {
      await discardTransferRecoveryState(item);
      item.status = "error";
      item.error = "Cancelled";
      item.browserFile = undefined;
    } catch (err) {
      item.status = "queued";
      item.phase = "paused";
      item.paused = true;
      item.cancelRequested = false;
      item.error = `Cancellation cleanup failed: ${normalizeError(err)}`;
      logActivity(
        `Cancellation cleanup failed for ${item.fileName}: ${normalizeError(err)}`,
        "error",
      );
      showToast(item.error, { type: "error", duration: 0 });
    }
    renderQueue();
  } else if (item.status === "uploading") {
    try {
      await invoke("cancel_transfer", { transferId: id });
      item.error = "Cancelling...";
      renderQueue();
    } catch (err) {
      item.cancelRequested = false;
      item.error = undefined;
      const message = `Could not cancel ${item.fileName}: ${normalizeError(err)}`;
      logActivity(message, "error");
      showToast(message, { type: "error" });
      renderQueue();
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
