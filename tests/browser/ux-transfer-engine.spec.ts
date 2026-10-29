// Failure modes covered before implementation (UI/UX audit 0.12.0, transfers):
// - Escape on the startup recovery prompt runs Discard and deletes resume data,
//   including moves that still await reconciliation.
// - Discard has no second confirmation and does not say what will be lost.
// - Cancelling a running copy is reported as a failure, is retried by
//   "Retry failed", and never shows the "Cancelling" phase.
// - "Clear completed" removes failed rows; completed rows leave the list
//   before the user can see them; clearing failed rows is not confirmed.
// - Enqueue during unresolved recovery reports "Queued" even though the
//   queue refused the work.
// - Row Pause/Cancel buttons use no base button class, no icon, and have no
//   file name in their label.
// - Per-row Retry on a failed row re-runs every failed row, not just that one.
import { expect, test, type Page } from "@playwright/test";
import {
  FULL_CREATE_ONLY,
  countOf,
  openCopyMoveFromRow,
  saveArtifact as saveSuiteArtifact,
} from "./helpers";
import {
  connectMockListing,
  installLayoutTauriMock,
  readMockCallLog,
  releaseMockCopies,
  type LayoutMockOptions,
} from "./tauri-layout";

/**
 * Pending recovery state from a previous session: one download that can
 * resume, one failed download that needs review.
 */
const PENDING_MANIFEST = JSON.stringify({
  version: 6,
  items: [
    {
      operation: "download",
      bucket: "layout-test-bucket",
      fileName: "report.csv",
      filePath: "",
      key: "reports/report.csv",
      destination: "/tmp/report.csv",
      size: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      resumable: true,
      checkpointId: "ckpt-report-csv",
      completedParts: 0,
      totalParts: 0,
    },
    {
      operation: "download",
      bucket: "layout-test-bucket",
      fileName: "failed.csv",
      filePath: "",
      key: "reports/failed.csv",
      destination: "/tmp/failed.csv",
      size: 0,
      totalBytes: 0,
      attempt: 1,
      maxAttempts: 1,
      conflictResolution: "ask",
      resumable: false,
      completedParts: 0,
      totalParts: 0,
      failed: true,
      error: "Access denied",
    },
  ],
});

/**
 * Install the Tauri mock, then a wrapper that can hold `cancel_transfer`
 * until the test releases it. Wrapper goes first so the setter sees the
 * mock's internals object when it is assigned.
 */
async function openListing(
  page: Page,
  options: LayoutMockOptions,
  { holdCancel = false }: { holdCancel?: boolean } = {},
): Promise<void> {
  if (holdCancel) {
    await page.addInitScript(() => {
      let internals:
        | {
            invoke: (c: string, a: Record<string, unknown>) => Promise<unknown>;
          }
        | undefined;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => internals,
        set: (value) => {
          const original = value.invoke;
          value.invoke = async (
            command: string,
            args: Record<string, unknown>,
          ) => {
            const w = window as unknown as Record<string, unknown>;
            if (
              command === "cancel_transfer" &&
              w.__UX_HOLD_CANCEL__ === true
            ) {
              await new Promise<void>((resolve) => {
                w.__UX_RELEASE_CANCEL__ = resolve;
              });
            }
            return original(command, args);
          };
          internals = value;
        },
      });
    });
  }
  await installLayoutTauriMock(page, options);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
}

async function releaseHeldCancel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const release = w.__UX_RELEASE_CANCEL__;
    if (typeof release === "function") release();
  });
}

/** Submit the copy dialog for the first file without asserting the outcome. */
async function submitCopyOfFirstFile(page: Page): Promise<void> {
  await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
  await page.locator("#copy-move-path").fill("destination/");
  await page.locator("#copy-move-copy-btn").click();
}

/** Accepted copy: the queue takes the work and the dialog closes. */
async function startCopyOfFirstFile(page: Page): Promise<void> {
  await submitCopyOfFirstFile(page);
  await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
}

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await expect(list).toBeVisible();
}

async function openTransferMenu(page: Page, label: string): Promise<void> {
  await page.locator("#transfer-more").click();
  await page
    .locator('.context-menu [role="menuitem"]', { hasText: label })
    .click();
}

function dialog(page: Page) {
  return page.locator("#dialog-overlay");
}

/**
 * Connect while a recovery decision is still pending. The prompt appears at
 * startup and again when a connection starts while recovery is unresolved,
 * so answer it with Escape ("Decide later") and then open the first bucket.
 */
