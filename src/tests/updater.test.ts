import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCheck = vi.fn<() => Promise<unknown>>();
const mockRelaunch = vi.fn<() => Promise<void>>();
const mockMessage = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockAsk = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockGetVersion = vi.fn<() => Promise<string>>();
const mockIsPermissionGranted = vi.fn<() => Promise<boolean>>();
const mockRequestPermission =
  vi.fn<() => Promise<"default" | "denied" | "granted">>();
const mockSendNotification = vi.fn<(payload: unknown) => void>();
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mockMessage,
  ask: mockAsk,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
  sendNotification: mockSendNotification,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("updater", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = `<div id="status"></div>`;
    mockCheck.mockReset();
    mockRelaunch.mockReset();
    mockMessage.mockReset();
    mockAsk.mockReset();
    mockGetVersion.mockReset();
    mockIsPermissionGranted.mockReset();
    mockRequestPermission.mockReset();
    mockSendNotification.mockReset();
    mockInvoke.mockReset();

    mockGetVersion.mockResolvedValue("0.6.0");
    mockAsk.mockResolvedValue(false);
    mockMessage.mockResolvedValue(undefined);
    mockIsPermissionGranted.mockResolvedValue(true);
    mockRequestPermission.mockResolvedValue("granted");
    mockInvoke.mockResolvedValue({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });

    const { state } = await import("../state.ts");
    state.platformName = "windows";
    state.currentSettings.autoCheckUpdates = true;
    state.currentSettings.updateChannel = "release";
  });

  it("disables native updater in manual mode and shows no-update message", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.6.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0",
        }),
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    expect(updater.isUpdaterEnabled()).toBe(false);

    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      "You are running the latest version.",
      {
        title: "No updates",
      },
    );
  });

  it("uses native updater and reports no update when check returns null", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce(null);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    expect(updater.isUpdaterEnabled()).toBe(true);

    await updater.checkUpdates();
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockMessage).toHaveBeenCalledWith(
      "You are running the latest version.",
      {
        title: "No updates",
      },
    );
  });

  it("downloads native updates and notifies when restart is deferred", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce({
      version: "0.7.0",
      download,
      install,
    });
    mockAsk.mockResolvedValueOnce(false);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(download).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: "S3 Sidekick",
      body: "Update downloaded. Restart the app when you're ready.",
    });
  });

  it("checks beta releases in manual mode and opens the release page", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.1",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1",
          },
          {
            draft: false,
            tag_name: "v0.6.0-beta.4",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.4",
          },
          {
            draft: false,
            tag_name: "v0.6.0",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0",
          },
        ],
      }),
    );
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    mockAsk.mockResolvedValueOnce(true);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.4",
    });
  });

  it("auto-checks manual mode release channel and sends notification when newer exists", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.7.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.7.0",
        }),
      }),
    );
    mockGetVersion.mockResolvedValue("0.6.0");
    mockIsPermissionGranted.mockResolvedValue(true);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.autoCheckUpdates();

    expect(mockSendNotification).toHaveBeenCalledWith({
      title: "S3 Sidekick",
      body: "Version 0.7.0 is available. Open settings to view download options.",
    });
  });

  it("falls back to updater_supported when updater_support_info is unavailable", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("no support info"))
      .mockResolvedValueOnce(true);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    expect(updater.isUpdaterEnabled()).toBe(true);
  });

  it("installs and relaunches when user accepts restart", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce({
      version: "0.8.0",
      download,
      install,
    });
    mockAsk.mockResolvedValueOnce(true);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("shows update error in manual mode when release API fails", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({
        title: "Update error",
        kind: "error",
      }),
    );
  });

  it("checks flatpak releases and opens release page when update exists", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "flatpak",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockGetVersion.mockResolvedValue("0.6.0");
    mockAsk.mockResolvedValueOnce(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.7.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.7.0",
        }),
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.7.0",
    });
  });

  it("falls back to beta release-page check when native beta returns no update", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce(null);
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    mockAsk.mockResolvedValueOnce(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.2",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.2",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();

    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.2",
    });
  });

  it("auto-checks native updates and restarts after download when confirmed", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce({
      version: "0.8.1",
      download,
      install,
    });
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue("granted");
    mockAsk.mockResolvedValueOnce(true);

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.autoCheckUpdates();

    expect(mockSendNotification).toHaveBeenCalledWith({
      title: "S3 Sidekick",
      body: "Version 0.8.1 is available. Downloading...",
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("swallows beta auto-check fallback failures after native check throws", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockRejectedValueOnce(new Error("native failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await expect(updater.autoCheckUpdates()).resolves.toBeUndefined();
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toBe("");
  });

  it("defaults to native mode when both support probes fail", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("no support info"))
      .mockRejectedValueOnce(new Error("no legacy support"));

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    expect(updater.isUpdaterEnabled()).toBe(true);
  });

  it("uses beta native target suffix per platform", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    const { state } = await import("../state.ts");
    state.platformName = "macos";
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    mockCheck.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.1",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();
    expect(mockCheck).toHaveBeenCalledWith({ target: "darwin-beta" });

    state.platformName = "linux";
    mockCheck.mockResolvedValueOnce(null);
    await updater.checkUpdates();
    expect(mockCheck).toHaveBeenCalledWith({ target: "linux-beta" });
  });

  it("surfaces release API shape/version errors in manual mode", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
        }),
      }),
    );
    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );

    mockMessage.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ not: "array" }),
      }),
    );
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );

    mockMessage.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ draft: false, tag_name: "v0.6.0" }],
      }),
    );
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );
  });

  it("handles flatpak no-update and update-check failures", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "flatpak",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockGetVersion.mockResolvedValue("0.7.0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.7.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.7.0",
        }),
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      "You are running the latest version.",
      { title: "No updates" },
    );

    mockMessage.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      }),
    );
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );
  });

  it("beta native failure falls back to release-page check and then shows error", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockRejectedValueOnce(new Error("native check failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );
  });

  it("beta auto-check with native no-update falls back to release-page notification", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce(null);
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    mockIsPermissionGranted.mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.3",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.3",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.autoCheckUpdates();
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: "S3 Sidekick",
      body: "Version 0.6.0-beta.3 is available. Open settings to view download options.",
    });
  });

  it("handles beta release ordering and filtered list items", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockGetVersion.mockResolvedValue("0.6.0-beta.0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          null,
          "bad-entry",
          { draft: true, tag_name: "v0.6.0-beta.99" },
          {
            draft: false,
            tag_name: "v0.6.0-beta.1.2",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1.2",
          },
          {
            draft: false,
            tag_name: "v0.6.0-beta.1.alpha",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1.alpha",
          },
          {
            draft: false,
            tag_name: "v0.6.0-beta.1.3",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1.3",
          },
          {
            draft: false,
            tag_name: "v0.6.0-beta.1.beta",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1.beta",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][0]).toContain("0.6.0-beta.1.beta");
  });

  it("skips manual auto-check notification when no newer release exists", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockGetVersion.mockResolvedValue("0.6.0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.6.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0",
        }),
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.autoCheckUpdates();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("beta native check error falls back to release-page success without error dialog", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockRejectedValueOnce(new Error("native failed"));
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.2",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.2",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to check for updates"),
      expect.objectContaining({ title: "Update error" }),
    );
  });

  it("returns early from auto-check when disabled in settings", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    const { state } = await import("../state.ts");
    state.currentSettings.autoCheckUpdates = false;

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.autoCheckUpdates();

    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("clears status when manual auto-check release lookup fails", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await expect(updater.autoCheckUpdates()).resolves.toBeUndefined();
    expect(
      (document.getElementById("status") as HTMLDivElement).textContent,
    ).toBe("");
  });

  it("beta auto-check falls back to release-page notification after native error", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockRejectedValueOnce(new Error("native down"));
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.4",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.4",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.autoCheckUpdates();

    expect(mockSendNotification).toHaveBeenCalledWith({
      title: "S3 Sidekick",
      body: "Version 0.6.0-beta.4 is available. Open settings to view download options.",
    });
  });

  it("handles prerelease comparison edge-cases for release-page checks", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    const updater = await import("../updater.ts");
    await updater.initUpdater();

    mockGetVersion.mockResolvedValue("0.6.0-beta.2");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.6.0",
          html_url:
            "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0",
        }),
      }),
    );
    await updater.checkUpdates();
    expect(mockAsk).toHaveBeenCalledTimes(1);

    mockAsk.mockClear();
    mockMessage.mockClear();
    updater.setUpdateChannel("beta");
    mockGetVersion.mockResolvedValue("0.6.0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.2",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.2",
          },
        ],
      }),
    );
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      "You are running the latest version.",
      { title: "No updates" },
    );

    mockAsk.mockClear();
    mockMessage.mockClear();
    mockGetVersion.mockResolvedValue("0.6.0-beta.1.1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.1",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1",
          },
        ],
      }),
    );
    await updater.checkUpdates();
    expect(mockMessage).toHaveBeenCalledWith(
      "You are running the latest version.",
      { title: "No updates" },
    );

    mockAsk.mockClear();
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.1.1",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.1.1",
          },
        ],
      }),
    );
    await updater.checkUpdates();
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it("falls back to configured release URL when latest payload html_url is untrusted", async () => {
    const fallbackUrl =
      "https://github.com/BurntToasters/S3-Sidekick/releases/custom";
    mockInvoke.mockResolvedValueOnce({
      mode: "manual",
      release_url: fallbackUrl,
    });
    mockGetVersion.mockResolvedValue("0.6.0");
    mockAsk.mockResolvedValueOnce(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: "v0.7.0",
          html_url: "https://example.com/not-trusted",
        }),
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      url: fallbackUrl,
    });
  });

  it("covers flatpak beta prompt text and decline flow", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "flatpak",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockGetVersion.mockResolvedValue("0.6.0-beta.1");
    mockAsk.mockResolvedValueOnce(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            draft: false,
            tag_name: "v0.6.0-beta.2",
            html_url:
              "https://github.com/BurntToasters/S3-Sidekick/releases/tag/v0.6.0-beta.2",
          },
        ],
      }),
    );

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    updater.setUpdateChannel("beta");
    await updater.checkUpdates();

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(String(mockAsk.mock.calls[0][0])).toContain("beta channel");
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "open_external_url",
      expect.anything(),
    );
  });

  it("shows flatpak update errors for non-Error throw values", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "flatpak",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network down"));

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(mockMessage).toHaveBeenCalledWith(
      expect.stringContaining("network down"),
      expect.objectContaining({ title: "Update error", kind: "error" }),
    );
  });

  it("skips deferred-update notification when notification permission is denied", async () => {
    const download = vi.fn(async () => undefined);
    const install = vi.fn(async () => undefined);
    document.getElementById("status")?.remove();
    mockInvoke.mockResolvedValueOnce({
      mode: "native",
      release_url:
        "https://github.com/BurntToasters/S3-Sidekick/releases/latest",
    });
    mockCheck.mockResolvedValueOnce({
      version: "0.9.0",
      download,
      install,
    });
    mockAsk.mockResolvedValueOnce(false);
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue("denied");

    const updater = await import("../updater.ts");
    await updater.initUpdater();
    await updater.checkUpdates();

    expect(download).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
