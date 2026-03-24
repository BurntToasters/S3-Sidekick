import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetVersion = vi.fn<() => Promise<string>>();
const mockOpen = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSave = vi.fn<(...args: unknown[]) => Promise<string | null>>();

const mockLoadSettings = vi.fn<() => Promise<void>>();
const mockOpenSettingsModal = vi.fn();
const mockCloseSettingsModal = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockResetSettings = vi.fn();
const mockSetBookmarkSelectHandler = vi.fn();
const mockSwitchSettingsTab = vi.fn();
const mockIncrementLaunchCount = vi.fn<() => Promise<number>>();
const mockMarkSupportPromptDismissed = vi.fn<() => Promise<void>>();
const mockIsSupportPromptDismissed = vi.fn();

const mockConnect = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockDisconnect = vi.fn<() => Promise<void>>();
const mockSaveConnection = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockLoadConnection = vi.fn<() => Promise<unknown>>();
const mockRefreshBuckets = vi.fn<() => Promise<void>>();
const mockRefreshObjects = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockLoadMoreObjects = vi.fn<() => Promise<void>>();

const mockRenderBucketList = vi.fn();
const mockRenderObjectTable = vi.fn();
const mockRenderBreadcrumb = vi.fn();
const mockNavigateToFolder = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockSelectBucket = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockShowEmptyState = vi.fn();
const mockHandleRowClick = vi.fn();
const mockHandleSelectAll = vi.fn();
const mockClearSelection = vi.fn();
const mockUpdateSelectionUI = vi.fn();
const mockGetSelectableKeys = vi.fn();
const mockToggleSort = vi.fn();
const mockNavigateUp = vi.fn<() => Promise<void>>();
const mockNavigateBack = vi.fn<() => Promise<void>>();
const mockNavigateForward = vi.fn<() => Promise<void>>();
const mockClearNavHistory = vi.fn();
const mockPruneStaleSelection = vi.fn();

const mockInitUpdater = vi.fn<() => Promise<void>>();
const mockAutoCheckUpdates = vi.fn<() => Promise<void>>();
const mockCheckUpdates = vi.fn<() => Promise<void>>();
const mockSetUpdateChannel = vi.fn();

const mockAddBookmark = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockRenderBookmarkBar = vi.fn();
const mockLoadBookmarks = vi.fn<() => Promise<void>>();
const mockSetBookmarkChangeHandler = vi.fn();

const mockOpenLicensesModal = vi.fn();
const mockCloseLicensesModal = vi.fn();

const mockShowContextMenu = vi.fn();
const mockHideContextMenu = vi.fn();

const mockOpenInfoPanel = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockCloseInfoPanel = vi.fn();
const mockSaveInfoPanel = vi.fn<() => Promise<void>>();
const mockSwitchTab = vi.fn();

const mockToggleTransferQueue = vi.fn();
const mockClearCompletedTransfers = vi.fn();
const mockEnqueuePaths = vi.fn();
const mockSetTransferCompleteHandler = vi.fn();
const mockInitTransferQueueUI = vi.fn<() => Promise<void>>();
const mockEnqueueFiles = vi.fn();
const mockDisposeTransferQueueUI = vi.fn<() => Promise<void>>();
const mockEnqueueDownloads = vi.fn();
const mockEnqueueFolderEntries = vi.fn();

const mockWireKeyboardShortcuts = vi.fn();
const mockCanPreview = vi.fn();
const mockOpenPreview = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockClosePreview = vi.fn();

const mockLogActivity = vi.fn();
const mockToggleActivityLog = vi.fn();
const mockClearActivityLog = vi.fn();

const mockInitDrawer = vi.fn();
const mockGetActiveTab = vi.fn();

const mockEnsureSecurityReady = vi.fn<() => Promise<boolean>>();
const mockHandleSecurityChangePassword =
  vi.fn<(...args: unknown[]) => Promise<void>>();
const mockHandleSecurityToggle = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockHandleLockNow = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockHandleLockTimeoutChange = vi.fn<() => Promise<void>>();
const mockHandleBiometricToggle =
  vi.fn<(...args: unknown[]) => Promise<void>>();

const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockShowPrompt = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockIsDialogActive = vi.fn();

const mockInitPalette = vi.fn();
const mockRegisterCommands = vi.fn();
const mockIsPaletteOpen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

let capturedDragDropHandler:
  | ((event: { payload: DragDropPayload }) => void)
  | null = null;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (
      handler: (event: { payload: DragDropPayload }) => void,
    ) => {
      capturedDragDropHandler = handler;
      return Promise.resolve(() => {});
    },
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
  save: mockSave,
}));

vi.mock("../settings.ts", () => ({
  loadSettings: mockLoadSettings,
  openSettingsModal: mockOpenSettingsModal,
  closeSettingsModal: mockCloseSettingsModal,
  resetSettings: mockResetSettings,
  setBookmarkSelectHandler: mockSetBookmarkSelectHandler,
  switchSettingsTab: mockSwitchSettingsTab,
  incrementLaunchCount: mockIncrementLaunchCount,
  markSupportPromptDismissed: mockMarkSupportPromptDismissed,
  isSupportPromptDismissed: mockIsSupportPromptDismissed,
}));

vi.mock("../connection.ts", () => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  saveConnection: mockSaveConnection,
  loadConnection: mockLoadConnection,
  refreshBuckets: mockRefreshBuckets,
  refreshObjects: mockRefreshObjects,
  loadMoreObjects: mockLoadMoreObjects,
}));

vi.mock("../browser.ts", () => ({
  renderBucketList: mockRenderBucketList,
  renderObjectTable: mockRenderObjectTable,
  renderBreadcrumb: mockRenderBreadcrumb,
  navigateToFolder: mockNavigateToFolder,
  selectBucket: mockSelectBucket,
  showEmptyState: mockShowEmptyState,
  handleRowClick: mockHandleRowClick,
  handleSelectAll: mockHandleSelectAll,
  clearSelection: mockClearSelection,
  updateSelectionUI: mockUpdateSelectionUI,
  getSelectableKeys: mockGetSelectableKeys,
  toggleSort: mockToggleSort,
  navigateUp: mockNavigateUp,
  navigateBack: mockNavigateBack,
  navigateForward: mockNavigateForward,
  clearNavHistory: mockClearNavHistory,
  pruneStaleSelection: mockPruneStaleSelection,
}));

vi.mock("../updater.ts", () => ({
  initUpdater: mockInitUpdater,
  autoCheckUpdates: mockAutoCheckUpdates,
  checkUpdates: mockCheckUpdates,
  setUpdateChannel: mockSetUpdateChannel,
}));

vi.mock("../bookmarks.ts", () => ({
  addBookmark: mockAddBookmark,
  renderBookmarkBar: mockRenderBookmarkBar,
  loadBookmarks: mockLoadBookmarks,
  setBookmarkChangeHandler: mockSetBookmarkChangeHandler,
}));

vi.mock("../licenses.ts", () => ({
  openLicensesModal: mockOpenLicensesModal,
  closeLicensesModal: mockCloseLicensesModal,
}));

vi.mock("../context-menu.ts", () => ({
  showContextMenu: mockShowContextMenu,
  hideContextMenu: mockHideContextMenu,
}));

vi.mock("../info-panel.ts", () => ({
  openInfoPanel: mockOpenInfoPanel,
  closeInfoPanel: mockCloseInfoPanel,
  saveInfoPanel: mockSaveInfoPanel,
  switchTab: mockSwitchTab,
}));

vi.mock("../transfers.ts", () => ({
  toggleTransferQueue: mockToggleTransferQueue,
  clearCompletedTransfers: mockClearCompletedTransfers,
  enqueuePaths: mockEnqueuePaths,
  setTransferCompleteHandler: mockSetTransferCompleteHandler,
  initTransferQueueUI: mockInitTransferQueueUI,
  enqueueFiles: mockEnqueueFiles,
  disposeTransferQueueUI: mockDisposeTransferQueueUI,
  enqueueDownloads: mockEnqueueDownloads,
  enqueueFolderEntries: mockEnqueueFolderEntries,
}));

vi.mock("../keyboard.ts", () => ({
  wireKeyboardShortcuts: mockWireKeyboardShortcuts,
}));

vi.mock("../preview.ts", () => ({
  canPreview: mockCanPreview,
  openPreview: mockOpenPreview,
  closePreview: mockClosePreview,
}));

vi.mock("../activity-log.ts", () => ({
  logActivity: mockLogActivity,
  toggleActivityLog: mockToggleActivityLog,
  clearActivityLog: mockClearActivityLog,
}));

vi.mock("../bottom-drawer.ts", () => ({
  initDrawer: mockInitDrawer,
  getActiveTab: mockGetActiveTab,
}));

