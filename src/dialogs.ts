interface ConfirmOptions {
  okLabel?: string;
  cancelLabel?: string;
  okDanger?: boolean;
}

interface CheckboxConfirmOptions extends ConfirmOptions {
  checkboxLabel: string;
}

export interface CheckboxConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

export interface DialogExtraAction {
  /** Button label shown at the left of the dialog footer. */
  label: string;
  /** Runs after the dialog has resolved as cancelled. Escape never runs it. */
  onSelect: () => void;
}

interface PromptOptions {
  okLabel?: string;
  cancelLabel?: string;
  inputType?: "text" | "password";
  inputPlaceholder?: string;
  inputDefault?: string;
  validationMessage?: string;
  /** Resolve true to accept, false to show `validationMessage`, or a string to
   * show that specific error (e.g. a failure that is not a wrong value). */
  validate?: (value: string) => Promise<boolean | string>;
  /** Optional secondary action. Activating it resolves the prompt as
   * cancelled, then runs `onSelect`. */
  extraAction?: DialogExtraAction;
}

interface AlertOptions {
  okLabel?: string;
}

export interface DialogChoice<T extends string> {
  value: T;
  label: string;
  danger?: boolean;
}

interface ChoiceDialogOptions<T extends string> {
  /** Value resolved for Escape and any dismissal that is not a choice. */
  cancelValue: T;
  /** Choice to focus when the dialog opens. Defaults to `cancelValue`. */
  initialFocus?: T;
}

interface DialogConfig {
  title: string;
  message: string;
  showInput: boolean;
  showCancel: boolean;
  okLabel: string;
  cancelLabel: string;
  okDanger: boolean;
  inputType: "text" | "password";
  inputPlaceholder: string;
  inputDefault: string;
  validationMessage?: string;
  validate?: (value: string) => Promise<boolean | string>;
  checkboxLabel?: string;
  choices?: DialogChoice<string>[];
  cancelValue?: string;
  initialFocus?: string;
  extraAction?: DialogExtraAction;
}

const queue: (() => void)[] = [];
let active = false;

function els() {
  return {
    overlay: document.getElementById("dialog-overlay")!,
    box: document.querySelector(".dialog-box") as HTMLElement,
    title: document.getElementById("dialog-title")!,
    message: document.getElementById("dialog-message")!,
    inputWrapper: document.querySelector(
      ".dialog-input-wrapper",
    ) as HTMLElement,
    inputIcon: document.getElementById("dialog-input-icon") as HTMLElement,
    inputLabel: document.getElementById(
      "dialog-input-label",
    ) as HTMLElement | null,
    input: document.getElementById("dialog-input") as HTMLInputElement,
    validationError: document.getElementById(
      "dialog-validation-error",
    ) as HTMLElement | null,
    reveal: document.getElementById("dialog-input-reveal") as HTMLButtonElement,
    checkboxWrapper: document.getElementById(
      "dialog-checkbox-wrapper",
    ) as HTMLElement | null,
    checkbox: document.getElementById(
      "dialog-checkbox",
    ) as HTMLInputElement | null,
    checkboxLabel: document.getElementById(
      "dialog-checkbox-label",
    ) as HTMLElement | null,
    choices: document.getElementById("dialog-choices") as HTMLElement | null,
    cancel: document.getElementById("dialog-cancel") as HTMLButtonElement,
    ok: document.getElementById("dialog-ok") as HTMLButtonElement,
  };
}

function shakeDialogBox(box: HTMLElement) {
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  box.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-8px)" },
      { transform: "translateX(7px)" },
      { transform: "translateX(-6px)" },
      { transform: "translateX(5px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 400, easing: "ease" },
  );
}

