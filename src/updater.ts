import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message, ask } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";

let updaterEnabled = true;

export async function initUpdater(): Promise<void> {
  updaterEnabled = await invoke<boolean>("updater_supported");
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

async function promptInstallAndRestart(version: string, install: () => Promise<void>): Promise<void> {
  setStatus("Update ready");
  const restart = await ask(
    `Version ${version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
    { title: "Update ready", kind: "info", okLabel: "Restart now", cancelLabel: "Later" }
  );
  if (restart) {
    setStatus("Installing update...");
    await install();
    await relaunch();
  } else {
    await notify("S3 Sidekick", "Update downloaded. Restart the app when you're ready.");
    setStatus("");
  }
}

export async function checkUpdates(): Promise<void> {
  if (!updaterEnabled) {
    await message(
      "Auto-updates are not available for this package format.\nPlease update through your package manager or download the latest release.",
      { title: "Updates not supported", kind: "info" }
    );
    return;
  }

  try {
    setStatus("Checking for updates...");
    const update = await check();
    if (!update) {
      await message("You are running the latest version.", { title: "No updates" });
      setStatus("");
      return;
    }
    setStatus(`Downloading update v${update.version}...`);
    await update.download();
    await promptInstallAndRestart(update.version, () => update.install());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus("");
    await message(`Failed to check for updates.\n\n${msg}`, { title: "Update error", kind: "error" });
  }
}

export async function autoCheckUpdates(): Promise<void> {
  if (!updaterEnabled) return;
  if (!state.currentSettings.autoCheckUpdates) return;

  try {
    const update = await check();
    if (!update) return;
    await notify("S3 Sidekick", `Version ${update.version} is available. Downloading...`);
    setStatus(`Downloading update v${update.version}...`);
    await update.download();
    await promptInstallAndRestart(update.version, () => update.install());
  } catch {
    setStatus("");
  }
}
