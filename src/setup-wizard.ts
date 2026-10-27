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

const LAST_STEP = 4;

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

function setProgress(step: number): void {
  const bar = $("setup-wizard-progress-bar");
  const progress = bar.parentElement;
  const pct = (step / LAST_STEP) * 100;
  bar.style.width = `${pct}%`;
  progress?.setAttribute("aria-valuenow", String(Math.round(pct)));
}

function showStep(step: number): void {
  const overlay = document.getElementById("setup-wizard-overlay");
  const headingIds = [
    "setup-wizard-title-welcome",
    "setup-wizard-title-theme",
    "setup-wizard-title-encryption",
    "setup-wizard-title-updates",
    "setup-wizard-title-done",
  ];
  const steps = document.querySelectorAll<HTMLElement>(".setup-wizard-step");
  for (const s of steps) {
    const idx = Number(s.dataset.step);
    s.hidden = idx !== step;
    s.setAttribute("aria-hidden", String(idx !== step));
    if (idx === step) {
      s.tabIndex = -1;
      s.focus();
    }
  }
  overlay?.setAttribute("aria-labelledby", headingIds[step] ?? headingIds[0]);
  setProgress(step);
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

export function showSetupWizard(): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    const overlay = $("setup-wizard-overlay");
    overlay.hidden = false;

    let selectedTheme: ThemePreference = "system";
    let securityAlreadyInitialized = false;
    let securityStatusError: string | null = null;

    const checkSecurityStatus = (): Promise<void> =>
      invoke<SecurityStatus>("get_security_status")
        .then((secStatus) => {
          securityAlreadyInitialized = secStatus.initialized;
          securityStatusError = null;
        })
        .catch((err: unknown) => {
          securityStatusError = securityErrorMessage(err);
        });
    let securityCheckDone = checkSecurityStatus();

    showStep(0);

    function goTo(step: number): void {
      showStep(step);
    }

    function cleanup(): void {
      // Clear wizard passwords after init so secrets do not linger in DOM.
      try {
        encPassword.value = "";
        encConfirm.value = "";
      } catch {
        // Best-effort: inputs may already be detached.
      }
      encPassword.disabled = false;
      encConfirm.disabled = false;
      encPasswordReveal.disabled = false;
      encConfirmReveal.disabled = false;
      encStatus.hidden = true;
      encBack.disabled = false;
      overlay.hidden = true;
      welcomeNext.removeEventListener("click", onWelcomeNext);
      themeBack.removeEventListener("click", onThemeBack);
      themeNext.removeEventListener("click", wrappedThemeNext);
      encBack.removeEventListener("click", onEncBack);
      encSkip.removeEventListener("click", wrappedEncSkip);
      encNext.removeEventListener("click", wrappedEncNext);
      updatesBack.removeEventListener("click", wrappedUpdatesBack);
      updatesNext.removeEventListener("click", onUpdatesNext);
      doneBtn.removeEventListener("click", onDone);
      for (const btn of themeBtns) {
        btn.removeEventListener("click", onThemeSelect);
      }
      themeOptions?.removeEventListener("keydown", onThemeKeydown);
    }

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
    const encError = $("setup-enc-error") as HTMLElement;
    const encStatus = $("setup-enc-status") as HTMLElement;
    const encBiometric = $("setup-enc-biometric") as HTMLInputElement;
    const biometricLabel = $("setup-biometric-label") as HTMLElement;
    const biometricText = $("setup-biometric-text") as HTMLElement;
    const biometricCaveatEl = $("setup-biometric-caveat") as HTMLElement;
    const updatesBack = $("setup-updates-back") as HTMLButtonElement;
    const updatesNext = $("setup-updates-next") as HTMLButtonElement;
    const autoUpdates = $("setup-auto-updates") as HTMLInputElement;
    const updateChannel = $("setup-update-channel") as HTMLSelectElement;
    const doneBtn = $("setup-done-btn") as HTMLButtonElement;
    const themeBtns = document.querySelectorAll<HTMLButtonElement>(
      ".setup-wizard-theme-btn",
    );
    const themeOptions = document.getElementById("setup-theme-options");

    function wireRevealToggle(
      input: HTMLInputElement,
      btn: HTMLButtonElement,
    ): void {
      // Visible text carries the state; aria-pressed tells assistive tech it
      // is a toggle. The accessible name stays "Show password".
      btn.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.textContent = showing ? "Show" : "Hide";
        btn.setAttribute("aria-pressed", String(!showing));
        input.focus();
      });
    }
    wireRevealToggle(encPassword, encPasswordReveal);
    wireRevealToggle(encConfirm, encConfirmReveal);

    let encryptionCommitted = false;
    let biometricEnrolled = false;
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
      encStatus.hidden = false;
      hideEncError();
      restoreEncActionLabels();
    }

    void initBiometricUI();

    async function initBiometricUI(): Promise<void> {
      try {
        const status = await invoke<SecurityStatus>("get_security_status");
        const platform = await invoke<string>("get_platform_info");
        if (status.biometric_available) {
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
        }
      } catch {
        // biometric not available
      }
    }

    function syncThemeRovingTabindex(): void {
      for (const btn of themeBtns) {
        btn.tabIndex = btn.getAttribute("aria-checked") === "true" ? 0 : -1;
      }
    }

    function onThemeSelect(this: HTMLButtonElement): void {
      for (const btn of themeBtns) {
        btn.classList.remove("setup-wizard-theme-btn--active");
        btn.setAttribute("aria-checked", "false");
      }
      this.classList.add("setup-wizard-theme-btn--active");
      this.setAttribute("aria-checked", "true");
      selectedTheme = (this.dataset.themeValue as ThemePreference) ?? "system";
      applyTheme(selectedTheme);
      syncThemeRovingTabindex();
    }

    function onThemeKeydown(event: KeyboardEvent): void {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      event.preventDefault();
      const list = Array.from(themeBtns);
      if (list.length === 0) return;
      const current = list.findIndex(
        (btn) => btn.getAttribute("aria-checked") === "true",
      );
      let next = current < 0 ? 0 : current;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = list.length - 1;
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (current + 1 + list.length) % list.length;
      } else {
        next = (current - 1 + list.length) % list.length;
      }
      list[next].click();
      list[next].focus();
    }

    function showEncError(msg: string): void {
      encError.textContent = msg;
      encError.hidden = false;
    }

    function hideEncError(): void {
      encError.hidden = true;
    }

    function onWelcomeNext(): void {
      goTo(1);
    }

    function onThemeBack(): void {
      goTo(0);
    }

    async function onThemeNext(): Promise<void> {
      await securityCheckDone;
      if (securityStatusError) {
        securityCheckDone = checkSecurityStatus();
        await securityCheckDone;
      }
      if (securityAlreadyInitialized) {
        goTo(3);
        return;
      }
      goTo(2);
      if (securityStatusError) {
        // Not knowing is not the same as "not set up". The backend refuses
        // to re-initialize an existing vault, so say why a step may fail.
        showEncError(
          `Could not read the current security setup. ${securityStatusError} If encryption is already configured, skip this step and manage it in Settings.`,
        );
      }
    }

    function onEncBack(): void {
      hideEncError();
      restoreEncActionLabels();
      goTo(1);
    }

    async function onEncSkip(): Promise<void> {
      hideEncError();
      if (encryptionCommitted) {
        encBiometric.checked = false;
        restoreEncActionLabels();
        goTo(3);
        return;
      }
      try {
        await invoke<SecurityStatus>("initialize_security", {
          enableEncryption: false,
          password: null,
        });
      } catch (err) {
        showEncError(
          `Could not turn off encryption. ${securityErrorMessage(err)}`,
        );
        return;
      }
      goTo(3);
    }

    async function onEncNext(): Promise<void> {
      hideEncError();
      const pw = encPassword.value;
      const confirm = encConfirm.value;

      if (!encryptionCommitted) {
        if (pw.length < 8) {
          showEncError("Password must be at least 8 characters.");
          return;
        }
        if (pw !== confirm) {
          showEncError("Passwords do not match.");
          return;
        }
      }

      encNext.disabled = true;
      encSkip.disabled = true;
      encBack.disabled = true;
      try {
        if (!encryptionCommitted) {
          await invoke<SecurityStatus>("initialize_security", {
            enableEncryption: true,
            password: pw,
          });
          commitEncryptionUI();
        }

        if (encBiometric.checked && !biometricEnrolled) {
          try {
            await invoke<SecurityStatus>("enable_biometric");
            biometricEnrolled = true;
          } catch (err) {
            // Encryption is already on, so only biometric is offered again.
            showEncError(
              `Encryption is on, but biometric unlock was not enabled. ${securityErrorMessage(err)}`,
            );
            encNext.textContent = "Retry biometric";
            encSkip.hidden = false;
            encSkip.textContent = "Continue without biometric";
            return;
          }
        }

        restoreEncActionLabels();
        goTo(3);
      } catch (err) {
        showEncError(
          `Could not turn on encryption. ${securityErrorMessage(err)}`,
        );
      } finally {
        encNext.disabled = false;
        encSkip.disabled = false;
        encBack.disabled = false;
      }
    }

    async function onUpdatesBack(): Promise<void> {
      await securityCheckDone;
      goTo(securityAlreadyInitialized ? 1 : 2);
    }

    function onUpdatesNext(): void {
      goTo(4);
    }

    function onDone(): void {
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

    const wrappedThemeNext = () => void onThemeNext();
    const wrappedEncSkip = () => void onEncSkip();
    const wrappedEncNext = () => void onEncNext();
    const wrappedUpdatesBack = () => void onUpdatesBack();

    welcomeNext.addEventListener("click", onWelcomeNext);
    themeBack.addEventListener("click", onThemeBack);
    themeNext.addEventListener("click", wrappedThemeNext);
    encBack.addEventListener("click", onEncBack);
    encSkip.addEventListener("click", wrappedEncSkip);
    encNext.addEventListener("click", wrappedEncNext);
    updatesBack.addEventListener("click", wrappedUpdatesBack);
    updatesNext.addEventListener("click", onUpdatesNext);
    doneBtn.addEventListener("click", onDone);
    for (const btn of themeBtns) {
      btn.addEventListener("click", onThemeSelect);
    }
    themeOptions?.addEventListener("keydown", onThemeKeydown);
    syncThemeRovingTabindex();
  });
}
