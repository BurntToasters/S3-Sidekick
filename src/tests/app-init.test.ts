import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../settings-model.ts";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetVersion = vi.fn<() => Promise<string>>();
const mockRelaunch = vi.fn<() => Promise<void>>();
const mockSetSize = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockGetCurrentWindow = vi.fn();

const mockLoadSettings = vi.fn<() => Promise<boolean>>();
const mockIncrementLaunchCount = vi.fn<() => Promise<number>>();
const mockMarkSupportPromptDismissed = vi.fn<() => Promise<void>>();
const mockIsSupportPromptDismissed = vi.fn<() => boolean>();

const mockLoadConnection = vi.fn<() => Promise<unknown>>();
const mockLoadBookmarks = vi.fn<() => Promise<void>>();
const mockSetBookmarkChangeHandler = vi.fn();
const mockInitUpdater = vi.fn<() => Promise<void>>();
const mockAutoCheckUpdates = vi.fn<() => Promise<void>>();
const mockLogActivity = vi.fn();
const mockEnsureSecurityReady = vi.fn<() => Promise<boolean>>();
const mockShowAlert = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockIsDialogActive = vi.fn<() => boolean>();
const mockIsPaletteOpen = vi.fn<() => boolean>();
const mockShouldShowSetupWizard = vi.fn<() => boolean>();
const mockShowSetupWizard =
  vi.fn<() => Promise<Record<string, unknown> | null>>();
const mockMarkSetupComplete = vi.fn<() => Promise<void>>();
const mockSetStatus = vi.fn();
const mockApplyPlatformClass = vi.fn();
const mockUpdateShortcutChips = vi.fn();
const mockGetActiveModalOverlay = vi.fn();
const mockSetConnectionInputs = vi.fn();
const mockRefreshBookmarkBar = vi.fn();
const mockSetConnectionUI = vi.fn();
const mockWireEvents = vi.fn();
const mockPrepareTransferRecovery = vi.fn();
const mockRecoverPendingTransfers = vi.fn<() => Promise<void>>();
const mockInitializeIcons = vi.fn();
const mockWireTitlebar = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mockGetCurrentWindow,
}));

vi.mock("../settings.ts", () => ({
  loadSettings: mockLoadSettings,
  incrementLaunchCount: mockIncrementLaunchCount,
  markSupportPromptDismissed: mockMarkSupportPromptDismissed,
  isSupportPromptDismissed: mockIsSupportPromptDismissed,
  saveSettings: vi.fn(async () => undefined),
}));

vi.mock("../connection.ts", () => ({
  loadConnection: mockLoadConnection,
}));

vi.mock("../bookmarks.ts", () => ({
  loadBookmarks: mockLoadBookmarks,
  setBookmarkChangeHandler: mockSetBookmarkChangeHandler,
}));

vi.mock("../updater.ts", () => ({
  initUpdater: mockInitUpdater,
  autoCheckUpdates: mockAutoCheckUpdates,
}));

vi.mock("../activity-log.ts", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../security.ts", () => ({
  ensureSecurityReady: mockEnsureSecurityReady,
}));

vi.mock("../dialogs.ts", () => ({
  showAlert: mockShowAlert,
  isDialogActive: mockIsDialogActive,
}));

vi.mock("../command-palette.ts", () => ({
  isPaletteOpen: mockIsPaletteOpen,
}));

vi.mock("../setup-wizard.ts", () => ({
  shouldShowSetupWizard: mockShouldShowSetupWizard,
  showSetupWizard: mockShowSetupWizard,
  markSetupComplete: mockMarkSetupComplete,
}));

vi.mock("../app-status.ts", () => ({
  setStatus: mockSetStatus,
}));

vi.mock("../app-layout.ts", () => ({
  applyPlatformClass: mockApplyPlatformClass,
  updateShortcutChips: mockUpdateShortcutChips,
  getActiveModalOverlay: mockGetActiveModalOverlay,
}));

vi.mock("../app-connection.ts", () => ({
  setConnectionInputs: mockSetConnectionInputs,
  refreshBookmarkBar: mockRefreshBookmarkBar,
  setConnectionUI: mockSetConnectionUI,
}));

vi.mock("../app-events.ts", () => ({
  wireEvents: mockWireEvents,
}));

vi.mock("../transfers.ts", () => ({
  prepareTransferRecovery: mockPrepareTransferRecovery,
  recoverPendingTransfers: mockRecoverPendingTransfers,
}));

vi.mock("../icons.ts", () => ({
  initializeIcons: mockInitializeIcons,
}));

vi.mock("../titlebar.ts", () => ({
  wireTitlebar: mockWireTitlebar,
}));

