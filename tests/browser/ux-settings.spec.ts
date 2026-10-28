// UX audit 0.12.0 — settings, security, setup wizard and updater.
//
// Failure modes checked before implementation:
// - Escape on the Reset Scope choice runs the partial reset (credentials are
//   cleared, settings saved, app relaunched) instead of cancelling.
// - Escape with unsaved Transfers edits discards them without asking.
// - "Check now" closes Settings while the update check runs.
// - Help buttons are named only "Help" and their text is not exposed.
// - The light-theme help tooltip has unreadable text/background contrast.
// - The Unlock prompt gives no recovery guidance for a forgotten password.
// - Manual (package-manager) installs hide every updater control.
// - Security changes that apply immediately still show Save/Cancel.
// - Lock Now interrupts running transfers without confirmation.
// - Wizard Back after enabling encryption re-offers Enable Encryption.
// - Settings select values are truncated.
// - Wizard and Settings use different theme order and update labels.
// - Settings password flows abort instead of validating inline.

import { expect, test, type Page } from "@playwright/test";
import { FULL_CREATE_ONLY, openCopyMoveFromRow } from "./helpers";
import {
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  releaseMockCopies,
} from "./tauri-layout";

const DESTRUCTIVE_COMMANDS = [
  "clear_saved_connection",
  "save_settings",
  "factory_reset",
  "plugin:process|restart",
];

async function callNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { calls: string[] };
      }
    ).__S3_LAYOUT_TEST__;
    return state ? [...state.calls] : [];
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
}

function dialog(page: Page) {
  return page.locator("#dialog-overlay");
}

test("Escape on Reset Scope cancels without a partial reset and focuses Cancel", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-reset").click();
  await page.locator("#settings-reset").click();
  await expect(dialog(page)).toHaveClass(/active/);
  await page.locator("#dialog-ok").click(); // "Continue" on Reset Settings

  await expect(dialog(page)).toHaveClass(/active/);
  await expect(
    dialog(page).getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();

  const before = (await callNames(page)).length;
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toHaveClass(/active/);
  const afterEscape = (await callNames(page)).slice(before);
  for (const command of DESTRUCTIVE_COMMANDS) {
    expect(afterEscape).not.toContain(command);
  }
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
});

test("Escape with unsaved Transfers edits asks before discarding", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  await page.locator("#setting-max-concurrent").selectOption("5");

  const saveCallsBefore = (await readMockCallLog(page)).filter(
    (call) => call.command === "save_settings",
  ).length;
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveClass(/active/);
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog(page)).not.toHaveClass(/active/);
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
  await expect(page.locator("#setting-max-concurrent")).toHaveValue("5");

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveClass(/active/);
  await dialog(page)
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  const saveCallsAfter = (await readMockCallLog(page)).filter(
    (call) => call.command === "save_settings",
  ).length;
  expect(saveCallsAfter).toBe(saveCallsBefore);

  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  await expect(page.locator("#setting-max-concurrent")).toHaveValue("3");
});

test("Check now keeps Settings open while the update check runs", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-updates").click();
  await page.locator("#settings-check-updates").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
  await expect(page.locator("#settings-check-updates")).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
});

test("Settings descriptions are visible text linked to their control, not hover help", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-updates").click();

  const channel = page.locator("#setting-update-channel");
  const describedBy = await channel.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const description = page.locator(`#${describedBy}`);
  await expect(description).toBeVisible();
  await expect(description).toContainText(/Beta/);
  await expect(page.locator("#settings-overlay .setting-help")).toHaveCount(0);
});

