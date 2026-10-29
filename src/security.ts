import { invoke } from "./ipc.ts";
import { showConfirm, showPrompt, showAlert } from "./dialogs.ts";
import { state } from "./state.ts";
import { setConnectionAccessLocked } from "./connection.ts";
import { friendlyError, plural } from "./utils.ts";
import { getIconHtml } from "./icons.ts";

const NEW_PASSWORD_WARNING =
  "Set a password to encrypt saved connections and your last-used connection with AES-256.\n\nThis password can't be recovered. If you forget it, the only way back is a factory reset, which deletes saved connections.";

/** Shown in the lock view and the unlock path when the password is wrong. */
const INCORRECT_PASSWORD_MESSAGE =
  "That password is incorrect. Check caps lock and try again.";

/** Runs the reset flow for "Forgot password?"; registered by the app wiring. */
let forgotPasswordHandler: (() => void) | null = null;

export function setForgotPasswordHandler(handler: () => void): void {
  forgotPasswordHandler = handler;
}

export interface SecurityStatus {
  initialized: boolean;
  encryption_enabled: boolean;
  unlocked: boolean;
  lock_timeout_minutes: number;
  biometric_available: boolean;
  biometric_enrolled: boolean;
}

type StatusSetter = (text: string) => void;
const WINDOWS_STARTUP_BIOMETRIC_DELAY_MS = 800;
const WINDOWS_STARTUP_FOCUS_WAIT_MS = 2500;

async function getSecurityStatus(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("get_security_status");
}

function announceSecurityReady(status: SecurityStatus): void {
  if (!status.encryption_enabled || status.unlocked) {
    window.dispatchEvent(new Event("s3-sidekick:security-ready"));
  }
}

async function initializeSecurity(
  enableEncryption: boolean,
  password: string | null,
): Promise<SecurityStatus> {
  const status = await invoke<SecurityStatus>("initialize_security", {
    enableEncryption,
    password,
  });
  announceSecurityReady(status);
  return status;
}

async function unlockSecurity(
  password: string,
  announce = true,
): Promise<SecurityStatus> {
  const status = await invoke<SecurityStatus>("unlock_security", { password });
  if (announce) announceSecurityReady(status);
  return status;
}

async function setSecurityEncryption(
  enableEncryption: boolean,
  currentPassword: string | null,
  newPassword: string | null,
): Promise<SecurityStatus> {
  const status = await invoke<SecurityStatus>("set_security_encryption", {
    enableEncryption,
    currentPassword,
    newPassword,
  });
  announceSecurityReady(status);
  return status;
}

async function changeSecurityPassword(
  currentPassword: string,
  newPassword: string,
): Promise<SecurityStatus> {
  const status = await invoke<SecurityStatus>("change_security_password", {
    currentPassword,
    newPassword,
  });
  announceSecurityReady(status);
  return status;
}

async function lockSecurity(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("lock_security");
}

async function setLockTimeoutMinutes(minutes: number): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("set_lock_timeout", { minutes });
}

async function enableBiometric(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("enable_biometric");
}

async function disableBiometric(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("disable_biometric");
}

async function unlockBiometric(): Promise<SecurityStatus> {
  const status = await invoke<SecurityStatus>("unlock_biometric");
  announceSecurityReady(status);
  return status;
}

function biometricLabel(platform: string): string {
  if (platform === "macos") return "Touch ID";
  if (platform === "windows") return "Windows Hello";
  return "Biometric";
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * User-facing text for a failed vault operation. Backend strings are kept as
 * detail only when nothing more specific applies, and each common cause says
 * what the user can do next.
 */
export function securityErrorMessage(err: unknown): string {
  const text = errorText(err);
  if (/invalid password|incorrect password/i.test(text)) {
    return "That password is incorrect. Check caps lock and try again.";
  }
  if (/keychain/i.test(text) && /denied|refus|access/i.test(text)) {
    return "The system keychain denied access. Allow S3 Sidekick to use the keychain (or unlock it), then try again.";
  }
  if (/locked/i.test(text) && /unlock/i.test(text)) {
    return "Encrypted storage is locked. Unlock it with your password first.";
  }
  return friendlyError(text);
}

/** Convenience-gate caveat shown wherever biometric unlock is offered. */
export function biometricCaveat(platform: string): string {
  const label = biometricLabel(platform);
  return `${label} is a convenience gate, not hardware-bound. A process running as your operating-system user can read the stored key without completing the prompt.`;
}

export function isCancellationError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return text.includes("canceled") || text.includes("cancelled");
}

