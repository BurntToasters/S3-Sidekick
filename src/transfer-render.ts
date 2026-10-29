import { escapeHtml, friendlyError, getIconHtml, plural } from "./utils.ts";
import { MULTIPART_UPLOAD_THRESHOLD_BYTES } from "./create-only-capabilities.ts";
import type { TransferItem } from "./transfers.ts";

const STALLED_AFTER_MS = 15_000;

/**
 * Wording shared by the transfer queue, its dialogs and the activity log.
 * Change a label here, not at the call site.
 */
export const TRANSFER_TEXT = {
  clearCompleted: "Clear completed",
  clearFailed: "Clear failed",
  retryFailed: "Retry failed",
  retry: "Retry",
  remove: "Remove",
  copyError: "Copy error",
  replace: "Replace",
  skip: "Skip",
  thisOneOnly: "This one only",
  applyToAllRemaining: "Apply to all remaining conflicts",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  cancelling: "Cancelling…",
  cancelled: "Cancelled",
  queuePaused: "Queue paused",
  preparing: "Preparing — checking file…",
} as const;

/** Question asked when a batch conflict choice can be applied to the rest. */
export function remainingConflictsQuestion(count: number): string {
  return `Apply to ${plural(count, "remaining conflict")}?`;
}

export function formatSpeedBps(speedBps: number): string {
  if (!Number.isFinite(speedBps) || speedBps <= 0) return "";
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (speedBps >= gb) return `${(speedBps / gb).toFixed(2)} GB/s`;
  if (speedBps >= mb) return `${(speedBps / mb).toFixed(2)} MB/s`;
  if (speedBps >= kb) return `${(speedBps / kb).toFixed(1)} KB/s`;
  return `${Math.round(speedBps)} B/s`;
}

export function formatEtaSeconds(etaSeconds: number | null): string {
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

/** Whole seconds left in a retry wait, never below one. */
export function formatRetryCountdown(retryAt: number, now: number): string {
  const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return `Retrying in ${seconds} s`;
}

export interface TransferRenderFocus {
  id: number;
  controlSelector: ".transfer-pause" | ".transfer-cancel";
}

export function captureTransferRenderFocus(
  list: HTMLElement,
): TransferRenderFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !list.contains(active)) return null;
  const control = active.closest<HTMLElement>(
    ".transfer-pause, .transfer-cancel",
  );
  const row = control?.closest<HTMLElement>(".transfer-item");
  const id = Number(row?.dataset.id);
  if (!control || !Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    controlSelector: control.classList.contains("transfer-pause")
      ? ".transfer-pause"
      : ".transfer-cancel",
  };
}

