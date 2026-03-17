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
}

const queue: (() => void)[] = [];
let active = false;

function els() {
  return {
    overlay: document.getElementById("dialog-overlay")!,
    title: document.getElementById("dialog-title")!,
    message: document.getElementById("dialog-message")!,
    input: document.getElementById("dialog-input") as HTMLInputElement,
    cancel: document.getElementById("dialog-cancel") as HTMLButtonElement,
    ok: document.getElementById("dialog-ok") as HTMLButtonElement,
  };
}

function present(config: DialogConfig): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    const el = els();

    el.title.textContent = config.title;
    el.message.textContent = config.message;

    el.input.style.display = config.showInput ? "" : "none";
    el.input.type = config.inputType;
    el.input.placeholder = config.inputPlaceholder;
    el.input.value = config.inputDefault;

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
      document.removeEventListener("keydown", onEscape);
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

    function onOk() {
      cleanup();
      resolve(config.showInput ? el.input.value : true);
    }

    function onInputKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      }
    }

    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (config.showCancel) {
          onCancel();
        } else {
          onOk();
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
      fn().then(resolve);
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
