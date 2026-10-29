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
const readLastBucketMock = vi.fn((): string | null => null);

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
  readLastBucket: readLastBucketMock,
  navigateToFolder: vi.fn(async () => undefined),
}));

vi.mock("../bookmarks.ts", () => ({
  addBookmark: addBookmarkMock,
  clearBookmarks: vi.fn(),
  getBookmarks: vi.fn(() => []),
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
    readLastBucketMock.mockReset().mockReturnValue(null);
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
      "",
    );
  });

  it("supersedes an in-progress connect when switching bookmarks rapidly", async () => {
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

    // The second click is not dropped; its generation supersedes the first.
    expect(connectMock).toHaveBeenCalled();
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

    // While connecting, the same button cancels the attempt.
    const btn = document.getElementById("connect-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Cancel");
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

  it("confirmSessionTeardown resolves true without asking when nothing is active", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.activeTransferCount = 0;

    await expect(app.confirmSessionTeardown("Disconnect")).resolves.toBe(true);
    expect(showConfirmMock).not.toHaveBeenCalled();
  });

  it("confirmSessionTeardown asks with the transfer count and returns the answer", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.activeTransferCount = 2;

    showConfirmMock.mockResolvedValueOnce(false);
    await expect(app.confirmSessionTeardown("Disconnect")).resolves.toBe(false);
    expect(showConfirmMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("2 transfers are still running or queued"),
      expect.objectContaining({ okLabel: "Continue" }),
    );
    expect(showConfirmMock.mock.calls[0][1]).toContain(
      "Disconnect will pause them until you reconnect",
    );

    showConfirmMock.mockResolvedValueOnce(true);
    await expect(app.confirmSessionTeardown("Disconnect")).resolves.toBe(true);
  });

  it("switching connections asks before pausing active transfers and keeps the session when declined", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-live";
    state.activeTransferCount = 1;
    showConfirmMock.mockResolvedValueOnce(false);

    await app.switchToBookmark(
      "beta",
      "https://beta.example.com",
      "us-east-1",
      "AKIA",
      "secret",
    );

    expect(showConfirmMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    state.connected = false;
    state.connectionId = "";
  });

  it("empty submit marks the first missing field invalid and focuses it", async () => {
    const app = await import("../app-connection.ts");
    const endpoint = document.getElementById(
      "conn-endpoint",
    ) as HTMLInputElement;
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "AKIA";

    await app.handleConnect();

    expect(document.activeElement).toBe(endpoint);
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");
    expect(endpoint.getAttribute("aria-describedby")).toBe("conn-form-error");
    expect(
      (
        document.getElementById("conn-access-key") as HTMLInputElement
      ).hasAttribute("aria-invalid"),
    ).toBe(false);
  });

  it("the Connect button cancels a pending connect and tears down its late session", async () => {
    let resolveConnect: ((value: string) => void) | null = null;
    connectMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://alpha.example.com";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "AKIA";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "secret";

    const pending = app.handleConnect();
    await Promise.resolve();
    const btn = document.getElementById("connect-btn") as HTMLButtonElement;
    expect(btn.textContent).toContain("Cancel");

    app.handleConnectButton();
    expect(btn.textContent).toBe("Connect");
    expect(btn.disabled).toBe(false);
    expect(
      (document.getElementById("conn-endpoint") as HTMLInputElement).disabled,
    ).toBe(false);

    // The backend finishes the cancelled connect after the user gave up.
    state.connectionId = "conn-late";
    resolveConnect!("us-east-1");
    await pending;

    expect(disconnectMock).toHaveBeenCalledWith("conn-late");
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(document.getElementById("connection-screen")!.style.display).toBe(
      "flex",
    );
    state.connectionId = "";
  });
});

