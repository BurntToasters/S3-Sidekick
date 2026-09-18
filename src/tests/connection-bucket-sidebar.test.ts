import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn<() => Promise<string>>();
const disconnectMock = vi.fn<() => Promise<boolean>>();
const saveConnectionMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const refreshBucketsMock = vi.fn<() => Promise<void>>();
const refreshObjectsMock =
  vi.fn<(bucket: string, prefix: string) => Promise<boolean>>();
const finishConnectingMock = vi.fn();
const saveBookmarkMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const renderBookmarkBarMock = vi.fn();
const renderBookmarkListMock = vi.fn();
const isEndpointBookmarkedMock = vi.fn(() => false);
const removeBookmarkMock = vi.fn();
const logActivityMock = vi.fn();
const setStatusMock = vi.fn();
const clearFilterInputDebounceMock = vi.fn();
const setSidebarOpenMock = vi.fn();
const setInspectorOpenMock = vi.fn();
const showConfirmMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const recoverPendingTransfersMock = vi.fn<() => Promise<void>>();
const resumeRecoveredTransfersAfterConnectMock = vi.fn<() => Promise<void>>();

vi.mock("../connection.ts", () => ({
  connect: connectMock,
  disconnect: disconnectMock,
  saveConnection: saveConnectionMock,
  refreshBuckets: refreshBucketsMock,
  refreshObjects: refreshObjectsMock,
  currentConnectionGeneration: () => 1,
  finishConnecting: finishConnectingMock,
  MAX_ACCUMULATED_LISTING_ITEMS: 10000,
}));

vi.mock("../bookmarks.ts", () => ({
  addBookmark: saveBookmarkMock,
  renderBookmarkBar: renderBookmarkBarMock,
  isEndpointBookmarked: isEndpointBookmarkedMock,
  renderBookmarkList: renderBookmarkListMock,
  removeBookmark: removeBookmarkMock,
}));

vi.mock("../activity-log.ts", () => ({
  logActivity: logActivityMock,
}));

vi.mock("../app-status.ts", () => ({
  setStatus: setStatusMock,
}));

vi.mock("../app-layout.ts", () => ({
  clearFilterInputDebounce: clearFilterInputDebounceMock,
  setSidebarOpen: setSidebarOpenMock,
}));

vi.mock("../inspector.ts", () => ({
  closeInspectorOnMobile: vi.fn(),
  isInspectorOpen: () => false,
  markInspectorHasContent: vi.fn(),
  setInspectorOpen: setInspectorOpenMock,
  syncInspectorFromSelection: vi.fn(async () => {}),
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: showConfirmMock,
}));

