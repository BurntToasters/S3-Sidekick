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
});
