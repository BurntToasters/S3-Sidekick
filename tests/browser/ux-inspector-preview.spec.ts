import { expect, test, type Locator, type Page } from "@playwright/test";
import { openMockListing, readMockCallLog } from "./tauri-layout";

// Preview eligibility and presentation in the docked and off-canvas inspector.

const ROOT_OBJECTS = [
  {
    key: "notes.txt",
    size: 120,
    last_modified: "2025-01-01T12:00:00.000Z",
    is_folder: false,
  },
  {
    key: "archive.zip",
    size: 2048,
    last_modified: "2025-01-01T12:01:00.000Z",
    is_folder: false,
  },
  {
    key: "photo.png",
    size: 5_000_000,
    last_modified: "2025-01-01T12:02:00.000Z",
    is_folder: false,
  },
];

/**
 * Head and preview answers for the three fixtures. The native preview command
 * decides from the HEAD content type; this wrapper answers the same way so the
 * webview's handling of each status is what the test exercises.
 */
async function openPreviewRoot(page: Page): Promise<void> {
  await page.addInitScript((extra) => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    const types: Record<string, string> = {
      "notes.txt": "text/plain",
      "archive.zip": "application/zip",
      "photo.png": "image/png",
    };
    let internals: { invoke: Invoke } | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (value: { invoke: Invoke }) => {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          const key = String(args?.key ?? "");
          if (command === "list_objects" && !args?.prefix) {
            const result = (await original(command, args)) as {
              objects: unknown[];
            };
            return { ...result, objects: [...extra, ...result.objects] };
          }
          if (command === "head_object") {
            await original(command, args);
            const object = extra.find((item) => item.key === key);
            return {
              content_type: types[key] ?? "application/octet-stream",
              content_length: object?.size ?? 0,
              last_modified: "2025-01-01T12:00:00.000Z",
              etag: '"etag-preview"',
              storage_class: "STANDARD",
              cache_control: "",
              content_disposition: "",
              content_encoding: "",
              server_side_encryption: "",
              metadata: {},
            };
          }
          if (command === "preview_object") {
            await original(command, args);
            if (key === "photo.png") {
              return {
                content_type: "image/png",
                data: "",
                is_text: false,
                truncated: false,
                total_size: 5_000_000,
              };
            }
            return {
              content_type: "text/plain",
              data: `preview of ${key}`,
              is_text: true,
              truncated: false,
              total_size: 16,
            };
          }
          if (command === "get_object_acl") {
            await original(command, args);
            return { owner: "owner", grants: [] };
          }
          if (command === "build_object_url") {
            await original(command, args);
            return `https://example.invalid/${key}`;
          }
          return original(command, args);
        };
        internals = value;
      },
    });
  }, ROOT_OBJECTS);
  await openMockListing(page, { objectCount: 0, prefixes: ["archive/"] });
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(".object-row--file", {
    has: page.locator(".object-name__text", { hasText: name }),
  });
}

test.describe("inspector preview eligibility", () => {
  test("a non-previewable file disables Preview and never fetches content", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await fileRow(page, "archive.zip").locator(".object-name").click();
    const previewTab = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    await expect(previewTab).toHaveAttribute("aria-disabled", "true");

    // Playwright treats aria-disabled as not enabled, so force the click: the
    // tab stays clickable so the user is told why there is no preview.
    await previewTab.click({ force: true });
    await expect(page.locator("#inspector-preview-body")).toContainText(
      "Preview not available for this file type.",
    );
    const calls = await readMockCallLog(page);
    expect(
      calls.filter((call) => call.command === "preview_object"),
    ).toHaveLength(0);
  });

  test("an image over the preview limit shows Too large with a Download action", async ({
    page,
  }) => {
    await openPreviewRoot(page);
    await fileRow(page, "photo.png").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="preview"]')
      .click();

    const body = page.locator("#inspector-preview-body");
    await expect(body).toContainText("Too large to preview");
    await expect(body.locator("img")).toHaveCount(0);
    await expect(body.getByRole("button", { name: "Download" })).toBeVisible();
  });
});

test.describe("inspector preview presentation", () => {
  test("the docked preview keeps its file name visible", async ({ page }) => {
    await openPreviewRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    const title = page.locator("#inspector-preview-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("notes.txt");
  });

  test("the off-canvas inspector does not repeat the file name heading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 640 });
    await openPreviewRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    if (!(await page.locator("#inspector-panel").isVisible())) {
      await page.locator("#btn-inspector").click();
    }
    await expect(page.locator("#inspector-header-title")).toHaveText(
      "notes.txt",
    );
    await expect(page.locator("#inspector-preview-title")).toBeHidden();
  });
});
