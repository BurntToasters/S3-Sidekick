// Failure modes covered (UI/UX audit 0.12.0, drawer, toasts, activity, drop zone):
// - The toast stack sits over the status-bar Activity/Transfers buttons and the
//   open drawer's header controls.
// - The toast stack covers a modal's action row.
// - The drawer forgets its open tab and minimized state across a reload.
// - "Clear" on the Activity tab wipes the log without asking first.
// - The drop overlay shows while disconnected, for drags that carry no files,
//   and Escape cannot dismiss it.
// - Drawer header, status-bar and row icon controls render below the 28px
//   pointer target floor.
// - The transfer list has no way to show only failed or completed rows.
// - Reduced motion still animates the indeterminate progress bar.
// - The resize handle is not exposed as a separator.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { saveArtifact as saveSuiteArtifact } from "./helpers";
import {
  connectMockListing,
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  setMockCommandError,
} from "./tauri-layout";

const SUITE = "ux-drawer";
const MIN_TARGET_PX = 28;

interface LayoutTestState {
  emit?: (event: string, payload: unknown) => void;
}

async function showToast(
  page: Page,
  message: string,
  options: { type?: string; duration?: number },
): Promise<void> {
  await page.evaluate(
    async ({ message, options }) => {
      const url =
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/toast\.ts(\?|$)/.test(name)) ??
        new URL("/toast.ts", window.location.href).href;
      const mod = (await import(/* @vite-ignore */ url)) as {
        showToast: (text: string, opts: object) => void;
      };
      mod.showToast(message, options);
    },
    { message, options },
  );
}

/** Queue a pathless browser File through the app's real transfer queue. */
async function enqueueBrowserFile(page: Page, fileName: string): Promise<void> {
  await page.evaluate(async (name) => {
    const url =
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((entry) => /\/transfers\.ts(\?|$)/.test(entry)) ??
      new URL("/transfers.ts", window.location.href).href;
    const mod = (await import(/* @vite-ignore */ url)) as {
      enqueueFiles(files: File[], targetPrefix: string): void;
    };
    const file = new File([new Uint8Array(1024)], name, {
      type: "text/plain",
    });
    mod.enqueueFiles([file], "browser-upload/");
  }, fileName);
}

async function emitDragEvent(
  page: Page,
  event: "tauri://drag-enter" | "tauri://drag-drop" | "tauri://drag-leave",
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ event, payload }) => {
      const state = (
        window as unknown as { __S3_LAYOUT_TEST__?: LayoutTestState }
      ).__S3_LAYOUT_TEST__;
      state?.emit?.(event, payload);
    },
    { event, payload },
  );
}

async function openTransfers(page: Page): Promise<void> {
  if (!(await page.locator("#bottom-drawer").isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await page.locator("#drawer-tab-transfers").click();
  await expect(page.locator("#drawer-tab-transfers")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#transfer-list")).toBeVisible();
}

async function openActivity(page: Page): Promise<void> {
  if (!(await page.locator("#bottom-drawer").isVisible())) {
    await page.locator("#activity-toggle").click();
  }
  await page.locator("#drawer-tab-activity").click();
  await expect(page.locator("#drawer-tab-activity")).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

/**
 * Pointer-level check: the centre of `target` must not be hit-tested to an
 * element inside `coverSelector`. Polled because toasts animate in.
 */
async function expectNotCoveredBy(
  target: Locator,
  coverSelector: string,
): Promise<void> {
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((node, cover) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && hit.closest(cover) !== null;
      }, coverSelector),
    )
    .toBe(false);
}

async function expectMinTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);
}

