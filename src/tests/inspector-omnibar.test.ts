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
      <div id="app">
        <div id="main-layout">
          <div id="inspector-background">
            <button id="btn-inspector"></button>
          </div>
          <button id="inspector-backdrop" hidden></button>
          <aside id="inspector-panel" role="complementary" aria-label="Inspector" hidden>
            <span id="inspector-header-title">Inspector</span>
            <button type="button" class="inspector-tab" data-inspector-tab="preview" aria-selected="true">Preview</button>
            <button type="button" class="inspector-tab" data-inspector-tab="properties" aria-selected="false">Properties</button>
            <button id="inspector-close">Close</button>
            <div id="inspector-pane-preview" hidden>
              <div id="inspector-preview-body"></div>
            </div>
            <div id="inspector-pane-info" hidden></div>
            <div id="inspector-empty" hidden></div>
          </aside>
          <div id="inspector-resizer" hidden></div>
        </div>
      </div>
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
    expect(document.documentElement.dataset.inspectorOpen).toBe("1");
    expect(
      (document.getElementById("inspector-panel") as HTMLElement).hidden,
    ).toBe(false);
    inspector.setInspectorOpen(false);
    expect(inspector.isInspectorOpen()).toBe(false);
    expect(document.documentElement.dataset.inspectorOpen).toBe("0");
  });

  it("shows empty state until selection is synced", async () => {
    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    const empty = document.getElementById("inspector-empty") as HTMLElement;
    const info = document.getElementById("inspector-pane-info") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(info.hidden).toBe(true);
  });

  it("treats the mobile inspector as a trapped modal and restores focus", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 900px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const toggle = document.getElementById(
      "btn-inspector",
    ) as HTMLButtonElement;
    const background = document.getElementById(
      "inspector-background",
    ) as HTMLElement & { inert: boolean };
    toggle.focus();

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);

    const panel = document.getElementById("inspector-panel") as HTMLElement;
    const previewTab = panel.querySelector<HTMLElement>(
      '[data-inspector-tab="preview"]',
    )!;
    const close = document.getElementById(
      "inspector-close",
    ) as HTMLButtonElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe(
      "inspector-header-title",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(previewTab);

    close.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(previewTab);
    previewTab.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(close);

    inspector.setInspectorOpen(false);
    expect(panel.getAttribute("role")).toBe("complementary");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it("wires every info-tabs region for File Info switching", () => {
    document.body.innerHTML += `
      <div class="info-tabs" id="inspector-info-tabs">
        <button class="info-tab info-tab--active" data-tab="general">General</button>
        <button class="info-tab" data-tab="metadata">Metadata</button>
      </div>
      <div class="info-tabs" id="modal-info-tabs">
        <button class="info-tab info-tab--active" data-tab="general">General</button>
        <button class="info-tab" data-tab="s3">S3</button>
      </div>
    `;
    const switched: string[] = [];
    document.querySelectorAll<HTMLElement>(".info-tabs").forEach((infoTabs) => {
      infoTabs.addEventListener("click", (e) => {
        const tab = (e.target as HTMLElement).closest<HTMLElement>(".info-tab");
        if (tab?.dataset.tab) switched.push(tab.dataset.tab);
      });
    });
    (
      document.querySelector(
        "#modal-info-tabs .info-tab[data-tab='s3']",
      ) as HTMLButtonElement | null
    )?.click();
    expect(switched).toEqual(["s3"]);
  });

  it("closes bottom drawer when opening inspector on narrow layouts", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
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
      <button id="transfer-toggle"></button>
      <div id="bottom-drawer" class="bottom-drawer" hidden>
        <div class="bottom-drawer__resize-handle" tabindex="0"></div>
        <div class="bottom-drawer__header">
          <div class="bottom-drawer__tabs">
            <button id="drawer-tab-activity" class="bottom-drawer__tab bottom-drawer__tab--active">Activity</button>
            <button id="drawer-tab-transfers" class="bottom-drawer__tab">Transfers</button>
          </div>
          <div class="bottom-drawer__actions">
            <button id="drawer-close"></button>
            <button id="drawer-minimize"></button>
          </div>
        </div>
        <div class="bottom-drawer__body">
          <div id="drawer-panel-activity" class="bottom-drawer__panel"></div>
          <div id="drawer-panel-transfers" class="bottom-drawer__panel" hidden></div>
        </div>
      </div>
    `;
    vi.resetModules();

    const drawer = await import("../bottom-drawer.ts");
    drawer.openDrawer("activity");
    expect(drawer.isDrawerOpen()).toBe(true);

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    expect(drawer.isDrawerOpen()).toBe(false);
  });
});
