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
    expect(els[0].getAttribute("role")).toBe("status");
    expect(els[0].querySelector(".toast__close svg")).not.toBeNull();
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

  it("pauses for hover and resumes with the remaining timeout", () => {
    showToast("Wait", { type: "info", duration: 1000 });
    const toast = toasts()[0];
    vi.advanceTimersByTime(300);
    toast.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    vi.advanceTimersByTime(700);
    expect(toasts()).toHaveLength(1);

    toast.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    vi.advanceTimersByTime(699);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("keeps the timer paused while focus and hover overlap", () => {
    showToast("Interact", { type: "info", duration: 1000 });
    const toast = toasts()[0];
    const close = toast.querySelector<HTMLButtonElement>(".toast__close")!;
    vi.advanceTimersByTime(300);
    close.focus();
    toast.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    vi.advanceTimersByTime(700);
    close.blur();
    vi.advanceTimersByTime(700);
    expect(toasts()).toHaveLength(1);

    toast.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    vi.advanceTimersByTime(699);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("keeps sticky toasts when duration is 0", () => {
    showToast("Stay", { type: "info", duration: 0 });
    vi.advanceTimersByTime(60000);
    expect(toasts()).toHaveLength(1);
  });

  it("keeps sticky toasts through hover and focus transitions", () => {
    showToast("Stay interactive", { type: "info", duration: 0 });
    const toast = toasts()[0];
    const close = toast.querySelector<HTMLButtonElement>(".toast__close")!;

    close.focus();
    toast.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    close.blur();
    toast.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    vi.advanceTimersByTime(60000);

    expect(toasts()).toHaveLength(1);
  });

  it("keeps a repeated toast sticky while it is paused", () => {
    showToast("Repeat me", { type: "info", duration: 1000 });
    const toast = toasts()[0];
    const close = toast.querySelector<HTMLButtonElement>(".toast__close")!;

    close.focus();
    vi.advanceTimersByTime(300);
    showToast("Repeat me", { type: "info", duration: 0 });
    close.blur();
    vi.advanceTimersByTime(60000);

    expect(toasts()).toHaveLength(1);
    expect(toast.querySelector<HTMLElement>(".toast__count")?.textContent).toBe(
      "×2",
    );
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

  it("caps auto-dismissing toasts", () => {
    for (let i = 0; i < 8; i += 1) {
      showToast(`Message ${i}`, { type: "info" });
    }
    // Let the leave-animation fallback remove the dropped (oldest) toasts.
    vi.advanceTimersByTime(240);
    expect(toasts().length).toBeLessThanOrEqual(4);
  });

  it("never auto-evicts sticky toasts to make room", () => {
    showToast("Sticky A", { type: "error", duration: 0 });
    showToast("Sticky B", { type: "error", duration: 0 });
    for (let i = 0; i < 6; i += 1) {
      showToast(`Transient ${i}`, { type: "info" });
    }
    vi.advanceTimersByTime(240);
    const texts = toasts().map((el) => el.textContent ?? "");
    expect(texts.some((t) => t.includes("Sticky A"))).toBe(true);
    expect(texts.some((t) => t.includes("Sticky B"))).toBe(true);
  });

  it("lazily creates the region if missing", () => {
    region()?.remove();
    expect(region()).toBeNull();
    showToast("Hello");
    expect(region()).not.toBeNull();
    expect(toasts()).toHaveLength(1);
  });
});