test("Settings description text meets 4.5:1 contrast in the light theme", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { theme: "light" },
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-updates").click();

  const ratio = await page.evaluate(() => {
    const tip = document.getElementById("help-update-channel");
    if (!tip) return -1;
    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [match[0] ?? 0, match[1] ?? 0, match[2] ?? 0, match[3] ?? 1];
    };
    const luminance = ([r, g, b]: number[]): number => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const style = getComputedStyle(tip);
    const fg = parse(style.color);
    // A description paints no fill, so it reads against the nearest opaque ancestor.
    let host: HTMLElement | null = tip;
    let bg = parse(style.backgroundColor);
    while (host && bg[3] < 1) {
      host = host.parentElement;
      if (host) bg = parse(getComputedStyle(host).backgroundColor);
    }
    if (!host || bg[3] < 1) return -2;
    const a = luminance(fg);
    const b = luminance(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("the lock view offers a Forgot password? action", async ({ page }) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: {
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
    },
    unlockPasswords: ["correct-horse-battery"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view")).toBeVisible();
  await expect(page.locator("#lock-view-title")).toHaveText(
    "S3 Sidekick is locked",
  );
  await expect(page.locator("#lock-view-forgot")).toHaveText(
    "Forgot password?",
  );
});

test("Forgot password? opens the reset flow, and Escape on Reset Scope cancels it", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: {
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
    },
    unlockPasswords: ["correct-horse-battery"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view")).toBeVisible();
  await page.locator("#lock-view-forgot").click();

  // The lock view stays up underneath while the existing reset flow opens.
  await expect(page.locator("#dialog-title")).toHaveText("Reset Settings");
  await page.locator("#dialog-ok").click(); // "Continue"
  await expect(page.locator("#dialog-title")).toHaveText("Reset Scope");
  await expect(
    dialog(page).getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();

  const before = (await callNames(page)).length;
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toHaveClass(/active/);
  const afterEscape = (await callNames(page)).slice(before);
  for (const command of DESTRUCTIVE_COMMANDS) {
    expect(afterEscape).not.toContain(command);
  }
  expect(await callNames(page)).not.toContain("unlock_security");
});

test("Escape on the lock view does not dismiss it or start the reset flow", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: {
      initialized: true,
      encryption_enabled: true,
      unlocked: false,
    },
    unlockPasswords: ["correct-horse-battery"],
  });
  await page.goto("/");
  await expect(page.locator("#lock-view")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#lock-view")).toBeVisible();
  await expect(dialog(page)).not.toHaveClass(/active/);
  expect(await callNames(page)).not.toContain("factory_reset");
});

test("Lock Now asks before interrupting running transfers", async ({
  page,
}) => {
  await openMockListing(page, {
    objectCount: 1,
    prefixes: [],
    createOnlyCapabilities: FULL_CREATE_ONLY,
    listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
    transferBackend: { holdCopies: true },
    security: { encryption_enabled: true, unlocked: true },
  });
  // A real copy held in flight, so the queue reports an active transfer.
  await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
  await page.locator("#copy-move-path").fill("destination/");
  await page.locator("#copy-move-copy-btn").click();
  await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);

  await openSettings(page);
  await page.locator("#settings-tab-security").click();
  await page.locator("#security-lock-btn").click();
  await expect(dialog(page)).toHaveClass(/active/);
  await expect(page.locator("#dialog-message")).toContainText(/transfer/i);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).not.toHaveClass(/active/);

  const names = await callNames(page);
  expect(names).not.toContain("lock_security");
  await releaseMockCopies(page);
});

test("Lock Now shows the saved connections as locked, not empty", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-security").click();
  await page.locator("#security-lock-btn").click();

  const locked = page.locator("#conn-saved-list .conn-saved-empty--locked");
  await expect(locked).toBeVisible();
  await expect(locked).toContainText("Saved connections are locked");
  await expect(locked.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.locator("#conn-saved-list")).not.toContainText(
    "No saved connections",
  );
});

test("Security tab marks changes as immediate and explains transfer and lock behavior", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-security").click();

  await expect(page.locator("#settings-save")).toBeHidden();
  await expect(page.locator("#settings-panel-security")).toContainText(
    "Changes apply immediately",
  );
  await expect(page.locator("#settings-panel-security")).toContainText(
    /running\s+transfers\s+keep\s+the\s+vault\s+unlocked/i,
  );
  await expect(page.locator("#settings-panel-security")).toContainText(
    /locking\s+disconnects/i,
  );

  await page.locator("#security-lock-timeout").selectOption("15");
  await expect(page.locator("#security-lock-status")).toHaveText(
    "Auto-lock set to 15 minutes",
  );
});

