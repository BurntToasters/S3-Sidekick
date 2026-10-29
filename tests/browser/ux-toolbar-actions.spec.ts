import { expect, test, type Page } from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  type MockCall,
} from "./tauri-layout";

const ARTIFACT_SUITE = "ux-toolbar-actions";

const TOOLBAR_SINGLE_ROW_MAX_HEIGHT = 46;

/** Bar buttons in the required selection-bar order. */
const BAR_ORDER = [
  "batch-download",
  "batch-copy-move",
  "batch-rename",
  "batch-copy-urls",
  "batch-delete",
  "batch-more",
  "batch-deselect",
];

/** True when every visible action button sits on the same baseline row. */
async function toolbarIsSingleRow(page: Page): Promise<boolean> {
  return page.locator(".content-toolbar__actions .btn").evaluateAll((nodes) => {
    const visible = nodes.filter(
      (node) =>
        node.getBoundingClientRect().height > 0 &&
        node.getBoundingClientRect().width > 0,
    );
    const tops = visible.map((node) => node.getBoundingClientRect().top);
    return tops.length > 0 && Math.max(...tops) - Math.min(...tops) < 3;
  });
}

async function menuLabels(page: Page): Promise<Map<string, string>> {
  const pairs = await page
    .locator('.context-menu [role="menuitem"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const el = node as HTMLElement;
        return [
          el.dataset.action ?? "",
          (el.querySelector(".context-menu__label")?.textContent ?? "").trim(),
        ] as [string, string];
      }),
    );
  return new Map(pairs.filter(([action]) => action !== ""));
}

async function openInspector(page: Page): Promise<void> {
  const layout = page.locator("#main-layout");
  if (
    !(await layout.evaluate((el) =>
      el.classList.contains("main-layout--inspector-docked"),
    ))
  ) {
    await page.locator("#btn-inspector").click();
  }
  await expect(layout).toHaveClass(/main-layout--inspector-docked/);
}

async function selectRows(page: Page, count: number): Promise<void> {
  const rows = page.locator(".object-row--file");
  for (let index = 0; index < count; index += 1) {
    await rows.nth(index).locator(".row-check").check();
  }
  await expect(page.locator("#batch-toolbar-actions")).toBeVisible();
}

