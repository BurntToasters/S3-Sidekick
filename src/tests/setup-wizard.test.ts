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

/**
 * The real wizard markup from index.html, so the fixture cannot drift from the
 * page. Takes the overlay's outer div through its matching close tag.
 */
function wizardMarkup(): string {
  const html = readFileSync("src/index.html", "utf8");
  const start = html.lastIndexOf(
    "<div",
    html.indexOf('id="setup-wizard-overlay"'),
  );
  const divTag = /<(\/?)div\b/g;
  divTag.lastIndex = start;
  let depth = 0;
  for (let m = divTag.exec(html); m !== null; m = divTag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, html.indexOf(">", m.index) + 1);
  }
  throw new Error("setup wizard markup not found in index.html");
}

function renderFixture(): void {
  document.body.innerHTML = wizardMarkup();
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
      "Could not turn on encryption",
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
      "biometric unlock was not enabled",
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
    expect(document.getElementById("setup-substep-done")?.hidden).toBe(false);

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
      "Could not turn off encryption",
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
      "biometric unlock was not enabled",
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

  it("offers Enable on an already-initialized vault and enables it without re-initializing", async () => {
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

    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
    (document.getElementById("setup-enc-password") as HTMLInputElement).value =
      "password123";
    (document.getElementById("setup-enc-confirm") as HTMLInputElement).value =
      "password123";
    (document.getElementById("setup-enc-next") as HTMLButtonElement).click();
    await flushMicrotasks(6);

    expect(mockInvoke).toHaveBeenCalledWith("set_security_encryption", {
      enableEncryption: true,
      currentPassword: null,
      newPassword: "password123",
    });
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "initialize_security")
        .length,
    ).toBe(0);
    expect(document.getElementById("setup-step-updates")?.hidden).toBe(false);

    (
      document.getElementById("setup-updates-back") as HTMLButtonElement
    ).click();
    await flushMicrotasks(6);
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );
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
    expect(document.getElementById("setup-substep-theme")?.hidden).toBe(false);

    (document.getElementById("setup-theme-back") as HTMLButtonElement).click();
    expect(document.getElementById("setup-substep-welcome")?.hidden).toBe(
      false,
    );

    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();
    (document.getElementById("setup-theme-next") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.getElementById("setup-step-encryption")?.hidden).toBe(
      false,
    );

    (document.getElementById("setup-enc-back") as HTMLButtonElement).click();
    expect(document.getElementById("setup-substep-theme")?.hidden).toBe(false);
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
    expect(document.getElementById("setup-substep-done")?.hidden).toBe(false);
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
    expect(reveal.textContent).toBe("Hide");
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    reveal.click();
    expect(password.type).toBe("password");
    expect(reveal.textContent).toBe("Show");
    expect(reveal.getAttribute("aria-pressed")).toBe("false");

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

  it("selects themes through one native radio group", async () => {
    renderFixture();
    const wizard = await import("../setup-wizard.ts");
    const donePromise = wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();

    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="setup-theme"]'),
    );
    expect(radios.map((radio) => radio.value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
    expect(radios.every((radio) => radio.type === "radio")).toBe(true);
    expect(radios.filter((radio) => radio.checked).map((r) => r.value)).toEqual(
      ["system"],
    );

    radios[2].click();
    expect(mockApplyTheme).toHaveBeenCalledWith("dark");
    expect(
      radios[2]
        .closest(".theme-card")
        ?.classList.contains("theme-card--active"),
    ).toBe(true);
    expect(
      radios[0]
        .closest(".theme-card")
        ?.classList.contains("theme-card--active"),
    ).toBe(false);

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

  it("moves theme focus and choice across one radio group", async () => {
    renderFixture();
    const wizard = await import("../setup-wizard.ts");
    void wizard.showSetupWizard();
    (
      document.getElementById("setup-welcome-next") as HTMLButtonElement
    ).click();

    // Arrow, Home and End move focus and the checked choice natively within
    // a radio group; E2E checks the browser keys (ux-setup-wizard.spec.ts).
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="setup-theme"]'),
    );
    for (const radio of radios) radio.focus();
    expect(document.activeElement).toBe(radios[2]);
    radios[1].click();
    expect(radios[1].checked).toBe(true);
    expect(radios[0].checked).toBe(false);
    radios[0].click();
    expect(radios[0].checked).toBe(true);
    expect(mockApplyTheme).toHaveBeenLastCalledWith("system");
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