export function isCredentialRemovedError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return (
    text.includes("credential was removed") || text.includes("no longer valid")
  );
}

export function isSecurityUpgradeRequiredError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return (
    text.includes("one-time password unlock is required") ||
    text.includes("upgrade encrypted storage")
  );
}

/// Unlock prompt validation: a wrong password re-prompts with the standard
/// message; anything else (disk error, interrupted migration, bad KDF data)
/// is shown as-is so it is not mistaken for a typo.
function unlockFailureMessage(err: unknown): false | string {
  const text = errorText(err);
  if (/invalid password/i.test(text)) return false;
  return `Unlock failed: ${securityErrorMessage(err)}`;
}

function extractErrorCode(err: unknown): string | null {
  const match = errorText(err).match(/0x[0-9a-fA-F]+/);
  return match ? match[0] : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForWindowFocus(timeoutMs: number): Promise<void> {
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(finish, timeoutMs);
    const onFocus = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        finish();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        finish();
      }
    };

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      resolve();
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
  });
}

/**
 * Ask for a new password twice. Length and match problems are reported
 * inline by the dialog, so the user corrects the field instead of restarting.
 */
async function promptForNewPassword(): Promise<string | null> {
  const first = await showPrompt("Set Password", NEW_PASSWORD_WARNING, {
    inputType: "password",
    inputPlaceholder: "Password (8+ characters)",
    validationMessage: "Password must be at least 8 characters.",
    validate: async (value) => value.length >= 8,
  });
  if (first === null) return null;

  const confirmed = await showPrompt(
    "Confirm Password",
    "Type the same password again.",
    {
      inputType: "password",
      inputPlaceholder: "Confirm password",
      validationMessage: "Passwords do not match.",
      validate: async (value) => value === first,
    },
  );
  if (confirmed === null) return null;
  return first;
}

/**
 * Check the current password before the flow asks for anything else. Uses
 * the backend unlock verifier, which is idempotent for an unlocked vault.
 */
async function verifyCurrentPassword(value: string): Promise<boolean | string> {
  if (!value) return "Enter your current password.";
  try {
    await unlockSecurity(value, false);
    return true;
  } catch (err) {
    return unlockFailureMessage(err);
  }
}

export async function ensureSecurityReady(): Promise<boolean> {
  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    await showAlert(
      "Error",
      `Could not read the security status. ${securityErrorMessage(err)}`,
    );
    return false;
  }

  if (!status.initialized) {
    const enableEncryption = await showConfirm(
      "Credential Encryption",
      "Enable credential encryption?\n\nRecommended: Yes.\nSaved connections and your last-used connection will be encrypted with AES-256 and protected by your password.",
      { okLabel: "Enable", cancelLabel: "Skip" },
    );

    if (enableEncryption) {
      const password = await promptForNewPassword();
      if (!password) {
        const continueUnencrypted = await showConfirm(
          "Continue?",
          "Encryption setup was canceled.\nContinue with unencrypted credential storage?",
        );
        if (!continueUnencrypted) return false;
        try {
          status = await initializeSecurity(false, null);
        } catch (err) {
          await showAlert(
            "Error",
            `Could not finish setup. ${securityErrorMessage(err)}`,
          );
          return false;
        }
      } else {
        try {
          status = await initializeSecurity(true, password);
        } catch (err) {
          await showAlert(
            "Error",
            `Could not turn on encryption. ${securityErrorMessage(err)}`,
          );
          return false;
        }
      }
    } else {
      try {
        status = await initializeSecurity(false, null);
      } catch (err) {
        await showAlert(
          "Error",
          `Could not finish setup. ${securityErrorMessage(err)}`,
        );
        return false;
      }
    }
  }

  if (!status.encryption_enabled) {
    announceSecurityReady(status);
    return true;
  }
  if (status.unlocked) {
    announceSecurityReady(status);
    return true;
  }

  const platform = await invoke<string>("get_platform_info").catch(
    () => "unknown",
  );
  const biometricReady =
    status.biometric_available && status.biometric_enrolled;
  if (biometricReady && platform === "windows") {
    await waitForWindowFocus(WINDOWS_STARTUP_FOCUS_WAIT_MS);
    await delay(WINDOWS_STARTUP_BIOMETRIC_DELAY_MS);
  }
  return promptLockView(platform, biometricReady, null);
}

