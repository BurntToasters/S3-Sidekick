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

// licenses-cargo.json is generated and gitignored. Without a stub the dev
// server answers its path with index.html, which fails JSON parsing, so the
// outcome would depend on whether the checkout ran `npm run licenses`.
async function stubMissingCargoLicenses(page: Page): Promise<void> {
  await page.route("**/licenses-cargo.json", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
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

/** Open the header connection switcher menu and wait for it to show. */
async function openSwitcherMenu(page: Page): Promise<void> {
  await page.locator("#conn-switcher-btn").click();
  await expect(page.locator("#conn-switcher-menu")).toBeVisible();
}

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
    await page
      .locator(
        '#conn-saved-list .bookmark__menu[aria-label="More actions for Production"]',
      )
      .click();
    const deleteButton = page.locator(
      '#conn-saved-list [role="menuitem"][data-delete="0"]',
    );
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
    const connectBtn = page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first();
    await connectBtn.focus();
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
        hasText: "Copy / Move…",
      })
      .click();
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-copy-btn").click();
    await expect
      .poll(async () => countOf(await readMockCallLog(page), "copy_object_to"))
      .toBe(1);

    await openSwitcherMenu(page);
    await page.locator("#conn-switcher-disconnect").click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#main-layout")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "disconnect")).toBe(0);

    await openSwitcherMenu(page);
    await page.locator("#conn-switcher-disconnect").click();
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

  test("at 820px with the sidebar open, the title does not overlap the switcher or the settings button", async ({
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
      const switcher = rect(document.getElementById("conn-switcher-btn"));
      const settings = rect(document.getElementById("settings-btn"));
      return {
        titleHitsSwitcher: hit(title, switcher),
        switcherHitsSettings: hit(switcher, settings),
        switcherVisible: Boolean(switcher && switcher.w > 0),
      };
    });
    expect(overlap).toEqual({
      titleHitsSwitcher: false,
      switcherHitsSettings: false,
      switcherVisible: true,
    });
  });

  test("the switcher button is at least 24px tall and bounded in width", async ({
    page,
  }) => {
    const longName = "x".repeat(200);
    await installLayoutTauriMock(page, {
      bookmarks: [{ ...savedConnections[0], name: longName }],
    });
    await openMockListing(page);
    const switcher = page.locator("#conn-switcher-btn");
    const box = await switcher.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.width ?? 0).toBeLessThanOrEqual(340);
  });

  test("the switcher menu saved list scrolls when long", async ({ page }) => {
    const bookmarks = Array.from({ length: 16 }, (_, i) => ({
      ...savedConnections[0],
      name: `Connection ${i + 1}`,
      access_key: `key-${i}`,
    }));
    await openMockListing(page, { bookmarks });
    await openSwitcherMenu(page);
    const saved = page.locator("#conn-switcher-saved");
    await page.mouse.move(
      (await saved.boundingBox())!.x + 20,
      (await saved.boundingBox())!.y + 20,
    );
    await page.mouse.wheel(0, 240);
    await expect
      .poll(() => saved.evaluate((el) => el.scrollTop))
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

  test("R2 preset builds the endpoint from the Account ID and keeps the preset", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#conn-provider-preset").selectOption("cloudflare");
    const account = page.locator("#conn-r2-account");
    await expect(account).toBeVisible();
    await expect(account).toBeFocused();
    await account.fill("abc123");
    await expect(page.locator("#conn-endpoint")).toHaveValue(
      "https://abc123.r2.cloudflarestorage.com",
    );
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
    await openSwitcherMenu(page);
    await page
      .locator("#conn-switcher-menu .conn-switcher__connection", {
        hasText: "Production",
      })
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
      .locator(
        '#conn-saved-list .bookmark__menu[aria-label="More actions for Production"]',
      )
      .click();
    await page
      .locator(
        '.bookmark-row-menu__item[role="menuitem"][aria-label="Rename Production"]',
      )
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

  test("only the saved connection matching endpoint and access key shows as current", async ({
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
    await openSwitcherMenu(page);
    const rows = page.locator(
      "#conn-switcher-saved .conn-switcher__connection",
    );
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Same endpoint A" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      rows.filter({ hasText: "Same endpoint B" }),
    ).not.toHaveAttribute("aria-current", "true");
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
    await stubMissingCargoLicenses(page);
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
    await stubMissingCargoLicenses(page);
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

test.describe("P6 connection switcher and remembered locations", () => {
  test("the header shows a connection switcher instead of the chip strip", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    const switcher = page.locator("#conn-switcher-btn");
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText("No connection");
    await expect(page.locator("#bookmark-bar")).toHaveCount(0);
    await expect(page.locator("#connection-status")).toHaveCount(0);
    await expect(page.locator("#disconnect-btn")).toHaveCount(0);
    await expect(page.locator("#conn-switcher-dot")).toHaveAttribute(
      "data-state",
      "off",
    );
  });

  test("the switcher shows the active connection name and endpoint host", async ({
    page,
  }) => {
    await openMockListing(page, { bookmarks: savedConnections });
    const switcher = page.locator("#conn-switcher-btn");
    await expect(switcher).toContainText("Production");
    await expect(switcher).toContainText("layout-test.invalid");
    await expect(page.locator("#conn-switcher-dot")).toHaveAttribute(
      "data-state",
      "on",
    );
  });

  test("the switcher menu lists saved connections and the actions group", async ({
    page,
  }) => {
    await openMockListing(page, {
      bookmarks: [
        ...savedConnections,
        { ...savedConnections[0], name: "Other", access_key: "other-key" },
      ],
    });
    await openSwitcherMenu(page);
    const menu = page.locator("#conn-switcher-menu");
    await expect(menu).toBeVisible();
    const production = menu
      .locator(".conn-switcher__connection", { hasText: "Production" })
      .first();
    await expect(production).toHaveAttribute("aria-current", "true");
    await expect(
      menu.locator(".conn-switcher__connection", { hasText: "Other" }).first(),
    ).not.toHaveAttribute("aria-current", "true");
    await expect(menu.locator("#conn-switcher-new")).toBeVisible();
    await expect(menu.locator("#conn-switcher-manage")).toBeVisible();
    await expect(menu.locator("#conn-switcher-disconnect")).toBeVisible();
    await expect(menu.locator("#conn-switcher-lock")).toBeHidden();
  });

  test("Disconnect from the switcher menu returns to the connection screen", async ({
    page,
  }) => {
    await openMockListing(page, { bookmarks: savedConnections });
    await openSwitcherMenu(page);
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).toBeHidden();
  });

  test("Lock now appears in the switcher when the vault is on", async ({
    page,
  }) => {
    await openMockListing(page, {
      bookmarks: savedConnections,
      security: { encryption_enabled: true, unlocked: true },
    });
    await openSwitcherMenu(page);
    await expect(page.locator("#conn-switcher-lock")).toBeVisible();
  });

  test("Test connection verifies credentials without keeping a session", async ({
    page,
  }, testInfo) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await fillCredentials(page);
    await page.locator("#conn-test-btn").click();

    await expect
      .poll(async () => {
        const calls = await readMockCallLog(page);
        return {
          connect: countOf(calls, "connect"),
          listBuckets: countOf(calls, "list_buckets"),
          disconnect: countOf(calls, "disconnect"),
        };
      })
      .toEqual({ connect: 1, listBuckets: 1, disconnect: 1 });
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).toBeHidden();
    await expect(page.locator("#conn-test-btn")).toBeEnabled();
    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "test-connection-clean",
      await readMockCallLog(page),
    );
  });

  test("a failed test connection leaves no session behind", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {
      errors: { list_buckets: "Mock listing failed" },
    });
    await page.goto("/");
    await fillCredentials(page);
    await page.locator("#conn-test-btn").click();

    await expect
      .poll(async () => countOf(await readMockCallLog(page), "disconnect"))
      .toBe(1);
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#main-layout")).toBeHidden();
  });

  test("Test connection is disabled while a connection is active", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await installUxHooks(page, { holdConnect: true });
    await page.goto("/");
    await fillCredentials(page);
    await page.locator("#connect-btn").click();
    await expect(page.locator("#connect-btn")).toHaveText("Cancel");
    await expect(page.locator("#conn-test-btn")).toBeDisabled();

    await page.locator("#connect-btn").click(); // cancel
    await expect(page.locator("#conn-test-btn")).toBeEnabled();
  });

  test("saved rows are a Connect button plus a row menu", async ({ page }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    const row = page.locator("#conn-saved-list .bookmark-item").first();
    await expect(row.locator(".bookmark-item__connect")).toContainText(
      "Production",
    );
    const more = row.locator(".bookmark__menu");
    await expect(more).toHaveAttribute(
      "aria-label",
      "More actions for Production",
    );
    await more.click();
    const menu = row.locator(".bookmark-row-menu");
    await expect(menu).toBeVisible();
    for (const label of ["Edit", "Rename", "Duplicate", "Delete"]) {
      await expect(
        menu.locator(".bookmark-row-menu__item", { hasText: label }),
      ).toBeVisible();
    }
  });

  test("Duplicate opens the connect form prefilled as a copy", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    await page
      .locator(
        '#conn-saved-list .bookmark__menu[aria-label="More actions for Production"]',
      )
      .click();
    await page
      .locator('.bookmark-row-menu__item[aria-label="Duplicate Production"]')
      .click();

    await expect(page.locator("#conn-name")).toHaveValue("Production (copy)");
    await expect(page.locator("#conn-endpoint")).toHaveValue(ENDPOINT);
    await expect(page.locator("#conn-access-key")).toHaveValue(
      "layout-access-key",
    );
    await expect(page.locator("#conn-secret-key")).toHaveValue("stored-secret");
  });

  test("switching connections restores the remembered bucket and prefix", async ({
    page,
  }) => {
    await openMockListing(page, {
      buckets: [
        { name: "layout-test-bucket" },
        { name: "layout-test-bucket-2" },
      ],
      prefixes: ["docs/"],
      bookmarks: savedConnections,
    });
    // Move to the second bucket and into a folder.
    await page
      .locator('#bucket-list [data-bucket="layout-test-bucket-2"]')
      .click();
    await expect(page.locator("#object-panel")).toBeVisible();
    await page.locator('.object-row--folder[data-prefix="docs/"]').focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator('.breadcrumb__segment[aria-current="page"]'),
    ).toHaveText("docs");

    // Disconnect, then switch back to the same saved connection.
    await openSwitcherMenu(page);
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();
    await openSwitcherMenu(page);
    await page
      .locator("#conn-switcher-menu .conn-switcher__connection", {
        hasText: "Production",
      })
      .click();

    await expect(page.locator("#main-layout")).toBeVisible();
    await expect(
      page.locator('.breadcrumb__segment[aria-current="page"]'),
    ).toHaveText("docs");
    await expect(
      page.locator(
        '#bucket-list .list__item--active [data-bucket="layout-test-bucket-2"]',
      ),
    ).toHaveCount(1);
  });

  test("the connection screen offers a Reconnect to the last used connection card", async ({
    page,
  }) => {
    await openMockListing(page, { bookmarks: savedConnections });
    await openSwitcherMenu(page);
    await page.locator("#conn-switcher-disconnect").click();
    await expect(page.locator("#connection-screen")).toBeVisible();

    const card = page.locator("#reconnect-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Reconnect to");
    await expect(card).toContainText("Production");
    await page.locator("#reconnect-card-btn").click();
    await expect(page.locator("#main-layout")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(2);
  });

  test("the saved list shows a filter input only with more than 8 connections", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {
      bookmarks: Array.from({ length: 10 }, (_, i) => ({
        ...savedConnections[0],
        name: i === 9 ? "Staging" : `Conn ${i}`,
        access_key: `key-${i}`,
      })),
    });
    await page.goto("/");
    const filter = page.locator("#conn-saved-filter");
    await expect(filter).toBeVisible();
    await filter.fill("stag");
    const rows = page.locator("#conn-saved-list .bookmark-item");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Staging");

    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    await expect(page.locator("#conn-saved-filter")).toBeHidden();
  });

  test("editing the endpoint switches the preset to Custom", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    const preset = page.locator("#conn-provider-preset");
    const endpoint = page.locator("#conn-endpoint");
    await preset.selectOption("aws");
    await expect(endpoint).toHaveValue("https://s3.us-east-1.amazonaws.com");
    await endpoint.fill("https://custom.example.com");
    await expect(preset).toHaveValue("custom");
  });

  test("changing the AWS region rewrites the endpoint", async ({ page }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#conn-provider-preset").selectOption("aws");
    await page.locator("#conn-region").fill("eu-west-1");
    await expect(page.locator("#conn-endpoint")).toHaveValue(
      "https://s3.eu-west-1.amazonaws.com",
    );
  });

  test("the R2 preset asks for the Account ID and builds the endpoint", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#conn-provider-preset").selectOption("cloudflare");
    const account = page.locator("#conn-r2-account");
    await expect(account).toBeVisible();
    await expect(account).toBeFocused();
    await account.fill("abc123");
    await expect(page.locator("#conn-endpoint")).toHaveValue(
      "https://abc123.r2.cloudflarestorage.com",
    );
  });

  test("blur shows a per-field endpoint error that clears on correction", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    const endpoint = page.locator("#conn-endpoint");
    await endpoint.fill("not-a-url");
    await page.locator("#conn-region").click(); // blur the endpoint
    await expect(page.locator("#conn-form-error")).toBeVisible();
    await expect(page.locator("#conn-form-error")).toContainText("http");
    await expect(endpoint).toHaveAttribute("aria-invalid", "true");

    await endpoint.fill("https://ok.example.com");
    await page.locator("#conn-region").click();
    await expect(page.locator("#conn-form-error")).toBeHidden();
    await expect(endpoint).not.toHaveAttribute("aria-invalid", "true");
  });
});