function present(
  config: DialogConfig,
): Promise<string | boolean | CheckboxConfirmResult | null> {
  return new Promise((resolve) => {
    const el = els();

    el.title.textContent = config.title;
    el.message.textContent = config.message;

    el.inputWrapper.style.display = config.showInput ? "" : "none";

    const showCheckbox =
      config.checkboxLabel !== undefined &&
      el.checkbox !== null &&
      el.checkboxWrapper !== null;
    if (el.checkbox) el.checkbox.checked = false;
    if (el.checkboxWrapper) el.checkboxWrapper.hidden = !showCheckbox;
    if (el.checkboxLabel)
      el.checkboxLabel.textContent = config.checkboxLabel ?? "";
    el.input.type = config.inputType;
    el.input.placeholder = config.inputPlaceholder;
    el.input.value = config.inputDefault;

    function clearValidationError() {
      el.input.removeAttribute("aria-invalid");
      el.input.removeAttribute("aria-errormessage");
      if (el.validationError) {
        el.validationError.textContent = "";
        el.validationError.hidden = true;
      }
    }

    function showValidationError(message: string) {
      el.input.setAttribute("aria-invalid", "true");
      if (el.validationError) {
        el.input.setAttribute("aria-errormessage", el.validationError.id);
        el.validationError.textContent = message;
        el.validationError.hidden = false;
      }
      shakeDialogBox(el.box);
      el.input.focus();
    }

    clearValidationError();

    const isPassword = config.inputType === "password";
    const inputLabel = isPassword ? "Password" : "Value";
    el.input.setAttribute("aria-label", inputLabel);
    if (el.inputLabel) el.inputLabel.textContent = inputLabel;
    el.inputWrapper.classList.toggle("dialog-input-wrapper--icon", isPassword);
    el.reveal.hidden = !isPassword;
    // The reveal toggle stays in the tab order: keyboard users must be able
    // to reach it, and the focus trap below already includes it.
    el.reveal.tabIndex = 0;
    if (isPassword) {
      // The accessible name stays constant; the pressed state carries the
      // revealed/hidden status so screen readers do not hear two labels.
      el.reveal.textContent = "Show";
      el.reveal.setAttribute("aria-label", "Show password");
      el.reveal.setAttribute("aria-pressed", "false");
    }

    const choices = config.choices ?? null;
    const choiceButtons: HTMLButtonElement[] = [];
    if (el.choices) {
      el.choices.replaceChildren();
      el.choices.hidden = choices === null;
    }
    if (choices && el.choices) {
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = choice.danger ? "btn btn--danger" : "btn";
        button.textContent = choice.label;
        button.dataset.choiceValue = choice.value;
        button.addEventListener("click", () => onChoice(choice.value));
        el.choices.appendChild(button);
        choiceButtons.push(button);
      }
    }

    // Choice dialogs use their own buttons, so the confirm footer is hidden.
    el.cancel.style.display =
      config.showCancel && choices === null ? "" : "none";
    el.cancel.textContent = config.cancelLabel;
    el.ok.textContent = config.okLabel;
    el.ok.className = config.okDanger ? "btn btn--danger" : "btn btn--primary";
    el.ok.disabled = false;
    el.ok.style.display = choices === null ? "" : "none";

    // The optional extra action sits at the left of the footer, beside Cancel.
    let extraButton: HTMLButtonElement | null = null;
    if (config.extraAction && choices === null && el.cancel.parentElement) {
      extraButton = document.createElement("button");
      extraButton.type = "button";
      extraButton.id = "dialog-extra";
      extraButton.className = "btn btn--ghost dialog-extra-action";
      extraButton.textContent = config.extraAction.label;
      el.cancel.parentElement.insertBefore(extraButton, el.cancel);
    }

    el.overlay.classList.add("active");
    active = true;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (choices !== null) {
      const target =
        choiceButtons.find(
          (button) =>
            button.dataset.choiceValue ===
            (config.initialFocus ?? config.cancelValue),
        ) ?? choiceButtons[0];
      target?.focus();
    } else if (config.showInput) {
      el.input.focus();
      el.input.select();
    } else if (config.okDanger && config.showCancel) {
      // A destructive action must not be the default Enter/Space target:
      // focus the safe choice so the confirmation is actually read.
      el.cancel.focus();
    } else {
      el.ok.focus();
    }

    function focusableInDialog(): HTMLElement[] {
      // The reveal toggle is in the tab order while visible (see above), so
      // it is part of the trap to match native Tab behavior.
      const candidates: (HTMLElement | null)[] =
        choices !== null
          ? choiceButtons
          : [
              config.showInput ? el.input : null,
              config.showInput && isPassword ? el.reveal : null,
              showCheckbox ? el.checkbox : null,
              extraButton,
              config.showCancel ? el.cancel : null,
              el.ok,
            ];
      return candidates.filter(
        (node): node is HTMLElement =>
          node !== null && node.offsetParent !== null,
      );
    }

    function onTrapFocus(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = focusableInDialog();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Move focus explicitly instead of relying on native Tab order: WebKit
      // (and so the macOS webview) skips checkboxes and buttons by default,
      // which left keyboard users unable to reach them.
      e.preventDefault();
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey) {
        (index <= 0 ? last : focusable[index - 1]).focus();
      } else {
        (index === -1 || index === focusable.length - 1
          ? first
          : focusable[index + 1]
        ).focus();
      }
    }

    function onReveal() {
      const showing = el.input.type === "text";
      el.input.type = showing ? "password" : "text";
      el.reveal.setAttribute("aria-pressed", String(!showing));
      el.input.focus();
    }

    if (isPassword) {
      el.reveal.addEventListener("click", onReveal);
    }

    function cleanup() {
      el.overlay.classList.remove("active");
      el.cancel.removeEventListener("click", onCancel);
      extraButton?.remove();
      el.ok.removeEventListener("click", onOk);
      el.input.removeEventListener("keydown", onInputKey);
      el.input.removeEventListener("input", clearValidationError);
      el.reveal.removeEventListener("click", onReveal);
      clearValidationError();
      // Never leave a typed password sitting in the hidden input.
      el.input.value = "";
      el.input.type = "text";
      el.reveal.hidden = true;
      el.reveal.setAttribute("aria-pressed", "false");
      el.ok.disabled = false;
      el.ok.style.display = "";
      if (el.choices) {
        el.choices.replaceChildren();
        el.choices.hidden = true;
      }
      if (el.checkboxWrapper) el.checkboxWrapper.hidden = true;
      document.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("keydown", onTrapFocus, true);
      // Restore focus to whatever was focused before the dialog opened, unless
      // another dialog is about to take over from the queue.
      if (queue.length > 0) {
        // Reserve active state until scheduled dialog starts. Promise
        // continuations may enqueue follow-up dialogs before next timer fires;
        // letting them present immediately would overlap handlers and reorder
        // user consent.
        active = true;
        const next = queue.shift();
        if (next) setTimeout(next, 0);
      } else {
        active = false;
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      }
    }

    let validating = false;
    let validateGeneration = 0;

    function onChoice(value: string) {
      cleanup();
      resolve(value);
    }

    function onCancel() {
      validateGeneration += 1;
      validating = false;
      el.ok.disabled = false;
      const checked = el.checkbox?.checked ?? false;
      cleanup();
      if (el.checkbox) el.checkbox.checked = false;
      if (choices !== null) {
        resolve(config.cancelValue ?? "");
        return;
      }
      if (showCheckbox) {
        resolve({ confirmed: false, checked });
        return;
      }
      resolve(config.showInput ? null : false);
    }

    function onExtra() {
      const extra = config.extraAction;
      if (!extra) return;
      // Same as Cancel: invalidate any in-flight validation, then resolve as
      // cancelled. The follow-up runs after the dialog has closed.
      validateGeneration += 1;
      validating = false;
      el.ok.disabled = false;
      cleanup();
      resolve(config.showInput ? null : false);
      setTimeout(extra.onSelect, 0);
    }

    async function onOk() {
      if (validating) return;
      if (config.validate) {
        const generation = ++validateGeneration;
        validating = true;
        el.ok.disabled = true;
        try {
          const ok = await config.validate(el.input.value);
          if (generation !== validateGeneration) return;
          if (ok !== true) {
            el.input.value = "";
            showValidationError(
              typeof ok === "string"
                ? ok
                : (config.validationMessage ?? "Please enter a valid value."),
            );
            return;
          }
        } catch {
          if (generation !== validateGeneration) return;
          showValidationError(
            "Validation could not be completed. Please try again.",
          );
          return;
        } finally {
          if (generation === validateGeneration) {
            validating = false;
            el.ok.disabled = false;
          }
        }
      }
      const checked = el.checkbox?.checked ?? false;
      const value = el.input.value;
      cleanup();
      if (el.checkbox) el.checkbox.checked = false;
      if (showCheckbox) {
        resolve({ confirmed: true, checked });
        return;
      }
      resolve(config.showInput ? value : true);
    }

    function onInputKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        void onOk();
      }
    }

    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (config.showCancel || choices !== null) {
          onCancel();
        } else {
          // showCancel:false is alert-only (showAlert is the sole caller that
          // passes it): Escape acknowledges the alert. Never route a confirm
          // through here — resolving onOk on Escape would silently confirm a
          // destructive choice the user tried to back out of.
          if (config.showInput || config.okDanger) {
            throw new Error(
              "Dialog misuse: showCancel:false is only valid for plain alerts.",
            );
          }
          void onOk();
        }
      }
    }

    el.cancel.addEventListener("click", onCancel);
    extraButton?.addEventListener("click", onExtra);
    el.ok.addEventListener("click", onOk);
    if (config.showInput) {
      el.input.addEventListener("keydown", onInputKey);
      el.input.addEventListener("input", clearValidationError);
    }
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("keydown", onTrapFocus, true);
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (!active) return fn();
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      fn().then(resolve, reject);
    });
  });
}