/** Biometric failure text for the lock view, keeping the existing wording. */
function biometricFailureNotice(err: unknown, label: string): string {
  if (isSecurityUpgradeRequiredError(err)) {
    return "A one-time password unlock is required to upgrade encrypted credentials after updating S3 Sidekick.";
  }
  if (isCredentialRemovedError(err)) {
    return `${label} credential was removed from the system. Please unlock with your password, then re-enable ${label} in Settings.`;
  }
  if (isCancellationError(err)) {
    return "Biometric authentication was canceled. Enter your password to unlock encrypted credentials.";
  }
  const code = extractErrorCode(err);
  if (code) {
    return `Biometric authentication was not completed (${code}). Enter your password to unlock encrypted credentials.`;
  }
  return "Biometric authentication was not completed. Enter your password to unlock encrypted credentials.";
}

/**
 * Full-window lock view. Resolves true once the vault is unlocked and false
 * when the user picks "Continue locked". Escape is swallowed and Tab stays
 * inside the view, so a mandatory lock cannot be dismissed by accident. While
 * a Touch ID / Windows Hello wait is open, Cancel returns to the password
 * field; a late biometric success still unlocks. A missing view resolves
 * false, which keeps saved connections locked.
 */
function promptLockView(
  platform: string,
  biometricReady: boolean,
  notice: string | null,
): Promise<boolean> {
  const view = document.getElementById("lock-view");
  const password = document.getElementById(
    "lock-view-password",
  ) as HTMLInputElement | null;
  const reveal = document.getElementById(
    "lock-view-reveal",
  ) as HTMLButtonElement | null;
  const form = document.getElementById(
    "lock-view-form",
  ) as HTMLFormElement | null;
  const errorEl = document.getElementById("lock-view-error");
  const noticeEl = document.getElementById("lock-view-notice");
  const unlockBtn = document.getElementById(
    "lock-view-unlock",
  ) as HTMLButtonElement | null;
  const biometricBtn = document.getElementById(
    "lock-view-biometric",
  ) as HTMLButtonElement | null;
  const forgotBtn = document.getElementById(
    "lock-view-forgot",
  ) as HTMLButtonElement | null;
  const continueBtn = document.getElementById(
    "lock-view-continue",
  ) as HTMLButtonElement | null;
  const overlay = document.getElementById("biometric-overlay");
  const overlayTitle = document.getElementById("biometric-overlay-title");
  const overlayDesc = document.getElementById("biometric-overlay-desc");
  const overlayCancel = document.getElementById(
    "biometric-overlay-cancel",
  ) as HTMLButtonElement | null;
  if (
    !view ||
    !password ||
    !reveal ||
    !form ||
    !errorEl ||
    !noticeEl ||
    !unlockBtn ||
    !biometricBtn ||
    !forgotBtn ||
    !continueBtn ||
    !overlay ||
    !overlayTitle ||
    !overlayDesc ||
    !overlayCancel
  ) {
    return Promise.resolve(false);
  }
  const lockView = view;
  const passwordInput = password;
  const revealBtn = reveal;
  const lockForm = form;
  const error = errorEl;
  const noticeText = noticeEl;
  const unlock = unlockBtn;
  const bioBtn = biometricBtn;
  const forgot = forgotBtn;
  const cont = continueBtn;
  const bioOverlay = overlay;
  const bioTitle = overlayTitle;
  const bioDesc = overlayDesc;
  const bioCancel = overlayCancel;
  const label = biometricLabel(platform);

  return new Promise<boolean>((resolve) => {
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let settled = false;
    let passwordBusy = false;
    let biometricWaiting = false;
    let cancelWait: (() => void) | null = null;

    const refreshControls = (): void => {
      unlock.disabled = passwordBusy;
      passwordInput.disabled = passwordBusy;
      cont.disabled = passwordBusy || biometricWaiting;
      bioBtn.disabled = passwordBusy || biometricWaiting;
    };
    const setError = (text: string | null): void => {
      error.textContent = text ?? "";
      error.hidden = !text;
    };
    const setNotice = (text: string | null): void => {
      noticeText.textContent = text ?? "";
      noticeText.hidden = !text;
    };
    const dialogOpen = (): boolean =>
      document.getElementById("dialog-overlay")?.classList.contains("active") ??
      false;

    const onKeyDown = (event: KeyboardEvent): void => {
      // A dialog opened from the lock view (Forgot password?) keeps its own keys.
      if (settled || dialogOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        lockView.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href]",
        ),
      ).filter((el) => !el.hasAttribute("disabled") && !el.closest("[hidden]"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      // Step through the list here rather than letting the browser Tab, since
      // WebKit skips buttons and would otherwise leave the view.
      event.preventDefault();
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      if (current === -1) {
        (event.shiftKey ? last : first).focus();
        return;
      }
      const step = event.shiftKey ? -1 : 1;
      const next =
        focusable[(current + step + focusable.length) % focusable.length];
      next?.focus();
    };

    const finish = (unlocked: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      lockForm.removeEventListener("submit", onSubmit);
      revealBtn.removeEventListener("click", onReveal);
      bioBtn.removeEventListener("click", onBiometricClick);
      forgot.removeEventListener("click", onForgot);
      cont.removeEventListener("click", onContinue);
      bioCancel.removeEventListener("click", onOverlayCancel);
      passwordInput.value = "";
      passwordInput.type = "password";
      revealBtn.textContent = "Show";
      revealBtn.setAttribute("aria-pressed", "false");
      revealBtn.setAttribute("aria-label", "Show password");
      bioOverlay.hidden = true;
      lockView.hidden = true;
      setError(null);
      setNotice(null);
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(unlocked);
    };

    const runBiometric = async (): Promise<void> => {
      if (settled || biometricWaiting || passwordBusy) return;
      biometricWaiting = true;
      setError(null);
      setNotice(null);
      bioTitle.textContent = `Waiting for ${label}`;
      bioDesc.textContent = `Approve the ${label} prompt to unlock, or cancel and type your password.`;
      bioOverlay.hidden = false;
      refreshControls();
      bioCancel.focus();
      const attempt = (async (): Promise<{
        unlocked: boolean;
        error: unknown;
      }> => {
        await delay(150);
        try {
          const unlockStatus = await unlockBiometric();
          return { unlocked: unlockStatus.unlocked, error: null };
        } catch (err) {
          console.error("Biometric unlock failed");
          return { unlocked: false, error: err };
        }
      })();
      const canceled = new Promise<"canceled">((done) => {
        cancelWait = () => done("canceled");
      });
      const outcome = await Promise.race([attempt, canceled]);
      cancelWait = null;
      if (settled) return;
      bioOverlay.hidden = true;
      if (outcome === "canceled") {
        // The OS prompt may still finish. Keep Continue disabled until it
        // settles, and accept a late success rather than dropping it.
        setNotice(
          `${label} was canceled. Enter your password to unlock encrypted credentials.`,
        );
        refreshControls();
        passwordInput.focus();
        void attempt.then((late) => {
          biometricWaiting = false;
          if (late.unlocked) {
            finish(true);
            return;
          }
          refreshControls();
        });
        return;
      }
      biometricWaiting = false;
      if (outcome.unlocked) {
        finish(true);
        return;
      }
      setNotice(biometricFailureNotice(outcome.error, label));
      refreshControls();
      passwordInput.focus();
    };

    const onSubmit = (event: Event): void => {
      event.preventDefault();
      if (settled || passwordBusy) return;
      const value = passwordInput.value;
      if (!value) {
        setError("Enter your password to unlock encrypted credentials.");
        passwordInput.focus();
        return;
      }
      passwordBusy = true;
      setError(null);
      setNotice(null);
      refreshControls();
      void unlockSecurity(value)
        .then(
          (unlockStatus) => {
            if (unlockStatus.unlocked) {
              finish(true);
              return;
            }
            setError(INCORRECT_PASSWORD_MESSAGE);
          },
          (err: unknown) => {
            const message = unlockFailureMessage(err);
            setError(message === false ? INCORRECT_PASSWORD_MESSAGE : message);
          },
        )
        .finally(() => {
          if (settled) return;
          passwordBusy = false;
          refreshControls();
          passwordInput.select();
          passwordInput.focus();
        });
    };
    const onReveal = (): void => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      revealBtn.textContent = showing ? "Show" : "Hide";
      revealBtn.setAttribute("aria-pressed", String(!showing));
      revealBtn.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password",
      );
      passwordInput.focus();
    };
    const onBiometricClick = (): void => {
      void runBiometric();
    };
    const onForgot = (): void => {
      forgotPasswordHandler?.();
    };
    const onContinue = (): void => {
      if (settled || passwordBusy || biometricWaiting) return;
      finish(false);
    };
    const onOverlayCancel = (): void => {
      cancelWait?.();
    };

    window.addEventListener("keydown", onKeyDown, true);
    lockForm.addEventListener("submit", onSubmit);
    revealBtn.addEventListener("click", onReveal);
    bioBtn.addEventListener("click", onBiometricClick);
    forgot.addEventListener("click", onForgot);
    cont.addEventListener("click", onContinue);
    bioCancel.addEventListener("click", onOverlayCancel);

    bioBtn.textContent = `Use ${label}`;
    bioBtn.hidden = !biometricReady;
    bioOverlay.hidden = true;
    lockView.hidden = false;
    setNotice(notice);
    refreshControls();
    if (biometricReady) {
      void runBiometric();
    } else {
      passwordInput.focus();
    }
  });
}

