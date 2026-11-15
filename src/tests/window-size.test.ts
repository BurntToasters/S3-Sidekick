import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../settings-model.ts";

const mockSetSize = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockUnmaximize = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockMaximize = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockIsMaximized = vi.fn<() => Promise<boolean>>();
const mockInnerSize = vi.fn<() => Promise<{ width: number; height: number }>>();
const mockScaleFactor = vi.fn<() => Promise<number>>();
const mockGetCurrentWindow = vi.fn();
const mockSaveSettings = vi.fn<() => Promise<void>>();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mockGetCurrentWindow,
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock("../settings.ts", () => ({
  saveSettings: mockSaveSettings,
}));

describe("window size", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockSetSize.mockReset().mockResolvedValue(undefined);
    mockUnmaximize.mockReset().mockResolvedValue(undefined);
    mockMaximize.mockReset().mockResolvedValue(undefined);
    mockIsMaximized.mockReset().mockResolvedValue(false);
    mockInnerSize.mockReset();
    mockScaleFactor.mockReset();
    mockGetCurrentWindow.mockReset();
    mockSaveSettings.mockReset().mockResolvedValue(undefined);
    mockGetCurrentWindow.mockReturnValue({
      setSize: mockSetSize,
      unmaximize: mockUnmaximize,
      maximize: mockMaximize,
      isMaximized: mockIsMaximized,
      innerSize: mockInnerSize,
      scaleFactor: mockScaleFactor,
    });
    const { state } = await import("../state.ts");
    state.currentSettings = { ...SETTING_DEFAULTS };
    state.settingsExtras = {};
    document.body.innerHTML = `<div id="settings-overlay"></div>`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    const windowSize = await import("../window-size.ts");
    windowSize.resetWindowSizePersistence();
  });

  it("rounds fractional viewport sizes", async () => {
    const { roundWindowSize } = await import("../window-size.ts");
    expect(roundWindowSize(950.4, 699.6)).toEqual({ width: 950, height: 700 });
  });

  it("restores saved size after unmaximize", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 960;
    state.currentSettings.windowHeight = 640;
    const { restoreWindowSize } = await import("../window-size.ts");
    await restoreWindowSize();
    expect(mockUnmaximize).toHaveBeenCalledTimes(1);
    expect(mockSetSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 960, height: 640 }),
    );
  });

  it("skips restore for empty sizes", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 0;
    state.currentSettings.windowHeight = 0;
    const { restoreWindowSize } = await import("../window-size.ts");
    await restoreWindowSize();
    expect(mockSetSize).not.toHaveBeenCalled();
  });

  it("persists rounded logical size after debounce", async () => {
    vi.useFakeTimers();
    mockInnerSize.mockResolvedValue({ width: 1900.8, height: 1401.2 });
    mockScaleFactor.mockResolvedValue(2);
    const { state } = await import("../state.ts");
    const windowSize = await import("../window-size.ts");
    windowSize.enableWindowSizePersistence();
    windowSize.wireWindowSizePersistence();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(200);
    expect(mockSaveSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.currentSettings.windowWidth).toBe(950);
    expect(state.currentSettings.windowHeight).toBe(701);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it("persists the maximized flag but keeps the last normal size", async () => {
    vi.useFakeTimers();
    mockIsMaximized.mockResolvedValue(true);
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 1100;
    state.currentSettings.windowHeight = 720;
    const windowSize = await import("../window-size.ts");
    windowSize.enableWindowSizePersistence();
    windowSize.wireWindowSizePersistence();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.currentSettings.windowWidth).toBe(1100);
    expect(state.currentSettings.windowHeight).toBe(720);
    expect(state.settingsExtras.windowMaximized).toBe(true);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("clears the maximized flag once the window is restored to normal", async () => {
    vi.useFakeTimers();
    mockIsMaximized.mockResolvedValue(false);
    const { state } = await import("../state.ts");
    state.settingsExtras.windowMaximized = true;
    state.currentSettings.windowWidth = 1100;
    state.currentSettings.windowHeight = 720;
    const windowSize = await import("../window-size.ts");
    windowSize.enableWindowSizePersistence();
    windowSize.wireWindowSizePersistence();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.settingsExtras.windowMaximized).toBe(false);
    // Back to normal: the live normal size is recorded (jsdom reports innerWidth).
    expect(state.currentSettings.windowWidth).toBe(window.innerWidth);
  });

  it("maximizes again on launch when the last session ended maximized", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 1100;
    state.currentSettings.windowHeight = 720;
    state.settingsExtras.windowMaximized = true;
    const { restoreWindowSize } = await import("../window-size.ts");
    await restoreWindowSize();

    expect(mockSetSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1100, height: 720 }),
    );
    expect(mockMaximize).toHaveBeenCalledTimes(1);
  });

  it("ignores resize events until restore finishes", async () => {
    vi.useFakeTimers();
    mockInnerSize.mockResolvedValue({ width: 1800, height: 1200 });
    mockScaleFactor.mockResolvedValue(1);
    mockSetSize.mockImplementation(() => new Promise(() => undefined));
    const { state } = await import("../state.ts");
    state.currentSettings.windowWidth = 1100;
    state.currentSettings.windowHeight = 720;
    const windowSize = await import("../window-size.ts");
    windowSize.wireWindowSizePersistence();

    void windowSize.restoreWindowSize();
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(state.currentSettings.windowWidth).toBe(1100);
  });
});
