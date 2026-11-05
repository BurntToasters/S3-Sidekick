import { invoke } from "./ipc.ts";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { state, dom } from "./state.ts";
import {
  openSettingsModal,
  closeSettingsModal,
  closeSettingsModalForLock,
  resetSettings,
  resetAfterForgottenPassword,
  setBookmarkSelectHandler,
  switchSettingsTab,
} from "./settings.ts";
import {
  loadConnection,
  refreshObjects,
  loadMoreObjects,
  currentConnectionGeneration,
  currentListingGeneration,
} from "./connection.ts";
import {
  renderBucketList,
  renderObjectTable,
  navigateToFolder,
  selectBucket,
  handleRowClick,
  handleBucketListKeydown,
  handleSelectAll,
  setLastClickedEntry,
  updateSelectionUI,
  toggleSort,
  navigateBack,
  navigateForward,
  navigateUp,
  navigateToLocationPath,
  enterLocationEditMode,
  exitLocationEditMode,
  pruneStaleSelection,
  clearFilter,
  updateFilterClearButton,
  reportNavFailure,
  selectOnlyEntry,
  isLocationEditMode,
  LOCATION_FLUSH_EVENT,
} from "./browser.ts";
import {
  wireInspectorChrome,
  toggleInspector,
  setInspectorOpen,
} from "./inspector.ts";
import { wireWindowSizePersistence } from "./window-size.ts";
import {
  checkUpdates,
  getReleasePageUrl,
  setUpdateChannel,
} from "./updater.ts";
import {
  loadBookmarks,
  clearBookmarks,
  setBookmarkChangeHandler,
} from "./bookmarks.ts";
import { openLicensesModal, closeLicensesModal } from "./licenses.ts";
import {
  openInfoPanel,
  requestCloseInfoPanel,
  saveInfoPanel,
  switchTab,
} from "./info-panel.ts";
import {
  toggleTransferQueue,
  clearCompletedTransfers,
  setTransferCompleteHandler,
  initTransferQueueUI,
  recoverPendingTransfers,
  disposeTransferQueueUI,
  retryFailedTransfers,
} from "./transfers.ts";
import { openKeyboardShortcuts, wireKeyboardShortcuts } from "./keyboard.ts";
import { canPreview, openPreview, closePreview } from "./preview.ts";
import {
  logActivity,
  toggleActivityLog,
  clearActivityLog,
} from "./activity-log.ts";
import {
  initDrawer,
  getActiveTab,
  openDrawer,
  setTransferFilter,
} from "./bottom-drawer.ts";
import { showConfirm, closeAllDialogs } from "./dialogs.ts";
import {
  handleSecurityChangePassword,
  handleSecurityToggle,
  handleLockNow,
  handleLockTimeoutChange,
  handleBiometricToggle,
  setForgotPasswordHandler,
} from "./security.ts";
import {
  initPalette,
  registerCommands,
  openPalette,
  type PaletteCommand,
} from "./command-palette.ts";
import { basename, friendlyError, plural } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { showToast } from "./toast.ts";
import {
  wireLayoutControls,
  wireInspectorControls,
  setSidebarOpen,
  closeSidebarOnMobile,
  handleTabListArrowKey,
  wireObjectFilterInput,
  clearFilterInputDebounce,
  initModalLayerObserver,
  disposeModalLayerObserver,
  disposeFilterInputDebounce,
  FILTER_INPUT_DEBOUNCE_MS,
} from "./app-layout.ts";
import {
  handleConnect,
  handleDisconnect,
  handleBookmarkSave,
  switchToBookmark,
  setConnectionInputs,
  refreshBookmarkBar,
  updateBookmarkBtn,
  handleNewConnection,
  applyProviderPreset,
  wireConnectionScreenExtras,
  setConnectionUI,
  confirmSessionTeardown,
  handleConnectButton,
  setSavedConnectionsLocked,
  rememberActiveConnectionLocation,
  cancelPendingConnect,
  cancelPendingTestConnection,
  cancelInlineSavedConnectionEdit,
  resetSecretRevealState,
  unlockSavedConnectionsNow,
} from "./app-connection.ts";
import { setConnectionAccessLocked } from "./connection.ts";
import {
  addSelection,
  entryFromRow,
  fileEntry,
  isSelected,
  removeSelection,
} from "./app-selection.ts";
import {
  handleDelete,
  handleRename,
  handleCreateFolder,
  handleRefresh,
  handleRefreshBuckets,
  handleExportActivityLog,
  handleGoToKeyOrPrefix,
} from "./app-objects.ts";
import {
  handleOpenLastDownloadFolder,
  getRememberedDownloadDir,
} from "./app-downloads.ts";
import {
  handleUploadButton,
  handleUploadFolderButton,
  queueDroppedPaths,
} from "./app-upload.ts";
import {
  handleContextMenu,
  handleBucketContextMenu,
} from "./app-context-menu.ts";
import { showContextMenu, type MenuItem } from "./context-menu.ts";
import {
  MORE_MENU_ACTION_IDS,
  currentActionContext,
  getObjectAction,
  resolveActionLabel,
  runObjectAction,
  syncSelectionBar,
} from "./object-actions.ts";

let dragDropUnlisten: (() => void) | null = null;

/** Surface an action that rejects after its click handler already returned. */
function reportAsyncActionFailure(label: string, err: unknown): void {
  const message = `${label} failed: ${friendlyError(err)}`;
  setStatus(message);
  logActivity(message, "error");
}

/**
 * Shared lock teardown for both the auto-lock watcher and the manual
 * "Lock now" button. A lock is only complete once nothing from the previous
 * session can be seen or edited afterwards (H5): dialogs (including queued
 * ones, which resolve cancelled), Settings (draft discarded, in-flight save
 * awaited), the preview (with its fetch generation bumped), the inspector,
 * inline saved-connection edits and duplicate drafts, and re-masked secrets.
 */
export async function teardownLockedSession(): Promise<void> {
  closeAllDialogs();
  await closeSettingsModalForLock();
  closePreview();
  setInspectorOpen(false);
  cancelInlineSavedConnectionEdit();
  setConnectionInputs("", "", "", "");
  resetSecretRevealState();
}

/**
 * After an inactivity auto-lock: end the S3 session and drop decrypted
 * credentials and bookmarks from memory, as the manual lock button does.
 */
