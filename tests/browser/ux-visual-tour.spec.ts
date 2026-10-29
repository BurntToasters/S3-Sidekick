// Failure modes covered (UI overhaul 0.12.0, visual tour):
// - A screen in the tour fails to render, so the before/after artifact is blank.
// - The persisted theme does not reach the document, so light and dark captures
//   show the same palette.
// - A drawer tab or palette overlay does not open in the tour state.
// - The settings overlay does not open on one of its tabs.
// - A selected row, or the row context menu, is missing at the tour viewport.
// - The browse screen stops rendering rows at the narrow tour widths.
// The tour asserts only that each screen rendered. Screenshots are written to
// test-results/ux-visual-tour/<project>/<phase>/<theme>/<name>.png, where phase
// comes from TOUR_PHASE (default "current"). Run it with TOUR_PHASE=before before
// styling changes and TOUR_PHASE=after afterwards.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openCopyMoveFromRow } from "./helpers.ts";
import { installLayoutTauriMock, openMockListing } from "./tauri-layout.ts";

const THEMES = ["light", "dark"] as const;
type TourTheme = (typeof THEMES)[number];
const PHASE = process.env.TOUR_PHASE ?? "current";
const TOUR_PREFIXES = ["archive/", "logs/", "images/"];
const SETTINGS_TABS = [
  "appearance",
  "updates",
  "transfers",
  "sharing",
  "bookmarks",
  "security",
  "about",
] as const;

const SAVED_CONNECTIONS = [
  {
    name: "Production",
    endpoint: "https://layout-test.invalid",
    region: "us-east-1",
    access_key: "layout-access-key",
    secret_key: "stored-secret",
  },
  {
    name: "Staging",
    endpoint: "https://layout-test.invalid",
    region: "eu-west-1",
    access_key: "staging-access-key",
    secret_key: "staging-secret",
  },
  {
    name: "Archive",
    endpoint: "https://layout-test.invalid",
    region: "us-west-2",
    access_key: "archive-access-key",
    secret_key: "archive-secret",
  },
];

function shotPath(
  testInfo: { project: { name: string } },
  theme: TourTheme,
  name: string,
): string {
  const dir = path.join(
    "test-results",
    "ux-visual-tour",
    testInfo.project.name,
    PHASE,
    theme,
  );
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/**
 * Fixed wall clock for every tour page. The activity log stamps entries with
 * the current time, so a live clock makes those shots differ between runs.
 */
const FROZEN_NOW = new Date("2025-06-15T12:00:00.000Z");

/** Let finite CSS animations and transitions end, then wait two frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return timing !== undefined && timing.endTime !== Infinity;
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    ),
  );
}

async function snap(
  page: Page,
  testInfo: { project: { name: string } },
  theme: TourTheme,
  name: string,
): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: shotPath(testInfo, theme, name),
    animations: "disabled",
  });
}

interface TourOptions {
  objectCount?: number;
  width?: number;
  height?: number;
  /** Saved connections shown in the header switcher and the connect screen. */
  bookmarks?: unknown[];
  /** Serve a fixed text body for `.txt` objects so the Preview tab has content. */
  textPreview?: boolean;
  /** Hold the first copy so one transfer row stays in the drawer. */
  holdCopies?: boolean;
}

/** Fixed body served for `.txt` objects by installTextPreview. */
const TEXT_PREVIEW_BODY = "line one\nline two\nline three";

/**
 * Answer head and preview requests for `.txt` keys with a fixed body. Added
 * before the Tauri mock so the mock's internals setter is wrapped.
 */
async function installTextPreview(page: Page): Promise<void> {
  await page.addInitScript((body: string) => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    let internals: { invoke: Invoke } | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (value: { invoke: Invoke }) => {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          const key = String(args?.key ?? "");
          if (command === "head_object" && key.endsWith(".txt")) {
            return {
              content_type: "text/plain",
              content_length: body.length,
              last_modified: "2025-01-01T12:00:00.000Z",
              etag: '"etag-tour"',
              storage_class: "STANDARD",
              cache_control: "",
              content_disposition: "",
              content_encoding: "",
              server_side_encryption: "",
              metadata: {},
            };
          }
          if (command === "preview_object" && key.endsWith(".txt")) {
            return {
              content_type: "text/plain",
              data: body,
              is_text: true,
              truncated: false,
              total_size: body.length,
            };
          }
          return original(command, args);
        };
        internals = value;
      },
    });
  }, TEXT_PREVIEW_BODY);
}

