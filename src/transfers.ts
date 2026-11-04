import { invoke } from "./ipc.ts";
import { invokeS3For } from "./connection.ts";
import {
  pickDownloadDirectory,
  pickDownloadFile,
  pickUploadFiles,
} from "./path-grants.ts";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { friendlyError, isLocalEndpoint, plural, joinPath } from "./utils.ts";
import {
  captureTransferRenderFocus,
  computeQueueAggregates,
  reconcileTransferList,
  remainingConflictsQuestion,
  renderTransferRow,
  restoreTransferRenderFocus,
  syncTransferVisibility,
  TRANSFER_TEXT,
  updateQueueSummary,
  updateTransferBadges,
  updateTransferThroughput,
  patchTransferRowElement,
} from "./transfer-render.ts";

export { renderTransferRow };
import { state } from "./state.ts";
import { logActivity } from "./activity-log.ts";
import {
  openDrawer,
  closeDrawer,
  isDrawerOpen,
  getActiveTab,
  toggleDrawer,
} from "./bottom-drawer.ts";
import { showChoiceDialog, showConfirm } from "./dialogs.ts";
import { promptUnguardedWrite } from "./app-conflicts.ts";
import {
  claim,
  CONNECT_TO_RESUME_MESSAGE,
  holdAfterCancelFailure,
  isAutoParked,
  isClaimable,
  markCancelled,
  markDone,
  markFailed,
  markSkipped,
  park,
  pause,
  releaseHold,
  requeueAfterPause,
  resetForRetry,
  resume,
  type ParkReason,
} from "./transfer-state.ts";
import { showContextMenu } from "./context-menu.ts";
import {
  isTransfersHintDismissed,
  markTransfersHintDismissed,
} from "./settings.ts";
import { showToast } from "./toast.ts";
import {
  lacksAtomicCreateForCopy,
  lacksAtomicCreateForUpload,
  MULTIPART_COPY_THRESHOLD_BYTES,
  MULTIPART_UPLOAD_THRESHOLD_BYTES,
  SMALL_OBJECT_BYTE_LENGTH,
  isCreateOnlyUnsupportedError,
} from "./create-only-capabilities.ts";

/** Outcome of an enqueue call. A refusal leaves the queue untouched. */
export interface EnqueueResult {
  accepted: boolean;
  count: number;
  reason?: string;
}

export interface CopyReceipt {
  source_key: string;
  source_etag: string;
  source_fingerprint: string;
  source_acl_fingerprint: string;
  source_tag_fingerprint: string;
  // Null on buckets without versioning. The backend still pins the copy on
  // the ETag and guards deletion with a HEAD-fingerprint plus If-Match check
  // under the mutation lease; the version is used when it exists.
  source_version_id: string | null;
  destination_key: string;
  destination_etag: string;
  destination_fingerprint: string;
  destination_acl_fingerprint: string;
  destination_tag_fingerprint: string;
  destination_version_id: string | null;
  /** True when recovery cannot prove the destination belongs to this copy. */
  ownership_ambiguous: boolean;
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
  status: "queued" | "uploading" | "done" | "error" | "skipped" | "cancelled";
  error?: string;
  progress: number;
  totalBytes: number;
  attempt: number;
  maxAttempts: number;
  verified: boolean;
  conflictResolution: "ask" | "skip" | "replace";
  phase:
    | "running"
    | "preparing"
    | "retry_wait"
    | "verifying"
    | "paused"
    | "resuming"
    | "finalizing";
  /** When a retry wait ends; drives the "Retrying in N s" countdown. */
  retryAt?: number;
  /** False for refusals that a retry would only repeat. Persisted with errors. */
  retryable?: boolean;
  tempPath?: string;
  speedBps: number;
  /** Wall-clock of the last progress event; drives the stalled indicator. */
  lastProgressAt?: number;
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
  /** Set only while beta.4-or-earlier recovery awaits explicit account binding. */
  legacyConnectionUnbound?: boolean;
  /**
   * Backend-issued upload-file grant (native picker or native drop). Session
   * only: never persisted, so a recovered row re-opens the picker instead of
   * trusting a path from the manifest.
   */
  uploadToken?: string;
  /**
   * Backend-issued download-destination grant. Session only; see `uploadToken`.
   */
  destinationToken?: string;
  /** Child name inside a directory grant for multi-object downloads. */
  destinationName?: string;
  /** The row is waiting for the user to re-select its local path. */
  needsReselection?: boolean;
  /** Loaded from the recovery manifest in this session; never persisted. */
  recovered?: boolean;
  /** Explicit overwrite intent for S3 writes; not persisted in the manifest. */
  overwrite?: boolean;
  /** Session/capability/operation scope for transient overwrite consent. */
  overwriteScope?: string;
  /** Transient user intent; never written to the recovery manifest. */
  cancelRequested?: boolean;
  /**
   * A pause asked the backend to stop the running attempt and its
   * cancellation error has not arrived yet. Resuming before it arrives must
   * not turn that expected error into a failure.
   */
  pauseCancelInFlight?: boolean;
}

export interface DownloadQueueEntry {
  bucket: string;
  key: string;
  destination: string;
  /** `download-destination` grant for the file or its selected folder. */
  destinationToken?: string;
  /** File name inside a granted folder; absent for an exact file grant. */
  destinationName?: string;
  conflictResolution?: "ask" | "skip" | "replace";
  tempPath?: string;
}

export interface FolderUploadEntry {
  file_path: string;
  relative_path: string;
  size: number;
  /** `upload-file` grant minted by the recursive scan under a granted root. */
  file_token: string;
}

/** One file chosen through the native picker, ready to enqueue. */
export interface UploadSelection {
  path: string;
  token: string;
  size?: number;
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
  overwrite?: boolean;
  size?: number;
}

export interface TransferRunSummary {
  hadUpload: boolean;
  hadDownload: boolean;
  /** True when a copy/move completed and the current listing may be stale. */
  hadListingChange: boolean;
  uploadCount: number;
  downloadCount: number;
  copyCount: number;
  moveCount: number;
  errorCount: number;
  skippedCount: number;
}

interface TransferManifestHydration {
  recovery_session: string;
  manifest_json: string;
  legacy_import_allowed: boolean;
}

interface PersistedTransferManifest {
  version: 6;
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
  /** Persist terminal failures so recovery ownership survives a restart. */
  failed?: boolean;
  error?: string;
  /** Persisted only when a retry would just repeat the same refusal. */
  retryable?: false;
  /** In-memory marker for manifests from beta.4 and earlier with no account binding. */
  legacyConnectionUnbound?: boolean;
}

interface HeadObjectSummary {
  content_length: number;
}

const BROWSER_UPLOAD_BYTES_LIMIT = 16 * 1024 * 1024;
const LEGACY_QUEUE_MANIFEST_KEY = "s3-sidekick.transfer-manifest.v1";
const TRANSFER_ID_SEQUENCE_KEY = "s3-sidekick.transfer-id-sequence.v1";
const TRANSFER_ERROR_PREFIX = "__S3_SIDEKICK_TRANSFER_ERROR__";
const PROVIDER_CANNOT_DELETE_MESSAGE =
  "This provider can't safely delete the source. Use Copy, then Delete.";
const RECOVERY_UNRESOLVED_MESSAGE =
  "Pending transfers from the last session are not resolved yet. Resume or discard them before starting new transfers.";
// Backend refusal from create_only.rs require_conditional_delete_support.
const PROVIDER_CANNOT_DELETE_PATTERN = /cannot enforce conditional DELETE/i;
const SESSION_REPLACEMENT_PATTERN =
  /connection changed|connection superseded|session (?:changed|closed|replaced|expired)|not connected/i;
const RECOVERY_DAMAGED_MESSAGE =
  "Saved transfer recovery data is damaged and was kept for repair. Discard it or keep it before starting new transfers.";

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

/**
 * A retry must never reuse an id that a pending cancel still targets. Minting
 * a fresh id keeps the old attempt's cancel (and any late progress event)
 * disconnected from the new attempt.
 */
function reassignTransferId(item: TransferItem): void {
  const previous = item.id;
  const next = allocateTransferId();
  item.id = next;
  // Any cancel still addressed to the previous id cannot reach this attempt.
  item.pauseCancelInFlight = false;
  if (selectedTransferId === previous) selectedTransferId = next;
}
let queue: TransferItem[] = [];
let processing = false;
let onComplete: ((summary: TransferRunSummary) => void) | null = null;
let progressUnlisten: UnlistenFn | null = null;
let downloadProgressUnlisten: UnlistenFn | null = null;
let renderQueued = false;
let fullRenderQueued = false;
const dirtyTransferIds = new Set<number>();
let stallTicker: ReturnType<typeof setInterval> | null = null;

function ensureStallTicker(): void {
  if (stallTicker !== null) return;
  stallTicker = setInterval(() => {
    if (!queue.some((item) => item.status === "uploading")) {
      if (stallTicker !== null) {
        clearInterval(stallTicker);
        stallTicker = null;
      }
      return;
    }
    queueRender();
  }, 1_000);
}

function stopStallTicker(): void {
  if (stallTicker !== null) {
    clearInterval(stallTicker);
    stallTicker = null;
  }
}
let cancelClickHandler: ((e: Event) => void) | null = null;
interface TrackedQueueListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
}
const trackedQueueListeners: TrackedQueueListener[] = [];
let recoveredQueue = false;
let recoveryInFlight: Promise<void> | null = null;
let conflictApplyAll: "skip" | "replace" | null = null;
const unguardedWriteAuthorizations = new Set<string>();
let conflictPromptQueue: Promise<void> = Promise.resolve();
let selectedTransferId: number | null = null;
let queuePaused = false;
/// Parked while the webview reports offline. New claims stop and retry waits
/// wake early so attempts park instead of churning through failures.
let offlineHold = false;
let manifestHydrated = false;
let manifestRecoveryUnresolved = false;
/** The stored recovery record is unreadable and kept for repair. */
let recoveryDamaged = false;
/** Legacy localStorage recovery is malformed and blocks enqueue until discarded. */
let legacyRecoveryMalformed = false;
let pendingRecoverySession: string | null = null;
let recoverySession: string | null = null;
let manifestWriteTail: Promise<void> = Promise.resolve();
let normalManifestWritePending = false;
let normalManifestClearRequested = false;
let lastPersistedManifestJson: string | null | undefined;
/** Session id the queue last ran against; a different id means replacement. */
let lastActiveConnectionId: string | null = null;
/** One registration pass even when init is called concurrently. */
let transferQueueInitInFlight: Promise<void> | null = null;

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
    unguardedWriteAuthorizations.clear();
  }
}

type UnguardedOperationClass =
  | "upload-put"
  | "upload-multipart"
  | "upload-unknown"
  | "copy-object"
  | "copy-multipart"
  | "copy-unknown";

function transferByteLength(item: TransferItem): number | undefined {
  if (item.operation === "upload") {
    if (item.browserFile) return item.browserFile.size;
    if (Number.isFinite(item.totalBytes) && item.totalBytes > 0) {
      return item.totalBytes;
    }
    if (Number.isFinite(item.size) && item.size > 0) return item.size;
    return undefined;
  }
  if (item.operation === "copy" || item.operation === "move") {
    // Prefix copies write objects one by one, nearly always below the
    // multipart threshold. Judge them by the single-object capability; the
    // backend fails closed on any large object and the worker then asks.
    if (item.sourcePrefix) return SMALL_OBJECT_BYTE_LENGTH;
    if (Number.isFinite(item.size) && item.size > 0) return item.size;
  }
  return undefined;
}

function unguardedOperationClass(
  item: TransferItem,
  byteLength: number | undefined,
): UnguardedOperationClass | null {
  if (item.operation === "upload") {
    if (byteLength === undefined) return "upload-unknown";
    return byteLength >= MULTIPART_UPLOAD_THRESHOLD_BYTES
      ? "upload-multipart"
      : "upload-put";
  }
  if (item.operation === "copy" || item.operation === "move") {
    if (byteLength === undefined) return "copy-unknown";
    return byteLength >= MULTIPART_COPY_THRESHOLD_BYTES
      ? "copy-multipart"
      : "copy-object";
  }
  return null;
}

function createOnlyCapabilityFingerprint(): string {
  const caps = state.createOnlyCapabilities;
  return `${Number(caps.put_object)}${Number(caps.complete_multipart)}${Number(caps.copy_object)}`;
}

function unguardedAuthorizationKey(
  item: TransferItem,
  connectionId: string,
): string | null {
  const operationClass = unguardedOperationClass(
    item,
    transferByteLength(item),
  );
  if (!operationClass || !item.connectionIdentity) return null;
  return [
    connectionId,
    item.connectionIdentity,
    createOnlyCapabilityFingerprint(),
    operationClass,
  ].join("\n");
}

async function confirmUnguardedTransferWrite(
  item: TransferItem,
  connectionId: string,
): Promise<boolean> {
  const authorizationKey = unguardedAuthorizationKey(item, connectionId);
  if (authorizationKey && unguardedWriteAuthorizations.has(authorizationKey)) {
    return true;
  }
  const { proceed, suppressed } = await promptUnguardedWrite();
  if (!proceed) return false;
  if (suppressed) return true;
  const remaining = queue.filter(
    (entry) =>
      (entry.status === "queued" || entry.status === "uploading") &&
      authorizationKey !== null &&
      unguardedAuthorizationKey(entry, connectionId) === authorizationKey,
  ).length;
  const others = remaining - 1;
  if (others > 0) {
    const applyAll = await showConfirm(
      TRANSFER_TEXT.applyToAllRemaining,
      `Write ${plural(others, "remaining transfer")} the same way on this provider? Without a create-only guard, an object that appears at the destination during the transfer can be overwritten.`,
      { okLabel: "Write all", cancelLabel: TRANSFER_TEXT.thisOneOnly },
    );
    if (applyAll && authorizationKey) {
      unguardedWriteAuthorizations.add(authorizationKey);
    }
  }
  return true;
}

