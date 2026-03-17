import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message, ask } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";
import { type UpdateChannel } from "./settings-model.ts";

type UpdaterMode = "native" | "flatpak" | "manual";

interface UpdaterSupportInfo {
  mode: UpdaterMode;
  release_url: string;
}

interface LatestReleaseInfo {
  version: string;
  releaseUrl: string;
}

const REPO_RELEASES_API =
  "https://api.github.com/repos/BurntToasters/S3-Sidekick/releases";
const DEFAULT_RELEASE_URL =
  "https://github.com/BurntToasters/S3-Sidekick/releases/latest";

let updaterEnabled = true;
let updateChannel: UpdateChannel = "release";
let updaterSupport: UpdaterSupportInfo = {
  mode: "native",
  release_url: DEFAULT_RELEASE_URL,
};

export function setUpdateChannel(channel: UpdateChannel): void {
  updateChannel = channel === "beta" ? "beta" : "release";
}

export async function initUpdater(): Promise<void> {
  try {
    const support = await invoke<UpdaterSupportInfo>("updater_support_info");
    if (
      support &&
      (support.mode === "native" ||
        support.mode === "flatpak" ||
        support.mode === "manual")
    ) {
      updaterSupport = {
        mode: support.mode,
        release_url: support.release_url || DEFAULT_RELEASE_URL,
      };
    }
  } catch {
    try {
      const nativeSupported = await invoke<boolean>("updater_supported");
      updaterSupport = {
        mode: nativeSupported ? "native" : "manual",
        release_url: DEFAULT_RELEASE_URL,
      };
    } catch {
      updaterSupport = {
        mode: "native",
        release_url: DEFAULT_RELEASE_URL,
      };
    }
  }
  updaterEnabled = updaterSupport.mode !== "manual";
  setUpdateChannel(state.currentSettings.updateChannel);
}

export function isUpdaterEnabled(): boolean {
  return updaterEnabled;
}

async function notify(title: string, body: string): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  if (granted) {
    sendNotification({ title, body });
  }
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function updaterTargetBase(): string {
  if (state.platformName === "windows") return "windows";
  if (state.platformName === "macos") return "darwin";
  return "linux";
}

function updaterCheckTargetForChannel(
  channel: UpdateChannel,
): string | undefined {
  if (channel !== "beta") return undefined;
  return `${updaterTargetBase()}-beta`;
}

function parseReleaseVersion(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/^v/i, "").trim();
}

function isBetaVersion(version: string): boolean {
  return /-beta\.\d+/i.test(version);
}

async function promptInstallAndRestart(
  version: string,
  install: () => Promise<void>,
): Promise<void> {
  setStatus("Update ready");
  const restart = await ask(
    `Version ${version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
    {
      title: "Update ready",
      kind: "info",
      okLabel: "Restart now",
      cancelLabel: "Later",
    },
  );
  if (restart) {
    setStatus("Installing update...");
    await install();
    await relaunch();
  } else {
    await notify(
      "S3 Sidekick",
      "Update downloaded. Restart the app when you're ready.",
    );
    setStatus("");
  }
}

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const normalized = version.trim().replace(/^v/i, "");
  const [corePart, prePart = ""] = normalized.split("-", 2);
  const core = corePart
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
  const pre = prePart.length > 0 ? prePart.split(".") : [];
  return { core, pre };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = Number.parseInt(left, 10);
    const b = Number.parseInt(right, 10);
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
  if (leftNumeric && !rightNumeric) return -1;
  if (!leftNumeric && rightNumeric) return 1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const maxCoreLen = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < maxCoreLen; i += 1) {
    const av = a.core[i] ?? 0;
    const bv = b.core[i] ?? 0;
    if (av !== bv) {
      return av > bv ? 1 : -1;
    }
  }

  const aHasPre = a.pre.length > 0;
  const bHasPre = b.pre.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre) return 1;
  if (!bHasPre) return -1;

  const maxPreLen = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < maxPreLen; i += 1) {
    const av = a.pre[i];
    const bv = b.pre[i];
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const cmp = compareIdentifiers(av, bv);
    if (cmp !== 0) return cmp;
  }

  return 0;
}

function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

async function fetchLatestReleaseInfo(
  channel: UpdateChannel,
): Promise<LatestReleaseInfo> {
  if (channel === "release") {
    const response = await fetch(`${REPO_RELEASES_API}/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const version =
      parseReleaseVersion(payload.tag_name) ||
      parseReleaseVersion(payload.name);
    if (!version) {
      throw new Error("Latest release did not include a valid version.");
    }

    const htmlUrl =
      typeof payload.html_url === "string" &&
      payload.html_url.startsWith("https://github.com/")
        ? payload.html_url
        : updaterSupport.release_url || DEFAULT_RELEASE_URL;
    return { version, releaseUrl: htmlUrl };
  }

  const response = await fetch(`${REPO_RELEASES_API}?per_page=50`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("GitHub API returned an invalid release list.");
  }

  let latest: LatestReleaseInfo | null = null;
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const release = item as Record<string, unknown>;
    if (release.draft === true) continue;

    const version =
      parseReleaseVersion(release.tag_name) ||
      parseReleaseVersion(release.name);
    if (!version || !isBetaVersion(version)) continue;

    const htmlUrl =
      typeof release.html_url === "string" &&
      release.html_url.startsWith("https://github.com/")
        ? release.html_url
        : DEFAULT_RELEASE_URL;
    if (!latest || isNewerVersion(version, latest.version)) {
      latest = { version, releaseUrl: htmlUrl };
    }
  }

  if (!latest) {
    throw new Error("No beta release is currently available.");
  }
  return latest;
}

