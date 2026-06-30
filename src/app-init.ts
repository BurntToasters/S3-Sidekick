import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state, dom } from "./state.ts";
import {
  loadSettings,
  incrementLaunchCount,
  markSupportPromptDismissed,
  isSupportPromptDismissed,
} from "./settings.ts";
import { loadConnection } from "./connection.ts";
import { loadBookmarks, setBookmarkChangeHandler } from "./bookmarks.ts";
import { initUpdater, autoCheckUpdates } from "./updater.ts";
import { logActivity } from "./activity-log.ts";
import { ensureSecurityReady } from "./security.ts";
import { showAlert, isDialogActive } from "./dialogs.ts";
import { isPaletteOpen } from "./command-palette.ts";
import {
  shouldShowSetupWizard,
  showSetupWizard,
  markSetupComplete,
} from "./setup-wizard.ts";
import { setStatus } from "./app-status.ts";
import {
  applyPlatformClass,
  updateShortcutChips,
  getActiveModalOverlay,
} from "./app-layout.ts";
import {
  setConnectionInputs,
  refreshBookmarkBar,
  setConnectionUI,
} from "./app-connection.ts";
import { wireEvents } from "./app-events.ts";
import { initializeIcons } from "./icons.ts";

async function checkSupportPrompt(): Promise<void> {
  try {
    if (isSupportPromptDismissed()) return;
    const count = await incrementLaunchCount();
    if (count < 2) return;

    setTimeout(() => {
      if (isDialogActive() || getActiveModalOverlay() || isPaletteOpen())
        return;
      const overlay = document.getElementById("support-overlay");
      const dismissButton = document.getElementById(
        "support-no",
      ) as HTMLButtonElement | null;
      const confirmButton = document.getElementById(
        "support-yes",
      ) as HTMLButtonElement | null;
      if (!overlay || !dismissButton || !confirmButton) return;

      const persistDismissal = () => {
        void markSupportPromptDismissed().catch((err) => {
          console.warn("Failed to persist support prompt dismissal:", err);
          logActivity("Failed to save support prompt preference.", "warning");
        });
      };

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        overlay.setAttribute("hidden", "");
        document.removeEventListener("keydown", onEsc, true);
        overlay.removeEventListener("click", onOverlayClick);
        dismissButton.removeEventListener("click", onDismiss);
        confirmButton.removeEventListener("click", onConfirm);
      };

      const onDismiss = () => {
        close();
        persistDismissal();
      };

      const onConfirm = () => {
        close();
        persistDismissal();
        void invoke("open_external_url", { url: "https://rosie.run/support" });
      };

      const onOverlayClick = (event: MouseEvent) => {
        if (event.target === overlay) {
          onDismiss();
        }
      };

      const onEsc = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      };

      overlay.removeAttribute("hidden");
      dismissButton.focus();
      dismissButton.addEventListener("click", onDismiss);
      confirmButton.addEventListener("click", onConfirm);
      overlay.addEventListener("click", onOverlayClick);
      document.addEventListener("keydown", onEsc, true);
    }, 1500);
  } catch (err) {
    console.warn("Support prompt unavailable:", err);
    logActivity("Support prompt unavailable this launch.", "warning");
  }
}

async function restoreWindowSize(): Promise<void> {
  try {
    const { windowWidth, windowHeight } = state.currentSettings;
    if (windowWidth && windowHeight) {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(windowWidth, windowHeight));
    }
  } catch (err) {
    console.warn("Failed to restore window size:", err);
  }
}

export async function init(): Promise<void> {
  initializeIcons();
  wireEvents();
  setConnectionUI(false);

  state.platformName = await invoke<string>("get_platform_info");
  applyPlatformClass();

  let settingsValid = true;
  try {
    settingsValid = await loadSettings();
    if (settingsValid) {
      void restoreWindowSize();
    }
  } catch (err) {
    setStatus(`Failed to load settings: ${String(err)}`);
  }

  if (!settingsValid) {
    await showAlert(
      "Settings Corrupted",
      "The settings file could not be read (it may be from an incompatible version). Settings will be reset to defaults. Your bookmarks and saved connections are unaffected.",
    );
    try {
      await invoke("save_settings", { json: "{}" });
    } catch {
      /* best effort */
    }
    try {
      await relaunch();
    } catch {
      window.location.assign(window.location.href);
    }
    return;
  }

  if (shouldShowSetupWizard()) {
    const result = await showSetupWizard();
    if (result) {
      state.currentSettings.theme = result.theme;
      state.currentSettings.autoCheckUpdates = result.autoCheckUpdates;
      state.currentSettings.updateChannel = result.updateChannel;
      await markSetupComplete();
    }

    try {
      await loadSettings();
      void restoreWindowSize();
    } catch (err) {
      setStatus(`Failed to load settings: ${String(err)}`);
      logActivity(`Failed to load settings: ${String(err)}`, "error");
    }

    const wizardSecurityReady = await ensureSecurityReady();
    if (!wizardSecurityReady) {
      setStatus(
        "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
      );
      logActivity(
        "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
        "warning",
      );
    }

    updateShortcutChips();
    const version = await getVersion();
    dom.versionLabel.textContent = `v${version}`;

    if (wizardSecurityReady) {
      try {
        await loadBookmarks();
        setBookmarkChangeHandler(refreshBookmarkBar);
        refreshBookmarkBar();
      } catch (err) {
        console.warn("Failed to load bookmarks:", err);
        logActivity("Failed to load bookmarks.", "warning");
      }
    }

    try {
      const saved = await loadConnection();
      if (saved) {
        setConnectionInputs(
          saved.endpoint,
          saved.region,
          saved.access_key,
          saved.secret_key,
        );
      }
    } catch (err) {
      setStatus(`Failed to load saved connection: ${String(err)}`);
      logActivity(`Failed to load saved connection: ${String(err)}`, "error");
    }

    await initUpdater();
    void autoCheckUpdates();
    return;
  }

  const securityReady = await ensureSecurityReady();
  if (!securityReady) {
    setStatus(
      "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
    );
    logActivity(
      "Secure storage is locked. Saved bookmarks and credentials are unavailable.",
      "warning",
    );
  }

  void checkSupportPrompt();

  updateShortcutChips();
  const version = await getVersion();
  dom.versionLabel.textContent = `v${version}`;

  if (securityReady) {
    try {
      await loadBookmarks();
      setBookmarkChangeHandler(refreshBookmarkBar);
      refreshBookmarkBar();
    } catch (err) {
      console.warn("Failed to load bookmarks:", err);
      logActivity("Failed to load bookmarks.", "warning");
    }

    try {
      const saved = await loadConnection();
      if (saved) {
        setConnectionInputs(
          saved.endpoint,
          saved.region,
          saved.access_key,
          saved.secret_key,
        );
      }
    } catch (err) {
      setStatus(`Failed to load saved connection: ${String(err)}`);
      logActivity(`Failed to load saved connection: ${String(err)}`, "error");
    }
  }

  await initUpdater();
  void autoCheckUpdates();
}
