import { describe, expect, it } from "vitest";
import {
  SETTING_DEFAULTS,
  mergeSettingsPayload,
  normalizeUserSettings,
  parseSettingsRaw,
} from "../settings-model.ts";

describe("settings model", () => {
  it("defaults update channel to release when missing", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        theme: "dark",
        autoCheckUpdates: false,
      }),
    );
    expect(result.settings.updateChannel).toBe("release");
  });

  it("parses beta update channel when provided", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        updateChannel: "beta",
      }),
    );
    expect(result.settings.updateChannel).toBe("beta");
  });

  it("defaults presigned URL expiration to 3600 when missing", () => {
    const result = parseSettingsRaw(JSON.stringify({ theme: "dark" }));
    expect(result.settings.presignedUrlExpiration).toBe(3600);
  });

  it("preserves valid presigned URL expiration", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, presignedUrlExpiration: 900 }),
    );
    expect(result.settings.presignedUrlExpiration).toBe(900);
  });

  it("clamps presigned URL expiration below minimum to default", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, presignedUrlExpiration: 10 }),
    );
    expect(result.settings.presignedUrlExpiration).toBe(3600);
  });

  it("clamps presigned URL expiration above maximum to default", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, presignedUrlExpiration: 999999 }),
    );
    expect(result.settings.presignedUrlExpiration).toBe(3600);
  });

  it("rejects non-number presigned URL expiration", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, presignedUrlExpiration: "bad" }),
    );
    expect(result.settings.presignedUrlExpiration).toBe(3600);
  });

  it("preserves valid max concurrent transfers", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, maxConcurrentTransfers: 8 }),
    );
    expect(result.settings.maxConcurrentTransfers).toBe(8);
  });

  it("defaults max concurrent transfers when below minimum", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, maxConcurrentTransfers: 0 }),
    );
    expect(result.settings.maxConcurrentTransfers).toBe(3);
  });

  it("defaults max concurrent transfers when above maximum", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, maxConcurrentTransfers: 999 }),
    );
    expect(result.settings.maxConcurrentTransfers).toBe(3);
  });

  it("defaults max concurrent transfers when not an integer", () => {
    const result = parseSettingsRaw(
      JSON.stringify({ ...SETTING_DEFAULTS, maxConcurrentTransfers: 2.5 }),
    );
    expect(result.settings.maxConcurrentTransfers).toBe(3);
  });

  it("normalizes transfer retry settings and conflict policy", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        transferRetryAttempts: 4,
        transferRetryBaseMs: 800,
        conflictPolicy: "replace",
        rememberDownloadPath: false,
      }),
    );
    expect(result.settings.transferRetryAttempts).toBe(4);
    expect(result.settings.transferRetryBaseMs).toBe(800);
    expect(result.settings.conflictPolicy).toBe("replace");
    expect(result.settings.rememberDownloadPath).toBe(false);
  });

  it("falls back for invalid transfer retry and conflict policy values", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        transferRetryAttempts: 99,
        transferRetryBaseMs: 1,
        conflictPolicy: "invalid",
        rememberDownloadPath: "yes",
      }),
    );
    expect(result.settings.transferRetryAttempts).toBe(
      SETTING_DEFAULTS.transferRetryAttempts,
    );
    expect(result.settings.transferRetryBaseMs).toBe(
      SETTING_DEFAULTS.transferRetryBaseMs,
    );
    expect(result.settings.conflictPolicy).toBe(
      SETTING_DEFAULTS.conflictPolicy,
    );
    expect(result.settings.rememberDownloadPath).toBe(
      SETTING_DEFAULTS.rememberDownloadPath,
    );
  });

  it("normalizes checksum verification setting", () => {
    const enabled = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        enableTransferChecksumVerification: true,
      }),
    );
    expect(enabled.settings.enableTransferChecksumVerification).toBe(true);

    const invalid = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        enableTransferChecksumVerification: "yes",
      }),
    );
    expect(invalid.settings.enableTransferChecksumVerification).toBe(
      SETTING_DEFAULTS.enableTransferChecksumVerification,
    );
  });

  it("persists update channel in merged payload", () => {
    const payload = mergeSettingsPayload(
      { ...SETTING_DEFAULTS, updateChannel: "beta" },
      { _bookmarks: [] },
    );
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.updateChannel).toBe("beta");
    expect(parsed._bookmarks).toEqual([]);
  });

  it("marks malformed payloads and falls back to defaults", () => {
    const malformed = parseSettingsRaw("{bad json");
    expect(malformed.malformed).toBe(true);
    expect(malformed.settings).toEqual(SETTING_DEFAULTS);

    const arrayPayload = parseSettingsRaw(JSON.stringify(["not", "object"]));
    expect(arrayPayload.malformed).toBe(true);
    expect(arrayPayload.settings).toEqual(SETTING_DEFAULTS);
  });

  it("separates extras and normalizes invalid setting fields", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        _launchCount: 4,
        unknownKey: "keep-me",
        theme: "invalid",
        autoCheckUpdates: "yes",
        updateChannel: "nightly",
        presignedUrlExpiration: 75.4,
        maxConcurrentTransfers: 7,
      }),
    );

    // Schema v2 prunes unknown non-underscore keys; _schemaVersion is stamped.
    expect(result.extras).toEqual({
      _launchCount: 4,
      _schemaVersion: 2,
    });
    expect(result.settings.theme).toBe("system");
    expect(result.settings.autoCheckUpdates).toBe(true);
    expect(result.settings.updateChannel).toBe("release");
    expect(result.settings.presignedUrlExpiration).toBe(75);
    expect(result.settings.maxConcurrentTransfers).toBe(7);
  });

  it("normalizes a partial settings object directly", () => {
    expect(
      normalizeUserSettings({
        theme: "light",
        autoCheckUpdates: false,
        updateChannel: "beta",
        presignedUrlExpiration: 600,
        maxConcurrentTransfers: 4,
      }),
    ).toEqual({
      ...SETTING_DEFAULTS,
      theme: "light",
      autoCheckUpdates: false,
      updateChannel: "beta",
      presignedUrlExpiration: 600,
      maxConcurrentTransfers: 4,
    });
  });

  it("preserves valid windowWidth and windowHeight settings", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 800,
        windowHeight: 600,
      }),
    );
    expect(result.settings.windowWidth).toBe(800);
    expect(result.settings.windowHeight).toBe(600);
  });

  it("clamps invalid windowWidth and windowHeight to defaults", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 100,
        windowHeight: 200,
      }),
    );
    expect(result.settings.windowWidth).toBe(SETTING_DEFAULTS.windowWidth);
    expect(result.settings.windowHeight).toBe(SETTING_DEFAULTS.windowHeight);
  });

  it("rejects non-integer or non-number values for window size", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 800.5,
        windowHeight: "large",
      }),
    );
    expect(result.settings.windowWidth).toBe(SETTING_DEFAULTS.windowWidth);
    expect(result.settings.windowHeight).toBe(SETTING_DEFAULTS.windowHeight);
  });

  it("keeps known non-underscore extras and prunes unknown keys", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        launchCount: 5,
        supportPromptDismissed: true,
        transfersHintDismissed: false,
        _setupComplete: true,
        unknownKey: "drop-me",
        anotherUnknown: 123,
      }),
    );
    expect(result.malformed).toBe(false);
    expect(result.extras).toMatchObject({
      launchCount: 5,
      supportPromptDismissed: true,
      transfersHintDismissed: false,
      _setupComplete: true,
      _schemaVersion: 2,
    });
    expect(result.extras.unknownKey).toBeUndefined();
    expect(result.extras.anotherUnknown).toBeUndefined();
  });

  it("stamps schema version even when payload carries a stale version", () => {
    const result = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        _schemaVersion: 1,
        _setupComplete: true,
      }),
    );
    expect(result.extras._schemaVersion).toBe(2);
    expect(result.malformed).toBe(false);
  });

  it("flags corrupt payloads instead of silently defaulting", () => {
    const empty = parseSettingsRaw("");
    expect(empty.malformed).toBe(true);
    expect(empty.settings).toEqual(SETTING_DEFAULTS);
    expect(empty.extras._schemaVersion).toBe(2);

    const scalar = parseSettingsRaw(JSON.stringify("just-a-string"));
    expect(scalar.malformed).toBe(true);
    expect(scalar.settings).toEqual(SETTING_DEFAULTS);

    const nulled = parseSettingsRaw(JSON.stringify(null));
    expect(nulled.malformed).toBe(true);
    expect(nulled.settings).toEqual(SETTING_DEFAULTS);
  });

  it("round-trips factory payloads through merge and parse", () => {
    const factoryJson = mergeSettingsPayload(SETTING_DEFAULTS, {});
    const parsed = JSON.parse(factoryJson) as Record<string, unknown>;
    expect(parsed._schemaVersion).toBe(2);
    expect(parsed.theme).toBe("system");

    const reparsed = parseSettingsRaw(factoryJson);
    expect(reparsed.malformed).toBe(false);
    expect(reparsed.settings).toEqual(SETTING_DEFAULTS);
    expect(reparsed.extras).toEqual({ _schemaVersion: 2 });
  });

  it("preserves partial factory payloads carrying setup completion", () => {
    const json = mergeSettingsPayload(SETTING_DEFAULTS, {
      _setupComplete: true,
      launchCount: 9,
    });
    const reparsed = parseSettingsRaw(json);
    expect(reparsed.settings).toEqual(SETTING_DEFAULTS);
    expect(reparsed.extras).toMatchObject({
      _setupComplete: true,
      launchCount: 9,
      _schemaVersion: 2,
    });
  });

  it("clamps zero and boundary window sizes", () => {
    const zero = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 0,
        windowHeight: 0,
      }),
    );
    expect(zero.settings.windowWidth).toBe(SETTING_DEFAULTS.windowWidth);
    expect(zero.settings.windowHeight).toBe(SETTING_DEFAULTS.windowHeight);

    const min = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 400,
        windowHeight: 300,
      }),
    );
    expect(min.settings.windowWidth).toBe(400);
    expect(min.settings.windowHeight).toBe(300);

    const max = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 10000,
        windowHeight: 10000,
      }),
    );
    expect(max.settings.windowWidth).toBe(10000);
    expect(max.settings.windowHeight).toBe(10000);

    const over = parseSettingsRaw(
      JSON.stringify({
        ...SETTING_DEFAULTS,
        windowWidth: 10001,
        windowHeight: 10001,
      }),
    );
    expect(over.settings.windowWidth).toBe(SETTING_DEFAULTS.windowWidth);
    expect(over.settings.windowHeight).toBe(SETTING_DEFAULTS.windowHeight);
  });
});
