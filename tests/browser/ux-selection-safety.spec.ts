import { expect, test, type Locator, type Page } from "@playwright/test";
import { commandCalls, saveArtifact } from "./helpers";
import { openMockListing, readMockCallLog } from "./tauri-layout";

const ARTIFACT_SUITE = "ux-selection-safety";

// Root objects that share names with the legacy `prefix:` selection encoding.
// The folder `archive/` and the file `archive.zip` guard against a delete of
// the file `prefix:archive` reaching a folder or a sibling by prefix match.
const ROOT_OBJECTS = [
  {
    key: "archive.zip",
    size: 2048,
    last_modified: "2025-01-01T12:00:00.000Z",
    is_folder: false,
  },
  {
    key: "prefix:archive",
    size: 12,
    last_modified: "2025-01-01T12:01:00.000Z",
    is_folder: false,
  },
];

async function openRootWithExtraObjects(page: Page): Promise<void> {
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
  await openMockListing(page, {
    objectCount: 0,
    prefixes: ["archive/"],
  });
}

function rowFor(page: Page, kind: "file" | "folder", name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(`.object-row--${kind}`).filter({
    has: page.locator(".object-name__text", {
      hasText: new RegExp(`^${escaped}$`),
    }),
  });
}

async function confirmDelete(page: Page): Promise<string> {
  // The docked inspector can cover the toolbar's Delete action at this width.
  if (!(await page.locator("#batch-delete").isVisible())) {
    await page.locator("#inspector-close").click();
  }
  await page.locator("#batch-delete").click();
  await expect(page.locator("#dialog-overlay")).toBeVisible();
  const text = await page.locator("#dialog-overlay").innerText();
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#dialog-overlay")).toBeHidden();
  return text;
}

test.describe("selection identity is structural", () => {
  test("a root file named prefix:<x> is deleted as a file, never as folder <x>", async ({
    page,
  }, testInfo) => {
    await openRootWithExtraObjects(page);

    const fileRow = rowFor(page, "file", "prefix:archive");
    await expect(fileRow).toBeVisible();
    await fileRow.locator(".row-check").check();

    const summary = await page.locator("#batch-count").innerText();
    expect(summary).toBe("1 file selected");

    const dialogText = await confirmDelete(page);
    expect(dialogText).toContain("Delete 1 file?");
    expect(dialogText).toContain("prefix:archive");
    expect(dialogText).not.toContain("folder");

    const calls = await readMockCallLog(page);
    expect(commandCalls(calls, "delete_prefix")).toEqual([]);
    const deleteCalls = commandCalls(calls, "delete_objects");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args).toMatchObject({ keys: ["prefix:archive"] });

    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "prefix-file-delete",
      calls,
    );
  });

  test("a folder selection still deletes through delete_prefix with its trailing slash", async ({
    page,
  }, testInfo) => {
    await openRootWithExtraObjects(page);

    const folderRow = rowFor(page, "folder", "archive/");
    await expect(folderRow).toBeVisible();
    await folderRow.locator(".row-check").check();

    const summary = await page.locator("#batch-count").innerText();
    expect(summary).toBe("1 folder selected");

    const dialogText = await confirmDelete(page);
    expect(dialogText).toContain(
      "Delete 1 folder? Its contents are deleted too.",
    );

    const calls = await readMockCallLog(page);
    const prefixCalls = commandCalls(calls, "delete_prefix");
    expect(prefixCalls).toHaveLength(1);
    expect(prefixCalls[0].args).toMatchObject({ prefix: "archive/" });
    expect(commandCalls(calls, "delete_objects")).toEqual([]);

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "folder-delete", calls);
  });

  test("Properties on a root file named prefix:<x> opens file properties", async ({
    page,
  }, testInfo) => {
    await openRootWithExtraObjects(page);

    const fileRow = rowFor(page, "file", "prefix:archive");
    await expect(fileRow).toBeVisible();
    await fileRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Properties" }).click();

    await expect(page.locator("#inspector-header-title")).toHaveText(
      "prefix:archive",
    );
    await expect(
      page.getByText(
        "Folder selected. Property editing applies to files only.",
      ),
    ).toHaveCount(0);

    const calls = await readMockCallLog(page);
    expect(
      commandCalls(calls, "head_object").some(
        (call) =>
          (call.args as { key?: string } | undefined)?.key === "prefix:archive",
      ),
    ).toBe(true);

    await saveArtifact(
      page,
      testInfo,
      ARTIFACT_SUITE,
      "prefix-file-properties",
      calls,
    );
  });

  test("a mixed file and folder selection deletes each through its own command", async ({
    page,
  }, testInfo) => {
    await openRootWithExtraObjects(page);

    await rowFor(page, "file", "prefix:archive").locator(".row-check").check();
    await rowFor(page, "folder", "archive/").locator(".row-check").check();

    const summary = await page.locator("#batch-count").innerText();
    expect(summary).toBe("1 file + 1 folder selected");

    const dialogText = await confirmDelete(page);
    expect(dialogText).toContain(
      "Delete 1 file and 1 folder? The folder's contents are deleted too.",
    );

    const calls = await readMockCallLog(page);
    const fileDeletes = commandCalls(calls, "delete_objects");
    expect(fileDeletes).toHaveLength(1);
    expect(fileDeletes[0].args).toMatchObject({ keys: ["prefix:archive"] });
    const prefixCalls = commandCalls(calls, "delete_prefix");
    expect(prefixCalls).toHaveLength(1);
    expect(prefixCalls[0].args).toMatchObject({ prefix: "archive/" });

    await saveArtifact(page, testInfo, ARTIFACT_SUITE, "mixed-delete", calls);
  });
});
