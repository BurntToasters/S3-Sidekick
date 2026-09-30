import type { TransferItem } from "./transfers.ts";

export type TransferStatus = TransferItem["status"];
export type TransferPhase = TransferItem["phase"];

/**
 * Every legal status change. A transfer is created "queued"; "done" is final
 * (the queue drops the row). Anything else is a bug in the caller, and
 * throws in development and tests so it cannot hide.
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<TransferStatus, readonly TransferStatus[]>
> = {
  queued: ["queued", "uploading", "error"],
  uploading: ["queued", "error", "skipped", "done"],
  error: ["queued"],
  skipped: ["queued"],
  done: [],
};

function moveTo(item: TransferItem, next: TransferStatus): void {
  if (!LEGAL_TRANSITIONS[item.status].includes(next)) {
    const message = `Illegal transfer transition ${item.status} -> ${next} for ${item.fileName}`;
    if (import.meta.env.DEV) throw new Error(message);
    console.error(message);
  }
  item.status = next;
}

/** Why a claimed item went back to the queue without running. */
export type ParkReason = "offline" | "disconnected";

const PARK_MESSAGES: Record<ParkReason, string> = {
  offline: "Offline — waiting for connection",
  disconnected: "Disconnected — waiting to reconnect",
};

/**
 * Work a queue worker may start now. The queue loop and the claim use this
 * one predicate: if they disagree, the loop spins on work nobody claims.
 */
export function isClaimable(item: TransferItem): boolean {
  return item.status === "queued" && !item.paused && !item.cancelRequested;
}

/** A worker takes the item. */
export function claim(item: TransferItem): void {
  // pauseCancelInFlight survives the claim: a pause sent while no backend
  // command was registered leaves a short-lived pending cancel, which the
  // next attempt consumes. That attempt's cancellation must still read as
  // the pause, not as a failure.
  moveTo(item, "uploading");
  item.phase = item.phase === "resuming" ? "resuming" : "running";
  item.error = undefined;
}

/**
 * Back to the queue without finishing. A reason replaces the row message;
 * without one (a user pause) the message is left as it was.
 */
export function park(item: TransferItem, reason?: ParkReason): void {
  moveTo(item, "queued");
  item.phase = "paused";
  if (reason) item.error = PARK_MESSAGES[reason];
}

/** The cancellation a pause asked for arrived. */
export function requeueAfterPause(item: TransferItem): void {
  moveTo(item, "queued");
  // Resumed before the cancel landed: run again instead of failing.
  item.phase = item.paused ? "paused" : "resuming";
  item.error = item.paused ? "Paused" : undefined;
}

export function markCancelled(item: TransferItem, phase?: TransferPhase): void {
  moveTo(item, "error");
  if (phase) item.phase = phase;
  item.error = "Cancelled";
  item.browserFile = undefined;
}

/**
 * Cancellation cleanup failed. Keep the row recoverable and cancellable:
 * dropping it would orphan scratch and checkpoint state.
 */
export function holdAfterCancelFailure(
  item: TransferItem,
  message: string,
): void {
  moveTo(item, "queued");
  item.phase = "paused";
  item.paused = true;
  item.cancelRequested = false;
  item.error = message;
}

export function markFailed(item: TransferItem, message: string): void {
  moveTo(item, "error");
  item.error = message;
  item.browserFile = undefined;
}

export function markSkipped(item: TransferItem, message: string): void {
  item.overwrite = undefined;
  item.overwriteScope = undefined;
  moveTo(item, "skipped");
  item.error = message;
  item.speedBps = 0;
  item.etaSeconds = null;
}

export function markDone(item: TransferItem): void {
  item.progress = 100;
  item.verified = true;
  moveTo(item, "done");
  item.speedBps = 0;
  item.etaSeconds = 0;
}

/**
 * Pause by the user or the queue. Returns true when a running attempt must
 * be cancelled in the backend to honor it.
 */
export function pause(item: TransferItem): boolean {
  item.paused = true;
  item.phase = "paused";
  if (item.status !== "uploading") return false;
  item.pauseCancelInFlight = true;
  return true;
}

/** Resume. Returns true when the item can run again. */
export function resume(item: TransferItem): boolean {
  item.paused = false;
  item.cancelRequested = false;
  if (item.status === "error" && item.error?.toLowerCase().includes("cancel")) {
    moveTo(item, "queued");
    item.error = undefined;
  }
  if (item.status !== "queued") return false;
  item.phase = "resuming";
  return true;
}

/** Release a row held back without user intent (legacy account binding). */
export function releaseHold(item: TransferItem): void {
  item.paused = false;
  item.phase = "running";
}

/** Put a failed or skipped row back in the queue from scratch. */
export function resetForRetry(
  item: TransferItem,
  { clearPause }: { clearPause: boolean },
): void {
  moveTo(item, "queued");
  item.error = undefined;
  item.progress = 0;
  item.speedBps = 0;
  item.etaSeconds = null;
  if (clearPause) item.paused = false;
  item.cancelRequested = false;
  item.phase = "running";
}