test.describe("drawer, toasts, activity log and drop zone", () => {
  test("toasts stack above the status bar and the open drawer header", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await showToast(page, "Upload failed", { type: "error", duration: 0 });
    const toast = page.locator(".toast-region .toast").first();
    await expect(toast).toBeVisible();

    await expect
      .poll(async () => {
        const toastBox = await toast.boundingBox();
        const statusBox = await page.locator(".statusbar").boundingBox();
        if (!toastBox || !statusBox) return false;
        return toastBox.y + toastBox.height <= statusBox.y;
      })
      .toBe(true);
    await expectNotCoveredBy(page.locator("#activity-toggle"), ".toast-region");
    await expectNotCoveredBy(page.locator("#transfer-toggle"), ".toast-region");

    await page.locator("#transfer-toggle").click();
    await expect(page.locator("#bottom-drawer")).toBeVisible();
    await expectNotCoveredBy(page.locator("#drawer-minimize"), ".toast-region");
    await expectNotCoveredBy(page.locator("#drawer-close"), ".toast-region");

    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      SUITE,
      "toast-above-statusbar",
      calls,
    );
  });

  test("a toast raised over a confirm dialog leaves the dialog buttons clickable", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await enqueueBrowserFile(page, "clear-me.txt");
    await openActivity(page);
    await page.locator("#drawer-clear").click();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Clear activity log?",
    );

    await showToast(page, "Upload failed", { type: "error", duration: 0 });
    await expect(page.locator(".toast-region .toast").first()).toBeVisible();
    await expectNotCoveredBy(page.locator("#dialog-ok"), ".toast-region");
    await expectNotCoveredBy(page.locator("#dialog-cancel"), ".toast-region");

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "toast-over-dialog", calls);
  });

  test("the drawer reopens on the same tab after a reload", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await openTransfers(page);

    await page.reload();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await connectMockListing(page);

    await expect(page.locator("#bottom-drawer")).toBeVisible();
    await expect(page.locator("#drawer-tab-transfers")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "reopen-same-tab", calls);
  });

  test("a minimized drawer stays minimized after a reload", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await openTransfers(page);
    await page.locator("#drawer-minimize").click();
    await expect(page.locator("#bottom-drawer")).toHaveClass(
      /bottom-drawer--minimized/,
    );

    await page.reload();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await connectMockListing(page);
    await expect(page.locator("#bottom-drawer")).toHaveClass(
      /bottom-drawer--minimized/,
    );
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      SUITE,
      "minimized-after-reload",
      calls,
    );
  });

  test("Clear on the Activity tab asks first and Keep leaves the log intact", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await enqueueBrowserFile(page, "logged.txt");
    await openActivity(page);
    const entries = page.locator("#activity-list .activity-entry");
    await expect(entries.first()).toBeVisible();
    const before = await entries.count();
    expect(before).toBeGreaterThan(0);

    await page.locator("#drawer-clear").click();
    await expect(page.locator("#dialog-title")).toHaveText(
      "Clear activity log?",
    );
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
    await expect(entries).toHaveCount(before);

    await page.locator("#drawer-clear").click();
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#activity-list .activity-empty")).toBeVisible();
    await expect(entries).toHaveCount(0);
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      SUITE,
      "clear-activity-confirm",
      calls,
    );
  });

  test("the drop target shows only for connected drags that carry files", async ({
    page,
  }, testInfo) => {
    await installAndGoToConnection(page);
    const overlay = page.locator("#drop-zone-overlay");

    await emitDragEvent(page, "tauri://drag-enter", {
      paths: ["/tmp/before-connect.txt"],
      position: { x: 10, y: 10 },
    });
    await expect(overlay).toBeHidden();

    await connectMockListing(page);
    await emitDragEvent(page, "tauri://drag-enter", {
      paths: [],
      position: { x: 10, y: 10 },
    });
    await expect(overlay).toBeHidden();

    await emitDragEvent(page, "tauri://drag-enter", {
      paths: ["/tmp/a.txt"],
      position: { x: 10, y: 10 },
    });
    await expect(overlay).toBeVisible();
    await expect(page.locator(".drop-zone-overlay__text")).toHaveText(
      "Drop to upload to",
    );
    await expect(page.locator("#drop-zone-path")).toHaveText(
      /layout-test-bucket\//,
    );

    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();

    await emitDragEvent(page, "tauri://drag-enter", {
      paths: ["/tmp/b.txt"],
      position: { x: 10, y: 10 },
    });
    await expect(overlay).toBeVisible();
    await emitDragEvent(page, "tauri://drag-leave", {});
    await expect(overlay).toBeHidden();

    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "drop-target-gating", calls);
  });

  test("drawer, status-bar and tab controls meet the 28px target floor", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await openActivity(page);
    await expectMinTarget(page.locator("#drawer-tab-activity"));
    await expectMinTarget(page.locator("#drawer-clear"));
    await expectMinTarget(page.locator("#drawer-export"));
    await expectMinTarget(page.locator("#drawer-minimize"));
    await expectMinTarget(page.locator("#drawer-close"));
    await expectMinTarget(page.locator("#activity-toggle"));
    await expectMinTarget(page.locator("#transfer-toggle"));

    await openTransfers(page);
    await expect(page.locator("#drawer-clear")).toHaveText("Clear completed");
    await expectMinTarget(page.locator("#drawer-tab-transfers"));
    await expectMinTarget(page.locator("#transfer-pause-all"));
    await expectMinTarget(page.locator("#transfer-more"));
    for (const filter of ["all", "active", "failed", "completed"]) {
      await expectMinTarget(page.locator(`[data-transfer-filter="${filter}"]`));
    }
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "target-sizes", calls);
  });

  test("row controls meet the target floor and name their file", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await setMockCommandError(page, "upload_object_bytes", "Access denied");
    await enqueueBrowserFile(page, "failed.txt");
    await openTransfers(page);
    const failedRow = page.locator('.transfer-item[data-status="error"]');
    await expect(failedRow).toBeVisible({ timeout: 20_000 });

    const retry = failedRow.locator(".transfer-retry");
    await expectMinTarget(retry);
    await expect(retry).toHaveAttribute("aria-label", /failed\.txt/);
    const copyError = failedRow.locator(".transfer-copy-error");
    await expectMinTarget(copyError);
    await expect(copyError).toHaveAttribute("aria-label", /failed\.txt/);
    const remove = failedRow.locator(".transfer-remove");
    await expectMinTarget(remove);
    await expect(remove).toHaveAttribute("aria-label", /failed\.txt/);
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "row-controls", calls);
  });

  test("the Failed and Completed filters show only matching rows", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await openTransfers(page);

    await setMockCommandError(page, "upload_object_bytes", "Access denied");
    await enqueueBrowserFile(page, "failed.txt");
    await expect(
      page.locator('.transfer-item[data-status="error"]'),
    ).toBeVisible({ timeout: 20_000 });

    await setMockCommandError(page, "upload_object_bytes", null);
    await enqueueBrowserFile(page, "done.txt");
    await expect(
      page.locator('.transfer-item[data-status="done"]'),
    ).toBeVisible({ timeout: 20_000 });

    const failedRows = page.locator('.transfer-item[data-status="error"]');
    const doneRows = page.locator('.transfer-item[data-status="done"]');
    const filter = (name: string) =>
      page.locator(`[data-transfer-filter="${name}"]`);

    await filter("failed").click();
    await expect(filter("failed")).toHaveAttribute("aria-pressed", "true");
    await expect(failedRows).toBeVisible();
    await expect(doneRows).toBeHidden();
    await expect(page.locator("#transfer-filter-empty")).toBeHidden();

    await filter("completed").click();
    await expect(doneRows).toBeVisible();
    await expect(failedRows).toBeHidden();

    await filter("active").click();
    await expect(page.locator("#transfer-filter-empty")).toHaveText(
      "No active transfers",
    );
    await expect(page.locator("#transfer-filter-empty")).toBeVisible();

    await filter("all").click();
    await expect(failedRows).toBeVisible();
    await expect(doneRows).toBeVisible();
    await expect(page.locator("#transfer-filter-empty")).toBeHidden();
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "transfer-filters", calls);
  });

  test("reduced motion holds the indeterminate bar still at full width", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMockListing(page);
    await openTransfers(page);
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "motion-probe";
      host.innerHTML =
        '<div class="transfer-progress transfer-progress--indeterminate" role="progressbar" aria-label="probe progress" aria-busy="true" style="width:300px"><div class="transfer-progress__bar"></div></div>';
      document.body.appendChild(host);
    });
    const bar = page.locator(
      "#motion-probe .transfer-progress--indeterminate .transfer-progress__bar",
    );
    const metrics = await bar.evaluate((node) => {
      const track = node.parentElement as HTMLElement;
      return {
        animationName: getComputedStyle(node).animationName,
        barWidth: node.getBoundingClientRect().width,
        trackWidth: track.getBoundingClientRect().width,
      };
    });
    expect(metrics.animationName).toBe("none");
    expect(Math.abs(metrics.barWidth - metrics.trackWidth)).toBeLessThanOrEqual(
      1,
    );
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "reduced-motion-bar", calls);
  });

  test("the drawer resize handle is exposed as a separator", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await expect(
      page.locator("#bottom-drawer .bottom-drawer__resize-handle"),
    ).toHaveAttribute("role", "separator");
    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(page, testInfo, SUITE, "resize-separator", calls);
  });
});

/** Open the app on the connection screen without connecting. */
async function installAndGoToConnection(page: Page): Promise<void> {
  await installLayoutTauriMock(page, {});
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
}