describe("connect shows the layout before restoring the last bucket", () => {
  beforeEach(async () => {
    vi.resetModules();
    connectMock.mockReset().mockResolvedValue("us-east-1");
    disconnectMock.mockReset().mockResolvedValue(true);
    saveConnectionMock.mockReset().mockResolvedValue(undefined);
    refreshBucketsMock.mockReset().mockResolvedValue(undefined);
    showConfirmMock.mockReset().mockResolvedValue(true);
    readLastBucketMock.mockReset().mockReturnValue("bucket-a");
    selectBucketMock
      .mockReset()
      .mockImplementation(() => new Promise<undefined>(() => undefined));
    const { state } = await import("../state.ts");
    state.connected = false;
    state.connecting = false;
    state.connectionId = "";
    renderFixture();
    (document.getElementById("conn-endpoint") as HTMLInputElement).value =
      "https://alpha.example.com";
    (document.getElementById("conn-access-key") as HTMLInputElement).value =
      "AKIA";
    (document.getElementById("conn-secret-key") as HTMLInputElement).value =
      "secret";
  });

  it("reveals the main layout while the restored listing is still pending", async () => {
    const app = await import("../app-connection.ts");
    const { state } = await import("../state.ts");
    state.buckets = [{ name: "bucket-a", creation_date: "2024-01-01" }];

    void app.handleConnect();

    await vi.waitFor(() => {
      expect(document.getElementById("main-layout")!.style.display).toBe(
        "flex",
      );
    });
    expect(selectBucketMock).toHaveBeenCalledWith("bucket-a");
    expect(document.getElementById("connection-screen")!.style.display).toBe(
      "none",
    );
    expect(showEmptyStateMock).not.toHaveBeenCalled();
  });
});

const MEMORY_STORAGE_KEY = "s3-sidekick.connection-memory";

/**
 * Failure-mode inventory for the per-connection location memory: the key
 * must be name+endpoint only, records must never carry secrets, and every
 * malformed storage state must read as "nothing remembered" instead of
 * throwing or leaking.
 */
