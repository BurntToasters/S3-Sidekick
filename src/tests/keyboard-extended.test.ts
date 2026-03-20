import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHideContextMenu = vi.fn();
const mockIsDialogActive = vi.fn();
const mockClosePreview = vi.fn();
const mockCloseInfoPanel = vi.fn();
const mockCloseLicensesModal = vi.fn();
const mockCloseDrawer = vi.fn();
const mockIsDrawerOpen = vi.fn();
const mockCloseSettingsModal = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockOpenPalette = vi.fn();
const mockClosePalette = vi.fn();
const mockIsPaletteOpen = vi.fn();
const mockNavigateUp = vi.fn<() => Promise<void>>();
const mockNavigateBack = vi.fn<() => Promise<void>>();
const mockNavigateForward = vi.fn<() => Promise<void>>();
const mockGetSelectableKeys = vi.fn();
const mockUpdateSelectionUI = vi.fn();

vi.mock("../context-menu.ts", () => ({
  hideContextMenu: mockHideContextMenu,
}));

vi.mock("../dialogs.ts", () => ({
  isDialogActive: mockIsDialogActive,
}));

vi.mock("../preview.ts", () => ({
  closePreview: mockClosePreview,
}));

vi.mock("../info-panel.ts", () => ({
  closeInfoPanel: mockCloseInfoPanel,
}));

vi.mock("../licenses.ts", () => ({
  closeLicensesModal: mockCloseLicensesModal,
}));

vi.mock("../bottom-drawer.ts", () => ({
  closeDrawer: mockCloseDrawer,
  isDrawerOpen: mockIsDrawerOpen,
}));

vi.mock("../settings.ts", () => ({
  closeSettingsModal: mockCloseSettingsModal,
}));

vi.mock("../command-palette.ts", () => ({
  openPalette: mockOpenPalette,
  closePalette: mockClosePalette,
  isPaletteOpen: mockIsPaletteOpen,
}));