vi.mock("../security.ts", () => ({
  ensureSecurityReady: mockEnsureSecurityReady,
  handleSecurityChangePassword: mockHandleSecurityChangePassword,
  handleSecurityToggle: mockHandleSecurityToggle,
  handleLockNow: mockHandleLockNow,
  handleLockTimeoutChange: mockHandleLockTimeoutChange,
  handleBiometricToggle: mockHandleBiometricToggle,
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: mockShowConfirm,
  showPrompt: mockShowPrompt,
  isDialogActive: mockIsDialogActive,
}));

vi.mock("../command-palette.ts", () => ({
  initPalette: mockInitPalette,
  registerCommands: mockRegisterCommands,
  isPaletteOpen: mockIsPaletteOpen,
}));

const mockShouldShowSetupWizard = vi.fn(() => false);
const mockShowSetupWizard = vi.fn<() => Promise<null>>();
const mockMarkSetupComplete = vi.fn<() => Promise<void>>();

vi.mock("../setup-wizard.ts", () => ({
  shouldShowSetupWizard: mockShouldShowSetupWizard,
  showSetupWizard: mockShowSetupWizard,
  markSetupComplete: mockMarkSetupComplete,
}));

const INDEX_HTML = fs.readFileSync(
  path.join(process.cwd(), "src", "index.html"),
  "utf8",
);
let clipboardWriteText = vi.fn<(data: string) => Promise<void>>();

function mountIndexFixture(): void {
  const bodyMatch = INDEX_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml =
    bodyMatch?.[1]?.replace(
      '<script type="module" src="main.ts"></script>',
      "",
    ) ?? "";
  document.body.innerHTML = bodyHtml;
}

async function flushMicrotasks(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve();
  }
}

function setupMatchMedia(matches = false): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setupClipboard(writeText: (data: string) => Promise<void>): void {
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return;
  }
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
}