describe("connection location memory (pure logic)", () => {
  let app: typeof import("../app-connection.ts");

  beforeEach(async () => {
    vi.resetModules();
    window.localStorage.clear();
    app = await import("../app-connection.ts");
  });

  it("keys memory on the connection name and endpoint only", () => {
    expect(app.connectionMemoryKey("Production", "https://x.example.com")).toBe(
      "Production\nhttps://x.example.com",
    );
    // Same name, different endpoint: a distinct connection.
    expect(app.connectionMemoryKey("a", "https://x")).not.toBe(
      app.connectionMemoryKey("a", "https://y"),
    );
    // Same endpoint, different name: also distinct.
    expect(app.connectionMemoryKey("a", "https://x")).not.toBe(
      app.connectionMemoryKey("b", "https://x"),
    );
  });

  it("round-trips bucket and prefix and never stores credentials", () => {
    app.rememberConnectionLocation(
      "Production",
      "https://x.example.com",
      "bucket-a",
      "docs/",
      1_000,
    );

    const stored = JSON.parse(
      window.localStorage.getItem(MEMORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const record = stored["Production\nhttps://x.example.com"] as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual([
      "bucket",
      "lastUsedAt",
      "prefix",
    ]);
    expect(record.bucket).toBe("bucket-a");
    expect(record.prefix).toBe("docs/");

    expect(
      app.readConnectionLocation("Production", "https://x.example.com"),
    ).toEqual({
      bucket: "bucket-a",
      prefix: "docs/",
      lastUsedAt: 1_000,
    });
  });

  it("returns null for connections that were never remembered", () => {
    expect(app.readConnectionLocation("Ghost", "https://x.example.com")).toBe(
      null,
    );
    expect(app.readConnectionLocation("", "")).toBe(null);
  });

  it("overwrites the previous location for the same connection", () => {
    app.rememberConnectionLocation("a", "https://x", "bucket-1", "", 100);
    app.rememberConnectionLocation("a", "https://x", "bucket-2", "new/", 200);

    expect(app.readConnectionLocation("a", "https://x")).toEqual({
      bucket: "bucket-2",
      prefix: "new/",
      lastUsedAt: 200,
    });
  });

  it("reads nothing when the stored memory is corrupt JSON", () => {
    window.localStorage.setItem(MEMORY_STORAGE_KEY, "not-json{");
    expect(app.readConnectionLocation("a", "https://x")).toBe(null);
  });

  it("rejects memory that is not a key-to-record map", () => {
    window.localStorage.setItem(MEMORY_STORAGE_KEY, "42");
    expect(app.readConnectionLocation("a", "https://x")).toBe(null);
  });

  it("rejects individual records with malformed fields", () => {
    window.localStorage.setItem(
      MEMORY_STORAGE_KEY,
      JSON.stringify({
        "a\nhttps://x": { bucket: 7, prefix: "", lastUsedAt: 5 },
        "b\nhttps://x": { bucket: "ok", prefix: "", lastUsedAt: "soon" },
        "c\nhttps://x": { bucket: "ok", prefix: "", lastUsedAt: NaN },
      }),
    );
    expect(app.readConnectionLocation("a", "https://x")).toBe(null);
    expect(app.readConnectionLocation("b", "https://x")).toBe(null);
    expect(app.readConnectionLocation("c", "https://x")).toBe(null);
  });

  it("survives storage that refuses writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() =>
      app.rememberConnectionLocation("a", "https://x", "bucket-a", "", 5),
    ).not.toThrow();
    vi.restoreAllMocks();
  });

  it("survives storage that refuses reads", () => {
    window.localStorage.setItem(
      MEMORY_STORAGE_KEY,
      JSON.stringify({
        "a\nhttps://x": { bucket: "b", prefix: "", lastUsedAt: 1 },
      }),
    );
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(app.readConnectionLocation("a", "https://x")).toBe(null);
    vi.restoreAllMocks();
  });

  it("forgets a removed connection", () => {
    app.rememberConnectionLocation("a", "https://x", "bucket-a", "", 5);
    app.forgetConnectionLocation("a", "https://x");
    expect(app.readConnectionLocation("a", "https://x")).toBe(null);
  });

  it("picks the most recent remembered connection that still exists", () => {
    app.rememberConnectionLocation("gone", "https://gone", "b", "", 300);
    app.rememberConnectionLocation("kept", "https://kept", "b", "", 100);
    app.rememberConnectionLocation("kept2", "https://kept2", "b", "", 200);

    // "gone" was removed from the saved list, so it is not a candidate.
    expect(
      app.mostRecentRememberedConnection([
        { name: "kept", endpoint: "https://kept" },
        { name: "kept2", endpoint: "https://kept2" },
      ]),
    ).toEqual({ name: "kept2", endpoint: "https://kept2", lastUsedAt: 200 });
  });

  it("returns null when no remembered connection matches a saved one", () => {
    app.rememberConnectionLocation("gone", "https://gone", "b", "", 300);
    expect(app.mostRecentRememberedConnection([])).toBe(null);
    expect(
      app.mostRecentRememberedConnection([
        { name: "x", endpoint: "https://x" },
      ]),
    ).toBe(null);
  });
});

describe("last-used marker label (pure logic)", () => {
  let app: typeof import("../app-connection.ts");

  beforeEach(async () => {
    vi.resetModules();
    app = await import("../app-connection.ts");
  });

  it("labels fresh, recent, and older uses", () => {
    const now = 1_000_000_000;
    expect(app.lastUsedLabel(now - 10_000, now)).toBe("just now");
    expect(app.lastUsedLabel(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(app.lastUsedLabel(now - 90 * 60_000, now)).toBe("1 hr ago");
    expect(app.lastUsedLabel(now - 3 * 3_600_000, now)).toBe("3 hr ago");
    expect(app.lastUsedLabel(now - 86_400_000, now)).toBe("1 day ago");
    expect(app.lastUsedLabel(now - 2 * 86_400_000, now)).toBe("2 days ago");
  });

  it("hides the marker for invalid or stale timestamps", () => {
    const now = 1_000_000_000;
    expect(app.lastUsedLabel(0, now)).toBe(null);
    expect(app.lastUsedLabel(Number.NaN, now)).toBe(null);
    expect(app.lastUsedLabel(now + 120_000, now)).toBe(null);
    expect(app.lastUsedLabel(now - 40 * 86_400_000, now)).toBe(null);
  });
});
