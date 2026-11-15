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
    // Keep the automatic Touch ID attempt pending long enough to assert the
    // retry control, rather than racing an immediate successful unlock.
    holdBiometric: true,
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

test("Forgot password? explains the erase, and Cancel leaves the vault untouched", async ({
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
  await expect(page.locator("#dialog-title")).toHaveText(
    "Erase the encrypted vault?",
  );
  await expect(page.locator("#dialog-message")).toContainText(
    /can.t be recovered/i,
  );
  await page.locator("#dialog-cancel").click();
  await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  await expect(page.locator("#lock-view")).toBeVisible();

  const calls = await readMockCallLog(page);
  for (const command of [
    "factory_reset",
    "unlock_security",
    "initialize_security",
    "set_security_encryption",
  ]) {
    expect(calls.some((call) => call.command === command)).toBe(false);
  }
});

test("confirming the erase runs the factory reset after a final confirmation", async ({
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
  await expect(page.locator("#dialog-title")).toHaveText(
    "Erase the encrypted vault?",
  );
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#dialog-title")).toHaveText(
    "Permanently delete all app data?",
  );
  await page.locator("#dialog-ok").click();

  await expect
    .poll(async () =>
      (await readMockCallLog(page)).some(
        (call) => call.command === "factory_reset",
      ),
    )
    .toBe(true);
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

type Rgb = [number, number, number];

function channels(css: string): Rgb {
  const parts = css.match(/[\d.]+/g)?.map(Number) ?? [];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, bl]: Rgb) => {
    const [R, G, B] = [r, g, bl].map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Failure modes (dark lock view):
// - "Forgot password?" and "Continue locked" use --accent (#4f46e5), about
//   2.8:1 on the #18181b lock card, below the 4.5:1 text minimum.
// - The lock icon uses the same accent, below the 3:1 non-text minimum.
// - The links have no focus-visible ring, so a Tab user cannot see focus.
test("dark lock view links meet text contrast, the icon meets 3:1, and a Tab-focused link shows a ring", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: ENCRYPTED_LOCKED,
    unlockPasswords: ["correct-horse-1"],
    settings: { theme: "dark" },
  });
  await page.goto("/");
  await expect(page.locator("#lock-view")).toBeVisible();

  const colorOf = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).color);
  const card = channels(
    await page
      .locator(".lock-view__card")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  const forgot = channels(await colorOf("#lock-view-forgot"));
  const cont = channels(await colorOf("#lock-view-continue"));
  const icon = channels(await colorOf(".lock-view__icon"));

  expect(
    contrast(forgot, card),
    "Forgot password? on lock card",
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    contrast(cont, card),
    "Continue locked on lock card",
  ).toBeGreaterThanOrEqual(4.5);
  expect(contrast(icon, card), "lock icon on lock card").toBeGreaterThanOrEqual(
    3,
  );

  let reached = false;
  for (let i = 0; i < 12 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () =>
        document.activeElement?.classList.contains("lock-view__link") ?? false,
    );
  }
  expect(reached, "Tab reaches a lock-view link").toBe(true);
  const outline = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement as HTMLElement);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});
