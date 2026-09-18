import { expect, test } from "@playwright/test";
import {
  openMockListing,
  releaseMockListing,
  type LayoutMockOptions,
} from "./tauri-layout.ts";

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PanelBoxes {
  listing: BoundingBox;
  sidebar: BoundingBox;
  inspector: BoundingBox;
}

function requireBoundingBox(
  box: BoundingBox | null,
  label: string,
): BoundingBox {
  if (!box) throw new Error(`${label} has no measurable bounding box`);
  return box;
}

async function panelBoxes(
  page: Parameters<typeof openMockListing>[0],
): Promise<PanelBoxes> {
  return {
    listing: requireBoundingBox(
      await page.locator(".content-main").boundingBox(),
      "object listing",
    ),
    sidebar: requireBoundingBox(
      await page.locator("#bucket-panel").boundingBox(),
      "bucket sidebar",
    ),
    inspector: requireBoundingBox(
      await page.locator("#inspector-panel").boundingBox(),
      "inspector panel",
    ),
  };
}

function expectPanelContainment(
  boxes: PanelBoxes,
  viewportWidth: number,
): void {
  const sidebarRight = boxes.sidebar.x + boxes.sidebar.width;
  const listingRight = boxes.listing.x + boxes.listing.width;
  const inspectorRight = boxes.inspector.x + boxes.inspector.width;
  expect(boxes.sidebar.x).toBeGreaterThanOrEqual(-1);
  expect(boxes.listing.x).toBeGreaterThanOrEqual(sidebarRight - 1);
  expect(boxes.listing.x).toBeGreaterThanOrEqual(-1);
  expect(boxes.inspector.x).toBeGreaterThanOrEqual(listingRight - 1);
  expect(boxes.inspector.x).toBeGreaterThanOrEqual(-1);
  expect(inspectorRight).toBeLessThanOrEqual(viewportWidth + 1);
}

async function rects(page: Parameters<typeof openMockListing>[0]) {
  return page.locator(".object-table").evaluate((table) => {
    const objectTable = table as HTMLTableElement;
    const header = Array.from(objectTable.tHead?.rows[0]?.cells ?? []).map(
      (cell) => {
        const rect = cell.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      },
    );
    const row =
      objectTable.tBodies[0]?.querySelector<HTMLElement>("tr.object-row");
    const cells = Array.from(row?.children ?? []).map((cell) => {
      const rect = (cell as HTMLElement).getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
      };
    });
    const rowHeights = Array.from(
      objectTable.tBodies[0]?.querySelectorAll<HTMLElement>("tr.object-row") ??
        [],
    ).map((candidate) => candidate.getBoundingClientRect().height);
    const tableRect = objectTable.getBoundingClientRect();
    return {
      header,
      cells,
      rowHeights,
      table: {
        left: tableRect.left,
        right: tableRect.right,
        width: tableRect.width,
      },
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

async function setTheme(
  page: Parameters<typeof openMockListing>[0],
  theme: "light" | "dark",
) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
  }, theme);
}

