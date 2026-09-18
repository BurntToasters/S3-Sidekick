import { state } from "./state.ts";
import { selectionCount } from "./app-selection.ts";
import { isEditableElement } from "./utils.ts";
import { hideContextMenu } from "./context-menu.ts";
import { isDialogActive } from "./dialogs.ts";
import { closePreview } from "./preview.ts";
import { requestCloseInfoPanel } from "./info-panel.ts";
import { closeLicensesModal } from "./licenses.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";
import { closeSettingsModal } from "./settings.ts";
import { openPalette, closePalette, isPaletteOpen } from "./command-palette.ts";
import {
  navigateUp,
  navigateBack,
  navigateForward,
  handleSelectAll,
} from "./browser.ts";
import {
  isInspectorOpen,
  requestCloseInspector,
  toggleInspector,
} from "./inspector.ts";

export interface KeyboardHandlers {
  setSidebarOpen: (open: boolean) => void;
  handleDelete: () => Promise<void>;
  handleRefresh: () => Promise<void>;
  handleRename: () => Promise<void>;
  handleUploadButton: () => Promise<void>;
  handleUploadFolderButton: () => Promise<void>;
  handleCreateFolder: () => Promise<void>;
}

export function hasAccelModifier(e: MouseEvent | KeyboardEvent): boolean {
  if (state.platformName === "macos") {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey;
}

function isModalLayerActive(): boolean {
  const overlays = document.querySelectorAll<HTMLElement>(
    ".modal-overlay.active, .dialog-overlay.active",
  );
  return overlays.length > 0;
}

function isSupportOverlayVisible(): boolean {
  const overlay = document.getElementById("support-overlay");
  return !!overlay && !overlay.hasAttribute("hidden");
}

function isSetupWizardVisible(): boolean {
  const overlay = document.getElementById("setup-wizard-overlay");
  return !!overlay && !overlay.hasAttribute("hidden");
}

export function wireKeyboardShortcuts(handlers: KeyboardHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // A more specific layer (for example a dialog or context menu) may have
    // already consumed this key while listening in capture/target phase.
    if (e.defaultPrevented) return;

    if (e.key === "Escape") {
      if (hideContextMenu()) {
        e.preventDefault();
        return;
      }

      if (isPaletteOpen()) {
        e.preventDefault();
        closePalette();
        return;
      }

      if (isSupportOverlayVisible()) {
        e.preventDefault();
        const dismiss = document.getElementById(
          "support-no",
        ) as HTMLButtonElement | null;
        dismiss?.click();
        return;
      }

      if (isDialogActive()) return;

      const previewOverlay = document.getElementById("preview-overlay");
      if (previewOverlay?.classList.contains("active")) {
        e.preventDefault();
        closePreview();
        return;
      }

      const infoOverlay = document.getElementById("info-overlay");
      if (infoOverlay?.classList.contains("active")) {
        e.preventDefault();
        void requestCloseInfoPanel();
        return;
      }

      const copyMoveOverlay = document.getElementById("copy-move-overlay");
      if (copyMoveOverlay?.classList.contains("active")) {
        e.preventDefault();
        copyMoveOverlay.classList.remove("active");
        return;
      }

      const licensesOverlay = document.getElementById("licenses-overlay");
      if (licensesOverlay?.classList.contains("active")) {
        e.preventDefault();
        closeLicensesModal();
        return;
      }

      const settingsOverlay = document.getElementById("settings-overlay");
      if (settingsOverlay?.classList.contains("active")) {
        e.preventDefault();
        void closeSettingsModal(false);
        return;
      }

      if (isDrawerOpen()) {
        e.preventDefault();
        closeDrawer();
        return;
      }

      const layout = document.getElementById("main-layout");
      if (layout?.classList.contains("main-layout--sidebar-open")) {
        e.preventDefault();
        handlers.setSidebarOpen(false);
        return;
      }

      if (isInspectorOpen()) {
        e.preventDefault();
        const previewBody = document.getElementById("inspector-preview-body");
        const usingDockedPreview =
          document.documentElement.dataset.inspectorOpen === "1" &&
          previewBody &&
          previewBody.childElementCount > 0;
        if (usingDockedPreview) {
          closePreview();
          return;
        }
        void requestCloseInspector();
        return;
      }
    }

    const inInput = isEditableElement(document.activeElement);
    const modalOpen =
      isModalLayerActive() ||
      isSupportOverlayVisible() ||
      isSetupWizardVisible();
    const accel = hasAccelModifier(e);
    const key = e.key.toLowerCase();

    if (isPaletteOpen()) {
      if (accel && key === "k") {
        e.preventDefault();
        closePalette();
      }
      return;
    }

    if (e.key === "Delete" && selectionCount() > 0) {
      if (inInput || modalOpen) return;
      e.preventDefault();
      void handlers.handleDelete();
    }

    if (e.key === "F5" || (accel && key === "r")) {
      e.preventDefault();
      if (modalOpen) return;
      void handlers.handleRefresh();
      return;
    }

    if (modalOpen) return;

    if (!inInput) {
      if (e.key === "F2" && selectionCount() === 1) {
        e.preventDefault();
        void handlers.handleRename();
      }

      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
        e.preventDefault();
        void navigateUp();
      }

      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        void navigateBack();
      }

      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        void navigateForward();
      }
    }

    if (accel) {
      if (key === "k") {
        e.preventDefault();
        if (isPaletteOpen()) closePalette();
        else openPalette();
        return;
      }

      if (key === "a" && !inInput) {
        e.preventDefault();
        handleSelectAll(true);
      }

      if (key === "u" && !inInput) {
        e.preventDefault();
        if (e.shiftKey) {
          void handlers.handleUploadFolderButton();
        } else {
          void handlers.handleUploadButton();
        }
      }

      if (key === "n" && !inInput) {
        e.preventDefault();
        void handlers.handleCreateFolder();
      }

      if (key === "i" && e.shiftKey && !inInput && state.connected) {
        e.preventDefault();
        toggleInspector();
        return;
      }

      if (key === "f") {
        e.preventDefault();
        const filterEl = document.getElementById(
          "filter-input",
        ) as HTMLInputElement | null;
        if (filterEl) {
          filterEl.focus();
          filterEl.select();
        }
      }
    }
  };

  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
