import { invoke } from "./ipc.ts";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { save } from "@tauri-apps/plugin-dialog";
import { state } from "./state.ts";
import {
  type DateFormat,
  type Density,
  type SizeUnits,
  type TransferPerformancePreset,
  type UserSettings,
  DATE_FORMAT_VALUES,
  DENSITY_VALUES,
  SETTING_DEFAULTS,
  SIZE_UNIT_VALUES,
  parseSettingsRaw,
  mergeSettingsPayload,
} from "./settings-model.ts";
import {
  loadBookmarks,
  renderBookmarkList,
  removeBookmark,
  exportBookmarksJson,
  importBookmarksJson,
  updateBookmark,
  MAX_IMPORT_BYTES,
  type Bookmark,
  type BookmarkImportResult,
  type BookmarkPatch,
} from "./bookmarks.ts";
import { isUpdaterEnabled, setUpdateChannel } from "./updater.ts";
import { refreshSecuritySettingsUI } from "./security.ts";
import {
  showConfirm,
  showConfirmWithCheckbox,
  showAlert,
  showChoiceDialog,
} from "./dialogs.ts";
import {
  friendlyError,
  getFormatPreferences,
  plural,
  setFormatPreferences,
} from "./utils.ts";
import { renderObjectTableFromLayout } from "./layout-render-bridge.ts";

let onBookmarkSelect: ((b: Bookmark) => void) | null = null;
let settingsSaveTail: Promise<void> = Promise.resolve();
let settingsModalSaveOperation: Promise<void> | null = null;

/**
 * Tabs with no explicit-save settings: their controls apply at once or carry
 * their own buttons. Save is shown only for other tabs or dirty drafts.
 */
const NO_SAVE_TABS = new Set(["security", "bookmarks", "about", "reset"]);

/** Set by the last search: whether a result row needs the explicit Save. */
let searchShowsExplicitSave = false;

function isExplicitSaveTab(tab: string): boolean {
  return !NO_SAVE_TABS.has(tab);
}

const PRESET_CONTROL_IDS = {
  threshold: "setting-download-parallel-threshold-mb",
  downloadPartSize: "setting-download-part-size-mb",
  downloadConcurrency: "setting-download-part-concurrency",
  uploadPartSize: "setting-upload-part-size-mb",
  uploadConcurrency: "setting-upload-part-concurrency",
} as const;

type PresetControl = keyof typeof PRESET_CONTROL_IDS;

const PRESET_VALUES: Record<
  TransferPerformancePreset,
  Record<PresetControl, string>
> = {
  safe: {
    threshold: "256",
    downloadPartSize: "16",
    downloadConcurrency: "2",
    uploadPartSize: "16",
    uploadConcurrency: "2",
  },
  max: {
    threshold: "64",
    downloadPartSize: "64",
    downloadConcurrency: "10",
    uploadPartSize: "64",
    uploadConcurrency: "10",
  },
  balanced: {
    threshold: "128",
    downloadPartSize: "32",
    downloadConcurrency: "6",
    uploadPartSize: "32",
    uploadConcurrency: "6",
  },
};

function isTransferPreset(value: string): value is TransferPerformancePreset {
  return value === "safe" || value === "balanced" || value === "max";
}

function presetControl(key: PresetControl): HTMLSelectElement | null {
  return document.getElementById(
    PRESET_CONTROL_IDS[key],
  ) as HTMLSelectElement | null;
}

export function setBookmarkSelectHandler(handler: (b: Bookmark) => void): void {
  onBookmarkSelect = handler;
}

function applyPresetToTransferControls(
  preset: TransferPerformancePreset,
): void {
  const values = PRESET_VALUES[preset];
  for (const key of Object.keys(PRESET_CONTROL_IDS) as PresetControl[]) {
    const control = presetControl(key);
    if (control) control.value = values[key];
  }
}

/** "Custom" replaces the preset name once an Advanced value leaves its values. */
function syncPresetWithControls(): void {
  const select = document.getElementById(
    "setting-transfer-performance-preset",
  ) as HTMLSelectElement | null;
  if (!select || !isTransferPreset(select.value)) return;
  const values = PRESET_VALUES[select.value];
  const matches = (Object.keys(PRESET_CONTROL_IDS) as PresetControl[]).every(
    (key) => {
      const control = presetControl(key);
      return !control || control.value === values[key];
    },
  );
  if (!matches) select.value = "custom";
}