export function showConfirm(
  title: string,
  message: string,
  options?: ConfirmOptions,
): Promise<boolean> {
  return enqueue(
    () =>
      present({
        title,
        message,
        showInput: false,
        showCancel: true,
        okLabel: options?.okLabel ?? "OK",
        cancelLabel: options?.cancelLabel ?? "Cancel",
        okDanger: options?.okDanger ?? false,
        inputType: "text",
        inputPlaceholder: "",
        inputDefault: "",
      }) as Promise<boolean>,
  );
}

/**
 * Confirm with an extra checkbox (e.g. "Don't ask again"). The checkbox state
 * is reported for both choices; callers decide which choice honors it.
 */
export function showConfirmWithCheckbox(
  title: string,
  message: string,
  options: CheckboxConfirmOptions,
): Promise<CheckboxConfirmResult> {
  return enqueue(
    () =>
      present({
        title,
        message,
        showInput: false,
        showCancel: true,
        okLabel: options.okLabel ?? "OK",
        cancelLabel: options.cancelLabel ?? "Cancel",
        okDanger: options.okDanger ?? false,
        inputType: "text",
        inputPlaceholder: "",
        inputDefault: "",
        checkboxLabel: options.checkboxLabel,
      }) as Promise<CheckboxConfirmResult>,
  );
}

