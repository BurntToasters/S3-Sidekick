import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <button id="transfer-toggle">
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
  mockShowConfirm.mockReset();
  mockShowConfirm.mockResolvedValue(false);
  localStorage.clear();
  renderFixture();
});

describe("transfers queue UI", () => {
  it("keeps transfer toggle visible when idle", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;
    const drawer = document.getElementById("bottom-drawer") as HTMLDivElement;

    expect(toggle.hidden).toBe(false);
    expect(toggle.classList.contains("statusbar__transfer--idle")).toBe(true);
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
    const uploadCall = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "upload_object",
    );
    expect(uploadCall).toBeTruthy();
    const uploadPayload = uploadCall?.[1] as Record<string, unknown>;
    expect(uploadPayload).not.toHaveProperty("checkpointId");
    await vi.waitFor(() => {
      expect(list.textContent).not.toContain("photo.png");
    });
  });

  it("serializes unconditional-write consent and applies one batch choice", async () => {
    const promptResolvers: Array<(value: boolean) => void> = [];
    mockShowConfirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          promptResolvers.push(resolve);
        }),
    );
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 3;
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    await transfers.initTransferQueueUI();

    transfers.enqueuePaths(
      ["C:\\tmp\\one.txt", "C:\\tmp\\two.txt", "C:\\tmp\\three.txt"],
      "uploads/",
    );

    await vi.waitFor(() => expect(mockShowConfirm).toHaveBeenCalledTimes(1));
    promptResolvers.shift()?.(true);
    await vi.waitFor(() => expect(mockShowConfirm).toHaveBeenCalledTimes(2));
    expect(mockShowConfirm.mock.calls[1]?.[0]).toBe("Apply Choice");
    promptResolvers.shift()?.(true);

    await vi.waitFor(() => {
      const uploadCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "upload_object",
      );
      expect(uploadCalls).toHaveLength(3);
      for (const [, payload] of uploadCalls) {
        expect(payload).toEqual(expect.objectContaining({ overwrite: true }));
      }
    });
    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
  });

  it("reports declined unconditional writes as cancellations", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    await transfers.initTransferQueueUI();

    transfers.enqueuePaths(["C:\\tmp\\declined.txt"], "uploads/");

    await vi.waitFor(() => expect(mockShowConfirm).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(
        (document.getElementById("activity-list") as HTMLDivElement)
          .textContent,
      ).toContain("unconditional write was not authorized");
    });
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "upload_object")).toBe(
      false,
    );
    expect(
      (document.getElementById("activity-list") as HTMLDivElement).textContent,
    ).not.toContain("destination exists");
  });

  it("rechecks explicit create-only copy intent against provider capability", async () => {
    mockShowConfirm.mockResolvedValueOnce(true);
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    await transfers.initTransferQueueUI();

    transfers.enqueueCopyMoveEntries([
      {
        operation: "copy",
        sourceBucket: "source",
        sourceKey: "old.txt",
        fileName: "old.txt",
        destinationBucket: "destination",
        destinationKey: "new.txt",
        overwrite: false,
        size: 10,
      },
    ]);

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "copy_object_to",
        expect.objectContaining({
          srcKey: "old.txt",
          dstKey: "new.txt",
          overwrite: true,
        }),
      );
    });
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
  });

  it("marks transfer toggle idle after completed history is cleared", async () => {
    const transfers = await loadTransfersModule();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\archive.zip"], "uploads/");
    await flushMicrotasks(8);

    transfers.clearCompletedTransfers();

    const toggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;

    expect(toggle.hidden).toBe(false);
    expect(toggle.classList.contains("statusbar__transfer--idle")).toBe(true);
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

  it("passes checksum verification flag to download and upload commands", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferChecksumVerification = true;
    await transfers.initTransferQueueUI();

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/readme.txt",
        destination: "C:\\tmp\\readme.txt",
      },
    ]);
    await flushMicrotasks(8);
    expect(mockInvoke).toHaveBeenCalledWith(
      "download_object",
      expect.objectContaining({
        key: "docs/readme.txt",
        checksumVerification: true,
      }),
    );

    transfers.clearCompletedTransfers();
    transfers.enqueuePaths(["C:\\tmp\\checksummed.txt"], "uploads/");
    await flushMicrotasks(12);
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({
        key: "uploads/checksummed.txt",
        checksumVerification: true,
      }),
    );
  });

  it("falls back to legacy manifest persistence when backend manifest load is unavailable", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;

    let resolveDownload: (value: number) => void = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        throw new Error("unknown command");
      }
      if (cmd === "transfer_checkpoint_gc") return undefined;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 0 };
      if (cmd === "download_object" || cmd === "download_object_parallel") {
        return new Promise<number>((resolve) => {
          resolveDownload = resolve;
        });
      }
      if (cmd === "cancel_transfer") return undefined;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/persist.txt",
        destination: "C:\\tmp\\persist.txt",
      },
    ]);
    await flushMicrotasks(8);

    const raw = localStorage.getItem("s3-sidekick.transfer-manifest.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? "{}") as { items?: unknown[] };
    expect(Array.isArray(parsed.items)).toBe(true);
    expect((parsed.items ?? []).length).toBeGreaterThan(0);

    resolveDownload(0);
    await flushMicrotasks(8);
  });

  it("does not persist in-flight uploads (they cannot resume part-way)", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;

    let resolveUpload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        throw new Error("unknown command");
      }
      if (cmd === "transfer_checkpoint_gc") return undefined;
      if (cmd === "object_exists") return false;
      if (cmd === "head_object") return { content_length: 0 };
      if (cmd === "upload_object") {
        return new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (cmd === "cancel_transfer") return undefined;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\persist.txt"], "uploads/");
    await flushMicrotasks(8);

    // The upload is now in-flight ("uploading"); it must be excluded from the
    // persisted manifest so an app kill does not offer a misleading resume.
    const raw = localStorage.getItem("s3-sidekick.transfer-manifest.v1");
    expect(raw).toBeFalsy();

    resolveUpload();
    await flushMicrotasks(8);
  });

  it("hides the pause control for in-flight uploads but shows it for downloads", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 2;

    let resolveUpload = () => {};
    let resolveDownload: (value: number) => void = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") throw new Error("unknown command");
      if (cmd === "transfer_checkpoint_gc") return undefined;
      if (cmd === "object_exists") return false;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 0 };
      if (cmd === "upload_object") {
        return new Promise<void>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (cmd === "download_object" || cmd === "download_object_parallel") {
        return new Promise<number>((resolve) => {
          resolveDownload = resolve;
        });
      }
      if (cmd === "cancel_transfer") return undefined;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(["C:\\tmp\\up.txt"], "uploads/");
    transfers.enqueueDownloads([
      { bucket: "b", key: "down.txt", destination: "C:\\tmp\\down.txt" },
    ]);
    await flushMicrotasks(8);

    const list = document.getElementById("transfer-list")!;
    const rows = Array.from(list.querySelectorAll(".transfer-item"));
    expect(rows.length).toBe(2);

    const uploadRow = rows.find((r) =>
      r.textContent?.includes("up.txt"),
    ) as HTMLElement;
    const downloadRow = rows.find((r) =>
      r.textContent?.includes("down.txt"),
    ) as HTMLElement;

    // In-flight upload: no pause control. In-flight download: pause available.
    expect(uploadRow.querySelector(".transfer-pause")).toBeNull();
    expect(downloadRow.querySelector(".transfer-pause")).not.toBeNull();

    resolveUpload();
    resolveDownload(0);
    await flushMicrotasks(8);
  });

  it("uses parallel download without synthetic completed-part indexes", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferResume = true;
    state.currentSettings.downloadParallelThresholdMb = 1;
    state.currentSettings.downloadPartConcurrency = 2;
    state.currentSettings.downloadPartSizeMb = 16;

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") {
        const key =
          payload &&
          typeof payload === "object" &&
          "key" in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).key)
            : "";
        if (key === "docs/big.bin") return { content_length: 5 * 1024 * 1024 };
        return { content_length: 0 };
      }
      if (cmd === "download_object_parallel") return 5 * 1024 * 1024;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/big.bin",
        destination: "C:\\tmp\\big.bin",
      },
    ]);
    await flushMicrotasks(12);

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(
          ([cmd]) => cmd === "download_object_parallel",
        ),
      ).toBe(true);
    });

    const parallelCall = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "download_object_parallel",
    );
    expect(parallelCall).toBeTruthy();
    const payload = parallelCall?.[1] as Record<string, unknown>;
    expect("resumeCompletedParts" in payload).toBe(false);
  });

  it("reports completion summary for successful transfer runs", async () => {
    const transfers = await loadTransfersModule();
    const onComplete = vi.fn();
    transfers.setTransferCompleteHandler(onComplete);
    await transfers.initTransferQueueUI();

    transfers.enqueuePaths(["C:\\tmp\\first.txt"], "uploads/");
    await vi.waitFor(() => {
      expect(onComplete.mock.calls.length).toBe(1);
      expect(onComplete.mock.calls.at(-1)?.[0]).toEqual({
        hadUpload: true,
        hadDownload: false,
        uploadCount: 1,
        downloadCount: 0,
        errorCount: 0,
        skippedCount: 0,
      });
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
    await vi.waitFor(() => {
      expect(onComplete.mock.calls.length).toBe(2);
      expect(onComplete.mock.calls.at(-1)?.[0]).toEqual({
        hadUpload: false,
        hadDownload: true,
        uploadCount: 0,
        downloadCount: 1,
        errorCount: 0,
        skippedCount: 0,
      });
    });

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object") throw new Error("upload failed");
      if (cmd === "head_object") return { content_length: 0 };
      return undefined;
    });
    transfers.enqueuePaths(["C:\\tmp\\second.txt"], "uploads/");
    await flushMicrotasks(20);
    await vi.waitFor(() => {
      expect(onComplete.mock.calls.length).toBe(3);
      expect(onComplete.mock.calls.at(-1)?.[0]).toEqual({
        hadUpload: false,
        hadDownload: false,
        uploadCount: 0,
        downloadCount: 0,
        errorCount: 1,
        skippedCount: 0,
      });
    });
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
    await flushMicrotasks(8);
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Cancelled");
    });
    transfers.clearCompletedTransfers();
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).not.toContain("slow.txt");

    state.currentSettings.maxConcurrentTransfers = 0;
    transfers.enqueuePaths(["C:\\tmp\\queued.txt"], "uploads/");
    await flushMicrotasks(2);
    const queuedRow = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((row) => row.textContent?.includes("queued.txt"));
    expect(queuedRow).toBeTruthy();
    (queuedRow?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Cancelled");
    });
  });

  it("waits for an active download to stop before ordered recovery cleanup", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferResume = true;
    await transfers.initTransferQueueUI();

    const events: string[] = [];
    let stopDownload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists" || cmd === "object_exists") return false;
      if (cmd === "head_object") return { content_length: 1 };
      if (cmd === "download_object") {
        return new Promise<number>((_resolve, reject) => {
          stopDownload = () => {
            events.push("transfer-stopped");
            reject(new Error("Transfer cancelled"));
          };
        });
      }
      if (cmd === "cancel_transfer") {
        events.push("cancel-signal");
        stopDownload();
        return undefined;
      }
      if (cmd === "discard_download_scratch") {
        events.push("scratch-discarded");
        return undefined;
      }
      if (cmd === "transfer_checkpoint_remove") {
        events.push("checkpoint-removed");
        return undefined;
      }
      return undefined;
    });

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/cancel-me.txt",
        destination: "C:\\tmp\\cancel-me.txt",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    });

    const row = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((entry) => entry.textContent?.includes("cancel-me.txt"));
    (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(events).toEqual([
        "cancel-signal",
        "transfer-stopped",
        "scratch-discarded",
        "checkpoint-removed",
      ]);
    });
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).toContain("Cancelled");
  });

  it("retains paused recovery state when cancellation cleanup fails", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferResume = true;
    await transfers.initTransferQueueUI();

    let stopDownload = () => {};
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists" || cmd === "object_exists") return false;
      if (cmd === "head_object") return { content_length: 1 };
      if (cmd === "download_object") {
        return new Promise<number>((_resolve, reject) => {
          stopDownload = () => reject(new Error("Transfer cancelled"));
        });
      }
      if (cmd === "cancel_transfer") {
        stopDownload();
        return undefined;
      }
      if (cmd === "discard_download_scratch") {
        throw new Error("scratch busy");
      }
      return undefined;
    });

    transfers.enqueueDownloads([
      {
        bucket: "bucket-a",
        key: "docs/retain-me.txt",
        destination: "C:\\tmp\\retain-me.txt",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    });
    const row = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((entry) => entry.textContent?.includes("retain-me.txt"));
    (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Cancellation cleanup failed");
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "transfer_checkpoint_remove",
      expect.anything(),
    );
    const manifest = JSON.parse(
      localStorage.getItem("s3-sidekick.transfer-manifest.v1") ?? "{}",
    ) as { items?: Array<{ paused?: boolean; destination?: string }> };
    expect(manifest.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paused: true,
          destination: "C:\\tmp\\retain-me.txt",
        }),
      ]),
    );
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

  it("durably saves copy identities before exact source deletion", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const receipt = {
      source_key: "source/file.txt",
      source_etag: '"source-etag"',
      source_version_id: null,
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "copy_object_to") return receipt;
      if (cmd === "save_transfer_manifest") return undefined;
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "move",
        sourceBucket: "source-bucket",
        sourceKey: receipt.source_key,
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: receipt.destination_key,
      },
    ]);

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "delete_copied_objects"),
      ).toBe(true);
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "copy_object_to",
      expect.objectContaining({ transferId: expect.any(Number) }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("delete_copied_objects", {
      srcBucket: "source-bucket",
      dstBucket: "destination-bucket",
      receipts: [receipt],
      transferId: expect.any(Number),
      connectionId: "test-connection",
    });
    const markerSaveIndex = mockInvoke.mock.calls.findIndex(
      ([cmd, payload]) =>
        cmd === "save_transfer_manifest" &&
        typeof payload === "object" &&
        payload !== null &&
        String((payload as { json?: unknown }).json).includes(
          '"movePhase":"copied"',
        ) &&
        String((payload as { json?: unknown }).json).includes(
          '"destination_etag":"\\"destination-etag\\""',
        ),
    );
    const deleteIndex = mockInvoke.mock.calls.findIndex(
      ([cmd]) => cmd === "delete_copied_objects",
    );
    expect(markerSaveIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(markerSaveIndex);
  });

  it("keeps the bound session for source deletion after a mid-move reconnect", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const receipt = {
      source_key: "source/file.txt",
      source_etag: '"source-etag"',
      source_version_id: null,
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "copy_object_to") {
        state.connectionId = "reconnected-session";
        state.connectionIdentity = "test-identity";
        return receipt;
      }
      if (cmd === "save_transfer_manifest") return undefined;
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "move",
        sourceBucket: "source-bucket",
        sourceKey: receipt.source_key,
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: receipt.destination_key,
      },
    ]);

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "delete_copied_objects"),
      ).toBe(true);
    });

    expect(mockInvoke).toHaveBeenCalledWith("copy_object_to", {
      srcBucket: "source-bucket",
      srcKey: receipt.source_key,
      dstBucket: "destination-bucket",
      dstKey: receipt.destination_key,
      overwrite: false,
      transferId: expect.any(Number),
      connectionId: "test-connection",
    });
    expect(mockInvoke).toHaveBeenCalledWith("delete_copied_objects", {
      srcBucket: "source-bucket",
      dstBucket: "destination-bucket",
      receipts: [receipt],
      transferId: expect.any(Number),
      connectionId: "test-connection",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.objectContaining({ connectionId: "reconnected-session" }),
    );
  });

  it("deletes prefix-move sources using collected copy receipts", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const receipt = {
      source_key: "docs/folder/file.txt",
      source_etag: '"source-etag"',
      source_version_id: null,
      destination_key: "archive/folder/file.txt",
      destination_etag: '"destination-etag"',
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "list_objects") {
        return {
          objects: [],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      if (cmd === "copy_prefix_to") return [receipt];
      if (cmd === "save_transfer_manifest") return undefined;
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "move",
        sourceBucket: "source-bucket",
        sourcePrefix: "docs/folder/",
        fileName: "folder",
        destinationBucket: "destination-bucket",
        destinationPrefix: "archive/folder/",
      },
    ]);

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "delete_copied_objects"),
      ).toBe(true);
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "copy_prefix_to",
      expect.objectContaining({
        srcPrefix: "docs/folder/",
        dstPrefix: "archive/folder/",
        overwrite: false,
        connectionId: "test-connection",
        collectReceipts: true,
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("delete_copied_objects", {
      srcBucket: "source-bucket",
      dstBucket: "destination-bucket",
      receipts: [receipt],
      transferId: expect.any(Number),
      connectionId: "test-connection",
    });
  });

  it("does not delete prefix-move sources when copy returns no receipts", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "list_objects") {
        return {
          objects: [],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      if (cmd === "copy_prefix_to") return [];
      if (cmd === "save_transfer_manifest") return undefined;
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "move",
        sourceBucket: "source-bucket",
        sourcePrefix: "docs/empty/",
        fileName: "empty",
        destinationBucket: "destination-bucket",
        destinationPrefix: "archive/empty/",
      },
    ]);

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "copy_prefix_to"),
      ).toBe(true);
    });
    await flushMicrotasks(8);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.anything(),
    );
  });

  it("refuses queued transfers after reconnecting a different account", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 0;

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "copy_object_to") {
        throw new Error("copy must not run against a different account");
      }
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "copy",
        sourceBucket: "source-bucket",
        sourceKey: "docs/file.txt",
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: "archive/file.txt",
      },
    ]);

    state.connectionId = "other-connection";
    state.connectionIdentity = "other-identity";
    state.currentSettings.maxConcurrentTransfers = 1;
    transfers.enqueueCopyMoveEntries([]);

    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Connection changed");
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "copy_object_to",
      expect.anything(),
    );
  });

  it("refuses source deletion when the durable move marker cannot be saved", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const receipt = {
      source_key: "source/file.txt",
      source_etag: '"source-etag"',
      source_version_id: null,
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "load_transfer_manifest") return "";
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "copy_object_to") return receipt;
      if (
        cmd === "save_transfer_manifest" &&
        typeof payload === "object" &&
        payload !== null &&
        String((payload as { json?: unknown }).json).includes(
          '"movePhase":"copied"',
        )
      ) {
        throw new Error("manifest disk full");
      }
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueCopyMoveEntries([
      {
        operation: "move",
        sourceBucket: "source-bucket",
        sourceKey: receipt.source_key,
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: receipt.destination_key,
      },
    ]);

    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("manifest disk full");
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.anything(),
    );
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

    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(
          ([cmd, payload]) =>
            cmd === "upload_object" &&
            typeof payload === "object" &&
            payload !== null &&
            (payload as { key?: string }).key === "direct/path-backed.txt" &&
            (payload as { filePath?: string }).filePath ===
              "C:\\tmp\\path-backed.txt",
        ),
      ).toBe(true);
    });
  });
});