function initPresetSync(): void {
  for (const key of Object.keys(PRESET_CONTROL_IDS) as PresetControl[]) {
    const control = presetControl(key);
    if (!control || control.dataset.presetWired === "true") continue;
    control.dataset.presetWired = "true";
    control.addEventListener("change", () => syncPresetWithControls());
  }
}

export function applyTheme(theme: UserSettings["theme"]): void {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

/** Re-renders the object table only when a size or date style actually changed. */
function applyFormatPreferences(
  sizeUnits: SizeUnits,
  dateFormat: DateFormat,
): void {
  const before = getFormatPreferences();
  setFormatPreferences({ sizeUnits, dateFormat });
  if (before.sizeUnits !== sizeUnits || before.dateFormat !== dateFormat) {
    renderObjectTableFromLayout();
  }
}

/**
 * Appearance applies at once, the way the theme always has. Cancel reverts it
 * because it is applied again from the last saved values.
 */
function applyAppearance(
  settings: Pick<
    UserSettings,
    "theme" | "density" | "sizeUnits" | "dateFormat"
  >,
): void {
  applyTheme(settings.theme);
  applyDensity(settings.density);
  applyFormatPreferences(settings.sizeUnits, settings.dateFormat);
}

/**
 * Reads a choice control. A missing control keeps the current value; an
 * unknown value keeps it too, so a stray DOM value never reaches the settings.
 */
function readChoice<T extends string>(
  id: string,
  values: readonly T[],
  current: T,
): T {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (!el) return current;
  return values.find((value) => value === el.value) ?? current;
}

function readAppearanceDraft(): Pick<
  UserSettings,
  "density" | "sizeUnits" | "dateFormat"
> {
  return {
    density: readChoice(
      "setting-density",
      DENSITY_VALUES,
      state.currentSettings.density,
    ),
    sizeUnits: readChoice(
      "setting-size-units",
      SIZE_UNIT_VALUES,
      state.currentSettings.sizeUnits,
    ),
    dateFormat: readChoice(
      "setting-date-format",
      DATE_FORMAT_VALUES,
      state.currentSettings.dateFormat,
    ),
  };
}

function initAppearancePreview(): void {
  for (const id of [
    "setting-density",
    "setting-size-units",
    "setting-date-format",
  ]) {
    const control = document.getElementById(id);
    if (!control || control.dataset.wired === "true") continue;
    control.dataset.wired = "true";
    control.addEventListener("change", () => {
      const draft = readAppearanceDraft();
      applyDensity(draft.density);
      applyFormatPreferences(draft.sizeUnits, draft.dateFormat);
    });
  }
}

export async function loadSettings(): Promise<boolean> {
  const json = await invoke<string>("load_settings");
  const result = parseSettingsRaw(json);
  state.currentSettings = result.settings;
  state.lastPersistedSettings = { ...result.settings };
  state.settingsExtras = result.extras;
  applyAppearance(state.currentSettings);
  setUpdateChannel(state.currentSettings.updateChannel);
  return !result.malformed;
}

function clampWindowSize(settingsSnapshot: UserSettings): void {
  // Clamp pre-save so a corrupt in-memory size never persists an
  // off-screen/unusable window. Bounds match settings-model validation.
  if (
    !Number.isInteger(settingsSnapshot.windowWidth) ||
    settingsSnapshot.windowWidth < 400 ||
    settingsSnapshot.windowWidth > 10000
  ) {
    settingsSnapshot.windowWidth = SETTING_DEFAULTS.windowWidth;
  }
  if (
    !Number.isInteger(settingsSnapshot.windowHeight) ||
    settingsSnapshot.windowHeight < 300 ||
    settingsSnapshot.windowHeight > 10000
  ) {
    settingsSnapshot.windowHeight = SETTING_DEFAULTS.windowHeight;
  }
}

function enqueueSettingsSnapshot(
  settingsSnapshot: UserSettings,
  extrasSnapshot: typeof state.settingsExtras,
): Promise<void> {
  clampWindowSize(settingsSnapshot);
  const payload = mergeSettingsPayload(settingsSnapshot, extrasSnapshot);
  const persistSnapshot = async () => {
    await invoke("save_settings", { json: payload });
    state.lastPersistedSettings = { ...settingsSnapshot };
  };
  const result = settingsSaveTail.then(persistSnapshot);
  settingsSaveTail = result.catch(() => undefined);
  return result;
}

export function saveSettings(): Promise<void> {
  if (settingsModalSaveOperation) {
    return settingsModalSaveOperation.then(() => saveSettings());
  }
  return enqueueSettingsSnapshot(
    { ...state.currentSettings },
    { ...state.settingsExtras },
  );
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
  updateSettingsFooter();
}

/**
 * Save and Cancel show when an explicit-save setting is on screen (its tab, or
 * a search result) or when the draft differs from the saved values. They do
 * not depend on which tab was opened first.
 */
export function updateSettingsFooter(): void {
  const footer = document.querySelector<HTMLElement>(
    "#settings-overlay .modal__footer",
  );
  if (!footer) return;
  const searchPanel = document.querySelector<HTMLElement>(
    '[data-settings-panel="__search"]',
  );
  const searching = searchPanel !== null && !searchPanel.hidden;
  const activeTab = getActiveSettingsTab();
  const explicitVisible = searching
    ? searchShowsExplicitSave
    : activeTab !== null && isExplicitSaveTab(activeTab);
  footer.hidden = !(explicitVisible || hasUnsavedSettingsChanges());
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

/**
 * What a row is searched by: its label, its description text, and its section
 * heading. Option text is left out, so "default" finds no row by itself.
 */
const SEARCH_DESCRIPTION_SELECTOR = ".setting-description, .setting-note";
const SEARCH_SKIP_SELECTOR = `select, option, button, input, textarea, .setting-section, ${SEARCH_DESCRIPTION_SELECTOR}`;

function searchableText(item: HTMLElement): {
  label: string;
  description: string;
  heading: string;
} {
  const labelOnly = item.cloneNode(true) as HTMLElement;
  for (const el of labelOnly.querySelectorAll(SEARCH_SKIP_SELECTOR)) {
    el.remove();
  }
  const description = Array.from(
    item.querySelectorAll<HTMLElement>(SEARCH_DESCRIPTION_SELECTOR),
  )
    .map((el) => el.textContent ?? "")
    .join(" ");
  const heading =
    item
      .closest<HTMLElement>(".settings-group")
      ?.querySelector<HTMLElement>(".setting-section")?.textContent ?? "";
  return {
    label: (labelOnly.textContent ?? "").toLowerCase(),
    description: description.toLowerCase(),
    heading: heading.toLowerCase(),
  };
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
    const restoreTab = preSearchActiveTab;
    preSearchActiveTab = null;
    searchShowsExplicitSave = false;
    if (restoreTab) switchSettingsTab(restoreTab);
    updateSettingsFooter();
    return;
  }

  preSearchActiveTab ??= getActiveSettingsTab() ?? "appearance";

  const allPanels = Array.from(
    document.querySelectorAll<HTMLElement>(".settings-panel"),
  ).filter((p) => p.dataset.settingsPanel !== "__search");

  let anyMatch = false;
  let explicitMatch = false;

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
      const text = searchableText(item);
      if (
        text.label.includes(trimmed) ||
        text.description.includes(trimmed) ||
        text.heading.includes(trimmed)
      ) {
        matched.push(item);
      }
    }
    if (matched.length === 0) continue;
    anyMatch = true;
    if (isExplicitSaveTab(tabName)) explicitMatch = true;

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
  searchShowsExplicitSave = explicitMatch;
  updateSettingsFooter();
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
      syncThemeCards(value);
      applyTheme(value);
    });
  }
}