test.describe("P4 toolbar and unified actions", () => {
  test("the content toolbar stays on one row at 760, 900 and 1280, with and without the inspector", async ({
    page,
  }, testInfo) => {
    for (const width of [760, 900, 1280]) {
      await page.setViewportSize({ width, height: 640 });
      await openMockListing(page, { objectCount: 12 });
      for (const docked of [false, true]) {
        if (docked && width > 900) {
          await openInspector(page);
        }
        const box = await page.locator(".content-toolbar").boundingBox();
        expect(
          box?.height ?? Infinity,
          `toolbar height at ${width}px (inspector ${docked})`,
        ).toBeLessThanOrEqual(TOOLBAR_SINGLE_ROW_MAX_HEIGHT);
        expect(
          await toolbarIsSingleRow(page),
          `toolbar rows at ${width}px (inspector ${docked})`,
        ).toBe(true);
        const clipped = await page
          .locator(".content-toolbar")
          .evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(clipped, `toolbar clip at ${width}px`).toBeLessThanOrEqual(1);
        const calls = await readMockCallLog(page);
        await saveArtifact(
          page,
          testInfo,
          ARTIFACT_SUITE,
          `single-row-${width}-${docked ? "docked" : "plain"}`,
          calls,
        );
        if (docked) {
          await page.locator("#btn-inspector").click();
          await expect(page.locator("#main-layout")).not.toHaveClass(
            /main-layout--inspector-docked/,
          );
        }
      }
    }
  });

  test("toolbar labels collapse before icons, then icons collapse into the overflow menu", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await openMockListing(page, { objectCount: 12 });

    // Wide: full labels, no overflow button.
    const uploadLabel = page.locator("#btn-upload .btn__label");
    await expect(uploadLabel).toBeVisible();
    await expect(page.locator("#btn-toolbar-overflow")).toBeHidden();

    // Narrow: labels gone, buttons remain as icons.
    await page.setViewportSize({ width: 900, height: 640 });
    await expect(uploadLabel).toBeHidden();
    await expect(page.locator("#btn-new-folder")).toBeVisible();

    // Narrowest: icons collapse into the overflow menu.
    await page.setViewportSize({ width: 560, height: 640 });
    await expect(page.locator("#btn-toolbar-overflow")).toBeVisible();
    await expect(page.locator("#btn-new-folder")).toBeHidden();
    await page.locator("#btn-toolbar-overflow").click();
    await expect(page.locator(".context-menu")).toBeVisible();
    for (const label of [
      "New folder",
      "Refresh",
      "Files\u2026",
      "Folder\u2026",
    ]) {
      await expect(
        page.locator('.context-menu [role="menuitem"]', { hasText: label }),
      ).toBeVisible();
    }
    const before = (await readMockCallLog(page)).filter(
      (call: MockCall) => call.command === "list_objects",
    ).length;
    await page
      .locator('.context-menu [role="menuitem"]', { hasText: "Refresh" })
      .click();
    const after = (await readMockCallLog(page)).filter(
      (call: MockCall) => call.command === "list_objects",
    ).length;
    expect(after).toBeGreaterThan(before);
    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "toolbar-overflow",
      calls,
    );
  });

  test("the toolbar has a primary Upload menu and no search icon", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await openMockListing(page, { objectCount: 12 });

    await expect(page.locator("#btn-palette")).toHaveCount(0);
    await expect(page.locator("#btn-upload-folder")).toHaveCount(0);
    await expect(page.locator("#btn-upload .btn__label")).toHaveText("Upload");
    await expect(page.locator("#btn-upload")).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
    await page.locator("#btn-upload").click();
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(
      page.locator('.context-menu [role="menuitem"]', {
        hasText: "Files\u2026",
      }),
    ).toBeVisible();
    await expect(
      page.locator('.context-menu [role="menuitem"]', {
        hasText: "Folder\u2026",
      }),
    ).toBeVisible();
    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "upload-menu", calls);
  });

  test("the selection bar is neutral when idle and accent only while selecting", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 640 });
    await openMockListing(page, { objectCount: 12 });

    const bar = page.locator("#batch-toolbar");
    await expect(bar).toHaveAttribute("data-selection-state", "idle");
    const idleShadow = await bar.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    expect(idleShadow).not.toContain("inset");

    await selectRows(page, 1);
    await expect(bar).toHaveAttribute("data-selection-state", "selected");
    const selectedShadow = await bar.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    // The CSS var is hex but computed box-shadow resolves to rgb().
    const accent = await page.locator("body").evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(selectedShadow).toContain(accent);

    // Button order.
    const order = await page
      .locator("#batch-toolbar-actions .btn")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).offsetParent !== null)
          .map((node) => (node as HTMLElement).id),
      );
    expect(order).toEqual(BAR_ORDER);
    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "selection-accent",
      calls,
    );
  });

  test("Rename shows only for one selection and Copy URL tracks the count", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 640 });
    await openMockListing(page, { objectCount: 12 });

    await selectRows(page, 1);
    await expect(page.locator("#batch-rename")).toBeVisible();
    await expect(
      page.locator("#batch-copy-urls .batch-toolbar__label"),
    ).toHaveText("Copy URL");

    await selectRows(page, 2);
    await expect(page.locator("#batch-rename")).toBeHidden();
    await expect(
      page.locator("#batch-copy-urls .batch-toolbar__label"),
    ).toHaveText("Copy URLs");
    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "rename-count", calls);
  });

  test("labels are identical across the context menu, More menu and palette", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await openMockListing(page, {
      objectCount: 12,
      endpoint: "https://s3.us-east-1.amazonaws.com",
    });
    await selectRows(page, 1);

    // Context menu.
    await page.locator(".object-row--file").first().click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    const context = await menuLabels(page);
    await page.keyboard.press("Escape");

    const shared = [
      "properties",
      "copy-keys",
      "copy-arns",
      "share-link",
      "copy-s3-uri",
    ];
    for (const id of shared) {
      expect(context.has(id), `context menu has ${id}`).toBe(true);
    }

    // More menu.
    await page.locator("#batch-more").click();
    await expect(page.locator(".context-menu")).toBeVisible();
    const more = await menuLabels(page);
    await page.keyboard.press("Escape");
    for (const id of shared) {
      expect(more.has(id), `More menu has ${id}`).toBe(true);
      expect(more.get(id), `More label matches for ${id}`).toBe(
        context.get(id),
      );
    }

    // Palette.
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    const paletteLabels = await page
      .locator(".palette__item-label")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? ""),
      );
    for (const id of shared) {
      expect(
        paletteLabels.includes(context.get(id) ?? ""),
        `palette has the same label for ${id}: ${String(context.get(id))}`,
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "shared-labels", calls);
  });

  test("Share link\u2026 offers an expiry select taken from settings and copies the URL", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await openMockListing(page, {
      objectCount: 12,
      settings: { presignedUrlExpiration: 21600 },
    });
    await selectRows(page, 1);
    await page.locator("#batch-more").click();
    await page
      .locator('.context-menu [role="menuitem"]', {
        hasText: "Share link\u2026",
      })
      .click();
    await expect(page.locator("#share-link-overlay")).toBeVisible();
    await expect(page.locator("#share-link-expiry")).toHaveValue("21600");

    await page.locator("#share-link-expiry").selectOption("300");
    await page.locator("#share-link-copy").click();
    await expect(page.locator("#share-link-overlay")).toBeHidden();

    const presignedCalls = (await readMockCallLog(page)).filter(
      (call: MockCall) => call.command === "generate_presigned_url",
    );
    expect(presignedCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      (presignedCalls.at(-1)?.args as { expiresInSecs?: number })
        ?.expiresInSecs,
    ).toBe(300);
    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "share-link", calls);
  });

  test("Delete stays reachable with the inspector docked on a wide viewport", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await openMockListing(page, { objectCount: 12 });
    await openInspector(page);
    const containerWidth = await page
      .locator(".content-main")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(containerWidth).toBeGreaterThanOrEqual(760);

    await selectRows(page, 1);
    await expect(page.locator("#batch-delete")).toBeVisible();
    await expect(page.locator("#batch-copy-move")).toBeVisible();
    await page.locator("#batch-delete").click();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await page.locator("#dialog-cancel").click();
    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "delete-docked", calls);
  });
});
