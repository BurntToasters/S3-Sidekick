// UX audit 0.12.0 P3a — settings structure, Appearance options and settings bugs.
//
// Failure modes checked before implementation:
// - The Desktop notifications note sits beside its checkbox and overlaps it.
// - Any Settings row can overlap its label, control or note at a phone width.
// - Save hides while Transfers controls are on screen after searching from
//   Security, so a dirty explicit-save change has no reachable Save.
// - Save shows on Appearance when the only match is the instant-apply auto-lock.
// - Opening Security hides Save even while Transfers has unsaved edits.
// - The Discard changes prompt cannot save the draft.
// - Searching "default" matches option text and shows nearly every row.
// - Search ignores section headings, so "Network" finds nothing in Transfers.
// - Density, size units and date format are missing, or do not apply instantly.
// - Cancel does not revert a previewed density.
// - Density does not reach the document at startup.
// - Size units and date format do not re-render the object table.
// - Transfers has no Performance, Behavior, Network or Advanced headings.
// - A performance preset keeps its name after an Advanced value changes.
// - Reset is still inside About and not its own last section.
// - Help is a hover "?" button instead of an inline, linked description.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { saveArtifact } from "./helpers";
import {
  installLayoutTauriMock,
  openMockListing,
  readMockCallLog,
  type MockCall,
} from "./tauri-layout";

const SUITE = "ux-settings-p3a";

async function openSettings(page: Page): Promise<void> {
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-overlay")).toHaveClass(/active/);
}

function dialog(page: Page): Locator {
  return page.locator("#dialog-overlay");
}

function lastCallJson(calls: MockCall[], command: string): unknown {
  const last = calls.filter((call) => call.command === command).at(-1);
  if (!last) throw new Error(`No ${command} call was recorded`);
  return JSON.parse((last.args as { json: string }).json);
}

/**
 * Names every pair of visible direct children of a settings row whose boxes
 * overlap, so a label, control or note drawn over another shows up here.
 */
async function overlappingRowChildren(
  page: Page,
  panelSelector: string,
): Promise<string[]> {
  return page.evaluate((selector) => {
    // A flex child squeezed to zero width still paints its text, so its box is
    // the union of the painted descendants.
    const paintedBox = (el: Element) => {
      const own = el.getBoundingClientRect();
      if (own.width > 0 && own.height > 0) return own;
      const boxes = Array.from(el.querySelectorAll("*"))
        .map((child) => child.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (boxes.length === 0) return null;
      return {
        left: Math.min(...boxes.map((r) => r.left)),
        right: Math.max(...boxes.map((r) => r.right)),
        top: Math.min(...boxes.map((r) => r.top)),
        bottom: Math.max(...boxes.map((r) => r.bottom)),
      };
    };
    const pairs: string[] = [];
    const rows = document.querySelectorAll<HTMLElement>(
      `${selector} .setting-item`,
    );
    for (const row of rows) {
      const kids = Array.from(row.children)
        .map((el) => ({
          name: `${el.tagName.toLowerCase()}#${el.id || el.className}`,
          rect: paintedBox(el),
        }))
        .filter(
          (kid): kid is { name: string; rect: NonNullable<typeof kid.rect> } =>
            kid.rect !== null,
        );
      for (let i = 0; i < kids.length; i += 1) {
        for (let j = i + 1; j < kids.length; j += 1) {
          const a = kids[i].rect;
          const b = kids[j].rect;
          const hit =
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1;
          if (hit) pairs.push(`${kids[i].name} x ${kids[j].name}`);
        }
      }
    }
    return pairs;
  }, panelSelector);
}

test("the Desktop notifications note sits below its checkbox row at any width", async ({
  page,
}, testInfo) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();

  const label = page.locator(
    "#settings-panel-transfers .setting-item:has(#setting-desktop-notifications) label.toggle-row",
  );
  const note = page.locator("#help-desktop-notifications");
  const labelBox = await label.boundingBox();
  const noteBox = await note.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(noteBox).not.toBeNull();
  expect(noteBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height - 1);

  expect(
    await overlappingRowChildren(page, "#settings-panel-transfers"),
  ).toEqual([]);
  await saveArtifact(page, testInfo, SUITE, "desktop-notifications-narrow", []);
});

test("Transfers, Appearance, Updates and Sharing rows never overlap their children", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  for (const width of [420, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await openSettings(page);
    for (const tab of ["appearance", "updates", "transfers", "sharing"]) {
      await page.locator(`#settings-tab-${tab}`).click();
      if (tab === "transfers") {
        await page.locator('[aria-controls="transfers-advanced"]').click();
      }
      expect(
        await overlappingRowChildren(page, `#settings-panel-${tab}`),
        `${tab} at ${width}px`,
      ).toEqual([]);
    }
    await page.locator("#settings-cancel").click();
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  }
});

test("Save follows the explicit-save settings on screen, not the active tab", async ({
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

  await page.locator("#settings-search").fill("Concurrent");
  await expect(page.locator("#settings-save")).toBeVisible();

  await page.locator("#settings-search").fill("inactivity");
  await expect(page.locator("#settings-save")).toBeHidden();
});

test("Save stays reachable after a dirty Transfers edit when Security is opened", async ({
  page,
}, testInfo) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    security: { encryption_enabled: true, unlocked: true },
  });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  await page.locator("#setting-max-concurrent").selectOption("5");

  await page.locator("#settings-tab-security").click();
  await expect(page.locator("#settings-save")).toBeVisible();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);

  const calls = await readMockCallLog(page);
  expect(lastCallJson(calls, "save_settings")).toMatchObject({
    maxConcurrentTransfers: 5,
  });
  await saveArtifact(page, testInfo, SUITE, "save-after-security-tab", calls);
});