export function restoreTransferRenderFocus(
  list: HTMLElement,
  focus: TransferRenderFocus | null,
): void {
  if (!focus) return;
  const row = list.querySelector<HTMLElement>(
    `.transfer-item[data-id="${focus.id}"]`,
  );
  const control = row?.querySelector<HTMLElement>(focus.controlSelector);
  const target = control ?? row ?? list;
  if (target === row || target === list) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

export interface QueueAggregates {
  /** Queued or running rows the user has not paused. */
  active: number;
  /** Rows currently in the backend (uploading), paused or not. */
  running: number;
  /** Queued or running rows the user paused. */
  paused: number;
  failed: number;
  skipped: number;
  cancelled: number;
  completed: number;
  /** Rows that need the user's attention (failed or skipped). */
  attention: number;
  totalSpeed: number;
}

export function computeQueueAggregates(
  queue: readonly TransferItem[],
): QueueAggregates {
  const aggregates: QueueAggregates = {
    active: 0,
    running: 0,
    paused: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    completed: 0,
    attention: 0,
    totalSpeed: 0,
  };

  for (const item of queue) {
    if (item.status === "queued" || item.status === "uploading") {
      if (item.paused) aggregates.paused += 1;
      else aggregates.active += 1;
    }
    if (item.status === "error") {
      aggregates.failed += 1;
      aggregates.attention += 1;
    } else if (item.status === "skipped") {
      aggregates.skipped += 1;
      aggregates.attention += 1;
    } else if (item.status === "cancelled") {
      aggregates.cancelled += 1;
    } else if (item.status === "done") {
      aggregates.completed += 1;
    }
    if (item.status === "uploading") {
      aggregates.running += 1;
      aggregates.totalSpeed += Math.max(0, item.speedBps);
    }
  }

  return aggregates;
}

export interface QueueSummaryStatus {
  waiting: boolean;
  heldForDisconnect: boolean;
  offline: boolean;
  /** The user paused the whole queue. */
  queuePaused?: boolean;
  /** Recovered work waits for this endpoint to be connected. */
  awaitingEndpoint?: string | null;
}

/**
 * The polite live region. It carries counts and states only: speed changes
 * on every progress frame and is shown in the status bar instead.
 */
export function updateQueueSummary(
  aggregates: QueueAggregates,
  status: QueueSummaryStatus,
): void {
  const el = document.getElementById("transfer-queue-summary");
  if (!el) return;

  const parts: string[] = [];
  if (status.queuePaused) {
    parts.push(
      aggregates.running > 0
        ? `${TRANSFER_TEXT.queuePaused} — ${plural(aggregates.running, "upload")} finishing`
        : TRANSFER_TEXT.queuePaused,
    );
  } else if (status.waiting && status.heldForDisconnect) {
    parts.push("Waiting to reconnect");
  } else if (status.waiting && status.offline) {
    parts.push("Offline — waiting for network");
  } else if (status.awaitingEndpoint) {
    parts.push(`Connect to ${status.awaitingEndpoint} to resume`);
  }
  if (
    !status.queuePaused &&
    !status.awaitingEndpoint &&
    aggregates.active > 0
  ) {
    parts.push(`${aggregates.active} active`);
  }
  if (aggregates.paused > 0) parts.push(`${aggregates.paused} paused`);
  if (aggregates.failed > 0) parts.push(`${aggregates.failed} failed`);
  if (aggregates.skipped > 0) parts.push(`${aggregates.skipped} skipped`);
  if (aggregates.cancelled > 0) parts.push(`${aggregates.cancelled} cancelled`);
  if (aggregates.completed > 0) parts.push(`${aggregates.completed} completed`);
  // Only state counts are in this text (no speed), so it changes on state
  // transitions. Writing the same text again would re-announce it to
  // assistive tech on every progress tick, so skip unchanged text.
  const text = parts.length > 0 ? parts.join(" · ") : "No active transfers";
  if (el.textContent !== text) el.textContent = text;
}

export function updateTransferBadges(aggregates: QueueAggregates): void {
  const badgeText =
    aggregates.active > 0
      ? String(aggregates.active)
      : aggregates.attention > 0
        ? "!"
        : "";
  const badge = document.getElementById("transfer-badge");
  if (badge) {
    badge.textContent = badgeText;
    badge.style.display =
      aggregates.active > 0 || aggregates.attention > 0 ? "" : "none";
    badge.classList.toggle(
      "transfer-badge--alert",
      aggregates.active === 0 && aggregates.attention > 0,
    );
  }
  const drawerBadge = document.getElementById("drawer-transfer-badge");
  if (drawerBadge) {
    drawerBadge.textContent = badgeText;
    drawerBadge.style.display =
      aggregates.active > 0 || aggregates.attention > 0 ? "" : "none";
    drawerBadge.classList.toggle(
      "drawer-badge--alert",
      aggregates.active === 0 && aggregates.attention > 0,
    );
  }
  const toggle = document.getElementById("transfer-toggle");
  if (toggle && (aggregates.active > 0 || aggregates.attention > 0)) {
    const speedLabel =
      aggregates.totalSpeed > 0 ? formatSpeedBps(aggregates.totalSpeed) : "";
    toggle.title = speedLabel
      ? `Transfers (${aggregates.active} active, ${speedLabel})`
      : `Transfers (${aggregates.active} active)`;
  } else if (toggle) {
    toggle.title = "Transfers";
  }
}

export function updateTransferThroughput(aggregates: QueueAggregates): void {
  const label =
    aggregates.totalSpeed > 0 ? formatSpeedBps(aggregates.totalSpeed) : "";
  const statusEl = document.getElementById("statusbar-throughput");
  if (statusEl) {
    statusEl.textContent = label ? `Transfers ${label}` : "";
  }
  const drawerEl = document.getElementById("drawer-transfer-throughput");
  if (drawerEl) {
    drawerEl.textContent = label ? `Total ${label}` : "";
  }
}

export function syncTransferVisibility(hasQueue: boolean): void {
  const toggle = document.getElementById(
    "transfer-toggle",
  ) as HTMLButtonElement | null;
  if (toggle) {
    toggle.hidden = false;
    toggle.classList.toggle("statusbar__transfer--idle", !hasQueue);
    if (!hasQueue) {
      toggle.setAttribute("aria-expanded", "false");
    }
  }
}

export interface TransferRenderOptions {
  selectedTransferId?: number | null;
  now?: number;
  /** Why a queued row is not moving, e.g. "Queue paused". */
  holdLabel?: string | null;
}

/** Single-request uploads report only 0% and 100%; no interim progress is due. */
function isSingleRequestUpload(t: TransferItem): boolean {
  return (
    t.operation === "upload" &&
    t.totalBytes > 0 &&
    t.totalBytes < MULTIPART_UPLOAD_THRESHOLD_BYTES
  );
}

/** Only these transfers emit incremental progress, so silence can mean a stall. */
function emitsIncrementalProgress(t: TransferItem): boolean {
  if (t.operation === "download") return true;
  return t.operation === "upload" && !isSingleRequestUpload(t);
}

function isOwnershipAmbiguous(t: TransferItem): boolean {
  return (
    t.operation === "move" &&
    t.receipts?.some((receipt) => receipt.ownership_ambiguous) === true
  );
}

function rowControl(
  action: string,
  label: string,
  iconName: string,
  classes: string,
  disabled = false,
): string {
  return (
    `<button type="button" class="btn btn--icon transfer-control ${classes}" data-action="${action}"` +
    ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${disabled ? " disabled" : ""}>` +
    `${getIconHtml(iconName, { className: "lucide-icon transfer-control-icon", decorative: true })}` +
    `</button>`
  );
}

export function renderTransferRow(
  t: TransferItem,
  options: TransferRenderOptions = {},
): string {
  const selectedTransferId = options.selectedTransferId ?? null;
  const now = options.now ?? Date.now();
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
  } else if (t.status === "cancelled") {
    statusIcon = getIconHtml("x", {
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

  const progressPct = Math.max(0, Math.min(100, Math.round(t.progress) || 0));
  // A row is busy only while the backend is actively transferring it. A
  // pause request can briefly leave a download in the uploading state, so
  // paused is part of this check as well.
  const isPaused = t.paused || t.phase === "paused";
  const cancelling =
    (t.status === "queued" || t.status === "uploading") &&
    t.cancelRequested === true;
  const isActive = t.status === "uploading" && !isPaused && !cancelling;
  const isPreparing = isActive && t.phase === "preparing";
  // Single-PUT uploads emit 0 then 100 with no hook in between, so a
  // determinate bar would fake progress. Hide that fake 0% while queued or
  // paused, and use an indeterminate bar only while the upload is running.
  const isSinglePutUpload = isSingleRequestUpload(t) && t.progress < 100;
  const hasStaticPartialProgress =
    t.totalBytes > 0 && t.progress > 0 && (t.status === "error" || isPaused);
  const showDeterminate =
    t.totalBytes > 0 &&
    !isPreparing &&
    ((isActive && !isSinglePutUpload) ||
      hasStaticPartialProgress ||
      (t.status === "queued" && !isSinglePutUpload));
  const showIndeterminate = isActive && !showDeterminate;
  const progressBusyAttribute = isActive ? ' aria-busy="true"' : "";
  const progressBar = showDeterminate
    ? `<div class="transfer-progress-wrap">` +
      `<div class="transfer-progress" role="progressbar" aria-label="${escapeHtml(t.fileName)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPct}"${progressBusyAttribute}><div class="transfer-progress__bar" style="width:${progressPct}%"></div></div>` +
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
  const source =
    t.operation === "copy" || t.operation === "move"
      ? `${t.sourceBucket ?? t.bucket}/${t.sourceKey ?? t.sourcePrefix ?? t.key}`
      : t.operation === "download"
        ? `${t.bucket}/${t.key}`
        : t.filePath || t.fileName;
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
      ? `<span class="transfer-attempt">Attempt ${t.attempt} of ${t.maxAttempts}</span>`
      : "";

  // Only transfers that emit incremental progress can stall. Retry waits,
  // verification, finalizing and single-request uploads are working normally.
  const stalled =
    isActive &&
    t.phase === "running" &&
    emitsIncrementalProgress(t) &&
    t.lastProgressAt !== undefined &&
    now - t.lastProgressAt > STALLED_AFTER_MS;
  let phaseText = "Running";
  if (cancelling) phaseText = TRANSFER_TEXT.cancelling;
  else if (!isActive && isPaused) phaseText = "Paused";
  else if (stalled) phaseText = "Stalled — waiting for data";
  else if (t.phase === "retry_wait") {
    phaseText =
      t.retryAt !== undefined
        ? formatRetryCountdown(t.retryAt, now)
        : "Retry wait";
  } else if (t.phase === "preparing") phaseText = TRANSFER_TEXT.preparing;
  else if (t.phase === "verifying") phaseText = "Verifying";
  else if (t.phase === "paused") phaseText = "Paused";
  else if (t.phase === "resuming") phaseText = "Resuming";
  else if (t.phase === "finalizing") phaseText = "Finalizing";
  const phaseLabel =
    isActive || cancelling
      ? `<span class="transfer-phase${stalled ? " transfer-phase--stalled" : ""}">${escapeHtml(phaseText)}</span>`
      : "";

  let statusPlain = "";
  if (t.status === "done") statusPlain = "Completed";
  else if (t.status === "error") statusPlain = "Failed";
  else if (t.status === "skipped") statusPlain = "Skipped";
  else if (t.status === "cancelled") statusPlain = TRANSFER_TEXT.cancelled;
  else if (isPaused) statusPlain = "Paused";
  else if (t.status === "queued") statusPlain = options.holdLabel ?? "Queued";
  const statusText = statusPlain
    ? `<span class="transfer-phase transfer-phase--status">${escapeHtml(statusPlain)}</span>`
    : "";
  const speedLabel =
    isActive && !stalled && t.speedBps > 0
      ? `<span class="transfer-phase">${escapeHtml(formatSpeedBps(t.speedBps))}</span>`
      : "";
  const etaLabel =
    isActive && !stalled && t.etaSeconds !== null
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
  const pauseLabel = `${t.paused ? TRANSFER_TEXT.resume : TRANSFER_TEXT.pause} ${t.fileName}`;
  const pauseButton = canPause
    ? rowControl(
        "pause",
        pauseLabel,
        t.paused ? "play" : "pause",
        "transfer-pause",
        cancelling,
      )
    : "";
  const cancelButton =
    t.status === "queued" || t.status === "uploading"
      ? rowControl(
          "cancel",
          `${TRANSFER_TEXT.cancel} ${t.fileName}`,
          "x",
          "transfer-cancel",
          cancelling,
        )
      : "";

  const ambiguous = isOwnershipAmbiguous(t);
  const retryable = t.retryable !== false && !ambiguous;
  const retryButton =
    t.status === "error" && retryable
      ? rowControl(
          "retry",
          `${TRANSFER_TEXT.retry} ${t.fileName}`,
          "rotate-ccw",
          "transfer-retry",
        )
      : "";
  const copyErrorButton =
    t.status === "error" && t.error
      ? rowControl(
          "copy-error",
          `${TRANSFER_TEXT.copyError} for ${t.fileName}`,
          "copy",
          "transfer-copy-error",
        )
      : "";
  // Only a finished download has a local file to reveal. Uploads keep their
  // source path out of the file manager.
  const revealButton =
    t.operation === "download" && t.status === "done" && t.destination
      ? rowControl(
          "reveal",
          `Show ${t.fileName} in folder`,
          "folder",
          "transfer-reveal",
        )
      : "";
  const removeButton =
    (t.status === "done" ||
      t.status === "error" ||
      t.status === "skipped" ||
      t.status === "cancelled") &&
    !ambiguous
      ? rowControl(
          "remove",
          `${TRANSFER_TEXT.remove} ${t.fileName} from the list`,
          "trash-2",
          "transfer-remove",
        )
      : "";

  const errorText = t.error ? friendlyError(t.error) : "";
  const errorLine =
    t.status === "error" || t.status === "skipped" || (isPaused && t.error)
      ? `<span class="transfer-error" title="${escapeHtml(t.error ?? "")}">${escapeHtml(errorText || "Error")}</span>`
      : "";

  // data-status lets the drawer filter rows without re-rendering them;
  // tabindex -1 makes the row reachable by arrow keys without a tab stop.
  return (
    `<div class="${rowClass}" role="listitem" tabindex="-1" data-id="${t.id}" data-status="${t.status}">` +
    `<span class="transfer-status ${statusClass}">${statusIcon}</span>` +
    `<div class="transfer-main">` +
    `<div class="transfer-main__row">` +
    `<span class="transfer-op">${escapeHtml(opLabel)}</span>` +
    `<span class="transfer-name" title="${escapeHtml(source)}" aria-label="${escapeHtml(source)}">${escapeHtml(t.fileName)}</span>` +
    (target
      ? `<span class="transfer-arrow">${arrow}</span>` +
        `<span class="transfer-key" title="${escapeHtml(target)}" aria-label="${escapeHtml(target)}">${escapeHtml(target)}</span>`
      : "") +
    `</div>` +
    (attemptLabel ||
    phaseLabel ||
    statusText ||
    speedLabel ||
    etaLabel ||
    partsLabel
      ? `<div class="transfer-meta">${statusText}${attemptLabel}${phaseLabel}${speedLabel}${etaLabel}${partsLabel}</div>`
      : "") +
    progressBar +
    errorLine +
    `</div>` +
    pauseButton +
    cancelButton +
    retryButton +
    copyErrorButton +
    revealButton +
    removeButton +
    `</div>`
  );
}

/**
 * Make `to` match `from` attribute-for-attribute and child-for-child, reusing
 * existing element nodes where their identity (tag, data-id, data-action)
 * matches. Keeping nodes alive is what keeps a click or focus that lands
 * during a progress update from being lost.
 */
function nodeKey(node: Element): string {
  return `${node.tagName}|${node.getAttribute("data-id") ?? ""}|${node.getAttribute("data-action") ?? ""}`;
}

function syncAttributes(from: Element, to: Element): void {
  for (const name of from.getAttributeNames()) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const name of to.getAttributeNames()) {
    const value = to.getAttribute(name) ?? "";
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

function reconcileChildren(parent: Element, source: Node): void {
  const pool = new Map<string, Element[]>();
  for (const child of Array.from(parent.children)) {
    const key = nodeKey(child);
    const bucket = pool.get(key) ?? [];
    bucket.push(child);
    pool.set(key, bucket);
  }

  const placed = new Set<Node>();
  let cursor: ChildNode | null = parent.firstChild;
  for (const next of Array.from(source.childNodes)) {
    let node: Node;
    if (next instanceof Element) {
      const reused = pool.get(nodeKey(next))?.shift();
      if (reused) {
        syncAttributes(reused, next);
        reconcileChildren(reused, next);
        node = reused;
      } else {
        node = next.cloneNode(true);
      }
    } else {
      node = next.cloneNode(true);
    }
    if (node === cursor) {
      cursor = cursor.nextSibling;
    } else {
      parent.insertBefore(node, cursor);
    }
    placed.add(node);
  }

  for (const child of Array.from(parent.childNodes)) {
    if (!placed.has(child)) parent.removeChild(child);
  }
}

/** Update one rendered row without replacing its interactive nodes. */
export function patchTransferRowElement(
  row: HTMLElement,
  fresh: HTMLElement,
): void {
  syncAttributes(row, fresh);
  reconcileChildren(row, fresh);
}

/** Bring the transfer list to `fragment` without rebuilding unchanged rows. */
export function reconcileTransferList(
  list: HTMLElement,
  fragment: DocumentFragment,
): void {
  reconcileChildren(list, fragment);
}
