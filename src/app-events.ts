import { getCurrentWebview } from "@tauri-apps/api/webview";
import { state, dom } from "./state.ts";
import {
  openSettingsModal,
  closeSettingsModal,
  resetSettings,
  setBookmarkSelectHandler,
  switchSettingsTab,
  saveSettings,
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
  handleSelectAll,
  clearSelection,
  setLastClickedKey,
  updateSelectionUI,
  toggleSort,
  navigateBack,
  navigateForward,
  navigateUp,
  navigateToLocationPath,
  enterLocationEditMode,
  exitLocationEditMode,
  pruneStaleSelection,
} from "./browser.ts";
import { wireInspectorChrome, toggleInspector } from "./inspector.ts";
import { checkUpdates, setUpdateChannel } from "./updater.ts";
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
} from "./transfers.ts";
import { wireKeyboardShortcuts } from "./keyboard.ts";
import { canPreview, openPreview, closePreview } from "./preview.ts";
import {
  logActivity,
  toggleActivityLog,
  clearActivityLog,
} from "./activity-log.ts";
import { initDrawer, getActiveTab } from "./bottom-drawer.ts";
import {
  handleSecurityChangePassword,
  handleSecurityToggle,
  handleLockNow,
  handleLockTimeoutChange,
  handleBiometricToggle,
} from "./security.ts";
import { initPalette, registerCommands } from "./command-palette.ts";
import { basename, friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { showToast } from "./toast.ts";
import {
  wireLayoutControls,
  wireInspectorControls,
  setSidebarOpen,
  closeSidebarOnMobile,
  handleTabListArrowKey,
  wireObjectFilterInput,
  initModalLayerObserver,
  disposeModalLayerObserver,
  disposeFilterInputDebounce,
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
} from "./app-connection.ts";
import { getSelectedFileKeys } from "./app-selection.ts";
import {
  handleDelete,
  handleRename,
  handleCreateFolder,
  handleRefresh,
  handleExportActivityLog,
  handleGoToKeyOrPrefix,
  handleCopyUrl,
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

export function wireEvents(): void {
  dom.connectBtn.addEventListener("click", handleConnect);
  dom.disconnectBtn.addEventListener("click", handleDisconnect);

  const connectionFieldIds = [
    "conn-endpoint",
    "conn-region",
    "conn-access-key",
    "conn-secret-key",
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

  const secretToggle = document.getElementById(
    "secret-key-toggle",
  ) as HTMLButtonElement | null;
  const secretInput = document.getElementById(
    "conn-secret-key",
  ) as HTMLInputElement | null;
  if (secretToggle && secretInput) {
    secretToggle.addEventListener("click", () => {
      const showing = secretInput.type === "text";
      secretInput.type = showing ? "password" : "text";
      secretToggle.textContent = showing ? "Show" : "Hide";
      secretToggle.setAttribute("aria-pressed", String(!showing));
      secretToggle.setAttribute(
        "aria-label",
        showing ? "Show secret key" : "Hide secret key",
      );
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
        if (endpointInput) endpointInput.value = "";
        if (regionInput) regionInput.value = "us-east-1";
      } else if (preset === "do") {
        if (endpointInput)
          endpointInput.value = "https://nyc3.digitaloceanspaces.com";
        if (regionInput) regionInput.value = "nyc3";
      } else if (preset === "backblaze") {
        if (endpointInput)
          endpointInput.value = "https://s3.us-west-004.backblazeb2.com";
        if (regionInput) regionInput.value = "us-west-004";
      } else if (preset === "cloudflare") {
        if (endpointInput)
          endpointInput.value = "https://<account-id>.r2.cloudflarestorage.com";
        if (regionInput) regionInput.value = "auto";
      } else if (preset === "minio") {
        if (endpointInput) endpointInput.value = "http://localhost:9000";
        if (regionInput) regionInput.value = "us-east-1";
      } else if (preset === "wasabi") {
        if (endpointInput) endpointInput.value = "https://s3.wasabisys.com";
        if (regionInput) regionInput.value = "us-east-1";
      }
      providerPreset.value = "";
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

  document
    .getElementById("settings-btn")!
    .addEventListener("click", openSettingsModal);
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
  document
    .getElementById("settings-check-updates")!
    .addEventListener("click", () => {
      const persistedChannel = state.lastPersistedSettings.updateChannel;
      const channelSelect = document.getElementById(
        "setting-update-channel",
      ) as HTMLSelectElement | null;
      setUpdateChannel(channelSelect?.value === "beta" ? "beta" : "release");
      void closeSettingsModal(false);
      void checkUpdates().finally(() => {
        setUpdateChannel(persistedChannel);
      });
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
      clearActivityLog();
    } else {
      clearCompletedTransfers();
    }
  });
  void initTransferQueueUI().catch((err) => {
    console.error("Failed to initialize transfer queue UI:", err);
    logActivity(`Transfer queue events unavailable: ${String(err)}`, "warning");
  });
  window.addEventListener("s3-sidekick:security-ready", () => {
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
    void disposeTransferQueueUI();
  });

  document
    .getElementById("preview-close")!
    .addEventListener("click", closePreview);
  document.getElementById("preview-overlay")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  document
    .getElementById("activity-toggle")!
    .addEventListener("click", toggleActivityLog);

  document.getElementById("batch-properties")!.addEventListener("click", () => {
    const keys = Array.from(state.selectedKeys);
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

  document.getElementById("security-toggle")!.addEventListener("click", () => {
    void (async () => {
      await handleSecurityToggle(setStatus);
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
          );
        }
      } catch {
        /* connection unavailable */
      }
    })();
  });
  document
    .getElementById("security-change-password")!
    .addEventListener("click", () => {
      void handleSecurityChangePassword(setStatus);
    });
  document
    .getElementById("security-lock-btn")!
    .addEventListener("click", () => {
      void (async () => {
        const locked = await handleLockNow(setStatus);
        if (locked) {
          if (state.connected) await handleDisconnect();
          setConnectionInputs("", "", "", "");
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

  const locationOmnibar = document.getElementById("location-omnibar");
  locationOmnibar?.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".breadcrumb__segment")) return;
    enterLocationEditMode();
  });
  locationOmnibar?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".breadcrumb__segment")) return;
    if (e.target === locationOmnibar) enterLocationEditMode();
  });

  document
    .getElementById("btn-refresh")!
    .addEventListener("click", handleRefresh);
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

  const bucketFilterInput = document.getElementById(
    "bucket-filter-input",
  ) as HTMLInputElement | null;
  if (bucketFilterInput) {
    bucketFilterInput.value = state.bucketFilterText;
    bucketFilterInput.addEventListener("input", () => {
      state.bucketFilterText = bucketFilterInput.value;
      renderBucketList();
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

  dom.bucketList.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      ".list__item-btn",
    );
    if (!button) return;
    const bucket = button.dataset.bucket;
    if (bucket) {
      void selectBucket(bucket)
        .then(() => closeSidebarOnMobile())
        .catch((err) => {
          setStatus(`Failed to open bucket "${bucket}": ${err}`);
          logActivity(
            `Failed to open bucket "${bucket}": ${String(err)}`,
            "error",
          );
        });
    }
  });
  dom.bucketPanel.addEventListener("contextmenu", handleBucketContextMenu);

  dom.objectTbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".object-row");
    if (!row) return;
    if (target.closest(".row-check")) return;

    if (
      row.classList.contains("object-row--folder") &&
      !target.closest(".col-check")
    ) {
      const prefix = row.dataset.prefix;
      if (prefix !== undefined) {
        void navigateToFolder(prefix).catch((err) => {
          setStatus(`Failed to open folder: ${friendlyError(err)}`, 5000);
          logActivity(`Failed to open folder: ${friendlyError(err)}`, "error");
        });
      }
      return;
    }

    const key =
      row.dataset.key ??
      (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
    if (key) handleRowClick(key, e);
  });

  dom.objectTbody.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(
      ".row-check",
    );
    if (!input) return;
    const row = input.closest<HTMLElement>(".object-row");
    if (!row) return;
    const key =
      row.dataset.key ??
      (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
    if (!key) return;
    if (input.checked) {
      state.selectedKeys.add(key);
    } else {
      state.selectedKeys.delete(key);
    }
    setLastClickedKey(key);
    updateSelectionUI();
  });

  dom.objectTbody.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
    if (!row) return;
    if ((e.target as HTMLElement).closest(".row-check")) return;

    if (e.key === " ") {
      e.preventDefault();
      const key =
        row.dataset.key ??
        (row.dataset.prefix != null ? "prefix:" + row.dataset.prefix : null);
      if (!key) return;
      if (state.selectedKeys.has(key)) {
        state.selectedKeys.delete(key);
      } else {
        state.selectedKeys.add(key);
      }
      setLastClickedKey(key);
      updateSelectionUI();
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = Array.from(
        dom.objectTbody.querySelectorAll<HTMLElement>(".object-row"),
      );
      const currentIndex = rows.indexOf(row);
      const nextIndex =
        e.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1;
      rows[nextIndex]?.focus();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const rows = Array.from(
        dom.objectTbody.querySelectorAll<HTMLElement>(".object-row"),
      );
      (e.key === "Home" ? rows[0] : rows[rows.length - 1])?.focus();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (row.classList.contains("object-row--folder")) {
        const prefix = row.dataset.prefix;
        if (prefix !== undefined) {
          void navigateToFolder(prefix).catch((err) => {
            setStatus(`Failed to open folder: ${friendlyError(err)}`, 5000);
          });
        }
        return;
      }

      const key = row.dataset.key;
      if (!key) return;
      if (canPreview(basename(key))) {
        void openPreview(key);
      } else {
        void openInfoPanel([key]);
      }
    }
  });

  dom.objectTbody.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
    if (!row) return;
    if (row.classList.contains("object-row--folder")) {
      return;
    }
    const key = row.dataset.key;
    if (!key) return;
    if (canPreview(basename(key))) {
      void openPreview(key);
    } else {
      void openInfoPanel([key]);
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
        setStatus(`Failed to open folder: ${friendlyError(err)}`, 5000);
      });
    }
  });

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

  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "enter") {
      if (state.connected && state.currentBucket) {
        dropPath.textContent = `to /${state.currentBucket}/${state.currentPrefix}`;
        dropOverlay.hidden = false;
      }
      objectPanel.classList.add("object-panel--dragover");
    } else if (event.payload.type === "leave") {
      objectPanel.classList.remove("object-panel--dragover");
      dropOverlay.hidden = true;
    } else if (event.payload.type === "drop") {
      objectPanel.classList.remove("object-panel--dragover");
      dropOverlay.hidden = true;

      if (!state.connected || !state.currentBucket) {
        setStatus("Connect to a bucket first.");
        return;
      }

      const paths = event.payload.paths;
      if (paths.length > 0) {
        void queueDroppedPaths(paths, state.currentPrefix);
      } else {
        setStatus("No dropped files detected. Try Upload Files instead.", 5000);
      }
    }
  });

  setTransferCompleteHandler(async (summary) => {
    if (summary.hadUpload && state.connected && state.currentBucket) {
      const bucket = state.currentBucket;
      const prefix = state.currentPrefix;
      try {
        await refreshObjects(bucket, prefix);
        if (
          state.connected &&
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
    if (summary.downloadCount > 0) {
      parts.push(`${summary.downloadCount} downloaded`);
    }
    if (parts.length > 0) {
      showToast(`Transfer complete \u2014 ${parts.join(", ")}`, {
        type: "success",
      });
    } else if (summary.hadUpload || summary.hadDownload) {
      showToast("Transfer complete", { type: "success" });
    }
    if (summary.errorCount > 0) {
      const n = summary.errorCount;
      showToast(
        `${n} transfer${n === 1 ? "" : "s"} failed \u2014 see Activity log`,
        {
          type: "error",
        },
      );
    }
    if (summary.skippedCount > 0) {
      showToast(
        `${summary.skippedCount} transfer${summary.skippedCount === 1 ? "" : "s"} skipped`,
        { type: "warning" },
      );
    }
  });

  wireLayoutControls();
  wireInspectorControls();
  wireInspectorChrome();

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
      action: () => void handleCreateFolder(),
      available: () => state.connected,
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: "refresh-cw",
      shortcut: "F5",
      action: () => void handleRefresh(),
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
      action: () => void handleDelete(),
      available: () => state.connected && getSelectedFileKeys().length > 0,
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
      available: () => state.selectedKeys.size > 0,
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
        const keys = Array.from(state.selectedKeys);
        if (keys.length > 0) {
          void openInfoPanel(keys);
        }
      },
      available: () => state.connected && state.selectedKeys.size > 0,
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
  ]);

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

  let resizeTimeout: number | undefined;
  window.addEventListener("resize", () => {
    if (resizeTimeout) {
      window.clearTimeout(resizeTimeout);
    }
    resizeTimeout = window.setTimeout(async () => {
      state.currentSettings.windowWidth = window.innerWidth;
      state.currentSettings.windowHeight = window.innerHeight;
      try {
        await saveSettings();
      } catch (err) {
        console.warn("Failed to save window size settings:", err);
      }
    }, 500);
  });
}
