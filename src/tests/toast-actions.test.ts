import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast, clearToasts } from "../toast.ts";

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".toast"));
}

function actionButtons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll<HTMLButtonElement>(".toast__action"));
}

describe("toast actions and persistence (UX audit 0.12.0)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="toast-region" class="toast-region"></div>`;
  });

  afterEach(() => {
    clearToasts();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders every action in order and runs only the chosen callback", () => {
    const showFailed = vi.fn();
    const retryFailed = vi.fn();
    showToast("2 transfers failed", {
      type: "error",
      duration: 0,
      actions: [
        { label: "Show failed", onClick: showFailed },
        { label: "Retry failed", onClick: retryFailed },
      ],
    });

    const [el] = toasts();
    const buttons = actionButtons(el);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Show failed",
      "Retry failed",
    ]);
    buttons.forEach((button) => expect(button.type).toBe("button"));

    buttons[1].click();
    expect(retryFailed).toHaveBeenCalledTimes(1);
    expect(showFailed).not.toHaveBeenCalled();
    // The toast leaves after its exit animation (or the 240ms fallback).
    vi.advanceTimersByTime(240);
    expect(toasts()).toHaveLength(0);
  });

  it("keeps an action toast with duration 0 on screen past every auto-dismiss delay", () => {
    showToast("2 transfers failed", {
      type: "error",
      duration: 0,
      actions: [{ label: "Show failed", onClick: () => undefined }],
    });

    vi.advanceTimersByTime(120_000);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].classList.contains("toast--persistent")).toBe(true);
  });

  it("still supports the single actionLabel/onAction pair", () => {
    const onAction = vi.fn();
    showToast("Saved", { actionLabel: "Undo", onAction });

    const [el] = toasts();
    expect(actionButtons(el).map((b) => b.textContent)).toEqual(["Undo"]);
    actionButtons(el)[0].click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
