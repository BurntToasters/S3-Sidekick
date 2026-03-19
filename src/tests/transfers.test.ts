import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <button id="transfer-toggle" hidden>
      <span id="transfer-badge" style="display:none"></span>
    </button>
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
  const drawer = await import("../bottom-drawer.ts");
  drawer.initDrawer();
  return import("../transfers.ts");
}

async function flushMicrotasks(cycles = 2): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  renderFixture();
});

describe("transfers queue UI", () => {
  it("hides transfer controls when there are no queued or historical items", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;
    const drawer = document.getElementById("bottom-drawer") as HTMLDivElement;

    expect(toggle.hidden).toBe(true);
    expect(drawer.hidden).toBe(true);
  });

  it("shows transfer controls after enqueueing files", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\photo.png"], "uploads/");

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;
    const drawer = document.getElementById("bottom-drawer") as HTMLDivElement;
    const list = document.getElementById("transfer-list") as HTMLDivElement;

    expect(toggle.hidden).toBe(false);
    expect(drawer.hidden).toBe(false);
    expect(list.textContent).toContain("photo.png");
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        key: "uploads/photo.png",
      }),
    );
  });

  it("hides transfer toggle after completed history is cleared", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\archive.zip"], "uploads/");
    await flushMicrotasks();

    transfers.clearCompletedTransfers();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;

    expect(toggle.hidden).toBe(true);
  });

  it("queues downloads and calls download_object", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    mockInvoke.mockResolvedValueOnce(1234);

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/readme.txt",
        destination: "C:\\tmp\\readme.txt",
      },
    ]);
    await flushMicrotasks();

    const list = document.getElementById("transfer-list") as HTMLDivElement;
    expect(list.textContent).toContain("readme.txt");
    expect(mockInvoke).toHaveBeenCalledWith(
      "download_object",
      expect.objectContaining({
        bucket: "bucket-a",
        key: "docs/readme.txt",
        destination: "C:\\tmp\\readme.txt",
      }),
    );
  });

  it("reports completion summary for successful transfer runs", async () => {
    const transfers = await loadTransfersModule();
    const onComplete = vi.fn();
    transfers.setTransferCompleteHandler(onComplete);
    await transfers.initTransferQueueUI();

    mockInvoke.mockResolvedValueOnce(undefined);
    transfers.enqueuePaths(["C:\\tmp\\first.txt"], "uploads/");
    await flushMicrotasks();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenLastCalledWith({
      hadUpload: true,
      hadDownload: false,
    });

    mockInvoke.mockResolvedValueOnce(250);
    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/guide.txt",
        destination: "C:\\tmp\\guide.txt",
      },
    ]);
    await flushMicrotasks();
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith({
      hadUpload: false,
      hadDownload: true,
    });

    mockInvoke.mockRejectedValueOnce(new Error("upload failed"));
    transfers.enqueuePaths(["C:\\tmp\\second.txt"], "uploads/");
    await flushMicrotasks();
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});
