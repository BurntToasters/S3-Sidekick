import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();
const TEST_RECOVERY_SESSION = "a".repeat(64);
const EMPTY_HYDRATION = {
  recovery_session: TEST_RECOVERY_SESSION,
  manifest_json: "",
  legacy_import_allowed: false,
};

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <button id="transfer-toggle">
      <span id="transfer-badge" style="display:none"></span>
    </button>
    <div id="transfer-queue-summary" class="transfer-queue-summary"></div>
    <button id="transfer-more" type="button"></button>
    <button id="transfer-pause-all"></button>
    <button id="transfer-resume-all"></button>
    <div id="bottom-drawer" class="bottom-drawer" hidden>
      <div class="bottom-drawer__resize-handle"></div>
      <div class="bottom-drawer__header">
        <div class="bottom-drawer__tabs">
          <button class="bottom-drawer__tab bottom-drawer__tab--active" id="drawer-tab-activity" role="tab" aria-selected="true" aria-controls="drawer-panel-activity" tabindex="0">Activity <span id="drawer-activity-badge" class="drawer-badge" style="display:none"></span></button>
          <button class="bottom-drawer__tab" id="drawer-tab-transfers" role="tab" aria-selected="false" aria-controls="drawer-panel-transfers" tabindex="-1">Transfers <span id="drawer-transfer-badge" class="drawer-badge" style="display:none"></span></button>
        </div>
        <div class="bottom-drawer__actions">
          <button id="drawer-clear" class="btn btn--ghost btn--sm">Clear</button>
          <button id="drawer-minimize" class="btn btn--icon"></button>
          <button id="drawer-close" class="btn btn--icon"></button>
        </div>
      </div>
      <div class="bottom-drawer__body">
        <div id="drawer-panel-activity" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-activity">
          <div id="activity-list" class="activity-list"></div>
        </div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-transfers" hidden>
          <div id="transfer-list" class="transfer-list"></div>
        </div>
      </div>
    </div>
  `;
}

async function loadTransfersModule() {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: mockInvoke,
  }));
  vi.doMock("@tauri-apps/api/event", () => ({
    listen: mockListen,
  }));
  vi.doMock("../dialogs.ts", () => ({
    showConfirm: mockShowConfirm,
  }));
  const drawer = await import("../bottom-drawer.ts");
  drawer.initDrawer();
  const transfers = await import("../transfers.ts");
  const { state } = await import("../state.ts");
  state.connectionId = "test-connection";
  state.connectionIdentity = "test-identity";
  state.connected = true;
  return transfers;
}

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
    if (cmd === "transfer_checkpoint_gc") return 0;
    if (cmd === "object_exists" || cmd === "path_exists") return false;
    if (cmd === "download_object") return 5;
    if (cmd === "head_object") return { content_length: 5 };
    return undefined;
  });
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  mockShowConfirm.mockReset();
  mockShowConfirm.mockResolvedValue(false);
  localStorage.clear();
  renderFixture();
});

describe("transfers UI shell", () => {
  it("expects summary and overflow elements used by the queue header", () => {
    document.body.innerHTML = `
      <div id="transfer-queue-summary" class="transfer-queue-summary"></div>
      <button id="transfer-more" type="button"></button>
      <button id="transfer-pause-all"></button>
      <button id="transfer-resume-all"></button>
      <div id="transfer-list" class="transfer-list"></div>
      <span id="transfer-badge"></span>
      <span id="drawer-transfer-badge"></span>
    `;
    expect(document.getElementById("transfer-queue-summary")).not.toBeNull();
    expect(document.getElementById("transfer-more")).not.toBeNull();
    expect(document.getElementById("transfer-pause-all")).not.toBeNull();
  });

  it("summarizes active transfers and badges the toggle", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    let release!: (v: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") return gate;
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      { bucket: "b", key: "a.txt", destination: "C:\\tmp\\a.txt" },
    ]);
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      document.getElementById("transfer-queue-summary")?.textContent,
    ).toContain("1 active");
    expect(document.getElementById("transfer-badge")?.textContent).toBe("1");
    release(5);
  });

  it("shows indeterminate bar for small uploads without faking progress", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    let releaseUpload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object_bytes") return gate;
      if (cmd === "head_object") return { content_length: 0 };
      return undefined;
    });
    await transfers.initTransferQueueUI();
    transfers.enqueueFiles(
      [new File(["hi"], "tiny.txt", { type: "text/plain" })],
      "web/",
    );
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "upload_object_bytes"),
      ).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const list = document.getElementById("transfer-list")!;
    expect(list.innerHTML).toContain("transfer-progress--indeterminate");
    releaseUpload();
  });
});