test.describe("production object table geometry", () => {
  test.use({ viewport: { width: 1100, height: 720 } });

  test("keeps native header and data columns aligned at exact row height", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 12 });
    const geometry = await rects(page);
    expect(geometry.header).toHaveLength(4);
    expect(geometry.cells).toHaveLength(4);
    for (let i = 0; i < geometry.header.length; i += 1) {
      expect(
        Math.abs(geometry.header[i].left - geometry.cells[i].left),
      ).toBeLessThan(1.5);
      expect(
        Math.abs(geometry.header[i].right - geometry.cells[i].right),
      ).toBeLessThan(1.5);
      expect(
        Math.abs(geometry.header[i].bottom - geometry.header[0].bottom),
      ).toBeLessThan(1.5);
      expect(
        Math.abs(geometry.cells[i].bottom - geometry.cells[0].bottom),
      ).toBeLessThan(1.5);
    }
    expect(geometry.rowHeights.length).toBeGreaterThanOrEqual(3);
    for (const height of geometry.rowHeights) {
      expect(Math.abs(height - 36)).toBeLessThanOrEqual(0.1);
    }
    expect(Math.abs(geometry.cells[0].height - 36)).toBeLessThanOrEqual(0.1);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    const panelWidths = await page
      .locator("#object-panel")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(panelWidths.scrollWidth).toBeGreaterThanOrEqual(520);

    const longName = page.locator(
      '.object-row--file .object-name[title*="quarterly-report-with-a-name"]',
    );
    await expect(longName).toHaveAttribute(
      "title",
      /quarterly-report-with-a-name/,
    );
    await page.screenshot({
      path: test.info().outputPath("table-desktop.png"),
    });
  });

  test("retains listing scroll and selected rows while moving through 0, 1, many, and 0", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 260 });
    await expect(page.locator(".object-table")).toHaveAttribute(
      "aria-rowcount",
      "262",
    );
    expect(await page.locator(".object-row").count()).toBeLessThan(262);
    const panel = page.locator("#object-panel");
    await panel.evaluate((element) => {
      element.scrollTop = 900;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(50);
    const fileRows = page.locator(".object-row--file");
    const visibleFileIndex = await fileRows.evaluateAll((rows) => {
      const panel = document.querySelector<HTMLElement>("#object-panel");
      const panelRect = panel?.getBoundingClientRect();
      if (!panelRect) return -1;
      return rows.findIndex((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= panelRect.top && rect.bottom <= panelRect.bottom;
      });
    });
    expect(visibleFileIndex).toBeGreaterThanOrEqual(0);
    const row = fileRows.nth(visibleFileIndex);
    await expect(row).toBeVisible();
    const before = requireBoundingBox(
      await row.boundingBox(),
      "selected row before selection",
    );
    const beforeScroll = await panel.evaluate((element) => element.scrollTop);
    await row.locator(".row-check").check();
    await expect(row).toHaveClass(/object-row--selected/);
    const afterOne = requireBoundingBox(
      await row.boundingBox(),
      "selected row after one selection",
    );
    expect(Math.abs(afterOne.y - before.y)).toBeLessThan(1);
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(
      beforeScroll,
    );

    const second = fileRows.nth(visibleFileIndex + 1);
    await second.locator(".row-check").check();
    await expect(page.locator("#batch-count")).toContainText("2 file");
    const afterMany = requireBoundingBox(
      await row.boundingBox(),
      "selected row after many selection",
    );
    expect(Math.abs(afterMany.y - before.y)).toBeLessThan(1);
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(
      beforeScroll,
    );

    const directDeselect = page.locator("#batch-deselect");
    if (await directDeselect.isVisible()) {
      await directDeselect.click();
    } else {
      await page.locator("#batch-more").click();
      await page
        .locator('.context-menu [role="menuitem"]', { hasText: "Deselect All" })
        .click();
    }
    await expect(page.locator("#batch-toolbar-actions")).toBeHidden();
    const afterZero = requireBoundingBox(
      await row.boundingBox(),
      "selected row after deselection",
    );
    expect(Math.abs(afterZero.y - before.y)).toBeLessThan(1);
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(
      beforeScroll,
    );
  });

  test("keeps hidden selections and reports a filter count", async ({
    page,
  }) => {
    await openMockListing(page, { objectCount: 12 });
    const row = page.locator(".object-row--file").first();
    const selectedKey = await row.getAttribute("data-key");
    await row.click();
    await page.locator("#filter-input").fill("no-object-matches-this-filter");
    await expect(page.locator("#batch-count")).toContainText(
      "hidden by filter",
    );
    await expect(page.locator(".object-row--selected")).toHaveCount(0);
    await page.locator("#filter-clear").click();
    await expect(page.locator("#filter-input")).toHaveValue("");
    await expect(
      page.locator(`.object-row[data-key="${selectedKey}"]`),
    ).toHaveClass(/object-row--selected/);
  });

  test("preserves selected-folder state and geometry while hovering", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMockListing(page, { objectCount: 12 });
    const folder = page.locator(".object-row--folder").first();
    const before = requireBoundingBox(
      await folder.boundingBox(),
      "folder before selection",
    );
    await folder.click();
    await expect(folder).toHaveClass(/object-row--selected/);
    await expect(folder).toHaveAttribute("aria-selected", "true");
    await expect(folder.locator(".row-check")).toBeChecked();

    await page.mouse.move(0, 0);
    const selectedBackground = await folder.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await folder.hover();
    const hoveredBackground = await folder.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const after = requireBoundingBox(
      await folder.boundingBox(),
      "folder after hover",
    );
    expect(hoveredBackground).toBe(selectedBackground);
    await expect(folder).toHaveClass(/object-row--selected/);
    await expect(folder).toHaveAttribute("aria-selected", "true");
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    await page.screenshot({
      path: test.info().outputPath("selected-folder.png"),
    });
  });
});

