import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    <div id="palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette" hidden>
      <div class="palette">
        <div class="palette__input-wrap">
          <input id="palette-input" role="combobox" aria-label="Search commands" aria-expanded="false" aria-controls="palette-results" aria-autocomplete="list" aria-activedescendant="" />
        </div>
        <div id="palette-results" role="listbox" aria-label="Commands"></div>
      </div>
    </div>
    <input id="filter-input" />
  `;
}

describe("keyboard shortcuts", () => {
  let unwireKeyboard: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    renderFixture();
    unwireKeyboard = null;
  });

  afterEach(() => {
    unwireKeyboard?.();
    unwireKeyboard = null;
  });

  const defaultHandlers = () => ({
    setSidebarOpen: vi.fn(),
    handleDelete: vi.fn(async () => {}),
    handleRefresh: vi.fn(async () => {}),
    handleRename: vi.fn(async () => {}),
    handleUploadButton: vi.fn(async () => {}),
    handleUploadFolderButton: vi.fn(async () => {}),
    handleCreateFolder: vi.fn(async () => {}),
  });

  async function wireKeyboard(
    handlers = defaultHandlers(),
  ): Promise<typeof import("../keyboard.ts")> {
    const keyboard = await import("../keyboard.ts");
    unwireKeyboard?.();
    unwireKeyboard = keyboard.wireKeyboardShortcuts(handlers);
    return keyboard;
  }

  it("does not fire global refresh while command palette is open", async () => {
    const stateModule = await import("../state.ts");
    stateModule.state.platformName = "windows";

    const palette = await import("../command-palette.ts");
    palette.initPalette();
    palette.openPalette();

    const handlers = defaultHandlers();
    await wireKeyboard(handlers);

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

    await wireKeyboard();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(palette.isPaletteOpen()).toBe(false);
  });

  it("closes docked inspector with Escape", async () => {
    document.body.innerHTML += `
      <aside id="inspector-panel"></aside>
      <button id="btn-inspector"></button>
    `;
    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    expect(inspector.isInspectorOpen()).toBe(true);

    await wireKeyboard();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(inspector.isInspectorOpen()).toBe(false);
  });

  it("clears docked preview on Escape before closing inspector", async () => {
    document.body.innerHTML += `
      <aside id="inspector-panel"></aside>
      <button id="btn-inspector"></button>
      <div id="inspector-preview-body"></div>
    `;
    const { state } = await import("../state.ts");
    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    await inspector.syncInspectorFromSelection(state.selectedKeys);
    const previewBody = document.getElementById("inspector-preview-body");
    previewBody?.appendChild(document.createElement("pre"));
    inspector.markInspectorHasContent();

    await wireKeyboard();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(
      document.getElementById("inspector-preview-body")?.childElementCount,
    ).toBe(0);
    expect(inspector.isInspectorOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(inspector.isInspectorOpen()).toBe(false);
  });

  it("toggles inspector with Ctrl+Shift+I when connected", async () => {
    document.body.innerHTML += `
      <aside id="inspector-panel" hidden></aside>
      <button id="btn-inspector"></button>
    `;
    const { state } = await import("../state.ts");
    state.platformName = "windows";
    state.connected = true;

    const inspector = await import("../inspector.ts");
    await wireKeyboard();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "I", ctrlKey: true, shiftKey: true }),
    );
    expect(inspector.isInspectorOpen()).toBe(true);
  });

  it("blocks global refresh while support prompt is visible", async () => {
    const stateModule = await import("../state.ts");
    stateModule.state.platformName = "windows";

    const overlay = document.getElementById("support-overlay");
    overlay?.removeAttribute("hidden");

    const handlers = defaultHandlers();
    await wireKeyboard(handlers);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    expect(handlers.handleRefresh).not.toHaveBeenCalled();
  });
});
