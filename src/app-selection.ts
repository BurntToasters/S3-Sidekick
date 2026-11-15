import { state } from "./state.ts";

/**
 * One selected row. Kind is explicit: a folder's `key` is its prefix (ending in
 * `/`), a file's `key` is the object key. Selection never infers kind from the
 * text of a key, so a file named `prefix:archive` stays a file.
 */
export interface SelectionEntry {
  readonly kind: "file" | "folder";
  readonly key: string;
}

export function fileEntry(key: string): SelectionEntry {
  return { kind: "file", key };
}

export function folderEntry(prefix: string): SelectionEntry {
  return { kind: "folder", key: prefix };
}

export function isSameEntry(a: SelectionEntry, b: SelectionEntry): boolean {
  return a.kind === b.kind && a.key === b.key;
}

/** Read the identity of an object-table row from its dataset. */
export function entryFromRow(row: HTMLElement): SelectionEntry | null {
  if (row.dataset.key !== undefined) return fileEntry(row.dataset.key);
  if (row.dataset.prefix !== undefined) return folderEntry(row.dataset.prefix);
  return null;
}

export function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys);
}

export function getSelectedPrefixes(): string[] {
  return Array.from(state.selectedPrefixes);
}

export function selectionCount(): number {
  return state.selectedKeys.size + state.selectedPrefixes.size;
}

export function isSelected(entry: SelectionEntry): boolean {
  return entry.kind === "folder"
    ? state.selectedPrefixes.has(entry.key)
    : state.selectedKeys.has(entry.key);
}

export function addSelection(entry: SelectionEntry): void {
  if (entry.kind === "folder") {
    state.selectedPrefixes.add(entry.key);
  } else {
    state.selectedKeys.add(entry.key);
  }
}

export function removeSelection(entry: SelectionEntry): void {
  if (entry.kind === "folder") {
    state.selectedPrefixes.delete(entry.key);
  } else {
    state.selectedKeys.delete(entry.key);
  }
}

export function clearAllSelection(): void {
  state.selectedKeys.clear();
  state.selectedPrefixes.clear();
}

/** Selected rows: files first, then folders. */
export function getSelectionEntries(): SelectionEntry[] {
  return [
    ...getSelectedFileKeys().map(fileEntry),
    ...getSelectedPrefixes().map(folderEntry),
  ];
}
