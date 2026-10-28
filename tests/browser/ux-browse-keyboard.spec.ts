// Failure modes covered (UI/UX audit 0.12.0, browse table and keyboard):
// - Sorting by size or date lists folders Z to A instead of A to Z.
// - The palette's "Clear Filter" resets the input but leaves rows filtered.
// - Every row checkbox is its own Tab stop, so Tab crawls through the table.
// - The header row has no aria-rowindex, and placeholder rows have none either.
// - The batch-count live region is rewritten on every filter keystroke.
// - A navigation failure is announced by both the status line and an error toast.
// - Shift+Arrow replaces the selection instead of extending from the anchor, so
//   rows selected before the range are dropped and the range cannot shrink.
// - Hover shows an accent bar that selected rows lack, so hover can outrank
//   selection.
// - PageUp/PageDown do not move focus by a visible page of rows.
// - Typing a name does not jump to the matching row (type-ahead is missing).
// - Shift+F10 and the ContextMenu key do not open the focused row's menu.
// - Escape does not clear the object selection once no other layer is open.
// - Virtualized rows ignore the --row-height density token and stay at 36px.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  setMockCommandError,
  type LayoutMockOptions,
} from "./tauri-layout";

const SUITE = "ux-browse-keyboard";
const DEFAULT_ROW_PX = 36;

function rowAt(page: Page, index: number): Locator {
  return page.locator(
    `#object-tbody .object-row[data-logical-index="${index}"]`,
  );
}

function folderRow(page: Page, prefix: string): Locator {
  return page.locator(
    `#object-tbody .object-row--folder[data-prefix="${prefix}"]`,
  );
}

const THREE_FOLDERS: LayoutMockOptions = {
  objectCount: 3,
  prefixes: ["alpha/", "bravo/", "charlie/"],
};

async function folderOrder(page: Page): Promise<string[]> {
  return page
    .locator("#object-tbody .object-row--folder")
    .evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.prefix ?? ""),
    );
}

