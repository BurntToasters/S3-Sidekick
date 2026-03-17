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
  type Bookmark,
} from "./bookmarks.ts";
import { isUpdaterEnabled, setUpdateChannel } from "./updater.ts";
import { refreshSecuritySettingsUI } from "./security.ts";
import { showConfirm } from "./dialogs.ts";

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

  const supported = isUpdaterEnabled();
  const updaterSection = document.getElementById("updater-section");
  const updaterUnsupported = document.getElementById("updater-unsupported");
  if (updaterSection) updaterSection.style.display = supported ? "" : "none";
  if (updaterUnsupported)
    updaterUnsupported.style.display = supported ? "none" : "";

  refreshBookmarkListUI();
  void refreshSecuritySettingsUI();

  const versionEl = document.getElementById("settings-version");
  if (versionEl) {
    getVersion().then((v) => {
      versionEl.textContent = `v${v}`;
    });
  }
  const platformEl = document.getElementById("settings-platform");
  if (platformEl) platformEl.textContent = state.platformName || "Unknown";

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
      await removeBookmark(index);
      refreshBookmarkListUI();
    },
  );
}
