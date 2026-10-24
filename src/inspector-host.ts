import type { InspectorPaneTab } from "./inspector.ts";

// Preview and properties render inside the inspector, but the inspector also
// owns their lifecycle. Keeping this small callback boundary here means preview
// and info-panel do not import inspector.ts, so those modules can be extracted
// or tested without a runtime import cycle.
type InspectorHost = {
  ensureInspectorOpenForPane(tab: InspectorPaneTab): void;
  focusInspectorPreviewPane(): void;
  focusInspectorPropertiesPane(): void;
  markInspectorHasContent(): void;
};

let host: InspectorHost | null = null;

export function installInspectorHost(next: InspectorHost): void {
  host = next;
}

export function ensureInspectorOpenForPane(tab: InspectorPaneTab): void {
  host?.ensureInspectorOpenForPane(tab);
}

export function focusInspectorPreviewPane(): void {
  host?.focusInspectorPreviewPane();
}

export function focusInspectorPropertiesPane(): void {
  host?.focusInspectorPropertiesPane();
}

export function markInspectorHasContent(): void {
  host?.markInspectorHasContent();
}
