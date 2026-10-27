import { expect, test, type Locator, type Page } from "@playwright/test";
import { commandCalls, saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  releaseMockListing,
} from "./tauri-layout";

const ARTIFACT_SUITE = "ux-browse";

interface ListingOverride {
  objects: Array<{
    key: string;
    size: number;
    last_modified: string;
    is_folder: boolean;
  }>;
  prefixes?: string[];
  truncated?: boolean;
  next_continuation_token?: string;
}

/**
 * Replace the main (delimited) listing the mock returns. Only the top-level
 * `list_objects` call is overridden; probes and paging keep the mock's shape.
 */
async function overrideMainListing(
  page: Page,
  listing: ListingOverride,
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

/** Report the platform as macOS so Command-based shortcuts are active. */
async function pretendMacos(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
          if (command === "get_platform_info") return "macos";
          return original(command, args);
        };
        internals = value;
      },
    });
  });
}

function rowAt(page: Page, index: number): Locator {
  return page.locator(
    `#object-tbody .object-row[data-logical-index="${index}"]`,
  );
}

test.describe("browse table, keyboard and location bar", () => {
  test("a failed bucket open shows an inline Retry row instead of an empty bucket", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { scenario: "error" });

    const errorRow = page.locator("#object-tbody [data-nav-error]");
    await expect(errorRow).toBeVisible();
    await expect(errorRow.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator("#object-tbody")).not.toContainText("is empty");

    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "bucket-open-error",
      calls,
    );
  });

  test("the Retry row on a failed open re-runs the listing", async ({
    page,
  }) => {
    await openMockListing(page, { scenario: "error" });
    const before = commandCalls(await readMockCallLog(page), "list_objects");

    await page
      .locator("#object-tbody [data-nav-error]")
      .getByRole("button", { name: "Retry" })
      .click();

    await expect
      .poll(
        async () =>
          commandCalls(await readMockCallLog(page), "list_objects").length,
      )
      .toBeGreaterThan(before.length);
  });

  test("an empty bucket root says Empty bucket, not Empty folder", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 0, prefixes: [] });

    await expect(page.locator("#object-tbody")).toContainText(
      "This bucket is empty",
    );
    await expect(page.locator("#object-tbody")).not.toContainText(
      "Empty folder",
    );
  });

  test("natural sort orders numbered names and the sort survives a reload", async ({
    page,
  }) => {
    await overrideMainListing(page, {
      objects: ["img10.txt", "img2.txt", "img1.txt"].map((name, index) => ({
        key: name,
        size: 100 * (index + 1),
        last_modified: `2025-01-0${index + 1}T00:00:00.000Z`,
        is_folder: false,
      })),
    });
    await openMockListing(page, { objectCount: 0, prefixes: [] });

    await expect(
      page.locator(".object-row--file .object-name__text"),
    ).toHaveText(["img1.txt", "img2.txt", "img10.txt"]);

    await page.locator('th[data-sort="size"] .sort-trigger').click();
    await expect(page.locator('th[data-sort="size"]')).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    await page.reload();
    await openMockListing(page, { objectCount: 0, prefixes: [] });
    await expect(page.locator('th[data-sort="size"]')).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  test("a partial listing says more objects are available", async ({
    page,
  }) => {
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

    await expect(page.locator("#batch-count")).toContainText("more available");
    await expect(page.locator("#batch-count")).toContainText(
      "cover loaded items only",
    );
  });

  test("a fast navigation never shows the skeleton", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await page.evaluate(() => {
      const flags = window as typeof window & { __sawSkeleton?: boolean };
      flags.__sawSkeleton = false;
      new MutationObserver(() => {
        if (document.querySelector(".object-row--skeleton")) {
          flags.__sawSkeleton = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.locator('.object-row--folder[data-prefix="archive/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".breadcrumb__segment", { hasText: "archive" }),
    ).toBeVisible();

    const saw = await page.evaluate(
      () =>
        (window as typeof window & { __sawSkeleton?: boolean }).__sawSkeleton,
    );
    expect(saw).toBe(false);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "fast-navigation", []);
  });

  test("a slow listing shows the skeleton once the delay passes", async ({
    page,
  }) => {
    await openMockListing(page, { scenario: "loading" });
    await expect(page.locator(".object-row--skeleton").first()).toBeVisible();
    await releaseMockListing(page);
    await expect(page.locator(".object-row--skeleton")).toHaveCount(0);
  });

  test("Enter on a folder leaves focus on the first row of the new listing", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await page.locator('.object-row--folder[data-prefix="archive/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".breadcrumb__segment", { hasText: "archive" }),
    ).toBeVisible();

    await expect(rowAt(page, 0)).toBeFocused();
  });

  test("Backspace goes up and focuses the folder just left", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await page.locator('.object-row--folder[data-prefix="archive/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".breadcrumb__segment", { hasText: "archive" }),
    ).toBeVisible();

    await page.keyboard.press("Backspace");
    await expect(page.locator(".breadcrumb__segment")).toHaveCount(1);
    await expect(
      page.locator('.object-row--folder[data-prefix="archive/"]'),
    ).toBeFocused();
  });

  test("Back restores the focused row of the folder we return to", async ({
    page,
  }) => {
    await openMockListing(page, {
      objectCount: 3,
      prefixes: ["archive/", "docs/"],
    });

    await page.locator('.object-row--folder[data-prefix="docs/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".breadcrumb__segment", { hasText: "docs" }),
    ).toBeVisible();

    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.locator(".breadcrumb__segment")).toHaveCount(1);
    await expect(
      page.locator('.object-row--folder[data-prefix="docs/"]'),
    ).toBeFocused();
  });

  test("arrow keys select the focused row and Shift+Arrow extends the range", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 5, prefixes: ["archive/"] });

    await rowAt(page, 1).focus();
    await page.keyboard.press("ArrowDown");
    await expect(rowAt(page, 2)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");
    await expect(rowAt(page, 2)).toHaveAttribute("aria-selected", "true");
    await expect(rowAt(page, 1)).toHaveAttribute("aria-selected", "false");

    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator("#batch-count")).toHaveText("2 files selected");

    await page.keyboard.press("Control+ArrowDown");
    await expect(rowAt(page, 4)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText("2 files selected");

    await page.keyboard.press("Space");
    await expect(page.locator("#batch-count")).toHaveText("3 files selected");

    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "keyboard-select",
      calls,
    );
  });

  test("a focused row checkbox does not block arrows or Delete", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await rowAt(page, 2).locator(".row-check").focus();
    await page.keyboard.press("ArrowDown");
    await expect(rowAt(page, 3)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");

    await page.keyboard.press("Delete");
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await expect(page.locator("#dialog-message")).toContainText(
      "Delete 1 file?",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).toBeHidden();
  });

  test("on macOS Command+Backspace deletes and plain Backspace goes up", async ({
    page,
  }) => {
    await pretendMacos(page);
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await page.locator('.object-row--folder[data-prefix="archive/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".breadcrumb__segment", { hasText: "archive" }),
    ).toBeVisible();

    await rowAt(page, 1).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");

    await page.keyboard.press("Meta+Backspace");
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await page.keyboard.press("Backspace");
    await expect(page.locator(".breadcrumb__segment")).toHaveCount(1);
  });

  test("Enter selects the focused row before opening it", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await rowAt(page, 1).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");
    await expect(rowAt(page, 1)).toHaveAttribute("aria-selected", "true");
  });

  test("the object table exposes grid semantics", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    const table = page.locator("table.object-table");
    await expect(table).toHaveAttribute("role", "grid");
    await expect(table).toHaveAttribute("aria-multiselectable", "true");
    await expect(table).toHaveAttribute("aria-rowcount", "5");
    await expect(
      page.locator("#object-tbody tr.object-row").first(),
    ).toHaveAttribute("role", "row");
  });

  test("clicking the empty part of the checkbox cell selects the row", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    const cell = rowAt(page, 1).locator("td.col-check");
    const box = await cell.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

    await cell.click({ position: { x: 2, y: 2 } });
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");
  });

  test("the root breadcrumb and sort triggers are at least 24px tall", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    const root = await page.locator(".breadcrumb__segment--root").boundingBox();
    expect(root?.height ?? 0).toBeGreaterThanOrEqual(24);

    const sort = await page
      .locator('th[data-sort="name"] .sort-trigger')
      .boundingBox();
    expect(sort?.height ?? 0).toBeGreaterThanOrEqual(24);
  });

  test("size cells carry no data-bar gradient", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: [] });

    const background = await page
      .locator(".object-row--file .object-size")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(background).toBe("none");
  });

  test("only the selection count is a live region", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await expect(page.locator("#batch-toolbar")).not.toHaveAttribute(
      "aria-live",
      /.*/,
    );
    await expect(page.locator("#batch-count")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  test("the selection toolbar stays on one row and More is always reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 640 });
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await rowAt(page, 1).locator(".row-check").check();

    const toolbar = await page.locator("#batch-toolbar").boundingBox();
    expect(toolbar?.height ?? 0).toBeLessThanOrEqual(36);

    const more = page.locator("#batch-more");
    await expect(more).toBeVisible();
    await more.click();
    await expect(
      page.locator('.context-menu [role="menuitem"]', { hasText: "Copy keys" }),
    ).toBeVisible();
  });

  test("the current breadcrumb segment is not a navigation control", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await page.locator('.object-row--folder[data-prefix="archive/"]').focus();
    await page.keyboard.press("Enter");
    const current = page.locator('[aria-current="page"]', {
      hasText: "archive",
    });
    await expect(current).toBeVisible();

    const before = commandCalls(await readMockCallLog(page), "list_objects");
    await current.click();
    await page.waitForTimeout(150);
    const after = commandCalls(await readMockCallLog(page), "list_objects");
    expect(after.length).toBe(before.length);
  });

  test("a single click on the location bar enters path edit mode", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    const bar = page.locator("#location-omnibar");
    const box = await bar.boundingBox();
    await bar.click({ position: { x: (box?.width ?? 40) - 6, y: 6 } });
    await expect(page.locator("#location-omnibar-edit")).toBeVisible();
    await expect(page.locator("#location-omnibar-edit")).toBeFocused();
  });

  test("Ctrl+L focuses the location editor", async ({ page }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await page.locator("#filter-input").focus();
    await page.keyboard.press("Control+l");
    await expect(page.locator("#location-omnibar-edit")).toBeFocused();
    await expect(page.locator("#location-omnibar-edit")).toHaveValue(
      "layout-test-bucket/",
    );
  });

  test("leaving the location editor closes it and restores the path", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });

    await page.keyboard.press("Control+l");
    await page.locator("#location-omnibar-edit").fill("junk/typed/");
    await page.locator("#filter-input").click();

    await expect(page.locator("#location-omnibar-edit")).toBeHidden();
    await expect(page.locator("#location-omnibar-browse")).toBeVisible();
    await expect(page.locator("#location-omnibar-browse")).toContainText(
      "layout-test-bucket",
    );
  });
});
