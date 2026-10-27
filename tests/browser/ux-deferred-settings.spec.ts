// Deferred settings: the desktop notification switch and in-place editing of
// saved connections from the connection screen and Settings.
//
// Failure modes checked before implementation:
// - The Transfers tab has no desktop notification switch, or it starts off.
// - Unchecking the switch is not what gets persisted.
// - Saved connections have no Edit action on the connection screen.
// - Editing the endpoint adds a second row instead of updating the first.
// - A blank secret key overwrites the stored secret.
// - A changed access key is saved with the old secret.
// - Escape leaves a half-finished edit behind, or closes Settings with it.
// - An edit that duplicates another saved endpoint and key is accepted.

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  readMockCallLog,
  type MockCall,
} from "./tauri-layout";

const ALPHA = {
  name: "alpha",
  endpoint: "https://alpha.example.com",
  region: "us-east-1",
  access_key: "AKIAALPHA",
  secret_key: "secret-alpha",
};

const BETA = {
  name: "beta",
  endpoint: "https://beta.example.com",
  region: "us-west-2",
  access_key: "AKIABETA",
  secret_key: "secret-beta",
};

const ARTIFACT_SUITE = "deferred-settings";

async function openSettings(page: Page): Promise<void> {
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
}

function lastCallJson(calls: MockCall[], command: string): unknown {
  const matching = calls.filter((call) => call.command === command);
  const last = matching.at(-1);
  if (!last) throw new Error(`No ${command} call was recorded`);
  return JSON.parse((last.args as { json: string }).json);
}

function countCalls(calls: MockCall[], command: string): number {
  return calls.filter((call) => call.command === command).length;
}

async function editAlphaFromConnectionScreen(page: Page): Promise<void> {
  await page
    .locator('#conn-saved-list button[aria-label="Edit alpha"]')
    .click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
  await expect(page.locator("#bookmark-edit")).toBeVisible();
}

test("Transfers has a Desktop notifications switch that is saved when unchecked", async ({
  page,
}, testInfo: TestInfo) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();

  const toggle = page.locator("#setting-desktop-notifications");
  await expect(toggle).toBeChecked();
  await expect(page.locator("#settings-panel-transfers")).toContainText(
    "Desktop notifications",
  );
  await expect(page.locator("#settings-panel-transfers")).toContainText(
    "in-app toasts still appear",
  );

  await toggle.uncheck();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);

  const calls = await readMockCallLog(page);
  expect(lastCallJson(calls, "save_settings")).toMatchObject({
    desktopNotifications: false,
  });
  await saveArtifact(
    page,
    testInfo,
    ARTIFACT_SUITE,
    "desktop-notifications-off",
    calls,
  );
});

test("Edit on the connection screen opens Settings on the edit form", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA, BETA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await expect(page.locator("#settings-tab-bookmarks")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#bookmark-edit-name")).toHaveValue(ALPHA.name);
  await expect(page.locator("#bookmark-edit-endpoint")).toHaveValue(
    ALPHA.endpoint,
  );
  await expect(page.locator("#bookmark-edit-region")).toHaveValue(ALPHA.region);
  await expect(page.locator("#bookmark-edit-access-key")).toHaveValue(
    ALPHA.access_key,
  );
  await expect(page.locator("#bookmark-edit-secret-key")).toHaveValue("");
  await expect(page.locator("#bookmark-edit-secret-key")).toHaveAttribute(
    "placeholder",
    "Leave blank to keep the current secret",
  );
  await expect(page.locator("#bookmark-edit-save")).toHaveAttribute(
    "type",
    "button",
  );
  await expect(page.locator("#bookmark-edit-cancel")).toHaveAttribute(
    "type",
    "button",
  );
});

test("Changing only the endpoint updates the saved row and keeps the stored secret", async ({
  page,
}, testInfo: TestInfo) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA, BETA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await page
    .locator("#bookmark-edit-endpoint")
    .fill("https://alpha-new.example.com");
  await page.locator("#bookmark-edit-save").click();

  await expect(page.locator("#bookmarks-status")).toContainText("alpha");
  await expect(page.locator("#bookmark-edit")).toBeHidden();
  await expect(page.locator("#bookmark-list .bookmark-item")).toHaveCount(2);
  await expect(page.locator("#bookmark-list")).toContainText(
    "https://alpha-new.example.com",
  );

  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  await expect(page.locator("#conn-saved-list .bookmark-item")).toHaveCount(2);
  await expect(page.locator("#conn-saved-list")).toContainText(
    "https://alpha-new.example.com",
  );

  const calls = await readMockCallLog(page);
  const saved = lastCallJson(calls, "save_bookmarks") as Array<
    Record<string, unknown>
  >;
  expect(saved).toHaveLength(2);
  expect(saved[0]).toMatchObject({
    name: "alpha",
    endpoint: "https://alpha-new.example.com",
    access_key: ALPHA.access_key,
    secret_key: ALPHA.secret_key,
  });
  expect(saved[1]).toEqual(BETA);
  await saveArtifact(
    page,
    testInfo,
    ARTIFACT_SUITE,
    "edit-endpoint-in-place",
    calls,
  );
});

test("A new secret key typed into the edit form replaces the stored one", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await page.locator("#bookmark-edit-secret-key").fill("rotated-secret-value");
  await page.locator("#bookmark-edit-save").click();
  await expect(page.locator("#bookmark-edit")).toBeHidden();

  const saved = lastCallJson(
    await readMockCallLog(page),
    "save_bookmarks",
  ) as Array<Record<string, unknown>>;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    endpoint: ALPHA.endpoint,
    secret_key: "rotated-secret-value",
  });
});

test("Escape on the edit form discards the changes and keeps Settings open", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA, BETA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await page
    .locator("#bookmark-edit-endpoint")
    .fill("https://discarded.example.com");
  await page.locator("#bookmark-edit-name").focus();
  await page.keyboard.press("Escape");

  await expect(page.locator("#bookmark-edit")).toBeHidden();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
  const calls = await readMockCallLog(page);
  expect(countCalls(calls, "save_bookmarks")).toBe(0);
});

test("Cancel on the edit form discards the changes without saving", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await page.locator("#bookmark-edit-region").fill("eu-central-1");
  await page.locator("#bookmark-edit-cancel").click();

  await expect(page.locator("#bookmark-edit")).toBeHidden();
  const calls = await readMockCallLog(page);
  expect(countCalls(calls, "save_bookmarks")).toBe(0);
});

test("An edit that duplicates another saved endpoint and key is refused", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    bookmarks: [ALPHA, BETA],
  });
  await page.goto("/");
  await editAlphaFromConnectionScreen(page);

  await page.locator("#bookmark-edit-endpoint").fill(BETA.endpoint);
  await page.locator("#bookmark-edit-access-key").fill(BETA.access_key);
  await page.locator("#bookmark-edit-secret-key").fill("typed-secret");
  await page.locator("#bookmark-edit-save").click();

  await expect(page.locator("#bookmark-edit-error")).toContainText(
    "already uses this endpoint and access key",
  );
  await expect(page.locator("#bookmark-edit")).toBeVisible();
  const calls = await readMockCallLog(page);
  expect(countCalls(calls, "save_bookmarks")).toBe(0);
});
