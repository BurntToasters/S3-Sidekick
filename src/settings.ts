import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { state } from "./state.ts";
import {
  type TransferPerformancePreset,
  type UserSettings,
  SETTING_DEFAULTS,
  parseSettingsRaw,
  mergeSettingsPayload,
} from "./settings-model.ts";
import {
  loadBookmarks,
  renderBookmarkList,
  removeBookmark,
  getBookmarks,
  exportBookmarksJson,
  importBookmarksJson,
  type Bookmark,
} from "./bookmarks.ts";
import { isUpdaterEnabled, setUpdateChannel } from "./updater.ts";
import { refreshSecuritySettingsUI } from "./security.ts";
import { showConfirm, showAlert } from "./dialogs.ts";

let onBookmarkSelect: ((b: Bookmark) => void) | null = null;

export function setBookmarkSelectHandler(handler: (b: Bookmark) => void): void {
  onBookmarkSelect = handler;
}

function applyPresetToTransferControls(
  preset: TransferPerformancePreset,
): void {
  const values =
    preset === "safe"
      ? {
          threshold: "256",
          downloadPartSize: "16",
          downloadConcurrency: "2",
          uploadPartSize: "16",
          uploadConcurrency: "2",
        }
      : preset === "max"
        ? {
            threshold: "64",
            downloadPartSize: "64",
            downloadConcurrency: "10",
            uploadPartSize: "64",
            uploadConcurrency: "10",
          }
        : {
            threshold: "128",
            downloadPartSize: "32",
            downloadConcurrency: "6",
            uploadPartSize: "32",
            uploadConcurrency: "6",
          };

  const threshold = document.getElementById(
    "setting-download-parallel-threshold-mb",
  ) as HTMLSelectElement | null;
  if (threshold) threshold.value = values.threshold;

  const downloadPartSize = document.getElementById(
    "setting-download-part-size-mb",
  ) as HTMLSelectElement | null;
  if (downloadPartSize) downloadPartSize.value = values.downloadPartSize;

  const downloadConcurrency = document.getElementById(
    "setting-download-part-concurrency",
  ) as HTMLSelectElement | null;
  if (downloadConcurrency)
    downloadConcurrency.value = values.downloadConcurrency;

  const uploadPartSize = document.getElementById(
    "setting-upload-part-size-mb",
  ) as HTMLSelectElement | null;
  if (uploadPartSize) uploadPartSize.value = values.uploadPartSize;

  const uploadConcurrency = document.getElementById(
    "setting-upload-part-concurrency",
  ) as HTMLSelectElement | null;
  if (uploadConcurrency) uploadConcurrency.value = values.uploadConcurrency;
}