export function populateSettingsModal(): void {
  initThemePicker();
  syncThemeCards(state.currentSettings.theme);

  const densitySelect = document.getElementById(
    "setting-density",
  ) as HTMLSelectElement | null;
  if (densitySelect) densitySelect.value = state.currentSettings.density;

  const sizeUnitsSelect = document.getElementById(
    "setting-size-units",
  ) as HTMLSelectElement | null;
  if (sizeUnitsSelect) sizeUnitsSelect.value = state.currentSettings.sizeUnits;

  const dateFormatSelect = document.getElementById(
    "setting-date-format",
  ) as HTMLSelectElement | null;
  if (dateFormatSelect)
    dateFormatSelect.value = state.currentSettings.dateFormat;

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

  const openTransferDrawerCheckbox = document.getElementById(
    "setting-open-transfer-drawer",
  ) as HTMLInputElement | null;
  if (openTransferDrawerCheckbox) {
    openTransferDrawerCheckbox.checked =
      state.currentSettings.openTransferDrawerOnStart;
  }

  const confirmUnguardedWritesCheckbox = document.getElementById(
    "setting-confirm-unguarded-writes",
  ) as HTMLInputElement | null;
  if (confirmUnguardedWritesCheckbox) {
    confirmUnguardedWritesCheckbox.checked =
      state.currentSettings.confirmUnguardedWrites;
  }

  const desktopNotificationsCheckbox = document.getElementById(
    "setting-desktop-notifications",
  ) as HTMLInputElement | null;
  if (desktopNotificationsCheckbox) {
    desktopNotificationsCheckbox.checked =
      state.currentSettings.desktopNotifications;
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

  // Package-manager installs keep the auto-check toggle, Check now and the
  // release-page button; only the in-app install is replaced by that note.
  const supported = isUpdaterEnabled();
  const updaterUnsupported = document.getElementById("updater-unsupported");
  if (updaterUnsupported)
    updaterUnsupported.style.display = supported ? "none" : "";
  const updateStatus = document.getElementById("settings-update-status");
  if (updateStatus) updateStatus.textContent = "";

  void refreshBookmarkListUI();
  void refreshSecuritySettingsUI();

  const versionEl = document.getElementById("settings-version");
  if (versionEl) {
    void getVersion()
      .then((v) => {
        versionEl.textContent = `v${v}`;
      })
      .catch(() => {
        versionEl.textContent = "";
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
  initPresetSync();
  syncPresetWithControls();
  initAppearancePreview();

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
  }

  Object.assign(state.currentSettings, readAppearanceDraft());

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

  const openTransferDrawerCheckbox = document.getElementById(
    "setting-open-transfer-drawer",
  ) as HTMLInputElement | null;
  if (openTransferDrawerCheckbox) {
    state.currentSettings.openTransferDrawerOnStart =
      openTransferDrawerCheckbox.checked;
  }

  const confirmUnguardedWritesCheckbox = document.getElementById(
    "setting-confirm-unguarded-writes",
  ) as HTMLInputElement | null;
  if (confirmUnguardedWritesCheckbox) {
    state.currentSettings.confirmUnguardedWrites =
      confirmUnguardedWritesCheckbox.checked;
  }

  const desktopNotificationsCheckbox = document.getElementById(
    "setting-desktop-notifications",
  ) as HTMLInputElement | null;
  if (desktopNotificationsCheckbox) {
    state.currentSettings.desktopNotifications =
      desktopNotificationsCheckbox.checked;
  }

  const presetSelect = document.getElementById(
    "setting-transfer-performance-preset",
  ) as HTMLSelectElement | null;
  // "Custom" is only a display state: the saved preset name stays as it was.
  if (presetSelect && presetSelect.value !== "custom") {
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
  hideBookmarkEdit();
  populateSettingsModal();
  const overlay = document.getElementById("settings-overlay");
  if (overlay) overlay.classList.add("active");
}

function setSettingsSaveBusy(busy: boolean): void {
  const button = document.getElementById(
    "settings-save",
  ) as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? "Saving\u2026" : "Save";
}

function settingsMatchSnapshotExceptWindowSize(
  snapshot: UserSettings,
): boolean {
  const current = { ...state.currentSettings };
  current.windowWidth = snapshot.windowWidth;
  current.windowHeight = snapshot.windowHeight;
  return JSON.stringify(current) === JSON.stringify(snapshot);
}

async function saveAndCloseSettingsModal(): Promise<void> {
  readSettingsModal();
  setUpdateChannel(state.currentSettings.updateChannel);
  const attemptedSettings = { ...state.currentSettings };
  const attemptedExtras = { ...state.settingsExtras };
  applyAppearance(attemptedSettings);
  setSettingsSaveBusy(true);
  try {
    await enqueueSettingsSnapshot(attemptedSettings, attemptedExtras);
  } catch (err) {
    if (settingsMatchSnapshotExceptWindowSize(attemptedSettings)) {
      const latestWindowWidth = state.currentSettings.windowWidth;
      const latestWindowHeight = state.currentSettings.windowHeight;
      const rollback = {
        ...state.lastPersistedSettings,
        windowWidth: latestWindowWidth,
        windowHeight: latestWindowHeight,
      };
      applyAppearance(rollback);
      state.currentSettings = rollback;
      setUpdateChannel(rollback.updateChannel);
    }
    const statusEl = document.getElementById("status");
    if (statusEl)
      statusEl.textContent = `Settings were not saved. ${friendlyError(err)}`;
    // The modal overlay makes #status inert, so the failure must be visible
    // inside the modal (and the draft must stay open so nothing is lost).
    const errorEl = document.getElementById("settings-save-error");
    if (errorEl) {
      errorEl.textContent = `Settings were not saved. ${friendlyError(err)}`;
      errorEl.hidden = false;
    }
    return;
  }
  const errorEl = document.getElementById("settings-save-error");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }
  document.getElementById("settings-overlay")?.classList.remove("active");
}

/**
 * True when the Settings form differs from the last saved values. Reads the
 * form without leaving the draft in state, so callers can ask at any time.
 * Security and bookmark changes apply immediately and are not part of this.
 */
export function hasUnsavedSettingsChanges(): boolean {
  const saved = state.lastPersistedSettings;
  const before = { ...state.currentSettings };
  readSettingsModal();
  const draft = state.currentSettings;
  state.currentSettings = before;
  const keys = Object.keys(draft) as (keyof UserSettings)[];
  return keys.some(
    (key) =>
      key !== "windowWidth" &&
      key !== "windowHeight" &&
      draft[key] !== saved[key],
  );
}

function settingsIsOpen(): boolean {
  return (
    document
      .getElementById("settings-overlay")
      ?.classList.contains("active") === true
  );
}

let discardPromptOpen = false;

async function discardSettingsDraft(): Promise<void> {
  if (discardPromptOpen) return;
  if (hasUnsavedSettingsChanges()) {
    discardPromptOpen = true;
    let choice: "save" | "discard" | "keep";
    try {
      choice = await showChoiceDialog<"save" | "discard" | "keep">(
        "Discard changes?",
        "Your Settings changes have not been saved.",
        [
          { value: "save", label: "Save" },
          { value: "discard", label: "Discard changes", danger: true },
          { value: "keep", label: "Keep editing" },
        ],
        { cancelValue: "keep" },
      );
    } finally {
      discardPromptOpen = false;
    }
    if (choice === "save") {
      await closeSettingsModal(true);
      return;
    }
    if (choice !== "discard") return;
  }
  applyAppearance(state.lastPersistedSettings);
  state.currentSettings = { ...state.lastPersistedSettings };
  setUpdateChannel(state.lastPersistedSettings.updateChannel);
  document.getElementById("settings-overlay")?.classList.remove("active");
}

export function closeSettingsModal(save: boolean): Promise<void> {
  if (settingsModalSaveOperation) return settingsModalSaveOperation;
  if (!save) return discardSettingsDraft();

  const operation = saveAndCloseSettingsModal().finally(() => {
    if (settingsModalSaveOperation === operation) {
      settingsModalSaveOperation = null;
      setSettingsSaveBusy(false);
    }
  });
  settingsModalSaveOperation = operation;
  return operation;
}

/**
 * The ", skipped ..." clause for an import result. Duplicates and invalid
 * entries are reported separately; `skipped` is only the fallback when neither
 * count is provided.
 */
function importSkippedClause(result: BookmarkImportResult): string {
  const parts: string[] = [];
  if (result.duplicates !== undefined || result.invalid !== undefined) {
    const duplicates = result.duplicates ?? 0;
    const invalid = result.invalid ?? 0;
    if (duplicates > 0) parts.push(plural(duplicates, "duplicate"));
    if (invalid > 0) {
      parts.push(plural(invalid, "invalid entry", "invalid entries"));
    }
  } else if (result.skipped > 0) {
    parts.push(plural(result.skipped, "duplicate"));
  }
  return parts.length > 0 ? `, skipped ${parts.join(" and ")}` : "";
}

export async function resetSettings(): Promise<void> {
  const confirmed = await showConfirm(
    "Reset Settings",
    "This will reset settings to defaults and restart the app.\nChoose how much to reset on the next step.",
    { okLabel: "Continue", okDanger: true },
  );
  if (!confirmed) return;

  // Escape and the default focus both mean Cancel: only an explicit choice
  // runs a reset.
  const scope = await showChoiceDialog<"partial" | "factory" | "cancel">(
    "Reset Scope",
    "Choose what to reset. The app restarts afterwards.\n\nKeep saved connections: resets settings, clears the last-used connection, and interrupts running transfers. Saved connections and encryption stay.\n\nFactory reset: also deletes saved connections, transfer recovery data, and encryption.",
    [
      { value: "partial", label: "Keep saved connections" },
      { value: "factory", label: "Factory reset", danger: true },
      { value: "cancel", label: "Cancel" },
    ],
    { cancelValue: "cancel" },
  );
  if (scope === "cancel") return;

  if (scope === "factory") {
    if (!(await confirmFactoryReset())) return;
    if (!(await runFactoryReset())) return;
  } else {
    if (!(await runPartialReset())) return;
  }

  await relaunchApp();
}

/**
 * "Forgot password?" on the Unlock prompt. A lost password cannot unlock the
 * vault, so the only recovery is erasing it. Keeps the explicit final
 * confirmation of a factory reset.
 */
export async function resetAfterForgottenPassword(): Promise<void> {
  const confirmed = await showConfirm(
    "Erase the Encrypted Vault?",
    "A forgotten password can't be recovered. Continuing erases the encrypted vault and all saved connections inside it, including their saved secret keys. The last-used connection, transfer checkpoints and partial downloads are erased too. Running transfers are stopped. Settings return to their starting values and the app restarts.",
    { okLabel: "Continue", okDanger: true },
  );
  if (!confirmed) return;
  if (!(await confirmFactoryReset())) return;
  if (!(await runFactoryReset())) return;
  await relaunchApp();
}

async function confirmFactoryReset(): Promise<boolean> {
  return showConfirm(
    "Permanently Delete All App Data?",
    "This permanently deletes saved connections, the last-used connection, encrypted storage, transfer checkpoints, and partial download files. Running transfers will be stopped. This cannot be undone.",
    {
      okLabel: "Delete Everything",
      cancelLabel: "Cancel Reset",
      okDanger: true,
    },
  );
}

/** The backend transaction is the commit point. Returns false after alerting. */
async function runFactoryReset(): Promise<boolean> {
  const defaults = mergeSettingsPayload(SETTING_DEFAULTS, {});
  try {
    await invoke("factory_reset", { settingsJson: defaults });
  } catch (err) {
    await showAlert("Factory Reset Failed", friendlyError(err));
    return false;
  }

  // Browser storage cleanup is best-effort only: a disabled/unavailable
  // localStorage implementation must not misreport a completed destructive
  // reset as failed or suppress relaunch.
  try {
    localStorage.clear();
  } catch {
    // Reads will generally be unavailable under the same policy; the backend
    // remains authoritative and the relaunch below must still happen.
  }
  return true;
}

/**
 * Settings go to defaults but engagement extras survive so launchCount and
 * support prompts do not re-fire after a routine reset. Returns false after
 * alerting.
 */
async function runPartialReset(): Promise<boolean> {
  const { launchCount, supportPromptDismissed, transfersHintDismissed } =
    state.settingsExtras as {
      launchCount?: unknown;
      supportPromptDismissed?: unknown;
      transfersHintDismissed?: unknown;
    };
  const carriedExtras: Record<string, unknown> = {
    _setupComplete: true,
  };
  if (typeof launchCount === "number") carriedExtras.launchCount = launchCount;
  if (typeof supportPromptDismissed === "boolean")
    carriedExtras.supportPromptDismissed = supportPromptDismissed;
  if (typeof transfersHintDismissed === "boolean")
    carriedExtras.transfersHintDismissed = transfersHintDismissed;
  const defaults = mergeSettingsPayload(SETTING_DEFAULTS, carriedExtras);
  try {
    // Credentials first: if clearing them fails, nothing is reset and the
    // user is not left with default settings but surviving credentials.
    await invoke("clear_saved_connection");
    await invoke("save_settings", { json: defaults });
  } catch (err) {
    await showAlert("Reset Failed", friendlyError(err));
    return false;
  }
  return true;
}

async function relaunchApp(): Promise<void> {
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

export function isTransfersHintDismissed(): boolean {
  return state.settingsExtras.transfersHintDismissed === true;
}

export async function markTransfersHintDismissed(): Promise<void> {
  state.settingsExtras.transfersHintDismissed = true;
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
      // Same close path as Cancel: unsaved edits are asked about, and a
      // previewed theme is reverted before the connection starts.
      void closeSettingsModal(false).then(() => {
        if (!settingsIsOpen() && onBookmarkSelect) onBookmarkSelect(bookmark);
      });
    },
    async (bookmark) => {
      const confirmed = await showConfirm(
        "Delete saved connection",
        `Delete saved connection "${bookmark.name}"?`,
        { okLabel: "Delete", okDanger: true },
      );
      if (!confirmed) return;
      try {
        await removeBookmark(bookmark);
      } catch (err) {
        void showAlert("Delete Failed", friendlyError(err));
        return;
      }
      void refreshBookmarkListUI();
    },
    { onEdit: (bookmark) => editSavedConnection(bookmark) },
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
    void exportBookmarksToFile().catch((err: unknown) => {
      void showAlert("Export Failed", friendlyError(err));
    });
  });

  importBtn?.addEventListener("click", () => {
    importInput?.click();
  });

  importInput?.addEventListener("change", () => {
    const file = importInput.files?.[0];
    if (!file) return;
    // Reset now so choosing the same file again fires "change" again.
    importInput.value = "";
    if (file.size > MAX_IMPORT_BYTES) {
      void showAlert(
        "Import Failed",
        "The saved connections file is too large.",
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      void showAlert(
        "Import Failed",
        `Could not read "${file.name}": ${reader.error?.message ?? "unknown error"}`,
      );
    };
    reader.onabort = () => {
      void showAlert("Import Failed", `Reading "${file.name}" was aborted.`);
    };
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      void importBookmarksJson(text)
        .then((result) => {
          if (result.error) {
            void showAlert("Import Failed", result.error);
            return;
          }
          const msg =
            `Imported ${plural(result.imported, "saved connection")}` +
            importSkippedClause(result) +
            ".";
          void showAlert("Import Complete", msg);
          void refreshBookmarkListUI();
        })
        .catch((err: unknown) => {
          void showAlert("Import Failed", friendlyError(err));
        });
    };
    reader.readAsText(file);
  });
}

/// Export through a native save dialog. A browser download would drop the
/// file (possibly with plaintext secrets) in the default Downloads folder
/// without letting the user choose where it goes.
async function exportBookmarksToFile(): Promise<void> {
  const choice = await showConfirmWithCheckbox(
    "Export saved connections",
    "Save your saved connections to a JSON file. Secret keys are left out unless you tick the box below.",
    {
      okLabel: "Export",
      cancelLabel: "Cancel",
      checkboxLabel: "Include secret keys (written as plain text)",
    },
  );
  if (!choice.confirmed) return;
  const includeSecrets = choice.checked;
  const path = await save({
    title: includeSecrets
      ? "Save saved connections (includes secret keys)"
      : "Save saved connections",
    defaultPath: "s3-sidekick-bookmarks.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  await invoke("write_text_file", {
    path,
    text: exportBookmarksJson(includeSecrets),
    // The save dialog already asked before replacing an existing file.
    overwrite: true,
  });
  const statusEl = document.getElementById("bookmarks-status");
  if (statusEl) {
    statusEl.textContent = `Exported saved connections${includeSecrets ? " with secret keys" : ""}.`;
  }
}

/** The saved connection whose edit form is open, or null when none is. */
let editingBookmark: Bookmark | null = null;
let bookmarkEditSaving = false;

type BookmarkEditField =
  "name" | "endpoint" | "region" | "accessKey" | "secretKey" | "sessionToken";

const BOOKMARK_EDIT_FIELD_IDS: Record<BookmarkEditField, string> = {
  name: "bookmark-edit-name",
  endpoint: "bookmark-edit-endpoint",
  region: "bookmark-edit-region",
  accessKey: "bookmark-edit-access-key",
  secretKey: "bookmark-edit-secret-key",
  sessionToken: "bookmark-edit-session-token",
};

function bookmarkEditField(field: BookmarkEditField): HTMLInputElement | null {
  return document.getElementById(
    BOOKMARK_EDIT_FIELD_IDS[field],
  ) as HTMLInputElement | null;
}

function setBookmarkEditError(message: string | null): void {
  const el = document.getElementById("bookmark-edit-error");
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}

function setBookmarkEditBusy(busy: boolean): void {
  const button = document.getElementById(
    "bookmark-edit-save",
  ) as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? "Saving\u2026" : "Save";
}

/** Close the edit form and clear every field, so no secret stays in the DOM. */
function hideBookmarkEdit(): void {
  editingBookmark = null;
  setBookmarkEditError(null);
  for (const field of Object.keys(
    BOOKMARK_EDIT_FIELD_IDS,
  ) as BookmarkEditField[]) {
    const input = bookmarkEditField(field);
    if (input) input.value = "";
  }
  const form = document.getElementById("bookmark-edit");
  if (form) form.hidden = true;
}

function showBookmarkEdit(bookmark: Bookmark): void {
  editingBookmark = bookmark;
  setBookmarkEditError(null);
  const values: Record<BookmarkEditField, string> = {
    name: bookmark.name,
    endpoint: bookmark.endpoint,
    region: bookmark.region,
    accessKey: bookmark.access_key,
    // Secrets are never shown; blank means keep the stored value.
    secretKey: "",
    sessionToken: "",
  };
  for (const field of Object.keys(values) as BookmarkEditField[]) {
    const input = bookmarkEditField(field);
    if (input) input.value = values[field];
  }
  const sessionInput = bookmarkEditField("sessionToken");
  if (sessionInput) {
    sessionInput.placeholder = bookmark.session_token
      ? "Leave blank to keep the current session token"
      : "Optional";
  }
  const form = document.getElementById("bookmark-edit");
  if (form) form.hidden = false;
  bookmarkEditField("name")?.focus();
}

function setBookmarkStatus(message: string): void {
  const el = document.getElementById("bookmarks-status");
  if (el) el.textContent = message;
}

async function saveBookmarkEdit(): Promise<void> {
  const target = editingBookmark;
  if (!target || bookmarkEditSaving) return;
  const name = bookmarkEditField("name")?.value.trim() ?? "";
  const endpoint = bookmarkEditField("endpoint")?.value.trim() ?? "";
  const region = bookmarkEditField("region")?.value.trim() ?? "";
  const accessKey = bookmarkEditField("accessKey")?.value.trim() ?? "";
  const secretKey = bookmarkEditField("secretKey")?.value.trim() ?? "";
  const sessionToken = bookmarkEditField("sessionToken")?.value.trim() ?? "";
  const accessKeyChanged = accessKey !== target.access_key;

  // Same rules as the connect form. A changed access key cannot reuse the old
  // secret, so it must come with a new one.
  if (!name) {
    setBookmarkEditError("Enter a name for this connection.");
    return;
  }
  if (!endpoint) {
    setBookmarkEditError("Enter the endpoint.");
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    setBookmarkEditError("Endpoint must start with http:// or https://.");
    return;
  }
  if (!accessKey) {
    setBookmarkEditError("Enter the access key.");
    return;
  }
  if (accessKeyChanged && !secretKey) {
    setBookmarkEditError("Enter the secret key for the new access key.");
    return;
  }

  // A blank secret or session token keeps the stored one. A changed access key
  // drops the old session token, because it belongs to the old key.
  const patch: BookmarkPatch = {
    name,
    endpoint,
    region,
    access_key: accessKey,
  };
  if (secretKey) patch.secret_key = secretKey;
  if (sessionToken) patch.session_token = sessionToken;
  else if (accessKeyChanged) patch.session_token = undefined;

  bookmarkEditSaving = true;
  setBookmarkEditBusy(true);
  setBookmarkEditError(null);
  try {
    const updated = await updateBookmark(
      { endpoint: target.endpoint, access_key: target.access_key },
      patch,
    );
    hideBookmarkEdit();
    setBookmarkStatus(
      updated
        ? `Saved changes to "${name}".`
        : "That saved connection is no longer saved.",
    );
    await refreshBookmarkListUI();
  } catch (err) {
    // Stays open so nothing typed is lost; the message never echoes secrets.
    setBookmarkEditError(`Could not save changes: ${friendlyError(err)}`);
  } finally {
    bookmarkEditSaving = false;
    setBookmarkEditBusy(false);
  }
}

function wireBookmarkEdit(): void {
  const form = document.getElementById("bookmark-edit");
  if (!form || form.dataset.wired === "true") return;
  form.dataset.wired = "true";
  form.addEventListener("keydown", (e) => {
    // Escape is for this form only: it must not also close Settings.
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    hideBookmarkEdit();
  });
  document
    .getElementById("bookmark-edit-save")
    ?.addEventListener("click", () => void saveBookmarkEdit());
  document
    .getElementById("bookmark-edit-cancel")
    ?.addEventListener("click", () => hideBookmarkEdit());
}

/**
 * Open Settings on the Saved connections tab with the edit form filled in.
 * The live session keeps the credentials it already has; the form says so.
 */
export function editSavedConnection(bookmark: Bookmark): void {
  wireBookmarkEdit();
  if (!settingsIsOpen()) openSettingsModal();
  switchSettingsTab("bookmarks");
  showBookmarkEdit(bookmark);
}
