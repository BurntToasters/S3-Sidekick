import { state } from "./state.ts";
import { isEditableElement } from "./utils.ts";
import { hideContextMenu } from "./context-menu.ts";
import { isDialogActive } from "./dialogs.ts";
import { closePreview } from "./preview.ts";
import { closeInfoPanel } from "./info-panel.ts";
import { closeLicensesModal } from "./licenses.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";
import { closeSettingsModal } from "./settings.ts";
import { openPalette, closePalette, isPaletteOpen } from "./command-palette.ts";
import {
  navigateUp,
  navigateBack,
  navigateForward,
  getSelectableKeys,
  updateSelectionUI,
} from "./browser.ts";

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

export function wireKeyboardShortcuts(handlers: KeyboardHandlers): void {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();

      if (isPaletteOpen()) {
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
        closePreview();
        return;
      }

      const infoOverlay = document.getElementById("info-overlay");
      if (infoOverlay?.classList.contains("active")) {
        closeInfoPanel();
        return;
      }

      const copyMoveOverlay = document.getElementById("copy-move-overlay");
      if (copyMoveOverlay?.classList.contains("active")) {
        copyMoveOverlay.classList.remove("active");
        return;
      }

      const licensesOverlay = document.getElementById("licenses-overlay");
      if (licensesOverlay?.classList.contains("active")) {
        closeLicensesModal();
        return;
      }

      if (isDrawerOpen()) {
        closeDrawer();
        return;
      }

      const layout = document.getElementById("main-layout");
      if (layout?.classList.contains("main-layout--sidebar-open")) {
        handlers.setSidebarOpen(false);
        return;
      }

      const overlay = document.getElementById("settings-overlay");
      if (overlay?.classList.contains("active")) {
        void closeSettingsModal(false);
      }
    }

    const inInput = isEditableElement(document.activeElement);
    const modalOpen = isModalLayerActive() || isSupportOverlayVisible();
    const accel = hasAccelModifier(e);
    const key = e.key.toLowerCase();

    if (isPaletteOpen()) {
      if (accel && key === "k") {
        e.preventDefault();
        closePalette();
      }
      return;
    }

    if (e.key === "Delete" && state.selectedKeys.size > 0) {
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
      if (e.key === "F2" && state.selectedKeys.size === 1) {
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
        const allKeys = getSelectableKeys();
        for (const k of allKeys) state.selectedKeys.add(k);
        updateSelectionUI();
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
  });
}
