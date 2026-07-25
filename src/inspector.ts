import { basename } from "./utils.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";

export type InspectorPaneTab = "preview" | "properties";

let inspectorOpen = false;
let inspectorTab: InspectorPaneTab = "preview";
let inspectorEmptyActive = true;
let inspectorSyncGeneration = 0;

const INSPECTOR_OPEN_STORAGE_KEY = "s3-sidekick.inspector.open";

/** Opens the docked inspector before preview/properties render (desktop slide-out or narrow overlay). */
export function ensureInspectorOpenForPane(tab: InspectorPaneTab): void {
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
    window.matchMedia("(min-width: 901px)").matches
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

export function markInspectorHasContent(): void {
  inspectorEmptyActive = false;
  syncInspectorPaneVisibility();
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

  if (inspectorEmptyActive) {
    empty.hidden = false;
    previewPane.hidden = true;
    infoPane.hidden = true;
  } else {
    const onPreview = inspectorTab === "preview";
    const onInfo = inspectorTab === "properties";
    empty.hidden = true;
    previewPane.hidden = !onPreview;
    infoPane.hidden = !onInfo;
  }

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
  const mobile = isMobileInspectorMode();

  if (open && mobile && isDrawerOpen()) {
    closeDrawer();
  }

  if (panel) panel.hidden = !open;
  if (resizer) resizer.hidden = !open || mobile;
  if (backdrop) backdrop.hidden = !open || !mobile;
  layout?.classList.toggle("main-layout--inspector-open", open && mobile);
  layout?.classList.toggle("main-layout--inspector-docked", open && !mobile);
  toggle?.classList.toggle("btn--active", open);
  toggle?.setAttribute("aria-pressed", String(open));
  document.documentElement.dataset.inspectorOpen = open ? "1" : "0";

  syncInspectorPaneVisibility();
  if (open) {
    void syncInspectorFromSelection();
  } else {
    inspectorEmptyActive = true;
    showInspectorEmpty("Select an object to inspect.");
    void import("./preview.ts").then((m) => m.closePreview());
    void import("./info-panel.ts").then((m) => m.closeInfoPanel());
  }
}

export function toggleInspector(): void {
  if (inspectorOpen) {
    void requestCloseInspector();
  } else {
    setInspectorOpen(true);
  }
}

export async function requestCloseInspector(): Promise<boolean> {
  if (!inspectorOpen) return true;
  const info = await import("./info-panel.ts");
  if (
    info.hasUnsavedInfoChanges() &&
    !(await info.confirmDiscardInfoProperties())
  ) {
    return false;
  }
  setInspectorOpen(false);
  return true;
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
  inspectorEmptyActive = true;
  const empty = document.getElementById("inspector-empty");
  if (empty) {
    empty.textContent = message;
  }
  syncInspectorPaneVisibility();
}

export async function syncInspectorFromSelection(
  selectedKeys?: Set<string>,
): Promise<void> {
  if (!inspectorOpen) return;

  const syncGen = ++inspectorSyncGeneration;
  const { state } = await import("./state.ts");
  if (syncGen !== inspectorSyncGeneration) return;

  const keysSet = selectedKeys ?? state.selectedKeys;
  const keys = Array.from(keysSet);

  if (keys.length === 0) {
    showInspectorEmpty("Select an object to inspect.");
    document.getElementById("inspector-preview-body")?.replaceChildren();
    document.getElementById("preview-body")?.replaceChildren();
    return;
  }

  inspectorEmptyActive = false;
  syncInspectorPaneVisibility();

  const headerTitle = document.getElementById("inspector-header-title");
  if (headerTitle) {
    headerTitle.textContent =
      keys.length === 1
        ? basename(keys[0].startsWith("prefix:") ? keys[0].slice(7) : keys[0])
        : `${keys.length} selected`;
  }

  try {
    const fileKeys = keys.filter((k) => !k.startsWith("prefix:"));

    if (inspectorTab === "preview") {
      const { canPreview, openPreview } = await import("./preview.ts");
      if (syncGen !== inspectorSyncGeneration) return;
      if (fileKeys.length === 1 && canPreview(basename(fileKeys[0]))) {
        await openPreview(fileKeys[0]);
        return;
      }
      if (fileKeys.length === 1) {
        markInspectorHasContent();
        const body = document.getElementById("inspector-preview-body");
        if (body) {
          body.innerHTML =
            '<p class="inspector-empty">Preview is not available for this file type.</p>';
        }
        focusInspectorPreviewPane();
        return;
      }
      focusInspectorPropertiesPane();
    }

    if (syncGen !== inspectorSyncGeneration) return;
    const { openInfoPanel } = await import("./info-panel.ts");
    await openInfoPanel(keys);
  } catch (err) {
    if (syncGen !== inspectorSyncGeneration) return;
    console.error("Inspector sync failed:", err);
    showInspectorEmpty("Could not load selection in the inspector.");
  }
}

export function wireInspectorChrome(): void {
  if (document.documentElement.dataset.inspectorChromeWired === "1") return;
  document.documentElement.dataset.inspectorChromeWired = "1";

  document.getElementById("btn-inspector")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleInspector();
  });
  document.getElementById("inspector-close")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void requestCloseInspector();
  });
  document
    .getElementById("inspector-backdrop")
    ?.addEventListener("click", () => void requestCloseInspector());

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
      void import("./info-panel.ts").then(async (m) => {
        if (await m.requestCloseInfoPanel()) {
          void syncInspectorFromSelection();
        }
      });
    });

  window.addEventListener("resize", () => {
    const mobile = isMobileInspectorMode();
    const layout = document.getElementById("main-layout");
    if (!layout || !inspectorOpen) return;
    layout.classList.toggle("main-layout--inspector-open", mobile);
    layout.classList.toggle("main-layout--inspector-docked", !mobile);
    const resizer = document.getElementById("inspector-resizer");
    const backdrop = document.getElementById("inspector-backdrop");
    if (resizer) resizer.hidden = !inspectorOpen || mobile;
    if (backdrop) backdrop.hidden = !inspectorOpen || !mobile;
    if (mobile && inspectorOpen && isDrawerOpen()) {
      closeDrawer();
    }
  });

  restoreInspectorOpenState();
}

// Re-export mount helpers for consumers that need them.
export {
  setInfoOverlayActive,
  clearInfoOverlayActive,
} from "./inspector-mount.ts";
