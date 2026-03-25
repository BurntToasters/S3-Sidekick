import { invoke } from "@tauri-apps/api/core";
import { applyTheme, saveSettings } from "./settings.ts";
import { state } from "./state.ts";
import type { ThemePreference } from "./settings-model.ts";
import type { SecurityStatus } from "./security.ts";

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
  const pct = (step / LAST_STEP) * 100;
  bar.style.width = `${pct}%`;
}

function showStep(step: number): void {
  const steps = document.querySelectorAll<HTMLElement>(".setup-wizard-step");
  for (const s of steps) {
    const idx = Number(s.dataset.step);
    s.hidden = idx !== step;
  }
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
    let currentStep = 0;
    let securityAlreadyInitialized = false;

    const securityCheckDone = invoke<SecurityStatus>("get_security_status")
      .then((secStatus) => {
        securityAlreadyInitialized = secStatus.initialized;
      })
      .catch(() => {
        /* assume not initialized */
      });

    showStep(0);

    function goTo(step: number): void {
      currentStep = step;
      showStep(step);
    }

    function cleanup(): void {
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
    const encBiometric = $("setup-enc-biometric") as HTMLInputElement;
    const biometricLabel = $("setup-biometric-label") as HTMLElement;
    const biometricText = $("setup-biometric-text") as HTMLElement;
    const updatesBack = $("setup-updates-back") as HTMLButtonElement;
    const updatesNext = $("setup-updates-next") as HTMLButtonElement;
    const autoUpdates = $("setup-auto-updates") as HTMLInputElement;
    const updateChannel = $("setup-update-channel") as HTMLSelectElement;
    const doneBtn = $("setup-done-btn") as HTMLButtonElement;
    const themeBtns = document.querySelectorAll<HTMLButtonElement>(
      ".setup-wizard-theme-btn",
    );

    function wireRevealToggle(
      input: HTMLInputElement,
      btn: HTMLButtonElement,
    ): void {
      btn.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.setAttribute(
          "aria-label",
          showing ? "Show password" : "Hide password",
        );
        input.focus();
      });
    }
    wireRevealToggle(encPassword, encPasswordReveal);
    wireRevealToggle(encConfirm, encConfirmReveal);

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
        }
      } catch {
        // biometric not available
      }
    }

    function onThemeSelect(this: HTMLButtonElement): void {
      for (const btn of themeBtns) {
        btn.classList.remove("setup-wizard-theme-btn--active");
      }
      this.classList.add("setup-wizard-theme-btn--active");
      selectedTheme = (this.dataset.themeValue as ThemePreference) ?? "system";
      applyTheme(selectedTheme);
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
      if (securityAlreadyInitialized) {
        goTo(3);
        return;
      }
      goTo(2);
    }

    function onEncBack(): void {
      hideEncError();
      goTo(1);
    }

    async function onEncSkip(): Promise<void> {
      hideEncError();
      try {
        await invoke<SecurityStatus>("initialize_security", {
          enableEncryption: false,
          password: null,
        });
      } catch {
        // non-fatal
      }
      goTo(3);
    }

    async function onEncNext(): Promise<void> {
      hideEncError();
      const pw = encPassword.value;
      const confirm = encConfirm.value;

      if (pw.length < 8) {
        showEncError("Password must be at least 8 characters.");
        return;
      }
      if (pw !== confirm) {
        showEncError("Passwords do not match.");
        return;
      }

      encNext.disabled = true;
      try {
        await invoke<SecurityStatus>("initialize_security", {
          enableEncryption: true,
          password: pw,
        });

        if (encBiometric.checked) {
          try {
            await invoke<SecurityStatus>("enable_biometric");
          } catch {
            // biometric enable failed, non-fatal
          }
        }

        goTo(3);
      } catch (err) {
        showEncError(`Failed to enable encryption: ${String(err)}`);
      } finally {
        encNext.disabled = false;
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
        encryptionEnabled: encPassword.value.length >= 8 && currentStep > 2,
        biometricEnabled: encBiometric.checked,
        autoCheckUpdates: autoUpdates.checked,
        updateChannel: updateChannel.value === "beta" ? "beta" : "release",
      };
      cleanup();
      resolve(result);
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
  });
}