function lacksAtomicCreateForTransferItem(item: TransferItem): boolean {
  const byteLength = transferByteLength(item);
  if (item.operation === "upload") {
    return lacksAtomicCreateForUpload(state.createOnlyCapabilities, byteLength);
  }
  if (item.operation === "copy" || item.operation === "move") {
    return lacksAtomicCreateForCopy(state.createOnlyCapabilities, byteLength);
  }
  return false;
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

const INVALID_LOCAL_GRANT_PATTERNS = [
  /local path grant/i,
  /grant (?:expired|is no longer valid)/i,
  /choose the path again/i,
  /re-select the (?:file|destination|path)/i,
  /changed since it was selected/i,
  /changed before it could be read/i,
  /local file is no longer (?:readable|accessible)/i,
  /granted upload path/i,
  /granted path (?:is a file|now resolves elsewhere)/i,
  /cannot inspect granted path/i,
  /symbolic link or reparse point for the granted path/i,
];

/**
 * Grant expiry, identity swaps, and size changes make the backend refuse the
 * same token forever. They are recoverable by asking the user once more, not
 * by turning the row into a permanent error.
 */
function isInvalidLocalGrantError(err: unknown): boolean {
  const text = normalizeError(err);
  return INVALID_LOCAL_GRANT_PATTERNS.some((pattern) => pattern.test(text));
}

function clearInvalidLocalGrant(item: TransferItem): void {
  if (item.operation === "upload") item.uploadToken = undefined;
  if (item.operation === "download") item.destinationToken = undefined;
  item.needsReselection = true;
  queueRender();
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

function pathLeaf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function uploadGrantMatchesItem(
  item: TransferItem,
  grant: { path: string; name?: string },
): "match" | "name" | "mismatch" {
  const expectedName = item.fileName.normalize("NFC");
  const selectedName = (
    grant.name && grant.name.length > 0 ? grant.name : pathLeaf(grant.path)
  ).normalize("NFC");
  if (selectedName !== expectedName) return "mismatch";
  const expectedSize =
    item.size > 0 ? item.size : item.totalBytes > 0 ? item.totalBytes : 0;
  const selectedSize = (grant as { size?: number }).size;
  if (
    expectedSize > 0 &&
    typeof selectedSize === "number" &&
    Number.isFinite(selectedSize) &&
    selectedSize !== expectedSize
  ) {
    return "name";
  }
  return "match";
}

async function grantRecoveredUpload(item: TransferItem): Promise<void> {
  item.needsReselection = true;
  queueRender();
  showToast(
    `Re-select ${item.fileName}. The saved grant expired or no longer matches.`,
    { type: "info", duration: 0 },
  );
  const picked = await pickUploadFiles(parentDirectory(item.filePath));
  const files = picked.filter((entry) => !entry.isDir);
  const nameMatches = files.filter(
    (entry) => uploadGrantMatchesItem(item, entry) !== "mismatch",
  );
  const exact = nameMatches.find(
    (entry) => uploadGrantMatchesItem(item, entry) === "match",
  );
  const near = nameMatches.find(
    (entry) => uploadGrantMatchesItem(item, entry) === "name",
  );
  if (!exact && near) {
    const expectedSize =
      item.size > 0 ? item.size : item.totalBytes > 0 ? item.totalBytes : 0;
    const selectedSize = (near as { size?: number }).size;
    throw new Error(
      `Re-selected file "${near.name || pathLeaf(near.path)}" does not match the recovered upload "${item.fileName}": expected ${expectedSize} bytes, selected ${selectedSize ?? "unknown"} bytes. Choose the original file.`,
    );
  }
  const grant = exact ?? nameMatches[0];
  if (!grant) {
    const selected =
      files.length > 0
        ? ` You selected ${files.map((entry) => entry.name || pathLeaf(entry.path)).join(", ")}.`
        : "";
    throw new Error(
      `Re-selected file does not match the recovered upload "${item.fileName}". Choose the original file.${selected}`,
    );
  }
  item.uploadToken = grant.token;
  item.filePath = grant.path;
  item.needsReselection = false;
  queueRender();
}

async function grantRecoveredDownload(item: TransferItem): Promise<void> {
  if (!item.destination) return;
  const directory = parentDirectory(item.destination);
  const siblings = queue.filter(
    (other) =>
      item.recovered === true &&
      other !== item &&
      other.recovered === true &&
      other.operation === "download" &&
      other.destination &&
      !other.destinationToken &&
      (other.status === "queued" || other.status === "error") &&
      parentDirectory(other.destination) === directory,
  );
  item.needsReselection = true;
  for (const row of [item, ...siblings]) row.needsReselection = true;
  queueRender();

  const applyDirectoryGrant = (grant: {
    token: string;
    path: string;
    isDir: boolean;
  }): void => {
    for (const row of [item, ...siblings]) {
      if (!row.destination) continue;
      const leaf = pathLeaf(row.destination);
      row.destinationName = leaf;
      row.destination = joinPath(grant.path, leaf, state.platformName);
      row.destinationToken = grant.token;
      row.tempPath = buildDownloadTempPath(row.destination);
      if (
        row.resumable &&
        getEffectiveTransferSettings().enableTransferResume
      ) {
        row.checkpointId = buildCheckpointId({
          operation: row.operation,
          bucket: row.bucket,
          key: row.key,
          destination: row.destination,
        });
      }
      row.needsReselection = false;
    }
    queueRender();
  };

  if (siblings.length > 0) {
    showToast(
      `Re-select the folder for ${plural(siblings.length + 1, "download")}.`,
      { type: "info", duration: 0 },
    );
    const grant = await pickDownloadDirectory(
      `Re-select folder for ${siblings.length + 1} downloads`,
      directory,
    );
    if (!grant) {
      throw new Error(
        "Download needs its destination folder re-selected after restart before it can continue.",
      );
    }
    applyDirectoryGrant(grant);
    return;
  }

  showToast(`Re-select the destination for ${item.fileName}.`, {
    type: "info",
    duration: 0,
  });
  const grant = await pickDownloadFile(
    item.fileName,
    `Re-select destination for ${item.fileName}`,
    directory,
  );
  if (!grant) {
    throw new Error(
      "Download needs its destination re-selected after restart before it can continue.",
    );
  }
  item.destination = grant.path;
  item.destinationName = undefined;
  item.destinationToken = grant.token;
  item.tempPath = buildDownloadTempPath(grant.path);
  const effective = getEffectiveTransferSettings();
  if (item.resumable && effective.enableTransferResume) {
    // The checkpoint is bound to its destination. Point it at the new grant
    // and leave the old record to the recovery sweep.
    item.checkpointId = buildCheckpointId({
      operation: item.operation,
      bucket: item.bucket,
      key: item.key,
      destination: grant.path,
    });
  }
  item.needsReselection = false;
  queueRender();
}

/**
 * A recovered row has no grant: grants live in backend memory for one
 * session. Re-ask through a native picker rather than trusting the path the
 * manifest recorded, which the webview could have written.
 */
async function ensureLocalPathGrant(item: TransferItem): Promise<void> {
  if (item.operation === "upload" && item.filePath && !item.uploadToken) {
    await grantRecoveredUpload(item);
  }
  if (
    item.operation === "download" &&
    item.destination &&
    !item.destinationToken
  ) {
    await grantRecoveredDownload(item);
  }
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

/// Share the backend per-transfer inflight budget across queued fan-out. The
/// backend clamps each transfer to 256MB inflight, but up to 10 queue workers
/// can run at once; scale part concurrency down as active transfers rise so
/// the fleet stays near one budget instead of N budgets.
const GLOBAL_PART_INFLIGHT_BUDGET_MB = 256;

function scalePartConcurrencyForGlobalBudget(
  requested: number,
  partSizeMb: number,
): number {
  const safeRequested =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1;
  const safePartMb =
    Number.isFinite(partSizeMb) && partSizeMb > 0 ? partSizeMb : 16;
  const activeCount = Math.max(
    1,
    queue.filter((t) => t.status === "uploading").length,
  );
  const perTransferMb = Math.max(1, safePartMb * activeCount);
  const budgeted = Math.floor(GLOBAL_PART_INFLIGHT_BUDGET_MB / perTransferMb);
  return Math.max(1, Math.min(safeRequested, budgeted));
}

/// The OS reports offline. Local and LAN endpoints (e.g. MinIO on this
/// machine) keep working without internet, so they are not held.
function offlineHoldActive(): boolean {
  return offlineHold && !isLocalEndpoint(state.endpoint);
}

/// Nothing may start: paused queue, offline hold, no S3 session, or a
/// disconnect in progress. Recovered rows stay queued with a visible hold
/// reason instead of being claimed and failed for a missing session.
function queueHeld(): boolean {
  return (
    queuePaused ||
    offlineHoldActive() ||
    state.transfersHeldForDisconnect ||
    !state.connected
  );
}

/** Why a claimed row must go back to the queue, if a hold applies. */
function queueParkReason(item: TransferItem): ParkReason | undefined {
  if (item.paused || queuePaused) return undefined;
  if (offlineHoldActive()) return "offline";
  if (state.transfersHeldForDisconnect) return "disconnected";
  if (!state.connected) return "no-connection";
  return undefined;
}

function syncOfflineHold(): void {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.onLine === "boolean"
  ) {
    offlineHold = !navigator.onLine;
  }
}

/**
 * A new live session replaced the one these rows were running against. The
 * old backend session cannot finish them; keep the work queued (not failed)
 * and let the user resume against the new connection. This mirrors the gate
 * `disconnect()` sets before it closes the backend session.
 */
function parkRowsForReplacedSession(newConnectionId: string): void {
  let parked = 0;
  for (const item of queue) {
    if (item.status !== "queued" && item.status !== "uploading") continue;
    if (!item.connectionId || item.connectionId === newConnectionId) continue;
    if (item.status === "uploading") pause(item);
    park(item, "session-replaced");
    item.paused = true;
    item.pauseCancelInFlight = false;
    parked += 1;
  }
  if (parked > 0) {
    const message = `${plural(parked, "transfer")} parked because the live session was replaced. Resume when the new connection is ready.`;
    logActivity(message, "warning");
    showToast(message, { type: "warning", duration: 0 });
  }
}

/// A refused scratch discard for a path that was never registered means there
/// is nothing to clean up, so cancelling must succeed rather than strand the
/// row as paused-with-error.
function isNothingToDiscardError(err: unknown): boolean {
  return /unregistered download scratch/i.test(normalizeError(err));
}

/// Base64 the browser-file payload (~1.4x) instead of a JSON number array
/// (~3-4x) for upload_object_bytes.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function shouldRetryError(err: unknown): boolean {
  // A re-pick gives these errors a new token; the original failure must not
  // become a permanent non-retry before that offer is made.
  if (isInvalidLocalGrantError(err)) return true;
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

/// Sleep that wakes promptly on cancel/pause/offline instead of waiting out
/// the full backoff. Callers re-check item state after it resolves.
function delayCancellable(ms: number, item: TransferItem): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(cleanupAndResolve, ms);
    const probe = setInterval(() => {
      if (item.cancelRequested || item.paused || queueHeld()) {
        cleanupAndResolve();
      }
    }, 50);
    function cleanupAndResolve(): void {
      clearTimeout(timer);
      clearInterval(probe);
      resolve();
    }
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
    failed: item.status === "error",
    error: item.status === "error" ? item.error : undefined,
    retryable:
      item.status === "error" && item.retryable === false ? false : undefined,
    // Rows the user kept unbound must stay recognisably legacy after a v6
    // rewrite, or the next session would try to run them without an account.
    legacyConnectionUnbound: item.legacyConnectionUnbound === true || undefined,
  };
}

