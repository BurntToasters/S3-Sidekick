import { basename } from "./utils.ts";

export type InspectorPaneTab = "preview" | "properties";

let inspectorOpen = false;
let inspectorTab: InspectorPaneTab = "preview";
let inspectorSyncInFlight = false;

const INSPECTOR_OPEN_STORAGE_KEY = "s3-sidekick.inspector.open";

export function preferInspectorMount(): boolean {
  return !isMobileInspectorMode();
}

/** Opens the docked inspector on desktop/wide layouts before preview/properties render. */
export function ensureInspectorOpenForPane(tab: InspectorPaneTab): void {
  if (!preferInspectorMount()) return;
  if (!inspectorOpen) {
    setInspectorOpen(true);
  }
  if (tab === "preview") {
    focusInspectorPreviewPane();
  } else {
    focusInspectorPropertiesPane();
  }
}

export function restoreInspectorOpenState(): void {
  if (isMobileInspectorMode()) {
    setInspectorOpen(false);
    return;
  }
  const stored = window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
  if (stored === "1") {
    setInspectorOpen(true);
  } else if (stored === "0") {
    setInspectorOpen(false);
  } else if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(min-width: 1181px)").matches
  ) {
    setInspectorOpen(true);
  }
}

export function isInspectorOpen(): boolean {
  return inspectorOpen;
}

export function getInspectorTab(): InspectorPaneTab {
  return inspectorTab;
}

export function focusInspectorPreviewPane(): void {
  inspectorTab = "preview";
  syncInspectorPaneVisibility();
}

export function focusInspectorPropertiesPane(): void {
  inspectorTab = "properties";
  syncInspectorPaneVisibility();
}

export function setInspectorTab(tab: InspectorPaneTab): void {
  if (inspectorTab === tab) {
    syncInspectorPaneVisibility();
    return;
  }
  inspectorTab = tab;
  syncInspectorPaneVisibility();
  void syncInspectorFromSelection();
}

function syncInspectorPaneVisibility(): void {
  const previewPane = document.getElementById("inspector-pane-preview");
  const infoPane = document.getElementById("inspector-pane-info");
  const empty = document.getElementById("inspector-empty");
  if (!previewPane || !infoPane || !empty) return;

  if (!inspectorOpen) {
    empty.hidden = true;
    previewPane.hidden = true;
    infoPane.hidden = true;
    return;
  }

  const onPreview = inspectorTab === "preview";
  const onInfo = inspectorTab === "properties";
  previewPane.hidden = !onPreview;
  infoPane.hidden = !onInfo;
  empty.hidden = onPreview || onInfo;

  const tabs = document.querySelectorAll<HTMLElement>("[data-inspector-tab]");
  for (const tab of tabs) {
    const active = tab.dataset.inspectorTab === inspectorTab;
    tab.classList.toggle("inspector-tab--active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

export function setInspectorOpen(open: boolean): void {
  inspectorOpen = open;
  if (!isMobileInspectorMode()) {
    window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, open ? "1" : "0");
  }
  const panel = document.getElementById("inspector-panel");
  const resizer = document.getElementById("inspector-resizer");
  const backdrop = document.getElementById("inspector-backdrop");
  const layout = document.getElementById("main-layout");
  const toggle = document.getElementById("btn-inspector");

  if (panel) panel.hidden = !open;
  if (resizer) resizer.hidden = !open || isMobileInspectorMode();
  if (backdrop) backdrop.hidden = !open || !isMobileInspectorMode();
  layout?.classList.toggle(
    "main-layout--inspector-open",
    open && isMobileInspectorMode(),
  );
  toggle?.classList.toggle("btn--active", open);
  toggle?.setAttribute("aria-pressed", String(open));

  syncInspectorPaneVisibility();
  if (open) {
    void syncInspectorFromSelection();
  } else {
    showInspectorEmpty("Select an object to inspect.");
    void import("./preview.ts").then((m) => m.closePreview());
  }
}

export function toggleInspector(): void {
  setInspectorOpen(!inspectorOpen);
}

export function isMobileInspectorMode(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 900px)").matches;
}

export function closeInspectorOnMobile(): void {
  if (isMobileInspectorMode()) {
    setInspectorOpen(false);
  }
}

function showInspectorEmpty(message: string): void {
  const empty = document.getElementById("inspector-empty");
  if (empty) {
    empty.textContent = message;
    empty.hidden = false;
  }
  const previewPane = document.getElementById("inspector-pane-preview");
  const infoPane = document.getElementById("inspector-pane-info");
  if (previewPane) previewPane.hidden = true;
  if (infoPane) infoPane.hidden = true;
}

export async function syncInspectorFromSelection(
  selectedKeys?: Set<string>,
): Promise<void> {
  if (!inspectorOpen || inspectorSyncInFlight) return;
  const { state } = await import("./state.ts");
  const keysSet = selectedKeys ?? state.selectedKeys;
  const keys = Array.from(keysSet);

  if (keys.length === 0) {
    showInspectorEmpty("Select an object to inspect.");
    return;
  }

  inspectorSyncInFlight = true;
  try {
    const headerTitle = document.getElementById("inspector-header-title");
    if (headerTitle) {
      headerTitle.textContent =
        keys.length === 1
          ? basename(keys[0].startsWith("prefix:") ? keys[0].slice(7) : keys[0])
          : `${keys.length} selected`;
    }

    syncInspectorPaneVisibility();

    if (inspectorTab === "preview") {
      const fileKeys = keys.filter((k) => !k.startsWith("prefix:"));
      const { canPreview, openPreview } = await import("./preview.ts");
      if (fileKeys.length === 1 && canPreview(basename(fileKeys[0]))) {
        await openPreview(fileKeys[0]);
        return;
      }
      inspectorTab = "properties";
      syncInspectorPaneVisibility();
    }

    const { openInfoPanel } = await import("./info-panel.ts");
    await openInfoPanel(keys);
  } finally {
    inspectorSyncInFlight = false;
  }
}

export function wireInspectorChrome(): void {
  document
    .getElementById("btn-inspector")
    ?.addEventListener("click", () => toggleInspector());
  document
    .getElementById("inspector-close")
    ?.addEventListener("click", () => setInspectorOpen(false));
  document
    .getElementById("inspector-backdrop")
    ?.addEventListener("click", () => setInspectorOpen(false));

  document
    .querySelectorAll<HTMLElement>("[data-inspector-tab]")
    .forEach((tab) => {
      tab.addEventListener("click", () => {
        const id = tab.dataset.inspectorTab as InspectorPaneTab | undefined;
        if (id) setInspectorTab(id);
      });
    });

  document
    .getElementById("inspector-info-save")
    ?.addEventListener("click", () => {
      void import("./info-panel.ts").then((m) => m.saveInfoPanel());
    });
  document
    .getElementById("inspector-info-cancel")
    ?.addEventListener("click", () => {
      void import("./info-panel.ts").then((m) => m.closeInfoPanel());
    });

  restoreInspectorOpenState();

  const inspectorInfoTabs = document.getElementById("inspector-info-tabs");
  inspectorInfoTabs?.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".info-tab");
    if (tab?.dataset.tab) {
      void import("./info-panel.ts").then((m) => m.switchTab(tab.dataset.tab!));
    }
  });
}

// Re-export mount helpers for consumers that need them.
export {
  setInfoOverlayActive,
  clearInfoOverlayActive,
} from "./inspector-mount.ts";