export async function clearSessionAfterAutoLock(): Promise<boolean> {
  // Capture the saved connection's bucket/prefix while the session still owns
  // state. The manual lock path records this from handleDisconnect; auto-lock
  // would otherwise clear it before that snapshot can run.
  rememberActiveConnectionLocation();
  // Cancel any connect/test UI before the access lock invalidates workflows,
  // so the connect button cannot stay stuck on "Cancel".
  cancelPendingConnect();
  cancelPendingTestConnection();
  const hadSession = state.connected || Boolean(state.connectionId);
  setConnectionAccessLocked(true);
  setSavedConnectionsLocked(true);
  setConnectionUI(false);
  // Single teardown covers Settings, dialogs, preview, inspector, inline
  // edits, and secret masking for both lock paths.
  await teardownLockedSession();
  clearBookmarks();
  refreshBookmarkBar();
  if (hadSession && !(await handleDisconnect({ skipInspectorPrompt: true }))) {
    // A failed drain leaves the backend client retained for a safe retry. Keep
    // the browsing surface closed and retain only the session ID for retirement.
    setConnectionUI(false);
    return false;
  }
  return true;
}

/** Connection form: connect, credentials, provider presets, saved list. */
function wireConnectionForm(): void {
  dom.connectBtn.addEventListener("click", handleConnectButton);

  const connectionFieldIds = [
    "conn-endpoint",
    "conn-region",
    "conn-access-key",
    "conn-secret-key",
    "conn-session-token",
  ];
  for (const id of connectionFieldIds) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    field?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleConnect().catch((err) =>
          reportAsyncActionFailure("Connect", err),
        );
      }
    });
  }

  // Reveal toggles keep a fixed accessible name and expose state via aria-pressed.
  const revealToggles: Array<
    [toggleId: string, inputId: string, label: string]
  > = [
    ["secret-key-toggle", "conn-secret-key", "secret key"],
    ["session-token-toggle", "conn-session-token", "session token"],
  ];
  for (const [toggleId, inputId, label] of revealToggles) {
    const toggle = document.getElementById(
      toggleId,
    ) as HTMLButtonElement | null;
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!toggle || !input) continue;
    toggle.setAttribute("aria-label", `Show ${label}`);
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      const revealed = input.type === "text";
      input.type = revealed ? "password" : "text";
      toggle.textContent = revealed ? "Show" : "Hide";
      toggle.setAttribute("aria-pressed", String(!revealed));
    });
  }

  const providerPreset = document.getElementById(
    "conn-provider-preset",
  ) as HTMLSelectElement | null;
  if (providerPreset) {
    // Preset prefill (endpoint/region/Account ID) lives in app-connection.ts
    // next to the rest of the connection-form behavior.
    providerPreset.addEventListener("change", () => {
      applyProviderPreset(providerPreset.value);
    });
  }

  // Switcher, test connection, saved filter, reconnect card, blur validation.
  wireConnectionScreenExtras();

  document
    .getElementById("bookmark-save-btn")!
    .addEventListener("click", handleBookmarkSave);

  document.getElementById("conn-new-btn")!.addEventListener("click", () => {
    void handleNewConnection().catch((err) =>
      reportAsyncActionFailure("Start new connection", err),
    );
  });

  (
    document.getElementById("conn-endpoint") as HTMLInputElement
  ).addEventListener("input", updateBookmarkBtn);
  (
    document.getElementById("conn-access-key") as HTMLInputElement
  )?.addEventListener("input", updateBookmarkBtn);

  document
    .getElementById("settings-btn")!
    .addEventListener("click", openSettingsModal);
}

/** Settings modal tabs and fields. */
function wireSettingsModal(): void {
  const settingsTabs = document.querySelector<HTMLElement>(".settings-tabs");
  settingsTabs!.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".settings-tab");
    if (tab?.dataset.settingsTab) switchSettingsTab(tab.dataset.settingsTab);
  });
  settingsTabs!.addEventListener("keydown", (e) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>(".settings-tab"),
    );
    handleTabListArrowKey(e as KeyboardEvent, tabs, (tab) => {
      if (tab.dataset.settingsTab) {
        switchSettingsTab(tab.dataset.settingsTab);
      }
    });
  });
  document
    .getElementById("settings-close")!
    .addEventListener("click", () => closeSettingsModal(false));
  document
    .getElementById("settings-cancel")!
    .addEventListener("click", () => closeSettingsModal(false));
  document
    .getElementById("settings-save")!
    .addEventListener("click", () => closeSettingsModal(true));
  document
    .getElementById("settings-reset")!
    .addEventListener("click", resetSettings);
  const checkNowButton = document.getElementById(
    "settings-check-updates",
  ) as HTMLButtonElement;
  checkNowButton.addEventListener("click", () => {
    // Runs inside Settings: the button shows progress and the result is
    // reported in the panel. Settings stays open with unsaved edits intact.
    const persistedChannel = state.lastPersistedSettings.updateChannel;
    const channelSelect = document.getElementById(
      "setting-update-channel",
    ) as HTMLSelectElement | null;
    setUpdateChannel(channelSelect?.value === "beta" ? "beta" : "release");
    const idleLabel = checkNowButton.textContent;
    checkNowButton.disabled = true;
    checkNowButton.setAttribute("aria-busy", "true");
    checkNowButton.textContent = "Checking\u2026";
    void checkUpdates()
      .catch((err) => reportAsyncActionFailure("Check for updates", err))
      .finally(() => {
        setUpdateChannel(persistedChannel);
        checkNowButton.disabled = false;
        checkNowButton.removeAttribute("aria-busy");
        checkNowButton.textContent = idleLabel;
      });
  });
  document
    .getElementById("settings-open-release-page")!
    .addEventListener("click", () => {
      void invoke("open_external_url", { url: getReleasePageUrl() }).catch(
        (err) =>
          logActivity(`Failed to open release page: ${String(err)}`, "warning"),
      );
    });

  document
    .getElementById("settings-support-me")!
    .addEventListener("click", () => {
      void invoke("open_external_url", {
        url: "https://rosie.run/support",
      }).catch((err) =>
        logActivity(`Failed to open support page: ${String(err)}`, "warning"),
      );
    });
  document
    .getElementById("show-licenses")!
    .addEventListener("click", openLicensesModal);
  document
    .getElementById("close-licenses")!
    .addEventListener("click", closeLicensesModal);
  document
    .getElementById("licenses-overlay")!
    .addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeLicensesModal();
    });

  document
    .getElementById("settings-overlay")!
    .addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
        void closeSettingsModal(false).catch((err) =>
          reportAsyncActionFailure("Close settings", err),
        );
      }
    });

  document.getElementById("info-close")!.addEventListener("click", () => {
    void requestCloseInfoPanel().catch((err) =>
      reportAsyncActionFailure("Close properties", err),
    );
  });
  document.getElementById("info-cancel")!.addEventListener("click", () => {
    void requestCloseInfoPanel().catch((err) =>
      reportAsyncActionFailure("Close properties", err),
    );
  });
  document.getElementById("info-save")!.addEventListener("click", () => {
    void saveInfoPanel().catch((err) =>
      reportAsyncActionFailure("Save properties", err),
    );
  });
}

