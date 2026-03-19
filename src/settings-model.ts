export type ThemePreference = "system" | "light" | "dark";
export type UpdateChannel = "release" | "beta";

export interface UserSettings {
  theme: ThemePreference;
  autoCheckUpdates: boolean;
  updateChannel: UpdateChannel;
  presignedUrlExpiration: number;
}

export const SETTING_DEFAULTS: UserSettings = {
  theme: "system",
  autoCheckUpdates: true,
  updateChannel: "release",
  presignedUrlExpiration: 3600,
};

export function normalizeUserSettings(
  raw: Partial<UserSettings>,
): UserSettings {
  const theme =
    raw.theme === "light" || raw.theme === "dark" || raw.theme === "system"
      ? raw.theme
      : SETTING_DEFAULTS.theme;

  const autoCheckUpdates =
    typeof raw.autoCheckUpdates === "boolean"
      ? raw.autoCheckUpdates
      : SETTING_DEFAULTS.autoCheckUpdates;

  const updateChannel =
    raw.updateChannel === "beta" || raw.updateChannel === "release"
      ? raw.updateChannel
      : SETTING_DEFAULTS.updateChannel;

  const rawExpiration = raw.presignedUrlExpiration;
  const presignedUrlExpiration =
    typeof rawExpiration === "number" &&
    Number.isFinite(rawExpiration) &&
    rawExpiration >= 60 &&
    rawExpiration <= 604800
      ? Math.round(rawExpiration)
      : SETTING_DEFAULTS.presignedUrlExpiration;

  return { theme, autoCheckUpdates, updateChannel, presignedUrlExpiration };
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
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
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
  extras: Record<string, unknown>,
): string {
  return JSON.stringify({ ...extras, ...settings }, null, 2);
}
