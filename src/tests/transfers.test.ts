import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();
const TEST_RECOVERY_SESSION = "a".repeat(64);
const TEST_SOURCE_FINGERPRINT = "1".repeat(64);
const TEST_SOURCE_ACL_FINGERPRINT = "2".repeat(64);
const TEST_SOURCE_TAG_FINGERPRINT = "3".repeat(64);
const TEST_DESTINATION_FINGERPRINT = "4".repeat(64);
const TEST_DESTINATION_ACL_FINGERPRINT = "5".repeat(64);
const TEST_DESTINATION_TAG_FINGERPRINT = "6".repeat(64);
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
    if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
    if (cmd === "transfer_checkpoint_gc") return 0;
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

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
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
          requireImmutableSourceVersion: false,
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

    await vi.waitFor(() => {
      expect(
        (document.getElementById("activity-list") as HTMLDivElement)
          .textContent,
      ).toContain("Downloaded readme.txt");
    });
    await flushMicrotasks(4);
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
    const parsed = JSON.parse(raw ?? "{}") as {
      version?: unknown;
      items?: unknown[];
    };
    expect(parsed.version).toBe(6);
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
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
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
    await transfers.recoverPendingTransfers();
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
    expect(payload.recoverySession).toBe(TEST_RECOVERY_SESSION);
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
        hadListingChange: true,
        uploadCount: 1,
        downloadCount: 0,
        copyCount: 0,
        moveCount: 0,
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
        hadListingChange: false,
        uploadCount: 0,
        downloadCount: 1,
        copyCount: 0,
        moveCount: 0,
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
        hadListingChange: false,
        uploadCount: 0,
        downloadCount: 0,
        copyCount: 0,
        moveCount: 0,
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
        bytes_base64: "aGVsbG8=",
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
    await transfers.recoverPendingTransfers();

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
    expect(mockInvoke).toHaveBeenCalledWith("transfer_checkpoint_remove", {
      checkpointId: expect.any(String),
      recoverySession: TEST_RECOVERY_SESSION,
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
    await transfers.recoverPendingTransfers();

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
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(
          ([cmd, payload]) =>
            cmd === "save_transfer_manifest" &&
            typeof payload === "object" &&
            payload !== null &&
            String((payload as { json?: unknown }).json).includes(
              "retain-me.txt",
            ),
        ),
      ).toBe(true);
    });
    const manifestSave = [...mockInvoke.mock.calls]
      .reverse()
      .find(
        ([cmd, payload]) =>
          cmd === "save_transfer_manifest" &&
          typeof payload === "object" &&
          payload !== null &&
          String((payload as { json?: unknown }).json).includes(
            "retain-me.txt",
          ),
      );
    expect(manifestSave?.[1]).toEqual(
      expect.objectContaining({ recoverySession: TEST_RECOVERY_SESSION }),
    );
    const manifest = JSON.parse(
      String(
        (manifestSave?.[1] as { json?: unknown } | undefined)?.json ?? "{}",
      ),
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

    // Folder entries carry their stat'ed size, but the backend returns the
    // stat'ed file size as a u64 so verification adopts it: return 2 while
    // the queued entry starts at 1, so a missing totalBytes update would
    // fail verification (expected 1, found 2).
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "object_exists" || cmd === "path_exists") return false;
      if (cmd === "upload_object") return 2;
      if (cmd === "download_object") return 1234;
      if (cmd === "head_object") {
        const key =
          payload &&
          typeof payload === "object" &&
          "key" in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).key)
            : "";
        if (key.endsWith("nested/a.txt")) return { content_length: 2 };
        return { content_length: 0 };
      }
      return undefined;
    });
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
    expect(mockInvoke).toHaveBeenCalledWith(
      "upload_object",
      expect.objectContaining({ key: "pref/nested/a.txt" }),
    );
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
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
      source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
      source_version_id: "source-version-1",
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
      destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
      destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
      expect.objectContaining({
        transferId: expect.any(Number),
        requireImmutableSourceVersion: false,
      }),
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
    expect(mockInvoke.mock.calls[markerSaveIndex]?.[1]).toEqual(
      expect.objectContaining({ recoverySession: TEST_RECOVERY_SESSION }),
    );
    const markerPayload = mockInvoke.mock.calls[markerSaveIndex]?.[1] as {
      json: string;
    };
    const markerManifest = JSON.parse(markerPayload.json) as {
      version: number;
      items: Array<{ receipts?: Array<Record<string, unknown>> }>;
    };
    expect(markerManifest.version).toBe(6);
    expect(markerManifest.items[0]?.receipts?.[0]).toEqual(
      expect.objectContaining({
        source_fingerprint: TEST_SOURCE_FINGERPRINT,
        source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
        source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
        destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
        destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
        destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      }),
    );
    expect(deleteIndex).toBeGreaterThan(markerSaveIndex);
  });

  it("refuses malformed fresh receipts before persistence or deletion", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const malformedReceipt = {
      source_key: "source/file.txt",
      source_etag: '"source-etag"',
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
      source_version_id: "source-version-1",
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
      destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
      destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "copy_object_to") return malformedReceipt;
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
        sourceKey: malformedReceipt.source_key,
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: malformedReceipt.destination_key,
      },
    ]);

    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("incomplete source/destination safety fingerprints");
    });
    expect(
      mockInvoke.mock.calls.some(
        ([cmd, payload]) =>
          cmd === "save_transfer_manifest" &&
          typeof payload === "object" &&
          payload !== null &&
          String((payload as { json?: unknown }).json).includes(
            '"movePhase":"copied"',
          ),
      ),
    ).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.anything(),
    );
  });

  it("surfaces move versioning preflight refusal without persisting copied authority", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "copy_object_to") {
        throw new Error(
          "Automatic move requires object versioning; no destination was changed.",
        );
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
        sourceKey: "source/file.txt",
        fileName: "file.txt",
        destinationBucket: "destination-bucket",
        destinationKey: "archive/file.txt",
      },
    ]);

    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("requires object versioning");
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "copy_object_to",
      expect.objectContaining({ requireImmutableSourceVersion: false }),
    );
    expect(
      mockInvoke.mock.calls.some(
        ([cmd, payload]) =>
          cmd === "save_transfer_manifest" &&
          typeof payload === "object" &&
          payload !== null &&
          String((payload as { json?: unknown }).json).includes(
            '"movePhase":"copied"',
          ),
      ),
    ).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.anything(),
    );
  });

  it("keeps the bound session for source deletion after a mid-move reconnect", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    const receipt = {
      source_key: "source/file.txt",
      source_etag: '"source-etag"',
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
      source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
      source_version_id: "source-version-1",
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
      destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
      destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
      requireImmutableSourceVersion: false,
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
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
      source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
      source_version_id: "source-version-1",
      destination_key: "archive/folder/file.txt",
      destination_etag: '"destination-etag"',
      destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
      destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
      destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
      source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
      source_version_id: "source-version-1",
      destination_key: "archive/file.txt",
      destination_etag: '"destination-etag"',
      destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
      destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
      destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
      destination_version_id: null,
    };

    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
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
        throw new Error(
          "Transfer recovery session is stale or missing; reload the application.",
        );
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
      ).toContain("reload the application");
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