async function connectAnsweringRecoveryLater(page: Page): Promise<void> {
  await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
  await page.locator("#conn-access-key").fill("layout-access-key");
  await page.locator("#conn-secret-key").fill("layout-secret-key");
  await page.locator("#connect-btn").click();
  await expect(dialog(page)).toHaveClass(/active/);
  await expect(page.locator("#dialog-title")).toHaveText(
    "Resume transfers from last session?",
  );
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toHaveClass(/active/);
  await expect(page.locator("#main-layout")).toBeVisible();
  const bucket = page.locator("#bucket-list .list__item-btn").first();
  await expect(bucket).toBeVisible();
  await bucket.click();
  await expect(page.locator("#object-panel")).toBeVisible();
}

test.describe("transfer engine UX", () => {
  test("Escape on the recovery prompt keeps the manifest and runs nothing", async ({
    page,
  }, testInfo) => {
    await openListing(page, { transferManifestJson: PENDING_MANIFEST });
    await expect(dialog(page)).toHaveClass(/active/);
    await expect(page.locator("#dialog-message")).toContainText(/1 to resume/);
    await expect(page.locator("#dialog-message")).toContainText(/1 failed/);

    await page.keyboard.press("Escape");
    await expect(dialog(page)).not.toHaveClass(/active/);

    await connectAnsweringRecoveryLater(page);
    await showTransferList(page);
    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "discard_download_scratch")).toBe(0);
    expect(countOf(calls, "transfer_checkpoint_remove")).toBe(0);
    expect(countOf(calls, "clear_transfer_manifest")).toBe(0);
    expect(countOf(calls, "download_object")).toBe(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "recovery-escape-keeps-manifest",
      calls,
    );
  });

  test("Discard on the recovery prompt needs a second confirmation", async ({
    page,
  }, testInfo) => {
    await openListing(page, { transferManifestJson: PENDING_MANIFEST });
    await dialog(page)
      .getByRole("button", { name: "Discard", exact: true })
      .click();

    // The first confirmation must say what will be lost.
    await expect(page.locator("#dialog-message")).toContainText(
      /does not delete/i,
    );
    expect(
      countOf(await readMockCallLog(page), "clear_transfer_manifest"),
    ).toBe(0);
    expect(
      countOf(await readMockCallLog(page), "discard_download_scratch"),
    ).toBe(0);

    await dialog(page)
      .getByRole("button", { name: "Discard recovery data" })
      .click();
    await expect(dialog(page)).not.toHaveClass(/active/);
    await connectMockListing(page);
    await expect
      .poll(async () =>
        countOf(await readMockCallLog(page), "clear_transfer_manifest"),
      )
      .toBe(1);
    const calls = await readMockCallLog(page);
    // One scratch discard per recovered row (resumable + failed).
    expect(countOf(calls, "discard_download_scratch")).toBe(2);
    expect(countOf(calls, "download_object")).toBe(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "recovery-discard-confirmed",
      calls,
    );
  });

  test("cancelling a running copy shows Cancelling, then a neutral Cancelled row", async ({
    page,
  }, testInfo) => {
    await openListing(
      page,
      { transferBackend: { holdCopies: true } },
      { holdCancel: true },
    );
    await connectMockListing(page);
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);

    const row = page.locator("#transfer-list .transfer-item").first();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__UX_HOLD_CANCEL__ = true;
    });
    await row.locator(".transfer-cancel").click();
    await expect(row).toContainText("Cancelling");
    await expect(row.locator(".transfer-cancel")).toBeDisabled();
    await expect(row.locator(".transfer-pause")).toBeDisabled();

    await releaseHeldCancel(page);
    await expect(row).toContainText("Cancelled");
    await expect(row).not.toContainText("Failed");
    await expect(page.locator("#transfer-queue-summary")).not.toContainText(
      /failed/,
    );

    await openTransferMenu(page, "Retry failed");
    await page.waitForTimeout(300);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(1);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "cancel-running-neutral",
      calls,
    );
  });

  test("a completed row stays listed until Clear completed", async ({
    page,
  }, testInfo) => {
    await openListing(page, {});
    await connectMockListing(page);
    await startCopyOfFirstFile(page);
    await showTransferList(page);

    const rows = page.locator("#transfer-list .transfer-item");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Completed");

    await openTransferMenu(page, "Clear completed");
    await expect(rows).toHaveCount(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "clear-completed",
      await readMockCallLog(page),
    );
  });

  test("clearing failed rows asks for confirmation first", async ({
    page,
  }, testInfo) => {
    await openListing(page, {
      settings: { transferRetryAttempts: 0 },
      transferBackend: { copyFailures: 1 },
    });
    await connectMockListing(page);
    await startCopyOfFirstFile(page);
    await showTransferList(page);

    const rows = page.locator("#transfer-list .transfer-item");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Failed");

    await openTransferMenu(page, "Clear failed");
    await expect(dialog(page)).toHaveClass(/active/);
    await expect(rows).toHaveCount(1);

    await dialog(page)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(rows).toHaveCount(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "clear-failed-confirmed",
      await readMockCallLog(page),
    );
  });

  test("enqueue during unresolved recovery is refused, not shown as Queued", async ({
    page,
  }, testInfo) => {
    await openListing(page, { transferManifestJson: PENDING_MANIFEST });
    await page.keyboard.press("Escape");
    await expect(dialog(page)).not.toHaveClass(/active/);

    await connectAnsweringRecoveryLater(page);
    await submitCopyOfFirstFile(page);
    // A refused copy keeps the dialog open and says why; it is not a success.
    await expect(page.locator("#copy-move-error")).toContainText(
      "not resolved yet",
    );
    await expect(page.locator("#copy-move-overlay")).toHaveClass(/active/);
    await page.locator("#copy-move-cancel").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
    // The refusal is announced as a toast; the activity log entry is hidden
    // while the drawer is closed.
    await expect(
      page.locator("#toast-region .toast--warning", {
        hasText: /not resolved/i,
      }),
    ).toBeVisible();

    await showTransferList(page);
    await expect(page.locator("#transfer-list")).not.toContainText("Queued");
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "enqueue-refused-during-recovery",
      calls,
    );
  });

  test("row Pause and Cancel buttons are real icon buttons labelled with the file name", async ({
    page,
  }, testInfo) => {
    await openListing(page, { transferBackend: { holdCopies: true } });
    await connectMockListing(page);
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);

    const row = page.locator("#transfer-list .transfer-item").first();
    const pause = row.locator(".transfer-pause");
    const cancel = row.locator(".transfer-cancel");
    await expect(pause).toHaveClass(/\bbtn\b/);
    await expect(cancel).toHaveClass(/\bbtn\b/);
    await expect(pause.locator("svg")).toHaveCount(1);
    await expect(cancel.locator("svg")).toHaveCount(1);
    const pauseLabel = (await pause.getAttribute("aria-label")) ?? "";
    expect(pauseLabel).toMatch(/^Pause \d{3}-sample-object\.txt$/);
    const fileName = pauseLabel.slice("Pause ".length);
    await expect(row).toContainText(fileName);
    await expect(cancel).toHaveAttribute("aria-label", `Cancel ${fileName}`);

    await releaseMockCopies(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "row-controls",
      await readMockCallLog(page),
    );
  });

  test("per-row Retry re-queues only the failed row", async ({
    page,
  }, testInfo) => {
    await openListing(page, {
      objectCount: 2,
      prefixes: [],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
      settings: { maxConcurrentTransfers: 1, transferRetryAttempts: 0 },
      transferBackend: { copyFailures: 1 },
    });
    await connectMockListing(page);
    for (const index of [0, 1]) {
      await openCopyMoveFromRow(
        page,
        page.locator(".object-row--file").nth(index),
      );
      await page.locator("#copy-move-path").fill("destination/");
      await page.locator("#copy-move-copy-btn").click();
      await expect(page.locator("#copy-move-overlay")).not.toHaveClass(
        /active/,
      );
    }
    await showTransferList(page);

    const rows = page.locator("#transfer-list .transfer-item");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Failed");
    await expect(rows.nth(1)).toContainText("Completed");

    await rows.nth(0).locator(".transfer-retry").click();
    await expect(rows.nth(0)).toContainText("Completed");

    const calls = await readMockCallLog(page);
    const copies = calls.filter((call) => call.command === "copy_object_to");
    expect(copies).toHaveLength(3);
    const srcKeyOf = (call: { args: unknown }) =>
      (call.args as { srcKey?: string }).srcKey;
    // copies[0] is the failed row; the retry must re-run that same source.
    expect(srcKeyOf(copies[2])).toBe(srcKeyOf(copies[0]));
    expect(srcKeyOf(copies[1])).not.toBe(srcKeyOf(copies[0]));
    await saveSuiteArtifact(
      page,
      testInfo,
      "ux-transfer-engine",
      "row-retry-only-failed",
      calls,
    );
  });
});
