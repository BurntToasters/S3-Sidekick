import type { InspectorInfoTab, InspectorPaneTab } from "./inspector.ts";
import type { SelectionEntry } from "./app-selection.ts";

// Preview and properties render inside the inspector, but the inspector also
// owns their lifecycle. Keeping this small callback boundary here means preview
// and info-panel do not import inspector.ts, so those modules can be extracted
// or tested without a runtime import cycle.
type InspectorHost = {
  ensureInspectorOpenForPane(tab: InspectorPaneTab): void;
  focusInspectorPreviewPane(): void;
  focusInspectorInfoPane(tab: InspectorInfoTab): void;
  markInspectorHasContent(): void;
  setInspectorTitle(label: string, entry: SelectionEntry | null): void;
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

export function focusInspectorInfoPane(tab: InspectorInfoTab): void {
  host?.focusInspectorInfoPane(tab);
}

export function markInspectorHasContent(): void {
  host?.markInspectorHasContent();
}

/** Names the shown object once in the inspector header, with its type icon. */
export function setInspectorTitle(
  label: string,
  entry: SelectionEntry | null,
): void {
  host?.setInspectorTitle(label, entry);
}