/** Info overlay and the bottom activity drawer. */
function wireOverlaysAndDrawer(): void {
  document.getElementById("info-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      void requestCloseInfoPanel().catch((err) =>
        reportAsyncActionFailure("Close properties", err),
      );
    }
  });

  document.querySelectorAll<HTMLElement>(".info-tabs").forEach((infoTabs) => {
    infoTabs.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>(".info-tab");
      if (tab?.dataset.tab) switchTab(tab.dataset.tab);
    });
    infoTabs.addEventListener("keydown", (e) => {
      const tabs = Array.from(
        infoTabs.querySelectorAll<HTMLElement>(".info-tab"),
      );
      handleTabListArrowKey(e as KeyboardEvent, tabs, (tab) => {
        if (tab.dataset.tab) {
          switchTab(tab.dataset.tab);
        }
      });
    });
  });

  initDrawer();
  // Opening the drawer moves focus into it, the same way the mobile sidebar
  // focuses its filter. Covered here because the drawer opens from several
  // entry points (statusbar buttons, palette, toast actions).
  const drawer = document.getElementById("bottom-drawer");
  if (drawer) {
    let drawerWasOpen = !drawer.hidden;
    const focusDrawer = (): void => {
      if (drawer.hidden) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && drawer.contains(active)) return;
      const target =
        drawer.querySelector<HTMLElement>(".bottom-drawer__tab--active") ??
        drawer.querySelector<HTMLElement>("button, [tabindex='0']");
      target?.focus();
    };
    new MutationObserver(() => {
      const open = !drawer.hidden;
      if (open && !drawerWasOpen) focusDrawer();
      drawerWasOpen = open;
    }).observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
  }
  document
    .getElementById("transfer-toggle")!
    .addEventListener("click", toggleTransferQueue);
  document.getElementById("drawer-export")?.addEventListener("click", () => {
    if (getActiveTab() === "activity") {
      void handleExportActivityLog().catch((err) =>
        reportAsyncActionFailure("Export activity log", err),
      );
    }
  });
  document.getElementById("drawer-clear")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab === "activity") {
      void showConfirm(
        "Clear activity log?",
        "This removes every entry from the activity log. Files and transfers are not changed.",
        { okLabel: "Clear", cancelLabel: "Keep", okDanger: true },
      )
        .then((confirmed) => {
          if (confirmed) clearActivityLog();
        })
        .catch((err) => reportAsyncActionFailure("Clear activity log", err));
    } else {
      clearCompletedTransfers();
    }
  });
  void initTransferQueueUI().catch((err) => {
    console.error("Failed to initialize transfer queue UI:", err);
    logActivity(`Transfer queue events unavailable: ${String(err)}`, "warning");
  });
}

/** Security-ready and unload hooks. */
function wireAppLifecycle(): void {
  window.addEventListener("s3-sidekick:security-ready", () => {
    if (!state.connectionId && !state.connected) {
      setConnectionAccessLocked(false);
    }
    void recoverPendingTransfers().catch((err) => {
      console.error("Failed to recover pending transfers:", err);
      logActivity(
        `Pending transfer recovery deferred: ${friendlyError(err)}`,
        "warning",
      );
    });
  });
  // Every navigation announces the view it is leaving, so the per-connection
  // location memory records the last real bucket/prefix before it changes.
  window.addEventListener(LOCATION_FLUSH_EVENT, () => {
    rememberActiveConnectionLocation();
  });
  window.addEventListener("beforeunload", () => {
    rememberActiveConnectionLocation();
    disposeFilterInputDebounce();
    disposeModalLayerObserver();
    dragDropUnlisten?.();
    dragDropUnlisten = null;
    void disposeTransferQueueUI();
  });
  // Long dialog copy scrolls independently; keyboard users need the message
  // area itself in the tab order, and the title names the group for heading
  // navigation in screen readers.
  const dialogTitle = document.getElementById("dialog-title");
  if (dialogTitle) {
    dialogTitle.setAttribute("role", "heading");
    dialogTitle.setAttribute("aria-level", "2");
  }
  const dialogMessage = document.getElementById("dialog-message");
  if (dialogMessage) {
    dialogMessage.setAttribute("tabindex", "0");
    dialogMessage.setAttribute("role", "region");
    dialogMessage.setAttribute("aria-labelledby", "dialog-title");
  }

  document
    .getElementById("preview-close")!
    .addEventListener("click", closePreview);
}

/** Preview overlay and batch selection actions. */

/** The fixed More menu, built from the object-actions registry. */
function moreMenuItems(): MenuItem[] {
  const context = currentActionContext();
  const items: MenuItem[] = [];
  for (const id of MORE_MENU_ACTION_IDS) {
    const action = getObjectAction(id);
    if (!action?.isAvailable(context)) continue;
    items.push({
      label: resolveActionLabel(action, context),
      action: id,
      icon: action.icon,
      danger: action.danger,
      disabled: context.listingLoading,
    });
  }
  return items;
}

