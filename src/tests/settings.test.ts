import { beforeEach, describe, expect, it, vi } from "vitest";

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
      theme: "system",
      autoCheckUpdates: true,
      updateChannel: "release",
      presignedUrlExpiration: 3600,
      maxConcurrentTransfers: 3,
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
      theme: "system",
      autoCheckUpdates: false,
      updateChannel: "beta",
      presignedUrlExpiration: 3600,
      maxConcurrentTransfers: 3,
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

    mockInvoke.mockResolvedValueOnce(undefined);
    settings.openSettingsModal();
    expect(overlay.classList.contains("active")).toBe(true);
    await settings.closeSettingsModal(true);
    expect(overlay.classList.contains("active")).toBe(false);

    overlay.classList.add("active");
    state.lastPersistedSettings = {
      theme: "light",
      autoCheckUpdates: true,
      updateChannel: "release",
      presignedUrlExpiration: 3600,
      maxConcurrentTransfers: 3,
    };
    state.currentSettings = {
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
    expect(mockInvoke).toHaveBeenCalledWith("save_connection", { json: "" });
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

  it("reverts in-memory settings when close modal is cancelled", async () => {
    document.body.innerHTML = `<div id="settings-overlay" class="modal-overlay active"></div>`;
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.lastPersistedSettings = {
      theme: "dark",
      autoCheckUpdates: false,
      updateChannel: "release",
      presignedUrlExpiration: 3600,
      maxConcurrentTransfers: 5,
    };
    state.currentSettings = {
      theme: "light",
      autoCheckUpdates: true,
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
        | ((this: FileReader, ev: ProgressEvent<FileReader>) => void)
        | null = null;

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
  });

  it("handles missing settings controls and overlay elements safely", async () => {
    document.body.innerHTML = "";
    const settings = await import("../settings.ts");
    const { state } = await import("../state.ts");
    state.currentSettings = {
      theme: "dark",
      autoCheckUpdates: true,
      updateChannel: "beta",
      presignedUrlExpiration: 3600,
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
      theme: "system",
      autoCheckUpdates: false,
      updateChannel: "release",
      presignedUrlExpiration: 120,
      maxConcurrentTransfers: 2,
    };
    state.currentSettings = {
      theme: "light",
      autoCheckUpdates: true,
      updateChannel: "beta",
      presignedUrlExpiration: 3600,
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
});
