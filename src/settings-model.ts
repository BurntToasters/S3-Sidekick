export type ThemePreference = "system" | "light" | "dark";

export interface UserSettings {
  theme: ThemePreference;
  autoCheckUpdates: boolean;
}

export const SETTING_DEFAULTS: UserSettings = {
  theme: "system",
  autoCheckUpdates: true,
};

export function normalizeUserSettings(raw: Partial<UserSettings>): UserSettings {
  const theme =
    raw.theme === "light" || raw.theme === "dark" || raw.theme === "system"
      ? raw.theme
      : SETTING_DEFAULTS.theme;

  const autoCheckUpdates =
    typeof raw.autoCheckUpdates === "boolean"
      ? raw.autoCheckUpdates
      : SETTING_DEFAULTS.autoCheckUpdates;

  return { theme, autoCheckUpdates };
}

export interface LoadSettingsResult {
  settings: UserSettings;
  extras: Record<string, unknown>;
  malformed: boolean;
}

export function parseSettingsRaw(json: string): LoadSettingsResult {
  let parsed: Record<string, unknown>;
  let malformed = false;
  try {
    parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      parsed = {};
      malformed = true;
    }
  } catch {
    parsed = {};
    malformed = true;
  }

  const extras: Record<string, unknown> = {};
  const settingsRaw: Partial<UserSettings> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_")) {
      extras[key] = value;
    } else if (key in SETTING_DEFAULTS) {
      (settingsRaw as Record<string, unknown>)[key] = value;
    } else {
      extras[key] = value;
    }
  }

  return {
    settings: normalizeUserSettings(settingsRaw),
    extras,
    malformed,
  };
}

export function mergeSettingsPayload(
  settings: UserSettings,
  extras: Record<string, unknown>
): string {
  return JSON.stringify({ ...extras, ...settings }, null, 2);
}