export function showPrompt(
  title: string,
  message: string,
  options?: PromptOptions,
): Promise<string | null> {
  return enqueue(
    () =>
      present({
        title,
        message,
        showInput: true,
        showCancel: true,
        okLabel: options?.okLabel ?? "OK",
        cancelLabel: options?.cancelLabel ?? "Cancel",
        okDanger: false,
        inputType: options?.inputType ?? "text",
        inputPlaceholder: options?.inputPlaceholder ?? "",
        inputDefault: options?.inputDefault ?? "",
        validationMessage: options?.validationMessage,
        validate: options?.validate,
        extraAction: options?.extraAction,
      }) as Promise<string | null>,
  );
}

export function showAlert(
  title: string,
  message: string,
  options?: AlertOptions,
): Promise<void> {
  return enqueue(async () => {
    await present({
      title,
      message,
      showInput: false,
      showCancel: false,
      okLabel: options?.okLabel ?? "OK",
      cancelLabel: "Cancel",
      okDanger: false,
      inputType: "text",
      inputPlaceholder: "",
      inputDefault: "",
    });
  });
}

/**
 * Ask the user to pick one of several labelled actions. Escape and any other
 * dismissal resolve `cancelValue`, so a destructive choice is never the
 * default outcome of an accidental keypress.
 */
export function showChoiceDialog<T extends string>(
  title: string,
  message: string,
  choices: DialogChoice<T>[],
  options: ChoiceDialogOptions<T>,
): Promise<T> {
  return enqueue(
    () =>
      present({
        title,
        message,
        showInput: false,
        showCancel: true,
        okLabel: "",
        cancelLabel: "Cancel",
        okDanger: false,
        inputType: "text",
        inputPlaceholder: "",
        inputDefault: "",
        choices,
        cancelValue: options.cancelValue,
        initialFocus: options.initialFocus,
      }) as Promise<T>,
  );
}

export function isDialogActive(): boolean {
  return active;
}
