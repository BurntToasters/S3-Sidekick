import { invoke } from "./ipc.ts";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { state, dom } from "./state.ts";
import {
  openSettingsModal,
  closeSettingsModal,
  resetSettings,
  setBookmarkSelectHandler,
  switchSettingsTab,
} from "./settings.ts";
import {
  loadConnection,
  refreshObjects,
  loadMoreObjects,
} from "./connection.ts";
import {
  renderBucketList,
  renderObjectTable,
  navigateToFolder,
  selectBucket,
  handleRowClick,
  handleBucketListKeydown,
  handleSelectAll,
  clearSelection,
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
} from "./browser.ts";
import { wireInspectorChrome, toggleInspector } from "./inspector.ts";
import { wireWindowSizePersistence } from "./window-size.ts";
import {
  checkUpdates,
  getReleasePageUrl,
  setUpdateChannel,
} from "./updater.ts";
import { loadBookmarks, clearBookmarks } from "./bookmarks.ts";
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
import { showConfirm } from "./dialogs.ts";
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
  awsRegionalEndpoint,
  setConnectionUI,
  confirmSessionTeardown,
  handleConnectButton,
  handleDisconnectRequest,
  setSavedConnectionsLocked,
} from "./app-connection.ts";
import { setConnectionAccessLocked } from "./connection.ts";
import {
  addSelection,
  entryFromRow,
  fileEntry,
  getSelectedFileKeys,
  getSelectionEntries,
  isSelected,
  removeSelection,
  selectionCount,
} from "./app-selection.ts";
import {
  handleDelete,
  handleRename,
  handleCreateFolder,
  handleRefresh,
  handleRefreshBuckets,
  handleExportActivityLog,
  handleGoToKeyOrPrefix,
  handleCopyUrl,
  handleCopyKey,
  handleCopyArn,
} from "./app-objects.ts";
import {
  handleDownload,
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
import { openCopyMoveDialog } from "./app-copy-move.ts";

let dragDropUnlisten: (() => void) | null = null;

/**
 * After an inactivity auto-lock: end the S3 session and drop decrypted
 * credentials and bookmarks from memory, as the manual lock button does.
 */
export async function clearSessionAfterAutoLock(): Promise<boolean> {
  const hadSession = state.connected || Boolean(state.connectionId);
  setConnectionAccessLocked(true);
  setSavedConnectionsLocked(true);
  setConnectionUI(false);
  closePreview();
  setConnectionInputs("", "", "", "");
  clearBookmarks();
  refreshBookmarkBar();
  if (hadSession && !(await handleDisconnect())) {
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
  dom.disconnectBtn.addEventListener("click", () => {
    void handleDisconnectRequest();
  });

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
        void handleConnect();
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
    providerPreset.addEventListener("change", () => {
      const endpointInput = document.getElementById(
        "conn-endpoint",
      ) as HTMLInputElement | null;
      const regionInput = document.getElementById(
        "conn-region",
      ) as HTMLInputElement | null;
      const preset = providerPreset.value;
      if (preset === "aws") {
        const region = "us-east-1";
        if (endpointInput) endpointInput.value = awsRegionalEndpoint(region);
        if (regionInput) regionInput.value = region;
      } else if (preset === "do") {
        if (endpointInput)
          endpointInput.value = "https://nyc3.digitaloceanspaces.com";
        if (regionInput) regionInput.value = "nyc3";
      } else if (preset === "backblaze") {
        if (endpointInput)
          endpointInput.value = "https://s3.us-west-004.backblazeb2.com";
        if (regionInput) regionInput.value = "us-west-004";
      } else if (preset === "cloudflare") {
        // The account ID is a placeholder: select it so typing replaces it.
        const placeholder = "<account-id>";
        if (endpointInput) {
          endpointInput.value = `https://${placeholder}.r2.cloudflarestorage.com`;
          endpointInput.focus();
          const start = endpointInput.value.indexOf(placeholder);
          endpointInput.setSelectionRange(start, start + placeholder.length);
        }
        if (regionInput) regionInput.value = "auto";
      } else if (preset === "minio") {
        if (endpointInput) endpointInput.value = "http://localhost:9000";
        if (regionInput) regionInput.value = "us-east-1";
      } else if (preset === "wasabi") {
        if (endpointInput) endpointInput.value = "https://s3.wasabisys.com";
        if (regionInput) regionInput.value = "us-east-1";
      }
      // Keep the chosen preset visible so the user can see which one was applied.
      updateBookmarkBtn();
    });
  }

  document
    .getElementById("bookmark-save-btn")!
    .addEventListener("click", handleBookmarkSave);

  document.getElementById("conn-new-btn")!.addEventListener("click", () => {
    void handleNewConnection();
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
    void checkUpdates().finally(() => {
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
        void closeSettingsModal(false);
      }
    });

  document
    .getElementById("info-close")!
    .addEventListener("click", () => void requestCloseInfoPanel());
  document
    .getElementById("info-cancel")!
    .addEventListener("click", () => void requestCloseInfoPanel());
  document
    .getElementById("info-save")!
    .addEventListener("click", saveInfoPanel);
}

/** Info overlay and the bottom activity drawer. */
function wireOverlaysAndDrawer(): void {
  document.getElementById("info-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) void requestCloseInfoPanel();
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
  document
    .getElementById("transfer-toggle")!
    .addEventListener("click", toggleTransferQueue);
  document.getElementById("drawer-export")?.addEventListener("click", () => {
    if (getActiveTab() === "activity") {
      void handleExportActivityLog();
    }
  });
  document.getElementById("drawer-clear")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab === "activity") {
      void showConfirm(
        "Clear activity log?",
        "This removes every entry from the activity log. Files and transfers are not changed.",
        { okLabel: "Clear", cancelLabel: "Keep", okDanger: true },
      ).then((confirmed) => {
        if (confirmed) clearActivityLog();
      });
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
  window.addEventListener("beforeunload", () => {
    disposeFilterInputDebounce();
    disposeModalLayerObserver();
    dragDropUnlisten?.();
    dragDropUnlisten = null;
    void disposeTransferQueueUI();
  });

  document
    .getElementById("preview-close")!
    .addEventListener("click", closePreview);
}

/** Preview overlay and batch selection actions. */
/** More-menu actions that have a batch toolbar button of the same name. */
const TOOLBAR_TWIN_BY_ACTION: Readonly<Record<string, string>> = {
  "copy-urls": "batch-copy-urls",
  delete: "batch-delete",
  "deselect-all": "batch-deselect",
};

function isToolbarButtonShowing(id: string): boolean {
  const button = document.getElementById(id);
  return button !== null && button.getClientRects().length > 0;
}

function withoutVisibleToolbarTwins(items: MenuItem[]): MenuItem[] {
  const kept = items.filter((item) => {
    if ("separator" in item) return true;
    const twin = TOOLBAR_TWIN_BY_ACTION[item.action];
    return !twin || !isToolbarButtonShowing(twin);
  });
  // Separators survive only between two real actions.
  return kept.filter((item, index) => {
    if (!("separator" in item)) return true;
    const prev = kept[index - 1];
    const next = kept[index + 1];
    return (
      prev !== undefined &&
      next !== undefined &&
      !("separator" in prev) &&
      !("separator" in next)
    );
  });
}

function wireSelectionActions(): void {
  document.getElementById("preview-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  document
    .getElementById("activity-toggle")!
    .addEventListener("click", toggleActivityLog);

  document.getElementById("batch-properties")!.addEventListener("click", () => {
    const keys = Array.from(getSelectionEntries());
    if (keys.length > 0) {
      void openInfoPanel(keys);
    }
  });
  document.getElementById("batch-download")!.addEventListener("click", () => {
    void handleDownload();
  });
  document.getElementById("batch-delete")!.addEventListener("click", () => {
    void handleDelete();
  });
  document.getElementById("batch-copy-urls")!.addEventListener("click", () => {
    void handleCopyUrl();
  });
  document.getElementById("batch-deselect")!.addEventListener("click", () => {
    clearSelection();
  });

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

      const objectPanel = document.getElementById("object-panel");
      const listingLoading = objectPanel?.getAttribute("aria-busy") === "true";
      const selectedFiles = getSelectedFileKeys().length;
      const selectedCount = selectionCount();
      const deleteButton = document.getElementById(
        "batch-delete",
      ) as HTMLButtonElement | null;
      const deleteInFlight = deleteButton?.dataset.operationInFlight === "true";
      const rect = batchMore.getBoundingClientRect();
      const allMenuItems: MenuItem[] = [
        {
          label: "Copy keys",
          action: "copy-keys",
          disabled: selectedCount === 0 || listingLoading,
        },
        {
          label: "Copy ARNs",
          action: "copy-arns",
          disabled: selectedCount === 0 || listingLoading,
        },
        {
          label: "Copy / Move to...",
          action: "copy-move",
          disabled: selectedCount === 0 || listingLoading,
        },
        { separator: true },
        {
          label: "Delete",
          action: "delete",
          disabled: selectedCount === 0 || listingLoading || deleteInFlight,
        },
        {
          label: "Copy URLs",
          action: "copy-urls",
          disabled: selectedFiles === 0 || listingLoading,
        },
        {
          label: "Deselect All",
          action: "deselect-all",
          disabled: selectedCount === 0,
        },
      ];
      // Only list what the toolbar cannot show right now. A visible toolbar
      // button already answers the same action, so it is not repeated here.
      const menuItems = withoutVisibleToolbarTwins(allMenuItems);
      showContextMenu(
        rect.left,
        rect.bottom,
        menuItems,
        (action) => {
          dismissMoreMenu();
          if (action === "copy-keys") void handleCopyKey();
          else if (action === "copy-arns") void handleCopyArn();
          else if (action === "copy-move") openCopyMoveDialog();
          else if (action === "delete") void handleDelete();
          else if (action === "copy-urls") void handleCopyUrl();
          else if (action === "deselect-all") clearSelection();
        },
        dismissMoreMenu,
      );
      batchMore.setAttribute("aria-expanded", "true");
    });
  }
}

/** Vault, biometric and lock controls in Settings. */
function wireSecuritySettings(): void {
  // "Forgot password?" on the Unlock prompt runs the existing reset flow.
  setForgotPasswordHandler(() => void resetSettings());
  const runSecurityAction = (action: "setup" | "unlock" | "disable"): void => {
    void (async () => {
      const changed = await handleSecurityToggle(setStatus, action);
      if (!changed) return;
      try {
        await loadBookmarks();
        refreshBookmarkBar();
      } catch {
        /* bookmarks unavailable */
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
    })();
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
      void handleSecurityChangePassword(setStatus);
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
          setConnectionInputs("", "", "", "");
          // Mirror clearSessionAfterAutoLock: show the locked saved list, not an empty one.
          setSavedConnectionsLocked(true);
          clearBookmarks();
          refreshBookmarkBar();
          await closeSettingsModal(false);
        }
      })();
    });
  document
    .getElementById("security-lock-timeout")!
    .addEventListener("change", () => {
      void handleLockTimeoutChange();
    });
  document.getElementById("biometric-toggle")!.addEventListener("click", () => {
    void handleBiometricToggle(setStatus);
  });

  document
    .getElementById("nav-back")
    ?.addEventListener("click", () => void navigateBack());
  document
    .getElementById("nav-forward")
    ?.addEventListener("click", () => void navigateForward());
  document
    .getElementById("nav-up")
    ?.addEventListener("click", () => void navigateUp());
}