export function applyTheme(theme: UserSettings["theme"]): void {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export async function loadSettings(): Promise<boolean> {
  const json = await invoke<string>("load_settings");
  const result = parseSettingsRaw(json);
  state.currentSettings = result.settings;
  state.lastPersistedSettings = { ...result.settings };
  state.settingsExtras = result.extras;
  applyTheme(state.currentSettings.theme);
  setUpdateChannel(state.currentSettings.updateChannel);
  return !result.malformed;
}

export async function saveSettings(): Promise<void> {
  const payload = mergeSettingsPayload(
    state.currentSettings,
    state.settingsExtras,
  );
  await invoke("save_settings", { json: payload });
  state.lastPersistedSettings = { ...state.currentSettings };
}

export function switchSettingsTab(tab: string): void {
  const tabs = document.querySelectorAll<HTMLElement>(".settings-tab");
  for (const t of tabs) {
    const isActive = t.dataset.settingsTab === tab;
    t.classList.toggle("settings-tab--active", isActive);
    t.setAttribute("aria-selected", String(isActive));
    t.setAttribute("tabindex", isActive ? "0" : "-1");
  }
  const panels = document.querySelectorAll<HTMLElement>(".settings-panel");
  for (const p of panels) {
    if (p.dataset.settingsPanel === "__search") {
      p.hidden = true;
      p.style.display = "none";
      continue;
    }
    const isActive = p.dataset.settingsPanel === tab;
    p.hidden = !isActive;
    p.style.display = isActive ? "" : "none";
  }
}

const searchOriginalParents = new Map<
  HTMLElement,
  { parent: HTMLElement; next: HTMLElement | null }
>();
let preSearchActiveTab: string | null = null;

function getActiveSettingsTab(): string | null {
  const active = document.querySelector<HTMLElement>(".settings-tab--active");
  return active?.dataset.settingsTab ?? null;
}

function restoreSearchItems(): void {
  for (const [item, { parent, next }] of searchOriginalParents) {
    if (next?.parentElement === parent) {
      parent.insertBefore(item, next);
    } else {
      parent.appendChild(item);
    }
  }
  searchOriginalParents.clear();
}

export function updateSettingsSearch(query: string): void {
  const searchPanel = document.querySelector<HTMLElement>(
    '[data-settings-panel="__search"]',
  );
  if (!searchPanel) return;

  restoreSearchItems();
  for (const g of Array.from(
    searchPanel.querySelectorAll<HTMLElement>(".settings-search-group"),
  )) {
    g.remove();
  }

  const trimmed = query.trim().toLowerCase();
  const empty = searchPanel.querySelector<HTMLElement>(
    ".settings-search-empty",
  );

  if (!trimmed) {
    if (empty) empty.hidden = true;
    if (preSearchActiveTab) {
      switchSettingsTab(preSearchActiveTab);
      preSearchActiveTab = null;
    }
    return;
  }

  preSearchActiveTab ??= getActiveSettingsTab() ?? "appearance";

  const allPanels = Array.from(
    document.querySelectorAll<HTMLElement>(".settings-panel"),
  ).filter((p) => p.dataset.settingsPanel !== "__search");

  let anyMatch = false;

  for (const panel of allPanels) {
    const tabName = panel.dataset.settingsPanel ?? "";
    const tabBtn = document.querySelector<HTMLElement>(
      `[data-settings-tab="${tabName}"]`,
    );
    // Intentional ||: fall back to tabName when the label is empty (""), not
    // just null/undefined, so ?? would be incorrect here.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const tabLabel = tabBtn?.textContent?.trim() || tabName;

    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(".setting-item"),
    );
    const matched: HTMLElement[] = [];
    for (const item of items) {
      const labelText = (item.textContent ?? "").toLowerCase();
      const tips = Array.from(
        item.querySelectorAll<HTMLElement>("[data-tooltip]"),
      )
        .map((b) => b.getAttribute("data-tooltip") ?? "")
        .join(" ")
        .toLowerCase();
      if (labelText.includes(trimmed) || tips.includes(trimmed)) {
        matched.push(item);
      }
    }
    if (matched.length === 0) continue;
    anyMatch = true;

    const group = document.createElement("div");
    group.className = "settings-search-group";
    const title = document.createElement("div");
    title.className = "settings-search-group-title";
    title.textContent = tabLabel;
    group.appendChild(title);

    for (const item of matched) {
      if (!searchOriginalParents.has(item) && item.parentElement) {
        searchOriginalParents.set(item, {
          parent: item.parentElement,
          next: item.nextElementSibling as HTMLElement | null,
        });
      }
      group.appendChild(item);
    }
    searchPanel.appendChild(group);
  }

  for (const panel of allPanels) {
    panel.hidden = true;
    panel.style.display = "none";
  }
  searchPanel.hidden = false;
  searchPanel.style.display = "";

  for (const t of Array.from(
    document.querySelectorAll<HTMLElement>(".settings-tab"),
  )) {
    t.classList.remove("settings-tab--active");
    t.setAttribute("aria-selected", "false");
  }

  if (empty) empty.hidden = anyMatch;
}

function initSettingsSearch(): void {
  const input = document.getElementById(
    "settings-search",
  ) as HTMLInputElement | null;
  if (!input || input.dataset.wired === "true") return;
  input.dataset.wired = "true";
  input.addEventListener("input", () => updateSettingsSearch(input.value));
}

