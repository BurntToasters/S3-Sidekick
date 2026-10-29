// UX deferred modal a11y — titlebar window controls and the modal layer.
//
// Failure modes checked before implementation:
// - #app carries aria-hidden="true" while a modal is open, which hides the
//   titlebar window controls even though they stay clickable under the overlay.
// - The titlebar window controls are inerted along with the page behind the
//   dialog, so they cannot be operated.
// - The page behind the dialog (for example #btn-refresh) is left operable,
//   so Tab or a click can reach controls under the modal.
// - Closing Settings with Escape or the close button leaves the page inert.

import { expect, test, type Page } from "@playwright/test";
import { installLayoutTauriMock } from "./tauri-layout";

async function openSettings(page: Page): Promise<void> {
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
}

// The layout mock reports a Linux platform, so the Windows caption buttons stay
// hidden. Unhide them the same way titlebar.ts does on Windows.
async function showWindowControls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const controls = document.getElementById("titlebar-win-controls");
    if (controls) controls.hidden = false;
  });
}

async function accessibilityState(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    return {
      ariaHiddenAncestor: element.closest('[aria-hidden="true"]') !== null,
      inertAncestor: element.closest("[inert]") !== null,
      inertProperty:
        (element as HTMLElement & { inert?: boolean }).inert === true,
    };
  }, selector);
}

test("titlebar window controls stay in the accessibility tree while Settings is open", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await showWindowControls(page);
  await openSettings(page);

  const minimize = page.getByRole("button", { name: "Minimize", exact: true });
  await expect(minimize).toBeVisible();
  await expect(minimize).toBeEnabled();
  expect(await accessibilityState(page, "#titlebar-minimize")).toEqual({
    ariaHiddenAncestor: false,
    inertAncestor: false,
    inertProperty: false,
  });

  // The page behind the dialog stays blocked.
  const refresh = await accessibilityState(page, "#btn-refresh");
  expect(refresh?.inertAncestor).toBe(true);
});

test("Escape and the close button still close Settings and release the page", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  expect((await accessibilityState(page, "#btn-refresh"))?.inertAncestor).toBe(
    false,
  );

  await openSettings(page);
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  expect((await accessibilityState(page, "#btn-refresh"))?.inertAncestor).toBe(
    false,
  );
});
