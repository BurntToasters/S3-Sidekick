import { state } from "./state.ts";

export function getSelectedFileKeys(): string[] {
  return Array.from(state.selectedKeys).filter((k) => !k.startsWith("prefix:"));
}

export function getSelectedPrefixes(): string[] {
  return Array.from(state.selectedKeys)
    .filter((k) => k.startsWith("prefix:"))
    .map((k) => k.slice("prefix:".length));
}
