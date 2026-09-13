import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockInvoke,
  mockApplyTheme,
  mockSaveSettings,
  mockFocusConnectionScreen,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockApplyTheme: vi.fn(),
  mockSaveSettings: vi.fn<() => Promise<void>>(),
  mockFocusConnectionScreen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("../settings.ts", () => ({
  applyTheme: mockApplyTheme,
  saveSettings: mockSaveSettings,
}));

vi.mock("../app-connection.ts", () => ({
  focusConnectionScreen: mockFocusConnectionScreen,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="setup-wizard-overlay" role="dialog" hidden>
      <div class="setup-wizard-progress">
        <div id="setup-wizard-progress-bar"></div>
      </div>
      <div id="setup-step-welcome" class="setup-wizard-step" data-step="0"><button id="setup-welcome-next"></button></div>
      <div id="setup-step-theme" class="setup-wizard-step" data-step="1" hidden>
        <button id="setup-theme-back"></button>
        <button id="setup-theme-next"></button>
        <div class="setup-wizard-theme-btn" data-theme-value="system"></div>
      </div>
      <div id="setup-step-encryption" class="setup-wizard-step" data-step="2" hidden>
        <button id="setup-enc-back"></button>
        <button id="setup-enc-skip"></button>
        <button id="setup-enc-next"></button>
        <input id="setup-enc-password" type="password" />
        <button id="setup-enc-password-reveal"></button>
        <input id="setup-enc-confirm" type="password" />
        <button id="setup-enc-confirm-reveal"></button>
        <p id="setup-enc-error" role="alert" aria-live="assertive" hidden></p>
        <label id="setup-biometric-label" hidden>
          <input id="setup-enc-biometric" type="checkbox" />
          <span id="setup-biometric-text"></span>
        </label>
      </div>
      <div id="setup-step-updates" class="setup-wizard-step" data-step="3" hidden>
        <button id="setup-updates-back"></button>
        <button id="setup-updates-next"></button>
        <input id="setup-auto-updates" type="checkbox" checked />
        <select id="setup-update-channel"><option value="release"></option></select>
      </div>
      <div id="setup-step-done" class="setup-wizard-step" data-step="4" hidden>
        <button id="setup-done-btn"></button>
      </div>
    </div>
  `;
}

const initializedStatus = {
  initialized: false,
  encryption_enabled: false,
  unlocked: false,
  lock_timeout_minutes: 0,
  biometric_available: false,
  biometric_enrolled: false,
};

async function flushMicrotasks(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await Promise.resolve();
}

describe("setup wizard", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockApplyTheme.mockReset();
    mockSaveSettings.mockReset().mockResolvedValue(undefined);
    mockFocusConnectionScreen.mockReset();
    renderFixture();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      return initializedStatus;
    });
  });

  it("stays on encryption step when initialization fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") throw new Error("disk full");
      return initializedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "password123";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "Failed to enable encryption",
    );
    expect(
      document.getElementById("setup-enc-error")?.getAttribute("role"),
    ).toBe("alert");
  });

  it("keeps encryption and offers biometric recovery when enrollment fails", async () => {
    const encryptedStatus = {
      ...initializedStatus,
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return encryptedStatus;
      if (command === "enable_biometric")
        throw new Error("Touch ID unavailable");
      return encryptedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "password123";
    (
      document.getElementById("setup-enc-biometric") as HTMLInputElement
    ).checked = true;
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "Failed to enable biometric",
    );
    expect(
      (document.getElementById("setup-enc-next") as HTMLButtonElement)
        .textContent,
    ).toContain("Retry biometric");
    expect(
      (document.getElementById("setup-enc-skip") as HTMLButtonElement)
        .textContent,
    ).toContain("Continue without biometric");

    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return encryptedStatus;
      if (command === "enable_biometric")
        throw new Error("Touch ID unavailable");
      return encryptedStatus;
    });
    (document.getElementById("setup-enc-skip") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(1);
  });

  it("keeps the wizard card vertically scrollable in constrained viewports", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/styles/setup-wizard.css", "utf8");
    document.head.appendChild(style);
    const card = document.createElement("div");
    card.className = "setup-wizard-card";
    document.body.appendChild(card);

    const computed = getComputedStyle(card);
    expect(computed.overflowX).toBe("hidden");
    expect(computed.overflowY).toBe("auto");
    expect(computed.overscrollBehavior).toBe("contain");
    expect(computed.maxHeight).toContain("100dvh");

    style.remove();
  });

  it("tracks setup completion via settings extras", async () => {
    const wizard = await import("../setup-wizard.ts");
    const { state } = await import("../state.ts");
    mockSaveSettings.mockResolvedValue(undefined);

    state.settingsExtras = {};
    expect(wizard.isSetupComplete()).toBe(false);
    expect(wizard.shouldShowSetupWizard()).toBe(true);

    state.settingsExtras = { _setupComplete: true };
    expect(wizard.isSetupComplete()).toBe(true);
    expect(wizard.shouldShowSetupWizard()).toBe(false);

    state.settingsExtras = {};
    await wizard.markSetupComplete();
    expect(state.settingsExtras._setupComplete).toBe(true);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("rejects empty and short passwords without backend calls", async () => {
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;

    password.value = "";
    confirm.value = "";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "at least 8 characters",
    );
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(0);

    password.value = "short";
    confirm.value = "short";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "at least 8 characters",
    );
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(0);
  });

  it("rejects mismatched passwords without backend calls", async () => {
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "different456";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "do not match",
    );
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(0);
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
  });

  it("completes opt-in flow and clears passwords after init", async () => {
    const encryptedStatus = {
      ...initializedStatus,
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return encryptedStatus;
      return encryptedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    const donePromise = wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "password123";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);

    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    expect(document.getElementById("setup-step-done")?.hidden).toBe(false);

    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();
    const result = await donePromise;

    expect(result).toMatchObject({
      encryptionEnabled: true,
      biometricEnabled: false,
      updateChannel: "release",
    });
    expect(password.value).toBe("");
    expect(confirm.value).toBe("");
    expect(
      (document.getElementById("setup-wizard-overlay") as HTMLElement).hidden,
    ).toBe(true);
    expect(mockFocusConnectionScreen).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("initialize_security", {
      enableEncryption: true,
      password: "password123",
    });
  });

  it("completes explicit Skip opt-out without a password", async () => {
    const skippedStatus = {
      ...initializedStatus,
      initialized: true,
      encryption_enabled: false,
      unlocked: true,
    };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return skippedStatus;
      return skippedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    const donePromise = wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    (document.getElementById("setup-enc-skip") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("initialize_security", {
      enableEncryption: false,
      password: null,
    });

    (
      document.getElementById("setup-auto-updates") as HTMLInputElement
    ).checked = false;
    const channel = document.getElementById(
      "setup-update-channel",
    ) as HTMLSelectElement;
    channel.innerHTML = `<option value="release">r</option><option value="beta" selected>beta</option>`;
    channel.value = "beta";
    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();
    const result = await donePromise;

    expect(result).toMatchObject({
      encryptionEnabled: false,
      biometricEnabled: false,
      autoCheckUpdates: false,
      updateChannel: "beta",
    });
    expect(
      (document.getElementById("setup-enc-password") as HTMLInputElement).value,
    ).toBe("");
  });

  it("stays on encryption step when Skip opt-out fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") throw new Error("vault locked");
      return initializedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    (document.getElementById("setup-enc-skip") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "Failed to disable encryption",
    );
  });

  it("skips password validation on retry after encryption committed", async () => {
    const encryptedStatus = {
      ...initializedStatus,
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    };
    let biometricCalls = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return initializedStatus;
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return encryptedStatus;
      if (command === "enable_biometric") {
        biometricCalls += 1;
        if (biometricCalls === 1) throw new Error("no sensor");
        return encryptedStatus;
      }
      return encryptedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "password123";
    (
      document.getElementById("setup-enc-biometric") as HTMLInputElement
    ).checked = true;
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-enc-error")?.textContent).toContain(
      "Failed to enable biometric",
    );

    // Retry with biometric unchecked and cleared passwords: committed path
    // must not re-validate or re-invoke initialize_security.
    password.value = "";
    confirm.value = "";
    (
      document.getElementById("setup-enc-biometric") as HTMLInputElement
    ).checked = false;
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(1);
  });

  it("enables biometric on opt-in and reports it in the result", async () => {
    const encryptedStatus = {
      ...initializedStatus,
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status")
        return { ...initializedStatus, biometric_available: true };
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return encryptedStatus;
      if (command === "enable_biometric") return encryptedStatus;
      return encryptedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    const donePromise = wizard.showSetupWizard();
    await flushMicrotasks();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    (document.getElementById("setup-enc-password") as HTMLInputElement).value =
      "password123";
    (document.getElementById("setup-enc-confirm") as HTMLInputElement).value =
      "password123";
    (
      document.getElementById("setup-enc-biometric") as HTMLInputElement
    ).checked = true;
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);
    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();
    const result = await donePromise;
    expect(result?.biometricEnabled).toBe(true);
    expect(result?.encryptionEnabled).toBe(true);
  });

  it("skips encryption step when security is already initialized", async () => {
    const already = { ...initializedStatus, initialized: true };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return already;
      if (command === "get_platform_info") return "macos";
      return already;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks(6);

    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);

    // Back from updates returns to theme when already initialized.
    (
      document.getElementById("setup-updates-back") as HTMLButtonElement
    ).click();
    await flushMicrotasks(6);
    expect(document.getElementById("setup-step-theme")?.hidden).toBe(false);
  });

  it("returns to encryption from updates when setup is fresh", async () => {
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    password.value = "password123";
    confirm.value = "password123";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);

    (
      document.getElementById("setup-updates-back") as HTMLButtonElement
    ).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
  });

  it("navigates welcome/theme/encryption/updates with back buttons", async () => {
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    expect(document.getElementById("setup-step-theme")?.hidden).toBe(false);

    (document.getElementById("setup-theme-back") as HTMLButtonElement).click();
    expect(document.getElementById("setup-step-welcome")?.hidden).toBe(false);

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );

    (document.getElementById("setup-enc-back") as HTMLButtonElement).click();
    expect(document.getElementById("setup-step-theme")?.hidden).toBe(false);
    expect(
      (document.getElementById("setup-enc-error") as HTMLElement).hidden,
    ).toBe(true);

    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    (document.getElementById("setup-enc-skip") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);

    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    expect(document.getElementById("setup-step-done")?.hidden).toBe(false);
  });

  it("proceeds to encryption when the initial security check fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") throw new Error("ipc down");
      if (command === "get_platform_info") return "macos";
      if (command === "initialize_security") return initializedStatus;
      return initializedStatus;
    });

    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks(6);

    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
  });

  it("toggles password visibility with reveal buttons", async () => {
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    await flushMicrotasks();

    const password = document.getElementById(
      "setup-enc-password",
    ) as HTMLInputElement;
    const reveal = document.getElementById(
      "setup-enc-password-reveal",
    ) as HTMLButtonElement;
    expect(password.type).toBe("password");

    reveal.click();
    expect(password.type).toBe("text");
    expect(reveal.getAttribute("aria-label")).toBe("Hide password");

    reveal.click();
    expect(password.type).toBe("password");
    expect(reveal.getAttribute("aria-label")).toBe("Show password");

    const confirm = document.getElementById(
      "setup-enc-confirm",
    ) as HTMLInputElement;
    const confirmReveal = document.getElementById(
      "setup-enc-confirm-reveal",
    ) as HTMLButtonElement;
    confirmReveal.click();
    expect(confirm.type).toBe("text");
    confirmReveal.click();
    expect(confirm.type).toBe("password");
  });

  it("selects themes and keeps roving tabindex in sync", async () => {
    document.body.innerHTML = `
      <div id="setup-wizard-overlay" role="dialog" hidden>
        <div class="setup-wizard-progress"><div id="setup-wizard-progress-bar"></div></div>
        <div class="setup-wizard-step" data-step="0"><h2 id="setup-wizard-title-welcome">W</h2><button id="setup-welcome-next"></button></div>
        <div class="setup-wizard-step" data-step="1" hidden>
          <h2 id="setup-wizard-title-theme">T</h2>
          <button id="setup-theme-back"></button><button id="setup-theme-next"></button>
          <div id="setup-theme-options" role="radiogroup">
            <button class="setup-wizard-theme-btn" data-theme-value="system" aria-checked="true">System</button>
            <button class="setup-wizard-theme-btn" data-theme-value="light" aria-checked="false">Light</button>
            <button class="setup-wizard-theme-btn" data-theme-value="dark" aria-checked="false">Dark</button>
          </div>
        </div>
        <div class="setup-wizard-step" data-step="2" hidden>
          <h2 id="setup-wizard-title-encryption">E</h2>
          <button id="setup-enc-back"></button><button id="setup-enc-skip">Skip</button><button id="setup-enc-next">Continue</button>
          <input id="setup-enc-password" type="password" /><button id="setup-enc-password-reveal"></button>
          <input id="setup-enc-confirm" type="password" /><button id="setup-enc-confirm-reveal"></button>
          <p id="setup-enc-error" hidden></p>
          <label id="setup-biometric-label" hidden><input id="setup-enc-biometric" type="checkbox" /><span id="setup-biometric-text"></span></label>
        </div>
        <div class="setup-wizard-step" data-step="3" hidden>
          <h2 id="setup-wizard-title-updates">U</h2>
          <button id="setup-updates-back"></button><button id="setup-updates-next"></button>
          <input id="setup-auto-updates" type="checkbox" checked />
          <select id="setup-update-channel"><option value="release">r</option><option value="beta">b</option></select>
        </div>
        <div class="setup-wizard-step" data-step="4" hidden>
          <h2 id="setup-wizard-title-done">D</h2><button id="setup-done-btn"></button>
        </div>
      </div>
    `;
    const wizard = await import("../setup-wizard.ts");
    const donePromise = wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();

    const btns = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".setup-wizard-theme-btn"),
    );
    expect(btns[0].tabIndex).toBe(0);
    expect(btns[1].tabIndex).toBe(-1);

    btns[2].click();
    expect(mockApplyTheme).toHaveBeenCalledWith("dark");
    expect(btns[2].getAttribute("aria-checked")).toBe("true");
    expect(btns[2].tabIndex).toBe(0);
    expect(btns[0].tabIndex).toBe(-1);

    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    (document.getElementById("setup-enc-skip") as HTMLButtonElement).click();
    await flushMicrotasks();
    (
      document.getElementById("setup-updates-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-done-btn") as HTMLButtonElement).click();
    const result = await donePromise;
    expect(result?.theme).toBe("dark");
  });

  it("moves theme focus with arrow keys, Home, and End", async () => {
    document.body.innerHTML = `
      <div id="setup-wizard-overlay" role="dialog" hidden>
        <div class="setup-wizard-progress"><div id="setup-wizard-progress-bar"></div></div>
        <div class="setup-wizard-step" data-step="0"><button id="setup-welcome-next"></button></div>
        <div class="setup-wizard-step" data-step="1" hidden>
          <button id="setup-theme-back"></button><button id="setup-theme-next"></button>
          <div id="setup-theme-options" role="radiogroup">
            <button class="setup-wizard-theme-btn" data-theme-value="system" aria-checked="true">System</button>
            <button class="setup-wizard-theme-btn" data-theme-value="light" aria-checked="false">Light</button>
            <button class="setup-wizard-theme-btn" data-theme-value="dark" aria-checked="false">Dark</button>
          </div>
        </div>
        <div class="setup-wizard-step" data-step="2" hidden>
          <button id="setup-enc-back"></button><button id="setup-enc-skip">Skip</button><button id="setup-enc-next">Continue</button>
          <input id="setup-enc-password" type="password" /><button id="setup-enc-password-reveal"></button>
          <input id="setup-enc-confirm" type="password" /><button id="setup-enc-confirm-reveal"></button>
          <p id="setup-enc-error" hidden></p>
          <label id="setup-biometric-label" hidden><input id="setup-enc-biometric" type="checkbox" /><span id="setup-biometric-text"></span></label>
        </div>
        <div class="setup-wizard-step" data-step="3" hidden>
          <button id="setup-updates-back"></button><button id="setup-updates-next"></button>
          <input id="setup-auto-updates" type="checkbox" checked />
          <select id="setup-update-channel"><option value="release">r</option></select>
        </div>
        <div class="setup-wizard-step" data-step="4" hidden><button id="setup-done-btn"></button></div>
      </div>
    `;
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();

    const options = document.getElementById(
      "setup-theme-options",
    ) as HTMLElement;
    const btns = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".setup-wizard-theme-btn"),
    );

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(btns[0].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(btns[1].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(btns[0].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(btns[2].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(btns[0].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(btns[1].getAttribute("aria-checked")).toBe("true");

    options.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(btns[0].getAttribute("aria-checked")).toBe("true");
  });

  it("labels biometric opt-in per platform and hides it when unavailable", async () => {
    async function labelFor(platform: string, available: boolean) {
      renderFixture();
      mockInvoke.mockImplementation(async (command) => {
        if (command === "get_security_status")
          return { ...initializedStatus, biometric_available: available };
        if (command === "get_platform_info") return platform;
        return initializedStatus;
      });
      const wizard = await import("../setup-wizard.ts");
      void wizard.showSetupWizard();
      await flushMicrotasks(6);
      return {
        hidden: (
          document.getElementById("setup-biometric-label") as HTMLElement
        ).hidden,
        text: (document.getElementById("setup-biometric-text") as HTMLElement)
          .textContent,
      };
    }

    expect(await labelFor("macos", true)).toMatchObject({
      hidden: false,
      text: "Enable Touch ID unlock",
    });
    expect(await labelFor("windows", true)).toMatchObject({
      hidden: false,
      text: "Enable Windows Hello unlock",
    });
    expect(await labelFor("linux", true)).toMatchObject({
      hidden: false,
      text: "Enable biometric unlock",
    });
    expect((await labelFor("macos", false)).hidden).toBe(true);

    renderFixture();
    mockInvoke.mockRejectedValue(new Error("ipc down"));
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("setup-biometric-label") as HTMLElement).hidden,
    ).toBe(true);
  });
});
