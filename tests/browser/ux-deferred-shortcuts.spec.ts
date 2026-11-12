import { expect, test, type Page } from "@playwright/test";
import {
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
} from "./tauri-layout";
import { saveArtifact } from "./helpers";

const SUITE = "ux-deferred-shortcuts";

/** Report the platform the app sees at startup, as the real backend would. */
async function installPlatform(
  page: Page,
  platform: "linux" | "macos",
): Promise<void> {
  await installLayoutTauriMock(page);
  await page.addInitScript((value) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown, options?: unknown) => unknown;
        };
      }
    ).__TAURI_INTERNALS__;
    const inner = internals.invoke;
    internals.invoke = (cmd, args, options) => {
      if (cmd === "get_platform_info") return Promise.resolve(value);
      return inner(cmd, args, options);
    };
  }, platform);
}

interface ShortcutRow {
  action: string;
  /** Each alternative key combo, as the chip labels in order. */
  combos: string[][];
}

/** Read every shortcut row in the open shortcuts dialog. */
async function shortcutRows(page: Page): Promise<ShortcutRow[]> {
  return page
    .locator("#dialog-message .shortcut-row")
    .evaluateAll((rows: Element[]) =>
      rows.map((row) => ({
        action:
          row.querySelector(".shortcut-row__action")?.textContent?.trim() ?? "",
        combos: Array.from(
          row.querySelectorAll(".shortcut-row__keys .shortcut-combo"),
        ).map((combo) =>
          Array.from(combo.querySelectorAll("kbd")).map(
            (chip) => chip.textContent ?? "",
          ),
        ),
      })),
    );
}

function rowNamed(
  rows: ShortcutRow[],
  action: string,
): ShortcutRow | undefined {
  return rows.find((row) => row.action === action);
}