async function checkFlatpakUpdates(channel: UpdateChannel): Promise<void> {
  try {
    setStatus("Checking for updates...");
    const currentVersion = await getVersion();
    const latest = await fetchLatestReleaseInfo(channel);
    if (!isNewerVersion(latest.version, currentVersion)) {
      await message("You are running the latest version.", {
        title: "No updates",
      });
      setStatus("");
      return;
    }

    setStatus("Update available");
    const channelLabel = channel === "beta" ? "beta channel " : "";
    const openDownloadPage = await ask(
      `Version ${latest.version} is available.\n\nFlatpak packages are updated outside the app. Open the latest ${channelLabel}release page now?`,
      {
        title: "Update available",
        kind: "info",
        okLabel: "Open download page",
        cancelLabel: "Later",
      },
    );
    if (openDownloadPage) {
      await invoke("open_external_url", { url: latest.releaseUrl });
    }
    setStatus("");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus("");
    await message(`Failed to check for updates.\n\n${msg}`, {
      title: "Update error",
      kind: "error",
    });
  }
}

async function checkNativeUpdate(channel: UpdateChannel) {
  const target = updaterCheckTargetForChannel(channel);
  if (target) {
    return check({ target });
  }
  return check();
}

async function promptOpenReleasePage(
  latest: LatestReleaseInfo,
  mode: UpdaterMode,
): Promise<void> {
  setStatus("Update available");
  const modeText =
    mode === "flatpak"
      ? "Flatpak packages are updated outside the app."
      : "Auto-updates are not available for this package format.";
  const openDownloadPage = await ask(
    `Version ${latest.version} is available.\n\n${modeText} Open the release page now?`,
    {
      title: "Update available",
      kind: "info",
      okLabel: "Open download page",
      cancelLabel: "Later",
    },
  );
  if (openDownloadPage) {
    await invoke("open_external_url", { url: latest.releaseUrl });
  }
  setStatus("");
}

async function checkReleasePageUpdate(
  channel: UpdateChannel,
  mode: UpdaterMode,
): Promise<void> {
  setStatus("Checking for updates...");
  const currentVersion = await getVersion();
  const latest = await fetchLatestReleaseInfo(channel);
  if (!isNewerVersion(latest.version, currentVersion)) {
    await message("You are running the latest version.", {
      title: "No updates",
    });
    setStatus("");
    return;
  }
  await promptOpenReleasePage(latest, mode);
}

async function notifyReleasePageUpdate(channel: UpdateChannel): Promise<void> {
  const currentVersion = await getVersion();
  const latest = await fetchLatestReleaseInfo(channel);
  if (!isNewerVersion(latest.version, currentVersion)) return;
  await notify(
    "S3 Sidekick",
    `Version ${latest.version} is available. Open settings to view download options.`,
  );
}

export async function checkUpdates(): Promise<void> {
  const channel = updateChannel;

  if (updaterSupport.mode === "flatpak") {
    await checkFlatpakUpdates(channel);
    return;
  }

  if (updaterSupport.mode === "manual") {
    try {
      await checkReleasePageUpdate(channel, "manual");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("");
      await message(`Failed to check for updates.\n\n${msg}`, {
        title: "Update error",
        kind: "error",
      });
    }
    return;
  }

  try {
    setStatus("Checking for updates...");
    const update = await checkNativeUpdate(channel);
    if (!update) {
      if (channel === "beta") {
        await checkReleasePageUpdate(channel, "manual");
      } else {
        await message("You are running the latest version.", {
          title: "No updates",
        });
        setStatus("");
      }
      return;
    }
    setStatus(`Downloading update v${update.version}...`);
    await update.download();
    await promptInstallAndRestart(update.version, () => update.install());
  } catch (err) {
    if (channel === "beta") {
      try {
        await checkReleasePageUpdate(channel, "manual");
        return;
      } catch {
        // fall through to normal error below
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    setStatus("");
    await message(`Failed to check for updates.\n\n${msg}`, {
      title: "Update error",
      kind: "error",
    });
  }
}

export async function autoCheckUpdates(): Promise<void> {
  if (!state.currentSettings.autoCheckUpdates) return;
  const channel = updateChannel;

  if (updaterSupport.mode === "flatpak" || updaterSupport.mode === "manual") {
    try {
      await notifyReleasePageUpdate(channel);
    } catch {
      setStatus("");
    }
    return;
  }

  if (!updaterEnabled) return;

  try {
    const update = await checkNativeUpdate(channel);
    if (update) {
      await notify(
        "S3 Sidekick",
        `Version ${update.version} is available. Downloading...`,
      );
      setStatus(`Downloading update v${update.version}...`);
      await update.download();
      await promptInstallAndRestart(update.version, () => update.install());
      return;
    }

    if (channel === "beta") {
      await notifyReleasePageUpdate(channel);
    }
  } catch {
    if (channel === "beta") {
      try {
        await notifyReleasePageUpdate(channel);
        return;
      } catch {
        // ignore
      }
    }
    setStatus("");
  }
}
