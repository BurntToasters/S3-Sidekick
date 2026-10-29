import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferItem } from "../transfers.ts";
import {
  TRANSFER_TEXT,
  computeQueueAggregates,
  patchTransferRowElement,
  renderTransferRow,
  updateQueueSummary,
} from "../transfer-render.ts";
import { isClaimable, markCancelled } from "../transfer-state.ts";

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

function transferFixture(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 1,
    operation: "copy",
    bucket: "source-bucket",
    fileName: "report.csv",
    filePath: "",
    key: "reports/report.csv",
    sourceBucket: "source-bucket",
    sourceKey: "reports/report.csv",
    destinationBucket: "destination-bucket",
    destinationKey: "archive/report.csv",
    size: 0,
    status: "queued",
    progress: 0,
    totalBytes: 0,
    attempt: 1,
    maxAttempts: 1,
    verified: false,
    conflictResolution: "ask",
    phase: "running",
    speedBps: 0,
    etaSeconds: null,
    paused: false,
    resumable: false,
    completedParts: 0,
    totalParts: 0,
    ...overrides,
  };
}

function renderRow(
  transfers: { renderTransferRow: (item: TransferItem) => string },
  item: TransferItem,
): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = transfers.renderTransferRow(item);
  return template.content.firstElementChild as HTMLElement;
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

  it("keeps terminal copy and move rows static with explicit status text", async () => {
    const transfers = await loadTransfersModule();

    for (const operation of ["copy", "move"] as const) {
      for (const [status, label] of [
        ["done", "Completed"],
        ["error", "Failed"],
        ["skipped", "Skipped"],
      ] as const) {
        const row = renderRow(
          transfers,
          transferFixture({
            id: operation === "copy" ? 10 : 20,
            operation,
            status,
            error:
              status === "error" ? "Destination already exists" : undefined,
          }),
        );
        expect(
          row.querySelector(".transfer-progress-wrap--indeterminate"),
        ).toBeNull();
        expect(row.querySelector("[aria-busy]")).toBeNull();
        expect(row.querySelector(".transfer-phase--status")?.textContent).toBe(
          label,
        );
        expect(row.querySelector(".transfer-cancel")).toBeNull();
      }
    }
  });

  it("animates only active copy and move rows", async () => {
    const transfers = await loadTransfersModule();
    const running = renderRow(
      transfers,
      transferFixture({ status: "uploading", phase: "running" }),
    );
    expect(
      running.querySelector(".transfer-progress-wrap--indeterminate"),
    ).not.toBeNull();
    expect(
      running.querySelector(".transfer-progress[aria-busy='true']"),
    ).not.toBeNull();

    const queued = renderRow(transfers, transferFixture({ status: "queued" }));
    expect(
      queued.querySelector(".transfer-progress-wrap--indeterminate"),
    ).toBeNull();
    expect(queued.querySelector("[aria-busy]")).toBeNull();

    const paused = renderRow(
      transfers,
      transferFixture({
        status: "uploading",
        phase: "running",
        paused: true,
        totalBytes: 100,
        progress: 42,
        speedBps: 4_000_000,
        etaSeconds: 12,
        lastProgressAt: Date.now() - 60_000,
      }),
    );
    expect(
      paused.querySelector(".transfer-progress-wrap--indeterminate"),
    ).toBeNull();
    expect(
      paused.querySelector(".transfer-progress[aria-valuenow='42']"),
    ).not.toBeNull();
    expect(paused.querySelector("[aria-busy]")).toBeNull();
    expect(paused.querySelector(".transfer-phase--status")?.textContent).toBe(
      "Paused",
    );
    expect(paused.querySelectorAll(".transfer-phase")).toHaveLength(1);
    expect(paused.querySelector(".transfer-phase--stalled")).toBeNull();

    const phasePaused = renderRow(
      transfers,
      transferFixture({
        operation: "upload",
        status: "uploading",
        phase: "paused",
        paused: false,
        totalBytes: 100,
        progress: 42,
        speedBps: 4_000_000,
        etaSeconds: 12,
        lastProgressAt: Date.now() - 60_000,
      }),
    );
    expect(
      phasePaused.querySelector(".transfer-progress-wrap--indeterminate"),
    ).toBeNull();
    expect(phasePaused.querySelector("[aria-busy]")).toBeNull();
    expect(
      phasePaused.querySelector(".transfer-progress[aria-valuenow='42']"),
    ).not.toBeNull();
    expect(
      phasePaused.querySelector(".transfer-phase--status")?.textContent,
    ).toBe("Paused");
    expect(phasePaused.querySelectorAll(".transfer-phase")).toHaveLength(1);
    expect(phasePaused.querySelector(".transfer-phase--stalled")).toBeNull();
    expect(phasePaused.querySelector(".transfer-pause")).toBeNull();
  });

  it("keeps full transfer paths and wrapped errors available to assistive users", async () => {
    const transfers = await loadTransfersModule();
    const source =
      "source-bucket/very/long/path/that/must/remain/available/report.csv";
    const destination = "destination-bucket/archive/very/long/path/report.csv";
    const error = "Upload failed: " + "x".repeat(260);
    const row = renderRow(
      transfers,
      transferFixture({
        status: "error",
        sourceKey: source.slice("source-bucket/".length),
        destinationKey: destination.slice("destination-bucket/".length),
        error,
      }),
    );
    expect(row.querySelector(".transfer-name")?.getAttribute("title")).toBe(
      source,
    );
    expect(row.querySelector(".transfer-key")?.getAttribute("title")).toBe(
      destination,
    );
    expect(row.querySelector(".transfer-error")?.textContent).toBe(error);
    expect(row.querySelector(".transfer-error")?.getAttribute("title")).toBe(
      error,
    );
  });
});

