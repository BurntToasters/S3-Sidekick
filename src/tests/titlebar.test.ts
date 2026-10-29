import { describe, it, expect, beforeEach, vi } from "vitest";
import { state } from "../state.ts";
import { usesCustomTitlebar, wireTitlebar } from "../titlebar.ts";

const windowMock = vi.hoisted(() => ({
  maximized: false,
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: windowMock.toggleMaximize,
    isMaximized: windowMock.isMaximized,
    close: vi.fn(),
    startDragging: vi.fn(),
  }),
}));

describe("titlebar", () => {
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = `
      <header class="header">
        <div class="titlebar__main">
          <div id="bookmark-bar" class="bookmark-bar"></div>
        </div>
        <div class="header__actions"></div>
        <div id="titlebar-win-controls" hidden></div>
      </header>
    `;
    state.platformName = "";
  });

  it("usesCustomTitlebar is true only on macOS and Windows", () => {
    state.platformName = "linux";
    expect(usesCustomTitlebar()).toBe(false);
    state.platformName = "macos";
    expect(usesCustomTitlebar()).toBe(true);
    state.platformName = "windows";
    expect(usesCustomTitlebar()).toBe(true);
  });

  it("wireTitlebar enables custom chrome on Windows", () => {
    state.platformName = "windows";
    wireTitlebar();
    expect(document.body.classList.contains("titlebar-custom")).toBe(true);
    const header = document.querySelector(".header");
    expect(header?.hasAttribute("data-tauri-drag-region")).toBe(true);
    const controls = document.getElementById("titlebar-win-controls");
    expect(controls?.hidden).toBe(false);
  });

  it("Windows maximize button announces Restore while the window is maximized", async () => {
    state.platformName = "windows";
    document.body.innerHTML = `
      <header class="header">
        <div class="titlebar__main">
          <div id="bookmark-bar" class="bookmark-bar"></div>
        </div>
        <div class="header__actions"></div>
        <div id="titlebar-win-controls" hidden>
          <button id="titlebar-minimize" aria-label="Minimize" title="Minimize"></button>
          <button id="titlebar-maximize" aria-label="Maximize" title="Maximize"></button>
          <button id="titlebar-close" aria-label="Close" title="Close"></button>
        </div>
      </header>
    `;
    windowMock.maximized = false;
    windowMock.isMaximized.mockImplementation(async () => windowMock.maximized);
    windowMock.toggleMaximize.mockImplementation(async () => {
      windowMock.maximized = !windowMock.maximized;
    });
    wireTitlebar();
    const maximize = document.getElementById("titlebar-maximize")!;
    await vi.waitFor(() => {
      expect(maximize.getAttribute("aria-label")).toBe("Maximize");
    });

    maximize.click();
    await vi.waitFor(() => {
      expect(maximize.getAttribute("aria-label")).toBe("Restore");
    });
    expect(maximize.getAttribute("title")).toBe("Restore");
    expect(maximize.querySelector("svg")).not.toBeNull();
  });

  it("wireTitlebar is a no-op on Linux", () => {
    state.platformName = "linux";
    wireTitlebar();
    expect(document.body.classList.contains("titlebar-custom")).toBe(false);
    const controls = document.getElementById("titlebar-win-controls");
    expect(controls?.hidden).toBe(true);
  });
});