/** Location omnibar, path input, filters and paging. */
function wireLocationAndFilters(): void {
  const pathInput = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  pathInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void navigateToLocationPath(pathInput.value).then((ok) => {
        if (ok) exitLocationEditMode(true);
      });
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
    .getElementById("btn-palette")!
    .addEventListener("click", openPalette);
  document
    .getElementById("palette-hint")!
    .addEventListener("click", openPalette);
  document
    .getElementById("btn-new-folder")!
    .addEventListener("click", handleCreateFolder);
  document
    .getElementById("btn-upload")!
    .addEventListener("click", handleUploadButton);
  document
    .getElementById("btn-upload-folder")!
    .addEventListener("click", handleUploadFolderButton);
  document.getElementById("btn-download")!.addEventListener("click", () => {
    void handleDownload();
  });

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
    renderObjectTable();
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
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading\u2026";
    setStatus("Loading more...");
    try {
      await loadMoreObjects();
      renderObjectTable();
      setStatus("");
    } catch (err) {
      setStatus(`Failed to load more: ${friendlyError(err)}`);
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
  reportNavFailure(message, () => void selectBucket(bucket));
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
              () => void navigateToFolder(prefix),
            );
          });
        }
        return;
      }

      const key = row.dataset.key;
      if (!key) return;
      if (canPreview(basename(key))) {
        void openPreview(key);
      } else {
        void openInfoPanel([fileEntry(key)]);
      }
    }
  });

  dom.objectTbody.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".row-check")) return;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;
    if (row.classList.contains("object-row--folder")) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) {
        void navigateToFolder(prefix).catch((err) => {
          reportNavFailure(
            `Failed to open folder: ${friendlyError(err)}`,
            () => void navigateToFolder(prefix),
          );
          logActivity(`Failed to open folder: ${friendlyError(err)}`, "error");
        });
      }
      return;
    }
    const key = row.dataset.key;
    if (!key) return;
    if (canPreview(basename(key))) {
      void openPreview(key);
    } else {
      void openInfoPanel([fileEntry(key)]);
    }
  });

  dom.objectTbody.addEventListener("click", (e) => {
    const actionBtn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-empty-action]",
    );
    if (!actionBtn) return;
    const action = actionBtn.dataset.emptyAction;
    if (action === "upload") {
      void handleUploadButton();
    } else if (action === "new-folder") {
      void handleCreateFolder();
    } else if (action === "clear-filter") {
      clearFilterInputDebounce();
      clearFilter();
      renderObjectTable();
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
        reportNavFailure(
          `Failed to open folder: ${friendlyError(err)}`,
          () => void navigateToFolder(prefix),
        );
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

  // Escape dismisses the target without dropping; the next drag re-shows it.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || dropOverlay.hidden) return;
    dropOverlay.hidden = true;
    objectPanel.classList.remove("object-panel--dragover");
  });

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
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
        objectPanel.classList.remove("object-panel--dragover");
        dropOverlay.hidden = true;
      } else if (event.payload.type === "drop") {
        objectPanel.classList.remove("object-panel--dragover");
        dropOverlay.hidden = true;

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
          void queueDroppedPaths(paths, state.currentPrefix);
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
      action: () => void handleUploadButton(),
      available: () => state.connected,
    },
    {
      id: "upload-folder",
      label: "Upload Folder",
      icon: "folder-up",
      shortcut: `${accelLabel}⇧U`,
      action: () => void handleUploadFolderButton(),
      available: () => state.connected,
    },
    {
      id: "create-folder",
      label: "Create Folder",
      icon: "folder-plus",
      shortcut: `${accelLabel}N`,
      keywords: ["mkdir", "new folder"],
      action: () => void handleCreateFolder(),
      available: () => state.connected,
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: "refresh-cw",
      shortcut: "F5",
      keywords: ["reload"],
      action: () => void handleRefresh(),
      available: () => state.connected,
    },
    {
      id: "refresh-buckets",
      label: "Refresh Buckets",
      icon: "refresh-cw",
      keywords: ["bucket list", "reload buckets"],
      action: () => void handleRefreshBuckets(),
      available: () => state.connected,
    },
    {
      id: "download",
      label: "Download Selected",
      icon: "download",
      action: () => void handleDownload(),
      available: () => state.connected && getSelectedFileKeys().length > 0,
    },
    {
      id: "delete",
      label: "Delete Selected",
      icon: "trash-2",
      keywords: ["trash", "remove"],
      action: () => void handleDelete(),
      available: () => state.connected && selectionCount() > 0,
    },
    {
      id: "copy-move",
      label: "Copy / Move to...",
      icon: "folder",
      action: () => openCopyMoveDialog(),
      available: () => state.connected && selectionCount() > 0,
    },
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
      id: "deselect-all",
      label: "Deselect All",
      icon: "x-square",
      action: () => clearSelection(),
      available: () => selectionCount() > 0,
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
      action: () => void handleGoToKeyOrPrefix(),
      available: () => state.connected,
    },
    {
      id: "open-last-download-folder",
      label: "Open Last Download Folder",
      icon: "folder",
      action: () => void handleOpenLastDownloadFolder(),
      available: () =>
        state.currentSettings.rememberDownloadPath &&
        getRememberedDownloadDir().length > 0,
    },
    {
      id: "export-activity-log",
      label: "Export Activity Log",
      icon: "save",
      action: () => void handleExportActivityLog(),
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
      id: "preview-selected",
      label: "Preview Selected File",
      icon: "eye",
      action: () => {
        const fileKeys = getSelectedFileKeys();
        if (fileKeys.length === 1 && canPreview(basename(fileKeys[0]))) {
          void openPreview(fileKeys[0]);
        }
      },
      available: () => {
        const fileKeys = getSelectedFileKeys();
        return (
          state.connected &&
          fileKeys.length === 1 &&
          canPreview(basename(fileKeys[0]))
        );
      },
    },
    {
      id: "properties-selected",
      label: "Open Properties for Selection",
      icon: "info",
      action: () => {
        const keys = Array.from(getSelectionEntries());
        if (keys.length > 0) {
          void openInfoPanel(keys);
        }
      },
      available: () => state.connected && selectionCount() > 0,
    },
    {
      id: "go-up",
      label: "Go Up (Parent Folder)",
      icon: "arrow-up",
      action: () => {
        void navigateUp();
      },
      available: () => state.connected && state.currentPrefix.length > 0,
    },
    {
      id: "rename-selected",
      label: "Rename Selected",
      icon: "file-text",
      keywords: ["move", "name"],
      action: () => void handleRename(),
      available: () => state.connected && selectionCount() === 1,
    },
    {
      id: "copy-urls",
      label: "Copy Object URLs",
      icon: "clipboard-list",
      keywords: ["link", "url"],
      action: () => void handleCopyUrl(),
      available: () => state.connected && getSelectedFileKeys().length > 0,
    },
    {
      id: "copy-keys",
      label: "Copy Keys",
      icon: "clipboard-list",
      keywords: ["path", "name"],
      action: () => void handleCopyKey(),
      available: () => state.connected && selectionCount() > 0,
    },
    {
      // Non-AWS endpoints get an explanation from handleCopyArn rather than a
      // hidden command, so the reason is visible.
      id: "copy-arns",
      label: "Copy ARNs",
      icon: "clipboard-list",
      keywords: ["amazon resource name"],
      action: () => void handleCopyArn(),
      available: () => state.connected && selectionCount() > 0,
    },
    {
      id: "back",
      label: "Back",
      icon: "arrow-left",
      keywords: ["previous", "history"],
      action: () => void navigateBack(),
      available: () => state.connected,
    },
    {
      id: "forward",
      label: "Forward",
      icon: "arrow-right",
      keywords: ["next", "history"],
      action: () => void navigateForward(),
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
      action: () => void openKeyboardShortcuts(),
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
    );
  });

  wireWindowSizePersistence();
}