describe("transfer recovery ownership", () => {
  const recoveredDownload = (
    version: 3 | 4 | 5 | 6,
    withIdentity: boolean,
  ) => ({
    version,
    items: [
      {
        operation: "download",
        bucket: "bucket-a",
        fileName: "recovered.txt",
        filePath: "",
        key: "docs/recovered.txt",
        destination: "C:\\tmp\\recovered.txt",
        size: 5,
        totalBytes: 5,
        attempt: 1,
        maxAttempts: 3,
        conflictResolution: "replace",
        ...(withIdentity
          ? {
              connectionId: "previous-session",
              connectionIdentity: "test-identity",
            }
          : {}),
      },
    ],
  });

  const recoveredReceipt = {
    source_key: "source/recovered.txt",
    source_etag: '"source-old"',
    source_fingerprint: TEST_SOURCE_FINGERPRINT,
    source_acl_fingerprint: TEST_SOURCE_ACL_FINGERPRINT,
    source_tag_fingerprint: TEST_SOURCE_TAG_FINGERPRINT,
    source_version_id: "source-version-1",
    destination_key: "archive/recovered.txt",
    destination_etag: '"destination-old"',
    destination_fingerprint: TEST_DESTINATION_FINGERPRINT,
    destination_acl_fingerprint: TEST_DESTINATION_ACL_FINGERPRINT,
    destination_tag_fingerprint: TEST_DESTINATION_TAG_FINGERPRINT,
    destination_version_id: null,
  };

  const recoveredMove = (version: 1 | 2 | 3 | 4 | 5 | 6, receipt: object) => ({
    version,
    items: [
      {
        operation: "move",
        bucket: "source-bucket",
        fileName: "recovered.txt",
        filePath: "",
        key: recoveredReceipt.source_key,
        sourceBucket: "source-bucket",
        sourceKey: recoveredReceipt.source_key,
        destinationBucket: "destination-bucket",
        destinationKey: recoveredReceipt.destination_key,
        size: 5,
        totalBytes: 5,
        attempt: 1,
        maxAttempts: 1,
        conflictResolution: "replace",
        movePhase: "copied",
        receipts: [receipt],
        connectionId: "previous-session",
        connectionIdentity: "test-identity",
      },
    ],
  });

  it("hydrates while disconnected without running or clearing recovered work", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.connected = false;
    state.connectionId = "";
    state.connectionIdentity = "";
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="dialog-overlay"></div>',
    );
    mockShowConfirm.mockResolvedValue(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        return {
          ...EMPTY_HYDRATION,
          manifest_json: JSON.stringify(recoveredDownload(5, true)),
        };
      }
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "discard_download_scratch") return undefined;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") return 5;
      return undefined;
    });

    await transfers.recoverPendingTransfers();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "download_object",
      expect.anything(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "clear_transfer_manifest",
      expect.anything(),
    );

    state.connected = true;
    state.connectionId = "new-session";
    state.connectionIdentity = "test-identity";
    await transfers.resumeRecoveredTransfersAfterConnect();
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "download_object",
        expect.objectContaining({
          connectionId: "new-session",
          key: "docs/recovered.txt",
        }),
      );
    });
  });

  it.each([1, 2, 3, 4, 5] as const)(
    "drops copied deletion authority from v%s manifests and recopies",
    async (version) => {
      const transfers = await loadTransfersModule();
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="dialog-overlay"></div>',
      );
      mockShowConfirm.mockResolvedValue(true);
      const freshReceipt = {
        ...recoveredReceipt,
        source_etag: '"source-fresh"',
        source_fingerprint: "4".repeat(64),
        source_acl_fingerprint: "5".repeat(64),
        source_tag_fingerprint: "6".repeat(64),
        destination_etag: '"destination-fresh"',
      };
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "load_transfer_manifest") {
          return {
            ...EMPTY_HYDRATION,
            manifest_json: JSON.stringify(
              recoveredMove(version, recoveredReceipt),
            ),
          };
        }
        if (cmd === "transfer_checkpoint_gc") return 0;
        if (cmd === "object_exists") return false;
        if (cmd === "copy_object_to") return freshReceipt;
        if (cmd === "save_transfer_manifest") return undefined;
        if (cmd === "delete_copied_objects") return 1;
        return undefined;
      });

      await transfers.recoverPendingTransfers();
      await vi.waitFor(() => {
        expect(
          mockInvoke.mock.calls.some(
            ([cmd]) => cmd === "delete_copied_objects",
          ),
        ).toBe(true);
      });

      const copyIndex = mockInvoke.mock.calls.findIndex(
        ([cmd]) => cmd === "copy_object_to",
      );
      const deleteIndex = mockInvoke.mock.calls.findIndex(
        ([cmd]) => cmd === "delete_copied_objects",
      );
      expect(copyIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(copyIndex);
      expect(mockInvoke).toHaveBeenCalledWith(
        "delete_copied_objects",
        expect.objectContaining({ receipts: [freshReceipt] }),
      );
    },
  );

  it("resumes a copied move from a complete v6 receipt without recopying", async () => {
    const transfers = await loadTransfersModule();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="dialog-overlay"></div>',
    );
    mockShowConfirm.mockResolvedValue(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        return {
          ...EMPTY_HYDRATION,
          manifest_json: JSON.stringify(recoveredMove(6, recoveredReceipt)),
        };
      }
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "delete_copied_objects") return 1;
      return undefined;
    });

    await transfers.recoverPendingTransfers();
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "delete_copied_objects"),
      ).toBe(true);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "copy_object_to",
      expect.anything(),
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_copied_objects",
      expect.objectContaining({ receipts: [recoveredReceipt] }),
    );
  });

  it.each([
    [
      "missing destination tag fingerprint",
      (({ destination_tag_fingerprint: _missing, ...receipt }) => receipt)(
        recoveredReceipt,
      ),
    ],
    ["empty source version", { ...recoveredReceipt, source_version_id: "" }],
  ] as const)(
    "drops malformed v6 copied authority (%s) before source deletion",
    async (_case, malformedReceipt) => {
      const transfers = await loadTransfersModule();
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="dialog-overlay"></div>',
      );
      mockShowConfirm.mockResolvedValue(true);
      const freshReceipt = {
        ...recoveredReceipt,
        source_etag: '"source-fresh"',
        destination_etag: '"destination-fresh"',
      };
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "load_transfer_manifest") {
          return {
            ...EMPTY_HYDRATION,
            manifest_json: JSON.stringify(recoveredMove(6, malformedReceipt)),
          };
        }
        if (cmd === "transfer_checkpoint_gc") return 0;
        if (cmd === "object_exists") return false;
        if (cmd === "copy_object_to") return freshReceipt;
        if (cmd === "save_transfer_manifest") return undefined;
        if (cmd === "delete_copied_objects") return 1;
        return undefined;
      });

      await transfers.recoverPendingTransfers();
      await vi.waitFor(() => {
        expect(
          mockInvoke.mock.calls.some(
            ([cmd]) => cmd === "delete_copied_objects",
          ),
        ).toBe(true);
      });
      const copyIndex = mockInvoke.mock.calls.findIndex(
        ([cmd]) => cmd === "copy_object_to",
      );
      const deleteIndex = mockInvoke.mock.calls.findIndex(
        ([cmd]) => cmd === "delete_copied_objects",
      );
      expect(copyIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(copyIndex);
      expect(mockInvoke).toHaveBeenCalledWith(
        "delete_copied_objects",
        expect.objectContaining({ receipts: [freshReceipt] }),
      );
    },
  );

  it("requires explicit durable account binding before a beta.4 manifest runs", async () => {
    const transfers = await loadTransfersModule();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="dialog-overlay"></div>',
    );
    mockShowConfirm.mockResolvedValue(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        return {
          ...EMPTY_HYDRATION,
          manifest_json: JSON.stringify(recoveredDownload(3, false)),
        };
      }
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "discard_download_scratch") return undefined;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") return 5;
      return undefined;
    });

    await transfers.recoverPendingTransfers();
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    });
    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
    const bindingSaveIndex = mockInvoke.mock.calls.findIndex(
      ([cmd, payload]) =>
        cmd === "save_transfer_manifest" &&
        typeof payload === "object" &&
        payload !== null &&
        String((payload as { json?: unknown }).json).includes(
          '"connectionIdentity":"test-identity"',
        ),
    );
    const downloadIndex = mockInvoke.mock.calls.findIndex(
      ([cmd]) => cmd === "download_object",
    );
    expect(bindingSaveIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBeGreaterThan(bindingSaveIndex);
  });

  it("keeps terminal failures in the durable manifest", async () => {
    const transfers = await loadTransfersModule();
    await transfers.recoverPendingTransfers();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object") throw new Error("provider unavailable");
      return undefined;
    });

    transfers.enqueuePaths(["C:\\tmp\\failed.txt"], "uploads/");
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(
          ([cmd, payload]) =>
            cmd === "save_transfer_manifest" &&
            typeof payload === "object" &&
            payload !== null &&
            String((payload as { json?: unknown }).json).includes(
              '"failed":true',
            ) &&
            String((payload as { json?: unknown }).json).includes("failed.txt"),
        ),
      ).toBe(true);
    });
  });

  it("retries hydration after a transient failure", async () => {
    const transfers = await loadTransfersModule();
    let loads = 0;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        loads += 1;
        if (loads === 1) throw new Error("vault temporarily locked");
        return EMPTY_HYDRATION;
      }
      if (cmd === "transfer_checkpoint_gc") return 0;
      return undefined;
    });

    transfers.prepareTransferRecovery();
    await expect(transfers.recoverPendingTransfers()).rejects.toThrow(
      "vault temporarily locked",
    );
    await expect(transfers.recoverPendingTransfers()).resolves.toBeUndefined();
    expect(loads).toBe(2);
  });

  it("retains malformed native recovery data instead of clearing it", async () => {
    const transfers = await loadTransfersModule();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") {
        return { ...EMPTY_HYDRATION, manifest_json: "{malformed" };
      }
      return undefined;
    });

    await expect(transfers.recoverPendingTransfers()).rejects.toThrow(
      /malformed or from an unsupported future version/i,
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "clear_transfer_manifest",
      expect.anything(),
    );
  });
});

