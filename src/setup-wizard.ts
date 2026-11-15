import { invoke } from "./ipc.ts";
import { applyTheme, saveSettings } from "./settings.ts";
import { state } from "./state.ts";
import type { ThemePreference } from "./settings-model.ts";
import {
  biometricCaveat,
  securityErrorMessage,
  type SecurityStatus,
} from "./security.ts";
import { focusConnectionScreen } from "./app-connection.ts";
import { codePointLength } from "./utils.ts";

/** Welcome + theme, security, then updates + done. */
const STEP_COUNT = 3;
/** The progress bar measures the five visible sub-screens, not the step digits. */
const SUBSTEP_COUNT = 5;
const STEP_PROGRESS: Record<string, number> = {
  "setup-wizard-title-welcome": 1,
  "setup-wizard-title-theme": 2,
  "setup-wizard-title-encryption": 3,
  "setup-wizard-title-updates": 4,
  "setup-wizard-title-done": 5,
};
const SUBSTEP_PROGRESS: Record<string, number> = {
  "setup-substep-welcome": 1,
  "setup-substep-theme": 2,
  "setup-substep-updates": 4,
  "setup-substep-done": 5,
};

interface SetupResult {
  theme: ThemePreference;
  encryptionEnabled: boolean;
  biometricEnabled: boolean;
  autoCheckUpdates: boolean;
  updateChannel: "release" | "beta";
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function setProgress(step: number, progressUnit: number): void {
  const bar = $("setup-wizard-progress-bar");
  const progress = bar.parentElement;
  const pct = (progressUnit / SUBSTEP_COUNT) * 100;
  bar.style.width = `${pct}%`;
  progress?.setAttribute("aria-valuenow", String(Math.round(pct)));
  $("setup-step-count").textContent = `Step ${step + 1} of ${STEP_COUNT}`;
}

/** Show numbered step `step` and focus the heading `focusId` inside it. */
function showStep(step: number, focusId: string): void {
  const overlay = $("setup-wizard-overlay");
  const steps = document.querySelectorAll<HTMLElement>(".setup-wizard-step");
  for (const s of steps) {
    const idx = Number(s.dataset.step);
    s.hidden = idx !== step;
    s.setAttribute("aria-hidden", String(idx !== step));
  }
  setProgress(
    step,
    STEP_PROGRESS[focusId] ?? Math.min(step + 1, SUBSTEP_COUNT),
  );
  overlay.setAttribute("aria-labelledby", focusId);
  $(focusId).focus();
}

/** Show one sub-view (welcome, theme, updates or done) inside the current step. */
function showSubstep(substepId: string): void {
  const substep = $(substepId);
  const container = substep.parentElement;
  if (container) {
    for (const sub of container.querySelectorAll<HTMLElement>(
      ":scope > .setup-wizard-substep",
    )) {
      sub.hidden = sub !== substep;
    }
  }
  const step = Number(
    substep.closest<HTMLElement>(".setup-wizard-step")?.dataset.step ?? 0,
  );
  setProgress(
    step,
    SUBSTEP_PROGRESS[substepId] ?? Math.min(step + 1, SUBSTEP_COUNT),
  );
  const heading = substep.querySelector<HTMLElement>("h2");
  if (heading) {
    $("setup-wizard-overlay").setAttribute("aria-labelledby", heading.id);
    heading.focus();
  }
}

export function isSetupComplete(): boolean {
  return state.settingsExtras._setupComplete === true;
}

export async function markSetupComplete(): Promise<void> {
  state.settingsExtras._setupComplete = true;
  await saveSettings();
}

export function shouldShowSetupWizard(): boolean {
  return !isSetupComplete();
}

/**
 * The vault state is read from the backend each time a step is about to
 * change it. The startup read goes stale after a Skip, Back or Enable, and
 * initializing an existing vault is refused by the backend.
 */
async function readVaultStatus(): Promise<SecurityStatus> {
  return invoke<SecurityStatus>("get_security_status");
}

/**
 * Encryption is already set up only once the vault exists. A fresh install
 * reports `encryption_enabled: true` before initialization (encryption is the
 * default), and that still needs a password or an explicit Skip.
 */
function encryptionIsSetUp(vault: SecurityStatus | null): boolean {
  return vault?.initialized === true && vault.encryption_enabled;
}

export function showSetupWizard(): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    const overlay = $("setup-wizard-overlay");
    overlay.hidden = false;

    // The theme preview is live. If the wizard is abandoned, put the saved
    // theme back; only a completed wizard returns the chosen theme.
    const startingTheme = state.currentSettings.theme;
    let completed = false;

