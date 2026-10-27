import { expect, test, type Locator, type Page } from "@playwright/test";
import { openMockListing, readMockCallLog } from "./tauri-layout";

// Inspector edit safety and pane behaviour: header identity, discard prompts,
// Save refresh, tab persistence and tab ARIA.

const ROOT_OBJECTS = [
  {
    key: "notes.txt",
    size: 120,
    last_modified: "2025-01-01T12:00:00.000Z",
    is_folder: false,
  },
  {
    key: "data.json",
    size: 64,
    last_modified: "2025-01-01T12:01:00.000Z",
    is_folder: false,
  },
];

/**
 * The shared layout mock returns a partial head and no preview body. Wrap its
 * invoke so the inspector sees a realistic head, stores metadata writes, and
 * re-reads them on the next head, which is what proves Save shows saved values.
 */
async function openEditableRoot(page: Page): Promise<void> {
  await page.addInitScript((extra) => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    const stored: Record<string, Record<string, string>> = {};
    const contentTypes: Record<string, string> = {
      "notes.txt": "text/plain",
      "data.json": "application/json",
    };
    let internals: { invoke: Invoke } | undefined;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set: (value: { invoke: Invoke }) => {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          const key = String(args?.key ?? "");
          if (command === "list_objects" && !args?.prefix) {
            const result = (await original(command, args)) as {
              objects: unknown[];
            };
            return { ...result, objects: [...extra, ...result.objects] };
          }
          if (command === "head_object") {
            await original(command, args);
            return {
              content_type: contentTypes[key] ?? "text/plain",
              content_length: 120,
              last_modified: "2025-01-01T12:00:00.000Z",
              etag: '"etag-audit"',
              storage_class: "STANDARD",
              cache_control: "",
              content_disposition: "",
              content_encoding: "",
              server_side_encryption: "",
              metadata: { ...(stored[key] ?? {}) },
            };
          }
          if (command === "update_metadata") {
            await original(command, args);
            stored[key] = { ...(args?.metadata as Record<string, string>) };
            return null;
          }
          if (command === "get_object_acl") {
            await original(command, args);
            return { owner: "owner", grants: [] };
          }
          if (command === "build_object_url") {
            await original(command, args);
            return `https://example.invalid/${key}`;
          }
          if (command === "preview_object") {
            await original(command, args);
            return {
              content_type: "text/plain",
              data: `preview of ${key}`,
              is_text: true,
              truncated: false,
              total_size: 16,
            };
          }
          return original(command, args);
        };
        internals = value;
      },
    });
  }, ROOT_OBJECTS);
  await openMockListing(page, { objectCount: 0, prefixes: ["archive/"] });
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(".object-row--file", {
    has: page.locator(".object-name__text", { hasText: name }),
  });
}

async function openPropertiesMetadata(page: Page): Promise<void> {
  await page
    .locator('#inspector-panel [data-inspector-tab="properties"]')
    .click();
  await page.locator('#inspector-pane-info [data-tab="metadata"]').click();
}

async function addHeader(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  await page.locator("#metadata-add-row").click();
  await page.locator(".metadata-entry__key").last().fill(key);
  await page.locator(".metadata-entry__value").last().fill(value);
}

test.describe("inspector edit safety", () => {
  test("Keep editing leaves the header on the object being edited", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await openPropertiesMetadata(page);
    await addHeader(page, "x-audit", "pending");

    await fileRow(page, "data.json").locator(".object-name").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await expect(page.locator("#dialog-title")).toHaveText("Discard changes?");
    await page.locator("#dialog-cancel").click();
    await expect(page.locator("#dialog-overlay")).toBeHidden();

    await expect(page.locator("#inspector-header-title")).toHaveText(
      "notes.txt",
    );
    await expect(page.locator("#inspector-pane-info")).toBeVisible();
  });

  test("Discard moves the inspector to the newly selected object", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await openPropertiesMetadata(page);
    await addHeader(page, "x-audit", "pending");

    await fileRow(page, "data.json").locator(".object-name").click();
    await expect(page.locator("#dialog-overlay")).toBeVisible();
    await page.locator("#dialog-ok").click();

    await expect(page.locator("#inspector-header-title")).toHaveText(
      "data.json",
    );
    await expect(page.locator("#inspector-info-title")).toHaveText("data.json");
  });

  test("Save keeps the Metadata tab and shows the saved header", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await openPropertiesMetadata(page);
    await addHeader(page, "x-audit", "saved-value");

    await page.locator("#inspector-info-save").click();
    await expect(page.locator("#status")).toContainText("Metadata updated.");

    const body = page.locator("#inspector-info-body");
    // Header values are input values, not text, so read them from the fields.
    await expect
      .poll(() =>
        body
          .locator(".metadata-entry__value")
          .evaluateAll((fields) =>
            fields.map((field) => (field as HTMLInputElement).value),
          ),
      )
      .toContain("saved-value");
    await expect(
      page.locator('#inspector-pane-info [data-tab="metadata"]'),
    ).toHaveAttribute("aria-selected", "true");
    const calls = await readMockCallLog(page);
    expect(calls.some((call) => call.command === "update_metadata")).toBe(true);
  });
});

test.describe("inspector tab behaviour", () => {
  test("an explicit Properties tab survives a selection change", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="properties"]')
      .click();
    await fileRow(page, "data.json").locator(".object-name").click();

    await expect(
      page.locator('#inspector-panel [data-inspector-tab="properties"]'),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#inspector-pane-info")).toBeVisible();
    await expect(page.locator("#inspector-pane-preview")).toBeHidden();
  });

  test("inspector tabs expose tablist, tab and tabpanel roles with controls", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    const previewTab = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    await expect(previewTab).toHaveAttribute("role", "tab");
    await expect(previewTab).toHaveAttribute(
      "aria-controls",
      "inspector-pane-preview",
    );
    await expect(page.locator("#inspector-pane-preview")).toHaveAttribute(
      "role",
      "tabpanel",
    );
    await expect(page.locator("#inspector-pane-info")).toHaveAttribute(
      "role",
      "tabpanel",
    );
  });

  test("arrow keys move between inspector tabs and select the focused tab", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    const previewTab = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    const propertiesTab = page.locator(
      '#inspector-panel [data-inspector-tab="properties"]',
    );
    await previewTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(propertiesTab).toBeFocused();
    await expect(propertiesTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#inspector-pane-info")).toBeVisible();
    await page.keyboard.press("Home");
    await expect(previewTab).toBeFocused();
  });

  test("arrow keys move between Properties sub-tabs", async ({ page }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="properties"]')
      .click();
    const general = page.locator('#inspector-pane-info [data-tab="general"]');
    const permissions = page.locator(
      '#inspector-pane-info [data-tab="permissions"]',
    );
    await general.focus();
    await page.keyboard.press("ArrowRight");
    await expect(permissions).toBeFocused();
    await expect(permissions).toHaveAttribute("aria-selected", "true");
  });
});
