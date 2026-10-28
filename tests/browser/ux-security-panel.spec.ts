// Failure modes covered (UI overhaul 0.12.0, P3b Security tab):
// - One relabelling button ("Initialize / Unlock / Disable / Enable") hides
//   which action is destructive and what state the vault is in.
// - The status is a bare text line with no icon or explanation.
// - "Lock now" is shown while the vault is already locked.
// - Visibility is toggled with inline style.display instead of `hidden`.
// - The biometric note is not linked to its toggle for assistive tech.
// - "Turn off encryption" is not a separately labelled action.
import { expect, test, type Page } from "@playwright/test";
import { installLayoutTauriMock, readMockCallLog } from "./tauri-layout";

async function openSecurityTab(page: Page): Promise<void> {
  await page.locator("#settings-btn").click();
  await page.locator("#settings-tab-security").click();
  await expect(page.locator("#settings-panel-security")).toBeVisible();
}

test("an unlocked vault shows a status card and separate action buttons", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
  });
  await page.goto("/");
  await openSecurityTab(page);

  await expect(page.locator("#security-status-card")).toBeVisible();
  await expect(page.locator("#security-status-text")).toHaveText(
    "Encrypted (AES-256) and unlocked",
  );
  await expect(page.locator("#security-status-card .lucide-icon")).toHaveCount(
    1,
  );
  await expect(page.locator("#security-toggle")).toHaveCount(0);
  await expect(page.locator("#security-lock-btn")).toBeVisible();
  await expect(page.locator("#security-lock-btn")).toHaveText("Lock now");
  await expect(page.locator("#security-change-password")).toBeVisible();
  await expect(page.locator("#security-disable-btn")).toHaveText(
    "Turn off encryption",
  );
  await expect(page.locator("#security-unlock-btn")).toBeHidden();
  await expect(page.locator("#security-setup-btn")).toBeHidden();
  await expect(page.locator("#security-lock-timeout")).toBeVisible();
});

test("visibility uses the hidden attribute, not inline display styles", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
  });
  await page.goto("/");
  await openSecurityTab(page);
  for (const id of [
    "security-change-password",
    "security-lock-settings",
    "security-warning",
    "security-unlock-btn",
    "security-setup-btn",
  ]) {
    await expect(page.locator(`#${id}`), id).not.toHaveAttribute(
      "style",
      /display/,
    );
  }
});

test("a locked vault offers Unlock and hides Lock now and Change password", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: false },
    unlockPasswords: ["correct-horse-1"],
  });
  await page.goto("/");
  // Startup shows the lock view; dismiss it to reach the Settings tab.
  await page.locator("#lock-view-continue").click();
  await openSecurityTab(page);

  await expect(page.locator("#security-status-text")).toHaveText(
    "Encrypted (AES-256) and locked",
  );
  await expect(page.locator("#security-unlock-btn")).toBeVisible();
  await expect(page.locator("#security-lock-btn")).toBeHidden();
  await expect(page.locator("#security-change-password")).toBeHidden();
});

test("an unencrypted vault explains the risk and offers Set up encryption", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { initialized: true, encryption_enabled: false },
  });
  await page.goto("/");
  await openSecurityTab(page);

  await expect(page.locator("#security-status-text")).toHaveText(
    "Not encrypted",
  );
  await expect(page.locator("#security-status-card")).toContainText(
    /saved credentials are stored unencrypted/i,
  );
  await expect(page.locator("#security-warning")).toBeVisible();
  await expect(page.locator("#security-setup-btn")).toHaveText(
    "Set up encryption",
  );
  await expect(page.locator("#security-lock-settings")).toBeHidden();
  await expect(page.locator("#security-disable-btn")).toBeHidden();
});

test("the biometric note describes the gate and is linked to its toggle", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    platform: "macos",
    security: {
      encryption_enabled: true,
      unlocked: true,
      biometric_available: true,
      biometric_enrolled: false,
    },
  });
  await page.goto("/");
  await openSecurityTab(page);

  const note = page.locator("#biometric-security-note");
  await expect(note).toHaveClass(/setting-description/);
  await expect(note).toContainText(/convenience gate/i);
  await expect(page.locator("#biometric-toggle")).toHaveAttribute(
    "aria-describedby",
    "biometric-security-note",
  );
  await expect(page.locator("#biometric-toggle")).toHaveText("Enable Touch ID");
});

test("Set up encryption on an unencrypted vault calls the existing enable path", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { initialized: true, encryption_enabled: false },
  });
  await page.goto("/");
  await openSecurityTab(page);
  await page.locator("#security-setup-btn").click();
  await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
  await page.locator("#dialog-input").fill("correct-horse-1");
  await page.locator("#dialog-ok").click();
  await page.locator("#dialog-input").fill("correct-horse-1");
  await page.locator("#dialog-ok").click();

  const calls = await readMockCallLog(page);
  expect(
    calls.find((call) => call.command === "set_security_encryption")?.args,
  ).toMatchObject({ enableEncryption: true });
  await expect(page.locator("#security-status-text")).toHaveText(
    "Encrypted (AES-256) and unlocked",
  );
});