    let selectedTheme: ThemePreference = "system";
    const cleanups: Array<() => void> = [];
    const listen = (
      target: EventTarget,
      type: string,
      handler: EventListener,
    ): void => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    // Closing the app without finishing must not leave the previewed theme
    // applied for the rest of the process.
    listen(window, "pagehide", () => {
      if (!completed) applyTheme(startingTheme);
    });

    const welcomeNext = $("setup-welcome-next") as HTMLButtonElement;
    const themeBack = $("setup-theme-back") as HTMLButtonElement;
    const themeNext = $("setup-theme-next") as HTMLButtonElement;
    const encBack = $("setup-enc-back") as HTMLButtonElement;
    const encSkip = $("setup-enc-skip") as HTMLButtonElement;
    const encNext = $("setup-enc-next") as HTMLButtonElement;
    const encPassword = $("setup-enc-password") as HTMLInputElement;
    const encPasswordReveal = $(
      "setup-enc-password-reveal",
    ) as HTMLButtonElement;
    const encConfirm = $("setup-enc-confirm") as HTMLInputElement;
    const encConfirmReveal = $("setup-enc-confirm-reveal") as HTMLButtonElement;
    const encPasswordError = $("setup-enc-password-error") as HTMLElement;
    const encConfirmError = $("setup-enc-confirm-error") as HTMLElement;
    const encError = $("setup-enc-error") as HTMLElement;
    const encStatus = $("setup-enc-status") as HTMLElement;
    const encSkipNote = $("setup-enc-skip-note") as HTMLElement;
    const encBiometric = $("setup-enc-biometric") as HTMLInputElement;
    encPassword.placeholder = "Password (12+ characters)";
    encPassword.minLength = 12;
    encConfirm.minLength = 12;
    const biometricLabel = $("setup-biometric-label") as HTMLElement;
    const biometricText = $("setup-biometric-text") as HTMLElement;
    const biometricUnavailable = $(
      "setup-biometric-unavailable",
    ) as HTMLElement;
    const biometricCaveatEl = $("setup-biometric-caveat") as HTMLElement;
    const updatesBack = $("setup-updates-back") as HTMLButtonElement;
    const updatesNext = $("setup-updates-next") as HTMLButtonElement;
    const autoUpdates = $("setup-auto-updates") as HTMLInputElement;
    const updateChannel = $("setup-update-channel") as HTMLSelectElement;
    const doneBtn = $("setup-done-btn") as HTMLButtonElement;
    const themeInputs = document.querySelectorAll<HTMLInputElement>(
      '#setup-substep-theme input[name="setup-theme"]',
    );

    function cleanup(): void {
      if (!completed) applyTheme(startingTheme);
      // Clear wizard passwords after init so secrets do not linger in DOM.
      encPassword.value = "";
      encConfirm.value = "";
      encPassword.type = "password";
      encConfirm.type = "password";
      encPassword.disabled = false;
      encConfirm.disabled = false;
      encPasswordReveal.disabled = false;
      encConfirmReveal.disabled = false;
      hideFieldErrors();
      encStatus.hidden = true;
      encBack.disabled = false;
      overlay.hidden = true;
      for (const remove of cleanups) remove();
    }

