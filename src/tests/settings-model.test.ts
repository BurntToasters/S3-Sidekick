import { describe, expect, it } from "vitest";
import {
  SETTING_DEFAULTS,
  mergeSettingsPayload,
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

  it("persists update channel in merged payload", () => {
    const payload = mergeSettingsPayload(
      { ...SETTING_DEFAULTS, updateChannel: "beta" },
      { _bookmarks: [] },
    );
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.updateChannel).toBe("beta");
    expect(parsed._bookmarks).toEqual([]);
  });
});
