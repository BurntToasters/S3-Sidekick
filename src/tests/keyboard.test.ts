import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="main-layout"></div>
    <div id="preview-overlay"></div>
    <div id="info-overlay"></div>
    <div id="licenses-overlay"></div>
    <div id="settings-overlay"></div>
    <div id="support-overlay" hidden>
      <button id="support-no" type="button">No</button>
    </div>
    <div id="palette-overlay" hidden>
      <div class="palette">
        <div class="palette__input-wrap">
          <input id="palette-input" />
        </div>
        <div id="palette-results"></div>
      </div>
    </div>
    <input id="filter-input" />
  `;
}

describe("keyboard shortcuts", () => {
  beforeEach(() => {
    vi.resetModules();
    renderFixture();
  });

  it("does not fire global refresh while command palette is open", async () => {
    const stateModule = await import("../state.ts");
    stateModule.state.platformName = "windows";

    const palette = await import("../command-palette.ts");
    palette.initPalette();
    palette.openPalette();

    const keyboard = await import("../keyboard.ts");
    const handlers = {
      setSidebarOpen: vi.fn(),
      handleDelete: vi.fn(async () => {}),
      handleRefresh: vi.fn(async () => {}),
      handleRename: vi.fn(async () => {}),
      handleUploadButton: vi.fn(async () => {}),
      handleUploadFolderButton: vi.fn(async () => {}),
      handleCreateFolder: vi.fn(async () => {}),
    };
    keyboard.wireKeyboardShortcuts(handlers);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    expect(handlers.handleRefresh).not.toHaveBeenCalled();
  });

  it("closes palette with Escape when open", async () => {
    const stateModule = await import("../state.ts");
    stateModule.state.platformName = "windows";

    const palette = await import("../command-palette.ts");
    palette.initPalette();
    palette.openPalette();
    expect(palette.isPaletteOpen()).toBe(true);

    const keyboard = await import("../keyboard.ts");
    const handlers = {
      setSidebarOpen: vi.fn(),
      handleDelete: vi.fn(async () => {}),
      handleRefresh: vi.fn(async () => {}),
      handleRename: vi.fn(async () => {}),
      handleUploadButton: vi.fn(async () => {}),
      handleUploadFolderButton: vi.fn(async () => {}),
      handleCreateFolder: vi.fn(async () => {}),
    };
    keyboard.wireKeyboardShortcuts(handlers);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(palette.isPaletteOpen()).toBe(false);
  });

  it("blocks global refresh while support prompt is visible", async () => {
    const stateModule = await import("../state.ts");
    stateModule.state.platformName = "windows";

    const overlay = document.getElementById("support-overlay");
    overlay?.removeAttribute("hidden");

    const keyboard = await import("../keyboard.ts");
    const handlers = {
      setSidebarOpen: vi.fn(),
      handleDelete: vi.fn(async () => {}),
      handleRefresh: vi.fn(async () => {}),
      handleRename: vi.fn(async () => {}),
      handleUploadButton: vi.fn(async () => {}),
      handleUploadFolderButton: vi.fn(async () => {}),
      handleCreateFolder: vi.fn(async () => {}),
    };
    keyboard.wireKeyboardShortcuts(handlers);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    expect(handlers.handleRefresh).not.toHaveBeenCalled();
  });
});
