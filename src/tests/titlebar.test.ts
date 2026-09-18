import { describe, it, expect, beforeEach, vi } from "vitest";
import { state } from "../state.ts";
import { usesCustomTitlebar, wireTitlebar } from "../titlebar.ts";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
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

  it("wireTitlebar is a no-op on Linux", () => {
    state.platformName = "linux";
    wireTitlebar();
    expect(document.body.classList.contains("titlebar-custom")).toBe(false);
    const controls = document.getElementById("titlebar-win-controls");
    expect(controls?.hidden).toBe(true);
  });
});