function buildQueueManifestJson(): string | null {
  // Uploads are not resumable, so an in-flight upload that survives an app kill
  // would restart from byte 0. We drop active uploads from the manifest; queued
  // uploads that never started are still safe to persist. Terminal failures stay
  // durable so a transient connection or provider error cannot erase recovery
  // ownership before the user retries or explicitly clears the row.
  const pending = queue.filter(
    (item) =>
      (item.status === "queued" ||
        item.status === "uploading" ||
        item.status === "error") &&
      !(item.operation === "upload" && item.status === "uploading"),
  );
  if (pending.length === 0) return null;
  const payload: PersistedTransferManifest = {
    version: 6,
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

async function persistQueueManifestNow(
  forceClear = false,
  hydrated = manifestHydrated,
  capturedRecoverySession = recoverySession,
): Promise<void> {
  if (!hydrated) {
    persistLegacyQueueManifest(forceClear);
    return;
  }
  if (!capturedRecoverySession) {
    throw new Error(
      "Transfer recovery session is unavailable; reload the application.",
    );
  }

  const json = forceClear ? null : buildQueueManifestJson();
  if (
    lastPersistedManifestJson !== undefined &&
    json === lastPersistedManifestJson
  ) {
    return;
  }

  if (json) {
    await invoke("save_transfer_manifest", {
      json,
      recoverySession: capturedRecoverySession,
    });
  } else {
    await invoke("clear_transfer_manifest", {
      recoverySession: capturedRecoverySession,
    });
  }
  // Only deduplicate against a snapshot that reached durable storage.
  lastPersistedManifestJson = json;
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
  // A valid backend hydration has exclusive ownership until recovery is either
  // restored or discarded. Publishing an in-memory snapshot before that point
  // could overwrite the retained manifest with a newly queued transfer.
  if (manifestRecoveryUnresolved) return;

  if (forceClear) {
    normalManifestClearRequested = true;
  }
  if (normalManifestWritePending) return;

  normalManifestWritePending = true;
  const hydrated = manifestHydrated;
  const capturedRecoverySession = recoverySession;
  const write = enqueueQueueManifestOperation(() => {
    const shouldClear = normalManifestClearRequested;
    normalManifestClearRequested = false;
    // Calls made while this operation is in flight should schedule one trailing
    // write, while calls made before it starts can share this latest snapshot.
    normalManifestWritePending = false;
    return persistQueueManifestNow(
      shouldClear,
      hydrated,
      capturedRecoverySession,
    );
  });
  void write.catch(logQueueManifestWriteError);
}

function persistQueueManifestCritical(): Promise<void> {
  if (!manifestHydrated || !recoverySession) {
    return Promise.reject(
      new Error(
        "Secure transfer recovery storage is unavailable; source deletion was refused.",
      ),
    );
  }
  const capturedRecoverySession = recoverySession;
  return enqueueQueueManifestOperation(() =>
    persistQueueManifestNow(false, true, capturedRecoverySession),
  );
}

function writeQueueManifest(): void {
  scheduleQueueManifestWrite();
}

/** Refusal for enqueue calls while stored recovery is unresolved; null when allowed. */
function refuseIfRecoveryUnresolved(): EnqueueResult | null {
  if (!manifestRecoveryUnresolved) return null;
  if (legacyRecoveryMalformed) {
    const reason =
      "Saved legacy transfer recovery data is malformed. Discard it before starting new transfers.";
    logActivity(reason, "warning");
    showToast(reason, {
      type: "warning",
      duration: 0,
      actions: [
        {
          label: "Discard malformed recovery",
          onClick: () => {
            void discardMalformedRecovery().catch(() => undefined);
          },
        },
      ],
    });
    return { accepted: false, count: 0, reason };
  }
  const reason = recoveryDamaged
    ? RECOVERY_DAMAGED_MESSAGE
    : RECOVERY_UNRESOLVED_MESSAGE;
  logActivity(reason, "warning");
  showToast(reason, { type: "warning" });
  return { accepted: false, count: 0, reason };
}

function isCanonicalFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseCopyReceipts(value: unknown): CopyReceipt[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const receipts: CopyReceipt[] = [];
  const sourceKeys = new Set<string>();
  const destinationKeys = new Set<string>();
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
      receipt.source_key.length === 0 ||
      typeof receipt.source_etag !== "string" ||
      receipt.source_etag.length === 0 ||
      !isCanonicalFingerprint(receipt.source_fingerprint) ||
      !isCanonicalFingerprint(receipt.source_acl_fingerprint) ||
      !isCanonicalFingerprint(receipt.source_tag_fingerprint) ||
      // A null source version means an unversioned bucket, not a weak
      // receipt: deletion authority then comes from the ETag plus the
      // canonical fingerprints above, rechecked by the backend under its
      // mutation lease with a conditional delete. The literal "null" version
      // string some providers return for versioning-suspended objects is a
      // valid version pin and is preserved as-is; only a truly absent
      // version (null/undefined) takes the unversioned path.
      (receipt.source_version_id !== null &&
        typeof receipt.source_version_id !== "string") ||
      (typeof receipt.source_version_id === "string" &&
        receipt.source_version_id.trim().length === 0) ||
      typeof receipt.destination_key !== "string" ||
      receipt.destination_key.length === 0 ||
      typeof receipt.destination_etag !== "string" ||
      receipt.destination_etag.length === 0 ||
      !isCanonicalFingerprint(receipt.destination_fingerprint) ||
      !isCanonicalFingerprint(receipt.destination_acl_fingerprint) ||
      !isCanonicalFingerprint(receipt.destination_tag_fingerprint) ||
      (receipt.ownership_ambiguous !== undefined &&
        typeof receipt.ownership_ambiguous !== "boolean") ||
      (receipt.destination_version_id !== null &&
        typeof receipt.destination_version_id !== "string") ||
      sourceKeys.has(receipt.source_key) ||
      destinationKeys.has(receipt.destination_key)
    ) {
      return undefined;
    }
    sourceKeys.add(receipt.source_key);
    destinationKeys.add(receipt.destination_key);
    receipts.push({
      source_key: receipt.source_key,
      source_etag: receipt.source_etag,
      source_fingerprint: receipt.source_fingerprint,
      source_acl_fingerprint: receipt.source_acl_fingerprint,
      source_tag_fingerprint: receipt.source_tag_fingerprint,
      source_version_id: receipt.source_version_id,
      destination_key: receipt.destination_key,
      destination_etag: receipt.destination_etag,
      destination_fingerprint: receipt.destination_fingerprint,
      destination_acl_fingerprint: receipt.destination_acl_fingerprint,
      destination_tag_fingerprint: receipt.destination_tag_fingerprint,
      destination_version_id: receipt.destination_version_id,
      // Receipts written before ownership identity was recorded cannot prove
      // that an existing destination was created by this move. Preserve a
      // native explicit value, but treat a missing legacy field as ambiguous.
      ownership_ambiguous: receipt.ownership_ambiguous !== false,
    });
  }
  return receipts;
}

function validateFreshCopyReceipts(value: unknown): CopyReceipt[] {
  if (Array.isArray(value) && value.length === 0) return [];
  const receipts = parseCopyReceipts(value);
  if (!receipts) {
    throw new Error(
      "Copy returned incomplete source/destination safety fingerprints; source deletion was refused.",
    );
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
      (version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5 &&
        version !== 6) ||
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
      // Only v6 receipts carry complete source and destination HEAD/ACL/tag
      // authority plus a source version (immutable on versioned buckets, null
      // on unversioned ones). Older manifests and malformed v6 receipts keep
      // the row but lose the copied marker so recovery recopies rather than
      // authorizing deletion from weaker evidence.
      const receipts =
        version === 6 ? parseCopyReceipts(row.receipts) : undefined;
      const movePhase =
        version === 6 &&
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
        failed: row.failed === true,
        error: typeof row.error === "string" ? row.error : undefined,
        retryable: row.retryable === false ? false : undefined,
        legacyConnectionUnbound:
          (version < 4 || row.legacyConnectionUnbound === true) &&
          !(
            typeof row.connectionIdentity === "string" &&
            row.connectionIdentity.length > 0
          ),
      });
    }

    return { version: 6, items: valid };
  } catch {
    return null;
  }
}

async function cleanupRecoveredTempFiles(
  items: PersistedTransferItem[],
): Promise<string[]> {
  // A scratch path may only be discarded against a live destination grant.
  // Persisted rows never carry one (grants are process memory), so their
  // leftovers stay for `transfer_checkpoint_gc`, which validates the lease and
  // the derived temp path in the backend.
  const pending = items.filter(
    (item) => item.operation === "download" && !item.resumable,
  );
  if (pending.length === 0) return [];
  return [];
}

async function discardTransferRecoveryState(
  item: Pick<
    PersistedTransferItem,
    "operation" | "destination" | "checkpointId"
  > & { destinationToken?: string; destinationName?: string },
  hydratedRecoverySession: string | null = recoverySession,
): Promise<void> {
  // Scratch first. If it cannot be removed, retain its checkpoint/manifest so
  // next startup still has a durable path back to the file and can retry.
  if (item.operation === "download" && item.destinationToken) {
    await invoke("discard_download_scratch", {
      destinationToken: item.destinationToken,
      destinationName: item.destinationName ?? null,
    });
  }
  if (item.checkpointId) {
    if (!hydratedRecoverySession) {
      throw new Error(
        "Transfer recovery session is unavailable; reload the application.",
      );
    }
    await invoke("transfer_checkpoint_remove", {
      checkpointId: item.checkpointId,
      recoverySession: hydratedRecoverySession,
    });
  }
}

/// Best-effort scratch/checkpoint cleanup for rows dropped by the clear
/// actions below. Unlike terminal success, cleared error/skipped rows never
/// pass through the cancel path, so discard here or orphan the state.
function discardClearedRecoveryState(removed: TransferItem[]): void {
  if (
    !removed.some((item) => item.operation === "download" || item.checkpointId)
  ) {
    return;
  }
  void (async () => {
    // Checkpoint IDs and scratch paths derive from bucket/key/destination, so a
    // cleared failed row can share them with a live row that downloads the same
    // object to the same place. That live row owns the state.
    const live = queue.filter(
      (entry) => entry.status === "queued" || entry.status === "uploading",
    );
    const liveDestinations = new Set(
      live
        .filter((entry) => entry.operation === "download" && entry.destination)
        .map((entry) => entry.destination),
    );
    const liveCheckpoints = new Set(
      live.map((entry) => entry.checkpointId).filter(Boolean),
    );
    const failures: string[] = [];
    for (const item of removed) {
      if (item.operation !== "download" && !item.checkpointId) continue;
      if (
        (item.destination && liveDestinations.has(item.destination)) ||
        (item.checkpointId && liveCheckpoints.has(item.checkpointId))
      ) {
        continue;
      }
      try {
        await discardTransferRecoveryState(item);
      } catch (err) {
        failures.push(`${item.fileName}: ${normalizeError(err)}`);
      }
    }
    // Removing the checkpoint only drops its map to the scratch file. Sweep
    // the now-unreferenced leases so discarded recovered rows really remove
    // their temporary downloads.
    if (!recoverySession) {
      failures.push(
        "scratch cleanup: transfer recovery session is unavailable",
      );
    } else {
      try {
        await invoke("transfer_checkpoint_gc", {
          ttlHours: getEffectiveTransferSettings().transferCheckpointTtlHours,
          keepCheckpointIds: Array.from(liveCheckpoints) as string[],
          recoverySession,
        });
      } catch (err) {
        failures.push(`scratch cleanup: ${normalizeError(err)}`);
      }
    }
    if (failures.length > 0) {
      const message = `Cleared ${plural(failures.length, "transfer")}, but some saved resume data could not be removed: ${failures.join("; ")}`;
      logActivity(message, "warning");
      showToast(message, { type: "warning", duration: 0 });
    }
  })();
}

function restoreItemFromManifest(item: PersistedTransferItem): TransferItem {
  const resumable = item.resumable === true;
  // Parts already completed before the restart stay complete in the row.
  const totalParts =
    item.totalParts && item.totalParts > 0 ? item.totalParts : 0;
  const completedParts =
    totalParts > 0 && item.completedParts
      ? Math.min(item.completedParts, totalParts)
      : 0;
  const seededProgress =
    totalParts > 0 ? (completedParts / totalParts) * 100 : 0;
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
    status: item.failed ? "error" : "queued",
    error: item.failed
      ? item.error?.trim()
        ? item.error
        : "Transfer failed before the previous session ended."
      : undefined,
    progress: seededProgress,
    totalBytes: item.totalBytes,
    attempt: 1,
    maxAttempts: Math.max(maxAttemptsFromSettings(), item.maxAttempts),
    verified: false,
    conflictResolution: item.conflictResolution,
    phase: item.failed || item.paused ? "paused" : "running",
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
    legacyConnectionUnbound: item.legacyConnectionUnbound,
    recovered: true,
    retryable: item.retryable === false ? false : undefined,
  };
}

type RecoveryDecision = "resume" | "later" | "discard";

interface RecoveryCounts {
  toResume: number;
  failed: number;
  awaitingMoves: number;
}

function countRecoveryItems(items: PersistedTransferItem[]): RecoveryCounts {
  let failed = 0;
  let awaitingMoves = 0;
  for (const row of items) {
    if (row.failed) failed += 1;
    if (row.operation === "move" && row.movePhase === "copied") {
      awaitingMoves += 1;
    }
  }
  // Failed rows come back as failed, not as resumable work.
  return { toResume: items.length - failed, failed, awaitingMoves };
}

/**
 * Startup prompt for work left by the last session. Escape and "Decide later"
 * keep everything as it is. Discard needs a second, explicit confirmation.
 */
async function askRecoveryDecision(
  items: PersistedTransferItem[],
): Promise<RecoveryDecision> {
  const counts = countRecoveryItems(items);
  const lines = [`${counts.toResume} to resume.`];
  if (counts.failed > 0) lines.push(`${counts.failed} failed (need review).`);
  if (counts.awaitingMoves > 0) {
    lines.push(
      `${plural(counts.awaitingMoves, "move")} awaiting source deletion.`,
    );
  }
  for (;;) {
    const choice = await showChoiceDialog<RecoveryDecision>(
      "Resume transfers from last session?",
      lines.join("\n"),
      [
        { value: "resume", label: "Resume" },
        { value: "discard", label: "Discard", danger: true },
        { value: "later", label: "Decide later" },
      ],
      { cancelValue: "later", initialFocus: "resume" },
    );
    if (choice !== "discard") return choice;
    const confirmed = await showConfirm(
      "Discard recovered transfers?",
      `Discarding removes resume data and temporary download files for ${plural(items.length, "transfer")}. ` +
        "It does not delete any objects in storage. Moves that already copied keep their source objects and need manual reconciliation.",
      { okLabel: "Discard recovery data", cancelLabel: "Keep", okDanger: true },
    );
    if (confirmed) return "discard";
  }
}

/**
 * The backend holds recovery data this build cannot read. Keep it unchanged
 * unless the user explicitly discards it; never report it as a reload problem.
 */
