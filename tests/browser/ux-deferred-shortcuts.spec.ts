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

async function shortcutDialogText(page: Page): Promise<string> {
  return (await page.locator("#dialog-message").textContent()) ?? "";
}

test.describe("keyboard shortcuts dialog", () => {
  test("palette lists Keyboard Shortcuts and opens the catalog dialog", async ({
    page,
  }, testInfo) => {
    await openMockListing(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();

    await page.locator("#palette-input").fill("keyboard");
    const option = page.locator("#palette-results .palette__item", {
      hasText: "Keyboard Shortcuts",
    });
    await expect(option).toHaveCount(1);
    await expect(option).toContainText("Ctrl+/");
    await page.keyboard.press("Enter");

    await expect(page.locator("#palette-overlay")).toBeHidden();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Keyboard Shortcuts",
    );
    const text = await shortcutDialogText(page);
    expect(text).toContain("Ctrl+K");
    expect(text).toContain("F5");
    expect(text).not.toContain("⌘K");

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

  test("Ctrl+/ opens the dialog from the listing", async ({ page }) => {
    await openMockListing(page);
    await expect(page.locator("#main-layout")).toBeVisible();

    await page.keyboard.press("Control+/");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Keyboard Shortcuts",
    );
    expect(await shortcutDialogText(page)).toContain("Ctrl+K");

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
    const text = await shortcutDialogText(page);
    expect(text).toContain("⌘K");
    expect(text).toContain("F5");
    expect(text).not.toContain("Ctrl+K");
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
