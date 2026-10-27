import { expect, test, type Page } from "@playwright/test";
import {
  connectMockListing,
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  type LayoutMockOptions,
} from "./tauri-layout";
import { FULL_CREATE_ONLY, countOf, openCopyMoveFromRow } from "./helpers";

/**
 * Layer the test-only behaviors on top of the shared layout mock: a
 * conditional-DELETE capability on `connect`, and an optional hold on
 * `object_exists` that models a slow destination check.
 */
async function installModalInfraMock(
  page: Page,
  options: LayoutMockOptions & {
    conditionalDelete?: boolean;
    holdExistenceChecks?: boolean;
    platform?: "linux" | "windows" | "macos";
  } = {},
): Promise<void> {
  await installLayoutTauriMock(page, options);
  const conditionalDelete = options.conditionalDelete ?? false;
  const holdExistenceChecks = options.holdExistenceChecks ?? false;
  const platform = options.platform ?? "linux";
  await page.addInitScript(
    ({ conditionalDelete, holdExistenceChecks, platform }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (
              cmd: string,
              args?: unknown,
              options?: unknown,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      const inner = internals.invoke;
      const pendingExists: Array<() => void> = [];
      let heldExistenceChecks = 0;
      // Hold only until the test releases it. The transfer engine repeats the
      // existence check for each queued item, and a later check must pass
      // through or the queued move never reaches copy_object_to.
      let holding = holdExistenceChecks;
      (
        window as unknown as { __heldExistenceChecks: () => number }
      ).__heldExistenceChecks = () => heldExistenceChecks;
      (
        window as unknown as { __releaseExistenceChecks: () => void }
      ).__releaseExistenceChecks = () => {
        holding = false;
        for (const release of pendingExists.splice(0)) release();
      };
      internals.invoke = async (cmd, args, callOptions) => {
        if (cmd === "get_platform_info") return platform;
        if (cmd === "connect") {
          const result = (await inner(cmd, args, callOptions)) as Record<
            string,
            unknown
          >;
          return { ...result, conditional_delete_supported: conditionalDelete };
        }
        if (cmd === "object_exists" && holding) {
          heldExistenceChecks += 1;
          return new Promise((resolve, reject) => {
            pendingExists.push(() => {
              inner(cmd, args, callOptions).then(resolve, reject);
            });
          });
        }
        return inner(cmd, args, callOptions);
      };
    },
    { conditionalDelete, holdExistenceChecks, platform },
  );
}

async function activeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return "";
    return element.id !== "" ? element.id : element.tagName.toLowerCase();
  });
}

async function isInsideInertSubtree(
  page: Page,
  selector: string,
): Promise<boolean> {
  return page.locator(selector).evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if ((node as HTMLElement & { inert?: boolean }).inert) return true;
    }
    return false;
  });
}

test.describe("modal focus return", () => {
  test("command palette returns focus to the button that opened it", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.locator("#btn-palette").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-overlay")).toBeHidden();
    expect(await activeId(page)).toBe("btn-palette");
  });

  test("command palette returns focus after a mouse-opened palette", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.locator("#btn-palette").click();
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-overlay")).toBeHidden();
    expect(await activeId(page)).toBe("btn-palette");
  });

  test("settings returns focus on Escape and on the X button", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.locator("#settings-btn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
    expect(await activeId(page)).toBe("settings-btn");

    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
    await page.locator("#settings-close").click();
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
    expect(await activeId(page)).toBe("settings-btn");
  });

  test("settings opens with focus on the active tab, not the X button", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        id: el?.id ?? "",
        isSettingsTab: el?.classList.contains("settings-tab") ?? false,
      };
    });
    expect(focused.id).not.toBe("settings-close");
    expect(focused.isSettingsTab || focused.id === "settings-search").toBe(
      true,
    );
  });

  test("new folder returns focus to the toolbar button on Escape", async ({
    page,
  }) => {
    await openMockListing(page);
    await page.locator("#btn-new-folder").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
    expect(await activeId(page)).toBe("btn-new-folder");
  });
});

test.describe("modal focus trap", () => {
  test("Tab cycles inside Settings for ten presses", async ({ page }) => {
    await openMockListing(page);
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
    const escapes: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest("#settings-overlay")),
      );
      if (!inside) escapes.push(i);
    }
    expect(escapes).toEqual([]);
  });
});

test.describe("window controls while a modal is open", () => {
  test("titlebar window controls stay outside the inert background", async ({
    page,
  }) => {
    await installModalInfraMock(page, { platform: "windows" });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
    await expect(page.locator("#titlebar-minimize")).toBeVisible();
    expect(await isInsideInertSubtree(page, "#titlebar-minimize")).toBe(false);
    expect(await isInsideInertSubtree(page, "#titlebar-close")).toBe(false);
    expect(await isInsideInertSubtree(page, "#settings-btn")).toBe(true);
  });
});