async function handleDamagedRecoveryData(session: string): Promise<void> {
  recoveryDamaged = true;
  const choice = await showChoiceDialog<"discard" | "keep">(
    "Transfer recovery data is damaged",
    "Saved transfer recovery data is malformed or from an unsupported version, and it was kept unchanged. " +
      "Discarding clears the recovery record so unfinished transfers are not resumed. No objects in storage are changed; temporary files from unfinished downloads may remain on disk.",
    [
      { value: "discard", label: "Discard recovery data", danger: true },
      { value: "keep", label: "Keep for repair" },
    ],
    { cancelValue: "keep", initialFocus: "keep" },
  );
  if (choice !== "discard") {
    logActivity(RECOVERY_DAMAGED_MESSAGE, "warning");
    return;
  }
  const confirmed = await showConfirm(
    "Discard damaged recovery data?",
    "This cannot be undone. The unreadable recovery record will be deleted.",
    { okLabel: "Discard recovery data", cancelLabel: "Keep", okDanger: true },
  );
  if (!confirmed) {
    logActivity(RECOVERY_DAMAGED_MESSAGE, "warning");
    return;
  }
  await invoke("clear_transfer_manifest", { recoverySession: session });
  completeRecoveryHydration(session, null);
}

/**
 * Clear both the malformed legacy record and the backend recovery fence it
 * blocked. This is the visible escape hatch offered by the warning toast and
 * by every refused enqueue while the dead end is active.
 */
export async function discardMalformedRecovery(): Promise<void> {
  const session = pendingRecoverySession ?? recoverySession;
  if (!session) {
    throw new Error(
      "Transfer recovery session is unavailable; reload the application.",
    );
  }
  try {
    persistLegacyQueueManifest(true);
    await invoke("clear_transfer_manifest", { recoverySession: session });
    completeRecoveryHydration(session, null);
    const message =
      "Malformed legacy transfer recovery was discarded. New transfers can start again.";
    logActivity(message, "success");
    showToast(message, { type: "success" });
  } catch (err) {
    const message = `Could not discard malformed transfer recovery: ${normalizeError(err)}`;
    logActivity(message, "error");
    showToast(message, { type: "error", duration: 0 });
    throw err;
  }
}

function completeRecoveryHydration(
  hydratedRecoverySession: string,
  persistedManifestJson: string | null | undefined,
): void {
  recoverySession = hydratedRecoverySession;
  pendingRecoverySession = hydratedRecoverySession;
  manifestHydrated = true;
  manifestRecoveryUnresolved = false;
  recoveryDamaged = false;
  legacyRecoveryMalformed = false;
  lastPersistedManifestJson = persistedManifestJson;
  recoveredQueue = true;
}

async function recoverPendingQueueIfNeeded(): Promise<void> {
  if (recoveredQueue) return;

  // From this point until a terminal restore/discard result, the durable
  // backend manifest remains authoritative. Queue entry points and normal
  // manifest writes stay disabled so a failed hydration cannot be overwritten.
  manifestRecoveryUnresolved = true;
  const hydration = await invoke<TransferManifestHydration>(
    "load_transfer_manifest",
  );
  if (
    !hydration ||
    typeof hydration.recovery_session !== "string" ||
    hydration.recovery_session.length === 0 ||
    typeof hydration.manifest_json !== "string" ||
    typeof hydration.legacy_import_allowed !== "boolean"
  ) {
    throw new Error(
      "Transfer recovery hydration returned an invalid response; reload the application.",
    );
  }
  const hydratedRecoverySession = hydration.recovery_session;
  pendingRecoverySession = hydratedRecoverySession;
  const manifestRaw = hydration.manifest_json;

  // Browser storage is a one-time compatibility source. Once the backend closes
  // its durable fence, do not even read stale local data; best-effort removal
  // below is cleanup only and can never authorize an import.
  const legacyManifestRaw = hydration.legacy_import_allowed
    ? localStorage.getItem(LEGACY_QUEUE_MANIFEST_KEY)
    : null;
  let manifest = parseQueueManifest(manifestRaw);
  const backendHasManifest = manifestRaw.trim().length > 0;
  if (backendHasManifest && !manifest) {
    await handleDamagedRecoveryData(hydratedRecoverySession);
    return;
  }
  let legacyManifestMigrated = false;
  if (!manifest && hydration.legacy_import_allowed) {
    manifest = parseQueueManifest(legacyManifestRaw);
    if (legacyManifestRaw?.trim() && !manifest) {
      legacyRecoveryMalformed = true;
      recoveryDamaged = true;
      const message =
        "Saved legacy transfer recovery data is malformed. Discard it before starting new transfers; no storage objects are changed.";
      logActivity(message, "warning");
      showToast(message, {
        type: "warning",
        duration: 0,
        actions: [
          {
            label: "Discard malformed recovery",
            onClick: () => {
              void discardMalformedRecovery().catch(() => undefined);
            },
          },
        ],
      });
      throw new Error(message);
    }
    if (manifest) {
      await invoke("save_transfer_manifest", {
        json: JSON.stringify(manifest),
        recoverySession: hydratedRecoverySession,
        legacyImport: true,
      });
      legacyManifestMigrated = true;
    }
  }
  if (
    !hydration.legacy_import_allowed ||
    backendHasManifest ||
    legacyManifestMigrated ||
    !legacyManifestRaw
  ) {
    try {
      persistLegacyQueueManifest(true);
    } catch (err) {
      logQueueManifestWriteError(err);
    }
  }

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
  try {
    await invoke("transfer_checkpoint_gc", {
      ttlHours: effective.transferCheckpointTtlHours,
      keepCheckpointIds: liveCheckpointIds,
      recoverySession: hydratedRecoverySession,
    });
  } catch (err) {
    // Garbage collection only reclaims disk space. A locked scratch file or
    // an unreadable lease must not leave every transfer blocked behind an
    // unresolved recovery; the next launch tries again.
    logActivity(
      `Could not reclaim expired transfer checkpoints: ${normalizeError(err)}`,
      "warning",
    );
  }
  if (!manifest || manifest.items.length === 0) {
    await invoke("clear_transfer_manifest", {
      recoverySession: hydratedRecoverySession,
    });
    completeRecoveryHydration(hydratedRecoverySession, null);
    return;
  }

  if (!document.getElementById("dialog-overlay")) {
    await invoke("clear_transfer_manifest", {
      recoverySession: hydratedRecoverySession,
    });
    completeRecoveryHydration(hydratedRecoverySession, null);
    return;
  }

  const decision = await askRecoveryDecision(manifest.items);
  if (decision === "later") {
    // Nothing runs and the manifest stays durable. Queue entry points refuse
    // until the user resumes or discards the pending work.
    logActivity(
      `${plural(manifest.items.length, "pending transfer")} kept for later. ${RECOVERY_UNRESOLVED_MESSAGE}`,
      "warning",
    );
    return;
  }

  if (decision === "discard") {
    const failures: string[] = [];
    for (const row of manifest.items) {
      try {
        await discardTransferRecoveryState(row, hydratedRecoverySession);
      } catch (err) {
        failures.push(`${row.fileName}: ${normalizeError(err)}`);
      }
    }
    // Checkpoint removal alone leaves the derived scratch file on disk. Sweep
    // every lease that no surviving checkpoint references before clearing the
    // manifest, and surface a failure instead of claiming the files are gone.
    try {
      await invoke("transfer_checkpoint_gc", {
        ttlHours: getEffectiveTransferSettings().transferCheckpointTtlHours,
        keepCheckpointIds: [],
        recoverySession: hydratedRecoverySession,
      });
    } catch (err) {
      failures.push(`scratch cleanup: ${normalizeError(err)}`);
    }
    if (failures.length > 0) {
      // Their download leases remain on disk, so the recovery sweep reclaims
      // any scratch left behind once no checkpoint references it.
      const message = `Could not fully discard ${failures.length} transfer(s); leftover files will be cleaned up later.`;
      logActivity(`${message} ${failures.join("; ")}`, "warning");
      showToast(message, { type: "warning" });
    }
    await invoke("clear_transfer_manifest", {
      recoverySession: hydratedRecoverySession,
    });
    completeRecoveryHydration(hydratedRecoverySession, null);
    return;
  }

  // Resume: only now may non-resumable scratch be reclaimed. Before the
  // decision the user's partial downloads are left exactly as they were.
  const tempCleanupFailures = await cleanupRecoveredTempFiles(manifest.items);
  if (tempCleanupFailures.length > 0) {
    // Leftover scratch only costs disk space: its lease stays on disk and the
    // recovery sweep reclaims it later. Refusing to recover would instead
    // block every transfer until the files could be removed.
    const message = `Could not clean ${tempCleanupFailures.length} interrupted download(s); their scratch files will be retried later.`;
    logActivity(`${message} ${tempCleanupFailures.join("; ")}`, "warning");
    showToast(message, { type: "warning" });
  }

  for (const row of manifest.items) {
    queue.push(restoreItemFromManifest(row));
  }
  renderQueue();
  showTransferQueue();
  completeRecoveryHydration(hydratedRecoverySession, manifestRaw);
  await resumeRecoveredTransfersAfterConnect();
}

