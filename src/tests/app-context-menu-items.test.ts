import { describe, expect, it, vi } from "vitest";

// The builder is pure; these modules are only needed by the click handlers,
// so empty factories keep the import graph out of the test.
vi.mock("../browser.ts", () => ({}));
vi.mock("../info-panel.ts", () => ({}));
vi.mock("../preview.ts", () => ({}));
vi.mock("../app-objects.ts", () => ({}));
vi.mock("../app-downloads.ts", () => ({}));
vi.mock("../app-upload.ts", () => ({}));
vi.mock("../app-copy-move.ts", () => ({}));
vi.mock("../activity-log.ts", () => ({}));
vi.mock("../app-status.ts", () => ({}));
vi.mock("../app-layout.ts", () => ({}));
vi.mock("../connection.ts", () => ({ invokeS3: () => Promise.resolve("") }));

import { buildObjectMenuItems } from "../app-context-menu.ts";
import type { ObjectActionContext } from "../object-actions.ts";
import type { MenuItem } from "../context-menu.ts";

function selection(
  overrides: Partial<ObjectActionContext> = {},
): ObjectActionContext {
  const base: ObjectActionContext = {
    fileKeys: [],
    folderPrefixes: [],
    total: 0,
    arnSupported: false,
    moveSupported: true,
    canPreviewSingle: false,
    listingLoading: false,
    deleteInFlight: false,
    ...overrides,
  };
  return {
    ...base,
    total: base.fileKeys.length + base.folderPrefixes.length,
  };
}

function actions(items: MenuItem[]) {
  return items.flatMap((item) => (item.separator ? [] : [item]));
}

function find(items: MenuItem[], label: string) {
  const match = actions(items).find((item) => item.label === label);
  if (!match) throw new Error(`no menu item "${label}"`);
  return match;
}

function labels(items: MenuItem[]): string[] {
  return actions(items).map((item) => item.label);
}

describe("object context menu items", () => {
  it("returns no items for an empty selection", () => {
    expect(buildObjectMenuItems(selection())).toEqual([]);
  });

  it("offers folder actions for a single folder", () => {
    const items = buildObjectMenuItems(
      selection({ folderPrefixes: ["docs/"] }),
    );
    expect(labels(items)).toEqual([
      "Open",
      "Properties",
      "Copy keys",
      "Copy S3 URI",
      "Rename",
      "Copy / Move\u2026",
      "Delete Folder",
    ]);
    expect(find(items, "Rename").shortcut).toBe("F2");
    expect(find(items, "Delete Folder").danger).toBe(true);
  });

  it("offers Copy ARNs only when the endpoint is AWS", () => {
    const aws = buildObjectMenuItems(
      selection({ folderPrefixes: ["docs/"], arnSupported: true }),
    );
    expect(labels(aws)).toContain("Copy ARNs");
    const other = buildObjectMenuItems(
      selection({ folderPrefixes: ["docs/"] }),
    );
    expect(labels(other)).not.toContain("Copy ARNs");
  });

  it("offers file actions for one file and Preview only when previewable", () => {
    const plain = buildObjectMenuItems(selection({ fileKeys: ["a.zip"] }));
    expect(labels(plain)).toEqual([
      "Properties",
      "Download",
      "Copy URL",
      "Share link\u2026",
      "Copy keys",
      "Copy S3 URI",
      "Rename",
      "Copy / Move\u2026",
      "Delete",
    ]);

    const previewable = buildObjectMenuItems(
      selection({ fileKeys: ["a.txt"], canPreviewSingle: true }),
    );
    expect(labels(previewable)[0]).toBe("Preview");
  });

  it("counts a multi-file selection and disables single-item actions with a reason", () => {
    const items = buildObjectMenuItems(
      selection({ fileKeys: ["a.txt", "b.txt"], arnSupported: true }),
    );
    expect(find(items, "Properties (2 items)").disabled).toBeFalsy();
    expect(find(items, "Download 2 files").disabled).toBeFalsy();
    expect(find(items, "Copy 2 keys").disabled).toBeFalsy();
    expect(find(items, "Copy URLs").disabled).toBeFalsy();
    expect(find(items, "Copy 2 ARNs").disabled).toBeFalsy();
    expect(find(items, "Delete 2 items").disabled).toBeFalsy();

    const rename = find(items, "Rename");
    expect(rename.disabled).toBe(true);
    expect(rename.disabledReason).toBe("Select one item to rename.");

    const share = find(items, "Share link\u2026");
    expect(share.disabled).toBe(true);
    expect(share.disabledReason).toBe(
      "Pre-signed URLs are made for one file at a time.",
    );
  });

  it("disables file-only actions in a mixed selection and names the reason", () => {
    const items = buildObjectMenuItems(
      selection({ fileKeys: ["a.txt", "b.txt"], folderPrefixes: ["docs/"] }),
    );

    const download = find(items, "Download 2 files");
    expect(download.disabled).toBe(true);
    expect(download.disabledReason).toBe(
      "Folders can't be downloaded. Select files only.",
    );

    const urls = find(items, "Copy URLs");
    expect(urls.disabled).toBe(true);
    expect(urls.disabledReason).toBe("Folders have no URL. Select files only.");

    expect(find(items, "Copy 3 keys").disabled).toBeFalsy();
    expect(find(items, "Properties (3 items)").disabled).toBeFalsy();
    expect(find(items, "Delete 2 files and 1 folder").disabled).toBeFalsy();
  });

  it("offers folder-only plurals without file actions", () => {
    const items = buildObjectMenuItems(
      selection({ folderPrefixes: ["a/", "b/"], arnSupported: true }),
    );
    expect(labels(items).some((label) => label.startsWith("Download"))).toBe(
      false,
    );
    expect(labels(items).some((label) => label.includes("URL"))).toBe(false);
    expect(labels(items).some((label) => label.startsWith("Share link"))).toBe(
      false,
    );
    expect(find(items, "Copy 2 keys").disabled).toBeFalsy();
    expect(find(items, "Copy 2 ARNs").disabled).toBeFalsy();
    expect(find(items, "Delete 2 folders").disabled).toBeFalsy();
  });

  it("replaces Copy / Move with a disabled Move when the provider cannot delete", () => {
    const items = buildObjectMenuItems(
      selection({ fileKeys: ["a.txt"], moveSupported: false }),
    );
    expect(labels(items)).not.toContain("Copy / Move\u2026");
    expect(find(items, "Copy to\u2026").disabled).toBeFalsy();
    const move = find(items, "Move to\u2026");
    expect(move.disabled).toBe(true);
    expect(move.disabledReason).toBe(
      "This provider can't safely delete the source. Use Copy, then Delete.",
    );
  });

  it("never renders a bare plural placeholder", () => {
    const cases: ObjectActionContext[] = [
      selection({ fileKeys: ["a"] }),
      selection({ folderPrefixes: ["a/"] }),
      selection({ fileKeys: ["a", "b"] }),
      selection({ fileKeys: ["a"], folderPrefixes: ["b/"] }),
      selection({ fileKeys: ["a", "b"], folderPrefixes: ["c/", "d/"] }),
    ];
    for (const items of cases.map((c) => buildObjectMenuItems(c))) {
      for (const label of labels(items)) {
        expect(label).not.toContain("(s)");
      }
    }
  });
});
