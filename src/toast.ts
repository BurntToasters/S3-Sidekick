import { escapeHtml, twemojiIcon } from "./utils.ts";

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
  info: "2139",
  success: "2705",
  warning: "26a0",
  error: "274c",
};

const MAX_VISIBLE = 4;

interface ActiveToast {
  el: HTMLElement;
  key: string;
  count: number;
  countEl: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
}

const active: ActiveToast[] = [];

function getRegion(): HTMLElement | null {
  let region = document.getElementById("toast-region");
  if (!region) {
    if (!document.body) return null;
    region = document.createElement("div");
    region.id = "toast-region";
    region.className = "toast-region";
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "Notifications");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-relevant", "additions");
    document.body.appendChild(region);
  }
  return region;
}

function clearTimer(toast: ActiveToast): void {
  if (toast.timer !== undefined) {
    clearTimeout(toast.timer);
    toast.timer = undefined;
  }
}

function armTimer(toast: ActiveToast, duration: number): void {
  clearTimer(toast);
  if (duration > 0) {
    toast.timer = setTimeout(() => dismissToast(toast.el), duration);
  }
}

function removeFromActive(el: HTMLElement): void {
  const idx = active.findIndex((t) => t.el === el);
  if (idx !== -1) {
    clearTimer(active[idx]);
    active.splice(idx, 1);
  }
}

export function dismissToast(el: HTMLElement): void {
  removeFromActive(el);
  if (!el.isConnected) return;
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

  const type = options.type ?? "info";
  const duration = options.duration ?? DEFAULT_DURATION[type];
  const key = `${type}:${message}`;

  // Collapse repeats of the same message instead of stacking duplicates.
  const existing = active.find((t) => t.key === key);
  if (existing) {
    existing.count += 1;
    existing.countEl.textContent = `\u00d7${existing.count}`;
    existing.countEl.hidden = false;
    region.appendChild(existing.el);
    armTimer(existing, duration);
    return;
  }

  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  if (type === "error" || type === "warning") {
    el.setAttribute("role", "alert");
  }

  const action =
    options.actionLabel && options.onAction
      ? `<button type="button" class="toast__action">${escapeHtml(options.actionLabel)}</button>`
      : "";

  el.innerHTML =
    `<span class="toast__icon" aria-hidden="true">${twemojiIcon(TYPE_ICON[type], { className: "twemoji-icon toast__twemoji", decorative: true })}</span>` +
    `<span class="toast__msg">${escapeHtml(message)}<span class="toast__count" hidden></span></span>` +
    action +
    `<button type="button" class="toast__close" aria-label="Dismiss notification">\u00d7</button>`;

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

  const toast: ActiveToast = { el, key, count: 1, countEl };
  active.push(toast);
  region.appendChild(el);
  armTimer(toast, duration);

  // Keep the stack bounded; drop the oldest beyond the cap.
  while (active.length > MAX_VISIBLE) {
    dismissToast(active[0].el);
  }
}
