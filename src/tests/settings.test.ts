import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../settings-model.ts";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetVersion = vi.fn<() => Promise<string>>();
const mockRelaunch = vi.fn<() => Promise<void>>();
const mockLoadBookmarks = vi.fn<() => Promise<void>>();
const mockRenderBookmarkList = vi.fn();
const mockRemoveBookmark = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockGetBookmarks = vi.fn();
const mockExportBookmarksJson = vi.fn();
const mockImportBookmarksJson = vi.fn();
const mockIsUpdaterEnabled = vi.fn();
const mockSetUpdateChannel = vi.fn();
const mockRefreshSecuritySettingsUI = vi.fn<() => Promise<void>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockShowAlert = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

vi.mock("../bookmarks.ts", () => ({
  loadBookmarks: mockLoadBookmarks,
  renderBookmarkList: mockRenderBookmarkList,
  removeBookmark: mockRemoveBookmark,
  getBookmarks: mockGetBookmarks,
  exportBookmarksJson: mockExportBookmarksJson,
  importBookmarksJson: mockImportBookmarksJson,
  MAX_IMPORT_BYTES: 1_048_576,
}));

vi.mock("../updater.ts", () => ({
  isUpdaterEnabled: mockIsUpdaterEnabled,
  setUpdateChannel: mockSetUpdateChannel,
}));

vi.mock("../security.ts", () => ({
  refreshSecuritySettingsUI: mockRefreshSecuritySettingsUI,
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: mockShowConfirm,
  showAlert: mockShowAlert,
}));