function wireSelectionActions(): void {
  document.getElementById("preview-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  document
    .getElementById("activity-toggle")!
    .addEventListener("click", toggleActivityLog);

  const runSelectionAction = (id: string): void => {
    runObjectAction(id, currentActionContext());
  };
  document
    .getElementById("batch-download")
    ?.addEventListener("click", () => runSelectionAction("download"));
  document
    .getElementById("batch-copy-move")
    ?.addEventListener("click", () => runSelectionAction("copy-move"));
  document
    .getElementById("batch-rename")
    ?.addEventListener("click", () => runSelectionAction("rename"));
  document
    .getElementById("batch-copy-urls")
    ?.addEventListener("click", () => runSelectionAction("copy-url"));
  document
    .getElementById("batch-delete")
    ?.addEventListener("click", () => runSelectionAction("delete"));
  document
    .getElementById("batch-deselect")
    ?.addEventListener("click", () => runSelectionAction("deselect-all"));

  const batchMore = document.getElementById(
    "batch-more",
  ) as HTMLButtonElement | null;
  if (batchMore) {
    const dismissMoreMenu = (): void => {
      batchMore.setAttribute("aria-expanded", "false");
    };
    batchMore.addEventListener("click", () => {
      if (batchMore.hidden || batchMore.disabled) return;
      dismissMoreMenu();
      const rect = batchMore.getBoundingClientRect();
      showContextMenu(
        rect.left,
        rect.bottom,
        moreMenuItems(),
        (action) => {
          dismissMoreMenu();
          runObjectAction(action, currentActionContext());
        },
        dismissMoreMenu,
      );
      batchMore.setAttribute("aria-expanded", "true");
    });
  }

  // The bar's labels and Rename visibility follow the live selection. The
  // count node is rewritten on every selection update, so watching it keeps
  // the registry-derived bar in sync without touching the render path.
  const selectionBarSync = new MutationObserver(() => syncSelectionBar());
  const batchToolbar = document.getElementById("batch-toolbar");
  const batchCount = document.getElementById("batch-count");
  if (batchToolbar) {
    selectionBarSync.observe(batchToolbar, {
      attributes: true,
      attributeFilter: ["data-selection-state", "aria-busy"],
    });
  }
  if (batchCount) {
    selectionBarSync.observe(batchCount, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
  syncSelectionBar();
}

/** Vault, biometric and lock controls in Settings. */
function wireSecuritySettings(): void {
  // "Forgot password?" on the lock view goes straight to the erase explanation.
  setForgotPasswordHandler(() => {
    void resetAfterForgottenPassword().catch((err) =>
      reportAsyncActionFailure("Reset forgotten password", err),
    );
  });
  const runSecurityAction = (action: "setup" | "unlock" | "disable"): void => {
    void (async () => {
      const changed = await handleSecurityToggle(setStatus, action);
      if (!changed) return;
      if (action === "unlock") {
        // One unlock path for Settings, the lock view and auto-lock: it loads
        // bookmarks, registers the change handler, and clears the access lock.
        if (!(await unlockSavedConnectionsNow())) {
          // No handler registered (unit fixture): at least reload and rewire.
          await loadBookmarks();
          setBookmarkChangeHandler(refreshBookmarkBar);
          refreshBookmarkBar();
        }
      } else {
        try {
          await loadBookmarks();
          setBookmarkChangeHandler(refreshBookmarkBar);
          refreshBookmarkBar();
        } catch {
          /* bookmarks unavailable */
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
            saved.session_token ?? "",
          );
        }
      } catch {
        /* connection unavailable */
      }
    })().catch((err) => reportAsyncActionFailure(`Security ${action}`, err));
  };
  document
    .getElementById("security-setup-btn")!
    .addEventListener("click", () => runSecurityAction("setup"));
  document
    .getElementById("security-unlock-btn")!
    .addEventListener("click", () => runSecurityAction("unlock"));
  document
    .getElementById("security-disable-btn")!
    .addEventListener("click", () => runSecurityAction("disable"));
  document
    .getElementById("security-change-password")!
    .addEventListener("click", () => {
      void handleSecurityChangePassword(setStatus).catch((err) =>
        reportAsyncActionFailure("Change password", err),
      );
    });
  document
    .getElementById("security-lock-btn")!
    .addEventListener("click", () => {
      void (async () => {
        // Ask before anything is torn down: running transfers stop on lock.
        if (!(await confirmSessionTeardown("Lock now"))) return;
        // Disconnect first so the backend cancels and drains operations that
        // already cloned the S3 client before encrypted credentials are locked.
        if (state.connected && !(await handleDisconnect())) return;
        const locked = await handleLockNow(setStatus);
        if (locked) {
          cancelPendingConnect();
          cancelPendingTestConnection();
          setConnectionAccessLocked(true);
          // Same single teardown as auto-lock (H5), then show the locked
          // saved list rather than an empty one.
          await teardownLockedSession();
          setSavedConnectionsLocked(true);
          clearBookmarks();
          refreshBookmarkBar();
        }
      })().catch((err) => reportAsyncActionFailure("Lock now", err));
    });
  document
    .getElementById("security-lock-timeout")!
    .addEventListener("change", () => {
      void handleLockTimeoutChange().catch((err) =>
        reportAsyncActionFailure("Change lock timeout", err),
      );
    });
  document.getElementById("biometric-toggle")!.addEventListener("click", () => {
    void handleBiometricToggle(setStatus).catch((err) =>
      reportAsyncActionFailure("Change biometric setting", err),
    );
  });

  document.getElementById("nav-back")?.addEventListener("click", () => {
    void navigateBack().catch((err) =>
      reportAsyncActionFailure("Navigate back", err),
    );
  });
  document.getElementById("nav-forward")?.addEventListener("click", () => {
    void navigateForward().catch((err) =>
      reportAsyncActionFailure("Navigate forward", err),
    );
  });
  document.getElementById("nav-up")?.addEventListener("click", () => {
    void navigateUp().catch((err) =>
      reportAsyncActionFailure("Navigate up", err),
    );
  });
}

/** Location omnibar, path input, filters and paging. */
function wireLocationAndFilters(): void {
  const pathInput = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  pathInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void navigateToLocationPath(pathInput.value)
        .then((ok) => {
          if (ok) exitLocationEditMode(true);
        })
        .catch((err) => reportAsyncActionFailure("Go to location", err));
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitLocationEditMode(true);
    }
  });

  // Leaving the editor by any route (Tab, a click elsewhere) closes it and
  // restores the path, so it cannot linger as an unlabeled, stale input.
  pathInput?.addEventListener("blur", () => {
    if (isLocationEditMode()) exitLocationEditMode(true);
  });

  // One click anywhere on the bar outside a breadcrumb segment opens the
  // editor. Segments keep their own click (navigate to that folder).
  const locationOmnibar = document.getElementById("location-omnibar");
  locationOmnibar?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // The Edit button enters edit mode itself, so the bar ignores its clicks.
    if (
      target.closest(
        ".breadcrumb__segment, .location-omnibar__edit, .location-omnibar__edit-btn",
      )
    )
      return;
    if (isLocationEditMode()) return;
    enterLocationEditMode();
  });
  document
    .getElementById("location-edit")
    ?.addEventListener("click", () => enterLocationEditMode());

  document
    .getElementById("btn-refresh")!
    .addEventListener("click", handleRefresh);
  document
    .getElementById("palette-hint")!
    .addEventListener("click", openPalette);
  document
    .getElementById("btn-new-folder")!
    .addEventListener("click", handleCreateFolder);
  const uploadButton = document.getElementById(
    "btn-upload",
  ) as HTMLButtonElement | null;
  if (uploadButton) {
    const dismissUploadMenu = (): void => {
      uploadButton.setAttribute("aria-expanded", "false");
    };
    uploadButton.addEventListener("click", () => {
      if (uploadButton.disabled) return;
      dismissUploadMenu();
      const rect = uploadButton.getBoundingClientRect();
      showContextMenu(
        rect.left,
        rect.bottom,
        [
          { label: "Files\u2026", action: "upload-files" },
          { label: "Folder\u2026", action: "upload-folder" },
        ],
        (action) => {
          dismissUploadMenu();
          if (action === "upload-files") {
            void handleUploadButton().catch((err) =>
              reportAsyncActionFailure("Upload files", err),
            );
          } else if (action === "upload-folder") {
            void handleUploadFolderButton().catch((err) =>
              reportAsyncActionFailure("Upload folder", err),
            );
          }
        },
        dismissUploadMenu,
      );
      uploadButton.setAttribute("aria-expanded", "true");
    });
  }

  wireObjectFilterInput();

  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  filterInput?.addEventListener("input", updateFilterClearButton);
  updateFilterClearButton();
  document.getElementById("filter-clear")?.addEventListener("click", () => {
    clearFilterInputDebounce();
    if (filterInput) filterInput.value = "";
    clearFilter();
    filterInput?.focus();
  });

  const bucketFilterInput = document.getElementById(
    "bucket-filter-input",
  ) as HTMLInputElement | null;
  if (bucketFilterInput) {
    bucketFilterInput.value = state.bucketFilterText;
    let bucketFilterDebounce: ReturnType<typeof setTimeout> | undefined;
    bucketFilterInput.addEventListener("input", () => {
      state.bucketFilterText = bucketFilterInput.value;
      if (bucketFilterDebounce !== undefined) {
        clearTimeout(bucketFilterDebounce);
      }
      bucketFilterDebounce = setTimeout(() => {
        renderBucketList();
        bucketFilterDebounce = undefined;
      }, FILTER_INPUT_DEBOUNCE_MS);
    });
  }

  const loadMoreBtn = document.getElementById(
    "btn-load-more",
  ) as HTMLButtonElement;
  loadMoreBtn.addEventListener("click", async () => {
    const connectionGeneration = currentConnectionGeneration();
    const listingGeneration = currentListingGeneration();
    const connectionId = state.connectionId;
    const bucket = state.currentBucket;
    const prefix = state.currentPrefix;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading\u2026";
    setStatus("Loading more...");
    try {
      await loadMoreObjects();
      // A navigation or reconnect that finished during the request owns the
      // table and status now; a stale page must not repaint over it.
      if (
        connectionGeneration !== currentConnectionGeneration() ||
        listingGeneration !== currentListingGeneration() ||
        connectionId !== state.connectionId ||
        bucket !== state.currentBucket ||
        prefix !== state.currentPrefix
      ) {
        return;
      }
      renderObjectTable();
      setStatus("");
    } catch (err) {
      if (
        connectionGeneration === currentConnectionGeneration() &&
        listingGeneration === currentListingGeneration() &&
        connectionId === state.connectionId &&
        bucket === state.currentBucket &&
        prefix === state.currentPrefix
      ) {
        setStatus(`Failed to load more: ${friendlyError(err)}`);
      }
    } finally {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load more";
    }
  });

  document.querySelectorAll<HTMLElement>(".sort-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const th = trigger.closest<HTMLElement>(".col-sortable");
      const col = th?.dataset.sort as "name" | "size" | "modified" | undefined;
      if (col) toggleSort(col);
    });
  });
}

