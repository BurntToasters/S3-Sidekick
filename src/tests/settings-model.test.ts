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

    expect(result.extras).toEqual({
      _launchCount: 4,
      unknownKey: "keep-me",
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
      theme: "light",
      autoCheckUpdates: false,
      updateChannel: "beta",
      presignedUrlExpiration: 600,
      maxConcurrentTransfers: 4,
    });
  });
});