describe("settings module", () => {
  async function flushMicrotasks(cycles = 3): Promise<void> {
    for (let i = 0; i < cycles; i += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockGetVersion.mockReset();
    mockRelaunch.mockReset();
    mockLoadBookmarks.mockReset();
    mockRenderBookmarkList.mockReset();
    mockRemoveBookmark.mockReset();
    mockGetBookmarks.mockReset();
    mockExportBookmarksJson.mockReset();
    mockImportBookmarksJson.mockReset();
    mockIsUpdaterEnabled.mockReset();
    mockSetUpdateChannel.mockReset();
    mockRefreshSecuritySettingsUI.mockReset();
    mockShowConfirm.mockReset();
    mockShowAlert.mockReset();
    mockGetVersion.mockResolvedValue("0.6.0");
    mockIsUpdaterEnabled.mockReturnValue(true);
    mockLoadBookmarks.mockResolvedValue(undefined);
    mockRefreshSecuritySettingsUI.mockResolvedValue(undefined);
    mockShowConfirm.mockResolvedValue(false);
    mockShowAlert.mockResolvedValue(undefined);
    mockGetBookmarks.mockReturnValue([]);
    mockExportBookmarksJson.mockReturnValue("[]");
    mockImportBookmarksJson.mockResolvedValue({ imported: 0, skipped: 0 });

    const { state } = await import("../state.ts");
    state.platformName = "windows";
    state.currentSettings = {
      ...SETTING_DEFAULTS,
    };
    state.lastPersistedSettings = { ...state.currentSettings };
    state.settingsExtras = {};
    document.documentElement.removeAttribute("data-theme");
  });

  it("loads and saves settings through the backend", async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        theme: "dark",
        autoCheckUpdates: false,
        updateChannel: "beta",
        presignedUrlExpiration: 120,
        maxConcurrentTransfers: 4,
        _launchCount: 10,
      }),
    );
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");

    await settings.loadSettings();

    expect(state.currentSettings.theme).toBe("dark");
    expect(state.currentSettings.updateChannel).toBe("beta");
    expect(state.settingsExtras._launchCount).toBe(10);
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("beta");

    mockInvoke.mockResolvedValueOnce(undefined);
    state.currentSettings.maxConcurrentTransfers = 5;
    await settings.saveSettings();
    expect(mockInvoke).toHaveBeenLastCalledWith("save_settings", {
      json: expect.stringContaining('"maxConcurrentTransfers": 5'),
    });
  });

  it("serializes overlapping saves and persists each immutable snapshot", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockInvoke
      .mockImplementationOnce(async () => firstGate)
      .mockResolvedValueOnce(undefined);
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");

    state.currentSettings.theme = "light";
    const firstSave = settings.saveSettings();
    state.currentSettings.theme = "dark";
    const secondSave = settings.saveSettings();
    await flushMicrotasks();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]?.[1]).toEqual({
      json: expect.stringContaining('"theme": "light"'),
    });
    releaseFirst?.();
    await firstSave;
    await flushMicrotasks();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1]?.[1]).toEqual({
      json: expect.stringContaining('"theme": "dark"'),
    });
    await secondSave;
    expect(state.lastPersistedSettings.theme).toBe("dark");
  });

  it("continues the settings save queue after a failed snapshot", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");

    state.currentSettings.theme = "light";
    const failedSave = settings.saveSettings();
    state.currentSettings.theme = "dark";
    const recoverySave = settings.saveSettings();

    await expect(failedSave).rejects.toThrow("disk full");
    await expect(recoverySave).resolves.toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(state.lastPersistedSettings.theme).toBe("dark");
  });

  it("applies and switches theme correctly", async () => {
    const settings = await import("../settings.ts");
    settings.applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    settings.applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("switches settings tabs and reads modal values", async () => {
    document.body.innerHTML = `
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
        <button class="settings-tab settings-tab--active" data-settings-tab="bookmarks"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <div class="settings-panel" data-settings-panel="bookmarks"></div>
      <select id="setting-theme"><option value="system">system</option><option value="dark" selected>dark</option></select>
      <input id="setting-updates" type="checkbox" />
      <select id="setting-update-channel"><option value="release">release</option><option value="beta" selected>beta</option></select>
      <select id="setting-presigned-expiration"><option value="120" selected>120</option></select>
      <select id="setting-max-concurrent"><option value="6" selected>6</option></select>
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");

    settings.switchSettingsTab("general");
    const tabs = document.querySelectorAll<HTMLElement>(".settings-tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(
      (document.querySelector('[data-settings-panel="general"]') as HTMLElement)
        .hidden,
    ).toBe(false);
    expect(
      (
        document.querySelector(
          '[data-settings-panel="bookmarks"]',
        ) as HTMLElement
      ).hidden,
    ).toBe(true);

    settings.readSettingsModal();
    expect(state.currentSettings.theme).toBe("dark");
    expect(state.currentSettings.autoCheckUpdates).toBe(false);
    expect(state.currentSettings.updateChannel).toBe("beta");
    expect(state.currentSettings.presignedUrlExpiration).toBe(120);
    expect(state.currentSettings.maxConcurrentTransfers).toBe(6);
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("beta");
  });

  it("normalizes invalid modal values and defaults update channel", async () => {
    document.body.innerHTML = `
      <select id="setting-theme"><option value="system">system</option><option value="light" selected>light</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="invalid" selected>invalid</option></select>
      <select id="setting-presigned-expiration"><option value="30" selected>30</option></select>
      <select id="setting-max-concurrent"><option value="99" selected>99</option></select>
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      autoCheckUpdates: false,
      updateChannel: "beta",
    };

    settings.readSettingsModal();

    expect(state.currentSettings.theme).toBe("light");
    expect(state.currentSettings.autoCheckUpdates).toBe(true);
    expect(state.currentSettings.updateChannel).toBe("release");
    expect(state.currentSettings.presignedUrlExpiration).toBe(3600);
    expect(state.currentSettings.maxConcurrentTransfers).toBe(3);
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("release");
  });

  it("open/close modal handles save success and save failure", async () => {
    document.body.innerHTML = `
      <div id="status"></div>
      <div id="settings-overlay" class="modal-overlay"></div>
      <button id="settings-save">Save</button>
      <select id="setting-theme"><option value="light" selected>light</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <div id="bookmark-list"></div>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;

    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    const overlay = document.getElementById(
      "settings-overlay",
    ) as HTMLDivElement;
    overlay.classList.add("active");

    let resolveSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    mockInvoke.mockImplementationOnce(async () => saveGate);
    settings.openSettingsModal();
    expect(overlay.classList.contains("active")).toBe(true);
    const firstClose = settings.closeSettingsModal(true);
    const duplicateClose = settings.closeSettingsModal(true);
    expect(duplicateClose).toBe(firstClose);
    expect(
      (document.getElementById("settings-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    await flushMicrotasks();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    resolveSave?.();
    await firstClose;
    expect(overlay.classList.contains("active")).toBe(false);
    expect(
      (document.getElementById("settings-save") as HTMLButtonElement).disabled,
    ).toBe(false);

    overlay.classList.add("active");
    state.lastPersistedSettings = {
      ...SETTING_DEFAULTS,
      theme: "light",
    };
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "beta",
      presignedUrlExpiration: 120,
      maxConcurrentTransfers: 6,
    };
    mockInvoke.mockRejectedValueOnce(new Error("save failed"));
    await settings.closeSettingsModal(true);
    expect(state.currentSettings).toEqual(state.lastPersistedSettings);
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toContain("Failed to save settings");
    expect(overlay.classList.contains("active")).toBe(true);
  });

  it("isolates a failed modal draft from a queued window-size save", async () => {
    document.body.innerHTML = `
      <div id="status"></div>
      <div id="settings-overlay" class="modal-overlay active"></div>
      <button id="settings-save">Save</button>
      <select id="setting-theme">
        <option value="light">light</option>
        <option value="dark" selected>dark</option>
      </select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
    `;
    let rejectModalSave: ((error: Error) => void) | undefined;
    const modalSaveGate = new Promise<void>((_resolve, reject) => {
      rejectModalSave = reject;
    });
    mockInvoke
      .mockImplementationOnce(async () => modalSaveGate)
      .mockResolvedValueOnce(undefined);
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.lastPersistedSettings = {
      ...SETTING_DEFAULTS,
      theme: "light",
      windowWidth: 800,
      windowHeight: 600,
    };
    state.currentSettings = { ...state.lastPersistedSettings };

    const modalSave = settings.closeSettingsModal(true);
    state.currentSettings.windowWidth = 1440;
    state.currentSettings.windowHeight = 900;
    const resizeSave = settings.saveSettings();
    await flushMicrotasks();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    rejectModalSave?.(new Error("modal save failed"));
    await modalSave;
    await resizeSave;

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[1]?.[1]).toEqual({
      json: expect.stringContaining('"theme": "light"'),
    });
    expect(mockInvoke.mock.calls[1]?.[1]).toEqual({
      json: expect.stringContaining('"windowWidth": 1440'),
    });
    expect(state.currentSettings.theme).toBe("light");
    expect(state.currentSettings.windowWidth).toBe(1440);
    expect(state.lastPersistedSettings.theme).toBe("light");
    expect(state.lastPersistedSettings.windowWidth).toBe(1440);
    expect(
      document.getElementById("settings-overlay")?.classList.contains("active"),
    ).toBe(true);
  });

  it("tracks support prompt flags in settings extras", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    mockInvoke.mockResolvedValue(undefined);

    expect(settings.isSupportPromptDismissed()).toBe(false);
    const count1 = await settings.incrementLaunchCount();
    const count2 = await settings.incrementLaunchCount();
    expect(count1).toBe(1);
    expect(count2).toBe(2);
    expect(state.settingsExtras.launchCount).toBe(2);

    await settings.markSupportPromptDismissed();
    expect(settings.isSupportPromptDismissed()).toBe(true);
    expect(state.settingsExtras.supportPromptDismissed).toBe(true);
  });

  it("populates updater unsupported state and unknown platform label", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    mockIsUpdaterEnabled.mockReturnValue(false);
    state.platformName = "";

    settings.populateSettingsModal();
    await flushMicrotasks();

    expect(
      (document.getElementById("updater-section") as HTMLDivElement).style
        .display,
    ).toBe("none");
    expect(
      (document.getElementById("updater-unsupported") as HTMLDivElement).style
        .display,
    ).toBe("");
    expect(
      (document.getElementById("settings-platform") as HTMLSpanElement)
        .textContent,
    ).toBe("Unknown");
  });

  it("resets settings with relaunch success and location fallback", async () => {
    const settings = await import("../settings.ts");

    mockShowConfirm.mockResolvedValueOnce(false);
    await settings.resetSettings();
    expect(mockInvoke).not.toHaveBeenCalled();

    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValueOnce(undefined);
    await settings.resetSettings();
    expect(mockInvoke).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        json: expect.stringContaining('"theme": "system"'),
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("clear_saved_connection");
    expect(mockRelaunch).toHaveBeenCalledTimes(1);

    const assignMock = vi.fn();
    const locationValue = window.location;
    Object.defineProperty(window, "location", {
      value: { href: "https://app.local/", assign: assignMock },
      configurable: true,
    });
    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockRejectedValueOnce(new Error("relaunch failed"));
    await settings.resetSettings();
    expect(assignMock).toHaveBeenCalledWith("https://app.local/");
    Object.defineProperty(window, "location", {
      value: locationValue,
      configurable: true,
    });
  });

  it("factory reset gets final consent before one backend transaction", async () => {
    const settings = await import("../settings.ts");
    localStorage.setItem("s3-sidekick.transfer-manifest.v1", "plaintext");

    mockShowConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await settings.resetSettings();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(localStorage.getItem("s3-sidekick.transfer-manifest.v1")).toBe(
      "plaintext",
    );

    mockShowConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);
    await settings.resetSettings();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("factory_reset", {
      settingsJson: expect.stringContaining('"theme": "system"'),
    });
    expect(localStorage.length).toBe(0);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("reverts in-memory settings when close modal is cancelled", async () => {
    document.body.innerHTML = `<div id="settings-overlay" class="modal-overlay active"></div>`;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.lastPersistedSettings = {
      ...SETTING_DEFAULTS,
      theme: "dark",
      autoCheckUpdates: false,
      maxConcurrentTransfers: 5,
    };
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "light",
      updateChannel: "beta",
      presignedUrlExpiration: 120,
      maxConcurrentTransfers: 2,
    };

    await settings.closeSettingsModal(false);

    expect(state.currentSettings).toEqual(state.lastPersistedSettings);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(
      (
        document.getElementById("settings-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
  });

  it("skips bookmark rendering when bookmark list element is missing", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    settings.openSettingsModal();
    await flushMicrotasks();
    expect(mockLoadBookmarks).toHaveBeenCalledTimes(1);
    expect(mockRenderBookmarkList).not.toHaveBeenCalled();
  });

  it("handles bookmark deletion cancel and confirm flows", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay active"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    mockGetBookmarks.mockReturnValue([{ name: "Saved One" }]);

    settings.openSettingsModal();
    await flushMicrotasks();

    expect(mockRenderBookmarkList).toHaveBeenCalledTimes(1);
    const onDelete = mockRenderBookmarkList.mock.calls[0][2] as (
      index: number,
    ) => Promise<void>;

    mockShowConfirm.mockResolvedValueOnce(false);
    await onDelete(0);
    expect(mockRemoveBookmark).not.toHaveBeenCalled();

    mockGetBookmarks.mockReturnValue([{}]);
    mockShowConfirm.mockResolvedValueOnce(false);
    await onDelete(0);
    expect(mockShowConfirm).toHaveBeenLastCalledWith(
      "Delete Bookmark",
      'Delete bookmark "this bookmark"?',
      expect.objectContaining({ okLabel: "Delete", okDanger: true }),
    );

    mockShowConfirm.mockResolvedValueOnce(true);
    await onDelete(0);
    await flushMicrotasks();
    expect(mockRemoveBookmark).toHaveBeenCalledWith(0);
    expect(mockRenderBookmarkList).toHaveBeenCalledTimes(2);
  });

  it("alerts when bookmark deletion fails", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay active"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    mockGetBookmarks.mockReturnValue([{ name: "Saved One" }]);
    mockShowConfirm.mockResolvedValue(true);
    mockRemoveBookmark.mockRejectedValueOnce(new Error("disk full"));

    settings.openSettingsModal();
    await flushMicrotasks();
    const onDelete = mockRenderBookmarkList.mock.calls[0][2] as (
      index: number,
    ) => Promise<void>;
    await onDelete(0);
    await flushMicrotasks();

    expect(mockShowAlert).toHaveBeenCalledWith("Delete Failed", "disk full");
    expect(mockRenderBookmarkList).toHaveBeenCalledTimes(1);
  });

  it("invokes bookmark select handler and closes overlay on selection", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay active"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    const onSelect = vi.fn();
    settings.setBookmarkSelectHandler(onSelect);

    settings.openSettingsModal();
    await flushMicrotasks();

    expect(mockRenderBookmarkList).toHaveBeenCalledTimes(1);
    const selectBookmark = mockRenderBookmarkList.mock.calls[0][1] as (
      bookmark: Record<string, string>,
    ) => void;
    selectBookmark({
      name: "Saved",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      access_key: "AKIA...",
      secret_key: "secret",
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(
      (
        document.getElementById("settings-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
  });

  it("wires bookmarks import/export controls in settings modal", async () => {
    document.body.innerHTML = `
      <div id="status"></div>
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div>
      <button id="security-toggle"></button>
      <button id="security-change-password"></button>
      <div id="security-warning"></div>
      <div id="security-lock-settings"></div>
      <div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div>
      <button id="biometric-toggle"></button>
      <span id="settings-version"></span>
      <span id="settings-platform"></span>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;

    const settings = await import("../settings.ts");
    mockExportBookmarksJson.mockReturnValue('[{"name":"x"}]');
    // Two-step export: confirm export, then secrets choice.
    mockShowConfirm.mockResolvedValue(true);
    mockImportBookmarksJson
      .mockResolvedValueOnce({ imported: 0, skipped: 0, error: "bad file" })
      .mockResolvedValueOnce({ imported: 2, skipped: 1 })
      .mockResolvedValueOnce({ imported: 1, skipped: 0 });

    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      onload:
        ((this: FileReader, ev: ProgressEvent<FileReader>) => void) | null =
        null;

      readAsText(): void {
        this.result = '[{"name":"imported"}]';
        if (this.onload) {
          this.onload.call(
            this as unknown as FileReader,
            {} as ProgressEvent<FileReader>,
          );
        }
      }
    }
    vi.stubGlobal("FileReader", MockFileReader as unknown as typeof FileReader);

    settings.openSettingsModal();
    await flushMicrotasks();

    (
      document.getElementById("bookmarks-export-btn") as HTMLButtonElement
    ).click();
    await flushMicrotasks(2);
    expect(mockExportBookmarksJson).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    const importInput = document.getElementById(
      "bookmarks-import-input",
    ) as HTMLInputElement;
    const importClick = vi
      .spyOn(importInput, "click")
      .mockImplementation(() => undefined);
    (
      document.getElementById("bookmarks-import-btn") as HTMLButtonElement
    ).click();
    expect(importClick).toHaveBeenCalledTimes(1);

    importInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks(2);
    expect(mockImportBookmarksJson).not.toHaveBeenCalled();

    Object.defineProperty(importInput, "files", {
      value: [
        new File(['{"x":1}'], "bookmarks.json", { type: "application/json" }),
      ],
      configurable: true,
    });
    importInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks(5);
    expect(mockShowAlert).toHaveBeenCalledWith("Import Failed", "bad file");

    Object.defineProperty(importInput, "files", {
      value: [
        new File(['{"x":2}'], "bookmarks2.json", { type: "application/json" }),
      ],
      configurable: true,
    });
    importInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks(5);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Import Complete",
      expect.stringContaining("Imported 2 bookmark(s)"),
    );
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Import Complete",
      expect.stringContaining("skipped 1 duplicate(s)"),
    );

    Object.defineProperty(importInput, "files", {
      value: [
        new File(['{"x":3}'], "bookmarks3.json", { type: "application/json" }),
      ],
      configurable: true,
    });
    importInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks(5);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Import Complete",
      "Imported 1 bookmark(s).",
    );

    const oversized = new File(["tiny"], "huge.json", {
      type: "application/json",
    });
    Object.defineProperty(oversized, "size", { value: 1_048_577 });
    Object.defineProperty(importInput, "files", {
      value: [oversized],
      configurable: true,
    });
    const importCalls = mockImportBookmarksJson.mock.calls.length;
    importInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks(5);
    expect(mockShowAlert).toHaveBeenCalledWith(
      "Import Failed",
      "Bookmark import is too large",
    );
    expect(mockImportBookmarksJson.mock.calls.length).toBe(importCalls);
  });

  it("handles missing settings controls and overlay elements safely", async () => {
    document.body.innerHTML = "";
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "dark",
      updateChannel: "beta",
      maxConcurrentTransfers: 4,
    };

    settings.populateSettingsModal();
    settings.readSettingsModal();
    settings.openSettingsModal();
    await settings.closeSettingsModal(false);

    expect(state.currentSettings).toEqual(state.lastPersistedSettings);
  });

  it("handles save failure when status element is missing", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay active"></div>
      <select id="setting-theme"><option value="light" selected>light</option></select>
      <input id="setting-updates" type="checkbox" />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.lastPersistedSettings = {
      ...SETTING_DEFAULTS,
      autoCheckUpdates: false,
      presignedUrlExpiration: 120,
      maxConcurrentTransfers: 2,
    };
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "light",
      updateChannel: "beta",
      maxConcurrentTransfers: 5,
    };

    mockInvoke.mockRejectedValueOnce(new Error("save failed"));
    await settings.closeSettingsModal(true);

    expect(state.currentSettings).toEqual(state.lastPersistedSettings);
    expect(
      (
        document.getElementById("settings-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(true);
  });

  it("handles bookmark select callback when no select handler or overlay exists", async () => {
    document.body.innerHTML = `
      <ul id="bookmark-list"></ul>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
      <div id="updater-section"></div>
      <div id="updater-unsupported"></div>
      <div class="settings-tabs">
        <button class="settings-tab" data-settings-tab="general"></button>
      </div>
      <div class="settings-panel" data-settings-panel="general"></div>
    `;
    const settings = await import("../settings.ts");

    settings.populateSettingsModal();
    await flushMicrotasks();
    expect(mockRenderBookmarkList).toHaveBeenCalledTimes(1);

    const selectBookmark = mockRenderBookmarkList.mock.calls[0][1] as (
      bookmark: Record<string, string>,
    ) => void;
    expect(() =>
      selectBookmark({
        name: "Saved",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        access_key: "AKIA...",
        secret_key: "secret",
      }),
    ).not.toThrow();
  });

  it("clamps corrupt window sizes pre-save to defaults", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    mockInvoke.mockResolvedValue(undefined);

    async function savedPayloadFor(
      width: unknown,
      height: unknown,
    ): Promise<Record<string, unknown>> {
      mockInvoke.mockClear();
      state.currentSettings = {
        ...SETTING_DEFAULTS,
        windowWidth: width as number,
        windowHeight: height as number,
      };
      state.settingsExtras = {};
      await settings.saveSettings();
      const arg = mockInvoke.mock.calls[0]?.[1] as { json: string };
      return JSON.parse(arg.json) as Record<string, unknown>;
    }

    expect(await savedPayloadFor(0, 0)).toMatchObject({
      windowWidth: SETTING_DEFAULTS.windowWidth,
      windowHeight: SETTING_DEFAULTS.windowHeight,
    });
    expect(await savedPayloadFor(399, 299)).toMatchObject({
      windowWidth: SETTING_DEFAULTS.windowWidth,
      windowHeight: SETTING_DEFAULTS.windowHeight,
    });
    expect(await savedPayloadFor(10001, 10001)).toMatchObject({
      windowWidth: SETTING_DEFAULTS.windowWidth,
      windowHeight: SETTING_DEFAULTS.windowHeight,
    });
    expect(await savedPayloadFor(800.5, "large")).toMatchObject({
      windowWidth: SETTING_DEFAULTS.windowWidth,
      windowHeight: SETTING_DEFAULTS.windowHeight,
    });
    expect(await savedPayloadFor(NaN, Infinity)).toMatchObject({
      windowWidth: SETTING_DEFAULTS.windowWidth,
      windowHeight: SETTING_DEFAULTS.windowHeight,
    });

    const valid = await savedPayloadFor(1440, 900);
    expect(valid.windowWidth).toBe(1440);
    expect(valid.windowHeight).toBe(900);
    // Schema version is always stamped on save.
    expect(valid._schemaVersion).toBe(2);
  });

  it("partial reset carries telemetry extras and stamps setup complete", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.settingsExtras = {
      launchCount: 7,
      supportPromptDismissed: true,
      transfersHintDismissed: true,
      _setupComplete: false,
    };
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);

    await settings.resetSettings();

    expect(mockInvoke).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        json: expect.stringContaining('"_setupComplete": true'),
      }),
    );
    const payload = JSON.parse(
      (mockInvoke.mock.calls[0]?.[1] as { json: string }).json,
    ) as Record<string, unknown>;
    expect(payload.launchCount).toBe(7);
    expect(payload.supportPromptDismissed).toBe(true);
    expect(payload.transfersHintDismissed).toBe(true);
    expect(payload._setupComplete).toBe(true);
    expect(payload._schemaVersion).toBe(2);
    expect(mockInvoke).toHaveBeenCalledWith("clear_saved_connection");
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("partial reset drops mistyped extras but keeps setup complete", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.settingsExtras = {
      launchCount: "seven",
      supportPromptDismissed: "yes",
      transfersHintDismissed: 123,
    };
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);

    await settings.resetSettings();

    const payload = JSON.parse(
      (mockInvoke.mock.calls[0]?.[1] as { json: string }).json,
    ) as Record<string, unknown>;
    expect(payload._setupComplete).toBe(true);
    expect(payload.launchCount).toBeUndefined();
    expect(payload.supportPromptDismissed).toBeUndefined();
    expect(payload.transfersHintDismissed).toBeUndefined();
  });

  it("alerts when partial reset save fails without relaunch", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.settingsExtras = { launchCount: 3 };
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockInvoke.mockRejectedValueOnce(new Error("disk full"));

    await settings.resetSettings();

    expect(mockShowAlert).toHaveBeenCalledWith(
      "Reset Failed",
      expect.stringContaining("disk full"),
    );
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("alerts when factory reset fails before destructive cleanup", async () => {
    const settings = await import("../settings.ts");
    localStorage.setItem("s3-sidekick.keep", "1");
    mockShowConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockInvoke.mockRejectedValueOnce(new Error("factory boom"));

    await settings.resetSettings();

    expect(mockShowAlert).toHaveBeenCalledWith(
      "Factory Reset Failed",
      expect.stringContaining("factory boom"),
    );
    expect(localStorage.getItem("s3-sidekick.keep")).toBe("1");
    expect(mockRelaunch).not.toHaveBeenCalled();
    localStorage.clear();
  });

  it("still relaunches when browser storage cleanup is unavailable", async () => {
    const settings = await import("../settings.ts");
    mockShowConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockInvoke.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);
    const clearSpy = vi
      .spyOn(Storage.prototype, "clear")
      .mockImplementationOnce(() => {
        throw new Error("denied");
      });

    await settings.resetSettings();

    expect(mockInvoke).toHaveBeenCalledWith(
      "factory_reset",
      expect.objectContaining({
        settingsJson: expect.stringContaining('"_schemaVersion": 2'),
      }),
    );
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it("exports bookmarks with secrets, redacted, or abort", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div><div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div class="settings-tabs"><button class="settings-tab" data-settings-tab="general"></button></div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:test"),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    settings.openSettingsModal();
    await flushMicrotasks();
    const exportBtn = document.getElementById(
      "bookmarks-export-btn",
    ) as HTMLButtonElement;

    // Abort: first confirm false writes nothing.
    mockShowConfirm.mockResolvedValueOnce(false);
    mockExportBookmarksJson.mockClear();
    exportBtn.click();
    await flushMicrotasks(4);
    expect(mockShowConfirm).toHaveBeenCalledWith(
      "Export bookmarks?",
      expect.any(String),
      expect.objectContaining({ okLabel: "Export" }),
    );
    expect(mockExportBookmarksJson).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();

    // Include secrets.
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    exportBtn.click();
    await flushMicrotasks(4);
    expect(mockExportBookmarksJson).toHaveBeenLastCalledWith(true);
    expect(anchorClick).toHaveBeenCalledTimes(1);

    // Redacted: second confirm false still exports with false.
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    exportBtn.click();
    await flushMicrotasks(4);
    expect(mockExportBookmarksJson).toHaveBeenLastCalledWith(false);
    expect(anchorClick).toHaveBeenCalledTimes(2);
    anchorClick.mockRestore();
  });

  it("tracks transfers hint and recovers launch count from corrupt extras", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    mockInvoke.mockResolvedValue(undefined);

    state.settingsExtras = {};
    expect(settings.isTransfersHintDismissed()).toBe(false);
    await settings.markTransfersHintDismissed();
    expect(settings.isTransfersHintDismissed()).toBe(true);
    expect(state.settingsExtras.transfersHintDismissed).toBe(true);

    state.settingsExtras = { launchCount: "corrupt" };
    const next = await settings.incrementLaunchCount();
    expect(next).toBe(1);
    expect(state.settingsExtras.launchCount).toBe(1);
  });

  it("reports malformed settings separately from valid payloads", async () => {
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");

    mockInvoke.mockResolvedValueOnce("{bad json");
    const malformed = await settings.loadSettings();
    expect(malformed).toBe(false);
    expect(state.currentSettings).toEqual(SETTING_DEFAULTS);
    expect(state.settingsExtras._schemaVersion).toBe(2);

    mockInvoke.mockResolvedValueOnce(JSON.stringify({ theme: "dark" }));
    const valid = await settings.loadSettings();
    expect(valid).toBe(true);
    expect(state.currentSettings.theme).toBe("dark");
  });

  it("applies transfer performance presets to controls", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="system" selected>system</option></select>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <select id="setting-transfer-retries"><option value="3" selected>3</option></select>
      <select id="setting-transfer-retry-base-ms"><option value="400" selected>400</option></select>
      <select id="setting-conflict-policy"><option value="ask" selected>ask</option></select>
      <select id="setting-transfer-performance-preset">
        <option value="safe">safe</option><option value="balanced" selected>balanced</option><option value="max">max</option>
      </select>
      <select id="setting-download-parallel-threshold-mb"><option value="128" selected>128</option><option value="256">256</option><option value="64">64</option></select>
      <select id="setting-download-part-size-mb"><option value="32" selected>32</option><option value="16">16</option><option value="64">64</option></select>
      <select id="setting-download-part-concurrency"><option value="6" selected>6</option><option value="2">2</option><option value="10">10</option></select>
      <select id="setting-upload-part-size-mb"><option value="32" selected>32</option><option value="16">16</option><option value="64">64</option></select>
      <select id="setting-upload-part-concurrency"><option value="6" selected>6</option><option value="2">2</option><option value="10">10</option></select>
      <div id="updater-section"></div><div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div class="settings-tabs"><button class="settings-tab" data-settings-tab="general"></button></div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    settings.populateSettingsModal();
    await flushMicrotasks();

    const preset = document.getElementById(
      "setting-transfer-performance-preset",
    ) as HTMLSelectElement;
    const threshold = document.getElementById(
      "setting-download-parallel-threshold-mb",
    ) as HTMLSelectElement;
    const dlPart = document.getElementById(
      "setting-download-part-size-mb",
    ) as HTMLSelectElement;
    const dlConc = document.getElementById(
      "setting-download-part-concurrency",
    ) as HTMLSelectElement;

    preset.value = "safe";
    preset.onchange?.(new Event("change"));
    expect(threshold.value).toBe("256");
    expect(dlPart.value).toBe("16");
    expect(dlConc.value).toBe("2");

    preset.value = "max";
    preset.onchange?.(new Event("change"));
    expect(threshold.value).toBe("64");
    expect(dlConc.value).toBe("10");

    preset.value = "balanced";
    preset.onchange?.(new Event("change"));
    expect(threshold.value).toBe("128");
  });

  it("wires theme radios, cards, and advanced transfer toggle", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <input id="setting-theme" value="system" />
      <input type="radio" name="theme" value="system" checked />
      <input type="radio" name="theme" value="light" />
      <input type="radio" name="theme" value="invalid-radio" />
      <div class="theme-card" data-theme-card="system"></div>
      <div class="theme-card" data-theme-card="dark"></div>
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="release" selected>release</option></select>
      <select id="setting-presigned-expiration"><option value="3600" selected>3600</option></select>
      <select id="setting-max-concurrent"><option value="3" selected>3</option></select>
      <div id="updater-section"></div><div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div class="settings-tabs"><button class="settings-tab" data-settings-tab="general"></button></div>
      <div class="settings-panel" data-settings-panel="general"></div>
      <input id="settings-search" />
      <button id="transfers-advanced-toggle" aria-expanded="false"></button>
      <div id="transfers-advanced" hidden></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings.theme = "dark";
    settings.populateSettingsModal();
    await flushMicrotasks();

    // Cards sync to dark and radio reflects it.
    expect(
      document
        .querySelector('[data-theme-card="dark"]')
        ?.classList.contains("theme-card--active"),
    ).toBe(true);
    expect(
      (
        document.querySelector(
          'input[name="theme"][value="dark"]',
        ) as HTMLInputElement | null
      )?.checked ?? false,
    ).toBe(false);

    const lightRadio = document.querySelector(
      'input[name="theme"][value="light"]',
    ) as HTMLInputElement;
    lightRadio.checked = true;
    lightRadio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(
      (document.getElementById("setting-theme") as HTMLInputElement).value,
    ).toBe("light");

    // Invalid radio value is ignored.
    const invalid = document.querySelector(
      'input[name="theme"][value="invalid-radio"]',
    ) as HTMLInputElement;
    invalid.checked = true;
    invalid.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Unchecked change is ignored.
    lightRadio.checked = false;
    lightRadio.dispatchEvent(new Event("change", { bubbles: true }));

    // Advanced toggle expands and collapses.
    const toggle = document.getElementById(
      "transfers-advanced-toggle",
    ) as HTMLElement;
    const group = document.getElementById("transfers-advanced") as HTMLElement;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(group.hidden).toBe(false);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(group.hidden).toBe(true);

    // Search input is wired exactly once.
    const search = document.getElementById(
      "settings-search",
    ) as HTMLInputElement;
    expect(search.dataset.wired).toBe("true");
    settings.populateSettingsModal();
    expect(search.dataset.wired).toBe("true");
  });

  it("searches settings and restores the prior tab", async () => {
    document.body.innerHTML = `
      <div class="settings-tabs">
        <button class="settings-tab settings-tab--active" data-settings-tab="appearance">Appearance</button>
        <button class="settings-tab" data-settings-tab="transfers">Transfers</button>
      </div>
      <div class="settings-panel" data-settings-panel="appearance">
        <div class="setting-item">Theme <button data-tooltip="change theme tooltip">?</button></div>
        <div class="setting-item">Language</div>
      </div>
      <div class="settings-panel" data-settings-panel="transfers" hidden>
        <div class="setting-item">Bandwidth limit</div>
      </div>
      <div class="settings-panel" data-settings-panel="__search" hidden>
        <div class="settings-search-empty" hidden>No results</div>
      </div>
    `;
    const settings = await import("../settings.ts");

    settings.updateSettingsSearch("theme");
    expect(
      (
        document.querySelector(
          '[data-settings-panel="__search"]',
        ) as HTMLElement
      ).hidden,
    ).toBe(false);
    expect(
      document.querySelector(".settings-search-group-title")?.textContent,
    ).toBe("Appearance");
    expect(
      document.querySelector(".settings-search-empty") as HTMLElement,
    ).not.toBeNull();

    // Tooltip-only match via data-tooltip text.
    settings.updateSettingsSearch("change theme tooltip");
    expect(
      document.querySelectorAll(".settings-search-group").length,
    ).toBeGreaterThan(0);

    // No match shows the empty state.
    settings.updateSettingsSearch("zzz-no-match");
    expect(
      (document.querySelector(".settings-search-empty") as HTMLElement).hidden,
    ).toBe(false);

    // Empty query restores the original tab and items.
    settings.updateSettingsSearch("");
    expect(
      (
        document.querySelector(
          '[data-settings-panel="appearance"]',
        ) as HTMLElement
      ).hidden,
    ).toBe(false);
    expect(
      document.querySelectorAll(
        '[data-settings-panel="appearance"] .setting-item',
      ).length,
    ).toBe(2);

    // Missing search panel is a safe no-op.
    document.body.innerHTML = `<div></div>`;
    expect(() => settings.updateSettingsSearch("theme")).not.toThrow();
  });

  it("keeps __search hidden when switching tabs directly", async () => {
    document.body.innerHTML = `
      <button class="settings-tab" data-settings-tab="appearance">A</button>
      <button class="settings-tab" data-settings-tab="transfers">T</button>
      <div class="settings-panel" data-settings-panel="appearance"></div>
      <div class="settings-panel" data-settings-panel="transfers"></div>
      <div class="settings-panel" data-settings-panel="__search"></div>
    `;
    const settings = await import("../settings.ts");
    settings.switchSettingsTab("transfers");
    const searchPanel = document.querySelector(
      '[data-settings-panel="__search"]',
    ) as HTMLElement;
    expect(searchPanel.hidden).toBe(true);
    expect(searchPanel.style.display).toBe("none");
    expect(
      (document.querySelector('[data-settings-panel="transfers"]') as HTMLElement)
        .hidden,
    ).toBe(false);
  });

  it("reads every transfer control and normalizes out-of-range values", async () => {
    document.body.innerHTML = `
      <input type="radio" name="theme" value="dark" checked />
      <input id="setting-updates" type="checkbox" checked />
      <select id="setting-update-channel"><option value="beta" selected>beta</option></select>
      <select id="setting-presigned-expiration"><option value="nope" selected>nope</option></select>
      <select id="setting-max-concurrent"><option value="99" selected>99</option></select>
      <select id="setting-transfer-retries"><option value="4" selected>4</option></select>
      <select id="setting-transfer-retry-base-ms"><option value="800" selected>800</option></select>
      <select id="setting-conflict-policy"><option value="replace" selected>replace</option></select>
      <input id="setting-remember-download-path" type="checkbox" checked />
      <input id="setting-open-transfer-drawer" type="checkbox" />
      <select id="setting-transfer-performance-preset"><option value="max" selected>max</option></select>
      <select id="setting-download-parallel-threshold-mb"><option value="64" selected>64</option></select>
      <select id="setting-download-part-size-mb"><option value="999" selected>999</option></select>
      <select id="setting-download-part-concurrency"><option value="10" selected>10</option></select>
      <select id="setting-upload-part-size-mb"><option value="16" selected>16</option></select>
      <select id="setting-upload-part-concurrency"><option value="1" selected>1</option></select>
      <input id="setting-enable-transfer-resume" type="checkbox" checked />
      <input id="setting-enable-transfer-checksum-verification" type="checkbox" checked />
      <select id="setting-transfer-checkpoint-ttl-hours"><option value="72" selected>72</option></select>
      <select id="setting-bandwidth-limit-mbps"><option value="100" selected>100</option></select>
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = { ...SETTING_DEFAULTS };

    settings.readSettingsModal();

    expect(state.currentSettings.theme).toBe("dark");
    expect(state.currentSettings.updateChannel).toBe("beta");
    // Out-of-range values keep defaults.
    expect(state.currentSettings.presignedUrlExpiration).toBe(3600);
    expect(state.currentSettings.maxConcurrentTransfers).toBe(3);
    expect(state.currentSettings.transferRetryAttempts).toBe(4);
    expect(state.currentSettings.transferRetryBaseMs).toBe(800);
    expect(state.currentSettings.conflictPolicy).toBe("replace");
    expect(state.currentSettings.rememberDownloadPath).toBe(true);
    expect(state.currentSettings.openTransferDrawerOnStart).toBe(false);
    expect(state.currentSettings.transferPerformancePreset).toBe("max");
    expect(state.currentSettings.downloadParallelThresholdMb).toBe(64);
    expect(state.currentSettings.downloadPartSizeMb).toBe(32);
    expect(state.currentSettings.downloadPartConcurrency).toBe(10);
    expect(state.currentSettings.uploadPartSizeMb).toBe(16);
    expect(state.currentSettings.uploadPartConcurrency).toBe(1);
    expect(state.currentSettings.enableTransferResume).toBe(true);
    expect(state.currentSettings.enableTransferChecksumVerification).toBe(true);
    expect(state.currentSettings.transferCheckpointTtlHours).toBe(72);
    expect(state.currentSettings.bandwidthLimitMbps).toBe(100);
  });

  it("falls back to hidden theme input and normalizes conflict/preset values", async () => {
    document.body.innerHTML = `
      <input id="setting-theme" value="light" />
      <select id="setting-conflict-policy"><option value="weird" selected>weird</option></select>
      <select id="setting-transfer-performance-preset"><option value="weird" selected>weird</option></select>
      <select id="setting-transfer-retries"><option value="99" selected>99</option></select>
      <select id="setting-transfer-retry-base-ms"><option value="1" selected>1</option></select>
      <select id="setting-download-parallel-threshold-mb"><option value="1" selected>1</option></select>
      <select id="setting-download-part-size-mb"><option value="1" selected>1</option></select>
      <select id="setting-download-part-concurrency"><option value="99" selected>99</option></select>
      <select id="setting-upload-part-size-mb"><option value="1" selected>1</option></select>
      <select id="setting-upload-part-concurrency"><option value="99" selected>99</option></select>
      <select id="setting-transfer-checkpoint-ttl-hours"><option value="9999" selected>9999</option></select>
      <select id="setting-bandwidth-limit-mbps"><option value="-5" selected>-5</option></select>
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = { ...SETTING_DEFAULTS, conflictPolicy: "ask" };

    settings.readSettingsModal();

    expect(state.currentSettings.theme).toBe("light");
    expect(state.currentSettings.conflictPolicy).toBe("ask");
    expect(state.currentSettings.transferPerformancePreset).toBe("balanced");
    expect(state.currentSettings.transferRetryAttempts).toBe(3);
    expect(state.currentSettings.bandwidthLimitMbps).toBe(0);
  });

  it("populates every settings control from state", async () => {
    document.body.innerHTML = `
      <div id="settings-overlay" class="modal-overlay"></div>
      <select id="setting-theme"><option value="dark">dark</option></select>
      <input id="setting-updates" type="checkbox" />
      <select id="setting-update-channel"><option value="beta">beta</option></select>
      <select id="setting-presigned-expiration"><option value="900">900</option></select>
      <select id="setting-max-concurrent"><option value="8">8</option></select>
      <select id="setting-transfer-retries"><option value="4">4</option></select>
      <select id="setting-transfer-retry-base-ms"><option value="800">800</option></select>
      <select id="setting-conflict-policy"><option value="replace">replace</option></select>
      <input id="setting-remember-download-path" type="checkbox" />
      <input id="setting-open-transfer-drawer" type="checkbox" />
      <select id="setting-transfer-performance-preset"><option value="max">max</option></select>
      <select id="setting-download-parallel-threshold-mb"><option value="64">64</option></select>
      <select id="setting-download-part-size-mb"><option value="64">64</option></select>
      <select id="setting-download-part-concurrency"><option value="10">10</option></select>
      <select id="setting-upload-part-size-mb"><option value="64">64</option></select>
      <select id="setting-upload-part-concurrency"><option value="10">10</option></select>
      <input id="setting-enable-transfer-resume" type="checkbox" />
      <input id="setting-enable-transfer-checksum-verification" type="checkbox" />
      <select id="setting-transfer-checkpoint-ttl-hours"><option value="72">72</option></select>
      <select id="setting-bandwidth-limit-mbps"><option value="100">100</option></select>
      <div id="updater-section"></div><div id="updater-unsupported"></div>
      <ul id="bookmark-list"></ul>
      <div id="security-status-text"></div><button id="security-toggle"></button>
      <button id="security-change-password"></button><div id="security-warning"></div>
      <div id="security-lock-settings"></div><div id="security-lock-action"></div>
      <select id="security-lock-timeout"></select>
      <div id="security-biometric-settings"></div><button id="biometric-toggle"></button>
      <span id="settings-version"></span><span id="settings-platform"></span>
      <div class="settings-tabs"><button class="settings-tab" data-settings-tab="appearance">A</button></div>
      <div class="settings-panel" data-settings-panel="appearance"></div>
      <input id="settings-search" />
      <button id="transfers-advanced-toggle"></button><div id="transfers-advanced"></div>
      <button id="bookmarks-export-btn"></button>
      <button id="bookmarks-import-btn"></button>
      <input id="bookmarks-import-input" type="file" />
    `;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "beta",
      presignedUrlExpiration: 900,
      maxConcurrentTransfers: 8,
      transferRetryAttempts: 4,
      transferRetryBaseMs: 800,
      conflictPolicy: "replace",
      rememberDownloadPath: false,
      openTransferDrawerOnStart: false,
      transferPerformancePreset: "max",
      downloadParallelThresholdMb: 64,
      downloadPartSizeMb: 64,
      downloadPartConcurrency: 10,
      uploadPartSizeMb: 64,
      uploadPartConcurrency: 10,
      enableTransferResume: false,
      enableTransferChecksumVerification: true,
      transferCheckpointTtlHours: 72,
      bandwidthLimitMbps: 100,
    };
    state.platformName = "macos";

    settings.populateSettingsModal();
    await flushMicrotasks();

    expect(
      (document.getElementById("setting-theme") as HTMLSelectElement).value,
    ).toBe("dark");
    expect(
      (document.getElementById("setting-updates") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (document.getElementById("setting-update-channel") as HTMLSelectElement)
        .value,
    ).toBe("beta");
    expect(
      (document.getElementById("setting-transfer-retries") as HTMLSelectElement)
        .value,
    ).toBe("4");
    expect(
      (document.getElementById("setting-conflict-policy") as HTMLSelectElement)
        .value,
    ).toBe("replace");
    expect(
      (document.getElementById("setting-bandwidth-limit-mbps") as HTMLSelectElement)
        .value,
    ).toBe("100");
    expect(
      (document.getElementById("settings-platform") as HTMLElement).textContent,
    ).toBe("macOS");
    expect(
      (document.getElementById("settings-version") as HTMLElement).textContent,
    ).toBe("v0.6.0");
  });
});
