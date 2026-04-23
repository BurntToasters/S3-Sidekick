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
  mockInvoke.mockImplementation(async (cmd, payload) => {
    if (cmd === "object_exists" || cmd === "path_exists") return false;
    if (cmd === "download_object") return 1234;
    if (cmd === "head_object") {
      const key =
        payload &&
        typeof payload === "object" &&
        "key" in (payload as Record<string, unknown>)
          ? String((payload as Record<string, unknown>).key)
          : "";
      if (key.endsWith("small.txt")) return { content_length: 5 };
      if (key.endsWith("progress-upload.txt")) return { content_length: 100 };
      return { content_length: 0 };
    }
    return undefined;
  });
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  localStorage.clear();
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
    await flushMicrotasks(8);
    expect(mockInvoke).toHaveBeenCalledWith(
      "object_exists",
      expect.objectContaining({ key: "uploads/photo.png" }),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        key: "uploads/photo.png",
      }),
    );
    expect(list.textContent).not.toContain("photo.png");
  });

  it("hides transfer toggle after completed history is cleared", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\archive.zip"], "uploads/");
    await flushMicrotasks(8);

    transfers.clearCompletedTransfers();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;

    expect(toggle.hidden).toBe(true);
  });

  it("queues downloads and calls download_object", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/readme.txt",
        destination: "C:\\tmp\\readme.txt",
      },
    ]);
    await flushMicrotasks(8);

    expect(mockInvoke).toHaveBeenCalledWith("path_exists", {
      path: "C:\\tmp\\readme.txt",
    });
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

    transfers.enqueuePaths(["C:\\tmp\\first.txt"], "uploads/");
    await flushMicrotasks(10);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenLastCalledWith({
      hadUpload: true,
      hadDownload: false,
    });

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "download_object") return 250;
      if (cmd === "object_exists") return false;
      if (cmd === "head_object") return { content_length: 0 };
      return undefined;
    });
    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/guide.txt",
        destination: "C:\\tmp\\guide.txt",
      },
    ]);
    await flushMicrotasks(10);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith({
      hadUpload: false,
      hadDownload: true,
    });

    mockInvoke.mockRejectedValueOnce(new Error("upload failed"));
    transfers.enqueuePaths(["C:\\tmp\\second.txt"], "uploads/");
    await flushMicrotasks(10);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("uses browser-file upload fallback and surfaces oversize browser upload errors", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentBucket = "bucket-a";
    await transfers.initTransferQueueUI();

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object_bytes") return undefined;
      if (cmd === "head_object") {
        const key =
          payload &&
          typeof payload === "object" &&
          "key" in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).key)
            : "";
        if (key.endsWith("small.txt")) return { content_length: 5 };
        return { content_length: 0 };
      }
      return undefined;
    });

    const small = new File(["hello"], "small.txt", { type: "text/plain" });
    transfers.enqueueFiles([small], "web/");
    await flushMicrotasks(8);
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object_bytes",
      expect.objectContaining({
        key: "web/small.txt",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    transfers.clearCompletedTransfers();

    const tooLarge = {
      name: "huge.bin",
      size: 17 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(1),
    } as unknown as File;
    transfers.enqueueFiles([tooLarge], "web/");
    await flushMicrotasks(10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const hugeRow = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((row) => row.textContent?.includes("huge.bin"));
    expect(hugeRow).toBeTruthy();
    expect(hugeRow?.textContent).toContain("16MB");
  });

  it("supports canceling uploading and queued transfer rows", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    await transfers.initTransferQueueUI();

    let resolveUpload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "upload_object") {
        return new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (cmd === "cancel_transfer") return undefined;
      return undefined;
    });

    transfers.enqueuePaths(["C:\\tmp\\slow.txt"], "uploads/");
    await flushMicrotasks(4);
    const slowCancel = document.querySelector(
      ".transfer-item .transfer-cancel",
    ) as HTMLButtonElement;
    slowCancel.click();
    await flushMicrotasks(2);
    expect(mockInvoke).toHaveBeenCalledWith(
      "cancel_transfer",
      expect.objectContaining({
        transferId: expect.any(Number),
      }),
    );

    resolveUpload();
    await flushMicrotasks(4);
    transfers.clearCompletedTransfers();

    state.currentSettings.maxConcurrentTransfers = 0;
    transfers.enqueuePaths(["C:\\tmp\\queued.txt"], "uploads/");
    await flushMicrotasks(2);
    const queuedRow = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((row) => row.textContent?.includes("queued.txt"));
    expect(queuedRow).toBeTruthy();
    (queuedRow?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
    await flushMicrotasks(2);
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("Cancelled");
  });

  it("updates progress via transfer events and cleans up listeners on dispose", async () => {
    let uploadProgressCb: (event: { payload: unknown }) => void = () => {};
    let downloadProgressCb: (event: { payload: unknown }) => void = () => {};
    const unlistenUpload = vi.fn(() => undefined);
    const unlistenDownload = vi.fn(() => undefined);
    mockListen.mockImplementation(async (event, callback) => {
      if (event === "upload-progress") {
        uploadProgressCb = callback as (event: { payload: unknown }) => void;
        return unlistenUpload;
      }
      downloadProgressCb = callback as (event: { payload: unknown }) => void;
      return unlistenDownload;
    });

    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 2;
    let resolveUpload = () => {};
    let resolveDownload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "upload_object") {
        return new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (cmd === "download_object") {
        return new Promise<number>((resolve) => {
          resolveDownload = () => resolve(50);
        });
      }
      return undefined;
    });
    await transfers.initTransferQueueUI();

    transfers.enqueuePaths(["C:\\tmp\\progress-upload.txt"], "uploads/");
    await flushMicrotasks(4);
    uploadProgressCb({
      payload: { transfer_id: 1, bytes_sent: 50, total_bytes: 100 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/progress-download.txt",
        destination: "C:\\tmp\\progress-download.txt",
      },
    ]);
    await flushMicrotasks(4);
    downloadProgressCb({
      payload: { transfer_id: 2, bytes_sent: 25, total_bytes: 50 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("50%");

    resolveUpload();
    resolveDownload();
    await flushMicrotasks(4);

    await transfers.disposeTransferQueueUI();
    expect(unlistenUpload).toHaveBeenCalledTimes(1);
    expect(unlistenDownload).toHaveBeenCalledTimes(1);
  });

  it("covers drawer toggle, folder enqueue filtering, and transfer validation errors", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    await transfers.initTransferQueueUI();

    transfers.toggleTransferQueue();
    expect(
      (document.getElementById("bottom-drawer") as HTMLDivElement).hidden,
    ).toBe(false);

    transfers.enqueueFolderEntries(
      [
        {
          file_path: "C:\\tmp\\a.txt",
          relative_path: "/nested/a.txt",
          size: 1,
        },
        { file_path: "C:\\tmp\\skip.txt", relative_path: "", size: 1 },
      ],
      "pref/",
    );
    await flushMicrotasks(8);
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).not.toContain("Verification failed");

    transfers.enqueueDownloads([
      { bucket: "bucket-a", key: "docs/no-destination.txt", destination: "" },
    ]);
    await flushMicrotasks(8);
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("no-destination.txt");
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "download_object",
      expect.objectContaining({ key: "docs/no-destination.txt" }),
    );

    transfers.enqueuePaths([""], "");
    await flushMicrotasks(8);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("No upload source available");
  });

  it("covers empty-queue visibility guard and unknown content-type fallback", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();

    transfers.showTransferQueue();
    expect(
      (document.getElementById("bottom-drawer") as HTMLDivElement).hidden,
    ).toBe(true);

    transfers.enqueuePaths(["C:\\tmp\\noext"], "uploads/");
    await flushMicrotasks(4);
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        filePath: "C:\\tmp\\noext",
        contentType: "application/octet-stream",
      }),
    );
  });

  it("covers cancel-click guard clauses and unknown transfer id cancellation", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    const list = document.getElementById("transfer-list") as HTMLDivElement;

    list.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const detachedCancel = document.createElement("button");
    detachedCancel.className = "transfer-cancel";
    list.appendChild(detachedCancel);
    detachedCancel.click();

    const zeroRow = document.createElement("div");
    zeroRow.className = "transfer-item";
    zeroRow.dataset.id = "0";
    const zeroCancel = document.createElement("button");
    zeroCancel.className = "transfer-cancel";
    zeroRow.appendChild(zeroCancel);
    list.appendChild(zeroRow);
    zeroCancel.click();

    const missingRow = document.createElement("div");
    missingRow.className = "transfer-item";
    missingRow.dataset.id = "999";
    const missingCancel = document.createElement("button");
    missingCancel.className = "transfer-cancel";
    missingRow.appendChild(missingCancel);
    list.appendChild(missingRow);
    missingCancel.click();
    await flushMicrotasks(2);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "cancel_transfer",
      expect.anything(),
    );
  });

  it("covers processing re-entry, requestAnimationFrame fallback, and download filename fallback", async () => {
    let uploadProgressCb: (event: { payload: unknown }) => void = () => {};
    mockListen.mockImplementation(async (event, callback) => {
      if (event === "upload-progress") {
        uploadProgressCb = callback as (event: { payload: unknown }) => void;
      }
      return () => undefined;
    });
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    await transfers.initTransferQueueUI();

    const rafValue = window.requestAnimationFrame;
    Object.defineProperty(window, "requestAnimationFrame", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let resolveUpload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "upload_object") {
        return new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (cmd === "download_object") return 10;
      return undefined;
    });

    transfers.enqueuePaths(["C:\\tmp\\first.txt"], "uploads/");
    transfers.enqueuePaths(["C:\\tmp\\second.txt"], "uploads/");
    uploadProgressCb({
      payload: { transfer_id: 1, bytes_sent: 1, total_bytes: 2 },
    });
    uploadProgressCb({
      payload: { transfer_id: 1, bytes_sent: 2, total_bytes: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    resolveUpload();
    await flushMicrotasks(5);

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/folder/",
        destination: "C:\\tmp\\folder",
      },
    ]);
    await flushMicrotasks(4);
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("docs/folder/");

    Object.defineProperty(window, "requestAnimationFrame", {
      value: rafValue,
      configurable: true,
      writable: true,
    });
  });

  it("handles missing transfer list and safe dispose before initialization", async () => {
    const transfers = await loadTransfersModule();
    await transfers.disposeTransferQueueUI();

    document.getElementById("transfer-list")?.remove();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\headless.txt"], "uploads/");
    await flushMicrotasks(4);

    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        filePath: "C:\\tmp\\headless.txt",
      }),
    );
  });

  it("covers unknown progress events, queued retention on clear, hide no-op, and file.path uploads", async () => {
    let uploadProgressCb: (event: { payload: unknown }) => void = () => {};
    let downloadProgressCb: (event: { payload: unknown }) => void = () => {};
    mockListen.mockImplementation(async (event, callback) => {
      if (event === "upload-progress") {
        uploadProgressCb = callback as (event: { payload: unknown }) => void;
      } else {
        downloadProgressCb = callback as (event: { payload: unknown }) => void;
      }
      return () => undefined;
    });

    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    await transfers.initTransferQueueUI();
    transfers.hideTransferQueue();

    state.currentSettings.maxConcurrentTransfers = 0;
    transfers.enqueuePaths(["C:\\tmp\\queued-only.txt"], "uploads/");
    await flushMicrotasks(3);
    uploadProgressCb({
      payload: { transfer_id: 1, bytes_sent: 0, total_bytes: 0 },
    });
    downloadProgressCb({
      payload: { transfer_id: 1, bytes_sent: 0, total_bytes: 0 },
    });
    uploadProgressCb({
      payload: { transfer_id: 999, bytes_sent: 1, total_bytes: 1 },
    });
    downloadProgressCb({
      payload: { transfer_id: 999, bytes_sent: 1, total_bytes: 1 },
    });
    transfers.clearCompletedTransfers();
    expect(
      (document.getElementById("transfer-toggle") as HTMLButtonElement).hidden,
    ).toBe(false);

    state.currentSettings.maxConcurrentTransfers = 1;
    const pseudoFile = {
      name: "path-backed.txt",
      size: 5,
      path: "C:\\tmp\\path-backed.txt",
      arrayBuffer: async () => new ArrayBuffer(5),
    } as unknown as File;
    transfers.enqueueFiles([pseudoFile], "direct/");
    await flushMicrotasks(12);

    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        key: "direct/path-backed.txt",
        filePath: "C:\\tmp\\path-backed.txt",
      }),
    );
  });
});
