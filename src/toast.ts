import { escapeHtml, getIconHtml } from "./utils.ts";

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  type?: ToastType;
  /** Auto-dismiss delay in ms. Pass 0 to keep the toast until dismissed. */
  duration?: number;
  /** Optional inline action button (e.g. "Undo", "View"). */
  actionLabel?: string;
  onAction?: () => void;
}

const DEFAULT_DURATION: Record<ToastType, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
};

const TYPE_ICON: Record<ToastType, string> = {
  info: "info",
  success: "check-circle",
  warning: "alert-triangle",
  error: "alert-circle",
};

const MAX_VISIBLE = 4;

interface ActiveToast {
  el: HTMLElement;
  key: string;
  count: number;
  countEl: HTMLElement;
  /** 0 = sticky (persistent): exempt from auto-eviction so errors survive. */
  duration: number;
  remaining: number;
  pausedReasons: Set<"hover" | "focus">;
  timer?: ReturnType<typeof setTimeout>;
  timerStartedAt?: number;
  timerGeneration: number;
}

const active: ActiveToast[] = [];

function getRegion(): HTMLElement | null {
  let region = document.getElementById("toast-region");
  if (!region) {
    if (!document.body) return null;
    region = document.createElement("div");
    region.id = "toast-region";
    region.className = "toast-region";
    // Single live strategy: the region itself is NOT a live region. Each
    // toast carries its own role (status/alert), so screen readers announce
    // every toast exactly once instead of double-announcing (polite region +
    // alert) for errors/warnings.
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "Notifications");
    document.body.appendChild(region);
  }
  return region;
}

function clearTimer(toast: ActiveToast): void {
  toast.timerGeneration += 1;
  if (toast.timer !== undefined) {
    clearTimeout(toast.timer);
    toast.timer = undefined;
  }
  toast.timerStartedAt = undefined;
}

function armTimer(toast: ActiveToast): void {
  clearTimer(toast);
  if (
    toast.duration <= 0 ||
    toast.remaining <= 0 ||
    toast.pausedReasons.size > 0 ||
    !toast.el.isConnected
  ) {
    return;
  }

  const startedAt = Date.now();
  const generation = toast.timerGeneration;
  toast.timerStartedAt = startedAt;
  toast.timer = setTimeout(() => {
    if (toast.timerGeneration !== generation || toast.pausedReasons.size > 0) {
      return;
    }
    toast.timer = undefined;
    toast.timerStartedAt = undefined;
    toast.remaining = Math.max(
      0,
      toast.remaining - Math.max(0, Date.now() - startedAt),
    );
    if (toast.remaining <= 0) {
      dismissToast(toast.el);
    } else {
      // A timer can fire late under load. Continue with the unelapsed
      // remainder instead of dismissing early.
      armTimer(toast);
    }
  }, toast.remaining);
}

function removeFromActive(el: HTMLElement): ActiveToast | undefined {
  const idx = active.findIndex((t) => t.el === el);
  if (idx !== -1) {
    const [toast] = active.splice(idx, 1);
    clearTimer(toast);
    toast.pausedReasons.clear();
    return toast;
  }
  return undefined;
}

export function dismissToast(el: HTMLElement): void {
  removeFromActive(el);
  if (!el.isConnected) return;
  if (el.classList.contains("toast--leaving")) return;
  el.classList.add("toast--leaving");
  let removed = false;
  const finish = (): void => {
    if (removed) return;
    removed = true;
    el.remove();
  };
  el.addEventListener("animationend", finish, { once: true });
  // Fallback in case the leave animation never fires (e.g. reduced motion).
  setTimeout(finish, 240);
}

export function clearToasts(): void {
  for (const toast of active.slice()) {
    dismissToast(toast.el);
  }
}

