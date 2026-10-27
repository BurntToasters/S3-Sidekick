// Failure modes covered before implementation:
// - A completed download has no way to reveal its file, so users open the
//   folder by hand and look for it. The "Show in folder" control must appear
//   only on a completed download and must send the row's stored destination
//   to `reveal_local_path`, never a path the user typed.
// - A running or failed download has no file on disk to reveal. Showing the
//   control there would select a file that may not exist yet.
// - An upload row has no local destination. Showing the control there would
//   send an upload's source path to the file manager.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  commandCalls,
  countOf,
  saveArtifact as saveSuiteArtifact,
} from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  type LayoutMockOptions,
} from "./tauri-layout";

const SUITE = "ux-deferred-reveal";
const DOWNLOAD_DESTINATION = "/tmp/s3-sidekick-reveal/000-sample-object.txt";
const DOWNLOAD_NAME = "000-sample-object.txt";
const UPLOAD_SOURCE = "/tmp/s3-sidekick-reveal/upload-source.csv";

/**
 * Wrap the mock's invoke, installed before the layout mock so its setter sees
 * the internals object. The dialog answers with a fixed path, a download can
 * be held open, and transfer commands get a plausible byte count when the
 * mock returns nothing.
 */
async function installRevealMocks(
  page: Page,
  options: { holdDownloads?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ holdDownloads, downloadDestination, uploadSource }) => {
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
            if (command === "plugin:dialog|save") return downloadDestination;
            if (command === "plugin:dialog|open") return uploadSource;
            if (command === "download_object") {
              // Record the call through the mock, then optionally never finish.
              const result = await original(command, args);
              if (holdDownloads) await new Promise(() => undefined);
              return result ?? 512;
            }
            if (command === "upload_object") {
              const result = await original(command, args);
              return result ?? 512;
            }
            return original(command, args);
          };
          internals = value;
        },
      });
    },
    {
      holdDownloads: options.holdDownloads ?? false,
      downloadDestination: DOWNLOAD_DESTINATION,
      uploadSource: UPLOAD_SOURCE,
    },
  );
}

async function openListingWithOneFile(
  page: Page,
  options: LayoutMockOptions = {},
): Promise<void> {
  await openMockListing(page, {
    objectCount: 1,
    longFileCount: 0,
    prefixes: [],
    settings: { transferRetryAttempts: 0 },
    ...options,
  });
}

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await expect(list).toBeVisible();
}

async function startDownloadOfFirstFile(page: Page): Promise<void> {
  const row = page.locator(".object-row--file").first();
  await row.click();
  await row.click({ button: "right" });
  await page
    .locator('.context-menu [role="menuitem"]', { hasText: /^Download$/ })
    .click();
}

async function startUploadFromToolbar(page: Page): Promise<void> {
  await page.locator("#btn-upload").click();
}

function revealControl(page: Page, fileName: string) {
  return page.getByRole("button", { name: `Show ${fileName} in folder` });
}

async function saveArtifact(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await saveSuiteArtifact(
    page,
    testInfo,
    SUITE,
    name,
    await readMockCallLog(page),
  );
}

test.describe("deferred reveal of completed downloads", () => {
  test("completed download shows Show in folder and reveals its stored destination", async ({
    page,
  }, testInfo) => {
    await installRevealMocks(page);
    await openListingWithOneFile(page);
    await startDownloadOfFirstFile(page);
    await showTransferList(page);

    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).toContainText("Completed");
    const control = revealControl(page, DOWNLOAD_NAME);
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("type", "button");
    await expect(control).toHaveAttribute("data-action", "reveal");

    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await control.click();
    await expect
      .poll(async () =>
        commandCalls(await readMockCallLog(page), "reveal_local_path"),
      )
      .toEqual([
        { command: "reveal_local_path", args: { path: DOWNLOAD_DESTINATION } },
      ]);
    await saveArtifact(page, testInfo, "completed-download-reveal");
  });

  test("running download has no Show in folder control", async ({
    page,
  }, testInfo) => {
    await installRevealMocks(page, { holdDownloads: true });
    await openListingWithOneFile(page);
    await startDownloadOfFirstFile(page);
    await showTransferList(page);
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "download_object"))
      .toBe(1);

    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).not.toContainText("Completed");
    await expect(revealControl(page, DOWNLOAD_NAME)).toHaveCount(0);
    await expect(row.locator('[data-action="reveal"]')).toHaveCount(0);
    await saveArtifact(page, testInfo, "running-download-no-reveal");
  });

  test("failed download has no Show in folder control", async ({
    page,
  }, testInfo) => {
    await installRevealMocks(page);
    await openListingWithOneFile(page, {
      errors: { download_object: "Access denied" },
    });
    await startDownloadOfFirstFile(page);
    await showTransferList(page);

    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).toHaveAttribute("data-status", "error");
    await expect(revealControl(page, DOWNLOAD_NAME)).toHaveCount(0);
    await expect(row.locator('[data-action="reveal"]')).toHaveCount(0);
    expect(countOf(await readMockCallLog(page), "reveal_local_path")).toBe(0);
    await saveArtifact(page, testInfo, "failed-download-no-reveal");
  });

  test("completed upload has no Show in folder control", async ({
    page,
  }, testInfo) => {
    await installRevealMocks(page);
    await openListingWithOneFile(page);
    await startUploadFromToolbar(page);
    await showTransferList(page);

    // The mock's post-upload size check may fail the row; either terminal
    // status is fine. The point is that an upload never gets the control.
    const row = page.locator("#transfer-list .transfer-item").first();
    await expect(row).toContainText("Upload");
    await expect(row).not.toHaveAttribute("data-status", /queued|uploading/);
    await expect(row.locator('[data-action="reveal"]')).toHaveCount(0);
    await expect(
      page.locator('#transfer-list [data-action="reveal"]'),
    ).toHaveCount(0);
    expect(countOf(await readMockCallLog(page), "reveal_local_path")).toBe(0);
    await saveArtifact(page, testInfo, "upload-no-reveal");
  });
});