function initAdvancedTransferToggle(): void {
  const toggle = document.getElementById(
    "transfers-advanced-toggle",
  ) as HTMLElement | null;
  const group = document.getElementById(
    "transfers-advanced",
  ) as HTMLElement | null;
  if (!toggle || !group || toggle.dataset.wired === "true") return;
  toggle.dataset.wired = "true";
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    toggle.setAttribute("aria-expanded", String(next));
    group.hidden = !next;
  });
}

function syncThemeCards(theme: UserSettings["theme"]): void {
  const cards = document.querySelectorAll<HTMLElement>(".theme-card");
  for (const card of cards) {
    card.classList.toggle(
      "theme-card--active",
      card.dataset.themeCard === theme,
    );
  }
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="theme"][value="${theme}"]`,
  );
  if (radio) radio.checked = true;
}

function initThemePicker(): void {
  const radios = document.querySelectorAll<HTMLInputElement>(
    'input[name="theme"]',
  );
  for (const r of radios) {
    if (r.dataset.wired === "true") continue;
    r.dataset.wired = "true";
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const value = r.value;
      if (value !== "system" && value !== "light" && value !== "dark") return;
      const hidden = document.getElementById(
        "setting-theme",
      ) as HTMLInputElement | null;
      if (hidden) hidden.value = value;
      syncThemeCards(value);
      applyTheme(value);
    });
  }
}

export function populateSettingsModal(): void {
  initThemePicker();
  const themeSelect = document.getElementById("setting-theme") as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  if (themeSelect) themeSelect.value = state.currentSettings.theme;
  syncThemeCards(state.currentSettings.theme);

  const updatesCheckbox = document.getElementById(
    "setting-updates",
  ) as HTMLInputElement | null;
  if (updatesCheckbox)
    updatesCheckbox.checked = state.currentSettings.autoCheckUpdates;

  const channelSelect = document.getElementById(
    "setting-update-channel",
  ) as HTMLSelectElement | null;
  if (channelSelect) {
    channelSelect.value = state.currentSettings.updateChannel;
  }

  const presignedSelect = document.getElementById(
    "setting-presigned-expiration",
  ) as HTMLSelectElement | null;
  if (presignedSelect) {
    presignedSelect.value = String(
      state.currentSettings.presignedUrlExpiration,
    );
  }

  const concurrentSelect = document.getElementById(
    "setting-max-concurrent",
  ) as HTMLSelectElement | null;
  if (concurrentSelect) {
    concurrentSelect.value = String(
      state.currentSettings.maxConcurrentTransfers,
    );
  }

  const retryAttemptsSelect = document.getElementById(
    "setting-transfer-retries",
  ) as HTMLSelectElement | null;
  if (retryAttemptsSelect) {
    retryAttemptsSelect.value = String(
      state.currentSettings.transferRetryAttempts,
    );
  }

  const retryBaseSelect = document.getElementById(
    "setting-transfer-retry-base-ms",
  ) as HTMLSelectElement | null;
  if (retryBaseSelect) {
    retryBaseSelect.value = String(state.currentSettings.transferRetryBaseMs);
  }

  const conflictPolicySelect = document.getElementById(
    "setting-conflict-policy",
  ) as HTMLSelectElement | null;
  if (conflictPolicySelect) {
    conflictPolicySelect.value = state.currentSettings.conflictPolicy;
  }

  const rememberDownloadCheckbox = document.getElementById(
    "setting-remember-download-path",
  ) as HTMLInputElement | null;
  if (rememberDownloadCheckbox) {
    rememberDownloadCheckbox.checked =
      state.currentSettings.rememberDownloadPath;
  }

  const presetSelect = document.getElementById(
    "setting-transfer-performance-preset",
  ) as HTMLSelectElement | null;
  if (presetSelect) {
    presetSelect.value = state.currentSettings.transferPerformancePreset;
    presetSelect.onchange = () => {
      const value = presetSelect.value as TransferPerformancePreset;
      if (value === "safe" || value === "balanced" || value === "max") {
        applyPresetToTransferControls(value);
      }
    };
  }

  const downloadThresholdSelect = document.getElementById(
    "setting-download-parallel-threshold-mb",
  ) as HTMLSelectElement | null;
  if (downloadThresholdSelect) {
    downloadThresholdSelect.value = String(
      state.currentSettings.downloadParallelThresholdMb,
    );
  }

  const downloadPartSizeSelect = document.getElementById(
    "setting-download-part-size-mb",
  ) as HTMLSelectElement | null;
  if (downloadPartSizeSelect) {
    downloadPartSizeSelect.value = String(
      state.currentSettings.downloadPartSizeMb,
    );
  }

  const downloadPartConcurrencySelect = document.getElementById(
    "setting-download-part-concurrency",
  ) as HTMLSelectElement | null;
  if (downloadPartConcurrencySelect) {
    downloadPartConcurrencySelect.value = String(
      state.currentSettings.downloadPartConcurrency,
    );
  }

  const uploadPartSizeSelect = document.getElementById(
    "setting-upload-part-size-mb",
  ) as HTMLSelectElement | null;
  if (uploadPartSizeSelect) {
    uploadPartSizeSelect.value = String(state.currentSettings.uploadPartSizeMb);
  }

  const uploadPartConcurrencySelect = document.getElementById(
    "setting-upload-part-concurrency",
  ) as HTMLSelectElement | null;
  if (uploadPartConcurrencySelect) {
    uploadPartConcurrencySelect.value = String(
      state.currentSettings.uploadPartConcurrency,
    );
  }

  const enableResumeCheckbox = document.getElementById(
    "setting-enable-transfer-resume",
  ) as HTMLInputElement | null;
  if (enableResumeCheckbox) {
    enableResumeCheckbox.checked = state.currentSettings.enableTransferResume;
  }

  const enableChecksumCheckbox = document.getElementById(
    "setting-enable-transfer-checksum-verification",
  ) as HTMLInputElement | null;
  if (enableChecksumCheckbox) {
    enableChecksumCheckbox.checked =
      state.currentSettings.enableTransferChecksumVerification;
  }

  const checkpointTtlSelect = document.getElementById(
    "setting-transfer-checkpoint-ttl-hours",
  ) as HTMLSelectElement | null;
  if (checkpointTtlSelect) {
    checkpointTtlSelect.value = String(
      state.currentSettings.transferCheckpointTtlHours,
    );
  }

  const bandwidthLimitSelect = document.getElementById(
    "setting-bandwidth-limit-mbps",
  ) as HTMLSelectElement | null;
  if (bandwidthLimitSelect) {
    bandwidthLimitSelect.value = String(
      state.currentSettings.bandwidthLimitMbps,
    );
  }

  const supported = isUpdaterEnabled();
  const updaterSection = document.getElementById("updater-section");
  const updaterUnsupported = document.getElementById("updater-unsupported");
  if (updaterSection) updaterSection.style.display = supported ? "" : "none";
  if (updaterUnsupported)
    updaterUnsupported.style.display = supported ? "none" : "";

  void refreshBookmarkListUI();
  void refreshSecuritySettingsUI();

  const versionEl = document.getElementById("settings-version");
  if (versionEl) {
    void getVersion().then((v) => {
      versionEl.textContent = `v${v}`;
    });
  }
  const platformEl = document.getElementById("settings-platform");
  if (platformEl) {
    const displayNames: Record<string, string> = {
      windows: "Windows",
      macos: "macOS",
      linux: "Linux",
    };
    platformEl.textContent =
      displayNames[state.platformName] ?? (state.platformName || "Unknown");
  }

  initSettingsSearch();
  initAdvancedTransferToggle();

  const searchInput = document.getElementById(
    "settings-search",
  ) as HTMLInputElement | null;
  if (searchInput) searchInput.value = "";
  updateSettingsSearch("");

  const advancedGroup = document.getElementById(
    "transfers-advanced",
  ) as HTMLElement | null;
  const advancedToggle = document.getElementById("transfers-advanced-toggle");
  if (advancedGroup) advancedGroup.hidden = true;
  if (advancedToggle) advancedToggle.setAttribute("aria-expanded", "false");

  switchSettingsTab("appearance");
}

export function readSettingsModal(): void {
  const themeRadio = document.querySelector<HTMLInputElement>(
    'input[name="theme"]:checked',
  );
  if (
    themeRadio &&
    (themeRadio.value === "system" ||
      themeRadio.value === "light" ||
      themeRadio.value === "dark")
  ) {
    state.currentSettings.theme = themeRadio.value;
  } else {
    const themeSelect = document.getElementById("setting-theme") as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (themeSelect) {
      state.currentSettings.theme = themeSelect.value as UserSettings["theme"];
    }
  }

  const updatesCheckbox = document.getElementById(
    "setting-updates",
  ) as HTMLInputElement | null;
  if (updatesCheckbox) {
    state.currentSettings.autoCheckUpdates = updatesCheckbox.checked;
  }

  const channelSelect = document.getElementById(
    "setting-update-channel",
  ) as HTMLSelectElement | null;
  if (channelSelect) {
    state.currentSettings.updateChannel =
      channelSelect.value === "beta" ? "beta" : "release";
    setUpdateChannel(state.currentSettings.updateChannel);
  }

  const presignedSelect = document.getElementById(
    "setting-presigned-expiration",
  ) as HTMLSelectElement | null;
  if (presignedSelect) {
    const val = parseInt(presignedSelect.value, 10);
    if (Number.isFinite(val) && val >= 60 && val <= 604800) {
      state.currentSettings.presignedUrlExpiration = val;
    }
  }

  const concurrentSelect = document.getElementById(
    "setting-max-concurrent",
  ) as HTMLSelectElement | null;
  if (concurrentSelect) {
    const val = parseInt(concurrentSelect.value, 10);
    if (Number.isInteger(val) && val >= 1 && val <= 10) {
      state.currentSettings.maxConcurrentTransfers = val;
    }
  }

  const retryAttemptsSelect = document.getElementById(
    "setting-transfer-retries",
  ) as HTMLSelectElement | null;
  if (retryAttemptsSelect) {
    const val = parseInt(retryAttemptsSelect.value, 10);
    if (Number.isInteger(val) && val >= 0 && val <= 10) {
      state.currentSettings.transferRetryAttempts = val;
    }
  }

  const retryBaseSelect = document.getElementById(
    "setting-transfer-retry-base-ms",
  ) as HTMLSelectElement | null;
  if (retryBaseSelect) {
    const val = parseInt(retryBaseSelect.value, 10);
    if (Number.isInteger(val) && val >= 50 && val <= 10000) {
      state.currentSettings.transferRetryBaseMs = val;
    }
  }

  const conflictPolicySelect = document.getElementById(
    "setting-conflict-policy",
  ) as HTMLSelectElement | null;
  if (conflictPolicySelect) {
    state.currentSettings.conflictPolicy =
      conflictPolicySelect.value === "replace"
        ? "replace"
        : conflictPolicySelect.value === "skip"
          ? "skip"
          : "ask";
  }

  const rememberDownloadCheckbox = document.getElementById(
    "setting-remember-download-path",
  ) as HTMLInputElement | null;
  if (rememberDownloadCheckbox) {
    state.currentSettings.rememberDownloadPath =
      rememberDownloadCheckbox.checked;
  }

  const presetSelect = document.getElementById(
    "setting-transfer-performance-preset",
  ) as HTMLSelectElement | null;
  if (presetSelect) {
    state.currentSettings.transferPerformancePreset =
      presetSelect.value === "safe"
        ? "safe"
        : presetSelect.value === "max"
          ? "max"
          : "balanced";
  }

  const downloadThresholdSelect = document.getElementById(
    "setting-download-parallel-threshold-mb",
  ) as HTMLSelectElement | null;
  if (downloadThresholdSelect) {
    const val = parseInt(downloadThresholdSelect.value, 10);
    if (Number.isInteger(val) && val >= 16 && val <= 10240) {
      state.currentSettings.downloadParallelThresholdMb = val;
    }
  }

  const downloadPartSizeSelect = document.getElementById(
    "setting-download-part-size-mb",
  ) as HTMLSelectElement | null;
  if (downloadPartSizeSelect) {
    const val = parseInt(downloadPartSizeSelect.value, 10);
    if (Number.isInteger(val) && val >= 16 && val <= 128) {
      state.currentSettings.downloadPartSizeMb = val;
    }
  }

  const downloadPartConcurrencySelect = document.getElementById(
    "setting-download-part-concurrency",
  ) as HTMLSelectElement | null;
  if (downloadPartConcurrencySelect) {
    const val = parseInt(downloadPartConcurrencySelect.value, 10);
    if (Number.isInteger(val) && val >= 1 && val <= 16) {
      state.currentSettings.downloadPartConcurrency = val;
    }
  }

  const uploadPartSizeSelect = document.getElementById(
    "setting-upload-part-size-mb",
  ) as HTMLSelectElement | null;
  if (uploadPartSizeSelect) {
    const val = parseInt(uploadPartSizeSelect.value, 10);
    if (Number.isInteger(val) && val >= 16 && val <= 128) {
      state.currentSettings.uploadPartSizeMb = val;
    }
  }

  const uploadPartConcurrencySelect = document.getElementById(
    "setting-upload-part-concurrency",
  ) as HTMLSelectElement | null;
  if (uploadPartConcurrencySelect) {
    const val = parseInt(uploadPartConcurrencySelect.value, 10);
    if (Number.isInteger(val) && val >= 1 && val <= 16) {
      state.currentSettings.uploadPartConcurrency = val;
    }
  }

  const enableResumeCheckbox = document.getElementById(
    "setting-enable-transfer-resume",
  ) as HTMLInputElement | null;
  if (enableResumeCheckbox) {
    state.currentSettings.enableTransferResume = enableResumeCheckbox.checked;
  }

  const enableChecksumCheckbox = document.getElementById(
    "setting-enable-transfer-checksum-verification",
  ) as HTMLInputElement | null;
  if (enableChecksumCheckbox) {
    state.currentSettings.enableTransferChecksumVerification =
      enableChecksumCheckbox.checked;
  }

  const checkpointTtlSelect = document.getElementById(
    "setting-transfer-checkpoint-ttl-hours",
  ) as HTMLSelectElement | null;
  if (checkpointTtlSelect) {
    const val = parseInt(checkpointTtlSelect.value, 10);
    if (Number.isInteger(val) && val >= 1 && val <= 720) {
      state.currentSettings.transferCheckpointTtlHours = val;
    }
  }

  const bandwidthLimitSelect = document.getElementById(
    "setting-bandwidth-limit-mbps",
  ) as HTMLSelectElement | null;
  if (bandwidthLimitSelect) {
    const val = parseInt(bandwidthLimitSelect.value, 10);
    if (Number.isInteger(val) && val >= 0 && val <= 10000) {
      state.currentSettings.bandwidthLimitMbps = val;
    }
  }
}

export function openSettingsModal(): void {
  populateSettingsModal();
  const overlay = document.getElementById("settings-overlay");
  if (overlay) overlay.classList.add("active");
}

export async function closeSettingsModal(save: boolean): Promise<void> {
  if (save) {
    readSettingsModal();
    applyTheme(state.currentSettings.theme);
    try {
      await saveSettings();
    } catch (err) {
      applyTheme(state.lastPersistedSettings.theme);
      state.currentSettings = { ...state.lastPersistedSettings };
      const statusEl = document.getElementById("status");
      if (statusEl)
        statusEl.textContent = `Failed to save settings: ${String(err)}`;
      return;
    }
  } else {
    applyTheme(state.lastPersistedSettings.theme);
    state.currentSettings = { ...state.lastPersistedSettings };
  }
  const overlay = document.getElementById("settings-overlay");
  if (overlay) overlay.classList.remove("active");
}

export async function resetSettings(): Promise<void> {
  const confirmed = await showConfirm(
    "Reset Settings",
    "This will reset settings to defaults and restart the app.\nChoose how much to reset on the next step.",
    { okLabel: "Continue", okDanger: true },
  );
  if (!confirmed) return;

  const fullReset = await showConfirm(
    "Reset Scope",
    "Keep your bookmarks, or factory reset everything?\n\nFactory reset removes all settings, bookmarks, saved connections, and encryption — a completely clean slate.",
    { okLabel: "Factory Reset", cancelLabel: "Keep Bookmarks", okDanger: true },
  );

  const extras = fullReset ? {} : { _setupComplete: true };
  const defaults = mergeSettingsPayload(SETTING_DEFAULTS, extras);
  try {
    await invoke("save_settings", { json: defaults });
  } catch {
    /* best effort */
  }
  try {
    await invoke("save_connection", { json: "" });
  } catch {
    /* best effort */
  }

  if (fullReset) {
    try {
      await invoke("save_bookmarks", { json: "[]" });
    } catch {
      /* vault may be locked; backup handles it */
    }
    try {
      await invoke("save_bookmarks_backup", { json: "[]" });
    } catch {
      /* best effort */
    }
    try {
      await invoke("reset_security");
    } catch {
      /* best effort */
    }
  }

  try {
    await relaunch();
  } catch {
    window.location.assign(window.location.href);
  }
}

export async function incrementLaunchCount(): Promise<number> {
  const current =
    typeof state.settingsExtras.launchCount === "number"
      ? state.settingsExtras.launchCount
      : 0;
  const next = current + 1;
  state.settingsExtras.launchCount = next;
  await saveSettings();
  return next;
}

export async function markSupportPromptDismissed(): Promise<void> {
  state.settingsExtras.supportPromptDismissed = true;
  await saveSettings();
}

export function isSupportPromptDismissed(): boolean {
  return state.settingsExtras.supportPromptDismissed === true;
}

let bookmarkImportExportWired = false;

async function refreshBookmarkListUI(): Promise<void> {
  await loadBookmarks();
  const listEl = document.getElementById("bookmark-list");
  if (!listEl) return;

  renderBookmarkList(
    listEl,
    (bookmark) => {
      if (onBookmarkSelect) onBookmarkSelect(bookmark);
      const overlay = document.getElementById("settings-overlay");
      if (overlay) overlay.classList.remove("active");
    },
    async (index) => {
      const b = getBookmarks()[index];
      const name = b?.name ?? "this bookmark";
      const confirmed = await showConfirm(
        "Delete Bookmark",
        `Delete bookmark "${name}"?`,
        { okLabel: "Delete", okDanger: true },
      );
      if (!confirmed) return;
      await removeBookmark(index);
      void refreshBookmarkListUI();
    },
  );

  if (!bookmarkImportExportWired) {
    bookmarkImportExportWired = true;
    wireBookmarkImportExport();
  }
}

function wireBookmarkImportExport(): void {
  const exportBtn = document.getElementById("bookmarks-export-btn");
  const importBtn = document.getElementById("bookmarks-import-btn");
  const importInput = document.getElementById(
    "bookmarks-import-input",
  ) as HTMLInputElement | null;

  exportBtn?.addEventListener("click", () => {
    const json = exportBookmarksJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "s3-sidekick-bookmarks.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn?.addEventListener("click", () => {
    importInput?.click();
  });

  importInput?.addEventListener("change", () => {
    const file = importInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      void importBookmarksJson(text).then((result) => {
        importInput.value = "";
        if (result.error) {
          void showAlert("Import Failed", result.error);
        } else {
          const msg =
            `Imported ${result.imported} bookmark(s)` +
            (result.skipped > 0
              ? `, skipped ${result.skipped} duplicate(s)`
              : "") +
            ".";
          void showAlert("Import Complete", msg);
          void refreshBookmarkListUI();
        }
      });
    };
    reader.readAsText(file);
  });
}
