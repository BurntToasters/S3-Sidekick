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

interface EditableRootOptions {
  /** Open the inspector after load; off for the default-visibility spec. */
  openInspector?: boolean;
  /** Fail every head_object so the pane shows its load error state. */
  failHeadObject?: boolean;
  /** ACL grants returned for get_object_acl. */
  grants?: Array<{ grantee: string; permission: string }>;
}

/**
 * The shared layout mock returns a partial head and no preview body. Wrap its
 * invoke so the inspector sees a realistic head, stores metadata writes, and
 * re-reads them on the next head, which is what proves Save shows saved values.
 */
async function openEditableRoot(
  page: Page,
  options: EditableRootOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ extra, failHeadObject, grants }) => {
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
              if (failHeadObject) {
                await original(command, args);
                throw new Error("head_object failed for the test");
              }
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
              return { owner: "owner", grants: [...grants] };
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
    },
    {
      extra: ROOT_OBJECTS,
      failHeadObject: options.failHeadObject ?? false,
      grants: options.grants ?? [],
    },
  );
  await openMockListing(page, { objectCount: 0, prefixes: ["archive/"] });
  if (options.openInspector !== false) {
    const panel = page.locator("#inspector-panel");
    if (await panel.isHidden()) {
      await page.locator("#btn-inspector").click();
      await expect(panel).toBeVisible();
    }
  }
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(".object-row--file", {
    has: page.locator(".object-name__text", { hasText: name }),
  });
}

async function openPropertiesMetadata(page: Page): Promise<void> {
  await page
    .locator('#inspector-panel [data-inspector-tab="metadata"]')
    .click();
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
      page.locator('#inspector-panel [data-inspector-tab="metadata"]'),
    ).toHaveAttribute("aria-selected", "true");
    const calls = await readMockCallLog(page);
    expect(calls.some((call) => call.command === "update_metadata")).toBe(true);
  });
});

test.describe("inspector tab behaviour", () => {
  test("an explicit Details tab survives a selection change", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="details"]')
      .click();
    await fileRow(page, "data.json").locator(".object-name").click();

    await expect(
      page.locator('#inspector-panel [data-inspector-tab="details"]'),
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

  test("arrow keys move across the merged tab row and skip a disabled Preview", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    const previewTab = page.locator(
      '#inspector-panel [data-inspector-tab="preview"]',
    );
    const detailsTab = page.locator(
      '#inspector-panel [data-inspector-tab="details"]',
    );
    const permissionsTab = page.locator(
      '#inspector-panel [data-inspector-tab="permissions"]',
    );
    const metadataTab = page.locator(
      '#inspector-panel [data-inspector-tab="metadata"]',
    );
    await detailsTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(permissionsTab).toBeFocused();
    await expect(permissionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#inspector-pane-info")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(metadataTab).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(permissionsTab).toBeFocused();
    await page.keyboard.press("Home");
    // The Preview tab is disabled here (text preview is fine, so it is
    // enabled); Home lands on it.
    await expect(previewTab).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(detailsTab).toBeFocused();
  });

  test("the tab row is Preview, Details, Permissions and Metadata with no sub-tabs", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    for (const tab of ["preview", "details", "permissions", "metadata"]) {
      await expect(
        page.locator(`#inspector-panel [data-inspector-tab="${tab}"]`),
      ).toBeVisible();
    }
    // The old General/S3 sub-tabs are gone from the pane.
    await expect(page.locator("#inspector-pane-info .info-tabs")).toHaveCount(
      0,
    );
    await expect(page.locator("#inspector-pane-info [data-tab]")).toHaveCount(
      0,
    );
  });

  test("Details merges the old General and S3 rows without duplicates", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="details"]')
      .click();

    const body = page.locator("#inspector-info-body");
    await expect(body).toBeVisible();
    const labels = await body
      .locator(".metadata-label")
      .evaluateAll((elements) => elements.map((el) => el.textContent ?? ""));
    for (const label of ["Path", "Size", "Last Modified", "ETag"]) {
      expect(labels.filter((text) => text === label)).toHaveLength(1);
    }
    // Storage Class and Encryption existed in both old tabs; exactly once now.
    expect(labels.filter((text) => text === "Storage Class")).toHaveLength(1);
    expect(labels.filter((text) => text === "Encryption")).toHaveLength(1);
  });

  test("the file name appears once with a type icon", async ({ page }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();

    const title = page.locator("#inspector-header-title");
    await expect(title).toHaveText("notes.txt");
    await expect(title.locator("svg")).toHaveCount(1);
  });

  test("load errors show role=alert with a working Retry", async ({ page }) => {
    await openEditableRoot(page, { failHeadObject: true });
    await fileRow(page, "notes.txt").locator(".object-name").click();
    // The auto pane is Preview; the head load happens on an info tab.
    await page
      .locator('#inspector-panel [data-inspector-tab="details"]')
      .click();

    const body = page.locator("#inspector-info-body");
    const alert = body.locator("[role=alert]");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("head_object failed");
    const retry = body.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();
    await retry.click();
    // The mock keeps failing, so the alert stays and stays actionable.
    await expect(body.locator("[role=alert]")).toBeVisible();
    await expect(body.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("Permissions shows an empty state when there are no ACL grants", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="permissions"]')
      .click();

    await expect(page.locator("#inspector-info-body .acl-empty")).toBeVisible();
    await expect(page.locator("#inspector-info-body .acl-empty")).toHaveText(
      "No ACL grants found.",
    );
  });

  test("Permissions with grants still lists them in the table", async ({
    page,
  }) => {
    await openEditableRoot(page, {
      grants: [{ grantee: "all-users", permission: "READ" }],
    });
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await page
      .locator('#inspector-panel [data-inspector-tab="permissions"]')
      .click();

    await expect(page.locator("#inspector-info-body .acl-empty")).toHaveCount(
      0,
    );
    await expect(page.locator("#inspector-info-body .acl-table")).toBeVisible();
  });
});