interface TransferProgressPayload {
  transfer_id: number;
  bytes_sent: number;
  total_bytes: number;
  attempt?: number;
  phase?:
    | "running"
    | "preparing"
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

interface ProgressUpdateResult {
  item: TransferItem;
  manifestChanged: boolean;
}

function applyProgressPayload(
  payload: TransferProgressPayload,
): ProgressUpdateResult | null {
  const item = queue.find((t) => t.id === payload.transfer_id);
  if (!item) return null;

  let manifestChanged = false;
  if (
    typeof payload.attempt === "number" &&
    Number.isInteger(payload.attempt) &&
    payload.attempt > 0
  ) {
    const nextAttempt = Math.max(item.attempt, payload.attempt);
    if (item.attempt !== nextAttempt) {
      item.attempt = nextAttempt;
      manifestChanged = true;
    }
  }
  if (
    payload.phase === "running" ||
    payload.phase === "preparing" ||
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
  if (item.totalBytes !== payload.total_bytes) {
    item.totalBytes = payload.total_bytes;
    manifestChanged = true;
  }
  if (typeof payload.speed_bps === "number" && payload.speed_bps >= 0) {
    item.speedBps = payload.speed_bps;
  }
  item.lastProgressAt = Date.now();
  if (typeof payload.eta_seconds === "number" && payload.eta_seconds >= 0) {
    item.etaSeconds = payload.eta_seconds;
  }
  if (
    typeof payload.completed_parts === "number" &&
    Number.isInteger(payload.completed_parts) &&
    item.completedParts !== payload.completed_parts
  ) {
    item.completedParts = payload.completed_parts;
    manifestChanged = true;
  }
  if (
    typeof payload.total_parts === "number" &&
    Number.isInteger(payload.total_parts) &&
    item.totalParts !== payload.total_parts
  ) {
    item.totalParts = payload.total_parts;
    manifestChanged = true;
  }
  if (
    typeof payload.checkpoint_id === "string" &&
    payload.checkpoint_id &&
    item.checkpointId !== payload.checkpoint_id
  ) {
    item.checkpointId = payload.checkpoint_id;
    manifestChanged = true;
  }
  if (
    typeof payload.resumable === "boolean" &&
    item.resumable !== payload.resumable
  ) {
    item.resumable = payload.resumable;
    manifestChanged = true;
  }

  return { item, manifestChanged };
}

function isIncludedInQueueManifest(item: TransferItem): boolean {
  return (
    (item.status === "queued" ||
      item.status === "uploading" ||
      item.status === "error") &&
    !(item.operation === "upload" && item.status === "uploading")
  );
}

export function prepareTransferRecovery(): void {
  if (!recoveredQueue) {
    manifestRecoveryUnresolved = true;
  }
}

export function recoverPendingTransfers(): Promise<void> {
  if (recoveredQueue) return Promise.resolve();
  recoveryInFlight ??= recoverPendingQueueIfNeeded().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

/**
 * Resume hydrated recovery only after native connection establishment has
 * published a trustworthy account identity. Legacy beta.4 manifests did not
 * record that identity, so they require explicit account binding and a durable
 * v5 rewrite before any S3 command is allowed to run.
 */
let resumeAfterConnectInFlight: Promise<void> | null = null;
/// Connection that already answered the legacy binding prompt. Recovery and
/// the connect flow both resume, so without this "Keep for later" would be
/// asked again moments later on the same connection.
let legacyBindingPromptedConnectionId: string | null = null;

export function resumeRecoveredTransfersAfterConnect(): Promise<void> {
  // A new session replaced the one active transfers were using. Park those
  // rows before releasing the disconnect gate so they cannot fail against a
  // session that no longer exists.
  if (
    lastActiveConnectionId &&
    state.connectionId &&
    lastActiveConnectionId !== state.connectionId
  ) {
    parkRowsForReplacedSession(state.connectionId);
  }
  if (state.connectionId) lastActiveConnectionId = state.connectionId;
  // A connection is established again; transfers parked by a disconnect may
  // run (items for another account are paused below).
  if (state.connected && state.connectionIdentity) {
    state.transfersHeldForDisconnect = false;
  }
  // Recovery and the connect flow both call this; one pass must not show the
  // legacy binding prompt twice.
  resumeAfterConnectInFlight ??= resumeRecoveredTransfersOnce().finally(() => {
    resumeAfterConnectInFlight = null;
  });
  return resumeAfterConnectInFlight;
}

async function resumeRecoveredTransfersOnce(): Promise<void> {
  if (
    !recoveredQueue ||
    !state.connected ||
    !state.connectionId ||
    !state.connectionIdentity
  ) {
    return;
  }

  const legacyItems = queue.filter((item) => item.legacyConnectionUnbound);
  if (
    legacyItems.length > 0 &&
    legacyBindingPromptedConnectionId !== state.connectionId
  ) {
    legacyBindingPromptedConnectionId = state.connectionId;
    const buckets = Array.from(
      new Set(
        legacyItems.flatMap((item) =>
          [item.sourceBucket ?? item.bucket, item.destinationBucket].filter(
            (bucket): bucket is string => Boolean(bucket),
          ),
        ),
      ),
    )
      .sort()
      .join(", ");
    const includesMove = legacyItems.some((item) => item.operation === "move");
    const warning = includesMove
      ? " Some recovered moves may delete their source objects after verifying the copied destination."
      : "";
    const confirmed = await showConfirm(
      "Bind Recovered Transfers",
      `Beta.4 did not record which account owned these ${legacyItems.length} transfer(s). Bind them to the currently connected endpoint ${state.endpoint} for bucket(s) ${buckets || "unknown"}?${warning}`,
      {
        okLabel: "Bind to this account",
        cancelLabel: "Keep for later",
        okDanger: includesMove,
      },
    );
    if (!confirmed) {
      // Keep them parked, not queued: unbound rows cannot run, and a worker
      // claiming them would fail them for a missing account identity.
      for (const item of legacyItems) {
        if (item.status === "queued") pause(item);
      }
      writeQueueManifest();
      queueRender();
      return;
    }

    const previous = legacyItems.map((item) => ({
      item,
      connectionId: item.connectionId,
      connectionIdentity: item.connectionIdentity,
      legacyConnectionUnbound: item.legacyConnectionUnbound,
      paused: item.paused,
      phase: item.phase,
    }));
    for (const item of legacyItems) {
      item.connectionId = state.connectionId;
      item.connectionIdentity = state.connectionIdentity;
      item.legacyConnectionUnbound = false;
      if (item.status === "queued" && item.paused) {
        // Parked by an earlier "Keep for later"; binding releases them.
        releaseHold(item);
      }
    }
    try {
      await persistQueueManifestCritical();
    } catch (error) {
      for (const saved of previous) {
        saved.item.connectionId = saved.connectionId;
        saved.item.connectionIdentity = saved.connectionIdentity;
        saved.item.legacyConnectionUnbound = saved.legacyConnectionUnbound;
        saved.item.paused = saved.paused;
        saved.item.phase = saved.phase;
      }
      throw new Error(
        `Recovered transfers were not bound because the durable manifest update failed: ${normalizeError(error)}`,
      );
    }
  }

  let mismatched = 0;
  for (const item of queue) {
    if (item.status !== "queued") continue;
    const identityMatches =
      !item.connectionIdentity ||
      item.connectionIdentity === state.connectionIdentity;
    if (isAutoParked(item) && identityMatches) {
      // A disconnect/session-replacement hold is not a user pause. Rebind it
      // to the fresh session and let the queue resume automatically.
      item.connectionId = state.connectionId;
      item.connectionIdentity = state.connectionIdentity;
      releaseHold(item);
      continue;
    }
    if (item.paused) continue;
    if (!identityMatches) {
      pause(item);
      mismatched += 1;
      continue;
    }
    item.connectionId = state.connectionId;
  }
  if (mismatched > 0) {
    const message = `${mismatched} recovered transfer(s) belong to a different account and were kept paused.`;
    logActivity(message, "warning");
    showToast(message, { type: "warning", duration: 0 });
    writeQueueManifest();
  }

  // The queue can run for hours. Callers (the connect flow) must not stay
  // busy until it drains, so start it and return.
  void processQueue().catch((err: unknown) => {
    logActivity(
      `Transfer queue stopped unexpectedly: ${normalizeError(err)}`,
      "error",
    );
  });
}

function trackQueueListener(
  target: EventTarget | null,
  type: string,
  listener: EventListener,
): void {
  if (!target) return;
  if (
    trackedQueueListeners.some(
      (entry) =>
        entry.target === target &&
        entry.type === type &&
        entry.listener === listener,
    )
  ) {
    return;
  }
  target.addEventListener(type, listener);
  trackedQueueListeners.push({ target, type, listener });
}

function handleQueueOffline(): void {
  offlineHold = true;
  logActivity("Network offline — transfer queue parked.", "warning");
  queueRender();
}

function handleQueueOnline(): void {
  offlineHold = false;
  if (!state.connected) {
    logActivity("Network restored — connect to resume transfers.", "info");
    queueRender();
    return;
  }
  logActivity("Network restored — resuming transfer queue.", "info");
  queueRender();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

function handleTransferMoreClick(event: Event): void {
  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  showContextMenu(
    rect.left,
    rect.bottom + 4,
    [
      {
        label: "Prioritize selected",
        action: "prioritize",
        ...prioritizeAvailability(),
      },
      { label: TRANSFER_TEXT.retryFailed, action: "retry-failed" },
      { label: "Retry skipped", action: "retry-skipped" },
      { label: TRANSFER_TEXT.clearCompleted, action: "clear-completed" },
      { label: TRANSFER_TEXT.clearFailed, action: "clear-failed" },
    ],
    (action) => {
      if (action === "prioritize") prioritizeSelectedTransfer();
      else if (action === "retry-failed") retryFailedTransfers();
      else if (action === "retry-skipped") retrySkippedTransfers();
      else if (action === "clear-completed") clearCompletedTransfers();
      else if (action === "clear-failed") void clearFailedTransfers();
    },
  );
}

export function initTransferQueueUI(): Promise<void> {
  // `listen()` is async, so two callers can both observe a null unlisten and
  // register duplicate Tauri listeners. One in-flight registration is shared.
  transferQueueInitInFlight ??= initializeTransferQueueUI().finally(() => {
    transferQueueInitInFlight = null;
  });
  return transferQueueInitInFlight;
}

async function initializeTransferQueueUI(): Promise<void> {
  updateQueueChrome();
  syncOfflineHold();

  if (typeof window !== "undefined") {
    trackQueueListener(window, "offline", handleQueueOffline);
    trackQueueListener(window, "online", handleQueueOnline);
  }

  progressUnlisten ??= await listen<TransferProgressPayload>(
    "upload-progress",
    (event) => {
      const update = applyProgressPayload(event.payload);
      if (!update) return;
      queueRender(update.item.id);
      if (update.manifestChanged && isIncludedInQueueManifest(update.item)) {
        writeQueueManifest();
      }
    },
  );

  downloadProgressUnlisten ??= await listen<TransferProgressPayload>(
    "download-progress",
    (event) => {
      const update = applyProgressPayload(event.payload);
      if (!update) return;
      queueRender(update.item.id);
      if (update.manifestChanged && isIncludedInQueueManifest(update.item)) {
        writeQueueManifest();
      }
    },
  );

  trackQueueListener(
    document.getElementById("transfer-pause-all"),
    "click",
    pauseAllTransfers,
  );
  trackQueueListener(
    document.getElementById("transfer-resume-all"),
    "click",
    resumeAllTransfers,
  );
  trackQueueListener(
    document.getElementById("transfer-more"),
    "click",
    handleTransferMoreClick,
  );

  const list = document.getElementById("transfer-list");
  if (list && !cancelClickHandler) {
    cancelClickHandler = (e: Event) => {
      const target = e.target as HTMLElement;
      const row = target.closest(".transfer-item") as HTMLElement | null;
      if (!row) return;
      const id = Number(row.dataset.id);
      if (!id) return;

      const action = target.closest<HTMLElement>("button[data-action]")?.dataset
        .action;
      if (action === "cancel") {
        void cancelTransferItem(id);
        return;
      }
      if (action === "pause") {
        togglePauseTransferItem(id);
        return;
      }
      if (action === "retry") {
        retryTransfer(id);
        return;
      }
      if (action === "remove") {
        void removeTransfer(id);
        return;
      }
      if (action === "copy-error") {
        void copyTransferError(id);
        return;
      }
      if (action === "reveal") {
        void revealTransferDestination(id);
        return;
      }
      if (action === "reselect") {
        void reselectTransferPath(id);
        return;
      }
      selectedTransferId = id;
      queueRender(id);
    };
    list.addEventListener("click", cancelClickHandler);
  }

  queueRender();
}

export function disposeTransferQueueUI(): void {
  stopStallTicker();
  for (const { target, type, listener } of trackedQueueListeners.splice(0)) {
    target.removeEventListener(type, listener);
  }
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

function cancelTransferForCurrentSession(id: number): Promise<unknown> {
  return invoke("cancel_transfer", {
    connectionId: state.connectionId,
    transferId: id,
  });
}

function pauseAllTransfers(): void {
  queuePaused = true;
  for (const item of queue) {
    if (item.status !== "queued" && item.status !== "uploading") continue;
    // In-flight uploads would have to restart from zero if interrupted, so let
    // them run to completion. Downloads resume cleanly, so cancelling them to
    // pause is safe; queued items simply stay queued.
    if (item.operation === "upload" && item.status === "uploading") continue;
    if (pause(item)) {
      void cancelTransferForCurrentSession(item.id).catch(() => undefined);
    }
  }
  queueRender();
  writeQueueManifest();
}

function resumeAllTransfers(): void {
  queuePaused = false;
  for (const item of queue) {
    if (item.paused) {
      reassignTransferId(item);
      resume(item);
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
    if (resume(item)) {
      reassignTransferId(item);
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
    if (pause(item)) {
      void cancelTransferForCurrentSession(item.id).catch(() => undefined);
    }
  }
  queueRender();
  writeQueueManifest();
}

function isAmbiguousMove(item: TransferItem): boolean {
  return (
    item.operation === "move" &&
    item.receipts?.some((receipt) => receipt.ownership_ambiguous) === true
  );
}

/** A move whose copy is durable carries the only proof recovery may need. */
function hasReceiptBackedMoveProgress(item: TransferItem): boolean {
  return (
    item.operation === "move" &&
    (item.movePhase === "copied" || (item.receipts?.length ?? 0) > 0)
  );
}

function operationLabel(item: TransferItem): string {
  if (item.operation === "download") return "Download";
  if (item.operation === "upload") return "Upload";
  if (item.operation === "copy") return "Copy";
  return "Move";
}

/** The row's source and destination, for activity entries. */
function describeTransfer(item: TransferItem): string {
  if (item.operation === "download") {
    return `${item.bucket}/${item.key} to ${item.destination ?? item.fileName}`;
  }
  if (item.operation === "copy" || item.operation === "move") {
    const from = `${item.sourceBucket ?? item.bucket}/${item.sourceKey ?? item.sourcePrefix ?? item.key}`;
    const to = `${item.destinationBucket ?? item.bucket}/${item.destinationKey ?? item.destinationPrefix ?? ""}`;
    return `${from} to ${to}`;
  }
  return `${item.fileName} to ${item.bucket}/${item.key}`;
}

/** Why a queued or paused row is not moving, shown in its status text. */
function rowHoldLabel(
  item: TransferItem,
  endpoint: string | null,
): string | null {
  if (item.status !== "queued" && !item.paused) return null;
  if (queuePaused) return TRANSFER_TEXT.queuePaused;
  if (offlineHoldActive()) return "Waiting for network";
  if (state.transfersHeldForDisconnect) return "Waiting to reconnect";
  if (!state.connected) return CONNECT_TO_RESUME_MESSAGE;
  if (endpoint !== null) return `Connect to ${endpoint} to resume`;
  return null;
}

/** Recovered work exists but this session has no connection to run it. */
function awaitingEndpoint(): string | null {
  if (state.connected) return null;
  const hasWork = queue.some(
    (item) => item.status === "queued" || item.status === "uploading",
  );
  if (!hasWork) return null;
  return state.endpoint || "your storage";
}

function rowRenderOptions(
  item: TransferItem,
  endpointHold: string | null,
): {
  selectedTransferId: number | null;
  holdLabel: string | null;
} {
  return {
    selectedTransferId,
    holdLabel: rowHoldLabel(item, endpointHold),
  };
}

function logCancelled(item: TransferItem): void {
  logActivity(`Cancelled ${describeTransfer(item)}.`, "info");
}

/**
 * OS notification for work that needs the user while the window is in the
 * background. Best effort: the in-app state is already correct without it.
 */
async function notifyIfUnfocused(title: string, body: string): Promise<void> {
  if (!state.currentSettings.desktopNotifications) return;
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // No notification plugin or permission; nothing else to do.
  }
}

export function retryFailedTransfers(): void {
  let ambiguousMovesHeld = 0;
  for (const item of queue) {
    if (item.status !== "error" || item.retryable === false) continue;
    if (isAmbiguousMove(item)) {
      ambiguousMovesHeld += 1;
      continue;
    }
    resetForRetry(item, { clearPause: true });
    reassignTransferId(item);
  }
  if (ambiguousMovesHeld > 0) {
    const message = `${plural(ambiguousMovesHeld, "move")} still failed because destination ownership is unclear. Inspect both objects, then remove those rows.`;
    logActivity(message, "warning");
    showToast(message, { type: "warning", duration: 0 });
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
    resetForRetry(item, { clearPause: false });
    reassignTransferId(item);
  }
  queueRender();
  writeQueueManifest();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

/** Drop rows from the queue and any recovery state they still hold. */
function dropRows(removed: TransferItem[]): void {
  for (const item of removed) item.browserFile = undefined;
  const removedIds = new Set(removed.map((item) => item.id));
  queue = queue.filter((item) => !removedIds.has(item.id));
  discardClearedRecoveryState(removed);
  if (
    selectedTransferId != null &&
    !queue.some((item) => item.id === selectedTransferId)
  ) {
    selectedTransferId = null;
  }
  renderQueue();
  writeQueueManifest();
  resetConflictApplyAllWhenIdle();
}

const TERMINAL_HISTORY_LIMIT = 200;
const PRUNABLE_TERMINAL_STATUSES = new Set<TransferItem["status"]>([
  "done",
  "cancelled",
  "skipped",
]);

/**
 * Bound the finished-row history so a long session cannot grow the queue
 * forever. Failed rows stay: they need review and may carry recovery state.
 * Active rows and the user's selection are always kept.
 */
function pruneTerminalHistory(): void {
  const terminalCount = queue.filter(
    (item) =>
      item.status === "error" || PRUNABLE_TERMINAL_STATUSES.has(item.status),
  ).length;
  let excess = terminalCount - TERMINAL_HISTORY_LIMIT;
  if (excess <= 0) return;

  const removed: TransferItem[] = [];
  queue = queue.filter((item) => {
    if (excess <= 0) return true;
    if (!PRUNABLE_TERMINAL_STATUSES.has(item.status)) return true;
    if (item.id === selectedTransferId) return true;
    if (hasReceiptBackedMoveProgress(item)) return true;
    excess -= 1;
    removed.push(item);
    return false;
  });
  if (removed.length > 0) discardClearedRecoveryState(removed);
}

/** Completed rows hold nothing to recover, so this removes them without asking. */
export function clearCompletedTransfers(): void {
  const removed = queue.filter((item) => item.status === "done");
  if (removed.length > 0) dropRows(removed);
  if (queue.length === 0) {
    hideTransferQueue();
  }
}

/**
 * Failed rows may hold resume data, so removing them needs a confirmation.
 * Moves whose ownership is unclear stay until both objects are inspected, and
 * any receipt-backed copied move keeps its durable progress even when the
 * copy's ownership was unambiguous.
 */
export async function clearFailedTransfers(): Promise<void> {
  const heldMoves = queue.filter(
    (item) => item.status === "error" && hasReceiptBackedMoveProgress(item),
  );
  const removable = queue.filter(
    (item) => item.status === "error" && !hasReceiptBackedMoveProgress(item),
  );
  if (heldMoves.length > 0) {
    const ambiguous = heldMoves.filter(isAmbiguousMove).length;
    const message =
      ambiguous > 0
        ? `${plural(heldMoves.length, "move")} kept because their copies are recorded${ambiguous > 0 ? " and destination ownership is unclear" : ""}. Inspect both objects, then remove those rows if reconciliation is complete.`
        : `${plural(heldMoves.length, "move")} kept because their copies are already recorded. Retry to finish source deletion or inspect both objects.`;
    logActivity(message, "warning");
    showToast(message, { type: "warning" });
  }
  if (removable.length === 0) return;

  const confirmed = await showConfirm(
    "Clear failed transfers?",
    `Remove ${plural(removable.length, "failed transfer")} from the list? Their saved resume data is discarded. No objects in storage are changed.`,
    { okLabel: TRANSFER_TEXT.remove, cancelLabel: "Keep", okDanger: true },
  );
  if (!confirmed) return;

  // The dialog was open; only rows that are still failed are removed.
  const current = queue.filter(
    (item) =>
      item.status === "error" &&
      !hasReceiptBackedMoveProgress(item) &&
      removable.some((row) => row.id === item.id),
  );
  if (current.length > 0) dropRows(current);
}

/** Remove one finished, failed or cancelled row. Active rows are cancelled instead. */
export async function removeTransfer(id: number): Promise<void> {
  const item = queue.find((row) => row.id === id);
  if (!item) return;
  if (hasReceiptBackedMoveProgress(item)) {
    const message = `Its copy is already recorded, so ${item.fileName} stays until the source deletion finishes or both objects are inspected.`;
    logActivity(message, "warning");
    showToast(message, { type: "warning" });
    return;
  }
  if (item.status === "queued" || item.status === "uploading") return;
  if (item.status === "error") {
    const confirmed = await showConfirm(
      "Remove failed transfer?",
      `Remove ${item.fileName} from the list? Its saved resume data is discarded. No objects in storage are changed.`,
      { okLabel: TRANSFER_TEXT.remove, cancelLabel: "Keep", okDanger: true },
    );
    if (!confirmed) return;
  }
  // The dialog may have been open while the row changed.
  const current = queue.find((row) => row.id === id);
  if (
    !current ||
    current.status === "queued" ||
    current.status === "uploading"
  ) {
    return;
  }
  dropRows([current]);
}

/** Put one failed row back in the queue. Other rows are left alone. */
export function retryTransfer(id: number): void {
  const item = queue.find((row) => row.id === id);
  if (item?.status !== "error") return;
  if (item.retryable === false || isAmbiguousMove(item)) return;
  resetForRetry(item, { clearPause: true });
  reassignTransferId(item);
  queueRender();
  writeQueueManifest();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
}

/**
 * Re-open the local picker for one row whose grant expired, was invalidated,
 * or was never present after recovery. A completed download only needs the
 * reveal grant refreshed; queued/failed work resumes through the queue.
 */
export async function reselectTransferPath(id: number): Promise<void> {
  const item = queue.find((row) => row.id === id);
  if (!item) return;
  clearInvalidLocalGrant(item);
  try {
    await ensureLocalPathGrant(item);
    if (item.status === "uploading" || item.status === "queued") {
      reassignTransferId(item);
      if (item.paused) {
        item.paused = false;
        item.phase = "resuming";
      }
      void processQueue().catch((err) =>
        logActivity(
          `Transfer processing error: ${normalizeError(err)}`,
          "error",
        ),
      );
    } else if (item.status === "error") {
      resetForRetry(item, { clearPause: true });
      reassignTransferId(item);
      void processQueue().catch((err) =>
        logActivity(
          `Transfer processing error: ${normalizeError(err)}`,
          "error",
        ),
      );
    } else if (item.status === "done") {
      showToast(`Path re-selected for ${item.fileName}.`, { type: "success" });
    }
    item.error = undefined;
    renderQueue();
    writeQueueManifest();
  } catch (err) {
    const message = `Could not re-select the path for ${item.fileName}: ${normalizeError(err)}`;
    item.needsReselection = true;
    item.error = message;
    logActivity(message, "error");
    showToast(message, { type: "error", duration: 0 });
    renderQueue();
  }
}

async function copyTransferError(id: number): Promise<void> {
  const item = queue.find((row) => row.id === id);
  if (!item?.error) return;
  try {
    await navigator.clipboard.writeText(item.error);
    showToast("Error copied.", { type: "success" });
  } catch {
    showToast("Could not copy the error.", { type: "error" });
  }
}

/** Show a completed download's file in the file manager, using the destination stored on its row. */
async function revealTransferDestination(id: number): Promise<void> {
  const item = queue.find((row) => row.id === id);
  if (
    !item?.destination ||
    item.operation !== "download" ||
    item.status !== "done"
  ) {
    return;
  }
  try {
    if (!item.destinationToken) {
      throw new Error("re-select the download destination first");
    }
    await invoke("reveal_local_path", {
      token: item.destinationToken,
      name: item.destinationName ?? null,
    });
  } catch (err) {
    if (isInvalidLocalGrantError(err) || !item.destinationToken) {
      clearInvalidLocalGrant(item);
      try {
        await ensureLocalPathGrant(item);
        const token = item.destinationToken;
        if (!token) throw new Error("destination grant is still unavailable");
        await invoke("reveal_local_path", {
          token,
          name: item.destinationName ?? null,
        });
        writeQueueManifest();
        return;
      } catch (reselectErr) {
        showToast(
          `Could not show ${item.fileName} in its folder. Re-select its local path: ${friendlyError(reselectErr)}`,
          { type: "error", duration: 0 },
        );
        renderQueue();
        return;
      }
    }
    showToast(
      `Could not show ${item.fileName} in its folder: ${friendlyError(err)}`,
      { type: "error" },
    );
  }
}

/** Whether "Prioritize selected" applies, and the reason when it does not. */
function prioritizeAvailability(): {
  disabled: boolean;
  disabledReason?: string;
} {
  if (selectedTransferId == null) {
    return {
      disabled: true,
      disabledReason: "Select a queued transfer to move it to the front.",
    };
  }
  const index = queue.findIndex((item) => item.id === selectedTransferId);
  if (index < 0) {
    return { disabled: true, disabledReason: "The selected transfer is gone." };
  }
  if (index === 0) {
    return {
      disabled: true,
      disabledReason: "It is already first in the queue.",
    };
  }
  return { disabled: false };
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
  // The drawer already shows this queue; a toast pointing at it would repeat it.
  if (isDrawerOpen() && getActiveTab() === "transfers") return;
  // The in-memory dismissal is already set before the save; a failed save must
  // not turn into an unhandled rejection or re-show the hint this session.
  void markTransfersHintDismissed().catch(() => undefined);
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
): EnqueueResult {
  const refusal = refuseIfRecoveryUnresolved();
  if (refusal) return refusal;
  const queuedBefore = queue.length;
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const allFiles = Array.from(files);
  const maxAttempts = maxAttemptsFromSettings();
  for (const file of allFiles) {
    // A `File` object may carry a `.path` from the platform webview. That is a
    // renderer-supplied filesystem path, which no longer has authority; send
    // the bytes instead. Path-backed uploads come from the native picker,
    // which mints grants.
    const fileName = file.name.normalize("NFC");
    const key = targetPrefix + fileName;
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
      operation: "upload",
      bucket,
      fileName: file.name,
      filePath: "",
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
      `Queued ${plural(allFiles.length, "upload")} to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
  return { accepted: true, count: queue.length - queuedBefore };
}

export function enqueuePaths(
  files: UploadSelection[],
  targetPrefix: string,
  target?: TransferEnqueueTarget,
): EnqueueResult {
  const refusal = refuseIfRecoveryUnresolved();
  if (refusal) return refusal;
  const queuedBefore = queue.length;
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const maxAttempts = maxAttemptsFromSettings();
  for (const file of files) {
    const normalizedPath = file.path.trim();
    const parts = normalizedPath.replace(/\\/g, "/").split("/");
    const fileName = (parts[parts.length - 1] ?? "").normalize("NFC");
    const key = targetPrefix + fileName;
    queue.push({
      id: allocateTransferId(),
      connectionId: enqueueTarget.connectionId,
      connectionIdentity: enqueueTarget.connectionIdentity,
      operation: "upload",
      bucket,
      fileName,
      filePath: normalizedPath,
      uploadToken: file.token,
      key,
      size:
        Number.isFinite(file.size) && (file.size ?? 0) > 0
          ? (file.size ?? 0)
          : 0,
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

  if (files.length > 0) {
    logActivity(
      `Queued ${plural(files.length, "upload")} to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
  return { accepted: true, count: queue.length - queuedBefore };
}

export function enqueueFolderEntries(
  entries: FolderUploadEntry[],
  targetPrefix: string,
  target?: TransferEnqueueTarget,
): EnqueueResult {
  const refusal = refuseIfRecoveryUnresolved();
  if (refusal) return refusal;
  const queuedBefore = queue.length;
  const enqueueTarget = resolveEnqueueTarget(target);
  const bucket = enqueueTarget.bucket;
  const maxAttempts = maxAttemptsFromSettings();
  for (const entry of entries) {
    const rel = (
      state.platformName === "windows"
        ? entry.relative_path.replace(/\\/g, "/")
        : entry.relative_path
    )
      .replace(/^\/+/, "")
      .normalize("NFC");
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
      uploadToken: entry.file_token,
      key,
      size: entry.size,
      status: "queued",
      progress: 0,
      totalBytes:
        Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0,
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

  const queued = queue.length - queuedBefore;
  if (queued > 0) {
    logActivity(
      `Queued ${plural(queued, "file")} for folder upload to ${targetPrefix || "/"}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
  return { accepted: true, count: queue.length - queuedBefore };
}

export function enqueueDownloads(
  entries: DownloadQueueEntry[],
  target?: TransferEnqueueTarget,
): EnqueueResult {
  const refusal = refuseIfRecoveryUnresolved();
  if (refusal) return refusal;
  const queuedBefore = queue.length;
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
      destinationToken: entry.destinationToken,
      destinationName: entry.destinationName,
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

  const queued = queue.length - queuedBefore;
  if (queued > 0) {
    logActivity(`Queued ${plural(queued, "download")}.`, "info");
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
  return { accepted: true, count: queue.length - queuedBefore };
}

export function enqueueCopyMoveEntries(
  entries: CopyMoveQueueEntry[],
  target?: TransferEnqueueTarget,
): EnqueueResult {
  const refusal = refuseIfRecoveryUnresolved();
  if (refusal) return refusal;
  const queuedBefore = queue.length;
  const enqueueTarget = resolveEnqueueTarget(target);
  const maxAttempts = maxAttemptsFromSettings();
  for (const entry of entries) {
    const keyLike = entry.sourceKey ?? entry.sourcePrefix ?? "";
    const destinationLike =
      entry.destinationKey ?? entry.destinationPrefix ?? "";
    const item: TransferItem = {
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
      size: entry.size ?? 0,
      status: "queued",
      progress: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts,
      verified: false,
      conflictResolution:
        entry.conflictResolution ?? state.currentSettings.conflictPolicy,
      overwrite: entry.overwrite,
      phase: "running",
      speedBps: 0,
      etaSeconds: null,
      paused: false,
      cancelRequested: false,
      resumable: false,
      completedParts: 0,
      totalParts: 0,
    };
    if (item.overwrite === true) {
      item.overwriteScope =
        unguardedAuthorizationKey(item, enqueueTarget.connectionId) ??
        undefined;
    }
    queue.push(item);
  }

  const queued = queue.length - queuedBefore;
  if (queued > 0) {
    logActivity(
      `Queued ${plural(queued, "copy or move", "copies or moves")}.`,
      "info",
    );
  }

  renderQueue();
  writeQueueManifest();
  showTransferQueue();
  void processQueue().catch((err) =>
    logActivity(`Transfer processing error: ${normalizeError(err)}`, "error"),
  );
  return { accepted: true, count: queue.length - queuedBefore };
}

async function processQueue(): Promise<void> {
  if (processing) return;
  // No S3 session: recovered work stays queued with a "Connect to resume"
  // hold. Claiming it would fail every row on bindTransferConnection.
  if (!state.connected) {
    writeQueueManifest();
    return;
  }
  lastActiveConnectionId = state.connectionId || lastActiveConnectionId;
  const maxConcurrent = state.currentSettings.maxConcurrentTransfers;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    writeQueueManifest();
    return;
  }

  processing = true;
  ensureStallTicker();
  let completedUploadThisRun = false;
  let completedDownloadThisRun = false;
  let attemptedUploadThisRun = false;
  let attemptedDownloadThisRun = false;
  let attemptedCopyThisRun = false;
  let attemptedMoveThisRun = false;
  let completedCopyThisRun = false;
  let completedMoveThisRun = false;
  let uploadCount = 0;
  let downloadCount = 0;
  let copyCount = 0;
  let moveCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  const workers: Promise<void>[] = [];
  for (let i = 0; i < maxConcurrent; i += 1) {
    workers.push(runWorker());
  }

  function claimNextItem(): TransferItem | null {
    if (queueHeld()) return null;
    // A queued row being cancelled stays "queued" while its cleanup IPC runs;
    // claiming it then would run (or prompt for) a transfer the user dropped.
    const item = queue.find(isClaimable);
    if (item) claim(item);
    return item ?? null;
  }

  async function runWorker(): Promise<void> {
    while (true) {
      const item = claimNextItem();
      if (!item) break;

      if (item.operation === "upload") attemptedUploadThisRun = true;
      if (item.operation === "download") attemptedDownloadThisRun = true;
      if (item.operation === "copy") attemptedCopyThisRun = true;
      if (item.operation === "move") attemptedMoveThisRun = true;

      renderQueue();
      writeQueueManifest();

      try {
        const completed = await runItemWithRetry(item);
        // A run that parked before reaching the backend (paused again,
        // offline) has not consumed the pending cancel yet; keep the flag.
        if (completed) item.pauseCancelInFlight = false;
        if (completed && item.operation === "download") {
          completedDownloadThisRun = true;
          downloadCount += 1;
        }
        if (completed && item.operation === "upload") {
          completedUploadThisRun = true;
          uploadCount += 1;
        }
        if (completed && item.operation === "copy") {
          completedCopyThisRun = true;
          copyCount += 1;
        }
        if (completed && item.operation === "move") {
          completedMoveThisRun = true;
          moveCount += 1;
        }
        if (item.status === "skipped") skippedCount += 1;
      } catch (err) {
        const errorText = normalizeError(err);
        const pauseCancelled = item.pauseCancelInFlight === true;
        item.pauseCancelInFlight = false;
        if (item.cancelRequested) {
          if (isReceiptBackedCopiedMove(item)) {
            // The copy is durable and may have started deleting the source.
            // Terminal cancel would drop the only recovery receipts.
            holdReceiptBackedMoveForReview(item);
            errorCount += 1;
          } else {
            try {
              await discardTransferRecoveryState(item);
              markCancelled(item, "finalizing");
              logCancelled(item);
            } catch (cleanupErr) {
              if (isNothingToDiscardError(cleanupErr)) {
                markCancelled(item, "finalizing");
                logCancelled(item);
              } else {
                // Cleanup failed: the row is held as an error, so it is counted.
                const cleanupMessage = `Cancellation cleanup failed: ${normalizeError(cleanupErr)}`;
                holdAfterCancelFailure(item, cleanupMessage);
                errorCount += 1;
                logActivity(
                  `Cancellation cleanup failed for ${describeTransfer(item)}: ${normalizeError(cleanupErr)}`,
                  "error",
                );
                showToast(cleanupMessage, { type: "error", duration: 0 });
              }
            }
          }
        } else if (
          (state.transfersHeldForDisconnect ||
            !state.connected ||
            SESSION_REPLACEMENT_PATTERN.test(errorText)) &&
          /cancel|not connected|connection|session|expired/i.test(errorText)
        ) {
          // Interrupted by disconnect or a live session replacement: park it
          // for the next connection instead of failing every queued item.
          park(item, queueParkReason(item) ?? "session-replaced");
          if (SESSION_REPLACEMENT_PATTERN.test(errorText)) {
            item.paused = true;
            item.pauseCancelInFlight = false;
            if (state.connectionId) {
              parkRowsForReplacedSession(state.connectionId);
            }
          }
        } else if (
          (item.paused || pauseCancelled) &&
          /cancel/i.test(errorText)
        ) {
          // Stopped by a pause. If the user already resumed, requeue it to
          // run again instead of reporting the expected cancellation.
          requeueAfterPause(item);
          if (!item.paused) reassignTransferId(item);
        } else {
          // Providers that cannot enforce DeleteObject If-Match make a move
          // unsafe to retry automatically. Keep the source and say so plainly.
          const refusedByProvider =
            item.operation === "move" &&
            PROVIDER_CANNOT_DELETE_PATTERN.test(errorText);
          if (refusedByProvider) item.retryable = false;
          markFailed(
            item,
            refusedByProvider ? PROVIDER_CANNOT_DELETE_MESSAGE : errorText,
          );
          errorCount += 1;
          logActivity(
            `${operationLabel(item)} failed for ${describeTransfer(item)}: ${refusedByProvider ? PROVIDER_CANNOT_DELETE_MESSAGE : friendlyError(errorText)}`,
            "error",
          );
        }
      }

      pruneTerminalHistory();
      renderQueue();
      writeQueueManifest();
    }
  }

  await Promise.all(workers);
  // An enqueue continuation can land after the last worker claimed null but
  // before `processing` is cleared; without this drain loop that item would sit
  // queued until an unrelated pause/resume/online event arrived.
  while (!queueHeld() && queue.some(isClaimable)) {
    const drain: Promise<void>[] = [];
    for (let i = 0; i < maxConcurrent; i += 1) {
      drain.push(runWorker());
    }
    await Promise.all(drain);
  }
  processing = false;
  resetConflictApplyAllWhenIdle();

  if (
    onComplete &&
    (attemptedUploadThisRun ||
      attemptedDownloadThisRun ||
      attemptedCopyThisRun ||
      attemptedMoveThisRun ||
      errorCount > 0 ||
      skippedCount > 0)
  ) {
    const finished = uploadCount + downloadCount + copyCount + moveCount;
    if (errorCount > 0 || finished > 0) {
      void notifyIfUnfocused(
        "Transfers finished",
        errorCount > 0
          ? `${plural(errorCount, "transfer")} failed. Open Transfers to review.`
          : `${plural(finished, "transfer")} finished.`,
      );
    }
    onComplete({
      hadUpload: completedUploadThisRun,
      hadDownload: completedDownloadThisRun,
      hadListingChange:
        completedUploadThisRun || completedCopyThisRun || completedMoveThisRun,
      uploadCount,
      downloadCount,
      copyCount,
      moveCount,
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

function isReceiptBackedCopiedMove(item: TransferItem): boolean {
  return (
    item.operation === "move" &&
    item.movePhase === "copied" &&
    item.receipts !== undefined &&
    item.receipts.length > 0
  );
}

const CANCELLED_MOVE_REVIEW_MESSAGE =
  "Cancelled after the copy; source deletion is unfinished. Inspect both objects or retry to finish the move.";

/**
 * A move whose copy is already durable must not become a terminal cancelled
 * row: its receipts are the only proof of what the destination owns, and the
 * recovery manifest deliberately skips cancelled rows. Keep it as a failed
 * row so restart, retry and "clear failed" all still see the receipts.
 */
function holdReceiptBackedMoveForReview(item: TransferItem): void {
  item.cancelRequested = false;
  item.pauseCancelInFlight = false;
  markFailed(item, CANCELLED_MOVE_REVIEW_MESSAGE);
  logActivity(
    `Cancelled ${describeTransfer(item)} after its copy; source deletion is unfinished. Retry to finish the move or inspect both objects.`,
    "warning",
  );
  showToast(CANCELLED_MOVE_REVIEW_MESSAGE, { type: "warning", duration: 0 });
}

async function runItemWithRetry(item: TransferItem): Promise<boolean> {
  const maxAttempts = Math.max(1, item.maxAttempts, maxAttemptsFromSettings());
  item.maxAttempts = maxAttempts;
  let grantRepicked = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (item.paused || queueHeld()) {
      park(item, queueParkReason(item));
      return false;
    }
    // A cancel that arrived while no backend command owned this id must stop
    // the retry before it starts.
    if (item.cancelRequested) throw new Error("Cancelled");
    item.attempt = attempt;
    item.phase = "running";
    item.retryAt = undefined;
    item.speedBps = 0;
    item.etaSeconds = null;
    queueRender();
    writeQueueManifest();

    try {
      const connectionId = bindTransferConnection(item);
      // A receipt-backed copied move is already past the destination-write
      // decision. Re-entering generic conflict handling would interpret the
      // operation's own durable destination as a new conflict and could turn a
      // safe deletion retry into "skipped", dropping the receipts from the
      // recoverable manifest.
      const conflictOutcome = isReceiptBackedCopiedMove(item)
        ? { overwrite: false }
        : await resolveConflict(item, connectionId);
      ensureTransferActive(item);
      let outcome = conflictOutcome;
      if (outcome !== "skip" && outcome !== "cancel") {
        item.overwrite = outcome.overwrite;
        item.overwriteScope = outcome.overwrite
          ? (unguardedAuthorizationKey(item, connectionId) ?? undefined)
          : undefined;
        try {
          await executeTransfer(item, attempt, outcome.overwrite, connectionId);
        } catch (err) {
          // The backend refused a create-only write it cannot guard (e.g. a
          // large object inside a prefix copy). Ask, then write unguarded.
          if (outcome.overwrite || !isCreateOnlyUnsupportedError(err)) {
            throw err;
          }
          const authorized = await withConflictPromptLock(() =>
            confirmUnguardedTransferWrite(item, connectionId),
          );
          ensureTransferActive(item);
          outcome = authorized ? { overwrite: true } : "cancel";
          if (authorized) {
            item.overwrite = true;
            item.overwriteScope =
              unguardedAuthorizationKey(item, connectionId) ?? undefined;
            await executeTransfer(item, attempt, true, connectionId);
          }
        }
      }
      if (outcome === "cancel") {
        markCancelled(item);
        logActivity(
          `Cancelled ${describeTransfer(item)}: unconditional write was not authorized.`,
          "warning",
        );
        return false;
      }
      if (outcome === "skip") {
        markSkipped(item, "Skipped — destination exists");
        logActivity(
          `${operationLabel(item)} skipped for ${describeTransfer(item)}: destination exists.`,
          "warning",
        );
        return false;
      }
      // The backend command has committed the write. A pause or cancel that
      // arrived meanwhile (possibly dropped before the backend registered the
      // transfer) must not relabel finished work: a paused finished download
      // would re-prompt "Replace?" for its own file, and a finished move would
      // re-copy a source that no longer exists.
      item.phase = "verifying";
      queueRender();

      if (item.operation === "upload") {
        await verifyUploadedObject(item, connectionId);
      }

      markDone(item);

      if (item.operation === "download") {
        logActivity(`Downloaded ${describeTransfer(item)}.`, "success");
      } else if (item.operation === "upload") {
        logActivity(`Uploaded ${describeTransfer(item)}.`, "success");
      } else if (item.operation === "copy") {
        logActivity(`Copied ${describeTransfer(item)}.`, "success");
      } else {
        logActivity(`Moved ${describeTransfer(item)}.`, "success");
      }
      if (item.checkpointId && recoverySession) {
        const capturedRecoverySession = recoverySession;
        await invoke("transfer_checkpoint_remove", {
          checkpointId: item.checkpointId,
          recoverySession: capturedRecoverySession,
        }).catch(() => undefined);
      }
      return true;
    } catch (err) {
      // A disconnect is not a transient failure to back off from; the worker
      // parks the item until the next connection.
      if (state.transfersHeldForDisconnect || !state.connected) throw err;
      if (isInvalidLocalGrantError(err) && grantRepicked) {
        clearInvalidLocalGrant(item);
        throw new Error(
          `Local path grant is no longer usable; re-select the path for ${item.fileName}. ${normalizeError(err)}`,
        );
      }
      if (
        !grantRepicked &&
        isInvalidLocalGrantError(err) &&
        (item.operation === "upload" || item.operation === "download")
      ) {
        grantRepicked = true;
        logActivity(
          `${operationLabel(item)} for ${describeTransfer(item)} needs its local path re-selected: ${normalizeError(err)}`,
          "warning",
        );
        clearInvalidLocalGrant(item);
        await ensureLocalPathGrant(item);
        ensureTransferActive(item);
        // The old attempt's cancel/progress identity must not attach to the
        // re-picked attempt.
        reassignTransferId(item);
        item.phase = "running";
        attempt -= 1;
        continue;
      }
      if (attempt < maxAttempts && shouldRetryError(err)) {
        const waitMs = computeRetryDelayMs(attempt);
        item.phase = "retry_wait";
        item.retryAt = Date.now() + waitMs;
        queueRender();
        logActivity(
          `${operationLabel(item)} retry ${attempt} of ${maxAttempts - 1} for ${describeTransfer(item)}: retrying in ${Math.ceil(waitMs / 1000)} s.`,
          "warning",
        );
        await delayCancellable(waitMs, item);
        item.retryAt = undefined;
        if (item.cancelRequested) {
          throw new Error("Cancelled");
        }
        reassignTransferId(item);
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
  const transferRecoverySession = recoverySession;
  ensureTransferActive(item);

  if (item.operation === "download") {
    if (!item.destination) {
      throw new Error("No destination available for download transfer.");
    }
    const destinationToken = item.destinationToken;
    if (!destinationToken) {
      throw new Error(
        "Download destination must be re-selected before this transfer can continue.",
      );
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
            destinationToken,
            destinationName: item.destinationName ?? null,
            transferId: item.id,
            overwrite,
            attempt,
            parallelThresholdMb: effective.downloadParallelThresholdMb,
            partSizeMb: effective.downloadPartSizeMb,
            partConcurrency: scalePartConcurrencyForGlobalBudget(
              effective.downloadPartConcurrency,
              effective.downloadPartSizeMb,
            ),
            bandwidthLimitMbps: effective.bandwidthLimitMbps,
            checkpointId,
            recoverySession: transferRecoverySession ?? "",
            enableResume:
              Boolean(transferRecoverySession) &&
              item.resumable &&
              effective.enableTransferResume,
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
          destinationToken,
          destinationName: item.destinationName ?? null,
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
        destinationToken,
        destinationName: item.destinationName ?? null,
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
            overwrite,
            transferId: item.id,
            // Preserve unversioned support on providers whose conditional
            // DeleteObject behavior is verified. The backend uses this intent
            // to refuse unsupported moves before it mutates the destination;
            // a resumed move is checked again by delete_copied_objects.
            requireImmutableSourceVersion: false,
            automaticMove: item.operation === "move",
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
            overwrite,
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

      // Tauri's generic annotation is compile-time only. Treat the backend
      // response as untrusted at runtime and refuse to persist or delete from
      // receipts without all canonical source identities.
      receipts = validateFreshCopyReceipts(receipts);
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

    if (!item.receipts) {
      throw new Error("Move copy receipts are unavailable.");
    }
    // Revalidate immediately before deletion as well as before persistence so
    // no malformed in-memory or recovered value can regain copied authority.
    const receipts = validateFreshCopyReceipts(item.receipts);
    if (receipts.length === 0) {
      throw new Error("Move copy receipts are unavailable.");
    }
    if (receipts.some((receipt) => receipt.ownership_ambiguous)) {
      throw new Error(
        "Destination ownership is ambiguous; source was retained. Inspect both objects before clearing this transfer.",
      );
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
    const uploadToken = item.uploadToken;
    if (!uploadToken) {
      throw new Error(
        "Upload needs its local file re-selected before this transfer can continue.",
      );
    }
    item.resumable = false;
    item.checkpointId = undefined;
    // The backend returns the stat'ed file size so post-upload verification
    // never trusts progress events (or a zero total) for its expectation.
    const uploadedBytes = await invokeS3For<number>(
      connectionId,
      "upload_object",
      {
        bucket: item.bucket,
        key: item.key,
        uploadToken,
        contentType,
        transferId: item.id,
        attempt,
        overwrite,
        partSizeMb: effective.uploadPartSizeMb,
        partConcurrency: scalePartConcurrencyForGlobalBudget(
          effective.uploadPartConcurrency,
          effective.uploadPartSizeMb,
        ),
        bandwidthLimitMbps: effective.bandwidthLimitMbps,
        checksumVerification: effective.enableTransferChecksumVerification,
      },
    );
    if (Number.isFinite(uploadedBytes) && uploadedBytes > 0) {
      item.totalBytes = uploadedBytes;
      item.size = uploadedBytes;
    }
  } else if (item.browserFile) {
    if (item.browserFile.size > BROWSER_UPLOAD_BYTES_LIMIT) {
      throw new Error(
        `Browser upload fallback is limited to ${Math.floor(BROWSER_UPLOAD_BYTES_LIMIT / (1024 * 1024))}MB. ` +
          "Use file-path based upload for larger files.",
      );
    }
    const bytesBase64 = arrayBufferToBase64(
      await item.browserFile.arrayBuffer(),
    );
    ensureTransferActive(item);
    await invokeS3For(connectionId, "upload_object_bytes", {
      bucket: item.bucket,
      key: item.key,
      bytesBase64,
      contentType,
      transferId: item.id,
      attempt,
      overwrite,
      checksumVerification: effective.enableTransferChecksumVerification,
    });
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
): Promise<"skip" | "cancel" | { overwrite: boolean }> {
  await ensureLocalPathGrant(item);
  const effectivePolicy =
    item.conflictResolution === "replace" || item.conflictResolution === "skip"
      ? item.conflictResolution
      : state.currentSettings.conflictPolicy;
  const authorizationKey = unguardedAuthorizationKey(item, connectionId);
  const hasScopedOverwrite =
    item.overwrite === true &&
    authorizationKey !== null &&
    item.overwriteScope === authorizationKey;

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
  if (!conflictExists) {
    if (hasScopedOverwrite || effectivePolicy === "replace") {
      return { overwrite: true };
    }
    if (lacksAtomicCreateForTransferItem(item)) {
      const authorized = await withConflictPromptLock(() =>
        confirmUnguardedTransferWrite(item, connectionId),
      );
      return authorized ? { overwrite: true } : "cancel";
    }
    return { overwrite: false };
  }

  if (hasScopedOverwrite || effectivePolicy === "replace") {
    return { overwrite: true };
  }
  if (effectivePolicy === "skip") return "skip";

  if (conflictApplyAll) {
    return conflictApplyAll === "replace" ? { overwrite: true } : "skip";
  }

  return withConflictPromptLock(async () => {
    if (conflictApplyAll) {
      return conflictApplyAll === "replace" ? { overwrite: true } : "skip";
    }

    const target =
      item.operation === "download"
        ? (item.destination ?? item.fileName)
        : item.operation === "copy" || item.operation === "move"
          ? `${
              item.destinationBucket ?? item.bucket
            }/${item.destinationKey ?? item.destinationPrefix ?? item.fileName}`
          : `${item.bucket}/${item.key}`;
    void notifyIfUnfocused(
      "S3 Sidekick needs a decision",
      `${target} already exists.`,
    );
    const replace = await showConfirm(
      "Transfer conflict",
      `${target} already exists. Replace it?`,
      {
        okLabel: TRANSFER_TEXT.replace,
        cancelLabel: TRANSFER_TEXT.skip,
        okDanger: true,
      },
    );

    const decision: "skip" | "replace" = replace ? "replace" : "skip";

    // Only offer "apply to all" when other rows are still waiting, and say how many.
    const others = queue.filter(
      (entry) =>
        entry !== item &&
        (entry.status === "queued" || entry.status === "uploading"),
    ).length;
    if (others > 0) {
      const applyAll = await showConfirm(
        TRANSFER_TEXT.applyToAllRemaining,
        remainingConflictsQuestion(others),
        {
          okLabel:
            decision === "replace"
              ? `${TRANSFER_TEXT.replace} all`
              : `${TRANSFER_TEXT.skip} all`,
          cancelLabel: TRANSFER_TEXT.thisOneOnly,
        },
      );
      if (applyAll) {
        conflictApplyAll = decision;
      }
    }

    return decision === "replace" ? { overwrite: true } : "skip";
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
    if (!item.destinationToken) {
      throw new Error(
        "Download destination grant is unavailable; re-select the destination.",
      );
    }
    return invoke<boolean>("path_exists", {
      token: item.destinationToken,
      name: item.destinationName ?? null,
    });
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

function queueRender(dirtyTransferId?: number): void {
  if (dirtyTransferId === undefined) {
    fullRenderQueued = true;
  } else {
    dirtyTransferIds.add(dirtyTransferId);
  }
  if (renderQueued) return;
  renderQueued = true;
  const scheduler =
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 16);
  scheduler(() => {
    renderQueued = false;
    const renderAll = fullRenderQueued;
    const dirtyIds = Array.from(dirtyTransferIds);
    fullRenderQueued = false;
    dirtyTransferIds.clear();
    if (renderAll || dirtyIds.length === 0) {
      renderQueue();
    } else {
      renderTransferRows(dirtyIds);
    }
  });
}

function renderTransferRows(ids: readonly number[]): void {
  const list = document.getElementById("transfer-list");
  if (!list) return;

  const focus = captureTransferRenderFocus(list);
  const endpointHold = awaitingEndpoint();
  const patches: Array<{ row: HTMLElement; replacement: HTMLElement }> = [];
  for (const id of ids) {
    const item = queue.find((entry) => entry.id === id);
    const row = list.querySelector<HTMLElement>(
      `.transfer-item[data-id="${id}"]`,
    );
    if (!item || !row) {
      renderQueue();
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = renderTransferRow(
      item,
      rowRenderOptions(item, endpointHold),
    );
    const replacement = template.content.firstElementChild;
    if (!(replacement instanceof HTMLElement)) {
      renderQueue();
      return;
    }
    patches.push({ row, replacement });
  }

  for (const { row, replacement } of patches) {
    patchTransferRowElement(row, replacement);
  }
  restoreTransferRenderFocus(list, focus);
  updateQueueChrome();
}

function renderQueue(): void {
  const list = document.getElementById("transfer-list");
  if (!list) return;

  const focus = captureTransferRenderFocus(list);
  const template = document.createElement("template");
  const endpointHold = awaitingEndpoint();
  // The empty-queue message sits beside the list, not in it: a list may only
  // hold list items.
  template.innerHTML = queue
    .map((item) =>
      renderTransferRow(item, rowRenderOptions(item, endpointHold)),
    )
    .join("");
  reconcileTransferList(list, template.content);

  restoreTransferRenderFocus(list, focus);
  updateQueueChrome();
}

const TRANSFER_FILTER_STATUSES: Record<string, readonly string[] | null> = {
  all: null,
  active: ["queued", "uploading"],
  failed: ["error"],
  completed: ["done"],
};

const TRANSFER_FILTER_EMPTY_TEXT: Record<string, string> = {
  active: "No active transfers",
  failed: "No failed transfers",
  completed: "No completed transfers",
};

function activeTransferFilter(list: HTMLElement | null): string {
  const filter = list?.dataset.filter ?? "all";
  return filter in TRANSFER_FILTER_STATUSES ? filter : "all";
}

function visibleTransferCount(filter: string): number {
  const statuses = TRANSFER_FILTER_STATUSES[filter];
  if (statuses === null) return queue.length;
  return queue.filter((item) => statuses.includes(item.status)).length;
}

/**
 * The filter message lives beside the list in the app shell. Fixtures that
 * render only the queue get one created on demand so an active filter never
 * leaves a blank pane. The element is a polite status: its text changes only
 * when the filter result changes, not on every progress tick.
 */
function ensureTransferFilterEmpty(): HTMLElement | null {
  const existing = document.getElementById("transfer-filter-empty");
  if (existing) return existing;
  const list = document.getElementById("transfer-list");
  const parent = list?.parentElement;
  if (!list || !parent) return null;
  const empty = document.createElement("div");
  empty.id = "transfer-filter-empty";
  empty.className = "transfer-filter-empty";
  empty.setAttribute("role", "status");
  empty.hidden = true;
  parent.insertBefore(empty, list);
  return empty;
}

function syncTransferEmptyState(list: HTMLElement | null): void {
  const filter = activeTransferFilter(list);
  const filterEmpty = ensureTransferFilterEmpty();
  const queueEmpty = document.getElementById("transfer-queue-empty");
  const trulyEmpty = queue.length === 0;
  if (queueEmpty) queueEmpty.hidden = !trulyEmpty;
  if (!filterEmpty) return;
  const showFilterEmpty =
    !trulyEmpty && filter !== "all" && visibleTransferCount(filter) === 0;
  if (showFilterEmpty) {
    const text = TRANSFER_FILTER_EMPTY_TEXT[filter] ?? "No matching transfers";
    if (filterEmpty.textContent !== text) filterEmpty.textContent = text;
  }
  filterEmpty.hidden = !showFilterEmpty;
}

function updateQueueChrome(): void {
  const aggregates = computeQueueAggregates(queue);
  const list = document.getElementById("transfer-list");
  syncTransferEmptyState(list);
  state.activeTransferCount = aggregates.active;
  state.runningTransferCount = aggregates.running;
  updateTransferBadges(aggregates);
  updateTransferThroughput(aggregates);
  updateQueueSummary(aggregates, {
    waiting: queue.some((item) => item.status === "queued" && !item.paused),
    heldForDisconnect: state.transfersHeldForDisconnect,
    offline: offlineHoldActive(),
    queuePaused,
    awaitingEndpoint: awaitingEndpoint(),
  });
  syncTransferVisibility(queue.length > 0);
}

async function cancelTransferItem(id: number): Promise<void> {
  const item = queue.find((t) => t.id === id);
  if (!item) return;
  item.cancelRequested = true;
  if (item.status === "queued") {
    if (isReceiptBackedCopiedMove(item)) {
      // The copy already owns a destination. Cancelling now would drop the
      // receipts that recovery needs to finish or reconcile the move.
      holdReceiptBackedMoveForReview(item);
      renderQueue();
      writeQueueManifest();
      return;
    }
    // Show "Cancelling" while the recovery state is discarded.
    renderQueue();
    try {
      await discardTransferRecoveryState(item);
      markCancelled(item);
      logCancelled(item);
    } catch (err) {
      if (isNothingToDiscardError(err)) {
        markCancelled(item);
        logCancelled(item);
      } else {
        const cleanupMessage = `Cancellation cleanup failed: ${normalizeError(err)}`;
        holdAfterCancelFailure(item, cleanupMessage);
        logActivity(
          `Cancellation cleanup failed for ${describeTransfer(item)}: ${normalizeError(err)}`,
          "error",
        );
        showToast(cleanupMessage, { type: "error", duration: 0 });
      }
    }
    pruneTerminalHistory();
    renderQueue();
  } else if (item.status === "uploading") {
    // Rendered as "Cancelling" before the IPC: the worker can finish its
    // cancel path before this call returns, and its "Cancelled" must win.
    renderQueue();
    try {
      await cancelTransferForCurrentSession(id);
    } catch (err) {
      item.cancelRequested = false;
      const message = `Could not cancel ${describeTransfer(item)}: ${friendlyError(err)}`;
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