export function showToast(message: string, options: ToastOptions = {}): void {
  const region = getRegion();
  if (!region) return;

  // A view transition or test fixture can remove a region while a toast is
  // still tracked. Drop stale entries and their timers before looking for a
  // repeated message.
  for (const toast of active.slice()) {
    if (!toast.el.isConnected) removeFromActive(toast.el);
  }

  const type = options.type ?? "info";
  const requestedDuration = options.duration ?? DEFAULT_DURATION[type];
  const duration = Number.isFinite(requestedDuration)
    ? Math.max(0, requestedDuration)
    : DEFAULT_DURATION[type];
  const key = `${type}:${message}`;

  // Collapse repeats of the same message instead of stacking duplicates.
  const existing = active.find((t) => t.key === key);
  if (existing) {
    existing.count += 1;
    existing.countEl.textContent = `\u00d7${existing.count}`;
    existing.countEl.hidden = false;
    existing.duration = duration;
    existing.remaining = duration;
    region.appendChild(existing.el);
    armTimer(existing);
    return;
  }

  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  if (type === "error" || type === "warning") {
    el.setAttribute("role", "alert");
  } else {
    el.setAttribute("role", "status");
  }

  const action =
    options.actionLabel && options.onAction
      ? `<button type="button" class="toast__action">${escapeHtml(options.actionLabel)}</button>`
      : "";

  el.innerHTML =
    `<span class="toast__icon" aria-hidden="true">${getIconHtml(TYPE_ICON[type], { className: "lucide-icon toast__icon-svg", decorative: true })}</span>` +
    `<span class="toast__msg">${escapeHtml(message)}<span class="toast__count" hidden></span></span>` +
    action +
    `<button type="button" class="toast__close" aria-label="Dismiss notification">${getIconHtml("x", { className: "lucide-icon toast__close-svg", decorative: true })}</button>`;

  const countEl = el.querySelector<HTMLElement>(".toast__count")!;
  el.querySelector<HTMLButtonElement>(".toast__close")!.addEventListener(
    "click",
    () => dismissToast(el),
  );
  if (options.actionLabel && options.onAction) {
    el.querySelector<HTMLButtonElement>(".toast__action")!.addEventListener(
      "click",
      () => {
        try {
          options.onAction?.();
        } finally {
          dismissToast(el);
        }
      },
    );
  }

  const toast: ActiveToast = {
    el,
    key,
    count: 1,
    countEl,
    duration,
    remaining: duration,
    pausedReasons: new Set(),
    timerGeneration: 0,
  };

  const pause = (reason: "hover" | "focus"): void => {
    if (!active.includes(toast) || toast.pausedReasons.has(reason)) return;
    if (toast.pausedReasons.size === 0 && toast.timerStartedAt !== undefined) {
      toast.remaining = Math.max(
        0,
        toast.remaining - Math.max(0, Date.now() - toast.timerStartedAt),
      );
      clearTimer(toast);
    }
    toast.pausedReasons.add(reason);
  };

  const resume = (reason: "hover" | "focus"): void => {
    if (!toast.pausedReasons.delete(reason)) return;
    if (toast.pausedReasons.size === 0) {
      // Sticky toasts intentionally have no countdown. Their remaining value
      // is zero by design and must not turn a hover/focus transition into a
      // dismissal; only timed toasts expire here.
      if (toast.duration > 0 && toast.remaining <= 0) dismissToast(toast.el);
      else armTimer(toast);
    }
  };

  el.addEventListener("mouseenter", () => pause("hover"));
  el.addEventListener("mouseleave", () => resume("hover"));
  el.addEventListener("pointerenter", () => pause("hover"));
  el.addEventListener("pointerleave", () => resume("hover"));
  el.addEventListener("focusin", () => pause("focus"));
  el.addEventListener("focusout", (event) => {
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !el.contains(related)) {
      resume("focus");
    }
  });

  active.push(toast);
  region.appendChild(el);
  armTimer(toast);

  // Keep the stack bounded, but never auto-evict sticky (duration 0)
  // toasts: those are persistent errors/warnings the user must dismiss.
  // Evict the oldest auto-dismissing toast instead; only if every visible
  // toast is sticky does the oldest sticky give way to preserve the bound.
  while (active.length > MAX_VISIBLE) {
    const evictable = active.find((t) => t.duration > 0) ?? active[0];
    dismissToast(evictable.el);
  }
}