test.describe("production table at compact and wide viewports", () => {
  test("keeps the local table within the 760px viewport and opens mobile panels as slideouts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 520 });
    await openMockListing(page, { objectCount: 5 });
    const geometry = await rects(page);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await page.locator(".object-row--file").first().click();
    await page.locator("#btn-inspector").click();
    await expect(page.locator("#main-layout")).toHaveClass(
      /main-layout--inspector-open/,
    );
    const inspector = requireBoundingBox(
      await page.locator("#inspector-panel").boundingBox(),
      "compact inspector",
    );
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("compact viewport is unavailable");
    expect(inspector.x + inspector.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );
    expect(inspector.width).toBeLessThanOrEqual(670);
    await page.locator("#inspector-close").click();
    await expect(page.locator("#main-layout")).not.toHaveClass(
      /main-layout--inspector-open/,
    );
  });

  test("handles wide layouts, panel compression, dark theme, and reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await openMockListing(page, { objectCount: 16 });
    await page.locator(".object-row--file").first().click();
    await page.locator("#btn-inspector").click();
    await expect(page.locator("#inspector-panel")).toBeVisible();

    const inspectorResizer = requireBoundingBox(
      await page.locator("#inspector-resizer").boundingBox(),
      "inspector resizer",
    );
    await page.mouse.move(
      inspectorResizer.x + inspectorResizer.width / 2,
      inspectorResizer.y + inspectorResizer.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      inspectorResizer.x + inspectorResizer.width / 2 - 40,
      inspectorResizer.y + inspectorResizer.height / 2,
    );
    await page.mouse.up();
    await page.waitForTimeout(20);
    let widths = await panelBoxes(page);
    expectPanelContainment(widths, 1100);

    await page.locator("#sidebar-resizer").focus();
    await page.locator("#sidebar-resizer").press("End");
    await page.locator("#inspector-resizer").focus();
    await page.locator("#inspector-resizer").press("Home");
    await page.waitForTimeout(20);
    widths = await panelBoxes(page);
    expectPanelContainment(widths, 1100);
    expect(widths.listing.width).toBeGreaterThanOrEqual(360);
    expect(widths.sidebar.width).toBeGreaterThanOrEqual(200);
    expect(widths.sidebar.width).toBeLessThanOrEqual(420);
    expect(widths.inspector.width).toBeGreaterThanOrEqual(280);
    expect(widths.inspector.width).toBeLessThanOrEqual(560);

    await page.setViewportSize({ width: 901, height: 720 });
    await page.waitForTimeout(20);
    widths = await panelBoxes(page);
    expectPanelContainment(widths, 901);
    expect(widths.listing.width).toBeGreaterThanOrEqual(360);
    expect(widths.sidebar.width).toBeGreaterThanOrEqual(200);
    expect(widths.sidebar.width).toBeLessThanOrEqual(420);
    expect(widths.inspector.width).toBeGreaterThanOrEqual(280);
    expect(widths.inspector.width).toBeLessThanOrEqual(560);

    await page.locator("#inspector-close").click();
    await expect(page.locator("#inspector-panel")).toBeHidden();
    await page.locator("#btn-inspector").click();
    await expect(page.locator("#inspector-panel")).toBeVisible();

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(20);
    widths = await panelBoxes(page);
    expectPanelContainment(widths, 1920);
    expect(widths.listing.width).toBeGreaterThanOrEqual(360);
    expect(widths.sidebar.width).toBeGreaterThanOrEqual(419);
    expect(widths.sidebar.width).toBeLessThanOrEqual(421);
    expect(widths.inspector.width).toBeGreaterThanOrEqual(559);
    expect(widths.inspector.width).toBeLessThanOrEqual(561);

    await setTheme(page, "light");
    const lightBackground = await page
      .locator(".content-toolbar")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await setTheme(page, "dark");
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    const darkBackground = await page
      .locator(".content-toolbar")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(darkBackground).not.toBe("");
    expect(darkBackground).not.toBe(lightBackground);
    await page.locator("#transfer-toggle").click();
    await expect(page.locator("#bottom-drawer")).toBeVisible();
    expect(
      await page
        .locator("#bottom-drawer")
        .evaluate((element) => getComputedStyle(element).animationDuration),
    ).toBe("0s");
    const drawer = page.locator("#bottom-drawer");
    const openDrawer = requireBoundingBox(
      await drawer.boundingBox(),
      "open transfer drawer",
    );
    await page.locator("#drawer-minimize").click();
    await expect(drawer).toHaveClass(/bottom-drawer--minimized/);
    const minimizedDrawer = requireBoundingBox(
      await drawer.boundingBox(),
      "minimized transfer drawer",
    );
    const minimizedChrome = await drawer.evaluate((element) => {
      const header = element.querySelector<HTMLElement>(
        ".bottom-drawer__header",
      );
      const style = getComputedStyle(element);
      return {
        headerHeight: header?.getBoundingClientRect().height ?? 0,
        borderTop: Number.parseFloat(style.borderTopWidth) || 0,
        borderBottom: Number.parseFloat(style.borderBottomWidth) || 0,
      };
    });
    expect(minimizedChrome.headerHeight).toBeGreaterThan(0);
    expect(
      Math.abs(
        minimizedDrawer.height -
          (minimizedChrome.headerHeight +
            minimizedChrome.borderTop +
            minimizedChrome.borderBottom),
      ),
    ).toBeLessThanOrEqual(1);
    await page.locator("#drawer-minimize").click();
    await expect(drawer).not.toHaveClass(/bottom-drawer--minimized/);
    const restoredDrawer = requireBoundingBox(
      await drawer.boundingBox(),
      "restored transfer drawer",
    );
    expect(
      Math.abs(restoredDrawer.height - openDrawer.height),
    ).toBeLessThanOrEqual(1);

    await page.locator("#drawer-close").click();
    await page.locator(".object-row--folder").first().click();
    await page.screenshot({
      path: test.info().outputPath("table-wide-dark.png"),
    });
  });
});

