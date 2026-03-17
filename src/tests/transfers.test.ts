import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="transfer-toggle" hidden>
      <span id="transfer-badge" style="display:none"></span>
    </button>
    <div id="transfer-overlay" class="transfer-popup" hidden>
      <div class="transfer-popup__header">
        <span>Transfers</span>
        <div class="transfer-popup__actions">
          <button id="transfer-collapse" aria-expanded="true">&#9660;</button>
          <button id="transfer-clear">Clear done</button>
          <button id="transfer-close">&#10005;</button>
        </div>
      </div>
      <div id="transfer-list" class="transfer-list"></div>
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
    const overlay = document.getElementById(
      "transfer-overlay",
    ) as HTMLDivElement;
    const clearButton = document.getElementById(
      "transfer-clear",
    ) as HTMLButtonElement;

    expect(toggle.hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    expect(clearButton.disabled).toBe(true);
  });

  it("shows transfer controls after enqueueing files", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\photo.png"], "uploads/");

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;
    const overlay = document.getElementById(
      "transfer-overlay",
    ) as HTMLDivElement;
    const list = document.getElementById("transfer-list") as HTMLDivElement;

    expect(toggle.hidden).toBe(false);
    expect(overlay.hidden).toBe(false);
    expect(list.textContent).toContain("photo.png");
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        key: "uploads/photo.png",
      }),
    );
  });

  it("hides transfer controls after completed history is cleared", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\archive.zip"], "uploads/");
    await flushMicrotasks();

    const clearButton = document.getElementById(
      "transfer-clear",
    ) as HTMLButtonElement;
    expect(clearButton.disabled).toBe(false);

    transfers.clearCompletedTransfers();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;
    const overlay = document.getElementById(
      "transfer-overlay",
    ) as HTMLDivElement;

    expect(toggle.hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    expect(clearButton.disabled).toBe(true);
  });

  it("toggles collapsed state for the transfer popup", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\notes.txt"], "uploads/");

    const overlay = document.getElementById(
      "transfer-overlay",
    ) as HTMLDivElement;
    const collapseButton = document.getElementById(
      "transfer-collapse",
    ) as HTMLButtonElement;

    expect(overlay.classList.contains("transfer-popup--collapsed")).toBe(false);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    transfers.toggleTransferCollapsed();

    expect(overlay.classList.contains("transfer-popup--collapsed")).toBe(true);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("false");

    transfers.toggleTransferCollapsed();

    expect(overlay.classList.contains("transfer-popup--collapsed")).toBe(false);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
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
