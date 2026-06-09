import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast, clearToasts } from "../toast.ts";

function region(): HTMLElement | null {
  return document.getElementById("toast-region");
}

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".toast"));
}

describe("toast notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="toast-region" class="toast-region"></div>`;
  });

  afterEach(() => {
    clearToasts();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders a toast with the message and type class", () => {
    showToast("Saved", { type: "success" });
    const els = toasts();
    expect(els).toHaveLength(1);
    expect(els[0].classList.contains("toast--success")).toBe(true);
    expect(els[0].querySelector(".toast__msg")?.textContent).toContain("Saved");
  });

  it("marks error and warning toasts as alerts", () => {
    showToast("Boom", { type: "error" });
    expect(toasts()[0].getAttribute("role")).toBe("alert");
  });

  it("collapses duplicate messages into a single counted toast", () => {
    showToast("Same", { type: "info" });
    showToast("Same", { type: "info" });
    showToast("Same", { type: "info" });
    const els = toasts();
    expect(els).toHaveLength(1);
    const count = els[0].querySelector<HTMLElement>(".toast__count");
    expect(count?.hidden).toBe(false);
    expect(count?.textContent).toBe("\u00d73");
  });

  it("auto-dismisses after the given duration", () => {
    showToast("Bye", { type: "info", duration: 1000 });
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    // Leave animation fallback timer removes the node.
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("keeps sticky toasts when duration is 0", () => {
    showToast("Stay", { type: "info", duration: 0 });
    vi.advanceTimersByTime(60000);
    expect(toasts()).toHaveLength(1);
  });

  it("dismisses via the close button", () => {
    showToast("Close me", { type: "info" });
    const closeBtn =
      toasts()[0].querySelector<HTMLButtonElement>(".toast__close");
    closeBtn?.click();
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("invokes the action callback and dismisses", () => {
    const onAction = vi.fn();
    showToast("Undo?", { type: "info", actionLabel: "Undo", onAction });
    const actionBtn =
      toasts()[0].querySelector<HTMLButtonElement>(".toast__action");
    actionBtn?.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("caps the number of visible toasts", () => {
    for (let i = 0; i < 8; i += 1) {
      showToast(`Message ${i}`, { type: "info", duration: 0 });
    }
    // Let the leave-animation fallback remove the dropped (oldest) toasts.
    vi.advanceTimersByTime(240);
    expect(toasts().length).toBeLessThanOrEqual(4);
  });

  it("lazily creates the region if missing", () => {
    region()?.remove();
    expect(region()).toBeNull();
    showToast("Hello");
    expect(region()).not.toBeNull();
    expect(toasts()).toHaveLength(1);
  });
});
