import { state } from "./state.ts";
import { selectionCount } from "./app-selection.ts";
import { isEditableElement } from "./utils.ts";
import { hideContextMenu, isContextMenuOpen } from "./context-menu.ts";
import { isDialogActive, showAlert } from "./dialogs.ts";
import { shortcutListText } from "./shortcut-catalog.ts";
import { closePreview } from "./preview.ts";
import { requestCloseInfoPanel } from "./info-panel.ts";
import { closeLicensesModal } from "./licenses.ts";
import { closeDrawer, isDrawerOpen } from "./bottom-drawer.ts";
import { closeSettingsModal } from "./settings.ts";
import { closeCopyMoveDialog } from "./app-copy-move.ts";
import { openPalette, closePalette, isPaletteOpen } from "./command-palette.ts";
import {
  navigateUp,
  navigateBack,
  navigateForward,
  handleSelectAll,
  clearSelection,
  enterLocationEditMode,
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

/** Show the shortcut list, labelled for the current platform. */
export function openKeyboardShortcuts(): Promise<void> {
  return showAlert("Keyboard Shortcuts", shortcutListText(state.platformName));
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
        // Cancel through the dialog's own close path so an in-flight
        // destination check cannot reopen or act on a dismissed dialog.
        closeCopyMoveDialog();
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
        // Escape dismisses the docked inspector as a whole, including any
        // preview it is showing. Closing only the preview would leave the
        // panel open with no keyboard-visible way to dismiss it.
        e.preventDefault();
        void requestCloseInspector();
        return;
      }

      // Clearing the object selection is the last layer: it runs only when no
      // layer above consumed the press, and never while a field has focus.
      if (selectionCount() > 0 && !isEditableElement(document.activeElement)) {
        e.preventDefault();
        clearSelection();
        return;
      }
    }

    // The context menu owns the keyboard while open (its own handler covers
    // arrows, Tab and Escape). Global shortcuts would otherwise act on a
    // changed selection while stale menu actions stay clickable.
    if (isContextMenuOpen()) return;

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

    // macOS keyboards have no Delete key, so Command+Backspace (Finder's
    // delete chord) acts as Delete when a selection exists. Plain Backspace
    // always means "go up", even with rows selected.
    const macDeleteChord =
      state.platformName === "macos" && e.key === "Backspace" && e.metaKey;
    if ((e.key === "Delete" || macDeleteChord) && selectionCount() > 0) {
      if (inInput || modalOpen) return;
      e.preventDefault();
      // Deleting from a listing that is still loading would act on a stale
      // selection, so the key is consumed but does nothing.
      const listingLoading =
        document.getElementById("object-panel")?.getAttribute("aria-busy") ===
        "true";
      if (!listingLoading) void handlers.handleDelete();
      return;
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

      // Command+Backspace is Finder's delete shortcut; with nothing selected it
      // should not silently change folders.
      const backspaceGoesUp = e.key === "Backspace" && !macDeleteChord;
      if (backspaceGoesUp || (e.altKey && e.key === "ArrowUp")) {
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

    // Ctrl+L / Cmd+L opens the location editor (Ctrl also works on macOS, where
    // the browser convention is Cmd+L; both are accepted).
    if (key === "l" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      enterLocationEditMode();
      return;
    }

    // Ctrl+/ and Cmd+/ open the shortcut list. Like Ctrl+L, either modifier
    // is accepted on every platform. Modal layers returned above; an editable
    // field keeps the key, so typing never opens the list.
    if (
      key === "/" &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      !inInput
    ) {
      e.preventDefault();
      void openKeyboardShortcuts();
      return;
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