/** Bucket list selection and context menu. */
function wireBucketList(): void {
  dom.bucketList.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      ".list__item-btn",
    );
    if (!button) return;
    const bucket = button.dataset.bucket;
    if (bucket) {
      void selectBucket(bucket)
        .then(() => closeSidebarOnMobile())
        .catch((err) => reportBucketOpenFailure(bucket, err));
    }
  });
  dom.bucketList.addEventListener("keydown", (e) => {
    handleBucketListKeydown(e as KeyboardEvent);
    if ((e as KeyboardEvent).defaultPrevented) return;
    if (
      (e as KeyboardEvent).key !== "Enter" &&
      (e as KeyboardEvent).key !== " "
    ) {
      return;
    }
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      ".list__item-btn",
    );
    const bucket = button?.dataset.bucket;
    if (!bucket) return;
    (e as KeyboardEvent).preventDefault();
    void selectBucket(bucket)
      .then(() => closeSidebarOnMobile())
      .catch((err) => reportBucketOpenFailure(bucket, err));
  });
  dom.bucketPanel.addEventListener("contextmenu", handleBucketContextMenu);
}

/** A bucket that fails to open must not look like an empty bucket. */
function reportBucketOpenFailure(bucket: string, err: unknown): void {
  const message = `Failed to open bucket "${bucket}": ${friendlyError(err)}`;
  reportNavFailure(message, () => {
    void selectBucket(bucket).catch((retryErr) =>
      reportBucketOpenFailure(bucket, retryErr),
    );
  });
  logActivity(message, "error");
}

