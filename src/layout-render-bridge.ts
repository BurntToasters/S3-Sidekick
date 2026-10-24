// Break the layout -> browser -> layout import cycle. The browser registers its
// renderer when it loads; layout only holds the callback.
let objectTableRenderer: (() => void) | null = null;

export function registerObjectTableRenderer(renderer: () => void): void {
  objectTableRenderer = renderer;
}

export function renderObjectTableFromLayout(): void {
  objectTableRenderer?.();
}
