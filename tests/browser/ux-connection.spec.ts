import { expect, test, type Page } from "@playwright/test";
import { commandCalls, countOf, saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  releaseMockListing,
} from "./tauri-layout";

const ENDPOINT = "https://layout-test.invalid";
const ARTIFACT_SUITE = "ux-connection";

interface UxHooks {
  /** Platform reported by `get_platform_info`. */
  platform?: string;
  /** Start the window maximized (Windows caption state). */
  maximized?: boolean;
  /** Initial value of the mutable hold flag used by `connect`. */
  holdConnect?: boolean;
}

/**
 * Wrap the shared layout mock's invoke with per-test behavior: a
 * switchable platform, a maximize state, and a `connect` that never settles
 * while `window.__UX__.holdConnect` is true. Must be installed after
 * `installLayoutTauriMock` so the mock's internals already exist.
 */
async function installUxHooks(page: Page, hooks: UxHooks = {}): Promise<void> {
  await page.addInitScript((init: UxHooks) => {
    const ux = {
      platform: init.platform ?? "linux",
      maximized: init.maximized ?? false,
      holdConnect: init.holdConnect ?? false,
    };
    (window as unknown as { __UX__: typeof ux }).__UX__ = ux;
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: unknown) => {
      if (command === "get_platform_info") return ux.platform;
      if (command === "connect" && ux.holdConnect) {
        return new Promise<never>(() => undefined);
      }
      if (command === "plugin:window|is_maximized") return ux.maximized;
      if (command === "plugin:window|toggle_maximize") {
        ux.maximized = !ux.maximized;
        return null;
      }
      return original(command, args);
    };
  }, hooks);
}

async function fillCredentials(page: Page): Promise<void> {
  await page.locator("#conn-endpoint").fill(ENDPOINT);
  await page.locator("#conn-access-key").fill("layout-access-key");
  await page.locator("#conn-secret-key").fill("layout-secret-key");
}

async function dialogVisible(page: Page): Promise<boolean> {
  return page
    .locator("#dialog-overlay")
    .evaluate((el) => el.classList.contains("active"));
}

const savedConnections = [
  {
    name: "Production",
    endpoint: ENDPOINT,
    region: "us-east-1",
    access_key: "layout-access-key",
    secret_key: "stored-secret",
  },
];

