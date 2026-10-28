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

async function snap(
  page: Page,
  testInfo: { project: { name: string } },
  theme: TourTheme,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: shotPath(testInfo, theme, name),
    animations: "disabled",
  });
}

async function openTour(
  page: Page,
  theme: TourTheme,
  options: { objectCount?: number; width?: number; height?: number } = {},
): Promise<void> {
  await page.setViewportSize({
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await openMockListing(page, {
    objectCount: options.objectCount ?? 40,
    prefixes: TOUR_PREFIXES,
    settings: { theme },
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
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
