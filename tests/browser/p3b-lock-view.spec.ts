// Failure modes covered (UI overhaul 0.12.0, P3b lock screen):
// - Locked startup shows a generic dialog prompt with paragraph-long copy
//   instead of a dedicated full-window lock view.
// - Escape dismisses the unlock prompt, so a mandatory lock can be bypassed
//   by focus moving out of the password field.
// - A wrong password has no inline error in the lock view itself.
// - The biometric overlay has no message and no Cancel, so the user cannot
//   fall back to the password field while Touch ID is waiting.
// - "Use Touch ID" is not offered as a retry on macOS when biometric is
//   enrolled, and is shown when it is not enrolled.
// - "Forgot password?" is only reachable through the generic dialog action.
// - Focus is not trapped in the lock view and does not land on the password.
// - "Continue locked" (the explicit non-unlock exit) is missing, so a user who
//   wants to reach non-encrypted parts of the app has no visible path.
import { expect, test, type Page } from "@playwright/test";
import {
  installLayoutTauriMock,
  readMockCallLog,
  releaseMockBiometric,
} from "./tauri-layout";

const ENCRYPTED_LOCKED = {
  initialized: true,
  encryption_enabled: true,
  unlocked: false,
  lock_timeout_minutes: 30,
};

async function lockViewVisible(page: Page): Promise<boolean> {
  return page.locator("#lock-view").isVisible();
}

test("a locked start shows a dedicated lock view with focus on the password", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");

  await expect(page.locator("#lock-view")).toBeVisible();
  await expect(page.locator("#lock-view-title")).toHaveText(
    "S3 Sidekick is locked",
  );
  await expect(page.locator("#lock-view-password")).toBeFocused();
  await expect(page.locator("#lock-view-unlock")).toBeVisible();
  await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);

  // Escape must not dismiss a mandatory lock.
  await page.keyboard.press("Escape");
  await expect(page.locator("#lock-view")).toBeVisible();
});

test("focus stays inside the lock view while Tab is pressed", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view-password")).toBeFocused();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest("#lock-view"),
    );
    expect(inside).toBe(true);
  }
});

test("a wrong password shows an inline error and a correct one unlocks", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await page.locator("#lock-view-password").fill("wrong-password");
  await page.locator("#lock-view-unlock").click();

  await expect(page.locator("#lock-view-error")).toContainText(
    /password is incorrect/i,
  );
  await expect(page.locator("#lock-view")).toBeVisible();

  await page.locator("#lock-view-password").fill("correct-horse-1");
  await page.locator("#lock-view-unlock").click();
  await expect(page.locator("#lock-view")).toBeHidden();
});

test("Show reveals the password and the field keeps its value", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await page.locator("#lock-view-password").fill("correct-horse-1");
  await expect(page.locator("#lock-view-password")).toHaveAttribute(
    "type",
    "password",
  );
  await page.locator("#lock-view-reveal").click();
  await expect(page.locator("#lock-view-password")).toHaveAttribute(
    "type",
    "text",
  );
  await expect(page.locator("#lock-view-password")).toHaveValue(
    "correct-horse-1",
  );
});

test("Touch ID retry is offered on macOS only when biometric is enrolled", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    platform: "macos",
    security: {
      ...ENCRYPTED_LOCKED,
      biometric_available: true,
      biometric_enrolled: true,
    },
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view-biometric")).toBeVisible();
  await expect(page.locator("#lock-view-biometric")).toHaveText("Use Touch ID");
});

test("Touch ID retry stays hidden when biometric is not enrolled", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    platform: "macos",
    security: {
      ...ENCRYPTED_LOCKED,
      biometric_available: true,
      biometric_enrolled: false,
    },
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view")).toBeVisible();
  await expect(page.locator("#lock-view-biometric")).toBeHidden();
});

test("the biometric wait shows a message and Cancel falls back to the password", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    platform: "macos",
    holdBiometric: true,
    security: {
      ...ENCRYPTED_LOCKED,
      biometric_available: true,
      biometric_enrolled: true,
    },
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");

  const overlay = page.locator("#biometric-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#biometric-overlay-title")).toContainText(
    "Touch ID",
  );
  await page.locator("#biometric-overlay-cancel").click();
  await expect(overlay).toBeHidden();
  await expect(page.locator("#lock-view")).toBeVisible();
  await expect(page.locator("#lock-view-password")).toBeFocused();
  await expect(page.locator("#lock-view-notice")).toContainText(/canceled/i);

  // A late biometric success after Cancel still unlocks; it is not dropped.
  await releaseMockBiometric(page);
  await expect(page.locator("#lock-view")).toBeHidden();
});

test("Forgot password? starts the existing reset flow from the lock view", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await page.locator("#lock-view-forgot").click();
  await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
  const calls = await readMockCallLog(page);
  expect(calls.some((call) => call.command === "factory_reset")).toBe(false);
});

test("Continue locked leaves saved connections locked and closes the lock view", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  await page.locator("#lock-view-continue").click();
  await expect(page.locator("#lock-view")).toBeHidden();
  await expect(page.locator("#connection-screen")).toBeVisible();
  expect(await lockViewVisible(page)).toBe(false);
});
