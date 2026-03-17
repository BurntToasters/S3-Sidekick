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
