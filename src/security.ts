import { invoke } from "./ipc.ts";
import {
  showConfirm,
  showPrompt,
  showAlert,
  type DialogExtraAction,
} from "./dialogs.ts";
import { state } from "./state.ts";
import { setConnectionAccessLocked } from "./connection.ts";
import { friendlyError, plural } from "./utils.ts";

const NEW_PASSWORD_WARNING =
  "Set a password to encrypt saved connections and your last-used connection with AES-256.\n\nThis password can't be recovered. If you forget it, the only way back is a factory reset, which deletes saved connections.";

const FORGOT_PASSWORD_HINT =
  "\n\nA forgotten password can't be recovered. Forgot password? starts a factory reset, which deletes saved connections.";

/** Runs the reset flow for "Forgot password?"; registered by the app wiring. */
let forgotPasswordHandler: (() => void) | null = null;

export function setForgotPasswordHandler(handler: () => void): void {
  forgotPasswordHandler = handler;
}

function forgotPasswordAction(): DialogExtraAction | undefined {
  if (!forgotPasswordHandler) return undefined;
  return {
    label: "Forgot password?",
    onSelect: () => forgotPasswordHandler?.(),
  };
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

  let biometricAttempted = false;
  let biometricErrorCode: string | null = null;
  let biometricCanceled = false;
  let biometricCredentialRemoved = false;
  let biometricUpgradeRequired = false;
  const platform = await invoke<string>("get_platform_info").catch(
    () => "unknown",
  );
  if (status.biometric_available && status.biometric_enrolled) {
    if (platform === "windows") {
      await waitForWindowFocus(WINDOWS_STARTUP_FOCUS_WAIT_MS);
      await delay(WINDOWS_STARTUP_BIOMETRIC_DELAY_MS);
    }
    const biometricOverlay = document.getElementById("biometric-overlay");
    if (biometricOverlay) {
      biometricOverlay.hidden = false;
      void biometricOverlay.offsetWidth;
    }
    await delay(150);
    try {
      status = await unlockBiometric();
      if (biometricOverlay) biometricOverlay.hidden = true;
      if (status.unlocked) return true;
    } catch (err) {
      if (biometricOverlay) biometricOverlay.hidden = true;
      biometricAttempted = true;
      biometricErrorCode = extractErrorCode(err);
      biometricCanceled = isCancellationError(err);
      biometricCredentialRemoved = isCredentialRemovedError(err);
      biometricUpgradeRequired = isSecurityUpgradeRequiredError(err);
      console.error("Biometric unlock failed");
    }
  }

  const label = biometricLabel(platform);
  const unlockMessage =
    (biometricAttempted
      ? biometricUpgradeRequired
        ? "A one-time password unlock is required to upgrade encrypted credentials after updating S3 Sidekick."
        : biometricCredentialRemoved
          ? `${label} credential was removed from the system.\nPlease unlock with your password, then re-enable ${label} in Settings.`
          : biometricCanceled
            ? "Biometric authentication was canceled.\nEnter your password to unlock encrypted credentials:"
            : biometricErrorCode
              ? `Biometric authentication was not completed (${biometricErrorCode}).\nEnter your password to unlock encrypted credentials:`
              : "Biometric authentication was not completed.\nEnter your password to unlock encrypted credentials:"
      : "Enter your password to unlock encrypted credentials:") +
    FORGOT_PASSWORD_HINT;
  // An unlock can still be running when the user presses Cancel. The backend
  // may then finish unlocking; report that state rather than claiming the
  // vault is locked while it is not.
  let pendingUnlock: Promise<unknown> | null = null;
  await showPrompt("Unlock", unlockMessage, {
    inputType: "password",
    inputPlaceholder: "Password",
    validationMessage: "Incorrect password. Try again.",
    extraAction: forgotPasswordAction(),
    validate: async (value) => {
      if (!value) return false;
      const attempt = unlockSecurity(value);
      pendingUnlock = attempt;
      try {
        status = await attempt;
        return status.unlocked;
      } catch (err) {
        return unlockFailureMessage(err);
      }
    },
  });
  if (pendingUnlock) {
    await (pendingUnlock as Promise<unknown>).catch(() => undefined);
  }
  return status.unlocked;
}