vi.mock("../browser.ts", () => ({
  navigateUp: mockNavigateUp,
  navigateBack: mockNavigateBack,
  navigateForward: mockNavigateForward,
  getSelectableKeys: mockGetSelectableKeys,
  updateSelectionUI: mockUpdateSelectionUI,
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="main-layout"></div>
    <div id="preview-overlay"></div>
    <div id="info-overlay"></div>
    <div id="licenses-overlay"></div>
    <div id="settings-overlay"></div>
    <div id="support-overlay" hidden>
      <button id="support-no" type="button">Dismiss</button>
    </div>
    <input id="filter-input" />
  `;
}

function createHandlers() {
  return {
    setSidebarOpen: vi.fn(),
    handleDelete: vi.fn(async () => {}),
    handleRefresh: vi.fn(async () => {}),
    handleRename: vi.fn(async () => {}),
    handleUploadButton: vi.fn(async () => {}),
    handleUploadFolderButton: vi.fn(async () => {}),
    handleCreateFolder: vi.fn(async () => {}),
  };
}

describe("keyboard shortcuts extended", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHideContextMenu.mockReset();
    mockIsDialogActive.mockReset();
    mockClosePreview.mockReset();
    mockCloseInfoPanel.mockReset();
    mockCloseLicensesModal.mockReset();
    mockCloseDrawer.mockReset();
    mockIsDrawerOpen.mockReset();
    mockCloseSettingsModal.mockReset();
    mockOpenPalette.mockReset();
    mockClosePalette.mockReset();
    mockIsPaletteOpen.mockReset();
    mockNavigateUp.mockReset();
    mockNavigateBack.mockReset();
    mockNavigateForward.mockReset();
    mockGetSelectableKeys.mockReset();
    mockUpdateSelectionUI.mockReset();

    mockIsDialogActive.mockReturnValue(false);
    mockIsDrawerOpen.mockReturnValue(false);
    mockIsPaletteOpen.mockReturnValue(false);
    mockCloseSettingsModal.mockResolvedValue(undefined);
    mockNavigateUp.mockResolvedValue(undefined);
    mockNavigateBack.mockResolvedValue(undefined);
    mockNavigateForward.mockResolvedValue(undefined);
    mockGetSelectableKeys.mockReturnValue(["file-a.txt", "file-b.txt"]);

    renderFixture();
    const { state } = await import("../state.ts");
    state.platformName = "windows";
    state.selectedKeys.clear();
  });

  it("handles Escape overlays in precedence order", async () => {
    const keyboard = await import("../keyboard.ts");
    const handlers = createHandlers();
    keyboard.wireKeyboardShortcuts(handlers);

    const preview = document.getElementById(
      "preview-overlay",
    ) as HTMLDivElement;
    const info = document.getElementById("info-overlay") as HTMLDivElement;
    const licenses = document.getElementById(
      "licenses-overlay",
    ) as HTMLDivElement;
    const layout = document.getElementById("main-layout") as HTMLDivElement;
    const settings = document.getElementById(
      "settings-overlay",
    ) as HTMLDivElement;

    preview.classList.add("active");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockClosePreview).toHaveBeenCalled();

    preview.classList.remove("active");
    info.classList.add("active");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockCloseInfoPanel).toHaveBeenCalled();

    info.classList.remove("active");
    licenses.classList.add("active");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockCloseLicensesModal).toHaveBeenCalled();

    licenses.classList.remove("active");
    mockIsDrawerOpen.mockReturnValue(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockCloseDrawer).toHaveBeenCalled();
    mockIsDrawerOpen.mockReturnValue(false);

    layout.classList.add("main-layout--sidebar-open");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.setSidebarOpen).toHaveBeenCalledWith(false);

    layout.classList.remove("main-layout--sidebar-open");
    settings.classList.add("active");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockCloseSettingsModal).toHaveBeenCalledWith(false);
  });

  it("fires accel/navigation shortcuts and select-all behavior", async () => {
    const { state } = await import("../state.ts");
    const keyboard = await import("../keyboard.ts");
    const handlers = createHandlers();
    keyboard.wireKeyboardShortcuts(handlers);

    state.selectedKeys.add("one.txt");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(handlers.handleDelete).toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    expect(handlers.handleRefresh).toHaveBeenCalled();

    state.selectedKeys.clear();
    state.selectedKeys.add("one.txt");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" }));
    expect(handlers.handleRename).toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }),
    );
    expect(mockNavigateUp).toHaveBeenCalled();
    expect(mockNavigateBack).toHaveBeenCalled();
    expect(mockNavigateForward).toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true }),
    );
    expect(state.selectedKeys.has("file-a.txt")).toBe(true);
    expect(state.selectedKeys.has("file-b.txt")).toBe(true);
    expect(mockUpdateSelectionUI).toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "u", ctrlKey: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "u", ctrlKey: true, shiftKey: true }),
    );
    expect(handlers.handleUploadButton).toHaveBeenCalled();
    expect(handlers.handleUploadFolderButton).toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true }),
    );
    expect(handlers.handleCreateFolder).toHaveBeenCalled();

    const filter = document.getElementById("filter-input") as HTMLInputElement;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true }),
    );
    expect(document.activeElement).toBe(filter);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
    );
    expect(mockOpenPalette).toHaveBeenCalled();
  });

  it("blocks selected shortcuts in palette/modal/input contexts", async () => {
    const { state } = await import("../state.ts");
    const keyboard = await import("../keyboard.ts");
    const handlers = createHandlers();
    keyboard.wireKeyboardShortcuts(handlers);

    mockIsPaletteOpen.mockReturnValue(true);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
    );
    expect(mockClosePalette).toHaveBeenCalled();

    const input = document.getElementById("filter-input") as HTMLInputElement;
    input.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true }),
    );
    expect(mockUpdateSelectionUI).not.toHaveBeenCalled();

    input.blur();
    state.selectedKeys.add("x.txt");
    (
      document.getElementById("settings-overlay") as HTMLDivElement
    ).classList.add("active");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(handlers.handleDelete).not.toHaveBeenCalled();

    const supportOverlay = document.getElementById(
      "support-overlay",
    ) as HTMLDivElement;
    supportOverlay.removeAttribute("hidden");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
    expect(handlers.handleRefresh).not.toHaveBeenCalled();
  });

  it("uses Command on macOS for accel detection", async () => {
    const { state } = await import("../state.ts");
    const keyboard = await import("../keyboard.ts");
    state.platformName = "macos";

    expect(
      keyboard.hasAccelModifier(
        new KeyboardEvent("keydown", { metaKey: true, ctrlKey: false }),
      ),
    ).toBe(true);
    expect(
      keyboard.hasAccelModifier(
        new KeyboardEvent("keydown", { metaKey: false, ctrlKey: true }),
      ),
    ).toBe(false);
  });
});
