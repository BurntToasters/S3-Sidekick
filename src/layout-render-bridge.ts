import type { SelectionEntry } from "./app-selection.ts";

// Break the layout -> browser -> layout import cycle. The browser registers its
// renderer when it loads; layout only holds the callback.
let objectTableRenderer: (() => void) | null = null;

export function registerObjectTableRenderer(renderer: () => void): void {
  objectTableRenderer = renderer;
}

export function renderObjectTableFromLayout(): void {
  objectTableRenderer?.();
}

// The object filter debounces its re-render in app-layout. The browser cancels
// that pending render when the filter is cleared, without importing layout.
let filterRenderCanceller: (() => void) | null = null;

export function registerFilterRenderCanceller(canceller: () => void): void {
  filterRenderCanceller = canceller;
}

export function cancelPendingFilterRender(): void {
  filterRenderCanceller?.();
}

// The inspector can return the table selection to the object it is editing
// without importing the browser module, which imports the inspector.
let selectionRestorer: ((entries: readonly SelectionEntry[]) => void) | null =
  null;

export function registerSelectionRestorer(
  restorer: (entries: readonly SelectionEntry[]) => void,
): void {
  selectionRestorer = restorer;
}

export function restoreTableSelectionFromInspector(
  entries: readonly SelectionEntry[],
): void {
  selectionRestorer?.(entries);
}