test.describe("keyboard shortcuts dialog", () => {
  // Failure mode: the palette entry still opens the old plain-text alert, so
  // the title, the row structure and the key chips are all missing.
  test("palette lists Keyboard Shortcuts and opens the catalog dialog", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();

    await page.locator("#palette-input").fill("keyboard");
    const option = page.locator("#palette-results .palette__item", {
      hasText: "Keyboard shortcuts",
    });
    await expect(option).toHaveCount(1);
    await expect(option).toContainText("Ctrl+/");
    await page.keyboard.press("Enter");

    await expect(page.locator("#palette-overlay")).toBeHidden();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Keyboard shortcuts",
    );
    const rows = await shortcutRows(page);
    expect(rowNamed(rows, "Command palette")?.combos).toEqual([["Ctrl", "K"]]);
    expect(rowNamed(rows, "Refresh")?.combos).toEqual([["F5"], ["Ctrl", "R"]]);

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, SUITE, "palette-open", calls);
  });

  test("Escape closes the shortcuts dialog", async ({ page }) => {
    await openMockListing(page);
    await page.keyboard.press("Control+k");
    await page.locator("#palette-input").fill("keyboard");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  // Failure mode: the dialog stays a 360px alert with plain text lines, so it
  // has no row per shortcut and no key chips to scan.
  test("Ctrl+/ opens a titled dialog with at least 20 rows, each with a chip", async ({
    page,
  }) => {
    await openMockListing(page);
    await expect(page.locator("#main-layout")).toBeVisible();

    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Keyboard shortcuts",
    );

    const rows = await shortcutRows(page);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      expect(row.action.length).toBeGreaterThan(0);
      expect(row.combos.flat().length).toBeGreaterThanOrEqual(1);
    }
    expect(rowNamed(rows, "Command palette")?.combos).toEqual([["Ctrl", "K"]]);
    expect(rowNamed(rows, "Refresh")?.combos).toEqual([["F5"], ["Ctrl", "R"]]);

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  // Failure mode: a non-macOS build shows a Command or Shift glyph in a chip,
  // which Windows and Linux users do not have on their keyboards.
  test("off macOS no key chip shows Command or Shift glyphs", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);

    const rows = await shortcutRows(page);
    const chips = rows.flatMap((row) => row.combos.flat());
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip).not.toContain("⌘");
      expect(chip).not.toContain("⇧");
    }
    expect(rowNamed(rows, "Upload folder")?.combos).toEqual([
      ["Ctrl", "Shift", "U"],
    ]);
  });

  // Failure mode: the macOS accelerator is shown as plain text, or as one
  // "⌘⇧U" chip, instead of one chip per key.
  test("on macOS the Upload folder row shows one chip each for Command, Shift and U", async ({
    page,
  }) => {
    await installPlatform(page, "macos");
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();

    await page.keyboard.press("Meta+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);

    const rows = await shortcutRows(page);
    expect(rowNamed(rows, "Upload folder")?.combos).toEqual([["⌘", "⇧", "U"]]);
    expect(rowNamed(rows, "Command palette")?.combos).toEqual([["⌘", "K"]]);
    expect(rowNamed(rows, "Refresh")?.combos).toEqual([["F5"], ["⌘", "R"]]);
  });

  // Failure mode: the dialog is narrower than the 560px design width, or
  // Escape leaves it open, or focus lands on the page behind instead of the
  // control that opened the dialog.
  test("the dialog is at least 480px wide, and Escape closes it and returns focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMockListing(page);
    const opener = page.locator("#btn-refresh");
    await opener.focus();
    await expect(opener).toBeFocused();

    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    const box = await page.locator("#dialog-overlay .dialog-box").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(480);

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
    await expect(opener).toBeFocused();
  });

  // Failure mode: forced-colors mode strips the chip background, leaving key
  // labels with no outline, so the keys become unreadable as chips.
  test("key chips keep a visible outline in forced-colors mode", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openMockListing(page);
    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);

    const chip = page.locator("#dialog-message kbd").first();
    await expect(chip).toBeVisible();
    const border = await chip.evaluate((node: HTMLElement) => {
      const style = window.getComputedStyle(node);
      return { style: style.borderTopStyle, width: style.borderTopWidth };
    });
    expect(border).toEqual({ style: "solid", width: "1px" });

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  // Failure mode: a tall list is clipped with no way to scroll it, or the
  // scroll region cannot be reached from the keyboard.
  test("the list scrolls inside the dialog and is reachable by keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMockListing(page);
    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);

    const scroller = page.locator("#dialog-message");
    const metrics = await scroller.evaluate((node: HTMLElement) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.keyboard.press("Shift+Tab");
    await expect(scroller).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  test("Ctrl+/ opens the dialog from the listing", async ({ page }) => {
    await openMockListing(page);
    await expect(page.locator("#main-layout")).toBeVisible();

    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Keyboard shortcuts",
    );
    const rows = await shortcutRows(page);
    expect(rowNamed(rows, "Command palette")?.combos).toEqual([["Ctrl", "K"]]);

    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  test("on macOS the dialog shows Command labels and Cmd+/ opens it", async ({
    page,
  }) => {
    await installPlatform(page, "macos");
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();

    await page.keyboard.press("Meta+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    const rows = await shortcutRows(page);
    expect(rowNamed(rows, "Command palette")?.combos).toEqual([["⌘", "K"]]);
    expect(rowNamed(rows, "Refresh")?.combos).toEqual([["F5"], ["⌘", "R"]]);
    const chips = rows.flatMap((row) => row.combos.flat());
    expect(chips).not.toContain("Ctrl");
  });

  test("the palette command works before a connection exists", async ({
    page,
  }) => {
    await installLayoutTauriMock(page);
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();

    await page.keyboard.press("Control+k");
    await page.locator("#palette-input").fill("keyboard shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  test("Ctrl+/ does nothing while a text field has focus", async ({ page }) => {
    await openMockListing(page);
    await page.locator("#filter-input").focus();

    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });
});