test("Settings password change reports a wrong current password inline", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
    unlockPasswords: ["right-password"],
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-security").click();
  await page.locator("#security-change-password").click();

  await expect(dialog(page)).toHaveClass(/active/);
  await page.locator("#dialog-input").fill("wrong-password");
  await page.locator("#dialog-ok").click();

  await expect(dialog(page)).toHaveClass(/active/);
  await expect(page.locator("#dialog-validation-error")).toBeVisible();
});

test("Settings bookmark, theme and update labels match across surfaces", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: true },
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-appearance").click();
  const settingsThemes = await page
    .locator("#settings-panel-appearance .theme-card-label")
    .allTextContents();
  expect(settingsThemes).toEqual(["System", "Light", "Dark"]);

  await page.locator("#settings-tab-updates").click();
  await expect(
    page
      .locator("#settings-panel-updates")
      .getByText("Automatically check for and download updates"),
  ).toBeVisible();
  const channelOptions = await page
    .locator("#setting-update-channel option")
    .allTextContents();
  expect(channelOptions).toEqual(["Stable", "Beta"]);
});

test("Transfers select values are not truncated", async ({ page }) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  // Advanced options are collapsed by default; open them so every select lays out.
  await page.locator('[aria-controls="transfers-advanced"]').click();

  const fit = await page.evaluate(() => {
    const ids = [
      "setting-transfer-performance-preset",
      "setting-transfer-retry-base-ms",
      "setting-download-parallel-threshold-mb",
    ];
    return ids.map((id) => {
      const select = document.getElementById(id) as HTMLSelectElement;
      const style = getComputedStyle(select);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return { id, width: 0, needed: 1 };
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const longest = Math.max(
        ...Array.from(select.options).map(
          (option) => context.measureText(option.text).width,
        ),
      );
      const padding =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      return {
        id,
        width: select.getBoundingClientRect().width,
        needed: longest + padding,
      };
    });
  });
  for (const { id, width, needed } of fit) {
    expect(width, id).toBeGreaterThanOrEqual(needed);
  }
});

test("Wizard shows the biometric caveat and the no-recovery warning", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: false },
    security: {
      initialized: false,
      encryption_enabled: false,
      biometric_available: true,
    },
  });
  await page.goto("/");
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();

  await expect(page.locator("#setup-step-encryption")).toBeVisible();
  await expect(page.locator("#setup-biometric-label")).toBeVisible();
  await expect(page.locator("#setup-biometric-caveat")).toContainText(
    /convenience gate/i,
  );
  await expect(page.locator("#setup-step-encryption")).toContainText(
    /can.t be recovered/i,
  );
});

test("Wizard Back after enabling encryption keeps the enabled state", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { _setupComplete: false },
    security: { initialized: false, encryption_enabled: false },
  });
  await page.goto("/");
  await page.locator("#setup-welcome-next").click();
  await page.locator("#setup-theme-next").click();
  await page.locator("#setup-enc-password").fill("correct-horse-1");
  await page.locator("#setup-enc-confirm").fill("correct-horse-1");
  await page.locator("#setup-enc-next").click();
  await expect(page.locator("#setup-step-updates")).toBeVisible();

  await page.locator("#setup-updates-back").click();
  await expect(page.locator("#setup-step-encryption")).toBeVisible();
  await expect(page.locator("#setup-enc-password")).toBeDisabled();
  await expect(page.locator("#setup-enc-next")).toHaveText("Continue");
  await expect(page.locator("#setup-step-encryption")).toContainText(
    "Encryption enabled",
  );

  await page.locator("#setup-enc-next").click();
  await expect(page.locator("#setup-step-updates")).toBeVisible();
  const calls = await readMockCallLog(page);
  expect(
    calls.filter((call) => call.command === "initialize_security"),
  ).toHaveLength(1);
});

test("Manual installs still show Check now and the auto-check toggle", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-updates").click();
  await expect(page.locator("#settings-check-updates")).toBeVisible();
  await expect(page.locator("#setting-updates")).toBeVisible();
  await expect(page.locator("#settings-open-release-page")).toBeVisible();
});

test("Escape on a clean Settings view still closes without a prompt", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  await expect(dialog(page)).not.toHaveClass(/active/);
});
