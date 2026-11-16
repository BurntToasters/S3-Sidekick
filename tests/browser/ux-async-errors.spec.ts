// Failure modes covered (unhandled promise rejections in the webview):
// - An async action rejects without a .catch, so the user sees no status line
//   and the activity log has no entry.
// - A rejection carries raw backend text ("AccessDenied: ...") and the status
//   line shows it unmapped.
// - The status line or activity log shows a stack trace or the raw Error prefix.
import { expect, test } from "@playwright/test";
import { saveArtifact as saveSuiteArtifact } from "./helpers";
import { installLayoutTauriMock, readMockCallLog } from "./tauri-layout";

const SUITE = "ux-async-errors";
const FRIENDLY_ACCESS_DENIED =
  "Unexpected error: Access denied. Check your credentials and permissions.";

test.describe("unhandled promise rejections", () => {
  test("a rejected async action shows a friendly status line and activity entry", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");

    const entries = page.locator("#activity-list .activity-entry");
    const before = await entries.count();

    await page.evaluate(() => {
      void Promise.reject(new Error("AccessDenied: probe failure"));
    });

    await expect(page.locator("#status")).toHaveText(FRIENDLY_ACCESS_DENIED);
    await expect(entries).toHaveCount(before + 1);
    await expect(entries.last().locator(".activity-msg")).toHaveText(
      FRIENDLY_ACCESS_DENIED,
    );
    await expect(page.locator("#status")).not.toContainText("AccessDenied");
    await expect(page.locator("#status")).not.toContainText("    at ");

    const calls = await readMockCallLog(page);
    await saveSuiteArtifact(
      page,
      testInfo,
      SUITE,
      "unhandled-rejection-reported",
      calls,
    );
  });

  test("an unexpected rejection with an Error reports exactly once per rejection", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");

    const entries = page.locator("#activity-list .activity-entry");
    const before = await entries.count();

    await page.evaluate(() => {
      void Promise.reject(new Error("probe failure"));
    });

    await expect(page.locator("#status")).toHaveText(
      "Unexpected error: probe failure",
    );
    await expect(entries).toHaveCount(before + 1);
  });
});
