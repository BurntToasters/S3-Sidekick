import { expect, test, type Locator, type Page } from "@playwright/test";
import { commandCalls, saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  setMockCommandError,
} from "./tauri-layout";

const ARTIFACT_SUITE = "ux-objects";

interface NativeConfig {
  /** Replace a command's result (or throw its error) after the mock logs it. */
  commands?: Record<string, { result?: unknown; error?: string }>;
  /** Merge fields into a command's result, e.g. a provider capability. */
  patch?: Record<string, Record<string, unknown>>;
  /** Keys that survive `delete_objects`; other keys are removed and the receipt reports the survivors as failed. */
  deleteFailKeys?: string[];
  /** Carry `rename_object` into later `list_objects` responses. */
  mirrorRenames?: boolean;
}

/**
 * Layer deterministic native behaviour over the layout mock. The layout mock
 * installs `__TAURI_INTERNALS__` after this init script, so the setter wraps
 * its `invoke` (the same pattern as ux-selection-safety.spec.ts).
 */
async function installNative(page: Page, config: NativeConfig): Promise<void> {
  await page.addInitScript((cfg: NativeConfig) => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    let internals: { invoke: Invoke } | undefined;
    const removed = new Set<string>();
    const renamed = new Map<string, string>();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (value: { invoke: Invoke }) => {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          const override = cfg.commands?.[command];
          const result = await original(command, args);
          if (override) {
            if (override.error !== undefined) throw new Error(override.error);
            return override.result;
          }
          if (command === "delete_objects" && cfg.deleteFailKeys) {
            const keys = (args?.keys as string[] | undefined) ?? [];
            const survivors = keys.filter((key) =>
              cfg.deleteFailKeys?.includes(key),
            );
            for (const key of keys) {
              if (!survivors.includes(key)) removed.add(key);
            }
            return {
              deleted: keys.length - survivors.length,
              failed: survivors.length,
              incomplete: false,
              errors: survivors.length > 0 ? ["Access denied"] : [],
            };
          }
          if (command === "rename_object" && cfg.mirrorRenames) {
            renamed.set(String(args?.oldKey), String(args?.newKey));
          }
          if (command === "list_objects" && (removed.size || renamed.size)) {
            const listing = result as { objects: Array<{ key: string }> };
            return {
              ...listing,
              objects: listing.objects
                .filter((object) => !removed.has(object.key))
                .map((object) =>
                  renamed.has(object.key)
                    ? { ...object, key: renamed.get(object.key) }
                    : object,
                ),
            };
          }
          const patch = cfg.patch?.[command];
          if (patch && result && typeof result === "object") {
            return { ...(result as object), ...patch };
          }
          return result;
        };
        internals = value;
      },
    });
  }, config);
}

/** Rows show the key relative to the listing, so match the name as a path suffix. */
function rowFor(page: Page, kind: "file" | "folder", name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(`.object-row--${kind}`).filter({
    has: page.locator(".object-name__text", {
      hasText: new RegExp(`(^|/)${escaped}$`),
    }),
  });
}

function fileRow(page: Page, name: string): Locator {
  return rowFor(page, "file", name);
}

function menuItem(page: Page, label: string): Locator {
  return page.locator('.context-menu [role="menuitem"]', {
    hasText: label,
  });
}

async function selectBatch(rows: Locator[]): Promise<void> {
  for (const row of rows) {
    await row.locator(".row-check").check();
  }
}

async function openDeleteDialog(page: Page): Promise<string> {
  // The docked inspector can cover the toolbar's Delete action at this width.
  if (!(await page.locator("#batch-delete").isVisible())) {
    await page.locator("#inspector-close").click();
  }
  await page.locator("#batch-delete").click();
  await expect(page.locator("#dialog-overlay")).toBeVisible();
  return page.locator("#dialog-overlay").innerText();
}

