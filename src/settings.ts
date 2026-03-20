import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { state } from "./state.ts";
import {
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

export function applyTheme(theme: UserSettings["theme"]): void {
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export async function loadSettings(): Promise<void> {
  const json = await invoke<string>("load_settings");
  const result = parseSettingsRaw(json);
  state.currentSettings = result.settings;
  state.lastPersistedSettings = { ...result.settings };
  state.settingsExtras = result.extras;
  applyTheme(state.currentSettings.theme);
  setUpdateChannel(state.currentSettings.updateChannel);
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
    const isActive = p.dataset.settingsPanel === tab;
    p.hidden = !isActive;
    p.style.display = isActive ? "" : "none";
  }
}

export function populateSettingsModal(): void {
  const themeSelect = document.getElementById(
    "setting-theme",
  ) as HTMLSelectElement | null;
  if (themeSelect) themeSelect.value = state.currentSettings.theme;

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

  switchSettingsTab("general");
}

export function readSettingsModal(): void {
  const themeSelect = document.getElementById(
    "setting-theme",
  ) as HTMLSelectElement | null;
  if (themeSelect) {
    state.currentSettings.theme = themeSelect.value as UserSettings["theme"];
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
    "This will reset all settings to their defaults and restart the app. Bookmarks and saved connections will be removed.",
    { okLabel: "Reset & Restart", okDanger: true },
  );
  if (!confirmed) return;

  const defaults = mergeSettingsPayload(SETTING_DEFAULTS, {});
  await invoke("save_settings", { json: defaults });
  await invoke("save_connection", { json: "" });

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
