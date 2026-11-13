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

  it("closes the docked inspector on Escape, including while a preview is showing", async () => {
    document.body.innerHTML += `
      <aside id="inspector-panel"></aside>
      <button id="btn-inspector"></button>
      <div id="inspector-preview-body"></div>
    `;
    const selection = await import("../app-selection.ts");
    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    await inspector.syncInspectorFromSelection(selection.getSelectionEntries());
    const previewBody = document.getElementById("inspector-preview-body");
    previewBody?.appendChild(document.createElement("pre"));
    inspector.markInspectorHasContent();

    await wireKeyboard();

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

  it("ignores connected-only shortcuts when disconnected and routes Ctrl+F to saved connection filter", async () => {
    document.body.innerHTML += `
      <div id="location-omnibar" data-editing="false">
        <button id="location-edit-btn" type="button">Edit</button>
        <input id="location-input" hidden />
      </div>
      <input id="conn-saved-filter" />
    `;
    const { state } = await import("../state.ts");
    state.platformName = "windows";
    state.connected = false;

    const browser = await import("../browser.ts");
    const enterLocationSpy = vi.spyOn(browser, "enterLocationEditMode");

    const handlers = defaultHandlers();
    await wireKeyboard(handlers);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "l", ctrlKey: true }),
    );
    expect(enterLocationSpy).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" }));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "u", ctrlKey: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true }),
    );
    expect(handlers.handleRefresh).not.toHaveBeenCalled();
    expect(handlers.handleRename).not.toHaveBeenCalled();
    expect(handlers.handleUploadButton).not.toHaveBeenCalled();
    expect(handlers.handleCreateFolder).not.toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true }),
    );
    expect(document.activeElement?.id).toBe("conn-saved-filter");
  });
});

describe("shortcut key chips and groups", () => {
  // Failure modes checked before implementation:
  // - A combo label such as "⌘⇧U" is kept as one chip instead of one per key.
  // - A key name with a space (Page Up, Type letters) is split on the space.
  // - A "+" separator is left inside a chip, such as "Ctrl+Shift".
  // - An entry with no group disappears from the grouped dialog list.
  it("splits a key label into one chip per key", async () => {
    const catalog = await import("../shortcut-catalog.ts");

    expect(catalog.shortcutKeyChips("⌘⇧U")).toEqual(["⌘", "⇧", "U"]);
    expect(catalog.shortcutKeyChips("⌘⌫")).toEqual(["⌘", "⌫"]);
    expect(catalog.shortcutKeyChips("⌥↑")).toEqual(["⌥", "↑"]);
    expect(catalog.shortcutKeyChips("⇧F10")).toEqual(["⇧", "F10"]);
    expect(catalog.shortcutKeyChips("Ctrl+Shift+U")).toEqual([
      "Ctrl",
      "Shift",
      "U",
    ]);
    expect(catalog.shortcutKeyChips("Ctrl+/")).toEqual(["Ctrl", "/"]);
    expect(catalog.shortcutKeyChips("Page Up")).toEqual(["Page Up"]);
    expect(catalog.shortcutKeyChips("Type letters")).toEqual(["Type letters"]);
    expect(catalog.shortcutKeyChips("Escape")).toEqual(["Escape"]);
  });

  it("groups every shortcut once, under a heading, in a stable order", async () => {
    const catalog = await import("../shortcut-catalog.ts");

    const groups = catalog.shortcutGroups();
    const grouped = groups.flatMap((group) => group.entries);
    expect(grouped.length).toBe(catalog.SHORTCUTS.length);
    expect(new Set(grouped.map((entry) => entry.action)).size).toBe(
      catalog.SHORTCUTS.length,
    );
    for (const group of groups) {
      expect(group.entries.length).toBeGreaterThan(0);
    }
    expect(groups.map((group) => group.title)).toEqual(
      catalog.SHORTCUT_GROUPS.filter((title) =>
        groups.some((group) => group.title === title),
      ),
    );
  });
});

describe("shortcut catalog", () => {
  it("shows Command labels on macOS and Ctrl labels elsewhere", async () => {
    const catalog = await import("../shortcut-catalog.ts");

    const mac = catalog.shortcutListText("macos");
    expect(mac).toContain("⌘K");
    expect(mac).toContain("⌘/");
    expect(mac).not.toContain("Ctrl+");

    for (const platform of ["windows", "linux", ""]) {
      const other = catalog.shortcutListText(platform);
      expect(other).toContain("Ctrl+K");
      expect(other).toContain("Ctrl+/");
      expect(other).not.toContain("⌘");
    }
  });

  it("lists the shortcuts the handler supports, with F5 and Escape", async () => {
    const catalog = await import("../shortcut-catalog.ts");
    const lines = catalog.shortcutListText("windows").split("\n");

    expect(lines.some((line) => line.includes("F5"))).toBe(true);
    expect(lines.some((line) => line.includes("F2"))).toBe(true);
    expect(lines.some((line) => line.includes("Alt+←"))).toBe(true);
    expect(lines.some((line) => line.includes("Alt+→"))).toBe(true);
    expect(lines.some((line) => line.includes("Escape"))).toBe(true);
  });

  it("has one entry per action and a key label on every platform", async () => {
    const catalog = await import("../shortcut-catalog.ts");

    const actions = catalog.SHORTCUTS.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const entry of catalog.SHORTCUTS) {
      expect(entry.macos.length).toBeGreaterThan(0);
      expect(entry.other.length).toBeGreaterThan(0);
    }
  });
});