test("Discard changes? offers Save and saves the draft", async ({
  page,
}, testInfo) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  await page.locator("#setting-max-concurrent").selectOption("5");

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveClass(/active/);
  await expect(page.locator("#dialog-title")).toHaveText("Discard changes?");
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  const calls = await readMockCallLog(page);
  expect(lastCallJson(calls, "save_settings")).toMatchObject({
    maxConcurrentTransfers: 5,
  });
  await saveArtifact(page, testInfo, SUITE, "discard-prompt-save", calls);
});

test("Search matches labels, descriptions and headings, not option text", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);

  await page.locator("#settings-search").fill("default");
  await expect(page.locator(".settings-search-group")).toHaveCount(0);
  await expect(page.locator(".settings-search-empty")).toBeVisible();

  await page.locator("#settings-search").fill("Performance");
  await expect(
    page.locator(".settings-search-group .setting-item").first(),
  ).toBeVisible();
});

test("Density applies at once, Cancel reverts it, and Save keeps it", async ({
  page,
}, testInfo) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "comfortable",
  );

  await page.locator("#setting-density").selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

  await page.locator("#settings-cancel").click();
  await dialog(page)
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "comfortable",
  );

  await openSettings(page);
  await page.locator("#setting-density").selectOption("compact");
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-overlay")).not.toHaveClass(/active/);
  const calls = await readMockCallLog(page);
  expect(lastCallJson(calls, "save_settings")).toMatchObject({
    density: "compact",
  });
  await saveArtifact(page, testInfo, SUITE, "density-compact", calls);
});

test("A saved compact density is applied before the first screen", async ({
  page,
}) => {
  await installLayoutTauriMock(page, {
    objectCount: 0,
    prefixes: [],
    settings: { density: "compact" },
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
});

test("Size units and date format re-render the object table immediately", async ({
  page,
}, testInfo) => {
  await openMockListing(page, { objectCount: 2, prefixes: [] });
  const row = page.locator(".object-row", {
    hasText: "001-sample-object.txt",
  });
  await expect(row.locator(".object-size")).toHaveText("4.5 KB");

  await openSettings(page);
  await page.locator("#setting-size-units").selectOption("decimal");
  await page.locator("#setting-date-format").selectOption("iso");
  await page.locator("#settings-save").click();
  await expect(row.locator(".object-size")).toHaveText("4.6 KB");
  await expect(row.locator(".object-modified")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  );
  await saveArtifact(page, testInfo, SUITE, "size-units-date-format", []);
});

test("Transfers groups its controls under Performance, Behavior, Network and Advanced", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();

  const headings = await page
    .locator("#settings-panel-transfers h3.setting-section")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        (node.textContent ?? "").replace(/[▸\s]+/g, " ").trim(),
      ),
    );
  expect(headings).toEqual(["Performance", "Behavior", "Network", "Advanced"]);
});

test("A performance preset shows Custom after an Advanced value changes", async ({
  page,
}) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-transfers").click();
  await page.locator('[aria-controls="transfers-advanced"]').click();

  const preset = page.locator("#setting-transfer-performance-preset");
  await expect(preset).toHaveValue("balanced");
  await page
    .locator("#setting-download-parallel-threshold-mb")
    .selectOption("256");
  await expect(preset).toHaveValue("custom");

  await preset.selectOption("safe");
  await expect(
    page.locator("#setting-download-parallel-threshold-mb"),
  ).toHaveValue("256");
  await expect(preset).toHaveValue("safe");
});

test("Reset is its own last section, not part of About", async ({ page }) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);

  const lastTab = page.locator(".settings-tabs > button").last();
  await expect(lastTab).toHaveAttribute("id", "settings-tab-reset");
  await page.locator("#settings-tab-about").click();
  await expect(
    page.locator("#settings-panel-about #settings-reset"),
  ).toHaveCount(0);

  await lastTab.click();
  await expect(
    page.locator("#settings-panel-reset #settings-reset"),
  ).toBeVisible();
  await expect(page.locator("#settings-panel-reset")).toContainText("Reset");
});

test("Settings descriptions are visible inline and linked to their control", async ({
  page,
}, testInfo) => {
  await installLayoutTauriMock(page, { objectCount: 0, prefixes: [] });
  await page.goto("/");
  await openSettings(page);
  await page.locator("#settings-tab-updates").click();

  const channel = page.locator("#setting-update-channel");
  const describedBy = await channel.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const description = page.locator(`#${describedBy}`);
  await expect(description).toBeVisible();
  await expect(description).toHaveClass(/setting-description/);
  await expect(description).toContainText("Beta");

  await page.locator("#settings-tab-transfers").click();
  await page.locator("#settings-tab-sharing").click();
  await expect(page.locator("#settings-overlay .setting-help")).toHaveCount(0);
  await saveArtifact(page, testInfo, SUITE, "inline-descriptions", []);
});
