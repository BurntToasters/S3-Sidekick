import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockShowPrompt = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockShowAlert = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: mockShowConfirm,
  showPrompt: mockShowPrompt,
  showAlert: mockShowAlert,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="security-status-text"></div>
    <button id="security-toggle">Enable Encryption</button>
    <button id="security-change-password" style="display:none"></button>
    <div id="security-warning" style="display:none"></div>
    <div id="security-lock-settings" style="display:none"></div>
    <div id="security-lock-action" style="display:none"></div>
    <select id="security-lock-timeout">
      <option value="5">5</option>
      <option value="15" selected>15</option>
      <option value="30">30</option>
    </select>
    <div id="security-biometric-settings" style="display:none">
      <label for="biometric-toggle"></label>
    </div>
    <button id="biometric-toggle"></button>
    <button id="security-lock-btn"></button>
  `;
}

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    initialized: true,
    encryption_enabled: false,
    unlocked: true,
    lock_timeout_minutes: 15,
    biometric_available: false,
    biometric_enrolled: false,
    biometric_schema: 0,
    ...overrides,
  };
}

describe("security flows", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    mockShowPrompt.mockReset();
    mockShowAlert.mockReset();
    mockShowConfirm.mockResolvedValue(false);
    mockShowPrompt.mockResolvedValue(null);
    mockShowAlert.mockResolvedValue(undefined);
    renderFixture();
  });

  it("refreshes UI for uninitialized and encrypted unlocked states", async () => {
    let status = makeStatus({ initialized: false, unlocked: false });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "windows";
      return undefined;
    });

    const security = await import("../security.ts");
    await security.refreshSecuritySettingsUI();
    expect(
      (document.getElementById("security-status-text") as HTMLDivElement)
        .textContent,
    ).toBe("Not initialized");
    expect(
      (document.getElementById("security-toggle") as HTMLButtonElement)
        .textContent,
    ).toBe("Initialize Security");

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
      lock_timeout_minutes: 5,
      biometric_available: true,
      biometric_enrolled: true,
    });
    await security.refreshSecuritySettingsUI();

    expect(
      (document.getElementById("security-status-text") as HTMLDivElement)
        .textContent,
    ).toContain("unlocked");
    expect(
      (document.getElementById("security-toggle") as HTMLButtonElement)
        .textContent,
    ).toBe("Disable Encryption");
    expect(
      (document.getElementById("security-change-password") as HTMLButtonElement)
        .style.display,
    ).toBe("");
    expect(
      (document.getElementById("security-lock-timeout") as HTMLSelectElement)
        .value,
    ).toBe("5");
    expect(
      (document.getElementById("biometric-toggle") as HTMLButtonElement)
        .textContent,
    ).toBe("Disable Windows Hello");
  });

  it("initializes security without encryption from toggle handler", async () => {
    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockShowConfirm.mockResolvedValue(false);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: false,
          unlocked: true,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      return undefined;
    });

    const setStatus = vi.fn();
    const security = await import("../security.ts");
    await security.handleSecurityToggle(setStatus);

    expect(mockInvoke).toHaveBeenCalledWith("initialize_security", {
      enableEncryption: false,
      password: null,
    });
    expect(setStatus).toHaveBeenCalledWith(
      "Security initialized without encryption.",
    );
    expect(
      (document.getElementById("security-toggle") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("unlocks encrypted credentials after biometric fails", async () => {
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });

    mockShowPrompt.mockImplementation(async (_title, _msg, options) => {
      const validate = (
        options as { validate?: (value: string) => Promise<boolean> }
      )?.validate;
      if (validate) {
        const ok = await validate("supersecret");
        if (!ok) return null;
      }
      return "supersecret";
    });

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "unlock_biometric") {
        throw new Error("canceled");
      }
      if (cmd === "unlock_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "windows";
      return undefined;
    });

    const setStatus = vi.fn();
    const security = await import("../security.ts");
    await security.handleSecurityToggle(setStatus);

    expect(mockInvoke).toHaveBeenCalledWith("unlock_biometric");
    expect(mockInvoke).toHaveBeenCalledWith("unlock_security", {
      password: "supersecret",
    });
    expect(setStatus).toHaveBeenCalledWith("Credentials unlocked.");
  });

  it("changes password with validation and successful update", async () => {
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "change_security_password") return status;
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      return undefined;
    });

    const security = await import("../security.ts");
    const setStatus = vi.fn();

    mockShowPrompt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("old-password")
      .mockResolvedValueOnce("new-password")
      .mockResolvedValueOnce("new-password");
    await security.handleSecurityChangePassword(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      "Current password is required.",
    );

    await security.handleSecurityChangePassword(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("change_security_password", {
      currentPassword: "old-password",
      newPassword: "new-password",
    });
    expect(setStatus).toHaveBeenCalledWith(
      "Credential encryption password updated.",
    );
  });

  it("handles lock now, lock timeout, and biometric enable/disable", async () => {
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
      biometric_available: true,
      biometric_enrolled: false,
      lock_timeout_minutes: 15,
    });

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "lock_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: false,
          biometric_available: true,
          biometric_enrolled: false,
        });
        return status;
      }
      if (cmd === "set_lock_timeout") return status;
      if (cmd === "get_security_status") return status;
      if (cmd === "enable_biometric") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      if (cmd === "disable_biometric") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: false,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "windows";
      return undefined;
    });

    const setStatus = vi.fn();
    const security = await import("../security.ts");

    await security.handleLockNow(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("lock_security");
    expect(setStatus).toHaveBeenCalledWith("Encrypted storage locked.");

    const timeoutSelect = document.getElementById(
      "security-lock-timeout",
    ) as HTMLSelectElement;
    timeoutSelect.value = "30";
    await security.handleLockTimeoutChange();
    expect(mockInvoke).toHaveBeenCalledWith("set_lock_timeout", {
      minutes: 30,
    });

    await security.handleBiometricToggle(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("enable_biometric");
    expect(setStatus).toHaveBeenCalledWith("Windows Hello enabled.");

    await security.handleBiometricToggle(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("disable_biometric");
    expect(setStatus).toHaveBeenCalledWith("Windows Hello disabled.");
  });

  it("ensures ready by initializing and then unlocking with password fallback", async () => {
    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
      biometric_available: false,
      biometric_enrolled: false,
    });

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt
      .mockResolvedValueOnce("strong-pass")
      .mockResolvedValueOnce("strong-pass");

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: false,
          biometric_available: false,
          biometric_enrolled: false,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      if (cmd === "unlock_security") {
        if ((payload as { password?: string } | undefined)?.password) {
          status = makeStatus({
            initialized: true,
            encryption_enabled: true,
            unlocked: true,
            biometric_available: false,
            biometric_enrolled: false,
          });
        }
        return status;
      }
      return undefined;
    });

    mockShowPrompt.mockImplementationOnce(async (_t, _m, options) => {
      const validate = (
        options as { validate?: (value: string) => Promise<boolean> }
      )?.validate;
      if (validate) {
        const ok = await validate("strong-pass");
        if (!ok) return null;
      }
      return "strong-pass";
    });

    const security = await import("../security.ts");
    await expect(security.ensureSecurityReady()).resolves.toBe(true);
  });

  it("returns false when status cannot be read or setup is canceled", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("status unavailable"));
    const security = await import("../security.ts");
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to read security status"),
    );

    mockInvoke.mockReset();
    mockShowAlert.mockReset();
    mockInvoke.mockResolvedValueOnce(
      makeStatus({
        initialized: false,
        encryption_enabled: false,
        unlocked: false,
      }),
    );
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockShowPrompt.mockResolvedValueOnce(null);
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
  });

  it("shows alert failures for lock, timeout, and biometric update handlers", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "lock_security") throw new Error("lock failed");
      if (cmd === "set_lock_timeout") throw new Error("timeout failed");
      if (cmd === "get_security_status") throw new Error("status failed");
      return undefined;
    });
    const setStatus = vi.fn();
    const security = await import("../security.ts");

    await security.handleLockNow(setStatus);
    await security.handleLockTimeoutChange();
    await security.handleBiometricToggle(setStatus);

    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to lock"),
    );
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to set lock timeout"),
    );
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Biometric update failed"),
    );
  });

  it("handles initialization password validation (short, mismatch) and status-read errors", async () => {
    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    const setStatus = vi.fn();
    const security = await import("../security.ts");

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce("short");
    await security.handleSecurityToggle(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Invalid Password",
      "Password must be at least 8 characters.",
    );

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt
      .mockResolvedValueOnce("long-pass")
      .mockResolvedValueOnce("wrong-pass");
    await security.handleSecurityToggle(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Password Mismatch",
      "Passwords do not match.",
    );

    mockInvoke.mockRejectedValueOnce(new Error("status boom"));
    await security.handleSecurityToggle(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to read security status"),
    );
  });

  it("covers disable/enable encryption branches and update failure handling", async () => {
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "set_security_encryption") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: false,
          unlocked: true,
          biometric_available: false,
          biometric_enrolled: false,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    const security = await import("../security.ts");
    const setStatus = vi.fn();

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce("");
    await security.handleSecurityToggle(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      "Current password is required.",
    );

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce("current-pass");
    await security.handleSecurityToggle(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("set_security_encryption", {
      enableEncryption: false,
      currentPassword: "current-pass",
      newPassword: null,
    });
    expect(setStatus).toHaveBeenCalledWith(
      "Credential encryption disabled. Saved credentials are unencrypted.",
    );

    status = makeStatus({
      initialized: true,
      encryption_enabled: false,
      unlocked: true,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockShowPrompt
      .mockResolvedValueOnce("new-pass-123")
      .mockResolvedValueOnce("new-pass-123");
    await security.handleSecurityToggle(setStatus);
    expect(mockInvoke).toHaveBeenCalledWith("set_security_encryption", {
      enableEncryption: true,
      currentPassword: null,
      newPassword: "new-pass-123",
    });

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "set_security_encryption") {
        throw new Error("set failed");
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    mockShowPrompt
      .mockResolvedValueOnce("newer-pass-123")
      .mockResolvedValueOnce("newer-pass-123");
    await security.handleSecurityToggle(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Security update failed"),
    );
  });

  it("waits for focus on windows biometric startup path and falls back to password", async () => {
    vi.useFakeTimers();
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    vi.spyOn(document, "hasFocus").mockImplementation(() => false);
    mockShowPrompt.mockImplementation(async (_title, _msg, options) => {
      const validate = (
        options as { validate?: (value: string) => Promise<boolean> }
      )?.validate;
      if (validate) {
        const ok = await validate("win-pass-123");
        if (!ok) return null;
      }
      return "win-pass-123";
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "windows";
      if (cmd === "unlock_biometric") {
        throw new Error("biometric failed 0x8010000A canceled");
      }
      if (cmd === "unlock_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      return status;
    });

    const security = await import("../security.ts");
    const promise = security.ensureSecurityReady();
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("covers ensureSecurityReady initialization fallback and init failures", async () => {
    const security = await import("../security.ts");

    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: false,
          unlocked: false,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce(null);
    await expect(security.ensureSecurityReady()).resolves.toBe(true);

    mockInvoke.mockReset();
    mockShowAlert.mockReset();
    status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") throw new Error("init failed");
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce(null);
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to initialize security"),
    );

    mockInvoke.mockReset();
    mockShowAlert.mockReset();
    status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") throw new Error("enable failed");
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt
      .mockResolvedValueOnce("new-pass-123")
      .mockResolvedValueOnce("new-pass-123");
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to enable encryption"),
    );

    mockInvoke.mockReset();
    mockShowAlert.mockReset();
    status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") throw new Error("skip failed");
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to initialize security"),
    );
  });

  it("returns false when password confirmation is canceled during setup", async () => {
    const security = await import("../security.ts");
    const status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockShowPrompt
      .mockResolvedValueOnce("new-pass-123")
      .mockResolvedValueOnce(null);
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
  });

  it("covers unlocked short-circuit, platform fallback, biometric success, and failed password validation", async () => {
    const security = await import("../security.ts");

    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      return status;
    });
    await expect(security.ensureSecurityReady()).resolves.toBe(true);

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") throw new Error("no platform");
      if (cmd === "unlock_biometric") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      return status;
    });
    await expect(security.ensureSecurityReady()).resolves.toBe(true);

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockShowPrompt.mockImplementationOnce(async (_title, _msg, options) => {
      const validate = (
        options as { validate?: (value: string) => Promise<boolean> }
      )?.validate;
      if (!validate) return null;
      expect(await validate("")).toBe(false);
      expect(await validate("wrong-pass")).toBe(false);
      return null;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      if (cmd === "unlock_security") throw new Error("bad password");
      return status;
    });
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
  });

  it("handles refreshSecuritySettingsUI guards and errors, including macOS biometric label", async () => {
    document.body.innerHTML = "";
    const security = await import("../security.ts");
    await expect(security.refreshSecuritySettingsUI()).resolves.toBeUndefined();

    renderFixture();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") throw new Error("status down");
      if (cmd === "get_platform_info") return "linux";
      return undefined;
    });
    await security.refreshSecuritySettingsUI();
    expect(
      (document.getElementById("security-status-text") as HTMLDivElement)
        .textContent,
    ).toContain("Security status error");

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") {
        return makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
      }
      if (cmd === "get_platform_info") return "macos";
      return undefined;
    });
    await security.refreshSecuritySettingsUI();
    expect(
      (document.getElementById("biometric-toggle") as HTMLButtonElement)
        .textContent,
    ).toBe("Disable Touch ID");
  });

  it("covers remaining toggle and password-handler early-return branches", async () => {
    const security = await import("../security.ts");
    const setStatus = vi.fn();

    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "initialize_security") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt
      .mockResolvedValueOnce("valid-pass-1")
      .mockResolvedValueOnce("valid-pass-1");
    await security.handleSecurityToggle(setStatus);
    expect(setStatus).toHaveBeenCalledWith("Credential encryption enabled.");

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "unlock_biometric") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    await security.handleSecurityToggle(setStatus);
    expect(setStatus).toHaveBeenCalledWith("Credentials unlocked.");

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockShowPrompt.mockImplementationOnce(async (_title, _msg, options) => {
      const validate = (
        options as { validate?: (value: string) => Promise<boolean> }
      )?.validate;
      if (!validate) return null;
      expect(await validate("")).toBe(false);
      expect(await validate("wrong")).toBe(false);
      return null;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "unlock_security") throw new Error("bad");
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    await security.handleSecurityToggle(setStatus);

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      return status;
    });
    await security.handleSecurityToggle(setStatus);

    mockShowConfirm.mockResolvedValueOnce(true);
    mockShowPrompt.mockResolvedValueOnce(null);
    await security.handleSecurityToggle(setStatus);

    status = makeStatus({
      initialized: true,
      encryption_enabled: false,
      unlocked: true,
      biometric_available: false,
      biometric_enrolled: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      return status;
    });
    mockShowPrompt.mockResolvedValueOnce(null);
    await security.handleSecurityToggle(setStatus);

    mockShowPrompt.mockResolvedValueOnce(null);
    await security.handleSecurityChangePassword(setStatus);

    mockShowPrompt
      .mockResolvedValueOnce("old-pass")
      .mockResolvedValueOnce(null);
    await security.handleSecurityChangePassword(setStatus);

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "change_security_password") throw new Error("update failed");
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    mockShowPrompt
      .mockResolvedValueOnce("old-pass")
      .mockResolvedValueOnce("new-password")
      .mockResolvedValueOnce("new-password");
    await security.handleSecurityChangePassword(setStatus);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Error",
      expect.stringContaining("Failed to change password"),
    );

    document.getElementById("security-lock-timeout")?.remove();
    await expect(security.handleLockTimeoutChange()).resolves.toBeUndefined();
  });

  it("covers windows focus wait via immediate focus, focus event, and visibility event", async () => {
    vi.useFakeTimers();
    const security = await import("../security.ts");
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });

    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "windows";
      if (cmd === "unlock_biometric") {
        status = makeStatus({
          initialized: true,
          encryption_enabled: true,
          unlocked: true,
          biometric_available: true,
          biometric_enrolled: true,
        });
        return status;
      }
      return status;
    });
    const immediatePromise = security.ensureSecurityReady();
    await vi.advanceTimersByTimeAsync(900);
    await expect(immediatePromise).resolves.toBe(true);

    focused = false;
    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    const focusPromise = security.ensureSecurityReady();
    focused = true;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(900);
    await expect(focusPromise).resolves.toBe(true);

    focused = false;
    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    const visibilityPromise = security.ensureSecurityReady();
    focused = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(900);
    await expect(visibilityPromise).resolves.toBe(true);

    vi.useRealTimers();
  });

  it("covers security UI/handler paths when optional controls are missing", async () => {
    document.body.innerHTML = `
      <div id="security-status-text"></div>
      <button id="security-toggle">Enable Encryption</button>
      <button id="security-change-password" style="display:none"></button>
      <div id="security-warning" style="display:none"></div>
    `;
    let status = makeStatus({
      initialized: false,
      encryption_enabled: false,
      unlocked: false,
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      return status;
    });

    const security = await import("../security.ts");
    await security.refreshSecuritySettingsUI();

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: true,
      biometric_available: true,
      biometric_enrolled: true,
    });
    await security.refreshSecuritySettingsUI();

    status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });
    await security.refreshSecuritySettingsUI();

    status = makeStatus({
      initialized: true,
      encryption_enabled: false,
      unlocked: true,
    });
    await security.refreshSecuritySettingsUI();

    document.getElementById("security-toggle")?.remove();
    mockInvoke.mockRejectedValueOnce(new Error("status boom"));
    await security.handleSecurityToggle(vi.fn());

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") {
        return makeStatus({
          initialized: true,
          encryption_enabled: false,
          unlocked: true,
        });
      }
      if (cmd === "get_platform_info") return "linux";
      return status;
    });
    mockShowPrompt.mockResolvedValueOnce(null);
    await security.handleSecurityToggle(vi.fn());

    document.getElementById("biometric-toggle")?.remove();
    await security.handleBiometricToggle(vi.fn());
  });

  it("covers credential-removed and error-code biometric fallback messages", async () => {
    const security = await import("../security.ts");
    let status = makeStatus({
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
      biometric_available: true,
      biometric_enrolled: true,
    });

    let promptMessage = "";
    mockShowPrompt.mockImplementation(async (_title, message) => {
      promptMessage = String(message);
      return null;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      if (cmd === "unlock_biometric") {
        throw new Error("The credential was removed from the system");
      }
      return status;
    });
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(promptMessage).toContain("credential was removed");

    promptMessage = "";
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_security_status") return status;
      if (cmd === "get_platform_info") return "linux";
      if (cmd === "unlock_biometric") {
        throw new Error("Biometric transport error 0x8010000A");
      }
      return status;
    });
    await expect(security.ensureSecurityReady()).resolves.toBe(false);
    expect(promptMessage).toContain("0x8010000A");
  });
});