    function wireRevealToggle(
      input: HTMLInputElement,
      btn: HTMLButtonElement,
    ): void {
      // Visible text and the accessible name both carry the state, matching
      // the lock view toggle.
      listen(btn, "click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.textContent = showing ? "Show" : "Hide";
        btn.setAttribute("aria-pressed", String(!showing));
        btn.setAttribute(
          "aria-label",
          showing ? "Show password" : "Hide password",
        );
        input.focus();
      });
    }
    wireRevealToggle(encPassword, encPasswordReveal);
    wireRevealToggle(encConfirm, encConfirmReveal);

    let encryptionCommitted = false;
    let biometricEnrolled = false;
    let encActionToken = 0;
    const encSkipDefaultLabel = encSkip.textContent;
    const encNextDefaultLabel = encNext.textContent;

    function restoreEncActionLabels(): void {
      encSkip.textContent = encSkipDefaultLabel;
      encNext.textContent = encryptionCommitted
        ? "Continue"
        : encNextDefaultLabel;
      // Skipping means "no encryption"; once it is on, the only way forward
      // is Continue, so the skip action goes away.
      encSkip.hidden = encryptionCommitted;
      encSkipNote.hidden = encryptionCommitted;
      encSkip.removeAttribute("title");
      encNext.removeAttribute("title");
    }

    function setEncBusy(busy: boolean): void {
      // Back stays usable while the backend or keychain is busy. Next and Skip
      // are disabled together so the same action cannot be submitted twice.
      encNext.disabled = busy;
      encSkip.disabled = busy;
    }

    /**
     * Encryption is on: lock the password fields so the password cannot be
     * changed (a second initialize would fail anyway) and say so.
     */
    function commitEncryptionUI(): void {
      encryptionCommitted = true;
      encPassword.disabled = true;
      encConfirm.disabled = true;
      encPasswordReveal.disabled = true;
      encConfirmReveal.disabled = true;
      encStatus.textContent = "Encryption enabled.";
      encStatus.hidden = false;
      hideEncError();
      hideFieldErrors();
      restoreEncActionLabels();
    }

    async function initBiometricUI(): Promise<void> {
      try {
        const status = await readVaultStatus();
        const platform = await invoke<string>("get_platform_info");
        if (!status.biometric_available) {
          biometricLabel.hidden = true;
          biometricCaveatEl.hidden = true;
          biometricUnavailable.hidden = false;
          return;
        }
        biometricUnavailable.hidden = true;
        biometricLabel.hidden = false;
        if (platform === "macos") {
          biometricText.textContent = "Enable Touch ID unlock";
        } else if (platform === "windows") {
          biometricText.textContent = "Enable Windows Hello unlock";
        } else {
          biometricText.textContent = "Enable biometric unlock";
        }
        biometricCaveatEl.textContent = biometricCaveat(platform);
        biometricCaveatEl.hidden = false;
      } catch {
        // The slot keeps its space and explains why the row is absent.
        biometricLabel.hidden = true;
        biometricCaveatEl.hidden = true;
        biometricUnavailable.hidden = false;
      }
    }
    void initBiometricUI();

    function syncThemeCards(): void {
      for (const input of themeInputs) {
        input
          .closest(".theme-card")
          ?.classList.toggle("theme-card--active", input.checked);
      }
    }

    function onThemeChange(input: HTMLInputElement): void {
      if (!input.checked) return;
      selectedTheme = input.value as ThemePreference;
      applyTheme(selectedTheme);
      syncThemeCards();
    }

    /** Arrow keys move through the radio group natively; Home and End do not. */
    function onThemeKeydown(event: KeyboardEvent): void {
      if (event.key !== "Home" && event.key !== "End") return;
      const list = Array.from(themeInputs);
      const target = event.key === "Home" ? list[0] : list[list.length - 1];
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.click();
    }

    function showEncError(msg: string): void {
      encError.textContent = msg;
      encError.hidden = false;
    }

    function hideEncError(): void {
      encError.hidden = true;
    }

    function setFieldError(
      input: HTMLInputElement,
      el: HTMLElement,
      msg: string,
    ): void {
      el.textContent = msg;
      el.hidden = false;
      input.setAttribute("aria-invalid", "true");
    }

    function hideFieldErrors(): void {
      for (const [input, el] of [
        [encPassword, encPasswordError],
        [encConfirm, encConfirmError],
      ] as const) {
        el.textContent = "";
        el.hidden = true;
        input.removeAttribute("aria-invalid");
      }
    }

    function onWelcomeNext(): void {
      showSubstep("setup-substep-theme");
    }

    function onThemeBack(): void {
      showSubstep("setup-substep-welcome");
    }

    async function onThemeNext(): Promise<void> {
      let readError: string | null = null;
      let vault: SecurityStatus | null = null;
      try {
        vault = await readVaultStatus();
      } catch (err) {
        readError = securityErrorMessage(err);
      }
      showStep(1, "setup-wizard-title-encryption");
      if (readError !== null) {
        // Not knowing is not the same as "not set up". Enable and Skip both
        // read the vault again and refuse to act if it still cannot be read.
        showEncError(`Could not read the current security setup. ${readError}`);
        return;
      }
      if (encryptionIsSetUp(vault)) commitEncryptionUI();
    }

    function onEncBack(): void {
      // Any in-flight encryption action is now stale. Its eventual result is
      // ignored instead of pulling the user back to Updates.
      encActionToken += 1;
      setEncBusy(false);
      hideEncError();
      hideFieldErrors();
      restoreEncActionLabels();
      showStep(0, "setup-wizard-title-theme");
      showSubstep("setup-substep-theme");
    }

    function goToUpdates(): void {
      showStep(2, "setup-wizard-title-updates");
      showSubstep("setup-substep-updates");
    }

    /** Continue without encryption: store unencrypted (not recommended). */
    async function onEncSkip(): Promise<void> {
      hideEncError();
      hideFieldErrors();
      if (encryptionCommitted) {
        encBiometric.checked = false;
        restoreEncActionLabels();
        goToUpdates();
        return;
      }
      const token = ++encActionToken;
      setEncBusy(true);
      try {
        const vault = await readVaultStatus();
        if (token !== encActionToken) return;
        if (encryptionIsSetUp(vault)) {
          commitEncryptionUI();
          encBiometric.checked = false;
        } else if (!vault.initialized) {
          await invoke<SecurityStatus>("initialize_security", {
            enableEncryption: false,
            password: null,
          });
          if (token !== encActionToken) return;
        }
        // Already initialized without encryption: the state already matches a
        // skip, so nothing is written again.
      } catch (err) {
        if (token !== encActionToken) return;
        showEncError(
          `Could not turn off encryption. ${securityErrorMessage(err)}`,
        );
        return;
      } finally {
        if (token === encActionToken) setEncBusy(false);
      }
      restoreEncActionLabels();
      goToUpdates();
    }

    async function onEncNext(): Promise<void> {
      hideEncError();
      hideFieldErrors();
      const token = ++encActionToken;
      setEncBusy(true);
      try {
        if (!encryptionCommitted) {
          const vault = await readVaultStatus();
          if (token !== encActionToken) return;
          if (encryptionIsSetUp(vault)) {
            commitEncryptionUI();
          } else {
            const pw = encPassword.value;
            const confirm = encConfirm.value;
            if (codePointLength(pw) < 12) {
              setFieldError(
                encPassword,
                encPasswordError,
                "Password must be at least 12 characters.",
              );
              showEncError("Password must be at least 12 characters.");
              return;
            }
            if (pw !== confirm) {
              setFieldError(
                encConfirm,
                encConfirmError,
                "Passwords do not match.",
              );
              showEncError("Passwords do not match.");
              return;
            }
            if (vault.initialized) {
              // Skipped earlier: the vault exists without encryption, so turn
              // encryption on rather than initializing it again.
              await invoke<SecurityStatus>("set_security_encryption", {
                enableEncryption: true,
                currentPassword: null,
                newPassword: pw,
              });
            } else {
              await invoke<SecurityStatus>("initialize_security", {
                enableEncryption: true,
                password: pw,
              });
            }
            if (token !== encActionToken) return;
            commitEncryptionUI();
          }
        }

        if (encBiometric.checked && !biometricEnrolled) {
          try {
            await invoke<SecurityStatus>("enable_biometric");
            if (token !== encActionToken) return;
            biometricEnrolled = true;
          } catch (err) {
            if (token !== encActionToken) return;
            // Encryption is already on, so only biometric is offered again.
            encStatus.textContent =
              "Encryption is enabled. Biometric unlock was not set up, so you will use your password.";
            encStatus.hidden = false;
            showEncError(
              `Encryption is on, but biometric unlock was not enabled. ${securityErrorMessage(err)}`,
            );
            encNext.textContent = "Retry biometric";
            encNext.title =
              "Try enabling biometric unlock again. Encryption is already on.";
            encSkip.hidden = false;
            encSkip.textContent =
              "Continue without biometric (encryption stays on)";
            encSkip.title =
              "Continue setup with encryption on; you will unlock with your password.";
            return;
          }
        }

        restoreEncActionLabels();
        goToUpdates();
      } catch (err) {
        if (token !== encActionToken) return;
        showEncError(
          `Could not turn on encryption. ${securityErrorMessage(err)}`,
        );
      } finally {
        if (token === encActionToken) setEncBusy(false);
      }
    }

    function onUpdatesBack(): void {
      showStep(1, "setup-wizard-title-encryption");
    }

    function onUpdatesNext(): void {
      showSubstep("setup-substep-done");
    }

    function onDone(): void {
      completed = true;
      const result: SetupResult = {
        theme: selectedTheme,
        encryptionEnabled: encryptionCommitted,
        biometricEnabled: biometricEnrolled,
        autoCheckUpdates: autoUpdates.checked,
        updateChannel: updateChannel.value === "beta" ? "beta" : "release",
      };
      cleanup();
      resolve(result);
      focusConnectionScreen();
    }

    listen(welcomeNext, "click", onWelcomeNext);
    listen(themeBack, "click", onThemeBack);
    listen(themeNext, "click", () => void onThemeNext());
    listen(encBack, "click", onEncBack);
    listen(encSkip, "click", () => void onEncSkip());
    listen(encNext, "click", () => void onEncNext());
    listen(updatesBack, "click", onUpdatesBack);
    listen(updatesNext, "click", onUpdatesNext);
    listen(doneBtn, "click", onDone);
    for (const input of themeInputs) {
      listen(input, "change", () => onThemeChange(input));
      listen(input, "keydown", (event) =>
        onThemeKeydown(event as KeyboardEvent),
      );
    }
    syncThemeCards();

    showStep(0, "setup-wizard-title-welcome");
  });
}