vi.mock("../transfers.ts", () => ({
  recoverPendingTransfers: recoverPendingTransfersMock,
  resumeRecoveredTransfersAfterConnect:
    resumeRecoveredTransfersAfterConnectMock,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <span id="connection-status" class="connection-badge"></span>
    <button id="connect-btn">Connect</button>
    <button id="disconnect-btn" style="display:none">Disconnect</button>
    <div id="main-layout" style="display:none"></div>
    <div id="connection-screen" style="display:flex"></div>
    <div id="bookmark-bar"></div>
    <ul id="conn-saved-list"></ul>
    <select id="conn-provider-preset"></select>
    <input id="conn-endpoint" />
    <input id="conn-region" />
    <input id="conn-access-key" />
    <input id="conn-secret-key" />
    <input id="conn-session-token" />
    <button id="conn-new-btn"></button>
    <button id="bookmark-save-btn"></button>
    <p id="conn-form-error" hidden></p>
    <ul id="bucket-list"></ul>
    <nav id="location-omnibar-browse" class="breadcrumb"></nav>
    <div id="object-panel" style="display:none"></div>
    <div id="empty-state" style="display:none"></div>
    <table><tbody id="object-tbody"></tbody></table>
    <span id="statusbar-count"></span>
    <input id="location-omnibar-edit" />
    <button id="btn-download"></button>
    <button id="nav-back"></button>
    <button id="nav-forward"></button>
    <button id="nav-up"></button>
    <span id="status"></span>
  `;
}

describe("connection bucket sidebar regression", () => {
  let stateRef: typeof import("../state.ts").state;

  beforeEach(async () => {
    vi.resetModules();
    renderFixture();
    localStorage.clear();

    stateRef = (await import("../state.ts")).state;
    stateRef.connected = false;
    stateRef.connecting = false;
    stateRef.endpoint = "";
    stateRef.region = "";
    stateRef.connectionId = "";
    stateRef.connectionIdentity = "";
    stateRef.currentBucket = "";
    stateRef.currentPrefix = "";
    stateRef.buckets = [];
    stateRef.objects = [];
    stateRef.prefixes = [];
    stateRef.bucketFilterText = "";

    connectMock.mockReset().mockImplementation(async () => {
      stateRef.connected = true;
      stateRef.connectionId = "connection-1";
      stateRef.connectionIdentity = "identity-1";
      return "us-east-1";
    });
    disconnectMock.mockReset().mockResolvedValue(true);
    saveConnectionMock.mockReset().mockResolvedValue(undefined);
    refreshBucketsMock.mockReset().mockImplementation(async () => {
      stateRef.buckets = [{ name: "bucket-a", creation_date: "2024-01-01" }];
    });
    refreshObjectsMock.mockReset().mockResolvedValue(true);
    finishConnectingMock.mockReset();
    saveBookmarkMock.mockReset().mockResolvedValue(true);
    renderBookmarkBarMock.mockReset();
    renderBookmarkListMock.mockReset();
    isEndpointBookmarkedMock.mockReset().mockReturnValue(false);
    removeBookmarkMock.mockReset();
    logActivityMock.mockReset();
    setStatusMock.mockReset();
    clearFilterInputDebounceMock.mockReset();
    setSidebarOpenMock.mockReset();
    setInspectorOpenMock.mockReset();
    showConfirmMock.mockReset().mockResolvedValue(true);
    recoverPendingTransfersMock.mockReset().mockResolvedValue(undefined);
    resumeRecoveredTransfersAfterConnectMock
      .mockReset()
      .mockResolvedValue(undefined);

    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://sfo2.digitaloceanspaces.com";
    (document.getElementById("conn-region") as HTMLInputElement).value = "sfo2";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "access";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "secret";
  });

  it.each([
    ["without a saved bucket", null],
    ["with a stale saved bucket", "bucket-that-was-deleted"],
  ])(
    "keeps the returned bucket list visible when connecting %s",
    async (_description, lastBucket) => {
      if (lastBucket)
        localStorage.setItem("s3-sidekick.last-bucket", lastBucket);

      const app = await import("../app-connection.ts");
      await app.handleConnect();

      expect(stateRef.connected).toBe(true);
      expect(stateRef.currentBucket).toBe("");
      expect(
        document.querySelector('.list__item-btn[data-bucket="bucket-a"]'),
      ).not.toBeNull();
      expect(
        (document.getElementById("empty-state") as HTMLDivElement).style
          .display,
      ).toBe("");
      expect(
        (document.getElementById("bucket-list") as HTMLUListElement)
          .textContent,
      ).toContain("bucket-a");
      expect(refreshObjectsMock).not.toHaveBeenCalled();
    },
  );

  it("keeps the connection and bucket sidebar when restoring a saved bucket fails", async () => {
    localStorage.setItem("s3-sidekick.last-bucket", "bucket-a");
    refreshObjectsMock.mockRejectedValueOnce(new Error("listing failed"));

    const app = await import("../app-connection.ts");
    await app.handleConnect();

    expect(stateRef.connected).toBe(true);
    expect(stateRef.currentBucket).toBe("");
    expect(refreshObjectsMock).toHaveBeenCalledWith("bucket-a", "");
    expect(
      document.querySelector('.list__item-btn[data-bucket="bucket-a"]'),
    ).not.toBeNull();
    expect(
      (document.getElementById("empty-state") as HTMLDivElement).style.display,
    ).toBe("");
    expect(setStatusMock).toHaveBeenCalledWith(
      expect.stringContaining('failed to list "bucket-a"'),
      8000,
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.stringContaining('failed to list "bucket-a"'),
      "warning",
    );
  });
});
