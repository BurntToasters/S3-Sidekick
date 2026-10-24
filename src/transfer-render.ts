import { escapeHtml, getIconHtml } from "./utils.ts";
import { MULTIPART_UPLOAD_THRESHOLD_BYTES } from "./create-only-capabilities.ts";
import type { TransferItem } from "./transfers.ts";

const STALLED_AFTER_MS = 15_000;

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
  active: number;
  running: number;
  failed: number;
  skipped: number;
  attention: number;
  totalSpeed: number;
}

export function computeQueueAggregates(
  queue: readonly TransferItem[],
): QueueAggregates {
  const aggregates: QueueAggregates = {
    active: 0,
    running: 0,
    failed: 0,
    skipped: 0,
    attention: 0,
    totalSpeed: 0,
  };

  for (const item of queue) {
    if (item.status === "queued" || item.status === "uploading") {
      aggregates.active += 1;
    }
    if (item.status === "error") {
      aggregates.failed += 1;
      aggregates.attention += 1;
    } else if (item.status === "skipped") {
      aggregates.skipped += 1;
      aggregates.attention += 1;
    }
    if (item.status === "uploading") {
      aggregates.running += 1;
      aggregates.totalSpeed += Math.max(0, item.speedBps);
    }
  }

  return aggregates;
}

export function updateQueueSummary(
  aggregates: QueueAggregates,
  status: { waiting: boolean; heldForDisconnect: boolean; offline: boolean },
): void {
  const el = document.getElementById("transfer-queue-summary");
  if (!el) return;

  const parts: string[] = [];
  // Held rows only say "Queued"; say why the queue is not moving.
  if (status.waiting && status.heldForDisconnect) {
    parts.push("Waiting to reconnect");
  } else if (status.waiting && status.offline) {
    parts.push("Offline — waiting for network");
  }
  if (aggregates.active > 0) parts.push(`${aggregates.active} active`);
  if (aggregates.failed > 0) parts.push(`${aggregates.failed} failed`);
  if (aggregates.skipped > 0) parts.push(`${aggregates.skipped} skipped`);
  if (aggregates.totalSpeed > 0) {
    parts.push(formatSpeedBps(aggregates.totalSpeed));
  }
  el.textContent = parts.length > 0 ? parts.join(" · ") : "No active transfers";
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
  const isActive = t.status === "uploading" && !isPaused;
  // Single-PUT uploads emit 0 then 100 with no hook in between, so a
  // determinate bar would fake progress. Hide that fake 0% while queued or
  // paused, and use an indeterminate bar only while the upload is running.
  const isSinglePutUpload =
    t.operation === "upload" &&
    t.totalBytes > 0 &&
    t.totalBytes < MULTIPART_UPLOAD_THRESHOLD_BYTES &&
    t.progress < 100;
  const hasStaticPartialProgress =
    t.totalBytes > 0 && t.progress > 0 && (t.status === "error" || isPaused);
  const showDeterminate =
    t.totalBytes > 0 &&
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
      ? `<span class="transfer-attempt">Attempt ${t.attempt}/${t.maxAttempts}</span>`
      : "";

  const stalled =
    isActive &&
    t.lastProgressAt !== undefined &&
    now - t.lastProgressAt > STALLED_AFTER_MS;
  const phaseLabel = isActive
    ? `<span class="transfer-phase${stalled ? " transfer-phase--stalled" : ""}">${
        stalled
          ? "Stalled — waiting for data"
          : t.phase === "retry_wait"
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
  const statusLabel =
    t.status === "done"
      ? "Completed"
      : t.status === "error"
        ? "Failed"
        : t.status === "skipped"
          ? "Skipped"
          : isPaused
            ? "Paused"
            : t.status === "queued"
              ? "Queued"
              : "";
  const statusText = statusLabel
    ? `<span class="transfer-phase transfer-phase--status">${statusLabel}</span>`
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
    (t.status === "error" || t.status === "skipped" || (isPaused && t.error)
      ? `<span class="transfer-error" title="${escapeHtml(t.error ?? "")}">${escapeHtml(t.error ?? "Error")}</span>`
      : "") +
    `</div>` +
    pauseButton +
    (t.status === "queued" || t.status === "uploading"
      ? `<button class="transfer-cancel btn--ghost" title="Cancel" aria-label="Cancel transfer">&times;</button>`
      : "") +
    `</div>`
  );
}