test.describe("connection screen UX", () => {
  test("reconnect shows the main layout and skeleton while the last bucket loads", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("s3-sidekick.last-bucket", "layout-test-bucket");
    });
    await installLayoutTauriMock(page, {
      scenario: "loading",
      objectCount: 30,
    });
    await page.goto("/");
    await fillCredentials(page);
    await page.locator("#connect-btn").click();

    await expect(page.locator("#main-layout")).toBeVisible({ timeout: 1000 });
    await expect(page.locator("#connection-screen")).toBeHidden();
    await expect(page.locator(".object-row--skeleton").first()).toBeVisible({
      timeout: 1000,
    });

    await releaseMockListing(page);
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "reconnect-held-listing",
      await readMockCallLog(page),
    );
  });

  test("Enter on a saved connection's delete button asks to delete and does not connect", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    const deleteButton = page.locator('#conn-saved-list [data-delete="0"]');
    await expect(deleteButton).toHaveAttribute(
      "aria-label",
      "Delete Production",
    );
    await deleteButton.focus();
    await page.keyboard.press("Enter");

    await expect.poll(() => dialogVisible(page)).toBe(true);
    await expect(page.locator("#dialog-title")).toContainText(
      /delete saved connection/i,
    );
    await page.locator("#dialog-cancel").click();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(0);
    await expect(page.locator("#connection-screen")).toBeVisible();
  });

  test("Space on a saved connection row connects with that connection", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    const row = page.locator("#conn-saved-list .bookmark-item").first();
    await expect(row).toHaveAttribute("role", "button");
    await row.focus();
    await page.keyboard.press("Space");

    await expect(page.locator("#main-layout")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(1);
  });

  test("Disconnect with a running transfer asks before tearing down the session", async ({
    page,
  }) => {
    await openMockListing(page, {
      objectCount: 1,
      prefixes: [],
      listObjectsByPrefix: { "destination/": { objects: [], prefixes: [] } },
      transferBackend: { holdCopies: true },
    });
    await page.locator(".object-row--file").first().click({ button: "right" });
    await page
      .locator('.context-menu [role="menuitem"]', {
        hasText: "Copy / Move to...",
      })
      .click();
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-copy-btn").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);

    await page.locator("#disconnect-btn").click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#main-layout")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "disconnect")).toBe(0);

    await page.locator("#disconnect-btn").click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "disconnect")).toBeGreaterThan(
      0,
    );
  });

  test("empty submit focuses the first missing field and marks it invalid", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#connect-btn").click();

    const endpoint = page.locator("#conn-endpoint");
    await expect(endpoint).toBeFocused();
    await expect(endpoint).toHaveAttribute("aria-invalid", "true");
    await expect(endpoint).toHaveAttribute(
      "aria-describedby",
      "conn-form-error",
    );
    await expect(page.locator("#conn-form-error")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(0);
  });

  test("credential inputs disable spellcheck and autocorrection", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    for (const id of [
      "conn-endpoint",
      "conn-region",
      "conn-access-key",
      "conn-secret-key",
      "conn-session-token",
    ]) {
      const input = page.locator(`#${id}`);
      await expect(input, id).toHaveAttribute("spellcheck", "false");
      await expect(input, id).toHaveAttribute("autocapitalize", "off");
      await expect(input, id).toHaveAttribute("autocorrect", "off");
      await expect(input, id).toHaveAttribute("autocomplete", "off");
    }
  });

  test("secret and session token reveal toggles are full-opacity 24px targets", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    for (const [toggleId, inputId] of [
      ["secret-key-toggle", "conn-secret-key"],
      ["session-token-toggle", "conn-session-token"],
    ]) {
      const toggle = page.locator(`#${toggleId}`);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      const box = await toggle.boundingBox();
      expect(box?.height ?? 0, toggleId).toBeGreaterThanOrEqual(24);
      expect(box?.width ?? 0, toggleId).toBeGreaterThanOrEqual(24);
      await expect(toggle, toggleId).toHaveCSS("opacity", "1");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveText("Hide");
      await expect(page.locator(`#${inputId}`)).toHaveAttribute("type", "text");
    }
  });

  test("at 820px with the sidebar open, the title does not overlap chips or the badge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 820, height: 640 });
    await openMockListing(page, {
      bookmarks: [
        { ...savedConnections[0], name: "Alpha" },
        { ...savedConnections[0], name: "Beta", access_key: "other-key" },
        { ...savedConnections[0], name: "Gamma", access_key: "third-key" },
      ],
    });
    const overlap = await page.evaluate(() => {
      const rect = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
      };
      const hit = (
        a: ReturnType<typeof rect>,
        b: ReturnType<typeof rect>,
      ): boolean =>
        Boolean(
          a &&
          b &&
          a.w > 0 &&
          b.w > 0 &&
          a.l < b.r &&
          b.l < a.r &&
          a.t < b.b &&
          b.t < a.b,
        );
      const title = rect(document.querySelector(".header__brand"));
      const badge = rect(document.getElementById("connection-status"));
      const chips = Array.from(document.querySelectorAll(".bookmark-chip")).map(
        (chip) => rect(chip),
      );
      return {
        titleHitsBadge: hit(title, badge),
        titleHitsChip: chips.some((chip) => hit(title, chip)),
        chipUnderBadge: chips.some((chip) => hit(chip, badge)),
      };
    });
    expect(overlap).toEqual({
      titleHitsBadge: false,
      titleHitsChip: false,
      chipUnderBadge: false,
    });
  });

  test("bookmark chips are at least 24px tall and bounded in width", async ({
    page,
  }) => {
    const longName = "x".repeat(200);
    await installLayoutTauriMock(page, {
      bookmarks: [{ ...savedConnections[0], name: longName }],
    });
    await page.goto("/");
    const chip = page.locator("#bookmark-bar .bookmark-chip").first();
    const box = await chip.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.width ?? 0).toBeLessThanOrEqual(200);
    await expect(chip).toHaveAttribute("title", /stored|layout-test/);
  });

  test("wheel over the bookmark bar scrolls it horizontally", async ({
    page,
  }) => {
    const bookmarks = Array.from({ length: 16 }, (_, i) => ({
      ...savedConnections[0],
      name: `Connection ${i + 1}`,
      access_key: `key-${i}`,
    }));
    await installLayoutTauriMock(page, { bookmarks });
    await page.goto("/");
    const bar = page.locator("#bookmark-bar");
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(() => bar.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  });

  test("a locked vault shows an Unlock action in the saved connections list", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {
      bookmarks: savedConnections,
      security: { encryption_enabled: true, unlocked: false },
      unlockPasswords: ["correct horse"],
    });
    await page.goto("/");
    await expect(page.locator("#lock-view")).toBeVisible();
    await page.locator("#lock-view-continue").click();
    await expect(page.locator("#lock-view")).toBeHidden();

    const list = page.locator("#conn-saved-list");
    await expect(list).not.toContainText("No saved connections yet");
    const unlock = list.getByRole("button", { name: "Unlock" });
    await expect(unlock).toBeVisible();
    await unlock.click();
    await expect(page.locator("#lock-view")).toBeVisible();
    await page.locator("#lock-view-password").fill("correct horse");
    await page.locator("#lock-view-unlock").click();
    await expect(page.locator("#lock-view")).toBeHidden();

    await expect(list).toContainText("Production");
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "locked-vault-unlock",
      await readMockCallLog(page),
    );
  });

  test("a pending connect turns into Cancel and re-enables the form", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await installUxHooks(page, { holdConnect: true });
    await page.goto("/");
    await fillCredentials(page);
    const connect = page.locator("#connect-btn");
    await connect.click();
    await expect(connect).toHaveText("Cancel");
    await connect.click();

    await expect(connect).toHaveText("Connect");
    await expect(connect).toBeEnabled();
    await expect(page.locator("#conn-endpoint")).toBeEnabled();
    await expect(page.locator("#conn-form-error")).toBeHidden();
  });

  test("R2 preset selects the <account-id> placeholder and keeps the preset", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#conn-provider-preset").selectOption("cloudflare");
    const endpoint = page.locator("#conn-endpoint");
    await expect(endpoint).toHaveValue(
      "https://<account-id>.r2.cloudflarestorage.com",
    );
    await expect(endpoint).toBeFocused();
    const selected = await endpoint.evaluate((el) => {
      const input = el as HTMLInputElement;
      return input.value.slice(
        input.selectionStart ?? 0,
        input.selectionEnd ?? 0,
      );
    });
    expect(selected).toBe("<account-id>");
    await expect(page.locator("#conn-provider-preset")).toHaveValue(
      "cloudflare",
    );
  });

  test("saving a connection suggests a provider, region and key-derived name", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page
      .locator("#conn-endpoint")
      .fill("https://s3.us-east-1.amazonaws.com");
    await page.locator("#conn-region").fill("us-east-1");
    await page.locator("#conn-access-key").fill("AKIAABCDEFGH1234");
    await page.locator("#conn-secret-key").fill("secret");
    await page.locator("#bookmark-save-btn").click();

    await expect.poll(() => dialogVisible(page)).toBe(true);
    await expect(page.locator("#dialog-input")).toHaveValue(
      "AWS · us-east-1 · AKIA…1234",
    );
    await page.locator("#dialog-ok").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "save_bookmarks"))
      .toBeGreaterThan(0);
  });

  test("a saved connection without a secret asks for it on connect and offers to store it", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {
      bookmarks: [{ ...savedConnections[0], secret_key: "" }],
    });
    await page.goto("/");
    await page
      .locator("#bookmark-bar .bookmark-chip", { hasText: "Production" })
      .click();

    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-input").fill("typed-secret");
    await page.locator("#dialog-ok").click();

    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#main-layout")).toBeVisible();
    const calls = await readMockCallLog(page);
    const connectCalls = commandCalls(calls, "connect");
    expect(connectCalls).toHaveLength(1);
    expect(JSON.stringify(connectCalls[0].args)).toContain("typed-secret");
    const saves = commandCalls(calls, "save_bookmarks");
    expect(saves.length).toBeGreaterThan(0);
    expect(JSON.stringify(saves.at(-1)?.args)).toContain("typed-secret");
  });

  test("renaming a saved connection persists the new name", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    await page
      .locator('#conn-saved-list button[aria-label="Rename Production"]')
      .click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-input").fill("Renamed production");
    await page.locator("#dialog-ok").click();

    await expect(page.locator("#conn-saved-list")).toContainText(
      "Renamed production",
    );
    const saves = commandCalls(await readMockCallLog(page), "save_bookmarks");
    expect(JSON.stringify(saves.at(-1)?.args)).toContain("Renamed production");
  });

  test("only the chip whose access key matches the connection looks active", async ({
    page,
  }) => {
    await openMockListing(page, {
      bookmarks: [
        { ...savedConnections[0], name: "Same endpoint A" },
        {
          ...savedConnections[0],
          name: "Same endpoint B",
          access_key: "other-access-key",
        },
      ],
    });
    const active = page.locator(".bookmark-chip--active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText("Same endpoint A");
  });

  test("validation errors for a bookmark appear in the connection form, not only the status bar", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#bookmark-save-btn").click();
    await expect(page.locator("#conn-form-error")).toBeVisible();
    await expect(page.locator("#conn-endpoint")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("Windows caption buttons are clickable below the drag strip", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await installUxHooks(page, { platform: "windows" });
    await page.goto("/");
    await expect(page.locator("#titlebar-win-controls")).toBeVisible();

    for (const id of [
      "titlebar-minimize",
      "titlebar-maximize",
      "titlebar-close",
      "settings-btn",
    ]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, id).not.toBeNull();
      const hitId = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest("button")?.id ?? el?.className ?? "";
        },
        { x: box!.x + box!.width / 2, y: box!.y + 2 },
      );
      expect(hitId, id).toBe(id);
    }
  });

  test("Windows maximize becomes Restore while the window is maximized", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await installUxHooks(page, { platform: "windows" });
    await page.goto("/");
    const maximize = page.locator("#titlebar-maximize");
    await expect(maximize).toHaveAttribute("aria-label", "Maximize");
    await maximize.click();
    await expect(maximize).toHaveAttribute("aria-label", "Restore");
    await expect(maximize).toHaveAttribute("title", "Restore");
    await maximize.click();
    await expect(maximize).toHaveAttribute("aria-label", "Maximize");
  });

  test("license cards expose a chevron, license text, and open links externally", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.route("**/licenses.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          "left-pad@1.0.0": {
            licenses: "MIT",
            repository: "https://github.com/example/left-pad",
            licenseText: "Permission is hereby granted, free of charge",
          },
        }),
      }),
    );
    await page.goto("/");
    await page.evaluate(async () => {
      const licenses = await import(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/licenses\.ts(\?|$)/.test(name)) ?? "/licenses.ts"
      );
      licenses.openLicensesModal();
    });
    const card = page.locator("#licenses-list .license-card").first();
    await expect(card).toBeVisible();
    const chevron = await card
      .locator("summary")
      .evaluate((el) => getComputedStyle(el, "::after").content);
    expect(chevron).not.toBe("none");
    await card.locator("summary").click();
    await expect(card).toContainText("Permission is hereby granted");

    const urlBefore = page.url();
    await card
      .getByRole("link", { name: "https://github.com/example/left-pad" })
      .click();
    await expect
      .poll(
        async () =>
          commandCalls(await readMockCallLog(page), "open_external_url").length,
      )
      .toBe(1);
    expect(page.url()).toBe(urlBefore);
  });

  test("a failed license load offers Retry", async ({ page }) => {
    await installLayoutTauriMock(page, {});
    let attempts = 0;
    await page.route("**/licenses.json", (route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({ status: 500, body: "nope" });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ "only@1.0.0": { licenses: "ISC" } }),
      });
    });
    await page.goto("/");
    await page.evaluate(async () => {
      const licenses = await import(
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/licenses\.ts(\?|$)/.test(name)) ?? "/licenses.ts"
      );
      licenses.openLicensesModal();
    });
    await expect(page.locator("#licenses-list")).toContainText(
      "Failed to load licenses.",
    );
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("#licenses-list")).toContainText("only@1.0.0");
  });
});
