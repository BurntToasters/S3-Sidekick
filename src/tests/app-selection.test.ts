import { beforeEach, describe, expect, it } from "vitest";
import {
  addSelection,
  clearAllSelection,
  entryFromRow,
  folderEntry,
  fileEntry,
  getSelectionEntries,
  isSelected,
  removeSelection,
} from "../app-selection.ts";
import { state } from "../state.ts";

function rowWith(attrs: Record<string, string>): HTMLElement {
  const row = document.createElement("tr");
  for (const [name, value] of Object.entries(attrs)) {
    row.dataset[name] = value;
  }
  return row;
}

describe("selection identity", () => {
  beforeEach(() => {
    clearAllSelection();
  });

  it("keeps a file named prefix:<x> a file, not the folder <x>", () => {
    addSelection(fileEntry("prefix:archive"));

    expect(state.selectedKeys.has("prefix:archive")).toBe(true);
    expect(state.selectedPrefixes.size).toBe(0);
    expect(isSelected(folderEntry("archive"))).toBe(false);
    expect(getSelectionEntries()).toEqual([
      { kind: "file", key: "prefix:archive" },
    ]);
  });

  it("keeps a file and a folder with the same text distinct", () => {
    addSelection(fileEntry("archive"));

    expect(isSelected(folderEntry("archive/"))).toBe(false);
    removeSelection(folderEntry("archive/"));
    expect(isSelected(fileEntry("archive"))).toBe(true);

    removeSelection(fileEntry("archive"));
    expect(isSelected(fileEntry("archive"))).toBe(false);
  });

  it("stores folders by prefix and lists files before folders", () => {
    addSelection(folderEntry("docs/"));
    addSelection(fileEntry("prefix:docs/"));

    expect(isSelected(folderEntry("docs/"))).toBe(true);
    expect(getSelectionEntries()).toEqual([
      { kind: "file", key: "prefix:docs/" },
      { kind: "folder", key: "docs/" },
    ]);
  });

  it("decodes object rows from their dataset without parsing key text", () => {
    expect(entryFromRow(rowWith({ key: "prefix:archive" }))).toEqual({
      kind: "file",
      key: "prefix:archive",
    });
    expect(entryFromRow(rowWith({ prefix: "archive/" }))).toEqual({
      kind: "folder",
      key: "archive/",
    });
    expect(entryFromRow(rowWith({}))).toBeNull();
  });
});