test.describe("browse table sorting, filter and live announcements", () => {
  test("folders stay A to Z when sorting by size or date", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, THREE_FOLDERS);

    await page.locator('th[data-sort="size"] .sort-trigger').click();
    expect(await folderOrder(page)).toEqual(["alpha/", "bravo/", "charlie/"]);

    await page.locator('th[data-sort="modified"] .sort-trigger').click();
    expect(await folderOrder(page)).toEqual(["alpha/", "bravo/", "charlie/"]);

    // The name column alone follows the chosen direction for folders.
    await page.locator('th[data-sort="name"] .sort-trigger').click();
    await page.locator('th[data-sort="name"] .sort-trigger').click();
    expect(await folderOrder(page)).toEqual(["charlie/", "bravo/", "alpha/"]);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "folder-sort",
      await readMockCallLog(page),
    );
  });

  test("palette Clear Filter restores every row", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, THREE_FOLDERS);
    await page.locator("#filter-input").fill("bravo");
    await expect(page.locator("#object-tbody .object-row")).toHaveCount(1);

    await page.locator("#btn-palette").click();
    await page.locator("#palette-input").fill("Clear Filter");
    await page
      .locator("#palette-results .palette__item", { hasText: "Clear Filter" })
      .click();

    await expect(page.locator("#filter-input")).toHaveValue("");
    await expect(page.locator("#object-tbody .object-row")).toHaveCount(6);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "palette-clear-filter",
      await readMockCallLog(page),
    );
  });

  test("clearFilter re-renders synchronously and cancels a pending filter update", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, THREE_FOLDERS);
    await page.locator("#filter-input").fill("bravo");
    await expect(page.locator("#object-tbody .object-row")).toHaveCount(1);

    const rowsAfterClear = await page.evaluate(async () => {
      const url =
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/browser\.ts(\?|$)/.test(name)) ??
        new URL("/browser.ts", window.location.href).href;
      const mod = (await import(/* @vite-ignore */ url)) as {
        clearFilter: () => void;
      };
      mod.clearFilter();
      return document.querySelectorAll("#object-tbody .object-row").length;
    });
    expect(rowsAfterClear).toBe(6);

    // A filter update still pending when the filter is cleared must not
    // re-apply the stale text after the clear.
    await page.evaluate(async () => {
      const url =
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/browser\.ts(\?|$)/.test(name)) ??
        new URL("/browser.ts", window.location.href).href;
      const mod = (await import(/* @vite-ignore */ url)) as {
        clearFilter: () => void;
      };
      const input = document.getElementById("filter-input") as HTMLInputElement;
      input.value = "zzz-no-match";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      mod.clearFilter();
    });
    await page.waitForTimeout(250);
    await expect(page.locator("#filter-input")).toHaveValue("");
    await expect(page.locator("#object-tbody .object-row")).toHaveCount(6);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "clear-filter-sync",
      await readMockCallLog(page),
    );
  });

  test("the row table is one Tab stop and row checkboxes stay clickable", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 4, prefixes: ["archive/"] });

    const tabbableRowChecks = await page
      .locator("#object-tbody .row-check")
      .evaluateAll(
        (inputs) =>
          inputs.filter((input) => (input as HTMLInputElement).tabIndex >= 0)
            .length,
      );
    expect(tabbableRowChecks).toBe(0);
    await expect(
      page.locator("#object-tbody .object-row[tabindex='0']"),
    ).toHaveCount(1);

    const check = rowAt(page, 1).locator(".row-check");
    await expect(check).toHaveAttribute("aria-label", /Select file/);
    await check.click();
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "single-tab-stop",
      await readMockCallLog(page),
    );
  });

  test("header row is aria-rowindex 1 and body rows follow it", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 2, prefixes: ["archive/"] });
    await expect(page.locator("#object-panel thead tr")).toHaveAttribute(
      "aria-rowindex",
      "1",
    );
    await expect(rowAt(page, 0)).toHaveAttribute("aria-rowindex", "2");

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "row-index",
      await readMockCallLog(page),
    );
  });

  test("an empty listing placeholder takes the first body row index", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 0, prefixes: [] });
    await expect(
      page.locator("#object-tbody [data-table-placeholder]"),
    ).toHaveAttribute("aria-rowindex", "2");

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "placeholder-row-index",
      await readMockCallLog(page),
    );
  });

  test("typing in the filter announces the summary once after it settles", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 40, prefixes: ["archive/"] });
    await page.evaluate(() => {
      const announcer = document.querySelector("[data-batch-announcer]");
      if (!announcer) throw new Error("no batch announcer");
      const counter = { mutations: 0 };
      (
        window as unknown as { __batchMutations: typeof counter }
      ).__batchMutations = counter;
      new MutationObserver(() => {
        counter.mutations += 1;
      }).observe(announcer, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    await page
      .locator("#filter-input")
      .pressSequentially("archive", { delay: 25 });
    const during = await page.evaluate(
      () =>
        (window as unknown as { __batchMutations: { mutations: number } })
          .__batchMutations.mutations,
    );
    expect(during).toBe(0);

    await expect(page.locator("[data-batch-announcer]")).toContainText(
      "matching",
    );
    const settled = await page.evaluate(
      () =>
        (window as unknown as { __batchMutations: { mutations: number } })
          .__batchMutations.mutations,
    );
    expect(settled).toBe(1);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "filter-announce",
      await readMockCallLog(page),
    );
  });

  test("a navigation failure is announced once", async ({ page }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await setMockCommandError(
      page,
      "list_objects",
      "simulated listing failure",
    );

    await folderRow(page, "archive/").dblclick();
    await expect(page.locator("#status")).toContainText(
      "Failed to open folder",
    );

    const announcements = page
      .locator('[role="status"], [role="alert"]')
      .filter({ hasText: "Failed to open folder" });
    await expect(announcements).toHaveCount(1);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "nav-failure-once",
      await readMockCallLog(page),
    );
  });
});