describe("transfer coverage lift", () => {
  it("scales part concurrency down as active transfers rise", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.downloadParallelThresholdMb = 16;
    state.currentSettings.downloadPartSizeMb = 32;
    state.currentSettings.downloadPartConcurrency = 10;
    state.currentSettings.enableTransferResume = false;

    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 200 * 1024 * 1024 };
      if (cmd === "download_object_parallel") return 200 * 1024 * 1024;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      { bucket: "b", key: "big.bin", destination: "C:\\tmp\\big.bin" },
    ]);
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(
          ([cmd]) => cmd === "download_object_parallel",
        ),
      ).toBe(true);
    });
    const single = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "download_object_parallel",
    )?.[1] as Record<string, unknown>;
    // 1 active: floor(256/32)=8, min(10,8)=8.
    expect(single?.partConcurrency).toBe(8);
    transfers.clearCompletedTransfers();
  });

  it("clamps fleet budget to one slot with ten active transfers", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 10;
    state.currentSettings.downloadParallelThresholdMb = 16;
    state.currentSettings.downloadPartSizeMb = 32;
    state.currentSettings.downloadPartConcurrency = 10;
    state.currentSettings.enableTransferResume = false;

    let release!: (v: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 200 * 1024 * 1024 };
      if (cmd === "download_object_parallel") return gate;
      return undefined;
    });

    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads(
      Array.from({ length: 10 }, (_, i) => ({
        bucket: "b",
        key: `big-${i}.bin`,
        destination: `C:\\tmp\\big-${i}.bin`,
      })),
    );
    await vi.waitFor(() => {
      const calls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "download_object_parallel",
      );
      expect(calls.length).toBe(10);
    });
    const calls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "download_object_parallel",
    );
    for (const [, payload] of calls) {
      // 10 active: floor(256/320)=0 -> clamp 1.
      expect((payload as Record<string, unknown>).partConcurrency).toBe(1);
    }
    release(200 * 1024 * 1024);
    await flushMicrotasks(10);
  });

  it("renders indeterminate progress for small in-flight uploads", async () => {
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
    const small = new File(["hello"], "small-ind.txt", {
      type: "text/plain",
    });
    transfers.enqueueFiles([small], "web/");
    await flushMicrotasks(6);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const list = document.getElementById("transfer-list")!;
    expect(list.innerHTML).toContain("transfer-progress--indeterminate");
    expect(list.innerHTML).not.toContain("transfer-progress__label");
    releaseUpload();
    await flushMicrotasks(6);
  });

  it("adopts backend u64 size for verification", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object") return 777;
      if (cmd === "head_object") {
        const key =
          payload &&
          typeof payload === "object" &&
          "key" in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).key)
            : "";
        if (key.endsWith("adopt.txt")) return { content_length: 777 };
        return { content_length: 0 };
      }
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueFolderEntries(
      [
        {
          file_path: "C:\\tmp\\adopt.txt",
          relative_path: "adopt.txt",
          size: 1,
        },
      ],
      "pref/",
    );
    await vi.waitFor(() => {
      expect(
        (document.getElementById("activity-list") as HTMLDivElement)
          .textContent,
      ).toContain("Uploaded adopt.txt");
    });
    expect(
      (document.getElementById("transfer-list") as HTMLDivElement).textContent,
    ).not.toContain("Verification failed");
  });

  it("base64-encodes browser payloads across chunk boundaries", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "object_exists") return false;
      if (cmd === "upload_object_bytes") return undefined;
      if (cmd === "head_object") return { content_length: 0 };
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    const bytes = new Uint8Array(40000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const file = new File([bytes as unknown as BlobPart], "chunked.bin");
    transfers.enqueueFiles([file], "web/");
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "upload_object_bytes"),
      ).toBe(true);
    });
    const call = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "upload_object_bytes",
    )?.[1] as Record<string, unknown>;
    const encoded = call?.bytes_base64 as string;
    expect(typeof encoded).toBe("string");
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(40000);
    expect(decoded[0]).toBe(0);
    expect(decoded[1234]).toBe(1234 % 251);
  });

  it("discards recovery state on clearCompletedTransfers", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferResume = true;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") throw new Error("forbidden nope");
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      {
        bucket: "b",
        key: "clear-me.txt",
        destination: "C:\\tmp\\clear-me.txt",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("forbidden");
    });
    mockInvoke.mockClear();
    mockInvoke.mockImplementation(async () => undefined);
    transfers.clearCompletedTransfers();
    await flushMicrotasks(4);
    expect(mockInvoke).toHaveBeenCalledWith("discard_download_scratch", {
      destination: "C:\\tmp\\clear-me.txt",
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "transfer_checkpoint_remove",
      expect.objectContaining({
        checkpointId: expect.any(String),
        recoverySession: TEST_RECOVERY_SESSION,
      }),
    );
  });

  it("discards recovery state on clearNonActiveTransfers", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    state.currentSettings.enableTransferResume = true;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") throw new Error("forbidden nope");
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      {
        bucket: "b",
        key: "clear-nonactive.txt",
        destination: "C:\\tmp\\clear-nonactive.txt",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("forbidden");
    });
    mockInvoke.mockClear();
    mockInvoke.mockImplementation(async () => undefined);
    transfers.clearNonActiveTransfers();
    await flushMicrotasks(4);
    expect(mockInvoke).toHaveBeenCalledWith("discard_download_scratch", {
      destination: "C:\\tmp\\clear-nonactive.txt",
    });
  });

  it("parks the queue while offline and resumes when online", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 1;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "download_object") return 5;
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    window.dispatchEvent(new Event("offline"));
    transfers.enqueueDownloads([
      { bucket: "b", key: "offline.txt", destination: "C:\\tmp\\offline.txt" },
    ]);
    await flushMicrotasks(6);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
    ).toBe(false);

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    });
  });

  it("treats unregistered scratch as nothing-to-discard on queued cancel", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 0;
    state.currentSettings.enableTransferResume = true;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "discard_download_scratch")
        throw new Error("unregistered download scratch path");
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      { bucket: "b", key: "queued.txt", destination: "C:\\tmp\\queued.txt" },
    ]);
    await flushMicrotasks(3);
    const row = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((entry) => entry.textContent?.includes("queued.txt"));
    expect(row).toBeTruthy();
    (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Cancelled");
    });
  });

  it("parks queued cancel when scratch discard fails", async () => {
    const transfers = await loadTransfersModule();
    const { state } = await import("../state.ts");
    state.currentSettings.maxConcurrentTransfers = 0;
    state.currentSettings.enableTransferResume = true;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "discard_download_scratch") throw new Error("scratch busy");
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueueDownloads([
      { bucket: "b", key: "parked.txt", destination: "C:\\tmp\\parked.txt" },
    ]);
    await flushMicrotasks(3);
    const row = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((entry) => entry.textContent?.includes("parked.txt"));
    (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("transfer-list") as HTMLDivElement)
          .textContent,
      ).toContain("Cancellation cleanup failed");
    });
  });

  it("surfaces uploading cancel failures without clearing intent", async () => {
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
      if (cmd === "head_object") return { content_length: 0 };
      if (cmd === "upload_object") return gate;
      if (cmd === "cancel_transfer") throw new Error("cancel busy");
      return undefined;
    });
    await transfers.initTransferQueueUI();
    await transfers.recoverPendingTransfers();
    transfers.enqueuePaths(["C:\\tmp\\cancel-fail.txt"], "uploads/");
    await flushMicrotasks(4);
    const row = Array.from(
      document.querySelectorAll<HTMLDivElement>(".transfer-item"),
    ).find((entry) => entry.textContent?.includes("cancel-fail.txt"));
    (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("activity-list") as HTMLDivElement)
          .textContent,
      ).toContain("Could not cancel cancel-fail.txt");
    });
    releaseUpload();
    await flushMicrotasks(6);
  });

  it("retries a transient failure after backoff (fake timers)", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const transfers = await loadTransfersModule();
      const { state } = await import("../state.ts");
      state.currentSettings.maxConcurrentTransfers = 1;
      state.currentSettings.transferRetryAttempts = 1;
      state.currentSettings.transferRetryBaseMs = 1000;
      let attempts = 0;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
        if (cmd === "transfer_checkpoint_gc") return 0;
        if (cmd === "path_exists") return false;
        if (cmd === "head_object") return { content_length: 5 };
        if (cmd === "download_object") {
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return 5;
        }
        return undefined;
      });
      await transfers.initTransferQueueUI();
      await transfers.recoverPendingTransfers();
      transfers.enqueueDownloads([
        { bucket: "b", key: "retry.txt", destination: "C:\\tmp\\retry.txt" },
      ]);
      // Reach the retry_wait backoff.
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toBe(1);
      // Backoff is 1000ms with zero jitter; firing it runs attempt 2.
      await vi.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toBe(2);
      expect(
        mockInvoke.mock.calls.some(([cmd]) => cmd === "download_object"),
      ).toBe(true);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels promptly during backoff without a second attempt", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const transfers = await loadTransfersModule();
      const { state } = await import("../state.ts");
      state.currentSettings.maxConcurrentTransfers = 1;
      state.currentSettings.transferRetryAttempts = 1;
      state.currentSettings.transferRetryBaseMs = 5000;
      let attempts = 0;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
        if (cmd === "transfer_checkpoint_gc") return 0;
        if (cmd === "path_exists") return false;
        if (cmd === "head_object") return { content_length: 5 };
        if (cmd === "download_object") {
          attempts += 1;
          throw new Error("network timeout");
        }
        if (cmd === "cancel_transfer") return undefined;
        if (cmd === "discard_download_scratch") return undefined;
        if (cmd === "transfer_checkpoint_remove") return undefined;
        return undefined;
      });
      await transfers.initTransferQueueUI();
      await transfers.recoverPendingTransfers();
      transfers.enqueueDownloads([
        {
          bucket: "b",
          key: "cancel-backoff.txt",
          destination: "C:\\tmp\\cancel-backoff.txt",
        },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toBe(1);
      // Cancel while the 5s backoff is pending; the 50ms probe wakes early.
      const row = Array.from(
        document.querySelectorAll<HTMLDivElement>(".transfer-item"),
      ).find((entry) => entry.textContent?.includes("cancel-backoff.txt"));
      expect(row).toBeTruthy();
      (row?.querySelector(".transfer-cancel") as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(60);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      // Prompt wake: only 60ms elapsed of a 5000ms backoff, no retry fired.
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toBe(1);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("parks a retry as offline when connectivity drops during backoff", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const transfers = await loadTransfersModule();
      const { state } = await import("../state.ts");
      state.currentSettings.maxConcurrentTransfers = 1;
      state.currentSettings.transferRetryAttempts = 2;
      state.currentSettings.transferRetryBaseMs = 1000;
      let attempts = 0;
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
        if (cmd === "transfer_checkpoint_gc") return 0;
        if (cmd === "path_exists") return false;
        if (cmd === "head_object") return { content_length: 5 };
        if (cmd === "download_object") {
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return 5;
        }
        return undefined;
      });
      await transfers.initTransferQueueUI();
      await transfers.recoverPendingTransfers();
      transfers.enqueueDownloads([
        {
          bucket: "b",
          key: "offline-backoff.txt",
          destination: "C:\\tmp\\offline-backoff.txt",
        },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toBe(1);
      window.dispatchEvent(new Event("offline"));
      await vi.advanceTimersByTimeAsync(1100);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      // Parked offline: backoff elapsed but no second attempt ran.
      expect(attempts).toBe(1);
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(attempts).toBe(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
      window.dispatchEvent(new Event("online"));
    }
  });
});
