import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  setMockCommandError,
} from "./tauri-layout";

const stalePreviewText = "STALE_PREVIEW_PAYLOAD_FOR_OBJECT_A";
const byteUploadError = "Mock terminal browser byte-upload error";
const verificationError = "Mock terminal upload verification error";

interface PreviewCall {
  command: string;
  args: Record<string, unknown>;
}

interface PreviewRaceHarness {
  heldCalls: number;
  calls: PreviewCall[];
  release?: () => void;
}

type PreviewScenario = "folder" | "multiple files" | "empty selection";

async function holdPreviewForObject(
  page: Page,
  expectedKey: string,
): Promise<void> {
  await page.evaluate((key) => {
    type TestWindow = Window & {
      __TAURI_INTERNALS__?: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      __S3_LAYOUT_TEST__?: {
        callLog: Array<{ command: string; args: unknown }>;
      };
      __PREVIEW_RACE_HARNESS__?: PreviewRaceHarness;
    };

    const testWindow = window as TestWindow;
    const internals = testWindow.__TAURI_INTERNALS__;
    const mockState = testWindow.__S3_LAYOUT_TEST__;
    if (!internals || !mockState) {
      throw new Error("The existing Tauri layout mock is not installed");
    }

    const originalInvoke = internals.invoke.bind(internals);
    const harness: PreviewRaceHarness = { heldCalls: 0, calls: [] };
    testWindow.__PREVIEW_RACE_HARNESS__ = harness;

    internals.invoke = async (command, args = {}) => {
      if (command === "preview_object") {
        harness.calls.push({ command, args });
        if (args.key === key && harness.heldCalls === 0) {
          harness.heldCalls += 1;
          mockState.callLog.push({
            command,
            args: JSON.parse(JSON.stringify(args)),
          });
          return await new Promise((resolve) => {
            harness.release = () =>
              resolve({
                content_type: "text/plain",
                data: "STALE_PREVIEW_PAYLOAD_FOR_OBJECT_A",
                is_text: true,
                truncated: false,
                total_size: 37,
              });
          });
        }
      }
      return originalInvoke(command, args);
    };
  }, expectedKey);
}

async function switchInspectorSelection(
  page: Page,
  scenario: PreviewScenario,
): Promise<void> {
  if (scenario === "folder") {
    await page.locator(".object-row--folder").first().click();
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "archive/",
    );
  } else if (scenario === "multiple files") {
    await page
      .locator(".object-row--file")
      .nth(1)
      .locator(".row-check")
      .check();
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "2 selected",
    );
  } else {
    const deselectAll = page.locator("#batch-deselect");
    if (await deselectAll.isVisible()) {
      await deselectAll.click();
    } else {
      await page.locator("#batch-more").click();
      await page
        .locator('.context-menu [role="menuitem"]', { hasText: "Deselect All" })
        .click();
    }
    await expect(page.locator("#inspector-empty")).toBeVisible();
  }

  if (scenario !== "empty selection") {
    await expect(
      page.locator('[data-inspector-tab="properties"]'),
    ).toHaveAttribute("aria-selected", "true");
  }

  // Unavailable tabs carry aria-disabled for accessibility, while the
  // production click handler still renders the selection explanation.
  await page.locator('[data-inspector-tab="preview"]').click({ force: true });
}

async function inspectorSnapshot(page: Page) {
  return page.evaluate(() => {
    const testWindow = window as Window & {
      __PREVIEW_RACE_HARNESS__?: PreviewRaceHarness;
    };
    const panel = document.querySelector<HTMLElement>("#inspector-panel");
    const preview = document.querySelector<HTMLElement>(
      "#inspector-preview-body",
    );
    const empty = document.querySelector<HTMLElement>("#inspector-empty");
    return {
      title: document.querySelector("#inspector-header-title")?.textContent,
      inspectorVisible: panel ? !panel.hidden : false,
      previewPaneVisible: !document.querySelector<HTMLElement>(
        "#inspector-pane-preview",
      )?.hidden,
      previewBody: preview?.innerText ?? "",
      emptyMessage: empty?.innerText ?? "",
      emptyVisible: empty ? !empty.hidden : false,
      selectedKeys: Array.from(
        document.querySelectorAll<HTMLElement>(".object-row--selected"),
        (row) => row.dataset.key ?? `prefix:${row.dataset.prefix ?? ""}`,
      ),
      previewCalls: testWindow.__PREVIEW_RACE_HARNESS__?.calls ?? [],
    };
  });
}