/** Object table clicks, keys, selection and breadcrumb. */
function wireObjectTable(): void {
  dom.objectTbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;
    // The whole checkbox cell is the target, not only the 13px box. Clicking
    // the cell forwards to the input, whose change handler does the selection.
    const checkCell = target.closest<HTMLElement>(".col-check");
    if (checkCell && !target.closest(".row-check")) {
      checkCell.querySelector<HTMLInputElement>(".row-check")?.click();
      return;
    }
    if (target.closest(".row-check")) return;

    // Standard file-manager behavior: single click selects (with
    // ctrl/shift support via handleRowClick); open on double-click/Enter.
    const entry = entryFromRow(row);
    if (entry) handleRowClick(entry, e);
  });

  dom.objectTbody.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(
      ".row-check",
    );
    if (!input) return;
    const row = input.closest<HTMLElement>(".object-row");
    if (!row) return;
    const entry = entryFromRow(row);
    if (!entry) return;
    if (input.checked) {
      addSelection(entry);
    } else {
      removeSelection(entry);
    }
    setLastClickedEntry(entry);
    updateSelectionUI();
  });

  dom.objectTbody.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
    if (!row) return;
    if ((e.target as HTMLElement).closest(".row-check")) return;

    if (e.key === " ") {
      e.preventDefault();
      const entry = entryFromRow(row);
      if (!entry) return;
      if (isSelected(entry)) {
        removeSelection(entry);
      } else {
        addSelection(entry);
      }
      setLastClickedEntry(entry);
      updateSelectionUI();
      return;
    }

    // Arrow/Home/End row navigation lives in browser.ts
    // (handleObjectTableKeydown, capture phase) so virtualized and plain
    // tables share one owner; Space/Enter are handled here.
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter acts on the focused row, so it becomes the selection first; the
      // open/preview below then refers to what the user sees highlighted.
      const focusedEntry = entryFromRow(row);
      if (focusedEntry) selectOnlyEntry(focusedEntry);
      if (row.classList.contains("object-row--folder")) {
        const prefix = row.dataset.prefix;
        if (prefix !== undefined) {
          void navigateToFolder(prefix).catch((err) => {
            reportNavFailure(
              `Failed to open folder: ${friendlyError(err)}`,
              () => {
                void navigateToFolder(prefix).catch((retryErr) => {
                  reportAsyncActionFailure("Open folder", retryErr);
                });
              },
            );
          });
        }
        return;
      }

      const key = row.dataset.key;
      if (!key) return;
      if (canPreview(basename(key))) {
        void openPreview(key).catch((err) =>
          reportAsyncActionFailure("Open preview", err),
        );
      } else {
        void openInfoPanel([fileEntry(key)]).catch((err) =>
          reportAsyncActionFailure("Open properties", err),
        );
      }
    }
  });

  dom.objectTbody.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    // Checkbox cells toggle selection on click; a double-click there must not
    // fall through to opening the row.
    if (target.closest(".col-check, .row-check")) return;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;
    if (row.classList.contains("object-row--folder")) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) {
        void navigateToFolder(prefix).catch((err) => {
          reportNavFailure(
            `Failed to open folder: ${friendlyError(err)}`,
            () => {
              void navigateToFolder(prefix).catch((retryErr) => {
                reportAsyncActionFailure("Open folder", retryErr);
              });
            },
          );
          logActivity(`Failed to open folder: ${friendlyError(err)}`, "error");
        });
      }
      return;
    }
    const key = row.dataset.key;
    if (!key) return;
    if (canPreview(basename(key))) {
      void openPreview(key).catch((err) =>
        reportAsyncActionFailure("Open preview", err),
      );
    } else {
      void openInfoPanel([fileEntry(key)]).catch((err) =>
        reportAsyncActionFailure("Open properties", err),
      );
    }
  });

  dom.objectTbody.addEventListener("click", (e) => {
    const actionBtn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-empty-action]",
    );
    if (!actionBtn) return;
    const action = actionBtn.dataset.emptyAction;
    if (action === "upload") {
      void handleUploadButton().catch((err) =>
        reportAsyncActionFailure("Upload files", err),
      );
    } else if (action === "new-folder") {
      void handleCreateFolder().catch((err) =>
        reportAsyncActionFailure("Create folder", err),
      );
    } else if (action === "clear-filter") {
      clearFilterInputDebounce();
      clearFilter();
      (
        document.getElementById("filter-input") as HTMLInputElement | null
      )?.focus();
    }
  });

  dom.emptyState.addEventListener("click", (e) => {
    const actionBtn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-empty-action]",
    );
    if (!actionBtn) return;
    if (actionBtn.dataset.emptyAction === "show-buckets") {
      (
        document.getElementById("sidebar-toggle") as HTMLButtonElement | null
      )?.click();
    }
  });

  dom.objectTbody.addEventListener("contextmenu", handleContextMenu);
  dom.objectPanel.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest(".object-row")) {
      handleContextMenu(e);
    }
  });

  document.getElementById("select-all")!.addEventListener("change", (e) => {
    handleSelectAll((e.target as HTMLInputElement).checked);
  });

  dom.breadcrumb.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>(
      ".breadcrumb__segment",
    );
    if (!seg) return;
    const prefix = seg.dataset.prefix;
    if (prefix !== undefined) {
      void navigateToFolder(prefix).catch((err) => {
        reportNavFailure(`Failed to open folder: ${friendlyError(err)}`, () => {
          void navigateToFolder(prefix).catch((retryErr) => {
            reportAsyncActionFailure("Open folder", retryErr);
          });
        });
      });
    }
  });

  // Clicking the header's checkbox cell (not the box itself) toggles select-all.
  document
    .getElementById("select-all")
    ?.closest("th")
    ?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, .sort-trigger")) return;
      const selectAll = document.getElementById(
        "select-all",
      ) as HTMLInputElement | null;
      selectAll?.click();
    });
}