/** Set a control's visibility with the hidden attribute. */
function setHidden(el: HTMLElement | null, hidden: boolean): void {
  if (el) el.hidden = hidden;
}

/** Status-card copy and icon for the vault state. */
function describeVault(status: SecurityStatus): {
  title: string;
  detail: string;
  icon: string;
} {
  if (!status.initialized) {
    return {
      title: "Not initialized",
      detail:
        "The vault has not been set up yet. Set up encryption to protect saved credentials with AES-256 and your password.",
      icon: "alert-triangle",
    };
  }
  if (!status.encryption_enabled) {
    return {
      title: "Not encrypted",
      detail:
        "Saved credentials are stored unencrypted on this device. Set up encryption to protect them with AES-256 and your password.",
      icon: "alert-triangle",
    };
  }
  if (status.unlocked) {
    return {
      title: "Encrypted (AES-256) and unlocked",
      detail:
        "Saved connections are encrypted with AES-256. Lock now clears the keys from memory and disconnects the current session.",
      icon: "check-circle",
    };
  }
  return {
    title: "Encrypted (AES-256) and locked",
    detail:
      "Saved connections stay unavailable until you unlock them with your password.",
    icon: "lock",
  };
}

export async function refreshSecuritySettingsUI(): Promise<void> {
  const statusText = document.getElementById("security-status-text");
  const detailEl = document.getElementById("security-status-detail");
  const iconHost = document.getElementById("security-status-icon");
  const setupBtn = document.getElementById("security-setup-btn");
  const unlockBtn = document.getElementById("security-unlock-btn");
  const lockBtn = document.getElementById("security-lock-btn");
  const changeBtn = document.getElementById("security-change-password");
  const disableBtn = document.getElementById("security-disable-btn");
  const warning = document.getElementById("security-warning");
  const lockSettings = document.getElementById("security-lock-settings");
  const lockTimeoutSelect = document.getElementById(
    "security-lock-timeout",
  ) as HTMLSelectElement | null;
  const biometricSettings = document.getElementById(
    "security-biometric-settings",
  );
  const biometricToggle = document.getElementById(
    "biometric-toggle",
  ) as HTMLButtonElement | null;
  const biometricNote = document.getElementById("biometric-security-note");
  if (!statusText) return;

  try {
    const status = await getSecurityStatus();
    const platform = await invoke<string>("get_platform_info");
    const label = biometricLabel(platform);
    const view = describeVault(status);
    const unlocked = status.encryption_enabled && status.unlocked;

    statusText.textContent = view.title;
    if (detailEl) detailEl.textContent = view.detail;
    if (iconHost) {
      iconHost.innerHTML = getIconHtml(view.icon, {
        className: "lucide-icon security-status-card__svg",
      });
    }
    setHidden(setupBtn, status.encryption_enabled);
    setHidden(unlockBtn, !status.encryption_enabled || status.unlocked);
    setHidden(lockBtn, !unlocked);
    setHidden(changeBtn, !unlocked);
    setHidden(disableBtn, !unlocked);
    setHidden(warning, status.encryption_enabled);
    setHidden(lockSettings, !unlocked);
    if (status.encryption_enabled && lockTimeoutSelect) {
      lockTimeoutSelect.value = String(status.lock_timeout_minutes);
    }

    const biometricShown = unlocked && status.biometric_available;
    setHidden(biometricSettings, !biometricShown);
    if (biometricShown) {
      const biometricLabelEl =
        biometricSettings?.querySelector(".setting-label") ?? null;
      if (biometricLabelEl) biometricLabelEl.textContent = `${label} Unlock`;
      if (biometricToggle) {
        // The visible text is the accessible name, so it starts the name.
        biometricToggle.textContent = status.biometric_enrolled
          ? `Disable ${label}`
          : `Enable ${label}`;
      }
      if (biometricNote) biometricNote.textContent = biometricCaveat(platform);
    }
  } catch (err) {
    statusText.textContent = `Could not read encryption status. ${securityErrorMessage(err)}`;
    if (detailEl) detailEl.textContent = "";
  }
}