for (const scenario of [
  "folder",
  "multiple files",
  "empty selection",
] as const) {
  test(`does not render a stale preview after switching to ${scenario}`, async ({
    page,
  }, testInfo) => {
    await openMockListing(page, {
      objectCount: 4,
      longFileCount: 0,
      prefixes: ["archive/"],
    });
    const firstFile = page.locator(".object-row--file").first();
    const objectKey = await firstFile.getAttribute("data-key");
    expect(objectKey).toBeTruthy();
    await holdPreviewForObject(page, objectKey!);

    await firstFile.click();
    if (await page.locator("#inspector-panel").isHidden()) {
      await page.locator("#btn-inspector").click();
    }
    await page.waitForFunction(
      () =>
        (
          window as Window & {
            __PREVIEW_RACE_HARNESS__?: PreviewRaceHarness;
          }
        ).__PREVIEW_RACE_HARNESS__?.heldCalls === 1,
      null,
      { timeout: 10_000 },
    );

    await switchInspectorSelection(page, scenario);
    if (scenario === "folder") {
      await expect(
        page.locator("#inspector-preview-body .inspector-preview-unavailable"),
      ).toHaveText("Preview is available for files only.");
    } else if (scenario === "multiple files") {
      await expect(
        page.locator("#inspector-preview-body .inspector-preview-unavailable"),
      ).toHaveText("Preview is available for a single previewable file.");
    } else {
      await expect(page.locator("#inspector-empty")).toHaveText(
        "Select an object to inspect.",
      );
    }

    const beforeRelease = await inspectorSnapshot(page);
    await page.evaluate(() => {
      const testWindow = window as Window & {
        __PREVIEW_RACE_HARNESS__?: PreviewRaceHarness;
      };
      const release = testWindow.__PREVIEW_RACE_HARNESS__?.release;
      if (!release) throw new Error("The held preview has no release callback");
      release();
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() => resolve()),
          ),
        ),
    );

    const afterRelease = await inspectorSnapshot(page);
    const calls = await readMockCallLog(page);
    const artifactName = `preview-${scenario.replaceAll(" ", "-")}`;
    await saveArtifact(
      page,
      testInfo,
      "ui-security-regressions",
      artifactName,
      calls,
    );
    const resultDir = path.join(
      "test-results",
      "ui-security-regressions",
      testInfo.project.name,
      artifactName,
    );
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(
      path.join(resultDir, "selection-race.json"),
      `${JSON.stringify(
        {
          scenario,
          objectKey,
          beforeRelease,
          afterRelease,
          previewObjectIpcCount: calls.filter(
            (call) => call.command === "preview_object",
          ).length,
        },
        null,
        2,
      )}\n`,
    );

    expect(afterRelease.previewBody).not.toContain(stalePreviewText);
    expect(
      calls.filter((call) => call.command === "preview_object"),
    ).toHaveLength(1);
    if (scenario === "folder") {
      expect(afterRelease.selectedKeys).toEqual(["prefix:archive/"]);
      expect(afterRelease.previewBody).toBe(
        "Preview is available for files only.",
      );
    } else if (scenario === "multiple files") {
      expect(afterRelease.selectedKeys).toHaveLength(2);
      expect(afterRelease.previewBody).toBe(
        "Preview is available for a single previewable file.",
      );
    } else {
      expect(afterRelease.selectedKeys).toHaveLength(0);
      expect(afterRelease.emptyVisible).toBe(true);
      expect(afterRelease.emptyMessage).toBe("Select an object to inspect.");
    }
  });
}

test("retries a pathless browser File after upload and verification failures", async ({
  page,
}, testInfo) => {
  await openMockListing(page, { objectCount: 0, prefixes: [] });
  await setMockCommandError(page, "upload_object_bytes", byteUploadError);

  const fileDetails = await page.evaluate(async () => {
    const file = new File([new Uint8Array(1024)], "browser-only.txt", {
      type: "text/plain",
    });
    const transfers = (await import(
      /* @vite-ignore */ new URL("/transfers.ts", window.location.href).href
    )) as {
      enqueueFiles(files: File[], targetPrefix: string): void;
    };
    transfers.enqueueFiles([file], "browser-upload/");
    const pathlessFile = file as File & { path?: string };
    return {
      name: file.name,
      size: file.size,
      filePath: typeof pathlessFile.path === "string" ? pathlessFile.path : "",
    };
  });
  expect(fileDetails).toEqual({
    name: "browser-only.txt",
    size: 1024,
    filePath: "",
  });

  const row = page.locator("#transfer-list .transfer-item").first();
  await expect(row.locator(".transfer-error")).toContainText(byteUploadError);
  await showTransferList(page);
  await setMockCommandError(page, "upload_object_bytes", null);
  await setMockCommandError(page, "head_object", verificationError);
  await page.locator("#transfer-more").click();
  await page
    .locator('.context-menu [role="menuitem"]', { hasText: "Retry failed" })
    .click();
  await expect(row.locator(".transfer-error")).toContainText(verificationError);

  const afterVerificationFailure = await readMockCallLog(page);
  expect(
    afterVerificationFailure.filter(
      (call) => call.command === "upload_object_bytes",
    ),
  ).toHaveLength(2);

  await setMockCommandError(page, "head_object", null);
  await page.locator("#transfer-more").click();
  await page
    .locator('.context-menu [role="menuitem"]', { hasText: "Retry failed" })
    .click();
  await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(0);

  const calls = await readMockCallLog(page);
  const uploadCalls = calls
    .filter((call) => call.command === "upload_object_bytes")
    .map((call) => call.args as Record<string, unknown>);
  expect(uploadCalls).toHaveLength(3);
  expect(uploadCalls[0].bytesBase64).toBe(uploadCalls[1].bytesBase64);
  expect(uploadCalls[1].bytesBase64).toBe(uploadCalls[2].bytesBase64);
  await saveArtifact(
    page,
    testInfo,
    "ui-security-regressions",
    "browser-file-retry",
    calls,
  );
  const resultDir = path.join(
    "test-results",
    "ui-security-regressions",
    testInfo.project.name,
    "browser-file-retry",
  );
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    path.join(resultDir, "retry-result.json"),
    `${JSON.stringify(
      {
        fileDetails,
        attemptCount: uploadCalls.length,
        retryContentsStable: uploadCalls.every(
          (call) => call.bytesBase64 === uploadCalls[0].bytesBase64,
        ),
        finalTransferRows: await page
          .locator("#transfer-list .transfer-item")
          .count(),
        uploadCommands: uploadCalls.map(({ key, transferId }) => ({
          key,
          transferId,
        })),
      },
      null,
      2,
    )}\n`,
  );
});

async function showTransferList(page: Page): Promise<void> {
  const list = page.locator("#transfer-list");
  if (!(await list.isVisible())) {
    await page.locator("#transfer-toggle").click();
  }
  await expect(list).toBeVisible();
}
