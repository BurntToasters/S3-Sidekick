// Failure modes covered before implementation:
// - A pause during retry backoff sends `cancel_transfer` while no native
//   command is registered. The backend keeps that cancel pending for 30s, so
//   a quick resume consumes it and the resumed attempt is reported as a
//   failed "Transfer cancelled" instead of running to completion.
// - Auto-lock only counts pointer and keyboard input as activity. An
//   unattended transfer then trips the inactivity timeout, which disconnects
//   the session and interrupts the transfer (uploads restart from zero).
// - Keeping the vault open for transfers must not disable auto-lock: once
//   the queue is idle, the inactivity timeout still locks and disconnects.
// Transition guards for the transfer state machine (each must hold before
// and after the refactor):
// - Cancelling a running copy leaves it running or reports it as failed
//   instead of "Cancelled".
// - Cancelling a queued copy still runs it later.
// - A permanently failed copy cannot be retried to completion.
// - Disconnecting fails running work instead of parking it, or a reconnect
//   does not resume it.
// - Offline hold starts work anyway, or never resumes once back online.

import { expect, test, type Page } from "@playwright/test";
import {
  FULL_CREATE_ONLY,
  countOf,
  openCopyMoveFromRow,
  saveArtifact as saveSuiteArtifact,
} from "./helpers";
import {
  connectMockListing,
  openMockListing,
  readMockCallLog,
  releaseMockCopies,
  type LayoutMockOptions,
} from "./tauri-layout";

async function openListingWithOneFile(
  page: Page,
  options: LayoutMockOptions,
): Promise<void> {
  await openMockListing(page, {
    objectCount: 1,
    prefixes: [],
    createOnlyCapabilities: FULL_CREATE_ONLY,
    listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
    ...options,
  });
}

async function startCopyOfFirstFile(page: Page): Promise<void> {
  await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
  await page.locator("#copy-move-path").fill("destination/");
  await page.locator("#copy-move-copy-btn").click();
  await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
}

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await expect(list).toBeVisible();
}

test.describe("transfer lifecycle", () => {
  test("pause during retry backoff then quick resume completes the copy", async ({
    page,
  }, testInfo) => {
    await openListingWithOneFile(page, {
      settings: { transferRetryBaseMs: 5000 },
      transferBackend: { copyFailures: 1 },
    });
    await startCopyOfFirstFile(page);
    await showTransferList(page);

    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).toContainText("Retry wait");

    // Pause while the backoff runs: nothing is registered natively, so the
    // cancel is recorded as pending. Resume well inside its 30s lifetime.
    await row.locator(".transfer-pause").click();
    await expect
      .poll(async () =>
        countOf(await readMockCallLog(page), "mock:pending-cancel-recorded"),
      )
      .toBe(1);
    await expect(row.locator(".transfer-pause")).toHaveAttribute(
      "title",
      "Resume",
    );
    await row.locator(".transfer-pause").click();

    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "mock:pending-cancel-consumed")).toBe(1);
    // Attempt 1 failed (503), the resumed attempt absorbed the pending
    // cancel, and the requeued attempt completed.
    expect(countOf(calls, "copy_object_to")).toBe(3);
    await expect(page.locator("#transfer-queue-summary")).not.toContainText(
      /failed/,
    );
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "pause-resume-retry",
      calls,
    );
  });

  test("auto-lock waits for running transfers, then locks once idle", async ({
    page,
  }, testInfo) => {
    await page.clock.install();
    await openListingWithOneFile(page, {
      security: {
        encryption_enabled: true,
        unlocked: true,
        lock_timeout_minutes: 1,
      },
      autoLockAfterMs: 60_000,
      transferBackend: { holdCopies: true },
    });
    await startCopyOfFirstFile(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);

    // Five idle minutes with a transfer running: the vault must stay open
    // and the session connected.
    await page.clock.runFor(5 * 60_000);
    let calls = await readMockCallLog(page);
    expect(countOf(calls, "mock:auto-locked")).toBe(0);
    expect(countOf(calls, "disconnect")).toBe(0);
    expect(countOf(calls, "touch_security_activity")).toBeGreaterThan(0);

    await releaseMockCopies(page);
    await showTransferList(page);
    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);

    // Idle queue: the inactivity timeout applies again.
    await page.clock.runFor(3 * 60_000);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "disconnect"))
      .toBe(1);
    calls = await readMockCallLog(page);
    expect(countOf(calls, "mock:auto-locked")).toBe(1);
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "auto-lock-transfers",
      calls,
    );
  });

  test("cancelling a running copy marks it cancelled", async ({
    page,
  }, testInfo) => {
    await openListingWithOneFile(page, {
      transferBackend: { holdCopies: true },
    });
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);
    const row = page.locator("#transfer-list .transfer-item").first();
    await row.locator(".transfer-cancel").click();
    await expect(row).toContainText("Cancelled");
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "cancel-running",
      await readMockCallLog(page),
    );
  });

  test("cancelling a queued copy never runs it", async ({ page }, testInfo) => {
    await openMockListing(page, {
      objectCount: 2,
      prefixes: [],
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
      settings: { maxConcurrentTransfers: 1 },
      transferBackend: { holdCopies: true },
    });
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
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);
    const queued = rows.filter({ hasText: "Queued" });
    await queued.locator(".transfer-cancel").click();
    await expect(rows.filter({ hasText: "Cancelled" })).toHaveCount(1);
    await releaseMockCopies(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Cancelled");
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(1);
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "cancel-queued",
      calls,
    );
  });

  test("a failed copy retries to completion from Retry failed", async ({
    page,
  }, testInfo) => {
    await openListingWithOneFile(page, {
      settings: { transferRetryAttempts: 0 },
      transferBackend: { copyFailures: 1 },
    });
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    const rows = page.locator("#transfer-list .transfer-item");
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "1 failed",
    );
    await page.locator("#transfer-more").click();
    await page
      .locator('.context-menu [role="menuitem"]', { hasText: "Retry failed" })
      .click();
    await expect(rows).toHaveCount(0);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(2);
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "retry-failed",
      calls,
    );
  });

  test("disconnect parks a running copy and reconnect completes it", async ({
    page,
  }, testInfo) => {
    await openListingWithOneFile(page, {
      transferBackend: { holdCopies: true },
    });
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);
    await page.locator("#disconnect-btn").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await showTransferList(page);
    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).toContainText("Disconnected — waiting to reconnect");
    await expect(page.locator("#transfer-queue-summary")).not.toContainText(
      "failed",
    );

    await connectMockListing(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(2);
    await releaseMockCopies(page);
    await showTransferList(page);
    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "disconnect-park",
      await readMockCallLog(page),
    );
  });

  test("offline hold parks new work and resumes once online", async ({
    page,
    context,
  }, testInfo) => {
    await openListingWithOneFile(page, {});
    await context.setOffline(true);
    await startCopyOfFirstFile(page);
    await showTransferList(page);
    await expect(page.locator("#transfer-queue-summary")).toContainText(
      "Offline",
    );
    expect(countOf(await readMockCallLog(page), "copy_object_to")).toBe(0);
    await context.setOffline(false);
    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(1);
    await saveSuiteArtifact(
      page,
      testInfo,
      "transfer-lifecycle",
      "offline-hold",
      calls,
    );
  });
});
