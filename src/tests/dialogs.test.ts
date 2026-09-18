import { beforeEach, describe, expect, it, vi } from "vitest";

async function tick(): Promise<void> {
  await Promise.resolve();
}

describe("dialogs", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="dialog-overlay" class="dialog-overlay">
        <div class="dialog-box">
          <div id="dialog-title"></div>
          <div id="dialog-message"></div>
          <div class="dialog-input-wrapper">
            <span id="dialog-input-icon"></span>
            <label id="dialog-input-label" for="dialog-input">Value</label>
            <input id="dialog-input" />
            <button id="dialog-input-reveal" hidden></button>
          </div>
          <p id="dialog-validation-error" role="alert" hidden></p>
          <div class="dialog-box__actions">
            <button id="dialog-cancel"></button>
            <button id="dialog-ok"></button>
          </div>
        </div>
      </div>
    `;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    if (!HTMLElement.prototype.animate) {
      Object.defineProperty(HTMLElement.prototype, "animate", {
        value: vi.fn(() => ({ finished: Promise.resolve() })),
        configurable: true,
      });
    }
  });

  it("showConfirm resolves true on OK and false on cancel", async () => {
    const dialogs = await import("../dialogs.ts");
    const overlay = document.getElementById("dialog-overlay") as HTMLDivElement;

    const okPromise = dialogs.showConfirm("Delete", "Delete file?");
    expect(dialogs.isDialogActive()).toBe(true);
    expect(overlay.classList.contains("active")).toBe(true);
    (document.getElementById("dialog-ok") as HTMLButtonElement).click();
    await expect(okPromise).resolves.toBe(true);
    expect(dialogs.isDialogActive()).toBe(false);

    const cancelPromise = dialogs.showConfirm("Again", "Cancel?");
    (document.getElementById("dialog-cancel") as HTMLButtonElement).click();
    await expect(cancelPromise).resolves.toBe(false);
    expect(overlay.classList.contains("active")).toBe(false);
  });

  it("showPrompt returns text, validates input, and supports Enter", async () => {
    const dialogs = await import("../dialogs.ts");
    const input = document.getElementById("dialog-input") as HTMLInputElement;

    const promptPromise = dialogs.showPrompt("Name", "Type value", {
      validate: async (value) => value === "valid",
    });
    input.value = "invalid";
    (document.getElementById("dialog-ok") as HTMLButtonElement).click();
    await tick();
    expect(dialogs.isDialogActive()).toBe(true);
    expect(input.value).toBe("");

    input.value = "valid";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await expect(promptPromise).resolves.toBe("valid");
  });

  it("announces validation errors, clears ARIA state, and honors reduced motion", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    const animate = vi.spyOn(HTMLElement.prototype, "animate");
    animate.mockClear();
    const dialogs = await import("../dialogs.ts");
    const input = document.getElementById("dialog-input") as HTMLInputElement;
    const error = document.getElementById(
      "dialog-validation-error",
    ) as HTMLElement;
    const promptPromise = dialogs.showPrompt("Name", "Type value", {
      validationMessage: "Use a unique name.",
      validate: async () => false,
    });

    input.value = "duplicate";
    (document.getElementById("dialog-ok") as HTMLButtonElement).click();
    await tick();

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-errormessage")).toBe(error.id);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Use a unique name.");
    expect(animate).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(error.hidden).toBe(true);
    (document.getElementById("dialog-cancel") as HTMLButtonElement).click();
    await expect(promptPromise).resolves.toBeNull();
  });

  it("showPrompt resets OK when validation is cancelled", async () => {
    const dialogs = await import("../dialogs.ts");
    const input = document.getElementById("dialog-input") as HTMLInputElement;
    const ok = document.getElementById("dialog-ok") as HTMLButtonElement;
    let releaseValidate: (() => void) | undefined;
    const validateGate = new Promise<boolean>((resolve) => {
      releaseValidate = () => resolve(false);
    });

    const promptPromise = dialogs.showPrompt("Password", "Enter password", {
      inputType: "password",
      validate: async () => validateGate,
    });

    input.value = "wrong";
    ok.click();
    await tick();
    expect(ok.disabled).toBe(true);

    (document.getElementById("dialog-cancel") as HTMLButtonElement).click();
    releaseValidate?.();
    await expect(promptPromise).resolves.toBeNull();

    const secondPromise = dialogs.showPrompt("Password", "Try again", {
      inputType: "password",
    });
    expect(ok.disabled).toBe(false);
    input.value = "value";
    ok.click();
    await expect(secondPromise).resolves.toBe("value");
  });

  it("showAlert resolves on Escape and dialog queue runs sequentially", async () => {
    vi.useFakeTimers();
    const dialogs = await import("../dialogs.ts");

    const first = dialogs.showConfirm("First", "First?");
    const second = dialogs.showConfirm("Second", "Second?");
    expect(
      (document.getElementById("dialog-title") as HTMLElement).textContent,
    ).toBe("First");

    (document.getElementById("dialog-cancel") as HTMLButtonElement).click();
    await expect(first).resolves.toBe(false);
    vi.runAllTimers();
    await tick();
    expect(
      (document.getElementById("dialog-title") as HTMLElement).textContent,
    ).toBe("Second");
    (document.getElementById("dialog-ok") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(true);

    const alertPromise = dialogs.showAlert("Notice", "Heads up");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(alertPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("covers danger-confirm styling and prompt cancel keyboard paths", async () => {
    const dialogs = await import("../dialogs.ts");
    const dangerPromise = dialogs.showConfirm("Danger", "Delete?", {
      okDanger: true,
    });
    expect(
      (document.getElementById("dialog-ok") as HTMLButtonElement).className,
    ).toBe("btn btn--danger");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(dangerPromise).resolves.toBe(false);

    const promptPromise = dialogs.showPrompt("Prompt", "Type value");
    const input = document.getElementById("dialog-input") as HTMLInputElement;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(promptPromise).resolves.toBeNull();
  });

  it("runs queued dialogs via cleanup scheduling", async () => {
    vi.useFakeTimers();
    const dialogs = await import("../dialogs.ts");

    const first = dialogs.showConfirm("First queued", "Continue?");
    const second = dialogs.showConfirm("Second queued", "Continue?");
    (document.getElementById("dialog-ok") as HTMLButtonElement).click();
    await expect(first).resolves.toBe(true);

    vi.runAllTimers();
    await tick();
    expect(
      (document.getElementById("dialog-title") as HTMLElement).textContent,
    ).toBe("Second queued");
    (document.getElementById("dialog-cancel") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("keeps continuation dialogs behind already queued consent", async () => {
    vi.useFakeTimers();
    const dialogs = await import("../dialogs.ts");
    const title = document.getElementById("dialog-title") as HTMLElement;
    const ok = document.getElementById("dialog-ok") as HTMLButtonElement;

    const first = dialogs.showConfirm("First", "Continue?");
    const second = dialogs.showConfirm("Already queued", "Continue?");
    ok.click();
    await expect(first).resolves.toBe(true);

    const followUp = dialogs.showConfirm("Follow-up", "Apply to all?");
    vi.runOnlyPendingTimers();
    await tick();
    expect(title.textContent).toBe("Already queued");
    ok.click();
    await expect(second).resolves.toBe(true);

    vi.runOnlyPendingTimers();
    await tick();
    expect(title.textContent).toBe("Follow-up");
    ok.click();
    await expect(followUp).resolves.toBe(true);
    vi.useRealTimers();
  });
});