export async function refreshSecuritySettingsUI(): Promise<void> {
  const statusText = document.getElementById("security-status-text");
  const toggleBtn = document.getElementById(
    "security-toggle",
  ) as HTMLButtonElement | null;
  const changeBtn = document.getElementById(
    "security-change-password",
  ) as HTMLButtonElement | null;
  const warning = document.getElementById("security-warning");
  const lockSettings = document.getElementById("security-lock-settings");
  const lockAction = document.getElementById("security-lock-action");
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
  if (!statusText || !toggleBtn || !changeBtn || !warning) return;

  try {
    const status = await getSecurityStatus();
    const platform = await invoke<string>("get_platform_info");
    const label = biometricLabel(platform);

    if (!status.initialized) {
      statusText.textContent = "Not initialized";
      toggleBtn.textContent = "Initialize Security";
      changeBtn.style.display = "none";
      warning.style.display = "";
      if (lockSettings) lockSettings.style.display = "none";
      if (lockAction) lockAction.style.display = "none";
      if (biometricSettings) biometricSettings.style.display = "none";
    } else if (status.encryption_enabled) {
      if (status.unlocked) {
        statusText.textContent = "Encrypted (AES-256) and unlocked";
        toggleBtn.textContent = "Disable Encryption";
        changeBtn.style.display = "";
        if (lockSettings) lockSettings.style.display = "";
        if (lockAction) lockAction.style.display = "";
      } else {
        statusText.textContent = "Encrypted (locked)";
        toggleBtn.textContent = "Unlock";
        changeBtn.style.display = "none";
        if (lockSettings) lockSettings.style.display = "none";
        if (lockAction) lockAction.style.display = "none";
      }
      warning.style.display = "none";
      if (lockTimeoutSelect) {
        lockTimeoutSelect.value = String(status.lock_timeout_minutes);
      }
      if (biometricSettings && biometricToggle) {
        if (status.biometric_available && status.unlocked) {
          biometricSettings.style.display = "";
          const biometricLabelEl =
            biometricSettings.querySelector(".setting-label");
          if (biometricLabelEl)
            biometricLabelEl.textContent = `${label} Unlock`;
          // The visible text is the accessible name, so it starts the name.
          biometricToggle.textContent = status.biometric_enrolled
            ? `Disable ${label}`
            : `Enable ${label}`;
          if (biometricNote) {
            biometricNote.textContent = biometricCaveat(platform);
          }
        } else {
          biometricSettings.style.display = "none";
        }
      }
    } else {
      statusText.textContent = "Unencrypted";
      toggleBtn.textContent = "Enable Encryption";
      changeBtn.style.display = "none";
      warning.style.display = "";
      if (lockSettings) lockSettings.style.display = "none";
      if (lockAction) lockAction.style.display = "none";
      if (biometricSettings) biometricSettings.style.display = "none";
    }
  } catch (err) {
    statusText.textContent = `Could not read encryption status. ${securityErrorMessage(err)}`;
  }
}

export async function handleSecurityToggle(
  setStatus: StatusSetter,
): Promise<boolean> {
  const toggleBtn = document.getElementById(
    "security-toggle",
  ) as HTMLButtonElement | null;
  if (toggleBtn) toggleBtn.disabled = true;

  let status: SecurityStatus;
  try {
    status = await getSecurityStatus();
  } catch (err) {
    if (toggleBtn) toggleBtn.disabled = false;
    await showAlert(
      "Error",
      `Could not read encryption status. ${securityErrorMessage(err)}`,
    );
    return false;
  }

  try {
    if (!status.initialized) {
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
      await refreshSecuritySettingsUI();
      return true;
    }

    if (status.encryption_enabled && !status.unlocked) {
      if (status.biometric_available && status.biometric_enrolled) {
        try {
          await unlockBiometric();
          setStatus("Credentials unlocked.");
          await refreshSecuritySettingsUI();
          return true;
        } catch {
          // biometric failed — fall through to password
        }
      }

      let pendingUnlock: Promise<SecurityStatus> | null = null;
      let unlockResult: SecurityStatus | null = null;
      const password = await showPrompt(
        "Unlock",
        `Enter your password to unlock encrypted credentials:${FORGOT_PASSWORD_HINT}`,
        {
          inputType: "password",
          inputPlaceholder: "Password",
          validationMessage: "Incorrect password. Try again.",
          extraAction: forgotPasswordAction(),
          validate: async (value) => {
            if (!value) return false;
            try {
              const attempt = unlockSecurity(value, false);
              pendingUnlock = attempt;
              unlockResult = await attempt;
              return unlockResult.unlocked;
            } catch (err) {
              return unlockFailureMessage(err);
            }
          },
        },
      );
      if (password === null) {
        const completed = pendingUnlock
          ? await (pendingUnlock as Promise<SecurityStatus>).catch(() => null)
          : null;
        if (completed?.unlocked) await lockSecurity();
        return false;
      }
      if (unlockResult) announceSecurityReady(unlockResult);
      setStatus("Credentials unlocked.");
    } else if (status.encryption_enabled) {
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
    } else {
      const newPassword = await promptForNewPassword();
      if (!newPassword) return false;

      await setSecurityEncryption(true, null, newPassword);
      setStatus("Credential encryption enabled.");
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
    if (toggleBtn) toggleBtn.disabled = false;
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
