export type ThemePreference = "system" | "light" | "dark";
export type UpdateChannel = "release" | "beta";
export type ConflictPolicy = "ask" | "skip" | "replace";
export type TransferPerformancePreset = "safe" | "balanced" | "max";

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
  transferPerformancePreset: TransferPerformancePreset;
  downloadParallelThresholdMb: number;
  downloadPartSizeMb: number;
  downloadPartConcurrency: number;
  uploadPartSizeMb: number;
  uploadPartConcurrency: number;
  enableTransferResume: boolean;
  transferCheckpointTtlHours: number;
  bandwidthLimitMbps: number;
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
  transferPerformancePreset: "balanced",
  downloadParallelThresholdMb: 128,
  downloadPartSizeMb: 32,
  downloadPartConcurrency: 6,
  uploadPartSizeMb: 32,
  uploadPartConcurrency: 6,
  enableTransferResume: true,
  transferCheckpointTtlHours: 168,
  bandwidthLimitMbps: 0,
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

  const transferPerformancePreset =
    raw.transferPerformancePreset === "safe" ||
    raw.transferPerformancePreset === "balanced" ||
    raw.transferPerformancePreset === "max"
      ? raw.transferPerformancePreset
      : SETTING_DEFAULTS.transferPerformancePreset;

  const rawDownloadParallelThresholdMb = raw.downloadParallelThresholdMb;
  const downloadParallelThresholdMb =
    typeof rawDownloadParallelThresholdMb === "number" &&
    Number.isInteger(rawDownloadParallelThresholdMb) &&
    rawDownloadParallelThresholdMb >= 16 &&
    rawDownloadParallelThresholdMb <= 10240
      ? rawDownloadParallelThresholdMb
      : SETTING_DEFAULTS.downloadParallelThresholdMb;

  const rawDownloadPartSizeMb = raw.downloadPartSizeMb;
  const downloadPartSizeMb =
    typeof rawDownloadPartSizeMb === "number" &&
    Number.isInteger(rawDownloadPartSizeMb) &&
    rawDownloadPartSizeMb >= 16 &&
    rawDownloadPartSizeMb <= 128
      ? rawDownloadPartSizeMb
      : SETTING_DEFAULTS.downloadPartSizeMb;

  const rawDownloadPartConcurrency = raw.downloadPartConcurrency;
  const downloadPartConcurrency =
    typeof rawDownloadPartConcurrency === "number" &&
    Number.isInteger(rawDownloadPartConcurrency) &&
    rawDownloadPartConcurrency >= 1 &&
    rawDownloadPartConcurrency <= 16
      ? rawDownloadPartConcurrency
      : SETTING_DEFAULTS.downloadPartConcurrency;

  const rawUploadPartSizeMb = raw.uploadPartSizeMb;
  const uploadPartSizeMb =
    typeof rawUploadPartSizeMb === "number" &&
    Number.isInteger(rawUploadPartSizeMb) &&
    rawUploadPartSizeMb >= 16 &&
    rawUploadPartSizeMb <= 128
      ? rawUploadPartSizeMb
      : SETTING_DEFAULTS.uploadPartSizeMb;

  const rawUploadPartConcurrency = raw.uploadPartConcurrency;
  const uploadPartConcurrency =
    typeof rawUploadPartConcurrency === "number" &&
    Number.isInteger(rawUploadPartConcurrency) &&
    rawUploadPartConcurrency >= 1 &&
    rawUploadPartConcurrency <= 16
      ? rawUploadPartConcurrency
      : SETTING_DEFAULTS.uploadPartConcurrency;

  const enableTransferResume =
    typeof raw.enableTransferResume === "boolean"
      ? raw.enableTransferResume
      : SETTING_DEFAULTS.enableTransferResume;

  const rawTransferCheckpointTtlHours = raw.transferCheckpointTtlHours;
  const transferCheckpointTtlHours =
    typeof rawTransferCheckpointTtlHours === "number" &&
    Number.isInteger(rawTransferCheckpointTtlHours) &&
    rawTransferCheckpointTtlHours >= 1 &&
    rawTransferCheckpointTtlHours <= 720
      ? rawTransferCheckpointTtlHours
      : SETTING_DEFAULTS.transferCheckpointTtlHours;

  const rawBandwidthLimitMbps = raw.bandwidthLimitMbps;
  const bandwidthLimitMbps =
    typeof rawBandwidthLimitMbps === "number" &&
    Number.isInteger(rawBandwidthLimitMbps) &&
    rawBandwidthLimitMbps >= 0 &&
    rawBandwidthLimitMbps <= 10000
      ? rawBandwidthLimitMbps
      : SETTING_DEFAULTS.bandwidthLimitMbps;

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
    transferPerformancePreset,
    downloadParallelThresholdMb,
    downloadPartSizeMb,
    downloadPartConcurrency,
    uploadPartSizeMb,
    uploadPartConcurrency,
    enableTransferResume,
    transferCheckpointTtlHours,
    bandwidthLimitMbps,
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