async function openTour(
  page: Page,
  theme: TourTheme,
  options: TourOptions = {},
): Promise<void> {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.clock.setFixedTime(FROZEN_NOW);
  if (options.textPreview) await installTextPreview(page);
  await openMockListing(page, {
    objectCount: options.objectCount ?? 40,
    prefixes: TOUR_PREFIXES,
    settings: { theme },
    bookmarks: options.bookmarks ?? [],
    transferBackend: options.holdCopies ? { holdCopies: true } : undefined,
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Open the docked inspector when the tour viewport has it closed. */
async function ensureInspectorDocked(page: Page): Promise<void> {
  const layout = page.locator("#main-layout");
  const docked = await layout.evaluate((element) =>
    element.classList.contains("main-layout--inspector-docked"),
  );
  if (!docked) await page.locator("#btn-inspector").click();
  await expect(layout).toHaveClass(/main-layout--inspector-docked/);
}

async function selectFirstFileRow(page: Page): Promise<void> {
  const row = page.locator(".object-row--file").first();
  await row.locator(".row-check").check({ force: true });
  await expect(row).toHaveClass(/object-row--selected/);
}

for (const theme of THEMES) {
  test(`tour: connect screen with saved connections (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.clock.setFixedTime(FROZEN_NOW);
    await installLayoutTauriMock(page, {
      bookmarks: SAVED_CONNECTIONS,
      settings: { theme },
    });
    await page.goto("/");
    await expect(page.locator("#connection-screen")).toBeVisible();
    await expect(page.locator("#conn-saved-list > *")).toHaveCount(3);
    await snap(page, testInfo, theme, "connect-saved");
  });

  test(`tour: browse with objects and prefixes (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme);
    await expect
      .poll(() => page.locator(".object-row").count())
      .toBeGreaterThan(3);
    await snap(page, testInfo, theme, "browse-1280x800");
  });

  test(`tour: browse with one row selected (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme);
    await selectFirstFileRow(page);
    await snap(page, testInfo, theme, "browse-selected");
  });

  test(`tour: row context menu (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme);
    await page.locator(".object-row--file").first().click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await snap(page, testInfo, theme, "row-context-menu");
  });

  test(`tour: command palette (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await snap(page, testInfo, theme, "command-palette");
  });

  test(`tour: transfers drawer (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme);
    await page.locator("#transfer-toggle").click();
    await page.locator("#drawer-tab-transfers").click();
    await expect(page.locator("#drawer-tab-transfers")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await snap(page, testInfo, theme, "drawer-transfers");
  });

  test(`tour: activity drawer (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme);
    await page.locator("#activity-toggle").click();
    await page.locator("#drawer-tab-activity").click();
    await expect(page.locator("#drawer-tab-activity")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await snap(page, testInfo, theme, "drawer-activity");
  });

  for (const tab of SETTINGS_TABS) {
    test(`tour: settings ${tab} (${theme})`, async ({ page }, testInfo) => {
      await openTour(page, theme);
      await page.locator("#settings-btn").click();
      await expect(page.locator("#settings-overlay")).toBeVisible();
      await page.locator(`#settings-tab-${tab}`).click();
      await expect(page.locator(`#settings-tab-${tab}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await snap(page, testInfo, theme, `settings-${tab}`);
    });
  }

  test(`tour: inspector details docked (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme, { width: 1440, height: 800 });
    await selectFirstFileRow(page);
    await ensureInspectorDocked(page);
    const details = page.locator(
      '#inspector-panel [data-inspector-tab="details"]',
    );
    await details.click();
    await expect(details).toHaveAttribute("aria-selected", "true");
    await snap(page, testInfo, theme, "inspector-details-docked");
  });

  test(`tour: inspector text preview docked (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme, {
      width: 1440,
      height: 800,
      textPreview: true,
    });
    await page
      .locator(".object-row--file")
      .first()
      .locator(".object-name")
      .click();
    await ensureInspectorDocked(page);
    const preview = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    if ((await preview.getAttribute("aria-selected")) !== "true") {
      await preview.click();
    }
    await expect(page.locator("#inspector-preview-body")).toContainText(
      "line two",
    );
    await snap(page, testInfo, theme, "inspector-preview-text-docked");
  });

  test(`tour: inspector empty state (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme, { width: 1440, height: 800 });
    await ensureInspectorDocked(page);
    await expect(page.locator("#inspector-empty")).toBeVisible();
    await snap(page, testInfo, theme, "inspector-empty");
  });

  test(`tour: header connection switcher menu (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme, { bookmarks: SAVED_CONNECTIONS });
    await page.locator("#conn-switcher-btn").click();
    await expect(page.locator("#conn-switcher-menu")).toBeVisible();
    await snap(page, testInfo, theme, "conn-switcher-menu");
  });

  test(`tour: confirm delete dialog, then cancel (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme);
    await selectFirstFileRow(page);
    await page.locator("#batch-delete").click();
    await expect(page.locator("#dialog-overlay")).toHaveClass(/active/);
    await snap(page, testInfo, theme, "confirm-delete");
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).not.toHaveClass(/active/);
  });

  test(`tour: share link dialog (${theme})`, async ({ page }, testInfo) => {
    await openTour(page, theme);
    await selectFirstFileRow(page);
    await page.locator("#batch-more").click();
    await page
      .locator('.context-menu [role="menuitem"]', {
        hasText: "Share link\u2026",
      })
      .click();
    await expect(page.locator("#share-link-overlay")).toBeVisible();
    await expect(page.locator("#share-link-expiry")).toBeVisible();
    await snap(page, testInfo, theme, "share-link-dialog");
  });

  test(`tour: setup wizard first step (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.clock.setFixedTime(FROZEN_NOW);
    await installLayoutTauriMock(page, {
      objectCount: 0,
      prefixes: [],
      settings: { theme, _setupComplete: false },
      security: { initialized: false, encryption_enabled: false },
    });
    await page.goto("/");
    await expect(page.locator("#setup-wizard-overlay")).toBeVisible();
    await expect(page.locator("#setup-step-count")).toHaveText("Step 1 of 3");
    await snap(page, testInfo, theme, "setup-wizard-welcome");
  });

  test(`tour: lock view (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.clock.setFixedTime(FROZEN_NOW);
    await installLayoutTauriMock(page, {
      objectCount: 0,
      prefixes: [],
      settings: { theme },
      security: {
        initialized: true,
        encryption_enabled: true,
        unlocked: false,
        lock_timeout_minutes: 30,
      },
    });
    await page.goto("/");
    await expect(page.locator("#lock-view")).toBeVisible();
    await expect(page.locator("#lock-view-password")).toBeFocused();
    await snap(page, testInfo, theme, "lock-view");
  });

  test(`tour: transfers drawer with a running row (${theme})`, async ({
    page,
  }, testInfo) => {
    await openTour(page, theme, { holdCopies: true });
    await openCopyMoveFromRow(page, page.locator(".object-row--file").first());
    await page.locator("#copy-move-path").fill("destination/");
    await page.locator("#copy-move-copy-btn").click();
    await expect(page.locator("#copy-move-overlay")).not.toHaveClass(/active/);
    await page.locator("#transfer-toggle").click();
    await page.locator("#drawer-tab-transfers").click();
    await expect(page.locator("#transfer-list .transfer-item")).toHaveCount(1);
    await snap(page, testInfo, theme, "drawer-transfer-row");
  });

  for (const [width, height] of [
    [900, 640],
    [760, 520],
  ] as const) {
    test(`tour: browse ${width}x${height} with one row selected (${theme})`, async ({
      page,
    }, testInfo) => {
      await openTour(page, theme, { width, height });
      await selectFirstFileRow(page);
      await snap(page, testInfo, theme, `browse-selected-${width}x${height}`);
    });
  }
}
