import { expect, test, type Page } from "@playwright/test";
import { saveArtifact } from "./helpers";
import { openMockListing, readMockCallLog } from "./tauri-layout";

const ARTIFACT_SUITE = "ux-deferred-location";

/**
 * Replace the delimited (main) listing with a fixed one, optionally reporting
 * more pages. The mock otherwise returns the same listing for every prefix,
 * which is enough to exercise navigation but not pagination.
 */
async function overrideMainListing(
  page: Page,
  listing: {
    objects: Array<{
      key: string;
      size: number;
      last_modified: string;
      is_folder: boolean;
    }>;
    prefixes?: string[];
    truncated?: boolean;
    next_continuation_token?: string;
  },
): Promise<void> {
  await page.addInitScript((override) => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    let internals: { invoke: Invoke } | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (value: { invoke: Invoke }) => {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          if (command === "list_objects" && args?.delimiter === "/") {
            return {
              objects: override.objects,
              prefixes: override.prefixes ?? [],
              truncated: override.truncated ?? false,
              next_continuation_token: override.next_continuation_token ?? "",
            };
          }
          return original(command, args);
        };
        internals = value;
      },
    });
  }, listing);
}

function omnibarCurrentSegment(page: Page) {
  return page.locator('#location-omnibar-browse [aria-current="page"]');
}

async function typeLocation(page: Page, value: string): Promise<void> {
  await page.keyboard.press("Control+l");
  await expect(page.locator("#location-omnibar-edit")).toBeFocused();
  await page.locator("#location-omnibar-edit").fill(value);
  await page.keyboard.press("Enter");
}

test.describe("deferred location and listing fixes", () => {
  test("the Edit button enters location edit mode and is at least 24px tall", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    const edit = page.locator("#location-edit");
    await expect(edit).toHaveAttribute("aria-label", "Edit location");
    await expect(edit).toHaveAttribute("type", "button");
    const box = await edit.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await edit.click();
    await expect(page.locator("#location-omnibar-edit")).toBeVisible();
    await expect(page.locator("#location-omnibar-edit")).toBeFocused();
    await expect(page.locator("#location-omnibar-edit")).toHaveValue(
      "layout-test-bucket/",
    );
    await expect(edit).toBeHidden();

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "edit-button", []);
  });

  test("a file path selects the file in its parent folder instead of opening a fake folder", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await typeLocation(
      page,
      "layout-test-bucket/reports/001-sample-object.txt",
    );

    await expect(omnibarCurrentSegment(page)).toHaveText("reports");
    await expect(page.locator("#location-omnibar-browse")).not.toContainText(
      "001-sample-object.txt",
    );
    await expect(
      page.locator(".object-row--file", { hasText: "001-sample-object.txt" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "file-path", calls);
  });

  test("a bare key that names a loaded folder opens that folder", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await typeLocation(page, "layout-test-bucket/archive");

    await expect(omnibarCurrentSegment(page)).toHaveText("archive");
  });

  test("a trailing-slash path still opens the folder", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await typeLocation(page, "layout-test-bucket/archive/");

    await expect(omnibarCurrentSegment(page)).toHaveText("archive");
    await expect(page.locator("#location-omnibar-browse")).toContainText(
      "archive",
    );
  });

  test("a bare key missing from the loaded listing says so when more pages exist", async ({
    page,
  }, testInfo) => {
    await overrideMainListing(page, {
      objects: [
        {
          key: "reports/first.txt",
          size: 1,
          last_modified: "2025-01-01T00:00:00.000Z",
          is_folder: false,
        },
      ],
      truncated: true,
      next_continuation_token: "page-2",
    });
    await openMockListing(page, { objectCount: 0, prefixes: [] });

    await typeLocation(page, "layout-test-bucket/reports/later.txt");

    await expect(page.locator("#status")).toContainText(
      "not in the loaded listing",
    );
    const calls = await readMockCallLog(page);
    const listCalls = calls.filter((call) => call.command === "list_objects");
    expect(listCalls.length).toBeLessThanOrEqual(3);

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "not-loaded", calls);
  });

  test("select-all says it selects loaded items only while more pages exist", async ({
    page,
  }, testInfo) => {
    await overrideMainListing(page, {
      objects: [
        {
          key: "reports/first.txt",
          size: 1,
          last_modified: "2025-01-01T00:00:00.000Z",
          is_folder: false,
        },
        {
          key: "reports/second.log",
          size: 2,
          last_modified: "2025-01-02T00:00:00.000Z",
          is_folder: false,
        },
      ],
      truncated: true,
      next_continuation_token: "page-2",
    });
    await openMockListing(page, { objectCount: 0, prefixes: [] });

    const selectAll = page.locator("#select-all");
    await expect(selectAll).toHaveAccessibleName(/loaded items only/);
    await expect(selectAll).toHaveAttribute("title", /loaded items only/);

    await page.locator("#filter-input").fill("first");
    await expect(selectAll).toHaveAccessibleName(
      /loaded items that match the filter/,
    );

    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "select-all-partial",
      [],
    );
  });

  test("select-all keeps its plain label when the listing is complete", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await expect(page.locator("#select-all")).toHaveAccessibleName(
      "Select all",
    );
    await page.locator("#filter-input").fill("sample");
    await expect(page.locator("#select-all")).toHaveAccessibleName(
      "Select all (filtered)",
    );
  });
});
