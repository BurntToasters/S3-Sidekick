// Mirrors scripts/e2e-fullstack.mjs step for step against the mock backend,
// so the selectors and flow the Linux-only full-stack run depends on are
// proven on every platform.
//
// Failure modes checked before implementation:
// - A renamed wizard control leaves first-run setup uncompletable.
// - Skipping encryption does not initialize security, so later steps fail.
// - Unchecking automatic updates is not saved.
// - Connect, bucket selection, or folder creation use different selectors
//   than the full-stack script expects.

import { expect, test } from "@playwright/test";
import { installLayoutTauriMock, readMockCallLog } from "./tauri-layout";

test("first-run setup, connect and folder create follow the full-stack path", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: false, autoCheckUpdates: true },
    security: { initialized: false, encryption_enabled: false },
  });
  await page.goto("/");

  await expect(page.locator("#setup-wizard-overlay")).toBeVisible();
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await page.locator("#setup-enc-skip").click();
  const autoUpdates = page.locator("#setup-auto-updates");
  if (await autoUpdates.isChecked()) await autoUpdates.click();
  await page.locator("#setup-updates-next").click();
  await page.locator("#setup-done-btn").click();
  await expect(page.locator("#setup-wizard-overlay")).toBeHidden();

  await page.locator("#conn-endpoint").fill("http://127.0.0.1:9000");
  await page.locator("#conn-access-key").fill("e2eadmin");
  await page.locator("#conn-secret-key").fill("e2eadmin-secret");
  await page.locator("#connect-btn").click();
  await expect(page.locator("#main-layout")).toBeVisible();

  await page
    .locator("#bucket-list .list__item-btn", { hasText: "layout-test-bucket" })
    .click();
  await page.locator("#btn-new-folder").click();
  await page.locator("#dialog-input").fill("smoke-folder");
  await page.locator("#dialog-ok").click();

  const calls = await readMockCallLog(page);
  const init = calls.find((call) => call.command === "initialize_security");
  expect(init?.args).toMatchObject({ enableEncryption: false });
  const saved = calls
    .filter((call) => call.command === "save_settings")
    .map((call) => JSON.parse(String((call.args as { json: string }).json)))
    .pop() as Record<string, unknown> | undefined;
  expect(saved?.autoCheckUpdates).toBe(false);
  await expect
    .poll(async () =>
      (await readMockCallLog(page)).some(
        (call) =>
          call.command === "create_folder" &&
          (call.args as { key?: string }).key === "smoke-folder",
      ),
    )
    .toBe(true);
});