test.describe("keyboard selection, roving focus and menus", () => {
  test("Shift+Arrow extends from the anchor and keeps earlier selection", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 8, prefixes: ["archive/"] });

    // Row 1 is the anchor; Space on row 4 adds it to the selection and moves
    // the anchor there without a range, so row 1 must survive the range below.
    await rowAt(page, 1).click();
    await rowAt(page, 4).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#batch-count")).toHaveText("2 files selected");

    await page.keyboard.press("Shift+ArrowDown");
    await expect(rowAt(page, 5)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText("3 files selected");

    await page.keyboard.press("Shift+ArrowUp");
    await expect(rowAt(page, 4)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText("2 files selected");

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "shift-arrow-anchor",
      await readMockCallLog(page),
    );
  });

  test("selected rows are stronger than hover and hover has no accent bar", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 4, prefixes: ["archive/"] });
    await rowAt(page, 1).click();
    await rowAt(page, 2).hover();

    const styles = await page.evaluate(() => {
      const read = (index: number) => {
        const row = document.querySelector<HTMLElement>(
          `#object-tbody .object-row[data-logical-index="${index}"]`,
        );
        if (!row) throw new Error(`no row ${index}`);
        const style = getComputedStyle(row);
        return {
          background: style.backgroundColor,
          shadow: style.boxShadow,
        };
      };
      return { selected: read(1), hovered: read(2) };
    });
    expect(styles.selected.shadow).not.toBe("none");
    expect(styles.hovered.shadow).toBe("none");
    expect(styles.selected.background).not.toBe(styles.hovered.background);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "hover-vs-selection",
      await readMockCallLog(page),
    );
  });

  test("PageDown and Shift+PageDown move by one visible page", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 120, prefixes: ["archive/"] });
    // A page is the panel height minus the sticky header, in default rows.
    const pageRows = await page
      .locator("#object-panel")
      .evaluate((panel, rowPx) => {
        const header = panel.querySelector("thead")?.offsetHeight ?? 0;
        return Math.max(1, Math.floor((panel.clientHeight - header) / rowPx));
      }, DEFAULT_ROW_PX);
    expect(pageRows).toBeGreaterThan(1);

    await rowAt(page, 1).click();
    await page.keyboard.press("PageDown");
    await expect(rowAt(page, 1 + pageRows)).toBeFocused();

    await rowAt(page, 1 + pageRows).click();
    await page.keyboard.press("Shift+PageDown");
    await expect(rowAt(page, 1 + 2 * pageRows)).toBeFocused();
    await expect(page.locator("#batch-count")).toHaveText(
      `${2 * pageRows + 1 - pageRows} files selected`,
    );

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "page-keys",
      await readMockCallLog(page),
    );
  });

  test("type-ahead jumps to the next row by name and resets after one idle second", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, THREE_FOLDERS);
    await rowAt(page, 0).focus();

    await page.keyboard.press("b");
    await expect(folderRow(page, "bravo/")).toBeFocused();

    await page.waitForTimeout(1100);
    await page.keyboard.press("C");
    await expect(folderRow(page, "charlie/")).toBeFocused();

    await page.keyboard.press("Control+b");
    await expect(folderRow(page, "charlie/")).toBeFocused();

    await page.waitForTimeout(1100);
    await page.keyboard.press("b");
    await expect(folderRow(page, "bravo/")).toBeFocused();

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "type-ahead",
      await readMockCallLog(page),
    );
  });

  test("Shift+F10 and the ContextMenu key open the focused row menu", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await rowAt(page, 1).focus();

    await page.keyboard.press("Shift+F10");
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(rowAt(page, 1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toBeHidden();

    await rowAt(page, 1).focus();
    await page.keyboard.press("ContextMenu");
    await expect(page.locator(".context-menu")).toBeVisible();

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "context-menu-keys",
      await readMockCallLog(page),
    );
  });

  test("Escape clears the object selection but not while typing in the filter", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 3, prefixes: ["archive/"] });
    await rowAt(page, 1).click();
    await expect(page.locator("#batch-count")).toHaveText("1 file selected");

    await page.locator("#filter-input").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#batch-toolbar")).toHaveAttribute(
      "data-selection-state",
      "selected",
    );

    await rowAt(page, 1).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#batch-toolbar")).toHaveAttribute(
      "data-selection-state",
      "idle",
    );

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "escape-clears-selection",
      await readMockCallLog(page),
    );
  });

  test("rows follow the --row-height density token and virtualization stays aligned", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 300, prefixes: ["archive/"] });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--row-height", "28px");
      document.documentElement.setAttribute("data-density", "compact");
    });
    await expect
      .poll(() =>
        page
          .locator("#object-tbody .object-row")
          .first()
          .evaluate((row) => row.getBoundingClientRect().height),
      )
      .toBeCloseTo(28, 0);

    await page.locator("#object-panel").evaluate((panel) => {
      panel.scrollTop = 150 * 28;
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const first = document.querySelector<HTMLElement>(
            "#object-tbody .object-row",
          );
          return Number(first?.dataset.logicalIndex ?? -1);
        }),
      )
      .toBeGreaterThan(100);

    const alignment = await page.evaluate(() => {
      const spacer = document.querySelector<HTMLElement>(
        ".object-virtual-spacer--top td",
      );
      const first = document.querySelector<HTMLElement>(
        "#object-tbody .object-row",
      );
      return {
        spacerPx: Number.parseFloat(spacer?.style.height ?? "0"),
        firstIndex: Number(first?.dataset.logicalIndex ?? -1),
      };
    });
    expect(alignment.spacerPx).toBe(alignment.firstIndex * 28);

    await saveArtifact(
      page,
      testInfo,
      SUITE,
      "density-row-height",
      await readMockCallLog(page),
    );
  });
});