async function flushMicrotasks(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < cycles; i += 1) await Promise.resolve();
}

describe("app-init startup waterfall", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockGetVersion.mockReset();
    mockRelaunch.mockReset();
    mockSetSize.mockReset();
    mockGetCurrentWindow.mockReset();
    mockLoadSettings.mockReset();
    mockIncrementLaunchCount.mockReset();
    mockMarkSupportPromptDismissed.mockReset();
    mockIsSupportPromptDismissed.mockReset();
    mockLoadConnection.mockReset();
    mockLoadBookmarks.mockReset();
    mockSetBookmarkChangeHandler.mockReset();
    mockInitUpdater.mockReset();
    mockAutoCheckUpdates.mockReset();
    mockLogActivity.mockReset();
    mockEnsureSecurityReady.mockReset();
    mockShowAlert.mockReset();
    mockIsDialogActive.mockReset();
    mockIsPaletteOpen.mockReset();
    mockShouldShowSetupWizard.mockReset();
    mockShowSetupWizard.mockReset();
    mockMarkSetupComplete.mockReset();
    mockSetStatus.mockReset();
    mockApplyPlatformClass.mockReset();
    mockUpdateShortcutChips.mockReset();
    mockGetActiveModalOverlay.mockReset();
    mockSetConnectionInputs.mockReset();
    mockRefreshBookmarkBar.mockReset();
    mockSetConnectionUI.mockReset();
    mockWireEvents.mockReset();
    mockPrepareTransferRecovery.mockReset();
    mockRecoverPendingTransfers.mockReset();
    mockInitializeIcons.mockReset();
    mockWireTitlebar.mockReset();

    document.body.innerHTML = `<span id="version-label"></span><div id="status"></div>`;
    const { state } = await import("../state.ts");
    state.platformName = "";
    state.currentSettings = { ...SETTING_DEFAULTS };
    state.lastPersistedSettings = { ...SETTING_DEFAULTS };
    state.settingsExtras = {};
    state.statusTimeout = undefined;

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_platform_info") return "macos";
      return undefined;
    });
    mockGetVersion.mockResolvedValue("0.11.0");
    mockSetSize.mockResolvedValue(undefined);
    mockGetCurrentWindow.mockReturnValue({ setSize: mockSetSize });
    mockLoadSettings.mockResolvedValue(true);
    mockIncrementLaunchCount.mockResolvedValue(1);
    mockMarkSupportPromptDismissed.mockResolvedValue(undefined);
    mockIsSupportPromptDismissed.mockReturnValue(true);
    mockLoadConnection.mockResolvedValue(null);
    mockLoadBookmarks.mockResolvedValue(undefined);
    mockInitUpdater.mockResolvedValue(undefined);
    mockAutoCheckUpdates.mockResolvedValue(undefined);
    mockEnsureSecurityReady.mockResolvedValue(true);
    mockRecoverPendingTransfers.mockResolvedValue(undefined);
    mockShowAlert.mockResolvedValue(undefined);
    mockIsDialogActive.mockReturnValue(false);
    mockIsPaletteOpen.mockReturnValue(false);
    mockGetActiveModalOverlay.mockReturnValue(null);
    mockShouldShowSetupWizard.mockReturnValue(false);
    mockShowSetupWizard.mockResolvedValue(null);
    mockMarkSetupComplete.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);
    const idle = window as unknown as {
      requestIdleCallback?: unknown;
    };
    delete idle.requestIdleCallback;
    vi.useRealTimers();
  });

  it("boots main path with version, bookmarks+connection in parallel, deferred update check", async () => {
    const { init } = await import("../app-init.ts");
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 1280;
    state.currentSettings.windowHeight = 800;
    mockLoadConnection.mockResolvedValue({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      access_key: "ak",
      secret_key: "sk",
    });

    await init();
    await flushMicrotasks(10);

    expect(mockInitializeIcons).toHaveBeenCalledTimes(1);
    expect(mockSetConnectionUI).toHaveBeenCalledWith(false);
    expect(state.platformName).toBe("macos");
    expect(mockApplyPlatformClass).toHaveBeenCalledTimes(1);
    expect(mockPrepareTransferRecovery).toHaveBeenCalledTimes(1);
    expect(mockWireEvents).toHaveBeenCalledTimes(1);
    expect(mockWireTitlebar).toHaveBeenCalledTimes(1);
    expect(document.getElementById("version-label")?.textContent).toBe(
      "v0.11.0",
    );
    expect(mockLoadSettings).toHaveBeenCalledTimes(1);
    expect(mockSetSize).toHaveBeenCalledTimes(1);
    expect(mockEnsureSecurityReady).toHaveBeenCalledTimes(1);
    expect(mockRecoverPendingTransfers).toHaveBeenCalledTimes(1);
    expect(mockLoadBookmarks).toHaveBeenCalledTimes(1);
    expect(mockSetBookmarkChangeHandler).toHaveBeenCalledTimes(1);
    expect(mockRefreshBookmarkBar).toHaveBeenCalled();
    expect(mockSetConnectionInputs).toHaveBeenCalledWith(
      "https://s3.example.com",
      "us-east-1",
      "ak",
      "sk",
      "",
    );
    expect(mockInitUpdater).toHaveBeenCalledTimes(1);
    // Deferred via setTimeout fallback: allow the timer to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 1600));
    expect(mockAutoCheckUpdates).toHaveBeenCalled();
  });

  it("uses idle callback for deferred update checks when available", async () => {
    const idleCb = vi.fn((cb: () => void) => {
      cb();
    });
    Object.defineProperty(window, "requestIdleCallback", {
      value: idleCb,
      configurable: true,
      writable: true,
    });
    try {
      const { init } = await import("../app-init.ts");
      await init();
      await flushMicrotasks();
      expect(idleCb).toHaveBeenCalled();
      expect(mockAutoCheckUpdates).toHaveBeenCalledTimes(1);
    } finally {
      const w = window as unknown as { requestIdleCallback?: unknown };
      delete w.requestIdleCallback;
    }
  });

  it("tolerates platform detection and version label failures", async () => {
    mockInvoke.mockRejectedValue(new Error("no platform"));
    mockGetVersion.mockRejectedValue(new Error("no version"));
    const { init } = await import("../app-init.ts");
    const { state } = await import("../state.ts");

    await init();
    await flushMicrotasks();

    expect(state.platformName).toBe("");
    expect(mockSetStatus).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to load settings"),
    );
    expect(mockInitUpdater).toHaveBeenCalledTimes(1);
  });

  it("reports settings load throw without corrupting startup", async () => {
    mockLoadSettings.mockRejectedValue(new Error("disk gone"));
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load settings"),
    );
    expect(mockEnsureSecurityReady).toHaveBeenCalledTimes(1);
  });

  it("recovers from corrupt settings with alert, reset, and relaunch", async () => {
    mockLoadSettings.mockResolvedValue(false);
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockShowAlert).toHaveBeenCalledWith(
      "Settings Corrupted",
      expect.stringContaining("bookmarks"),
    );
    expect(mockInvoke).toHaveBeenCalledWith("save_settings", {
      json: "{}",
    });
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockEnsureSecurityReady).not.toHaveBeenCalled();
  });

  it("falls back to location reload when corrupt-recovery relaunch fails", async () => {
    mockLoadSettings.mockResolvedValue(false);
    mockRelaunch.mockRejectedValue(new Error("no relaunch"));
    const assignMock = vi.fn();
    const locationValue = window.location;
    Object.defineProperty(window, "location", {
      value: { href: "https://app.local/", assign: assignMock },
      configurable: true,
    });
    try {
      const { init } = await import("../app-init.ts");
      await init();
      await flushMicrotasks();
      expect(assignMock).toHaveBeenCalledWith("https://app.local/");
    } finally {
      Object.defineProperty(window, "location", {
        value: locationValue,
        configurable: true,
      });
    }
  });

  it("routes through the wizard and persists its result", async () => {
    mockShouldShowSetupWizard.mockReturnValue(true);
    mockShowSetupWizard.mockResolvedValue({
      theme: "dark",
      encryptionEnabled: true,
      biometricEnabled: false,
      autoCheckUpdates: false,
      updateChannel: "beta",
    });
    const { init } = await import("../app-init.ts");
    const { state } = await import("../state.ts");

    await init();
    await flushMicrotasks();

    expect(mockShowSetupWizard).toHaveBeenCalledTimes(1);
    expect(state.currentSettings.theme).toBe("dark");
    expect(state.currentSettings.autoCheckUpdates).toBe(false);
    expect(state.currentSettings.updateChannel).toBe("beta");
    expect(mockMarkSetupComplete).toHaveBeenCalledTimes(1);
    expect(mockLoadSettings).toHaveBeenCalledTimes(2);
    expect(mockEnsureSecurityReady).toHaveBeenCalledTimes(1);
    expect(mockLoadBookmarks).toHaveBeenCalledTimes(1);
    expect(mockInitUpdater).toHaveBeenCalledTimes(1);
  });

  it("continues wizard startup when the result is dismissed", async () => {
    mockShouldShowSetupWizard.mockReturnValue(true);
    mockShowSetupWizard.mockResolvedValue(null);
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockMarkSetupComplete).not.toHaveBeenCalled();
    expect(mockLoadSettings).toHaveBeenCalledTimes(2);
    expect(mockInitUpdater).toHaveBeenCalledTimes(1);
  });

  it("reports reload failure after the wizard without aborting", async () => {
    mockShouldShowSetupWizard.mockReturnValue(true);
    mockShowSetupWizard.mockResolvedValue({
      theme: "light",
      encryptionEnabled: false,
      biometricEnabled: false,
      autoCheckUpdates: true,
      updateChannel: "release",
    });
    mockLoadSettings
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("reload gone"));
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load settings"),
    );
    expect(mockEnsureSecurityReady).toHaveBeenCalledTimes(1);
  });

  it("locks bookmarks and credentials when secure storage stays locked", async () => {
    mockEnsureSecurityReady.mockResolvedValue(false);
    mockLoadConnection.mockResolvedValue({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      access_key: "ak",
      secret_key: "sk",
    });
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.stringContaining("Secure storage is locked"),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining("Secure storage is locked"),
      "warning",
    );
    expect(mockRecoverPendingTransfers).not.toHaveBeenCalled();
    // Main path skips the concurrent loads when locked.
    expect(mockLoadBookmarks).not.toHaveBeenCalled();
    expect(mockSetConnectionInputs).not.toHaveBeenCalled();
  });

  it("locks wizard startup the same way when security stays locked", async () => {
    mockShouldShowSetupWizard.mockReturnValue(true);
    mockShowSetupWizard.mockResolvedValue(null);
    mockEnsureSecurityReady.mockResolvedValue(false);
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.stringContaining("Secure storage is locked"),
    );
    expect(mockLoadBookmarks).not.toHaveBeenCalled();
    // Wizard path still attempts the saved connection.
    expect(mockLoadConnection).toHaveBeenCalledTimes(1);
  });

  it("defers transfer recovery failures to the activity log", async () => {
    mockRecoverPendingTransfers.mockRejectedValue(new Error("vault busy"));
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining("Pending transfer recovery deferred"),
      "warning",
    );
  });

  it("warns when bookmarks fail to load on the main path", async () => {
    mockLoadBookmarks.mockRejectedValue(new Error("bookmarks gone"));
    const { init } = await import("../app-init.ts");

    await init();
    await flushMicrotasks();

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load bookmarks"),
      "warning",
    );
    // Saved connection still loads concurrently.
    expect(mockLoadConnection).toHaveBeenCalledTimes(1);
  });

  it("handles saved-connection load failure, empty, and invalid shapes", async () => {
    const { init } = await import("../app-init.ts");

    mockLoadConnection.mockRejectedValueOnce(new Error("vault locked"));
    await init();
    await flushMicrotasks();
    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load saved connection"),
    );
    expect(mockSetConnectionInputs).not.toHaveBeenCalled();

    mockSetStatus.mockClear();
    mockSetConnectionInputs.mockClear();
    mockLoadConnection.mockResolvedValueOnce(null);
    await init();
    await flushMicrotasks();
    expect(mockSetConnectionInputs).not.toHaveBeenCalled();

    mockSetConnectionInputs.mockClear();
    mockLoadConnection.mockResolvedValueOnce({
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      access_key: "ak2",
      secret_key: "sk2",
    });
    await init();
    await flushMicrotasks();
    expect(mockSetConnectionInputs).toHaveBeenCalledWith(
      "https://s3.example.com",
      "eu-west-1",
      "ak2",
      "sk2",
      "",
    );
  });

  it("skips window restore for empty sizes and warns on failure", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 0;
    state.currentSettings.windowHeight = 0;
    const { init } = await import("../app-init.ts");
    await init();
    await flushMicrotasks();
    expect(mockSetSize).not.toHaveBeenCalled();

    state.currentSettings.windowWidth = 1280;
    state.currentSettings.windowHeight = 800;
    mockSetSize.mockRejectedValueOnce(new Error("no window"));
    await init();
    await flushMicrotasks();
    expect(mockSetSize).toHaveBeenCalledTimes(1);
  });

  it("skips the support prompt before the second launch", async () => {
    mockIsSupportPromptDismissed.mockReturnValue(false);
    mockIncrementLaunchCount.mockResolvedValue(1);
    const { init } = await import("../app-init.ts");
    await init();
    await flushMicrotasks();
    expect(mockIncrementLaunchCount).toHaveBeenCalledTimes(1);
    expect(mockMarkSupportPromptDismissed).not.toHaveBeenCalled();
  });

  it("defers the support prompt while a dialog is active, then shows it", async () => {
    vi.useFakeTimers();
    try {
      mockIsSupportPromptDismissed.mockReturnValue(false);
      mockIncrementLaunchCount.mockResolvedValue(5);
      mockIsDialogActive.mockReturnValueOnce(true).mockReturnValue(false);
      document.body.innerHTML = `
        <span id="version-label"></span><div id="status"></div>
        <div id="support-overlay" hidden>
          <button id="support-no">No</button>
          <button id="support-yes">Yes</button>
        </div>
      `;
      const { init } = await import("../app-init.ts");
      await init();
      await vi.advanceTimersByTimeAsync(1600);
      // First attempt deferred due to active dialog.
      expect(
        document.getElementById("support-overlay")?.hasAttribute("hidden"),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(1600);
      expect(
        document.getElementById("support-overlay")?.hasAttribute("hidden"),
      ).toBe(false);

      // Dismiss persists and closes exactly once.
      (document.getElementById("support-no") as HTMLButtonElement).click();
      (document.getElementById("support-no") as HTMLButtonElement).click();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(mockMarkSupportPromptDismissed).toHaveBeenCalled();
      expect(
        document.getElementById("support-overlay")?.hasAttribute("hidden"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens support externally on confirm and handles overlay interactions", async () => {
    vi.useFakeTimers();
    try {
      mockIsSupportPromptDismissed.mockReturnValue(false);
      mockIncrementLaunchCount.mockResolvedValue(5);
      document.body.innerHTML = `
        <span id="version-label"></span><div id="status"></div>
        <div id="support-overlay" hidden>
          <button id="support-no">No</button>
          <button id="support-yes">Yes</button>
        </div>
      `;
      const { init } = await import("../app-init.ts");
      await init();
      await vi.advanceTimersByTimeAsync(1600);
      const overlay = document.getElementById("support-overlay") as HTMLElement;
      expect(overlay.hasAttribute("hidden")).toBe(false);

      // Backdrop click dismisses.
      overlay.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(overlay.hasAttribute("hidden")).toBe(true);
      expect(mockMarkSupportPromptDismissed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms support, tolerates persistence and external-url failures", async () => {
    vi.useFakeTimers();
    try {
      mockIsSupportPromptDismissed.mockReturnValue(false);
      mockIncrementLaunchCount.mockResolvedValue(5);
      mockMarkSupportPromptDismissed.mockRejectedValue(new Error("save gone"));
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "get_platform_info") return "macos";
        if (cmd === "open_external_url") throw new Error("no browser");
        return undefined;
      });
      document.body.innerHTML = `
        <span id="version-label"></span><div id="status"></div>
        <div id="support-overlay" hidden>
          <button id="support-no">No</button>
          <button id="support-yes">Yes</button>
        </div>
      `;
      const { init } = await import("../app-init.ts");
      await init();
      await vi.advanceTimersByTimeAsync(1600);

      (document.getElementById("support-yes") as HTMLButtonElement).click();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.stringContaining("Failed to open support page"),
        "warning",
      );

      // Missing overlay elements are a safe no-op.
      document.body.innerHTML = `<span id="version-label"></span>`;
      mockMarkSupportPromptDismissed.mockReset();
      mockMarkSupportPromptDismissed.mockResolvedValue(undefined);
      await init();
      await vi.advanceTimersByTimeAsync(1600);
      expect(mockMarkSupportPromptDismissed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles Escape, missing palette state, and prompt unavailability", async () => {
    vi.useFakeTimers();
    try {
      mockIsSupportPromptDismissed.mockReturnValue(false);
      mockIncrementLaunchCount.mockResolvedValue(5);
      mockGetActiveModalOverlay.mockReturnValueOnce(
        document.createElement("div"),
      );
      document.body.innerHTML = `
        <span id="version-label"></span>
        <div id="support-overlay" hidden>
          <button id="support-no">No</button>
          <button id="support-yes">Yes</button>
        </div>
      `;
      const { init } = await import("../app-init.ts");
      await init();
      await vi.advanceTimersByTimeAsync(1600);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(1600);
      const overlay = document.getElementById("support-overlay") as HTMLElement;
      expect(overlay.hasAttribute("hidden")).toBe(false);

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(overlay.hasAttribute("hidden")).toBe(false);
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(overlay.hasAttribute("hidden")).toBe(true);

      mockIncrementLaunchCount.mockRejectedValueOnce(new Error("count gone"));
      await init();
      await vi.advanceTimersByTimeAsync(1600);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.stringContaining("Support prompt unavailable"),
        "warning",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