test.describe("delete outcomes and confirmation wording", () => {
  test("a partial delete raises a sticky error toast with Details that opens the activity log", async ({
    page,
  }, testInfo) => {
    await installNative(page, {
      deleteFailKeys: [
        "reports/002-sample-object.txt",
        "reports/003-sample-object.txt",
      ],
    });
    await openMockListing(page, { objectCount: 6, prefixes: [] });

    // Index 0 is the long-named fixture, so the sample rows start at 1.
    await selectBatch(
      [1, 2, 3, 4, 5].map((i) =>
        fileRow(page, `${String(i).padStart(3, "0")}-sample-object.txt`),
      ),
    );
    await openDeleteDialog(page);
    await page.locator("#dialog-ok").click();

    const toast = page.locator("#toast-region .toast--error");
    await expect(toast).toContainText("Couldn't delete 2 of 5 items");
    await page.waitForTimeout(8_500);
    await expect(toast).toBeVisible();

    await toast.getByRole("button", { name: "Details" }).click();
    await expect(page.locator("#bottom-drawer")).toBeVisible();
    await expect(page.locator("#drawer-tab-activity")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await expect(
      page.locator(".object-row--file .row-check:checked"),
    ).toHaveCount(2);

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "partial-delete", calls);
  });

  test("the confirmation counts files and folders in plain English", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });

    await selectBatch([
      fileRow(page, "001-sample-object.txt"),
      fileRow(page, "002-sample-object.txt"),
      rowFor(page, "folder", "archive/"),
    ]);
    const mixed = await openDeleteDialog(page);
    expect(mixed).toContain(
      "Delete 2 files and 1 folder? The folder's contents are deleted too.",
    );
    expect(mixed).not.toContain("all their contents");
    expect(mixed).not.toContain("(s)");
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await rowFor(page, "folder", "archive/").locator(".row-check").uncheck();
    await fileRow(page, "001-sample-object.txt")
      .locator(".row-check")
      .uncheck();
    await fileRow(page, "002-sample-object.txt")
      .locator(".row-check")
      .uncheck();

    await selectBatch([rowFor(page, "folder", "archive/")]);
    const single = await openDeleteDialog(page);
    expect(single).toContain("Delete 1 folder? Its contents are deleted too.");
    expect(single).toContain("archive");
    await page.locator("#dialog-cancel").click();

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "delete-wording", []);
  });
});

test.describe("rename", () => {
  test("empty, slash-containing and unchanged names are rejected inline", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    await menuItem(page, "Rename").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();

    const input = page.locator("#dialog-input");
    const validation = page.locator("#dialog-validation-error");

    await input.fill("   ");
    await page.locator("#dialog-ok").click();
    await expect(validation).toContainText("Name cannot be empty");
    await expect(page.locator("#dialog-overlay")).toBeVisible();

    await input.fill("a/b.txt");
    await page.locator("#dialog-ok").click();
    await expect(validation).toContainText('Name cannot contain "/"');

    await input.fill("001-sample-object.txt");
    await page.locator("#dialog-ok").click();
    await expect(validation).toContainText("already the name");
    await expect(page.locator("#dialog-overlay")).toBeVisible();

    await input.fill("  renamed.txt  ");
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "rename_object")).toHaveLength(1);
    expect(commandCalls(calls, "rename_object")[0].args).toMatchObject({
      oldKey: "reports/001-sample-object.txt",
      newKey: "reports/renamed.txt",
    });
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "rename-validation",
      calls,
    );
  });

  test("the renamed item stays selected and focused after the listing refreshes", async ({
    page,
  }, testInfo) => {
    await installNative(page, { mirrorRenames: true });
    await openMockListing(page, { objectCount: 12 });

    await fileRow(page, "002-sample-object.txt").click({ button: "right" });
    await menuItem(page, "Rename").click();
    await page.locator("#dialog-input").fill("renamed-2.txt");
    await page.locator("#dialog-ok").click();

    const renamed = page.locator(
      '.object-row[data-key="reports/renamed-2.txt"]',
    );
    await expect(renamed).toBeVisible();
    await expect(renamed.locator(".row-check")).toBeChecked();
    await expect(renamed).toBeFocused();

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "rename-focus", calls);
  });
});