/** The Security tab action a button stands for. */
export type SecurityAction = "setup" | "unlock" | "disable";

const SECURITY_ACTION_BUTTON: Record<SecurityAction, string> = {
  setup: "security-setup-btn",
  unlock: "security-unlock-btn",
  disable: "security-disable-btn",
};

/**
 * Run the action a Security tab button names. The live vault state is read
 * first, so a button whose action no longer applies (for example after the
 * vault was locked in another window) refreshes the view and does nothing.
 */
export async function handleSecurityToggle(
  setStatus: StatusSetter,
  action: SecurityAction,
): Promise<boolean> {
  const btn = document.getElementById(
    SECURITY_ACTION_BUTTON[action],
  ) as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    if (btn) btn.disabled = false;
    await showAlert(
      "Error",
      `Could not read encryption status. ${securityErrorMessage(err)}`,
    );
    return false;
  }

  const applies =
    action === "setup"
      ? !status.encryption_enabled
      : action === "unlock"
        ? status.encryption_enabled && !status.unlocked
        : status.encryption_enabled && status.unlocked;
  if (!applies) {
    if (btn) btn.disabled = false;
    await refreshSecuritySettingsUI();
    return false;
  }

  try {
    if (action === "setup" && !status.initialized) {
      const enable = await showConfirm(
        "Initialize Security",
        "Security is not initialized yet. Enable encryption now?",
        { okLabel: "Enable", cancelLabel: "Skip" },
      );
      if (enable) {
        const password = await promptForNewPassword();
        if (!password) return false;
        await initializeSecurity(true, password);
        setStatus("Credential encryption enabled.");
      } else {
        await initializeSecurity(false, null);
        setStatus("Security initialized without encryption.");
      }
    } else if (action === "setup") {
      const newPassword = await promptForNewPassword();
      if (!newPassword) return false;
      await setSecurityEncryption(true, null, newPassword);
      setStatus("Credential encryption enabled.");
    } else if (action === "unlock") {
      const platform = await invoke<string>("get_platform_info").catch(
        () => "unknown",
      );
      const biometricReady =
        status.biometric_available && status.biometric_enrolled;
      const unlocked = await promptLockView(platform, biometricReady, null);
      if (!unlocked) {
        await refreshSecuritySettingsUI();
        return false;
      }
      setStatus("Credentials unlocked.");
    } else {
      const shouldDisable = await showConfirm(
        "Disable Encryption",
        "Disable encryption?\n\nSaved connections and your last-used connection will be stored unencrypted.",
        { okLabel: "Disable", okDanger: true },
      );
      if (!shouldDisable) return false;

      const currentPassword = await showPrompt(
        "Current Password",
        "Enter your current password to decrypt stored credentials:",
        {
          inputType: "password",
          inputPlaceholder: "Current password",
          validationMessage: "That password is incorrect. Try again.",
          validate: verifyCurrentPassword,
        },
      );
      if (currentPassword === null) return false;
      if (!currentPassword) {
        await showAlert("Error", "Current password is required.");
        return false;
      }

      await setSecurityEncryption(false, currentPassword, null);
      setStatus(
        "Credential encryption disabled. Saved credentials are unencrypted.",
      );
    }

    await refreshSecuritySettingsUI();
    return true;
  } catch (err) {
    await showAlert(
      "Error",
      `Could not update encryption. ${securityErrorMessage(err)}`,
    );
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function handleSecurityChangePassword(
  setStatus: StatusSetter,
): Promise<void> {
  const changeBtn = document.getElementById(
    "security-change-password",
  ) as HTMLButtonElement | null;
  if (changeBtn) changeBtn.disabled = true;
  try {
    // The current password is verified inline, before the new one is typed.
    const currentPassword = await showPrompt(
      "Current Password",
      "Enter your current password:",
      {
        inputType: "password",
        inputPlaceholder: "Current password",
        validationMessage: "That password is incorrect. Try again.",
        validate: verifyCurrentPassword,
      },
    );
    if (currentPassword === null) return;
    if (!currentPassword) {
      await showAlert("Error", "Current password is required.");
      return;
    }

    const newPassword = await promptForNewPassword();
    if (!newPassword) return;

    await changeSecurityPassword(currentPassword, newPassword);
    setStatus("Credential encryption password updated.");
    await refreshSecuritySettingsUI();
  } catch (err) {
    await showAlert(
      "Error",
      `Could not change the password. ${securityErrorMessage(err)}`,
    );
  } finally {
    if (changeBtn) changeBtn.disabled = false;
  }
}

/** Visible confirmation for an immediately applied auto-lock change. */
export function autoLockLabel(minutes: number): string {
  if (minutes <= 0) return "Auto-lock turned off";
  if (minutes >= 60) return "Auto-lock set to 1 hour";
  return `Auto-lock set to ${plural(minutes, "minute")}`;
}

export async function handleLockNow(setStatus: StatusSetter): Promise<boolean> {
  try {
    await lockSecurity();
    noteManualLock();
    setStatus("Encrypted storage locked.");
    await refreshSecuritySettingsUI();
    return true;
  } catch (err) {
    await showAlert(
      "Error",
      `Could not lock encrypted storage. ${securityErrorMessage(err)}`,
    );
    return false;
  }
}

export async function handleLockTimeoutChange(): Promise<void> {
  const select = document.getElementById(
    "security-lock-timeout",
  ) as HTMLSelectElement | null;
  const statusEl = document.getElementById("security-lock-status");
  if (!select) return;

  const minutes = Number(select.value);
  try {
    await setLockTimeoutMinutes(minutes);
    if (statusEl) statusEl.textContent = autoLockLabel(minutes);
  } catch (err) {
    if (statusEl) statusEl.textContent = "";
    await showAlert(
      "Error",
      `Could not change auto-lock. ${securityErrorMessage(err)}`,
    );
  }
}

export async function handleBiometricToggle(
  setStatus: StatusSetter,
): Promise<void> {
  const btn = document.getElementById(
    "biometric-toggle",
  ) as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    const status = await getSecurityStatus();
    const platform = await invoke<string>("get_platform_info");
    const label = biometricLabel(platform);

    if (status.biometric_enrolled) {
      await disableBiometric();
      setStatus(`${label} disabled.`);
    } else {
      await enableBiometric();
      setStatus(`${label} enabled.`);
    }
    await refreshSecuritySettingsUI();
  } catch (err) {
    await showAlert(
      "Error",
      `Could not change biometric unlock. ${securityErrorMessage(err)}`,
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

const AUTO_LOCK_POLL_MS = 15_000;
const ACTIVITY_TOUCH_INTERVAL_MS = 30_000;
let autoLockTimer: ReturnType<typeof setInterval> | null = null;
/** Last lock state the watcher saw; null until the first poll. */
let lastSeenUnlocked: boolean | null = null;

/**
 * Tell the watcher a lock was requested by the user, so it does not treat
 * the change as an inactivity timeout.
 */
export function noteManualLock(): void {
  lastSeenUnlocked = false;
}

/**
 * Enforce the auto-lock timeout in the running app.
 *
 * The backend expires the vault key lazily, which on its own locks nothing
 * the user can see: decrypted bookmarks stay in memory and the S3 session
 * stays live. This polls the vault state and runs `onLocked` (disconnect,
 * clear secrets, re-prompt) when an inactivity timeout has locked it. User
 * input and running transfers count as activity, so the timeout measures
 * idle time.
 */
export function startAutoLockWatcher(onLocked: () => Promise<boolean>): void {
  if (autoLockTimer !== null) return;
  let lastTouch = 0;
  let handling = false;
  let pendingAutoLockCleanup = false;
  const touch = (): void => {
    const now = Date.now();
    if (now - lastTouch < ACTIVITY_TOUCH_INTERVAL_MS) return;
    lastTouch = now;
    void invoke("touch_security_activity").catch(() => undefined);
  };
  document.addEventListener("pointerdown", touch, true);
  document.addEventListener("keydown", touch, true);

  const retryLockedCleanup = async (): Promise<void> => {
    if (handling || !pendingAutoLockCleanup) return;
    handling = true;
    try {
      if (await onLocked()) {
        pendingAutoLockCleanup = false;
        lastSeenUnlocked = false;
      }
    } catch {
      // Keep the fail-closed state and retry on the next poll.
    } finally {
      handling = false;
    }
  };

  autoLockTimer = setInterval(() => {
    if (handling) return;
    // A running transfer counts as activity. Locking would disconnect the
    // session and interrupt it (uploads restart from zero); the timeout
    // starts once the queue is idle.
    const keepAlive: Promise<unknown> =
      state.runningTransferCount > 0
        ? invoke("touch_security_activity").catch(() => undefined)
        : Promise.resolve();
    void keepAlive
      .then(async () => {
        let status: SecurityStatus;
        try {
          status = await getSecurityStatus();
        } catch {
          if (lastSeenUnlocked === true) {
            pendingAutoLockCleanup = true;
            setConnectionAccessLocked(true);
            await retryLockedCleanup();
          }
          return;
        }

        const unlocked = !status.encryption_enabled || status.unlocked;
        const wasUnlocked = lastSeenUnlocked;
        if (unlocked) {
          lastSeenUnlocked = true;
        } else if (
          wasUnlocked === true ||
          (wasUnlocked === null &&
            (state.connected || Boolean(state.connectionId)))
        ) {
          pendingAutoLockCleanup = true;
          setConnectionAccessLocked(true);
        } else if (!pendingAutoLockCleanup) {
          lastSeenUnlocked = false;
          return;
        }

        await retryLockedCleanup();
      })
      .catch(() => undefined);
  }, AUTO_LOCK_POLL_MS);
}
