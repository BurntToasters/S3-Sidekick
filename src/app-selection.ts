import { state } from "./state.ts";

const PREFIX_TAG = "prefix:";

/**
 * Selection is stored structurally, not by string prefix.
 *
 * Files live in `selectedKeys`, folders in `selectedPrefixes`. The previous
 * encoding stored folders as `"prefix:" + prefix` in the same set as file
 * keys, so a legal object key beginning with `prefix:` was decoded as a
 * folder and destructive actions targeted the wrong path.
 */
export function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys);
}

export function getSelectedPrefixes(): string[] {
  return Array.from(state.selectedPrefixes);
}

export function selectionCount(): number {
  return state.selectedKeys.size + state.selectedPrefixes.size;
}

export function isSelected(semanticKey: string): boolean {
  if (semanticKey.startsWith(PREFIX_TAG)) {
    return state.selectedPrefixes.has(semanticKey.slice(PREFIX_TAG.length));
  }
  return state.selectedKeys.has(semanticKey);
}

export function addSelection(semanticKey: string): void {
  if (semanticKey.startsWith(PREFIX_TAG)) {
    state.selectedPrefixes.add(semanticKey.slice(PREFIX_TAG.length));
  } else {
    state.selectedKeys.add(semanticKey);
  }
}

export function removeSelection(semanticKey: string): void {
  if (semanticKey.startsWith(PREFIX_TAG)) {
    state.selectedPrefixes.delete(semanticKey.slice(PREFIX_TAG.length));
  } else {
    state.selectedKeys.delete(semanticKey);
  }
}

export function clearAllSelection(): void {
  state.selectedKeys.clear();
  state.selectedPrefixes.clear();
}

/** Selection as semantic keys (`prefix:x` for folders, raw keys for files). */
export function getSelectionEntries(): Set<string> {
  const entries = new Set<string>(state.selectedKeys);
  for (const prefix of state.selectedPrefixes) {
    entries.add(PREFIX_TAG + prefix);
  }
  return entries;
}