describe("transfer row contracts (UX audit 0.12.0)", () => {
  function rowFrom(html: string): HTMLElement {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content.firstElementChild as HTMLElement;
  }

  function downloadFixture(
    overrides: Partial<TransferItem> = {},
  ): TransferItem {
    return transferFixture({
      operation: "download",
      fileName: "report.csv",
      key: "reports/report.csv",
      destination: "C:\\tmp\\report.csv",
      status: "uploading",
      phase: "running",
      totalBytes: 64 * 1024 * 1024,
      progress: 10,
      ...overrides,
    });
  }

  it("cancelled rows are neutral: not failed, not claimable, not counted as errors", () => {
    const item = transferFixture({ status: "uploading" });
    markCancelled(item);
    expect(item.status).toBe("cancelled");
    expect(isClaimable(item)).toBe(false);
    const aggregates = computeQueueAggregates([item]);
    expect(aggregates.failed).toBe(0);
    expect(aggregates.attention).toBe(0);
    expect(aggregates.cancelled).toBe(1);
  });

  it("renders a cancelled row as Cancelled with no retry or error styling", () => {
    const item = transferFixture({ status: "uploading" });
    markCancelled(item);
    const row = rowFrom(renderTransferRow(item));
    expect(row.textContent).toContain("Cancelled");
    expect(row.querySelector(".transfer-status--error")).toBeNull();
    expect(row.querySelector(".transfer-retry")).toBeNull();
  });

  it("gives row pause and cancel controls the base button class, an icon, and a file-name label", () => {
    const row = rowFrom(
      renderTransferRow(transferFixture({ status: "queued" })),
    );
    const pause = row.querySelector<HTMLElement>(".transfer-pause");
    const cancel = row.querySelector<HTMLElement>(".transfer-cancel");
    expect(pause?.className).toMatch(/\bbtn\b/);
    expect(cancel?.className).toMatch(/\bbtn\b/);
    expect(pause?.querySelector("svg")).not.toBeNull();
    expect(cancel?.querySelector("svg")).not.toBeNull();
    expect(pause?.getAttribute("aria-label")).toBe("Pause report.csv");
    expect(cancel?.getAttribute("aria-label")).toBe("Cancel report.csv");
  });

  it("shows Cancelling and disables row controls once cancel was requested", () => {
    const row = rowFrom(
      renderTransferRow(downloadFixture({ cancelRequested: true })),
    );
    expect(row.textContent).toContain("Cancelling");
    expect(
      row.querySelector<HTMLButtonElement>(".transfer-pause")?.disabled,
    ).toBe(true);
    expect(
      row.querySelector<HTMLButtonElement>(".transfer-cancel")?.disabled,
    ).toBe(true);
  });

  it("does not call a healthy single-request upload stalled", () => {
    const item = transferFixture({
      operation: "upload",
      status: "uploading",
      phase: "running",
      filePath: "/tmp/small.bin",
      key: "uploads/small.bin",
      fileName: "small.bin",
      totalBytes: 1024,
      progress: 0,
      lastProgressAt: Date.now() - 60_000,
    });
    const row = rowFrom(renderTransferRow(item, { now: Date.now() }));
    expect(row.textContent).not.toContain("Stalled");
    expect(row.textContent).toContain("Running");
  });

  it("flags a multipart download that stops reporting progress as stalled", () => {
    const now = Date.now();
    const row = rowFrom(
      renderTransferRow(downloadFixture({ lastProgressAt: now - 20_000 }), {
        now,
      }),
    );
    expect(row.textContent).toContain("Stalled");
  });

  it("counts down a retry wait in seconds instead of raw milliseconds", () => {
    const now = Date.now();
    const row = rowFrom(
      renderTransferRow(
        downloadFixture({ phase: "retry_wait", retryAt: now + 3000 }),
        { now },
      ),
    );
    expect(row.textContent).toContain("Retrying in 3 s");
    expect(row.textContent).not.toContain("ms");
  });

  it("labels attempts consistently as Attempt N of M", () => {
    const row = rowFrom(
      renderTransferRow(downloadFixture({ attempt: 2, maxAttempts: 4 })),
    );
    expect(row.textContent).toContain("Attempt 2 of 4");
  });

  it("keeps live speed out of the queue summary and names a paused queue", () => {
    document.body.innerHTML = `<div id="transfer-queue-summary"></div>`;
    const queue = [
      downloadFixture({ speedBps: 5 * 1024 * 1024 }),
      transferFixture({ status: "queued" }),
    ];
    updateQueueSummary(computeQueueAggregates(queue), {
      waiting: true,
      heldForDisconnect: false,
      offline: false,
      queuePaused: true,
      awaitingEndpoint: null,
    });
    const text =
      document.getElementById("transfer-queue-summary")?.textContent ?? "";
    expect(text).toContain("Queue paused");
    expect(text).not.toMatch(/\/s\b/);
    expect(text).not.toContain("MB");
  });

  it("counts paused rows separately from active ones", () => {
    const aggregates = computeQueueAggregates([
      transferFixture({ status: "queued", paused: true, phase: "paused" }),
      transferFixture({ status: "queued" }),
    ]);
    expect(aggregates.paused).toBe(1);
    expect(aggregates.active).toBe(1);
  });

  it("patches a progress update in place so Pause and Cancel nodes survive", () => {
    const item = downloadFixture({ progress: 10 });
    const row = rowFrom(renderTransferRow(item));
    const container = document.createElement("div");
    container.appendChild(row);
    const pause = row.querySelector(".transfer-pause");
    const cancel = row.querySelector(".transfer-cancel");

    item.progress = 50;
    patchTransferRowElement(row, rowFrom(renderTransferRow(item)));

    expect(row.querySelector(".transfer-pause")).toBe(pause);
    expect(row.querySelector(".transfer-cancel")).toBe(cancel);
    expect(
      row.querySelector(".transfer-progress__bar")?.getAttribute("style"),
    ).toContain("50%");
  });

  it("keeps the wording for shared transfer actions in one table", () => {
    expect(TRANSFER_TEXT.clearCompleted).toBe("Clear completed");
    expect(TRANSFER_TEXT.clearFailed).toBe("Clear failed");
    expect(TRANSFER_TEXT.replace).toBe("Replace");
    expect(TRANSFER_TEXT.skip).toBe("Skip");
  });

  it("exposes each row's status so the drawer filter can match it", () => {
    for (const status of ["queued", "uploading", "done", "error"] as const) {
      const row = rowFrom(renderTransferRow(transferFixture({ status })));
      expect(row.dataset.status).toBe(status);
    }
  });

  it("makes rows programmatically focusable for arrow-key movement", () => {
    const row = rowFrom(
      renderTransferRow(transferFixture({ status: "queued" })),
    );
    expect(row.getAttribute("tabindex")).toBe("-1");
  });

  it("gives the row action icons from the shared icon set, with a 28px-capable icon button", () => {
    const row = rowFrom(
      renderTransferRow(transferFixture({ status: "queued" })),
    );
    expect(
      row.querySelector(".transfer-pause svg")?.getAttribute("data-icon"),
    ).toBe("pause");
    expect(
      row.querySelector(".transfer-cancel svg")?.getAttribute("data-icon"),
    ).toBe("x");
    const retry = rowFrom(
      renderTransferRow(transferFixture({ status: "error", error: "Denied" })),
    );
    expect(
      retry.querySelector(".transfer-retry svg")?.getAttribute("data-icon"),
    ).toBe("rotate-ccw");
    expect(
      retry
        .querySelector(".transfer-copy-error svg")
        ?.getAttribute("data-icon"),
    ).toBe("copy");
  });
});