/** Drag-and-drop uploads onto the object panel. */
function wireDropUpload(): void {
  const objectPanel = dom.objectPanel;
  const dropOverlay = document.getElementById(
    "drop-zone-overlay",
  ) as HTMLDivElement;
  const dropPath = document.getElementById(
    "drop-zone-path",
  ) as HTMLParagraphElement;

  const suppressDrag = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  objectPanel.addEventListener("dragover", suppressDrag);
  dropOverlay.addEventListener("dragover", suppressDrag);
  objectPanel.addEventListener("drop", suppressDrag);
  dropOverlay.addEventListener("drop", suppressDrag);

  // Escape dismisses the target without dropping. The native drop event still
  // arrives afterwards, so remember the escaped drag and ignore its matching
  // drop. A dragleave starts a new drag and clears that memory.
  let escapedDrop = false;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || dropOverlay.hidden) return;
    dropOverlay.hidden = true;
    objectPanel.classList.remove("object-panel--dragover");
    escapedDrop = true;
  });

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        escapedDrop = false;
        // Only offer a target when a drop would actually upload: connected to
        // a bucket, carrying files, and no dialog waiting for an answer.
        const canUpload =
          state.connected &&
          Boolean(state.currentBucket) &&
          event.payload.paths.length > 0 &&
          !document.body.classList.contains("modal-open");
        if (canUpload) {
          dropPath.textContent = `${state.currentBucket}/${state.currentPrefix}`;
          dropOverlay.hidden = false;
          objectPanel.classList.add("object-panel--dragover");
        }
      } else if (event.payload.type === "leave") {
        escapedDrop = false;
        objectPanel.classList.remove("object-panel--dragover");
        dropOverlay.hidden = true;
      } else if (event.payload.type === "drop") {
        objectPanel.classList.remove("object-panel--dragover");
        dropOverlay.hidden = true;
        if (escapedDrop) {
          escapedDrop = false;
          return;
        }

        if (document.body.classList.contains("modal-open")) {
          setStatus(
            "Finish or close the open dialog before dropping files.",
            5000,
          );
          return;
        }
        if (!state.connected || !state.currentBucket) {
          setStatus("Connect to a bucket first.", 5000);
          return;
        }

        const paths = event.payload.paths;
        if (paths.length > 0) {
          void queueDroppedPaths(state.currentPrefix).catch((err) =>
            reportAsyncActionFailure("Queue dropped files", err),
          );
        } else {
          setStatus(
            "No dropped files detected. Try Upload Files instead.",
            5000,
          );
        }
      }
    })
    .then((unlisten) => {
      dragDropUnlisten?.();
      dragDropUnlisten = unlisten;
    })
    .catch((err) => {
      console.error("Failed to register native drag and drop:", err);
      logActivity(
        `Native drag and drop unavailable: ${friendlyError(err)}`,
        "warning",
      );
    });
}

/** Transfer completion refresh and notifications. */
function wireTransferCompletion(): void {
  setTransferCompleteHandler(async (summary) => {
    if (
      (summary.hadUpload || summary.hadListingChange) &&
      state.connected &&
      state.currentBucket
    ) {
      const connectionId = state.connectionId;
      const bucket = state.currentBucket;
      const prefix = state.currentPrefix;
      try {
        // A background refresh must not wipe what the user has selected.
        const committed = await refreshObjects(bucket, prefix, {
          supersedePending: false,
          preserveSelection: true,
        });
        if (
          committed &&
          state.connected &&
          state.connectionId === connectionId &&
          state.currentBucket === bucket &&
          state.currentPrefix === prefix
        ) {
          pruneStaleSelection();
          renderObjectTable();
        }
      } catch (err) {
        setStatus(
          `Transfer completed, but listing refresh failed: ${friendlyError(err)}`,
          5000,
        );
        logActivity(
          `Transfer completed, but listing refresh failed: ${friendlyError(err)}`,
          "warning",
        );
      }
    }

    const parts: string[] = [];
    if (summary.uploadCount > 0) {
      parts.push(`${summary.uploadCount} uploaded`);
    }
    if (summary.copyCount > 0) {
      parts.push(`${summary.copyCount} copied`);
    }
    if (summary.moveCount > 0) {
      parts.push(`${summary.moveCount} moved`);
    }
    if (summary.downloadCount > 0) {
      parts.push(`${summary.downloadCount} downloaded`);
    }
    if (parts.length > 0) {
      showToast(`Transfer complete \u2014 ${parts.join(", ")}`, {
        type: "success",
      });
    } else if (
      summary.hadUpload ||
      summary.hadDownload ||
      summary.hadListingChange
    ) {
      showToast("Transfer complete", { type: "success" });
    }
    if (summary.errorCount > 0) {
      // Sticky, with the two things the user needs next: look at the rows, or
      // retry them. Both open the Transfers tab rather than the log.
      showToast(`${plural(summary.errorCount, "transfer")} failed`, {
        type: "error",
        duration: 0,
        actions: [
          {
            label: "Show failed",
            onClick: () => {
              openDrawer("transfers");
              setTransferFilter("failed");
            },
          },
          { label: "Retry failed", onClick: () => retryFailedTransfers() },
        ],
      });
    }
    if (summary.skippedCount > 0) {
      showToast(
        `${summary.skippedCount} transfer${summary.skippedCount === 1 ? "" : "s"} skipped`,
        { type: "warning" },
      );
    }
  });
}

/** Command palette entries and their shortcuts. */

/** One palette command rendered from the shared object-actions registry. */
function paletteCommandForAction(id: string): PaletteCommand {
  const entry = getObjectAction(id);
  if (!entry) throw new Error(`Unknown object action: ${id}`);
  return {
    id: entry.id,
    get label() {
      return resolveActionLabel(entry, currentActionContext());
    },
    icon: entry.icon,
    shortcut: entry.shortcut,
    keywords: entry.keywords,
    action: () => entry.run(currentActionContext()),
    available: () =>
      state.connected && entry.isAvailable(currentActionContext()),
  };
}

