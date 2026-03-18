interface ConfirmOptions {
  okLabel?: string;
  cancelLabel?: string;
  okDanger?: boolean;
}

interface PromptOptions {
  okLabel?: string;
  cancelLabel?: string;
  inputType?: "text" | "password";
  inputPlaceholder?: string;
  inputDefault?: string;
  validate?: (value: string) => Promise<boolean>;
}

interface AlertOptions {
  okLabel?: string;
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
  validate?: (value: string) => Promise<boolean>;
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
    input: document.getElementById("dialog-input") as HTMLInputElement,
    cancel: document.getElementById("dialog-cancel") as HTMLButtonElement,
    ok: document.getElementById("dialog-ok") as HTMLButtonElement,
  };
}

function shakeDialogBox(box: HTMLElement) {
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

function present(config: DialogConfig): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    const el = els();

    el.title.textContent = config.title;
    el.message.textContent = config.message;

    el.inputWrapper.style.display = config.showInput ? "" : "none";
    el.input.type = config.inputType;
    el.input.placeholder = config.inputPlaceholder;
    el.input.value = config.inputDefault;

    const isPassword = config.inputType === "password";
    el.inputWrapper.classList.toggle("dialog-input-wrapper--icon", isPassword);

    el.cancel.style.display = config.showCancel ? "" : "none";
    el.cancel.textContent = config.cancelLabel;
    el.ok.textContent = config.okLabel;
    el.ok.className = config.okDanger ? "btn btn--danger" : "btn btn--primary";

    el.overlay.classList.add("active");
    active = true;

    if (config.showInput) {
      el.input.focus();
      el.input.select();
    } else {
      el.ok.focus();
    }

    function cleanup() {
      el.overlay.classList.remove("active");
      el.cancel.removeEventListener("click", onCancel);
      el.ok.removeEventListener("click", onOk);
      el.input.removeEventListener("keydown", onInputKey);
      document.removeEventListener("keydown", onEscape, true);
      active = false;
      if (queue.length > 0) {
        const next = queue.shift()!;
        setTimeout(next, 0);
      }
    }

    function onCancel() {
      cleanup();
      resolve(config.showInput ? null : false);
    }

    async function onOk() {
      if (config.validate) {
        el.ok.disabled = true;
        const ok = await config.validate(el.input.value);
        el.ok.disabled = false;
        if (!ok) {
          shakeDialogBox(el.box);
          el.input.value = "";
          el.input.focus();
          return;
        }
      }
      cleanup();
      resolve(config.showInput ? el.input.value : true);
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
        if (config.showCancel) {
          onCancel();
        } else {
          void onOk();
        }
      }
    }

    el.cancel.addEventListener("click", onCancel);
    el.ok.addEventListener("click", onOk);
    if (config.showInput) {
      el.input.addEventListener("keydown", onInputKey);
    }
    document.addEventListener("keydown", onEscape, true);
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (!active) return fn();
  return new Promise<T>((resolve) => {
    queue.push(() => {
      void fn().then(resolve);
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
        validate: options?.validate,
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

export function isDialogActive(): boolean {
  return active;
}
