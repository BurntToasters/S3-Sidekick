import { expect, test, type Locator, type Page } from "@playwright/test";
import { openMockListing } from "./tauri-layout";

// Command palette behaviour: focus return, ranking, hover/active agreement,
// and reachability of every toolbar action from the palette.

const ROOT_OBJECTS = [
  {
    key: "notes.txt",
    size: 120,
    last_modified: "2025-01-01T12:00:00.000Z",
    is_folder: false,
  },
  {
    key: "photo.png",
    size: 4096,
    last_modified: "2025-01-01T12:01:00.000Z",
    is_folder: false,
  },
];

async function openRootWithObjects(page: Page): Promise<void> {
  await page.addInitScript((extra) => {
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
          if (command === "list_objects" && !args?.prefix) {
            const result = (await original(command, args)) as {
              objects: unknown[];
            };
            return { ...result, objects: [...extra, ...result.objects] };
          }
          return original(command, args);
        };
        internals = value;
      },
    });
  }, ROOT_OBJECTS);
  await openMockListing(page, { objectCount: 0, prefixes: ["archive/"] });
}

function options(page: Page): Locator {
  return page.locator("#palette-results .palette__item");
}

async function typeQuery(page: Page, query: string): Promise<void> {
  await page.locator("#palette-input").fill(query);
}

async function firstLabel(page: Page): Promise<string> {
  return (
    await options(page).first().locator(".palette__item-label").innerText()
  ).trim();
}

test.describe("command palette focus and ranking", () => {
  test("Escape returns focus to the status-bar opener", async ({ page }) => {
    await openRootWithObjects(page);
    const opener = page.locator("#palette-hint");
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-overlay")).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("Ctrl+K opened from a table row returns focus to that row", async ({
    page,
  }) => {
    await openRootWithObjects(page);
    const row = page.locator('.object-row--file[data-key="notes.txt"]');
    await row.locator(".object-name").click();
    await row.focus();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-overlay")).toBeHidden();
    await expect(row).toBeFocused();
  });

  test("initials and keywords rank the matching command first", async ({
    page,
  }) => {
    await openRootWithObjects(page);
    await page.locator("#palette-hint").click();
    await typeQuery(page, "uf");
    expect(await firstLabel(page)).toBe("Upload Files");
    await typeQuery(page, "mkdir");
    expect(await firstLabel(page)).toBe("New folder");
    await typeQuery(page, "ref");
    expect(await firstLabel(page)).toBe("Refresh");
    await page.keyboard.press("Escape");
  });

  test("hovering an option leaves exactly one option marked active", async ({
    page,
  }) => {
    await openRootWithObjects(page);
    await page.locator("#palette-hint").click();
    await typeQuery(page, "o");
    const second = options(page).nth(1);
    await second.hover();
    await expect(
      page.locator("#palette-results [aria-selected='true']"),
    ).toHaveCount(1);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
  });

  test("the keyboard hint sits outside the listbox", async ({ page }) => {
    await openRootWithObjects(page);
    await page.locator("#palette-hint").click();
    await expect(page.locator("#palette-results .palette__hint")).toHaveCount(
      0,
    );
    await expect(page.locator("#palette-shortcut-help")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("toolbar actions are reachable by name from the palette", async ({
    page,
  }) => {
    await openRootWithObjects(page);
    await page
      .locator('.object-row--file[data-key="notes.txt"]')
      .locator(".row-check")
      .check();
    await page.locator("#palette-hint").click();
    await typeQuery(page, "copy url");
    expect(await firstLabel(page)).toBe("Copy URL");
    await typeQuery(page, "location");
    expect(await firstLabel(page)).toBe("Edit Location");
    await typeQuery(page, "back");
    expect(await firstLabel(page)).toBe("Back");
    await page.keyboard.press("Escape");
  });
});
