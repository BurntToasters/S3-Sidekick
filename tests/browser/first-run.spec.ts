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
// - A fresh install reports `encryption_enabled: true` before the vault is
//   initialized (`default_security_config`). Reading that as "encryption is
//   already on" hides Skip, locks the password fields, and lets Continue
//   finish setup without ever initializing the vault.

import { expect, test } from "@playwright/test";
import { installLayoutTauriMock, readMockCallLog } from "./tauri-layout";

// What the backend reports for a profile with no security.json and no legacy
// plaintext: see `default_security_config` in src-tauri/src/security.rs.
const FRESH_INSTALL_VAULT = { initialized: false, encryption_enabled: true };

test("first-run setup, connect and folder create follow the full-stack path", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: false, autoCheckUpdates: true },
    security: FRESH_INSTALL_VAULT,
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

test("enabling encryption on a fresh install initializes the vault with the password", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: false },
    security: FRESH_INSTALL_VAULT,
  });
  await page.goto("/");

  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await expect(page.locator("#setup-enc-password")).toBeEnabled();
  await page.locator("#setup-enc-password").fill("correct horse battery");
  await page.locator("#setup-enc-confirm").fill("correct horse battery");
  await page.locator("#setup-enc-next").click();
  await expect(page.locator("#setup-updates-next")).toBeVisible();

  const calls = await readMockCallLog(page);
  const init = calls.find((call) => call.command === "initialize_security");
  expect(init?.args).toMatchObject({
    enableEncryption: true,
    password: "correct horse battery",
  });
});
