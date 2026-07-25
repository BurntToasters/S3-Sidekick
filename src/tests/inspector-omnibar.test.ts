import { beforeEach, describe, expect, it, vi } from "vitest";

describe("location omnibar", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="location-omnibar" class="location-omnibar">
        <nav id="location-omnibar-browse" class="breadcrumb"></nav>
        <input id="location-omnibar-edit" type="text" hidden />
      </div>
      <button id="nav-up"></button>
      <span id="status"></span>
    `;
    vi.resetModules();
  });

  it("enters and exits edit mode", async () => {
    const browser = await import("../browser.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";

    browser.enterLocationEditMode();
    expect(browser.isLocationEditMode()).toBe(true);
    expect(
      (document.getElementById("location-omnibar-edit") as HTMLInputElement)
        .hidden,
    ).toBe(false);

    browser.exitLocationEditMode(true);
    expect(browser.isLocationEditMode()).toBe(false);
    expect(
      (document.getElementById("location-omnibar-browse") as HTMLElement)
        .hidden,
    ).toBe(false);
  });
});

describe("inspector chrome", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    document.body.innerHTML = `
      <div id="main-layout"></div>
      <aside id="inspector-panel" hidden></aside>
      <div id="inspector-resizer" hidden></div>
      <button id="inspector-backdrop" hidden></button>
      <button id="btn-inspector"></button>
      <div id="inspector-pane-preview" hidden></div>
      <div id="inspector-pane-info" hidden></div>
      <div id="inspector-empty" hidden></div>
      <div id="inspector-preview-body"></div>
      <div id="preview-body"></div>
      <div id="preview-overlay"></div>
    `;
    vi.resetModules();
  });

  it("toggles inspector open state on the panel", async () => {
    const inspector = await import("../inspector.ts");
    expect(inspector.isInspectorOpen()).toBe(false);
    inspector.setInspectorOpen(true);
    expect(inspector.isInspectorOpen()).toBe(true);
    expect(
      (document.getElementById("inspector-panel") as HTMLElement).hidden,
    ).toBe(false);
    inspector.setInspectorOpen(false);
    expect(inspector.isInspectorOpen()).toBe(false);
  });
});