test.describe("P6 saved rows, duplicates, and test connection guards", () => {
  test("clicking a saved connection's Connect button connects with it", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    await page
      .locator("#conn-saved-list .bookmark-item__connect")
      .first()
      .click();
    await expect(page.locator("#main-layout")).toBeVisible();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(1);
  });

  test("choosing a row menu item closes the row menu", async ({ page }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    const row = page.locator("#conn-saved-list .bookmark-item").first();
    await row.locator(".bookmark__menu").click();
    await expect(row.locator(".bookmark-row-menu")).toBeVisible();
    await row.locator('.bookmark-row-menu__item[data-rename="0"]').click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await expect(row.locator(".bookmark-row-menu")).toBeHidden();
    await page.locator("#dialog-cancel").click();
  });

  test("saving a duplicate with the same endpoint and access key asks for a different key", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, { bookmarks: savedConnections });
    await page.goto("/");
    await page
      .locator(
        '#conn-saved-list .bookmark__menu[aria-label="More actions for Production"]',
      )
      .click();
    await page
      .locator('.bookmark-row-menu__item[aria-label="Duplicate Production"]')
      .click();
    const before = countOf(await readMockCallLog(page), "save_bookmarks");
    await page.locator("#bookmark-save-btn").click();
    await expect(page.locator("#conn-form-error")).toContainText(
      "already uses this endpoint and access key",
    );
    await expect(page.locator("#conn-access-key")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(countOf(await readMockCallLog(page), "save_bookmarks")).toBe(before);
  });

  test("Test connection over plain HTTP to a remote host asks before sending credentials", async ({
    page,
  }) => {
    await installLayoutTauriMock(page, {});
    await page.goto("/");
    await page.locator("#conn-endpoint").fill("http://remote.example.com");
    await page.locator("#conn-access-key").fill("layout-access-key");
    await page.locator("#conn-secret-key").fill("layout-secret-key");
    await page.locator("#conn-test-btn").click();
    await expect.poll(() => dialogVisible(page)).toBe(true);
    await expect(page.locator("#dialog-title")).toHaveText(
      "Insecure connection",
    );
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#conn-test-btn")).toBeEnabled();
    expect(countOf(await readMockCallLog(page), "connect")).toBe(0);
  });
});
