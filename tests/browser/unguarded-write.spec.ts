import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  openMockListing,
  readMockCallLog,
  type MockCall,
} from "./tauri-layout";

// A provider that cannot enforce create-only writes (Backblaze B2 / generic
// S3), so every new-destination write asks for "Write anyway" consent.
const NO_CREATE_ONLY = {
  put_object: false,
  complete_multipart: false,
  copy_object: false,
};

const RELEVANT = new Set(["object_exists", "create_folder", "save_settings"]);

function savedSettings(call: MockCall): Record<string, unknown> {
  const json = (call.args as { json?: unknown } | null)?.json;
  return (typeof json === "string" ? JSON.parse(json) : json) as Record<
    string,
    unknown
  >;
}

async function relevantCalls(page: Page): Promise<MockCall[]> {
  return (await readMockCallLog(page)).filter((call) =>
    RELEVANT.has(call.command),
  );
}

async function startNewFolder(page: Page, name: string): Promise<void> {
  await page.locator("#btn-new-folder").click();
  await expect(page.locator("#dialog-title")).toHaveText("New Folder");
  await page.locator("#dialog-input").fill(name);
  await page.locator("#dialog-ok").click();
}

async function createFolderCalls(page: Page): Promise<MockCall[]> {
  return (await relevantCalls(page)).filter(
    (call) => call.command === "create_folder",
  );
}

test("unconditional write warning honors Don't ask again and Settings re-enable", async ({
  page,
}, testInfo) => {
  const outDir = path.join(
    "test-results",
    "unguarded-write",
    testInfo.project.name,
  );
  mkdirSync(outDir, { recursive: true });
  const dialog = page.locator("#dialog-overlay");
  const title = page.locator("#dialog-title");
  const checkbox = page.locator("#dialog-checkbox");

  await openMockListing(page, { createOnlyCapabilities: NO_CREATE_ONLY });

  await test.step("1. warning shows with unchecked box; Cancel writes nothing", async () => {
    await startNewFolder(page, "first");
    await expect(title).toHaveText("Unconditional Write");
    await expect(page.locator("#dialog-checkbox-wrapper")).toBeVisible();
    await expect(page.locator("#dialog-checkbox-label")).toHaveText(
      "Don't ask again",
    );
    await expect(checkbox).not.toBeChecked();
    await page.screenshot({ path: path.join(outDir, "1-warning.png") });
    await page.locator("#dialog-cancel").click();
    await expect(dialog).not.toHaveClass(/active/);
    expect(await createFolderCalls(page)).toHaveLength(0);
  });

  await test.step("2. keyboard: box is in tab order; checked + Escape changes nothing", async () => {
    await startNewFolder(page, "second");
    await expect(title).toHaveText("Unconditional Write");
    // Destructive default: Cancel has focus, and the checkbox precedes it.
    await expect(page.locator("#dialog-cancel")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toHaveClass(/active/);
    const calls = await relevantCalls(page);
    expect(calls.filter((c) => c.command === "create_folder")).toHaveLength(0);
    expect(calls.filter((c) => c.command === "save_settings")).toHaveLength(0);
  });

  await test.step("3. box resets; Don't ask again + Write anyway persists and writes", async () => {
    await startNewFolder(page, "third");
    await expect(title).toHaveText("Unconditional Write");
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await page.screenshot({ path: path.join(outDir, "3-dont-ask-again.png") });
    await page.locator("#dialog-ok").click();
    await expect(dialog).not.toHaveClass(/active/);
    await expect
      .poll(async () => (await createFolderCalls(page)).length)
      .toBe(1);
    const [created] = await createFolderCalls(page);
    expect(created.args).toMatchObject({ key: "third", overwrite: true });
    const saves = (await relevantCalls(page)).filter(
      (c) => c.command === "save_settings",
    );
    expect(saves.length).toBeGreaterThan(0);
    expect(savedSettings(saves[saves.length - 1])).toMatchObject({
      confirmUnguardedWrites: false,
    });
  });

  await test.step("4. later writes skip the warning", async () => {
    await startNewFolder(page, "fourth");
    await expect
      .poll(async () => (await createFolderCalls(page)).length)
      .toBe(2);
    await expect(dialog).not.toHaveClass(/active/);
    const created = await createFolderCalls(page);
    expect(created[1].args).toMatchObject({
      key: "fourth",
      overwrite: true,
    });
  });

  await test.step("5. Settings shows the warning off; turning it on restores the prompt", async () => {
    await page.locator("#settings-btn").click();
    await page.locator("#settings-tab-transfers").click();
    const setting = page.locator("#setting-confirm-unguarded-writes");
    await expect(setting).toBeVisible();
    await expect(setting).not.toBeChecked();
    await setting.check();
    await page.screenshot({ path: path.join(outDir, "5-settings.png") });
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
    const saves = (await relevantCalls(page)).filter(
      (c) => c.command === "save_settings",
    );
    expect(savedSettings(saves[saves.length - 1])).toMatchObject({
      confirmUnguardedWrites: true,
    });

    await startNewFolder(page, "fifth");
    await expect(title).toHaveText("Unconditional Write");
    await expect(checkbox).not.toBeChecked();
    await page.locator("#dialog-cancel").click();
    await expect(dialog).not.toHaveClass(/active/);
    expect(await createFolderCalls(page)).toHaveLength(2);
  });

  const log = await relevantCalls(page);
  writeFileSync(
    path.join(outDir, "ipc-log.json"),
    `${JSON.stringify(log, null, 2)}\n`,
  );
});