describe("main integration", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    mountIndexFixture();
    setupMatchMedia(false);
    capturedDragDropHandler = null;

    mockInvoke.mockReset();
    mockGetVersion.mockReset();
    mockOpen.mockReset();
    mockSave.mockReset();
    mockLoadSettings.mockReset();
    mockOpenSettingsModal.mockReset();
    mockCloseSettingsModal.mockReset();
    mockResetSettings.mockReset();
    mockSetBookmarkSelectHandler.mockReset();
    mockSwitchSettingsTab.mockReset();
    mockIncrementLaunchCount.mockReset();
    mockMarkSupportPromptDismissed.mockReset();
    mockIsSupportPromptDismissed.mockReset();
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockSaveConnection.mockReset();
    mockLoadConnection.mockReset();
    mockRefreshBuckets.mockReset();
    mockRefreshObjects.mockReset();
    mockLoadMoreObjects.mockReset();
    mockRenderBucketList.mockReset();
    mockRenderObjectTable.mockReset();
    mockRenderBreadcrumb.mockReset();
    mockNavigateToFolder.mockReset();
    mockSelectBucket.mockReset();
    mockShowEmptyState.mockReset();
    mockHandleRowClick.mockReset();
    mockHandleSelectAll.mockReset();
    mockClearSelection.mockReset();
    mockUpdateSelectionUI.mockReset();
    mockGetSelectableKeys.mockReset();
    mockToggleSort.mockReset();
    mockNavigateUp.mockReset();
    mockNavigateBack.mockReset();
    mockNavigateForward.mockReset();
    mockClearNavHistory.mockReset();
    mockPruneStaleSelection.mockReset();
    mockInitUpdater.mockReset();
    mockAutoCheckUpdates.mockReset();
    mockCheckUpdates.mockReset();
    mockSetUpdateChannel.mockReset();
    mockAddBookmark.mockReset();
    mockRenderBookmarkBar.mockReset();
    mockLoadBookmarks.mockReset();
    mockSetBookmarkChangeHandler.mockReset();
    mockOpenLicensesModal.mockReset();
    mockCloseLicensesModal.mockReset();
    mockShowContextMenu.mockReset();
    mockHideContextMenu.mockReset();
    mockOpenInfoPanel.mockReset();
    mockCloseInfoPanel.mockReset();
    mockSaveInfoPanel.mockReset();
    mockSwitchTab.mockReset();
    mockToggleTransferQueue.mockReset();
    mockClearCompletedTransfers.mockReset();
    mockEnqueuePaths.mockReset();
    mockSetTransferCompleteHandler.mockReset();
    mockInitTransferQueueUI.mockReset();
    mockEnqueueFiles.mockReset();
    mockDisposeTransferQueueUI.mockReset();
    mockEnqueueDownloads.mockReset();
    mockEnqueueFolderEntries.mockReset();
    mockWireKeyboardShortcuts.mockReset();
    mockCanPreview.mockReset();
    mockOpenPreview.mockReset();
    mockClosePreview.mockReset();
    mockLogActivity.mockReset();
    mockToggleActivityLog.mockReset();
    mockClearActivityLog.mockReset();
    mockInitDrawer.mockReset();
    mockGetActiveTab.mockReset();
    mockEnsureSecurityReady.mockReset();
    mockHandleSecurityChangePassword.mockReset();
    mockHandleSecurityToggle.mockReset();
    mockHandleLockNow.mockReset();
    mockHandleLockTimeoutChange.mockReset();
    mockHandleBiometricToggle.mockReset();
    mockShowConfirm.mockReset();
    mockShowPrompt.mockReset();
    mockIsDialogActive.mockReset();
    mockInitPalette.mockReset();
    mockRegisterCommands.mockReset();
    mockIsPaletteOpen.mockReset();

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "get_platform_info") return "windows";
      if (cmd === "delete_objects") return 1;
      if (cmd === "build_object_url") {
        return `https://example.com/${(payload as { key?: string }).key ?? ""}`;
      }
      if (cmd === "generate_presigned_url") {
        return `https://signed/${(payload as { key?: string }).key ?? ""}`;
      }
      if (cmd === "rename_object") return undefined;
      if (cmd === "create_folder") return undefined;
      if (cmd === "download_object") return 128;
      if (cmd === "list_local_files_recursive") {
        return [
          {
            file_path: "C:\\tmp\\folder\\a.txt",
            relative_path: "a.txt",
            size: 1,
          },
        ];
      }
      if (cmd === "open_external_url") return undefined;
      return undefined;
    });
    mockGetVersion.mockResolvedValue("0.6.0");
    mockOpen.mockImplementation(async (options) => {
      const o = options as { directory?: boolean } | undefined;
      if (o?.directory) return ["C:\\tmp\\folder"];
      return ["C:\\tmp\\upload-a.txt", "C:\\tmp\\upload-b.txt"];
    });
    mockSave.mockResolvedValue("C:\\tmp\\download.txt");
    mockLoadSettings.mockResolvedValue(undefined);
    mockCloseSettingsModal.mockResolvedValue(undefined);
    mockIncrementLaunchCount.mockResolvedValue(1);
    mockMarkSupportPromptDismissed.mockResolvedValue(undefined);
    mockIsSupportPromptDismissed.mockReturnValue(false);
    mockConnect.mockResolvedValue("us-west-2");
    mockDisconnect.mockResolvedValue(undefined);
    mockSaveConnection.mockResolvedValue(undefined);
    mockLoadConnection.mockResolvedValue({
      endpoint: "https://saved.example.com",
      region: "us-east-1",
      access_key: "saved-access",
      secret_key: "saved-secret",
    });
    mockRefreshBuckets.mockResolvedValue(undefined);
    mockRefreshObjects.mockResolvedValue(undefined);
    mockLoadMoreObjects.mockResolvedValue(undefined);
    mockNavigateToFolder.mockResolvedValue(undefined);
    mockSelectBucket.mockResolvedValue(undefined);
    mockGetSelectableKeys.mockReturnValue(["a.txt", "b.txt"]);
    mockNavigateUp.mockResolvedValue(undefined);
    mockNavigateBack.mockResolvedValue(undefined);
    mockNavigateForward.mockResolvedValue(undefined);
    mockInitUpdater.mockResolvedValue(undefined);
    mockAutoCheckUpdates.mockResolvedValue(undefined);
    mockCheckUpdates.mockResolvedValue(undefined);
    mockAddBookmark.mockResolvedValue(true);
    mockLoadBookmarks.mockResolvedValue(undefined);
    mockInitTransferQueueUI.mockResolvedValue(undefined);
    mockDisposeTransferQueueUI.mockResolvedValue(undefined);
    mockCanPreview.mockReturnValue(true);
    mockOpenPreview.mockResolvedValue(undefined);
    mockGetActiveTab.mockReturnValue("activity");
    mockEnsureSecurityReady.mockResolvedValue(true);
    mockHandleSecurityChangePassword.mockResolvedValue(undefined);
    mockHandleSecurityToggle.mockResolvedValue(undefined);
    mockHandleLockNow.mockResolvedValue(undefined);
    mockHandleLockTimeoutChange.mockResolvedValue(undefined);
    mockHandleBiometricToggle.mockResolvedValue(undefined);
    mockShowConfirm.mockResolvedValue(true);
    mockShowPrompt.mockResolvedValue("renamed.txt");
    mockIsDialogActive.mockReturnValue(false);
    mockIsPaletteOpen.mockReturnValue(false);

    clipboardWriteText = vi.fn(async (_data: string) => undefined);
    setupClipboard(clipboardWriteText);

    const { state } = await import("../state.ts");
    state.connected = false;
    state.currentBucket = "";
    state.currentPrefix = "";
    state.platformName = "";
    state.selectedKeys.clear();
  });

  it("initializes app and wires base controls", async () => {
    await import("../main.ts");
    await flushMicrotasks();

    expect(mockEnsureSecurityReady).toHaveBeenCalledTimes(1);
    expect(mockLoadSettings).toHaveBeenCalledTimes(1);
    expect(mockInitUpdater).toHaveBeenCalledTimes(1);
    expect(mockAutoCheckUpdates).toHaveBeenCalledTimes(1);
    expect(
      (document.getElementById("version-label") as HTMLSpanElement).textContent,
    ).toBe("v0.6.0");
    expect(
      (document.getElementById("conn-endpoint") as HTMLInputElement).value,
    ).toBe("https://saved.example.com");

    const secretInput = document.getElementById(
      "conn-secret-key",
    ) as HTMLInputElement;
    const secretToggle = document.getElementById(
      "secret-key-toggle",
    ) as HTMLButtonElement;
    const secretToggleIcon = document.getElementById(
      "secret-key-toggle-icon",
    ) as HTMLImageElement;
    secretToggle.click();
    expect(secretInput.type).toBe("text");
    expect(secretToggle.getAttribute("aria-pressed")).toBe("true");
    expect(secretToggleIcon.getAttribute("src")).toContain("1f648");
    secretToggle.click();
    expect(secretInput.type).toBe("password");
    expect(secretToggle.getAttribute("aria-pressed")).toBe("false");
    expect(secretToggleIcon.getAttribute("src")).toContain("1f441");

    const preset = document.getElementById(
      "conn-provider-preset",
    ) as HTMLSelectElement;
    const endpoint = document.getElementById(
      "conn-endpoint",
    ) as HTMLInputElement;
    const region = document.getElementById("conn-region") as HTMLInputElement;
    preset.value = "do";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    expect(endpoint.value).toContain("digitaloceanspaces.com");
    expect(region.value).toBe("nyc3");
    expect(preset.value).toBe("");

    const presets: Array<{ value: string; endpoint: string; region: string }> =
      [
        { value: "aws", endpoint: "", region: "us-east-1" },
        {
          value: "backblaze",
          endpoint: "https://s3.us-west-004.backblazeb2.com",
          region: "us-west-004",
        },
        {
          value: "cloudflare",
          endpoint: "https://<account-id>.r2.cloudflarestorage.com",
          region: "auto",
        },
        {
          value: "minio",
          endpoint: "http://localhost:9000",
          region: "us-east-1",
        },
        {
          value: "wasabi",
          endpoint: "https://s3.wasabisys.com",
          region: "us-east-1",
        },
      ];
    for (const item of presets) {
      preset.value = item.value;
      preset.dispatchEvent(new Event("change", { bubbles: true }));
      expect(endpoint.value).toBe(item.endpoint);
      expect(region.value).toBe(item.region);
      expect(preset.value).toBe("");
    }
    endpoint.value = "https://custom.example.com";
    region.value = "custom-region";
    preset.value = "unknown-provider";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    expect(endpoint.value).toBe("https://custom.example.com");
    expect(region.value).toBe("custom-region");
    expect(preset.value).toBe("");

    const channelSelect = document.getElementById(
      "setting-update-channel",
    ) as HTMLSelectElement;
    channelSelect.value = "beta";
    (
      document.getElementById("settings-check-updates") as HTMLButtonElement
    ).click();
    await flushMicrotasks();
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("beta");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("release");

    channelSelect.value = "release";
    (
      document.getElementById("settings-check-updates") as HTMLButtonElement
    ).click();
    await flushMicrotasks();
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("release");
  });

  it("handles connect, refresh, upload, and disconnect flows", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://service.example.com";
    (document.getElementById("conn-region") as HTMLInputElement).value =
      "us-east-1";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "ak";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "sk";

    (document.getElementById("connect-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledWith(
      "https://service.example.com",
      "us-east-1",
      "ak",
      "sk",
    );
    expect(mockRefreshBuckets).toHaveBeenCalledTimes(1);
    expect(mockSaveConnection).toHaveBeenCalledTimes(1);

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    (document.getElementById("btn-refresh") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockRefreshObjects).toHaveBeenCalledWith("bucket-a", "docs/");

    mockShowPrompt.mockResolvedValueOnce("new-folder");
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockInvoke).toHaveBeenCalledWith("create_folder", {
      bucket: "bucket-a",
      key: "docs/new-folder",
    });

    (document.getElementById("btn-upload") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockEnqueuePaths).toHaveBeenCalledWith(
      ["C:\\tmp\\upload-a.txt", "C:\\tmp\\upload-b.txt"],
      "docs/",
    );

    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockEnqueueFolderEntries).toHaveBeenCalledWith(
      expect.any(Array),
      "docs/",
    );

    vi.useFakeTimers();
    const filter = document.getElementById("filter-input") as HTMLInputElement;
    filter.value = "abc";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    filter.value = "abcd";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(130);
    expect(mockRenderObjectTable).toHaveBeenCalled();
    vi.useRealTimers();

    (document.getElementById("btn-load-more") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockLoadMoreObjects).toHaveBeenCalledTimes(1);

    (document.getElementById("disconnect-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockShowEmptyState).toHaveBeenCalledTimes(1);
  });

  it("handles bookmark select callback and overlay close controls", async () => {
    await import("../main.ts");
    await flushMicrotasks();

    expect(mockSetBookmarkSelectHandler).toHaveBeenCalledTimes(1);
    const onBookmarkSelect = mockSetBookmarkSelectHandler.mock.calls[0][0] as (
      bookmark: Record<string, string>,
    ) => void;
    onBookmarkSelect({
      name: "Pinned",
      endpoint: "https://bookmarked.example.com",
      region: "us-west-2",
      access_key: "bookmark-access",
      secret_key: "bookmark-secret",
    });
    expect(
      (document.getElementById("conn-endpoint") as HTMLInputElement).value,
    ).toBe("https://bookmarked.example.com");
    expect(
      (document.getElementById("conn-region") as HTMLInputElement).value,
    ).toBe("us-west-2");
    expect(
      (document.getElementById("conn-access-key") as HTMLInputElement).value,
    ).toBe("bookmark-access");
    expect(
      (document.getElementById("conn-secret-key") as HTMLInputElement).value,
    ).toBe("bookmark-secret");
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain('Loaded bookmark "Pinned".');

    (document.getElementById("settings-close") as HTMLButtonElement).click();
    (document.getElementById("settings-cancel") as HTMLButtonElement).click();
    (document.getElementById("settings-save") as HTMLButtonElement).click();
    (
      document.getElementById("settings-overlay") as HTMLDivElement
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushMicrotasks();
    expect(mockCloseSettingsModal).toHaveBeenCalledWith(false);
    expect(mockCloseSettingsModal).toHaveBeenCalledWith(true);

    (
      document.getElementById("licenses-overlay") as HTMLDivElement
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (document.getElementById("info-overlay") as HTMLDivElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    (
      document.getElementById("preview-overlay") as HTMLDivElement
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockCloseLicensesModal).toHaveBeenCalled();
    expect(mockCloseInfoPanel).toHaveBeenCalled();
    expect(mockClosePreview).toHaveBeenCalled();
  });

  it("handles object row interactions and context menu actions", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();

    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML = `
      <tr class="object-row object-row--folder" data-prefix="docs/folder/">
        <td class="col-name">folder</td>
      </tr>
      <tr class="object-row object-row--folder" data-prefix="docs/folder-check/" tabindex="0">
        <td class="col-check"><input class="row-check" type="checkbox" /></td>
        <td class="col-name">folder-check</td>
      </tr>
      <tr class="object-row" data-key="docs/file.txt" tabindex="0">
        <td class="col-check"><input class="row-check" type="checkbox" /></td>
        <td class="col-name">file.txt</td>
      </tr>
    `;

    const folderRow = tbody.querySelector(".object-row--folder") as HTMLElement;
    const folderCheckRow = tbody.querySelector(
      '[data-prefix="docs/folder-check/"]',
    ) as HTMLElement;
    const fileRow = tbody.querySelector(
      '[data-key="docs/file.txt"]',
    ) as HTMLElement;
    const rowCheck = fileRow.querySelector(".row-check") as HTMLInputElement;

    folderRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/folder/");
    folderCheckRow
      .querySelector(".col-check")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockHandleRowClick).toHaveBeenCalledWith(
      "prefix:docs/folder-check/",
      expect.any(MouseEvent),
    );

    fileRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flushMicrotasks();
    expect(mockOpenPreview).toHaveBeenCalledWith("docs/file.txt");

    folderRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/folder/");

    folderRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/folder/");

    fileRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushMicrotasks();
    expect(mockOpenPreview).toHaveBeenCalledWith("docs/file.txt");

    mockCanPreview.mockReturnValue(false);
    fileRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flushMicrotasks();
    expect(mockOpenInfoPanel).toHaveBeenCalledWith(["docs/file.txt"]);
    fileRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushMicrotasks();
    expect(mockOpenInfoPanel).toHaveBeenCalledWith(["docs/file.txt"]);

    rowCheck.checked = true;
    rowCheck.dispatchEvent(new Event("change", { bubbles: true }));
    expect(mockUpdateSelectionUI).toHaveBeenCalled();
    rowCheck.checked = false;
    rowCheck.dispatchEvent(new Event("change", { bubbles: true }));
    expect(mockUpdateSelectionUI).toHaveBeenCalled();

    state.selectedKeys.delete("docs/file.txt");
    fileRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(state.selectedKeys.has("docs/file.txt")).toBe(true);
    fileRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(state.selectedKeys.has("docs/file.txt")).toBe(false);
    expect(mockUpdateSelectionUI).toHaveBeenCalled();

    fileRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 20,
      }),
    );
    const ctxCall = mockShowContextMenu.mock.calls.at(-1);
    expect(ctxCall).toBeTruthy();
    const onAction = ctxCall?.[3] as ((action: string) => void) | undefined;
    expect(onAction).toBeTruthy();

    if (onAction) {
      onAction("copy-url");
      onAction("copy-presigned-url");
      onAction("rename");
      onAction("download");
      onAction("delete");
      onAction("info");
      await flushMicrotasks(6);
    }

    expect(mockInvoke).toHaveBeenCalledWith("build_object_url", {
      bucket: "bucket-a",
      key: "docs/file.txt",
    });
    expect(mockInvoke).toHaveBeenCalledWith("generate_presigned_url", {
      bucket: "bucket-a",
      key: "docs/file.txt",
      expiresInSecs: expect.any(Number),
    });
    expect(mockInvoke).toHaveBeenCalledWith("rename_object", {
      bucket: "bucket-a",
      oldKey: "docs/file.txt",
      newKey: "docs/renamed.txt",
    });
    expect(mockInvoke).toHaveBeenCalledWith("delete_objects", {
      bucket: "bucket-a",
      keys: ["docs/file.txt"],
    });
    expect(mockOpenInfoPanel).toHaveBeenCalledWith(["docs/file.txt"]);
    expect(mockEnqueueDownloads).toHaveBeenCalledWith([
      {
        bucket: "bucket-a",
        key: "docs/file.txt",
        destination: "C:\\tmp\\download.txt",
      },
    ]);
  });

  it("builds preview and multi-select properties context menu variants", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML = `
      <tr class="object-row" data-key="docs/file-a.txt" tabindex="0">
        <td class="col-name">file-a.txt</td>
      </tr>
    `;
    const row = tbody.querySelector(".object-row") as HTMLElement;

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file-a.txt");
    mockCanPreview.mockReturnValue(true);
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 14,
      }),
    );
    const singleItems = mockShowContextMenu.mock.calls.at(-1)?.[2] as Array<{
      label?: string;
      action?: string;
    }>;
    expect(singleItems.some((item) => item.label === "Preview")).toBe(true);

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file-a.txt");
    state.selectedKeys.add("docs/file-b.txt");
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 18,
        clientY: 19,
      }),
    );
    const multiItems = mockShowContextMenu.mock.calls.at(-1)?.[2] as Array<{
      label?: string;
      action?: string;
    }>;
    expect(
      multiItems.some((item) => item.label === "Properties (2 items)"),
    ).toBe(true);
    expect(multiItems.some((item) => item.label === "Download 2 items")).toBe(
      true,
    );
  });

  it("covers validation and guard paths for connect/bookmark/upload/create", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    (document.getElementById("conn-endpoint") as HTMLInputElement).value = "";
    (document.getElementById("conn-access-key") as HTMLInputElement).value = "";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value = "";
    (document.getElementById("connect-btn") as HTMLButtonElement).click();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("required");

    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "ftp://not-http";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "ak";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "sk";
    (document.getElementById("connect-btn") as HTMLButtonElement).click();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("http:// or https://");

    (document.getElementById("conn-endpoint") as HTMLInputElement).value = "";
    (document.getElementById("conn-access-key") as HTMLInputElement).value = "";
    (document.getElementById("bookmark-save-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Fill in endpoint");

    state.connected = false;
    state.currentBucket = "";
    (document.getElementById("btn-upload") as HTMLButtonElement).click();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Connect to a bucket first.");
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Connect to a bucket first.");
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Connect to a bucket first.");

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "";
    mockShowPrompt
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("bad/name");
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("cannot be empty");
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("cannot contain");
  });

  it("covers bucket/object context menus, sidebar controls, and drag-drop paths", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    const bucketList = document.getElementById(
      "bucket-list",
    ) as HTMLUListElement;
    bucketList.innerHTML =
      '<li><button class="list__item-btn" data-bucket="bucket-a">bucket-a</button></li>';
    const bucketBtn = bucketList.querySelector(
      ".list__item-btn",
    ) as HTMLButtonElement;
    bucketBtn.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 30,
      }),
    );
    let ctx = mockShowContextMenu.mock.calls.at(-1);
    let onBucketAction = ctx?.[3] as ((action: string) => void) | undefined;
    if (onBucketAction) {
      onBucketAction("copy-bucket-name");
      onBucketAction("refresh-buckets");
      onBucketAction("open-bucket");
      await flushMicrotasks();
    }
    expect(clipboardWriteText).toHaveBeenCalledWith("bucket-a");
    expect(mockRefreshBuckets).toHaveBeenCalled();
    expect(mockSelectBucket).toHaveBeenCalledWith("bucket-a");

    const bucketPanel = document.getElementById(
      "bucket-panel",
    ) as HTMLDivElement;
    bucketPanel.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 5,
        clientY: 8,
      }),
    );
    ctx = mockShowContextMenu.mock.calls.at(-1);
    const onPanelAction = ctx?.[3] as (() => void) | undefined;
    if (onPanelAction) {
      onPanelAction();
      await flushMicrotasks();
    }
    expect(mockRefreshBuckets).toHaveBeenCalled();

    const objectPanel = document.getElementById(
      "object-panel",
    ) as HTMLDivElement;
    const breadcrumb = document.getElementById("breadcrumb") as HTMLElement;
    breadcrumb.innerHTML =
      '<button type="button" class="breadcrumb__segment" data-prefix="docs/ctx/"></button>';
    const breadcrumbSeg = breadcrumb.querySelector(
      ".breadcrumb__segment",
    ) as HTMLButtonElement;
    breadcrumbSeg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/ctx/");
    const breadcrumbCallCount = mockNavigateToFolder.mock.calls.length;
    breadcrumb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigateToFolder.mock.calls.length).toBe(breadcrumbCallCount);

    const selectAll = document.getElementById("select-all") as HTMLInputElement;
    selectAll.checked = true;
    selectAll.dispatchEvent(new Event("change", { bubbles: true }));
    expect(mockHandleSelectAll).toHaveBeenCalledWith(true);

    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    objectPanel.dispatchEvent(dragOver);
    expect(dragOver.defaultPrevented).toBe(true);

    objectPanel.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 11,
        clientY: 12,
      }),
    );
    ctx = mockShowContextMenu.mock.calls.at(-1);
    const onObjectPanelAction = ctx?.[3] as
      | ((action: string) => void)
      | undefined;
    if (onObjectPanelAction) {
      mockShowPrompt.mockResolvedValueOnce("from-context");
      onObjectPanelAction("new-folder");
      onObjectPanelAction("upload-files");
      onObjectPanelAction("upload-folder");
      onObjectPanelAction("refresh");
      await flushMicrotasks(6);
    }
    expect(mockInvoke).toHaveBeenCalledWith("create_folder", {
      bucket: "bucket-a",
      key: "docs/from-context",
    });
    expect(mockEnqueuePaths).toHaveBeenCalled();
    expect(mockEnqueueFolderEntries).toHaveBeenCalled();
    expect(mockRefreshObjects).toHaveBeenCalledWith("bucket-a", "docs/");

    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML =
      '<tr class="object-row object-row--folder" data-prefix="docs/ctx/"><td>ctx</td></tr>';
    const folderRow = tbody.querySelector(".object-row--folder") as HTMLElement;
    folderRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 15,
        clientY: 16,
      }),
    );
    ctx = mockShowContextMenu.mock.calls.at(-1);
    const onFolderAction = ctx?.[3] as ((action: string) => void) | undefined;
    if (onFolderAction) {
      onFolderAction("open-folder");
      await flushMicrotasks();
    }
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/ctx/");

    const overlay = document.getElementById(
      "drop-zone-overlay",
    ) as HTMLDivElement;
    expect(capturedDragDropHandler).toBeTruthy();
    capturedDragDropHandler!({
      payload: {
        type: "enter",
        paths: ["/tmp/overlay.txt"],
        position: { x: 0, y: 0 },
      },
    });
    expect(overlay.hidden).toBe(false);

    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["/tmp/overlay.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks();
    expect(mockEnqueueFolderEntries).toHaveBeenCalled();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Dropped 1 item(s). Queued 1 file(s) for upload.");
    expect(overlay.hidden).toBe(true);

    capturedDragDropHandler!({
      payload: {
        type: "enter",
        paths: ["/tmp/a.txt"],
        position: { x: 0, y: 0 },
      },
    });
    capturedDragDropHandler!({ payload: { type: "leave" } });
    expect(overlay.hidden).toBe(true);

    state.connected = false;
    state.currentBucket = "";
    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["/tmp/a.txt"],
        position: { x: 0, y: 0 },
      },
    });
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Connect to a bucket first.");

    state.connected = true;
    state.currentBucket = "bucket-a";
    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["C:\\tmp\\a.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks();
    expect(mockEnqueueFolderEntries).toHaveBeenCalled();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Dropped 1 item(s). Queued 1 file(s) for upload.");

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_local_files_recursive") {
        throw new Error("scan failed");
      }
      return undefined;
    });
    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["C:\\tmp\\a.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks();
    expect(mockEnqueuePaths).toHaveBeenCalledWith(["C:\\tmp\\a.txt"], "docs/");
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Dropped 1 file(s). Queued for upload.");

    const sidebar = document.getElementById("bucket-panel") as HTMLElement;
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
      width: 220,
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    } as DOMRect);

    (document.getElementById("sidebar-toggle") as HTMLButtonElement).click();
    expect(
      (
        document.getElementById("main-layout") as HTMLDivElement
      ).classList.contains("main-layout--sidebar-open"),
    ).toBe(true);
    (document.getElementById("sidebar-backdrop") as HTMLButtonElement).click();
    expect(
      (
        document.getElementById("main-layout") as HTMLDivElement
      ).classList.contains("main-layout--sidebar-open"),
    ).toBe(false);

    const resizer = document.getElementById(
      "sidebar-resizer",
    ) as HTMLDivElement;
    resizer.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 100 }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 140 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(
      window.localStorage.getItem("s3-sidekick.sidebar.width"),
    ).toBeTruthy();
  });

  it("handles transfer init and bucket interaction failure branches", async () => {
    const { state } = await import("../state.ts");
    mockInitTransferQueueUI.mockRejectedValueOnce(
      new Error("queue init failed"),
    );
    await import("../main.ts");
    await flushMicrotasks(4);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining("Transfer queue events unavailable"),
      "warning",
    );

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "";

    const bucketList = document.getElementById(
      "bucket-list",
    ) as HTMLUListElement;
    bucketList.innerHTML =
      '<li><button class="list__item-btn" data-bucket="bucket-a">bucket-a</button></li>';
    const bucketBtn = bucketList.querySelector(
      ".list__item-btn",
    ) as HTMLButtonElement;

    mockSelectBucket.mockRejectedValueOnce(new Error("open bucket failed"));
    bucketBtn.click();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain('Failed to open bucket "bucket-a"');
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining('Failed to open bucket "bucket-a"'),
      "error",
    );

    clipboardWriteText.mockRejectedValueOnce(new Error("clipboard blocked"));
    bucketBtn.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 40,
      }),
    );
    const ctx = mockShowContextMenu.mock.calls.at(-1);
    const onBucketAction = ctx?.[3] as ((action: string) => void) | undefined;
    onBucketAction?.("copy-bucket-name");
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to copy bucket name");
  });

  it("handles sort-trigger clicks and successful bucket open mobile-close path", async () => {
    await import("../main.ts");
    await flushMicrotasks();

    const sortTriggers =
      document.querySelectorAll<HTMLElement>(".sort-trigger");
    expect(sortTriggers.length).toBeGreaterThan(0);
    sortTriggers[0].click();
    expect(mockToggleSort).toHaveBeenCalled();

    setupMatchMedia(true);
    const layout = document.getElementById("main-layout") as HTMLDivElement;
    layout.classList.add("main-layout--sidebar-open");

    const bucketList = document.getElementById(
      "bucket-list",
    ) as HTMLUListElement;
    bucketList.innerHTML =
      '<li><button class="list__item-btn" data-bucket="bucket-mobile">bucket-mobile</button></li>';
    (bucketList.querySelector(".list__item-btn") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(mockSelectBucket).toHaveBeenCalledWith("bucket-mobile");
    expect(layout.classList.contains("main-layout--sidebar-open")).toBe(false);
  });

  it("queues dropped paths via Tauri events and refreshes after upload completion", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["/home/user/local.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks();
    expect(mockEnqueueFolderEntries).toHaveBeenCalled();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Dropped 1 item(s). Queued 1 file(s) for upload.");

    const transferHandler = mockSetTransferCompleteHandler.mock
      .calls[0]?.[0] as
      | ((summary: { hadUpload: boolean }) => Promise<void>)
      | undefined;
    expect(transferHandler).toBeTruthy();

    await transferHandler?.({ hadUpload: false });
    expect(mockRefreshObjects).not.toHaveBeenCalledWith("bucket-a", "docs/");

    await transferHandler?.({ hadUpload: true });
    expect(mockRefreshObjects).toHaveBeenCalledWith("bucket-a", "docs/");
    expect(mockPruneStaleSelection).toHaveBeenCalled();
    expect(mockRenderObjectTable).toHaveBeenCalled();
  });

  it("handles settings/info tab interactions, wrapper button handlers, and unload cleanup", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file-a.txt");
    state.selectedKeys.add("docs/file-b.txt");

    const settingsBookmarks = document.querySelector(
      '[data-settings-tab="bookmarks"]',
    ) as HTMLButtonElement;
    settingsBookmarks.click();
    expect(mockSwitchSettingsTab).toHaveBeenCalledWith("bookmarks");

    const settingsGeneral = document.querySelector(
      '[data-settings-tab="general"]',
    ) as HTMLButtonElement;
    settingsGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(mockSwitchSettingsTab).toHaveBeenCalled();
    settingsGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    settingsGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    settingsGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    const settingsCallCount = mockSwitchSettingsTab.mock.calls.length;
    settingsGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(mockSwitchSettingsTab.mock.calls.length).toBe(settingsCallCount);

    const settingsTabs = document.querySelector(
      ".settings-tabs",
    ) as HTMLElement;
    const straySettingsTab = document.createElement("button");
    straySettingsTab.setAttribute("role", "tab");
    settingsTabs.appendChild(straySettingsTab);
    straySettingsTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(mockSwitchSettingsTab.mock.calls.length).toBe(settingsCallCount);

    const infoPermissions = document.querySelector(
      '[data-tab="permissions"]',
    ) as HTMLButtonElement;
    infoPermissions.click();
    expect(mockSwitchTab).toHaveBeenCalledWith("permissions");

    const infoGeneral = document.querySelector(
      '[data-tab="general"]',
    ) as HTMLButtonElement;
    infoGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(mockSwitchTab).toHaveBeenCalled();
    infoGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    infoGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    infoGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    const infoCallCount = mockSwitchTab.mock.calls.length;
    infoGeneral.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", bubbles: true }),
    );
    expect(mockSwitchTab.mock.calls.length).toBe(infoCallCount);

    const infoTabs = document.querySelector(".info-tabs") as HTMLElement;
    const strayInfoTab = document.createElement("button");
    strayInfoTab.setAttribute("role", "tab");
    infoTabs.appendChild(strayInfoTab);
    strayInfoTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(mockSwitchTab.mock.calls.length).toBe(infoCallCount);

    (document.getElementById("batch-copy-urls") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockInvoke).toHaveBeenCalledWith("build_object_url", {
      bucket: "bucket-a",
      key: "docs/file-a.txt",
    });
    expect(clipboardWriteText).toHaveBeenCalled();

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file-a.txt");
    (document.getElementById("batch-download") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(mockEnqueueDownloads).toHaveBeenCalled();

    (document.getElementById("batch-delete") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_objects",
      expect.objectContaining({ bucket: "bucket-a" }),
    );

    (document.getElementById("batch-deselect") as HTMLButtonElement).click();
    expect(mockClearSelection).toHaveBeenCalled();

    mockGetActiveTab.mockReturnValueOnce("activity");
    (document.getElementById("drawer-clear") as HTMLButtonElement).click();
    expect(mockClearActivityLog).toHaveBeenCalled();
    mockGetActiveTab.mockReturnValueOnce("transfers");
    (document.getElementById("drawer-clear") as HTMLButtonElement).click();
    expect(mockClearCompletedTransfers).toHaveBeenCalled();

    (document.getElementById("security-toggle") as HTMLButtonElement).click();
    (
      document.getElementById("security-change-password") as HTMLButtonElement
    ).click();
    (document.getElementById("security-lock-btn") as HTMLButtonElement).click();
    (
      document.getElementById("security-lock-timeout") as HTMLSelectElement
    ).dispatchEvent(new Event("change", { bubbles: true }));
    (document.getElementById("biometric-toggle") as HTMLButtonElement).click();
    expect(mockHandleSecurityToggle).toHaveBeenCalled();
    expect(mockHandleSecurityChangePassword).toHaveBeenCalled();
    expect(mockHandleLockNow).toHaveBeenCalled();
    expect(mockHandleLockTimeoutChange).toHaveBeenCalled();
    expect(mockHandleBiometricToggle).toHaveBeenCalled();

    document
      .getElementById("nav-back")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .getElementById("nav-forward")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockNavigateBack).toHaveBeenCalled();
    expect(mockNavigateForward).toHaveBeenCalled();

    const app = document.getElementById("app") as HTMLElement & {
      inert?: boolean;
    };
    Object.defineProperty(app, "inert", {
      value: false,
      writable: true,
      configurable: true,
    });
    (document.getElementById("settings-btn") as HTMLButtonElement).focus();
    const settingsOverlay = document.getElementById(
      "settings-overlay",
    ) as HTMLDivElement;
    settingsOverlay.classList.add("active");
    await flushMicrotasks(4);
    expect(document.body.classList.contains("modal-open")).toBe(true);
    expect(mockHideContextMenu).toHaveBeenCalled();
    expect(app.getAttribute("aria-hidden")).toBe("true");

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    settingsOverlay.classList.remove("active");
    await flushMicrotasks(4);
    expect(document.body.classList.contains("modal-open")).toBe(false);

    const filterInput = document.getElementById(
      "filter-input",
    ) as HTMLInputElement;
    filterInput.value = "cleanup";
    filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    window.dispatchEvent(new Event("beforeunload"));
    await flushMicrotasks();
    expect(mockDisposeTransferQueueUI).toHaveBeenCalled();
  });

  it("executes registered command actions and availability predicates", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    const commands = mockRegisterCommands.mock.calls[0]?.[0] as
      | Array<{
          id: string;
          action: () => void;
          available?: () => boolean;
        }>
      | undefined;
    expect(commands).toBeTruthy();
    const getCommand = (id: string) => {
      const found = commands?.find((command) => command.id === id);
      expect(found).toBeTruthy();
      return found!;
    };

    state.connected = false;
    state.currentPrefix = "";
    state.selectedKeys.clear();
    expect(getCommand("upload-files").available?.()).toBe(false);
    expect(getCommand("upload-folder").available?.()).toBe(false);
    expect(getCommand("create-folder").available?.()).toBe(false);
    expect(getCommand("refresh").available?.()).toBe(false);
    expect(getCommand("download").available?.()).toBe(false);
    expect(getCommand("delete").available?.()).toBe(false);
    expect(getCommand("select-all").available?.()).toBe(false);
    expect(getCommand("deselect-all").available?.()).toBe(false);
    expect(getCommand("filter").available?.()).toBe(false);
    expect(getCommand("go-up").available?.()).toBe(false);

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file-a.txt");
    state.selectedKeys.add("docs/file-b.txt");
    mockGetSelectableKeys.mockReturnValue([
      "docs/file-a.txt",
      "docs/file-b.txt",
    ]);
    expect(getCommand("upload-files").available?.()).toBe(true);
    expect(getCommand("upload-folder").available?.()).toBe(true);
    expect(getCommand("create-folder").available?.()).toBe(true);
    expect(getCommand("refresh").available?.()).toBe(true);
    expect(getCommand("download").available?.()).toBe(true);
    expect(getCommand("delete").available?.()).toBe(true);
    expect(getCommand("select-all").available?.()).toBe(true);
    expect(getCommand("deselect-all").available?.()).toBe(true);
    expect(getCommand("filter").available?.()).toBe(true);
    expect(getCommand("go-up").available?.()).toBe(true);
    state.selectedKeys.clear();
    expect(getCommand("deselect-all").available?.()).toBe(false);
    state.selectedKeys.add("docs/file-a.txt");
    state.selectedKeys.add("docs/file-b.txt");

    const filterInput = document.getElementById(
      "filter-input",
    ) as HTMLInputElement;
    const focusSpy = vi
      .spyOn(filterInput, "focus")
      .mockImplementation(() => undefined);
    mockShowPrompt.mockResolvedValueOnce("cmd-folder");

    getCommand("upload-files").action();
    getCommand("upload-folder").action();
    getCommand("create-folder").action();
    getCommand("refresh").action();
    getCommand("download").action();
    getCommand("delete").action();
    getCommand("select-all").action();
    getCommand("deselect-all").action();
    getCommand("filter").action();
    getCommand("activity").action();
    getCommand("settings").action();
    getCommand("go-up").action();
    await flushMicrotasks(10);

    expect(mockEnqueuePaths).toHaveBeenCalled();
    expect(mockEnqueueFolderEntries).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("create_folder", {
      bucket: "bucket-a",
      key: "docs/cmd-folder",
    });
    expect(mockRefreshObjects).toHaveBeenCalledWith("bucket-a", "docs/");
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_objects",
      expect.objectContaining({ bucket: "bucket-a" }),
    );
    expect(mockUpdateSelectionUI).toHaveBeenCalled();
    expect(mockClearSelection).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
    expect(mockToggleActivityLog).toHaveBeenCalled();
    expect(mockOpenSettingsModal).toHaveBeenCalled();
    expect(mockNavigateUp).toHaveBeenCalled();
  });

  it("covers additional action guard and error branches", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML = `
      <tr class="object-row" data-key="docs/file.txt" tabindex="0">
        <td class="col-name">file.txt</td>
      </tr>
    `;
    const row = tbody.querySelector(".object-row") as HTMLElement;

    const baseInvoke = mockInvoke.getMockImplementation();
    let failDelete = false;
    let failRename = false;
    let failCreateFolder = false;
    let failPresigned = false;
    let listMode: "normal" | "empty" | "throw" = "normal";
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "delete_objects" && failDelete) {
        throw new Error("delete failed");
      }
      if (cmd === "rename_object" && failRename) {
        throw new Error("rename failed");
      }
      if (cmd === "create_folder" && failCreateFolder) {
        throw new Error("create folder failed");
      }
      if (cmd === "generate_presigned_url" && failPresigned) {
        throw new Error("presigned failed");
      }
      if (cmd === "list_local_files_recursive") {
        if (listMode === "throw") throw new Error("scan failed");
        if (listMode === "empty") return [];
      }
      if (baseInvoke) return baseInvoke(cmd, payload);
      return undefined;
    });

    mockRefreshBuckets.mockImplementationOnce(async () => {
      state.buckets = [{ name: "first-bucket", creation_date: "" }];
    });
    mockSaveConnection.mockRejectedValueOnce(new Error("save creds failed"));
    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://service.example.com";
    (document.getElementById("conn-region") as HTMLInputElement).value =
      "us-east-1";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "ak";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "sk";
    (document.getElementById("connect-btn") as HTMLButtonElement).click();
    await flushMicrotasks(6);
    expect(mockSelectBucket).toHaveBeenCalledWith("first-bucket");
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("credentials not saved");

    mockConnect.mockRejectedValueOnce(new Error("connect failed"));
    (document.getElementById("connect-btn") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Connection failed");

    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://alpha.example.com/path";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "ak";
    mockAddBookmark.mockResolvedValueOnce(true);
    (document.getElementById("bookmark-save-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockAddBookmark).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "alpha" }),
    );

    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "not-a-url:9000/path";
    mockAddBookmark.mockResolvedValueOnce(false);
    (document.getElementById("bookmark-save-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("already exists");

    mockAddBookmark.mockRejectedValueOnce(new Error("bookmark failed"));
    (document.getElementById("bookmark-save-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to save bookmark");

    state.selectedKeys.clear();
    const saveBeforeNoSelection = mockSave.mock.calls.length;
    (document.getElementById("batch-download") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockSave.mock.calls.length).toBe(saveBeforeNoSelection);

    state.selectedKeys.add("docs/file.txt");
    mockSave.mockResolvedValueOnce(null);
    const enqueueBeforeSingleNull = mockEnqueueDownloads.mock.calls.length;
    (document.getElementById("batch-download") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(mockEnqueueDownloads.mock.calls.length).toBe(
      enqueueBeforeSingleNull,
    );

    state.selectedKeys.add("other/file.txt");
    mockOpen.mockImplementationOnce(async () => "C:\\tmp\\downloads");
    (document.getElementById("batch-download") as HTMLButtonElement).click();
    await flushMicrotasks(8);
    const uniqueEntries = mockEnqueueDownloads.mock.calls.at(-1)?.[0] as Array<{
      destination: string;
    }>;
    expect(uniqueEntries.length).toBe(2);
    expect(
      uniqueEntries.some((entry) => entry.destination.endsWith("\\file.txt")),
    ).toBe(true);
    expect(
      uniqueEntries.some((entry) =>
        entry.destination.endsWith("\\file (2).txt"),
      ),
    ).toBe(true);

    state.selectedKeys.clear();
    const clipBeforeNoSelection = clipboardWriteText.mock.calls.length;
    (document.getElementById("batch-copy-urls") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(clipboardWriteText.mock.calls.length).toBe(clipBeforeNoSelection);

    state.selectedKeys.add("docs/file.txt");
    state.selectedKeys.add("other/file.txt");
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 31,
      }),
    );
    let onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("copy-presigned-url");
    await flushMicrotasks(3);

    clipboardWriteText.mockRejectedValueOnce(new Error("clipboard blocked"));
    (document.getElementById("batch-copy-urls") as HTMLButtonElement).click();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to copy URL");

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.currentSettings.presignedUrlExpiration = 120;
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 32,
        clientY: 33,
      }),
    );
    onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("copy-presigned-url");
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("2 minutes");

    state.currentSettings.presignedUrlExpiration = 172800;
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 34,
        clientY: 35,
      }),
    );
    onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("copy-presigned-url");
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("2 days");

    failPresigned = true;
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 36,
        clientY: 37,
      }),
    );
    onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("copy-presigned-url");
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to create pre-signed URL");
    failPresigned = false;

    const renameInvokeCount = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "rename_object",
    ).length;
    mockShowPrompt.mockResolvedValueOnce("file.txt");
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 38,
        clientY: 39,
      }),
    );
    onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("rename");
    await flushMicrotasks(4);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "rename_object").length,
    ).toBe(renameInvokeCount);

    failRename = true;
    mockShowPrompt.mockResolvedValueOnce("renamed-file.txt");
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 41,
      }),
    );
    onAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onAction?.("rename");
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Rename failed");
    failRename = false;

    state.selectedKeys.clear();
    state.selectedKeys.add("prefix:docs/folder/");
    (document.getElementById("batch-delete") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Folder deletion is not supported");

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    const deleteCountBeforeConfirmCancel = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "delete_objects",
    ).length;
    mockShowConfirm.mockResolvedValueOnce(false);
    (document.getElementById("batch-delete") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "delete_objects").length,
    ).toBe(deleteCountBeforeConfirmCancel);

    failDelete = true;
    mockShowConfirm.mockResolvedValueOnce(true);
    (document.getElementById("batch-delete") as HTMLButtonElement).click();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Delete failed");
    failDelete = false;

    mockShowPrompt.mockResolvedValueOnce(null);
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    failCreateFolder = true;
    mockShowPrompt.mockResolvedValueOnce("will-fail");
    (document.getElementById("btn-new-folder") as HTMLButtonElement).click();
    await flushMicrotasks(4);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to create folder");
    failCreateFolder = false;

    mockOpen.mockResolvedValueOnce(null);
    (document.getElementById("btn-upload") as HTMLButtonElement).click();
    await flushMicrotasks();
    mockOpen.mockResolvedValueOnce(null);
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    mockOpen.mockResolvedValueOnce([42] as unknown as string[]);
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    listMode = "empty";
    mockOpen.mockResolvedValueOnce(["C:\\tmp\\folder"]);
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("contain no files");
    listMode = "throw";
    mockOpen.mockResolvedValueOnce(["C:\\tmp\\folder"]);
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Folder upload failed");
  });

  it("covers additional table, context-menu, and layout guard branches", async () => {
    const { state } = await import("../state.ts");
    setupMatchMedia(true);
    await import("../main.ts");
    await flushMicrotasks();

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    const bucketList = document.getElementById(
      "bucket-list",
    ) as HTMLUListElement;
    const bucketClickCalls = mockSelectBucket.mock.calls.length;
    bucketList.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockSelectBucket.mock.calls.length).toBe(bucketClickCalls);

    const bucketPanel = document.getElementById(
      "bucket-panel",
    ) as HTMLDivElement;
    bucketPanel.innerHTML =
      '<button class="list__item-btn" data-bucket="bucket-ctx">bucket-ctx</button>';
    state.connected = false;
    const ctxBeforeDisconnected = mockShowContextMenu.mock.calls.length;
    (
      bucketPanel.querySelector(".list__item-btn") as HTMLButtonElement
    ).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 13,
      }),
    );
    expect(mockShowContextMenu.mock.calls.length).toBe(ctxBeforeDisconnected);

    state.connected = true;
    mockSelectBucket.mockRejectedValueOnce(new Error("ctx open failed"));
    (
      bucketPanel.querySelector(".list__item-btn") as HTMLButtonElement
    ).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 14,
        clientY: 15,
      }),
    );
    let onBucketAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onBucketAction?.("open-bucket");
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain('Failed to open bucket "bucket-ctx"');

    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML = "";
    tbody.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    tbody.innerHTML = `
      <tr class="object-row object-row--folder" data-prefix="docs/folder/" tabindex="0">
        <td class="col-name">folder</td>
      </tr>
      <tr class="object-row" tabindex="0">
        <td class="col-check"><input class="row-check" type="checkbox" /></td>
        <td class="col-name">missing-key</td>
      </tr>
    `;
    const folderRow = tbody.querySelector(".object-row--folder") as HTMLElement;
    const keylessRow = tbody.querySelectorAll<HTMLElement>(".object-row")[1];
    const rowCheck = keylessRow.querySelector(".row-check") as HTMLInputElement;

    const rowClickCalls = mockHandleRowClick.mock.calls.length;
    rowCheck.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockHandleRowClick.mock.calls.length).toBe(rowClickCalls);

    tbody.dispatchEvent(new Event("change", { bubbles: true }));
    const detachedCheck = document.createElement("input");
    detachedCheck.className = "row-check";
    detachedCheck.dispatchEvent(new Event("change", { bubbles: true }));
    keylessRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    keylessRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    tbody.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    rowCheck.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    tbody.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    keylessRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    state.selectedKeys.clear();
    state.selectedKeys.add("prefix:docs/folder/");
    state.selectedKeys.add("prefix:docs/other/");
    const menuBeforeNoItems = mockShowContextMenu.mock.calls.length;
    folderRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 16,
        clientY: 17,
      }),
    );
    expect(mockShowContextMenu.mock.calls.length).toBe(menuBeforeNoItems);

    tbody.innerHTML = `
      <tr class="object-row" data-key="docs/preview.txt" tabindex="0">
        <td class="col-name">preview.txt</td>
      </tr>
    `;
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/preview.txt");
    const previewRow = tbody.querySelector(".object-row") as HTMLElement;
    previewRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 18,
        clientY: 19,
      }),
    );
    const onObjectAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    onObjectAction?.("preview");
    await flushMicrotasks();
    expect(mockOpenPreview).toHaveBeenCalledWith("docs/preview.txt");

    const resizer = document.getElementById(
      "sidebar-resizer",
    ) as HTMLDivElement;
    resizer.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 80,
      }),
    );
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    setupMatchMedia(false);
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );

    const layout = document.getElementById("main-layout");
    const backdrop = document.getElementById("sidebar-backdrop");
    layout?.remove();
    backdrop?.remove();
    window.dispatchEvent(new Event("resize"));
    (
      document.getElementById("sidebar-toggle") as HTMLButtonElement | null
    )?.click();
  });

  it("covers additional support prompt early-return branches", async () => {
    vi.useFakeTimers();
    mockIsSupportPromptDismissed.mockReturnValue(true);
    await import("../main.ts");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);
    expect(
      (document.getElementById("support-overlay") as HTMLDivElement).hidden,
    ).toBe(true);
    vi.useRealTimers();

    vi.resetModules();
    mountIndexFixture();
    setupMatchMedia(false);
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockIsSupportPromptDismissed.mockReturnValue(false);
    await import("../main.ts");
    await flushMicrotasks();
    const supportOverlay = document.getElementById("support-overlay");
    supportOverlay?.querySelector("#support-yes")?.remove();
    await vi.advanceTimersByTimeAsync(1600);
    expect(
      (document.getElementById("support-overlay") as HTMLDivElement).hidden,
    ).toBe(true);
    vi.useRealTimers();

    vi.resetModules();
    mountIndexFixture();
    setupMatchMedia(false);
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockIsSupportPromptDismissed.mockReturnValue(false);
    await import("../main.ts");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);
    const overlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    expect(overlay.hidden).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(overlay.hidden).toBe(false);
    vi.useRealTimers();
  });

  it("handles support prompt dismiss flows and persistence failures", async () => {
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockMarkSupportPromptDismissed.mockRejectedValueOnce(
      new Error("persist failed"),
    );
    await import("../main.ts");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1600);
    const overlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    const noBtn = document.getElementById("support-no") as HTMLButtonElement;
    expect(overlay.hidden).toBe(false);

    noBtn.click();
    await flushMicrotasks(4);
    expect(overlay.hidden).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledWith(
      "Failed to save support prompt preference.",
      "warning",
    );

    vi.useRealTimers();
  });

  it("suppresses support prompt when a dialog is active", async () => {
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockIsDialogActive.mockReturnValue(true);
    await import("../main.ts");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1600);
    const overlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    expect(overlay.hidden).toBe(true);
    expect(mockMarkSupportPromptDismissed).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("opens support URL when support prompt confirm is clicked", async () => {
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockMarkSupportPromptDismissed.mockResolvedValue(undefined);
    await import("../main.ts");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1600);
    const yesBtn = document.getElementById("support-yes") as HTMLButtonElement;
    yesBtn.click();
    await flushMicrotasks(4);
    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://rosie.run/support",
    });
    vi.useRealTimers();
  });

  it("closes support prompt when clicking the overlay backdrop", async () => {
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    mockMarkSupportPromptDismissed.mockResolvedValue(undefined);
    await import("../main.ts");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1600);
    const overlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    expect(overlay.hidden).toBe(false);

    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushMicrotasks(4);
    expect(overlay.hidden).toBe(true);
    expect(mockMarkSupportPromptDismissed).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("closes support prompt when Escape is pressed", async () => {
    vi.useFakeTimers();
    mockIncrementLaunchCount.mockResolvedValue(2);
    await import("../main.ts");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1600);
    const overlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    expect(overlay.hidden).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(overlay.hidden).toBe(true);
    vi.useRealTimers();
  });

  it("logs warning when support prompt checks throw", async () => {
    mockIsSupportPromptDismissed.mockImplementation(() => {
      throw new Error("support check failed");
    });
    await import("../main.ts");
    await flushMicrotasks();

    expect(mockLogActivity).toHaveBeenCalledWith(
      "Support prompt unavailable this launch.",
      "warning",
    );
  });

  it("covers init warning/error branches and top-level init catch", async () => {
    mockEnsureSecurityReady.mockResolvedValue(false);
    await import("../main.ts");
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Secure storage is locked");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.stringContaining("Secure storage is locked"),
      "warning",
    );

    vi.resetModules();
    mountIndexFixture();
    setupMatchMedia(false);
    mockLoadSettings.mockRejectedValue(new Error("settings failed"));
    mockEnsureSecurityReady.mockResolvedValue(true);
    await import("../main.ts");
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to load settings");
    mockLoadSettings.mockReset();

    vi.resetModules();
    mountIndexFixture();
    setupMatchMedia(false);
    mockLoadSettings.mockResolvedValue(undefined);
    mockLoadBookmarks.mockRejectedValueOnce(new Error("bookmark fail"));
    mockLoadConnection.mockRejectedValueOnce(new Error("connection fail"));
    await import("../main.ts");
    await flushMicrotasks();
    expect(mockLogActivity).toHaveBeenCalledWith(
      "Failed to load bookmarks.",
      "warning",
    );
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Failed to load saved connection");

    vi.resetModules();
    mountIndexFixture();
    setupMatchMedia(false);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "get_platform_info") throw new Error("platform fail");
      return undefined;
    });
    await import("../main.ts");
    await flushMicrotasks(6);
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("Initialization error:");
  });

  it("covers additional modal focus trap, tab keyboard, and disconnected/drop guard branches", async () => {
    const { state } = await import("../state.ts");
    await import("../main.ts");
    await flushMicrotasks();

    const noOverlayTab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(noOverlayTab);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay active";
    const first = document.createElement("button");
    first.textContent = "first";
    const last = document.createElement("button");
    last.textContent = "last";
    overlay.append(first, last);
    document.body.appendChild(overlay);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockImplementation(function (this: HTMLElement) {
        if (this === first || this === last) {
          return [{ width: 1, height: 1 }] as unknown as DOMRectList;
        }
        return [] as unknown as DOMRectList;
      });

    (document.getElementById("connect-btn") as HTMLButtonElement).focus();
    const toFirst = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(toFirst);
    expect(document.activeElement).toBe(first);
    expect(toFirst.defaultPrevented).toBe(true);

    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(last);
    last.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(first);
    rectSpy.mockRestore();

    const settingsTabs = document.querySelector(
      ".settings-tabs",
    ) as HTMLElement;
    settingsTabs.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    const firstSettingsTab = document.querySelector(
      ".settings-tab",
    ) as HTMLButtonElement;
    firstSettingsTab.focus();
    firstSettingsTab.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }),
    );
    document.querySelectorAll(".settings-tab").forEach((tab) => tab.remove());
    settingsTabs.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }),
    );

    state.connected = false;
    state.currentBucket = "";
    state.currentPrefix = "";
    const refreshObjectsBefore = mockRefreshObjects.mock.calls.length;
    (document.getElementById("btn-refresh") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockRefreshObjects.mock.calls.length).toBe(refreshObjectsBefore);

    const openDialogBefore = mockOpen.mock.calls.length;
    (document.getElementById("btn-upload") as HTMLButtonElement).click();
    (document.getElementById("btn-upload-folder") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(mockOpen.mock.calls.length).toBe(openDialogBefore);

    const filterInput = document.getElementById(
      "filter-input",
    ) as HTMLInputElement;
    filterInput.value = "pending";
    filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    (document.getElementById("disconnect-btn") as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(filterInput.value).toBe("");

    state.connected = true;
    const bucketPanel = document.getElementById(
      "bucket-panel",
    ) as HTMLDivElement;
    bucketPanel.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 9,
        clientY: 10,
      }),
    );
    const onBucketAction = mockShowContextMenu.mock.calls.at(-1)?.[3] as
      | ((action: string) => void)
      | undefined;
    const refreshBucketsBefore = mockRefreshBuckets.mock.calls.length;
    state.connected = false;
    onBucketAction?.("refresh-buckets");
    await flushMicrotasks();
    expect(mockRefreshBuckets.mock.calls.length).toBe(refreshBucketsBefore);

    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    capturedDragDropHandler!({
      payload: { type: "drop", paths: [], position: { x: 0, y: 0 } },
    });
    await flushMicrotasks();
    expect(
      (document.getElementById("status") as HTMLSpanElement).textContent,
    ).toContain("No dropped files detected.");

    const baseInvoke = mockInvoke.getMockImplementation();
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "list_local_files_recursive") return [];
      if (baseInvoke) return baseInvoke(cmd, payload);
      return undefined;
    });
    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["C:\\tmp\\dropped.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks(6);
    expect(mockEnqueuePaths).toHaveBeenCalledWith(
      ["C:\\tmp\\dropped.txt"],
      "docs/",
    );

    capturedDragDropHandler!({
      payload: {
        type: "drop",
        paths: ["/home/user/from-tauri.txt"],
        position: { x: 0, y: 0 },
      },
    });
    await flushMicrotasks(6);
    expect(mockEnqueuePaths).toHaveBeenCalledWith(
      ["/home/user/from-tauri.txt"],
      "docs/",
    );

    const tbody = document.getElementById(
      "object-tbody",
    ) as HTMLTableSectionElement;
    tbody.innerHTML = `
      <tr class="object-row object-row--folder" data-prefix="docs/folder/" tabindex="0">
        <td class="col-check"><input class="row-check" type="checkbox" /></td>
      </tr>
    `;
    const looseCheck = document.createElement("input");
    looseCheck.className = "row-check";
    tbody.appendChild(looseCheck);
    looseCheck.dispatchEvent(new Event("change", { bubbles: true }));

    state.selectedKeys.clear();
    const folderCheck = tbody.querySelector(
      ".object-row .row-check",
    ) as HTMLInputElement;
    folderCheck.checked = true;
    folderCheck.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.selectedKeys.has("prefix:docs/folder/")).toBe(true);

    const folderRow = tbody.querySelector(".object-row") as HTMLElement;
    folderRow.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(state.selectedKeys.has("prefix:docs/folder/")).toBe(false);

    const resizer = document.getElementById(
      "sidebar-resizer",
    ) as HTMLDivElement;
    resizer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    document.getElementById("main-layout")?.remove();
    (
      document.getElementById("sidebar-toggle") as HTMLButtonElement | null
    )?.click();
  });

  it("covers init guards for missing bookmark bar and sidebar resizer", async () => {
    document.getElementById("bookmark-bar")?.remove();
    document.getElementById("sidebar-resizer")?.remove();

    await import("../main.ts");
    await flushMicrotasks();

    const onBookmarkChanged = mockSetBookmarkChangeHandler.mock.calls.at(
      -1,
    )?.[0] as (() => void) | undefined;
    expect(() => onBookmarkChanged?.()).not.toThrow();
  });

  it("applies platform class and shortcut chips for macOS", async () => {
    const baseInvoke = mockInvoke.getMockImplementation();
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "get_platform_info") return "macos";
      if (baseInvoke) return baseInvoke(cmd, payload);
      return undefined;
    });

    await import("../main.ts");
    await flushMicrotasks();

    expect(document.body.getAttribute("data-platform")).toBe("macos");
    expect(document.body.classList.contains("platform-macos")).toBe(true);
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>(".shortcut-chip"),
    ).map((chip) => chip.textContent ?? "");
    expect(chips.some((text) => text.startsWith("⌘"))).toBe(true);
  });
});