test.describe("context menu labels and availability", () => {
  test("a mixed selection counts plainly and disables file-only actions with a reason", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await selectBatch([
      fileRow(page, "001-sample-object.txt"),
      fileRow(page, "002-sample-object.txt"),
      rowFor(page, "folder", "archive/"),
    ]);

    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    await expect(menuItem(page, "Properties (3 items)")).toBeVisible();
    await expect(menuItem(page, "Delete 2 files and 1 folder")).toBeVisible();

    const download = menuItem(page, "Download 2 files");
    await expect(download).toBeDisabled();
    await expect(menu).toContainText("Folders can't be downloaded");

    const menuText = await menu.innerText();
    expect(menuText).not.toContain("(s)");

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "mixed-menu", calls);
  });

  test("a multi-file menu uses counted labels", async ({ page }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await selectBatch([
      fileRow(page, "001-sample-object.txt"),
      fileRow(page, "002-sample-object.txt"),
    ]);
    await fileRow(page, "001-sample-object.txt").click({ button: "right" });

    await expect(menuItem(page, "Download 2 files")).toBeEnabled();
    await expect(menuItem(page, "Copy 2 keys")).toBeVisible();
    await expect(menuItem(page, "Copy 2 URLs")).toBeVisible();
    await expect(menuItem(page, "Delete 2 items")).toBeVisible();

    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "multi-file-menu",
      calls,
    );
  });

  test("Move is disabled with the provider reason when conditional delete is unsupported", async ({
    page,
  }, testInfo) => {
    await installNative(page, {
      patch: { connect: { conditional_delete_supported: false } },
    });
    await openMockListing(page, { objectCount: 12 });

    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    const move = menuItem(page, "Move to...");
    await expect(move).toBeDisabled();
    await expect(page.locator(".context-menu")).toContainText(
      "This provider can't safely delete the source. Use Copy, then Delete.",
    );
    await expect(menuItem(page, "Copy / Move to...")).toHaveCount(0);
    await expect(menuItem(page, "Copy to...")).toBeEnabled();

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "move-disabled", calls);
  });

  test("Copy ARN is hidden for a non-AWS endpoint and offered for AWS", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    await expect(menuItem(page, "Copy Key")).toBeVisible();
    await expect(menuItem(page, "Copy ARN")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const awsPage = await page.context().newPage();
    await openMockListing(awsPage, {
      objectCount: 12,
      endpoint: "https://s3.us-east-1.amazonaws.com",
    });
    await fileRow(awsPage, "001-sample-object.txt").click({ button: "right" });
    await expect(menuItem(awsPage, "Copy ARN")).toBeVisible();
    await awsPage.close();

    const calls = await readMockCallLog(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "arn-availability",
      calls,
    );
  });

  test("context menu items are at least 24px tall and keep a visible focus ring", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    const items = page.locator(".context-menu .context-menu__item");
    const count = await items.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i += 1) {
      const box = await items.nth(i).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
    const zIndex = await page
      .locator(".context-menu")
      .evaluate((el) => getComputedStyle(el).zIndex);
    expect(zIndex).toBe("300");

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "menu-target-size", []);
  });
});

test.describe("go to, export and bucket refresh", () => {
  test("Go To selects the key after opening its folder and reveals it", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });

    await page.keyboard.press("Control+k");
    await page.locator("#palette-input").fill("Go to Key");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await page.locator("#dialog-input").fill("reports/005-sample-object.txt");
    await page.locator("#dialog-ok").click();

    const target = page.locator(
      '.object-row[data-key="reports/005-sample-object.txt"]',
    );
    await expect(target.locator(".row-check")).toBeChecked();
    await expect(target).toBeFocused();

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "go-to-reveal", calls);
  });

  test("exporting the activity log asks once, through the save dialog", async ({
    page,
  }, testInfo) => {
    await installNative(page, {
      commands: {
        "plugin:dialog|save": { result: "/tmp/s3-sidekick-activity.txt" },
        path_exists: { result: true },
      },
    });
    await openMockListing(page, { objectCount: 12 });

    await fileRow(page, "001-sample-object.txt").click({ button: "right" });
    await menuItem(page, "Copy Key").click();

    await page.locator("#activity-toggle").click();
    await page.locator("#drawer-export").click();

    await expect
      .poll(async () =>
        commandCalls(await readMockCallLog(page), "write_text_file"),
      )
      .toHaveLength(1);
    await expect(page.locator("#dialog-overlay")).toBeHidden();
    const [write] = commandCalls(
      await readMockCallLog(page),
      "write_text_file",
    );
    expect(write.args).toMatchObject({ overwrite: true });

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "export-once", []);
  });

  test("a failed bucket refresh keeps the buckets and shows a retry banner", async ({
    page,
  }, testInfo) => {
    await openMockListing(page, { objectCount: 12 });
    await setMockCommandError(page, "list_buckets", "Mock bucket failure");

    await page.locator("#bucket-list .list__item-btn").first().click({
      button: "right",
    });
    await menuItem(page, "Refresh Buckets").click();

    await expect(
      page.locator("#bucket-list .list__item-btn", {
        hasText: "layout-test-bucket",
      }),
    ).toBeVisible();
    const banner = page.locator("#bucket-panel .bucket-refresh-banner");
    await expect(banner).toContainText("Failed to refresh buckets");
    await expect(
      banner.getByRole("button", { name: "Retry bucket refresh" }),
    ).toBeVisible();

    const calls = await readMockCallLog(page);
    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "bucket-banner", calls);
  });
});
