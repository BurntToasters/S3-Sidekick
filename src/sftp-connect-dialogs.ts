import type { SftpHostKeyUnknownStep, SftpPromptStep } from "./sftp.ts";

/*
 * The two dialogs of the SFTP connect flow: the host key trust decision and the
 * keyboard-interactive answers. Both are static `.modal-overlay` blocks in
 * index.html, the same layer the copy/move dialog uses, so the focus trap,
 * background inert state and focus restore come from app-layout.ts. Each call
 * resolves exactly once. Escape and the close button are the same as Cancel.
 * Server-supplied text is only ever written as text.
 */

const TRUST_OVERLAY = "sftp-trust-overlay";
const PROMPT_OVERLAY = "sftp-prompt-overlay";

/** Closes the open SFTP dialog as cancelled. Only one is open at a time. */
let closeOpenDialog: (() => void) | null = null;

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function requireElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Show one overlay and return a function that hides it and detaches every
 * listener. The first focus goes to `focusTarget`, which is Cancel for trust so
 * that Enter never trusts a key by accident.
 */
function openOverlay(
  overlay: HTMLElement,
  focusTarget: HTMLElement,
  onDismiss: () => void,
  wire: (signal: AbortSignal) => void,
): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  // The Escape listener is in the capture phase so it runs before the global
  // shortcut handler, which would otherwise act on the page behind the dialog.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    },
    { capture: true, signal },
  );
  wire(signal);
  overlay.classList.add("active");
  focusTarget.focus();
  return () => {
    controller.abort();
    overlay.classList.remove("active");
  };
}

/**
 * Ask whether to trust a server host key the client has never seen. Resolves
 * true only when the user presses Trust and connect. A missing dialog fails
 * closed, so the connect is refused rather than trusted.
 */
export function promptSftpHostKeyTrust(
  endpoint: string,
  info: SftpHostKeyUnknownStep,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = requireElement<HTMLElement>(TRUST_OVERLAY);
    const confirm = requireElement<HTMLButtonElement>("sftp-trust-confirm");
    const cancel = requireElement<HTMLButtonElement>("sftp-trust-cancel");
    const close = requireElement<HTMLButtonElement>("sftp-trust-close");
    if (!overlay || !confirm || !cancel) {
      resolve(false);
      return;
    }
    closeSftpConnectDialogs();
    setText("sftp-trust-endpoint", endpoint);
    setText("sftp-trust-key-type", info.key_type);
    setText("sftp-trust-fingerprint", info.fingerprint_sha256);

    let settled = false;
    let hide: () => void = () => undefined;
    const finish = (trusted: boolean): void => {
      if (settled) return;
      settled = true;
      if (closeOpenDialog === dismiss) closeOpenDialog = null;
      hide();
      resolve(trusted);
    };
    const dismiss = (): void => finish(false);
    closeOpenDialog = dismiss;
    hide = openOverlay(overlay, cancel, dismiss, (signal) => {
      confirm.addEventListener("click", () => finish(true), { signal });
      cancel.addEventListener("click", dismiss, { signal });
      close?.addEventListener("click", dismiss, { signal });
    });
  });
}

/**
 * Show the server's keyboard-interactive challenge. Each prompt gets one input,
 * masked when the server says the answer must not be echoed. Resolves one
 * answer per prompt in order, or null when the user cancels. The inputs are
 * emptied and removed before the promise resolves.
 */
export function promptSftpKeyboardInteractive(
  info: SftpPromptStep,
): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve) => {
    const overlay = requireElement<HTMLElement>(PROMPT_OVERLAY);
    const form = requireElement<HTMLFormElement>("sftp-prompt-form");
    const fields = requireElement<HTMLElement>("sftp-prompt-fields");
    const cancel = requireElement<HTMLButtonElement>("sftp-prompt-cancel");
    const close = requireElement<HTMLButtonElement>("sftp-prompt-close");
    const continueButton = requireElement<HTMLButtonElement>(
      "sftp-prompt-continue",
    );
    if (!overlay || !form || !fields || !cancel || !continueButton) {
      resolve(null);
      return;
    }
    closeSftpConnectDialogs();
    setText("sftp-prompt-name", info.name);
    setText("sftp-prompt-instructions", info.instructions);
    const name = requireElement<HTMLElement>("sftp-prompt-name");
    const instructions = requireElement<HTMLElement>(
      "sftp-prompt-instructions",
    );
    if (name) name.hidden = info.name === "";
    if (instructions) instructions.hidden = info.instructions === "";

    const inputs: HTMLInputElement[] = info.prompts.map((prompt, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "sftp-prompt__field";
      const label = document.createElement("label");
      const input = document.createElement("input");
      const id = `sftp-prompt-answer-${index}`;
      label.htmlFor = id;
      label.textContent = prompt.text.trim();
      input.id = id;
      input.className = "field field--full";
      input.type = prompt.echo ? "text" : "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocorrect", "off");
      wrapper.append(label, input);
      fields.append(wrapper);
      return input;
    });

    let settled = false;
    let hide: () => void = () => undefined;
    const finish = (answers: string[] | null): void => {
      if (settled) return;
      settled = true;
      if (closeOpenDialog === dismiss) closeOpenDialog = null;
      hide();
      for (const input of inputs) input.value = "";
      fields.replaceChildren();
      resolve(answers);
    };
    const dismiss = (): void => finish(null);
    closeOpenDialog = dismiss;
    const firstFocus = inputs[0] ?? continueButton;
    hide = openOverlay(overlay, firstFocus, dismiss, (signal) => {
      cancel.addEventListener("click", dismiss, { signal });
      close?.addEventListener("click", dismiss, { signal });
      form.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          finish(inputs.map((input) => input.value));
        },
        { signal },
      );
    });
  });
}

/**
 * Resolve any open SFTP dialog as cancelled. Called when the attempt that owns
 * it is cancelled, superseded, or torn down by a lock, so no connect waits on a
 * dialog nobody can answer.
 */
export function closeSftpConnectDialogs(): void {
  const close = closeOpenDialog;
  closeOpenDialog = null;
  close?.();
  for (const id of [TRUST_OVERLAY, PROMPT_OVERLAY]) {
    requireElement<HTMLElement>(id)?.classList.remove("active");
  }
}
