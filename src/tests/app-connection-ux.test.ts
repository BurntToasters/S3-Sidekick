import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn(async () => "us-east-1");
const disconnectMock = vi.fn(async () => true);
const saveConnectionMock = vi.fn(async () => undefined);
const refreshBucketsMock = vi.fn(async () => undefined);
const selectBucketMock = vi.fn(async () => undefined);
const renderBucketListMock = vi.fn();
const renderBucketListSkeletonMock = vi.fn();
const showEmptyStateMock = vi.fn();
const clearSelectionMock = vi.fn();
const clearNavHistoryMock = vi.fn();
const addBookmarkMock = vi.fn(async () => true);
const renderBookmarkBarMock = vi.fn();
const isEndpointBookmarkedMock = vi.fn(() => false);
const renderBookmarkListMock = vi.fn();
const removeBookmarkMock = vi.fn(async () => undefined);
const logActivityMock = vi.fn();
const setStatusMock = vi.fn();
const clearFilterInputDebounceMock = vi.fn();
const showConfirmMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("../connection.ts", () => ({
  connect: connectMock,
  disconnect: disconnectMock,
  saveConnection: saveConnectionMock,
  refreshBuckets: refreshBucketsMock,
  currentConnectionGeneration: () => 1,
  finishConnecting: vi.fn(),
}));

vi.mock("../browser.ts", () => ({
  renderBucketList: renderBucketListMock,
  renderBucketListSkeleton: renderBucketListSkeletonMock,
  selectBucket: selectBucketMock,
  showEmptyState: showEmptyStateMock,
  clearSelection: clearSelectionMock,
  clearNavHistory: clearNavHistoryMock,
}));

vi.mock("../bookmarks.ts", () => ({
  addBookmark: addBookmarkMock,
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
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: showConfirmMock,
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
    <input id="conn-endpoint" />
    <input id="conn-region" />
    <input id="conn-access-key" />
    <input id="conn-secret-key" />
    <button id="bookmark-save-btn"></button>
    <p id="conn-form-error" hidden></p>
    <span id="status"></span>
  `;
}

describe("connection UX polish", () => {
  beforeEach(async () => {
    vi.resetModules();
    connectMock.mockReset().mockResolvedValue("us-east-1");
    disconnectMock.mockReset().mockResolvedValue(true);
    saveConnectionMock.mockReset().mockResolvedValue(undefined);
    refreshBucketsMock.mockReset().mockResolvedValue(undefined);
    selectBucketMock.mockReset().mockResolvedValue(undefined);
    renderBucketListMock.mockReset();
    renderBucketListSkeletonMock.mockReset();
    showEmptyStateMock.mockReset();
    clearSelectionMock.mockReset();
    clearNavHistoryMock.mockReset();
    renderBookmarkBarMock.mockReset();
    renderBookmarkListMock.mockReset();
    logActivityMock.mockReset();
    setStatusMock.mockReset();
    clearFilterInputDebounceMock.mockReset();
    showConfirmMock.mockReset().mockResolvedValue(true);
    renderFixture();

    const { state } = await import("../state.ts");
    state.connected = false;
    state.connecting = false;
    state.endpoint = "";
    state.region = "";
    state.buckets = [];
  });

  it("connects immediately when selecting a bookmark while disconnected", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.buckets = [{ name: "bucket-a", creation_date: "2024-01-01" }];

    await app.switchToBookmark(
      "alpha",
      "https://alpha.example.com",
      "us-east-1",
      "AKIA",
      "secret",
    );

    expect(
      (document.getElementById("conn-endpoint") as HTMLInputElement).value,
    ).toBe("https://alpha.example.com");
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(
      "https://alpha.example.com",
      "us-east-1",
      "AKIA",
      "secret",
    );
  });

  it("ignores bookmark selection while a connect is already in progress", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.connecting = true;

    await app.switchToBookmark(
      "alpha",
      "https://alpha.example.com",
      "us-east-1",
      "AKIA",
      "secret",
    );

    expect(connectMock).not.toHaveBeenCalled();
  });

  it("shows inline validation errors on the connection form", async () => {
    const app = await import("../app-connection.ts");

    await app.handleConnect();

    const error = document.getElementById("conn-form-error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("required");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("shows a busy connect button label while connecting", async () => {
    let resolveConnect: ((value: string) => void) | null = null;
    connectMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const app = await import("../app-connection.ts");
    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://alpha.example.com";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "AKIA";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "secret";

    const pending = app.handleConnect();
    await Promise.resolve();

    const btn = document.getElementById("connect-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Connecting");
    expect(btn.querySelector(".spinner")).not.toBeNull();

    resolveConnect!("us-east-1");
    await pending;

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Connect");
  });

  it("requires confirmation for non-local cleartext HTTP", async () => {
    const app = await import("../app-connection.ts");
    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "http://storage.example.com";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "AKIA";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "secret";

    showConfirmMock.mockResolvedValueOnce(false);
    await app.handleConnect();

    expect(showConfirmMock).toHaveBeenCalledWith(
      "Insecure connection",
      expect.stringContaining("storage.example.com"),
      expect.objectContaining({ okDanger: true }),
    );
    expect(connectMock).not.toHaveBeenCalled();
  });
});
