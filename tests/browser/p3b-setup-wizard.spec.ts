// Failure modes covered (UI overhaul 0.12.0, P3b setup wizard):
// - The wizard has five steps; the Welcome and Theme steps are split.
// - Steps are not numbered, so the user cannot tell how far setup goes.
// - The vault-initialized flag is read once at the start. Skip -> Back -> Back
//   -> Next -> Enable calls initialize_security on an already-initialized vault.
// - "Skip" on the encryption step does not say that saved connections are
//   stored unencrypted.
// - Enabling encryption after a skip does not re-read the vault status, so it
//   cannot take the "already initialized" branch.
import { expect, test } from "@playwright/test";
import { installLayoutTauriMock, readMockCallLog } from "./tauri-layout";

const FIRST_RUN = {
  objectCount: 0,
  prefixes: [],
  settings: { _setupComplete: false },
  security: { initialized: false, encryption_enabled: false },
};

test("the wizard has three numbered steps", async ({ page }) => {
  await installLayoutTauriMock(page, FIRST_RUN);
  await page.goto("/");
  await expect(page.locator("#setup-step-count")).toHaveText("Step 1 of 3");
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await expect(page.locator("#setup-step-count")).toHaveText("Step 2 of 3");
  await page.locator("#setup-enc-skip").click();
  await expect(page.locator("#setup-step-count")).toHaveText("Step 3 of 3");
  await expect(page.locator("#setup-done-btn")).toBeHidden();
  await page.locator("#setup-updates-next").click();
  await expect(page.locator("#setup-done-btn")).toHaveText(
    "Connect to storage",
  );
});

test("skip, back, back, next, enable never re-initializes the vault", async ({
  page,
}) => {
  await installLayoutTauriMock(page, FIRST_RUN);
  await page.goto("/");
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await page.locator("#setup-enc-skip").click();
  await expect(page.locator("#setup-step-updates")).toBeVisible();
  await page.locator("#setup-updates-back").click();
  await expect(page.locator("#setup-step-encryption")).toBeVisible();
  await page.locator("#setup-enc-back").click();
  await page.locator("#setup-theme-next").click();
  await expect(page.locator("#setup-step-encryption")).toBeVisible();

  await page.locator("#setup-enc-password").fill("correct-horse-1");
  await page.locator("#setup-enc-confirm").fill("correct-horse-1");
  await page.locator("#setup-enc-next").click();
  await expect(page.locator("#setup-step-updates")).toBeVisible();

  const calls = await readMockCallLog(page);
  const inits = calls.filter((call) => call.command === "initialize_security");
  expect(inits).toHaveLength(1);
  expect(inits[0]?.args).toMatchObject({ enableEncryption: false });
  const enable = calls.find(
    (call) => call.command === "set_security_encryption",
  );
  expect(enable?.args).toMatchObject({
    enableEncryption: true,
    newPassword: "correct-horse-1",
  });
});

test("skipping says that saved connections are stored unencrypted", async ({
  page,
}) => {
  await installLayoutTauriMock(page, FIRST_RUN);
  await page.goto("/");
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await expect(page.locator("#setup-enc-skip-note")).toContainText(
    /unencrypted.*not recommended/is,
  );
  await expect(page.locator("#setup-enc-skip")).toHaveText("Skip setup");
});