function wireCommandPalette(): void {
  initPalette();
  const isMac = state.platformName === "macos";
  const accelLabel = isMac ? "⌘" : "Ctrl+";
  registerCommands([
    {
      id: "upload-files",
      label: "Upload Files",
      icon: "upload",
      shortcut: `${accelLabel}U`,
      action: () => {
        void handleUploadButton().catch((err) =>
          reportAsyncActionFailure("Upload files", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "upload-folder",
      label: "Upload Folder",
      icon: "folder-up",
      shortcut: `${accelLabel}⇧U`,
      action: () => {
        void handleUploadFolderButton().catch((err) =>
          reportAsyncActionFailure("Upload folder", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "create-folder",
      label: "New folder",
      icon: "folder-plus",
      shortcut: `${accelLabel}N`,
      keywords: ["mkdir", "new folder"],
      action: () => {
        void handleCreateFolder().catch((err) =>
          reportAsyncActionFailure("Create folder", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: "refresh-cw",
      shortcut: "F5",
      keywords: ["reload"],
      action: () => {
        void handleRefresh().catch((err) =>
          reportAsyncActionFailure("Refresh", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "refresh-buckets",
      label: "Refresh Buckets",
      icon: "refresh-cw",
      keywords: ["bucket list", "reload buckets"],
      action: () => {
        void handleRefreshBuckets().catch((err) =>
          reportAsyncActionFailure("Refresh buckets", err),
        );
      },
      available: () => state.connected,
    },
    // Selection commands come from the object-actions registry, so their
    // labels match the context menu and the batch More menu exactly.
    paletteCommandForAction("download"),
    paletteCommandForAction("delete"),
    paletteCommandForAction("copy-move"),
    paletteCommandForAction("rename"),
    paletteCommandForAction("copy-url"),
    paletteCommandForAction("share-link"),
    paletteCommandForAction("copy-keys"),
    paletteCommandForAction("copy-arns"),
    paletteCommandForAction("copy-s3-uri"),
    paletteCommandForAction("properties"),
    paletteCommandForAction("deselect-all"),
    paletteCommandForAction("preview"),
    {
      id: "select-all",
      label: "Select All",
      icon: "check-square",
      shortcut: `${accelLabel}A`,
      action: () => {
        handleSelectAll(true);
      },
      available: () => state.connected,
    },
    {
      id: "filter",
      label: "Filter Objects",
      icon: "search",
      shortcut: `${accelLabel}F`,
      action: () => {
        const f = document.getElementById(
          "filter-input",
        ) as HTMLInputElement | null;
        if (f) f.focus();
      },
      available: () => state.connected,
    },
    {
      id: "go-to-key-prefix",
      label: "Go to Key/Prefix",
      icon: "compass",
      keywords: ["jump", "path", "prefix"],
      action: () => {
        void handleGoToKeyOrPrefix().catch((err) =>
          reportAsyncActionFailure("Go to key or prefix", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "open-last-download-folder",
      label: "Open Last Download Folder",
      icon: "folder",
      action: () => {
        void handleOpenLastDownloadFolder().catch((err) =>
          reportAsyncActionFailure("Open download folder", err),
        );
      },
      available: () =>
        state.currentSettings.rememberDownloadPath &&
        getRememberedDownloadDir().length > 0,
    },
    {
      id: "export-activity-log",
      label: "Export Activity Log",
      icon: "save",
      action: () => {
        void handleExportActivityLog().catch((err) =>
          reportAsyncActionFailure("Export activity log", err),
        );
      },
    },
    {
      id: "activity",
      label: "Toggle Activity Log",
      icon: "clipboard-list",
      action: () => toggleActivityLog(),
    },
    {
      id: "settings",
      label: "Open Settings",
      icon: "settings",
      action: () => {
        document.getElementById("settings-btn")?.click();
      },
    },
    {
      id: "toggle-inspector",
      label: "Toggle Inspector",
      icon: "sidebar",
      shortcut: `${accelLabel}⇧I`,
      action: () => toggleInspector(),
      available: () => state.connected,
    },
    {
      id: "go-up",
      label: "Go Up (Parent Folder)",
      icon: "arrow-up",
      action: () => {
        void navigateUp().catch((err) =>
          reportAsyncActionFailure("Navigate up", err),
        );
      },
      available: () => state.connected && state.currentPrefix.length > 0,
    },
    {
      id: "back",
      label: "Back",
      icon: "arrow-left",
      keywords: ["previous", "history"],
      action: () => {
        void navigateBack().catch((err) =>
          reportAsyncActionFailure("Navigate back", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "forward",
      label: "Forward",
      icon: "arrow-right",
      keywords: ["next", "history"],
      action: () => {
        void navigateForward().catch((err) =>
          reportAsyncActionFailure("Navigate forward", err),
        );
      },
      available: () => state.connected,
    },
    {
      id: "clear-filter",
      label: "Clear Filter",
      icon: "x-square",
      keywords: ["reset filter"],
      action: () => clearFilter(),
      available: () => {
        const filter = document.getElementById(
          "filter-input",
        ) as HTMLInputElement | null;
        return state.connected && (filter?.value.length ?? 0) > 0;
      },
    },
    {
      id: "edit-location",
      label: "Edit Location",
      icon: "compass",
      keywords: ["address bar", "path", "url"],
      action: () => enterLocationEditMode(),
      available: () => state.connected,
    },
    {
      id: "keyboard-shortcuts",
      label: "Keyboard Shortcuts",
      icon: "info",
      shortcut: `${accelLabel}/`,
      keywords: ["keys", "hotkeys", "bindings"],
      action: () => {
        void openKeyboardShortcuts().catch((err) =>
          reportAsyncActionFailure("Open keyboard shortcuts", err),
        );
      },
    },
  ]);
}

export function wireEvents(): void {
  wireConnectionForm();
  wireSettingsModal();
  wireOverlaysAndDrawer();
  wireAppLifecycle();
  wireSelectionActions();
  wireSecuritySettings();
  wireLocationAndFilters();
  wireBucketList();
  wireObjectTable();
  wireDropUpload();
  wireTransferCompletion();

  wireLayoutControls();
  wireInspectorControls();
  wireInspectorChrome();

  wireCommandPalette();

  initModalLayerObserver();

  wireKeyboardShortcuts({
    setSidebarOpen,
    handleDelete,
    handleRefresh,
    handleRename,
    handleUploadButton,
    handleUploadFolderButton,
    handleCreateFolder,
  });

  setBookmarkSelectHandler((bookmark) => {
    void switchToBookmark(
      bookmark.name,
      bookmark.endpoint,
      bookmark.region,
      bookmark.access_key,
      bookmark.secret_key,
      bookmark.session_token ?? "",
    ).catch((err) => reportAsyncActionFailure("Open bookmark", err));
  });

  wireWindowSizePersistence();
}
