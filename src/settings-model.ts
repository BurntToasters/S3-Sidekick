export type ThemePreference = "system" | "light" | "dark";
export type UpdateChannel = "release" | "beta";
export type ConflictPolicy = "ask" | "skip" | "replace";

export interface UserSettings {
  theme: ThemePreference;
  autoCheckUpdates: boolean;
  updateChannel: UpdateChannel;
  presignedUrlExpiration: number;
  maxConcurrentTransfers: number;
  transferRetryAttempts: number;
  transferRetryBaseMs: number;
  conflictPolicy: ConflictPolicy;
  rememberDownloadPath: boolean;
}

export const SETTING_DEFAULTS: UserSettings = {
  theme: "system",
  autoCheckUpdates: true,
  updateChannel: "release",
  presignedUrlExpiration: 3600,
  maxConcurrentTransfers: 3,
  transferRetryAttempts: 3,
  transferRetryBaseMs: 400,
  conflictPolicy: "ask",
  rememberDownloadPath: true,
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

  const rawConcurrent = raw.maxConcurrentTransfers;
  const maxConcurrentTransfers =
    typeof rawConcurrent === "number" &&
    Number.isInteger(rawConcurrent) &&
    rawConcurrent >= 1 &&
    rawConcurrent <= 10
      ? rawConcurrent
      : SETTING_DEFAULTS.maxConcurrentTransfers;

  const rawRetryAttempts = raw.transferRetryAttempts;
  const transferRetryAttempts =
    typeof rawRetryAttempts === "number" &&
    Number.isInteger(rawRetryAttempts) &&
    rawRetryAttempts >= 0 &&
    rawRetryAttempts <= 10
      ? rawRetryAttempts
      : SETTING_DEFAULTS.transferRetryAttempts;

  const rawRetryBaseMs = raw.transferRetryBaseMs;
  const transferRetryBaseMs =
    typeof rawRetryBaseMs === "number" &&
    Number.isInteger(rawRetryBaseMs) &&
    rawRetryBaseMs >= 50 &&
    rawRetryBaseMs <= 10000
      ? rawRetryBaseMs
      : SETTING_DEFAULTS.transferRetryBaseMs;

  const conflictPolicy =
    raw.conflictPolicy === "ask" ||
    raw.conflictPolicy === "skip" ||
    raw.conflictPolicy === "replace"
      ? raw.conflictPolicy
      : SETTING_DEFAULTS.conflictPolicy;

  const rememberDownloadPath =
    typeof raw.rememberDownloadPath === "boolean"
      ? raw.rememberDownloadPath
      : SETTING_DEFAULTS.rememberDownloadPath;

  return {
    theme,
    autoCheckUpdates,
    updateChannel,
    presignedUrlExpiration,
    maxConcurrentTransfers,
    transferRetryAttempts,
    transferRetryBaseMs,
    conflictPolicy,
    rememberDownloadPath,
  };
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
