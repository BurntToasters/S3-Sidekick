import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { state } from "./state.ts";
import { saveSettings } from "./settings.ts";

const PERSIST_DEBOUNCE_MS = 500;

let persistEnabled = false;
let persistWired = false;
let persistTimeout: number | undefined;

type WindowHandle = {
  setSize: (size: LogicalSize) => Promise<void>;
  unmaximize?: () => Promise<void>;
  isMaximized?: () => Promise<boolean>;
  innerSize?: () => Promise<{ width: number; height: number }>;
  scaleFactor?: () => Promise<number>;
};

function currentWindow(): WindowHandle {
  return getCurrentWindow() as unknown as WindowHandle;
}

export function enableWindowSizePersistence(): void {
  persistEnabled = true;
}

export function disableWindowSizePersistence(): void {
  persistEnabled = false;
}

export function roundWindowSize(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

export async function readLogicalWindowSize(): Promise<{
  width: number;
  height: number;
} | null> {
  try {
    const win = currentWindow();
    if (typeof win.isMaximized === "function" && (await win.isMaximized())) {
      // Keep the last restored/resized normal size instead of persisting a
      // zoomed/maximized frame as the next launch default.
      return null;
    }
    if (
      typeof win.innerSize === "function" &&
      typeof win.scaleFactor === "function"
    ) {
      const physical = await win.innerSize();
      const scale = await win.scaleFactor();
      if (
        Number.isFinite(physical.width) &&
        Number.isFinite(physical.height) &&
        Number.isFinite(scale) &&
        scale > 0
      ) {
        return roundWindowSize(physical.width / scale, physical.height / scale);
      }
    }
  } catch {
    // Fall through to the viewport size.
  }
  return roundWindowSize(window.innerWidth, window.innerHeight);
}

async function persistCurrentWindowSize(): Promise<void> {
  if (!persistEnabled) return;
  if (
    document.getElementById("settings-overlay")?.classList.contains("active")
  ) {
    const size = await readLogicalWindowSize();
    if (size) {
      state.currentSettings.windowWidth = size.width;
      state.currentSettings.windowHeight = size.height;
    }
    return;
  }
  const size = await readLogicalWindowSize();
  if (!size) return;
  state.currentSettings.windowWidth = size.width;
  state.currentSettings.windowHeight = size.height;
  try {
    await saveSettings();
  } catch (err) {
    console.warn("Failed to save window size settings:", err);
  }
}

function schedulePersistWindowSize(): void {
  if (persistTimeout) {
    window.clearTimeout(persistTimeout);
  }
  persistTimeout = window.setTimeout(() => {
    persistTimeout = undefined;
    void persistCurrentWindowSize();
  }, PERSIST_DEBOUNCE_MS);
}

export function wireWindowSizePersistence(): void {
  if (persistWired) return;
  persistWired = true;
  window.addEventListener("resize", schedulePersistWindowSize);
}

export function resetWindowSizePersistence(): void {
  persistEnabled = false;
  persistWired = false;
  if (persistTimeout !== undefined) {
    window.clearTimeout(persistTimeout);
    persistTimeout = undefined;
  }
  window.removeEventListener("resize", schedulePersistWindowSize);
}

export async function restoreWindowSize(): Promise<void> {
  disableWindowSizePersistence();
  try {
    const { windowWidth, windowHeight } = state.currentSettings;
    if (!windowWidth || !windowHeight) return;
    const win = currentWindow();
    try {
      if (typeof win.unmaximize === "function") {
        await win.unmaximize();
      }
    } catch {
      // Best effort: still apply the saved size if unmaximize is unavailable.
    }
    await win.setSize(new LogicalSize(windowWidth, windowHeight));
  } catch (err) {
    console.warn("Failed to restore window size:", err);
  } finally {
    enableWindowSizePersistence();
  }
}