test.describe("production compact selection and dialogs", () => {
  test("shows the hidden-selection warning visibly in the compact toolbar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 901, height: 720 });
    await openMockListing(page, { objectCount: 12 });
    await page.locator(".object-row--file").first().click();
    await page.locator("#btn-inspector").click();
    await expect(page.locator("#inspector-panel")).toBeVisible();
    await page.locator("#sidebar-resizer").focus();
    await page.locator("#sidebar-resizer").press("End");
    await page.locator("#inspector-resizer").focus();
    await page.locator("#inspector-resizer").press("Home");
    await page.waitForTimeout(20);
    const widths = await panelBoxes(page);
    expect(widths.listing.width).toBeGreaterThanOrEqual(360);
    expect(widths.listing.width).toBeLessThanOrEqual(361);
    expectPanelContainment(widths, 901);
    await page.locator("#select-all").check();
    await page.locator("#filter-input").fill("no-object-matches-this-filter");

    const count = page.locator("#batch-count");
    await expect(count).toHaveAttribute(
      "data-compact-count",
      "13 selected · 13 hidden",
    );
    const compactWarning = await count.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const pseudo = getComputedStyle(element, "::before");
      const text = element.getAttribute("data-compact-count") ?? "";
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas text metrics are unavailable");
      context.font = [
        pseudo.fontStyle,
        pseudo.fontVariant,
        pseudo.fontWeight,
        pseudo.fontSize,
        pseudo.fontFamily,
      ].join(" ");
      return {
        width: rect.width,
        height: rect.height,
        content: pseudo.content,
        text,
        textWidth: context.measureText(text).width,
        fontSize: pseudo.fontSize,
      };
    });
    expect(compactWarning.width).toBeGreaterThan(0);
    expect(compactWarning.height).toBeGreaterThan(0);
    expect(compactWarning.text).toMatch(/^\d{2} selected · \d{2} hidden$/);
    expect(compactWarning.content).toContain(compactWarning.text);
    expect(compactWarning.textWidth).toBeLessThanOrEqual(
      compactWarning.width + 1,
    );
    expect(compactWarning.fontSize).not.toBe("0px");
  });

  test("keeps a long delete confirmation inside the viewport with its footer visible", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 520 });
    await openMockListing(page, { objectCount: 12, longFileCount: 12 });
    const longRows = page.locator(".object-row--file").filter({
      has: page.locator('.object-name[title*="quarterly-report-with-a-name"]'),
    });
    await expect(longRows).toHaveCount(12);
    for (let index = 0; index < 5; index += 1) {
      await longRows.nth(index).locator(".row-check").check();
    }
    const more = page.locator("#batch-more");
    if (await more.isVisible()) {
      await more.click();
      await page
        .locator('.context-menu [role="menuitem"]', { hasText: "Delete" })
        .click();
    } else {
      await page.locator("#batch-delete").click();
    }

    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-message")).toContainText(
      "quarterly-report-with-a-name",
    );
    const messageMetrics = await page
      .locator("#dialog-message")
      .evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    expect(messageMetrics.scrollHeight).toBeGreaterThan(
      messageMetrics.clientHeight,
    );
    const box = requireBoundingBox(
      await page.locator(".dialog-box").boundingBox(),
      "delete confirmation",
    );
    const footer = requireBoundingBox(
      await page.locator(".dialog-box__actions").boundingBox(),
      "delete confirmation footer",
    );
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("dialog viewport is unavailable");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(footer.x).toBeGreaterThanOrEqual(box.x);
    expect(footer.y + footer.height).toBeLessThanOrEqual(
      box.y + box.height + 1,
    );
    expect(footer.y + footer.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });
});

test.describe("production listing states", () => {
  test.use({ viewport: { width: 1100, height: 720 } });

  const stateCases: Array<[LayoutMockOptions["scenario"], string]> = [
    ["empty", "This folder is empty"],
    ["error", "Failed to open bucket"],
  ];

  for (const [scenario, expected] of stateCases) {
    test(`${scenario} listing remains contained and actionable`, async ({
      page,
    }) => {
      await openMockListing(page, { scenario, objectCount: 0 });
      if (scenario === "empty") {
        await expect(page.locator(".table-empty")).toContainText(expected);
      } else {
        await expect(page.locator("#status")).toContainText(expected);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(1100);
    });
  }

  test("loading state exposes real skeletons and busy semantics before resolving", async ({
    page,
  }) => {
    await openMockListing(page, { scenario: "loading", objectCount: 30 });
    await expect(page.locator(".object-row--skeleton")).toHaveCount(8);
    await expect(page.locator("#object-panel")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await releaseMockListing(page);
    await expect(page.locator("#object-panel")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(page.locator(".object-row--file").first()).toBeVisible();
  });
});