test.describe("copy and move dialog", () => {
  test("Escape during a held destination check enqueues nothing", async ({
    page,
  }) => {
    await installModalInfraMock(page, {
      conditionalDelete: true,
      holdExistenceChecks: true,
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-move-btn").click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __heldExistenceChecks: () => number }
          ).__heldExistenceChecks(),
        ),
      )
      .toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);

    await page.evaluate(() =>
      (
        window as unknown as { __releaseExistenceChecks: () => void }
      ).__releaseExistenceChecks(),
    );
    await page.waitForTimeout(500);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(0);
    expect(countOf(calls, "copy_prefix_to")).toBe(0);
    await expect(page.locator("#status")).not.toContainText("Queued");
  });

  test("control: a held move still queues once the check releases without Escape", async ({
    page,
  }) => {
    await installModalInfraMock(page, {
      conditionalDelete: true,
      holdExistenceChecks: true,
      createOnlyCapabilities: FULL_CREATE_ONLY,
      listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
    });
    await page.goto("/");
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-move-btn").click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __heldExistenceChecks: () => number }
          ).__heldExistenceChecks(),
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() =>
      (
        window as unknown as { __releaseExistenceChecks: () => void }
      ).__releaseExistenceChecks(),
    );
    await expect
      .poll(
        async () => countOf(await readMockCallLog(page), "copy_object_to"),
        {
          timeout: 20_000,
        },
      )
      .toBeGreaterThan(0);
  });

  test("Move is disabled with an explanation when the provider cannot delete safely", async ({
    page,
  }) => {
    // Pin the capability explicitly: the shared layout mock reports conditional
    // DELETE support, so relying on its default would not test this state.
    await installModalInfraMock(page, { conditionalDelete: false });
    await page.goto("/");
    await connectMockListing(page);
    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await expect(page.locator("#copy-move-move-btn")).toBeDisabled();
    await expect(page.locator("#copy-move-overlay")).toContainText(
      "This provider can't safely delete the source. Use Copy, then Delete.",
    );
    await expect(page.locator("#copy-move-copy-btn")).toBeEnabled();
  });

  test("Copy with destination equal to source shows an inline error and copies nothing", async ({
    page,
  }) => {
    await installModalInfraMock(page, { conditionalDelete: true });
    await page.goto("/");
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    const description = await page.locator("#copy-move-desc").textContent();
    const sourceKey = (description ?? "").replace(/^File:\s*/, "");
    expect(sourceKey.length).toBeGreaterThan(0);
    await page.locator("#copy-move-path").fill(sourceKey);
    await page.locator("#copy-move-copy-btn").click();
    await expect(page.locator("#copy-move-error")).toBeVisible();
    await expect(page.locator("#copy-move-error")).toContainText(
      "source and destination",
    );
    await page.waitForTimeout(300);
    const calls = await readMockCallLog(page);
    expect(countOf(calls, "copy_object_to")).toBe(0);
  });

  test("the dialog does not prefill a destination equal to the source", async ({
    page,
  }) => {
    await installModalInfraMock(page, { conditionalDelete: true });
    await page.goto("/");
    await connectMockListing(page);

    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    const description = await page.locator("#copy-move-desc").textContent();
    const sourceKey = (description ?? "").replace(/^File:\s*/, "");
    await expect(page.locator("#copy-move-path")).not.toHaveValue(sourceKey);
  });
});

test.describe("keyboard delete from a focused checkbox", () => {
  test("Delete opens the delete confirmation while a row checkbox has focus", async ({
    page,
  }) => {
    await openMockListing(page);
    const row = page.locator(".object-row--file").first();
    await row.locator('input[type="checkbox"]').first().check();
    await row.locator('input[type="checkbox"]').first().focus();
    await page.keyboard.press("Delete");
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-title")).toContainText(/Delete/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });
});

test.describe("showChoiceDialog", () => {
  test("resolves the cancel value on Escape", async ({ page }) => {
    await openMockListing(page);
    const pending = page.evaluate(async () => {
      const dialogs = await import(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/dialogs\.ts(\?|$)/.test(name)) ?? "/dialogs.ts"
      );
      return dialogs.showChoiceDialog(
        "Reset",
        "Keep bookmarks, or factory reset?",
        [
          { value: "keep", label: "Keep bookmarks" },
          { value: "factory", label: "Factory reset", danger: true },
          { value: "cancel", label: "Cancel" },
        ],
        { cancelValue: "cancel" },
      );
    });
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await expect(page.locator("#dialog-choices button")).toHaveText([
      "Keep bookmarks",
      "Factory reset",
      "Cancel",
    ]);
    await page.keyboard.press("Escape");
    await expect(pending).resolves.toBe("cancel");
  });
});