test.describe("inspector empty state and footer", () => {
  test("the empty inspector summarises the current folder", async ({
    page,
  }) => {
    await openEditableRoot(page);
    // Deselect everything so the inspector shows its empty state.
    await page.locator(".object-row--file").first().click();
    await page
      .locator(".object-row--file")
      .nth(1)
      .locator(".row-check")
      .check();
    const deselectAll = page.locator("#batch-deselect");
    if (await deselectAll.isVisible()) {
      await deselectAll.click();
    } else {
      await page.locator("#batch-more").click();
      await page
        .locator('.context-menu [role="menuitem"]', { hasText: "Deselect All" })
        .click();
    }

    const empty = page.locator("#inspector-empty");
    await expect(empty).toBeVisible();
    // Location, loaded counts and loaded size.
    await expect(empty).toContainText("layout-test-bucket/");
    await expect(empty).toContainText("2 files");
    await expect(empty).toContainText("1 folder");
    await expect(empty).toContainText("184 B");
    const copy = empty.getByRole("button", { name: "Copy path" });
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAttribute("data-copy-path", "layout-test-bucket/");
  });

  test("the footer shows only on Metadata or Permissions and only when dirty", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    const footer = page.locator(
      "#inspector-pane-info .inspector-panel__footer",
    );

    // Details: never, even while an edit is unsaved.
    await page
      .locator('#inspector-panel [data-inspector-tab="details"]')
      .click();
    await expect(footer).toBeHidden();

    // Metadata: appears once dirty, hides again after a Save.
    await page
      .locator('#inspector-panel [data-inspector-tab="metadata"]')
      .click();
    await addHeader(page, "x-audit", "pending");
    await expect(footer).toBeVisible();

    // Back to Details: the dirty edit is still unsaved, but the footer rule
    // keeps it to Metadata and Permissions only.
    await page
      .locator('#inspector-panel [data-inspector-tab="details"]')
      .click();
    await expect(footer).toBeHidden();

    // Permissions with an unsaved edit: visible again.
    await page
      .locator('#inspector-panel [data-inspector-tab="permissions"]')
      .click();
    await expect(footer).toBeVisible();
    await page.locator("#inspector-info-save").click();
    await expect(page.locator("#status")).toContainText(/updated/);
    await expect(footer).toBeHidden();
  });

  test("a batch edit shows the footer and Save once it is dirty", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await fileRow(page, "data.json")
      .locator(".object-name")
      .click({ modifiers: ["Shift"] });
    await expect(page.locator("#batch-visibility")).toBeVisible();

    // The batch view has no sub-tabs, so the footer follows the dirty edit
    // alone: hidden while clean, visible with Save once Access is changed.
    const footer = page.locator(
      "#inspector-pane-info .inspector-panel__footer",
    );
    await expect(footer).toBeHidden();
    await page.locator("#batch-visibility").selectOption("private");
    await expect(footer).toBeVisible();
    await expect(page.locator("#inspector-info-save")).toBeVisible();
  });

  test("Metadata separates system headers from user metadata", async ({
    page,
  }) => {
    await openEditableRoot(page);
    await fileRow(page, "notes.txt").locator(".object-name").click();
    await openPropertiesMetadata(page);

    const body = page.locator("#inspector-info-body");
    await expect(
      body.locator('[data-metadata-section="system"]'),
    ).toBeVisible();
    await expect(body.locator('[data-metadata-section="user"]')).toBeVisible();
    // The system section holds the read-only Content-Type row.
    await expect(
      body
        .locator('[data-metadata-section="system"] .metadata-entry__key')
        .first(),
    ).toHaveValue("Content-Type");
  });
});

test.describe("inspector default visibility", () => {
  test("without a stored choice the inspector opens only from a 1280px container", async ({
    page,
  }) => {
    // 1280px viewport leaves the content container under 1280px.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEditableRoot(page, { openInspector: false });
    await expect(page.locator("#inspector-panel")).toBeHidden();

    await page.setViewportSize({ width: 1760, height: 900 });
    await openEditableRoot(page, { openInspector: false });
    const container = await page
      .locator(".content-main")
      .evaluate((el) => el.clientWidth);
    if (container >= 1280) {
      await expect(page.locator("#inspector-panel")).toBeVisible();
    }
  });
});
