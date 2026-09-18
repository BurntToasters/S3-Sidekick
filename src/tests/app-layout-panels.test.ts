import { beforeEach, describe, expect, it, vi } from "vitest";

function rect(width: number): DOMRect {
  return {
    width,
    height: 0,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderFixture(): void {
  document.body.innerHTML = `
    <div id="main-layout">
      <button id="sidebar-backdrop" hidden></button>
      <aside id="bucket-panel"></aside>
      <div id="sidebar-resizer" role="separator"></div>
      <div class="content">
        <div class="content-body">
          <div class="content-main"></div>
          <div id="inspector-resizer" role="separator" hidden></div>
          <aside id="inspector-panel" hidden></aside>
        </div>
      </div>
      <button id="sidebar-toggle"></button>
    </div>
  `;
}

describe("desktop panel width preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    renderFixture();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    const layout = document.getElementById("main-layout")!;
    const sidebar = document.getElementById("bucket-panel")!;
    const sidebarResizer = document.getElementById("sidebar-resizer")!;
    const inspector = document.getElementById("inspector-panel")!;
    const inspectorResizer = document.getElementById("inspector-resizer")!;
    vi.spyOn(layout, "getBoundingClientRect").mockImplementation(() =>
      rect(window.innerWidth),
    );
    vi.spyOn(sidebar, "getBoundingClientRect").mockImplementation(() =>
      rect(
        Number.parseFloat(
          document.documentElement.style.getPropertyValue("--sidebar-width"),
        ) || 240,
      ),
    );
    vi.spyOn(sidebarResizer, "getBoundingClientRect").mockReturnValue(rect(8));
    vi.spyOn(inspector, "getBoundingClientRect").mockImplementation(() =>
      rect(
        Number.parseFloat(
          document.documentElement.style.getPropertyValue("--inspector-width"),
        ) || 360,
      ),
    );
    vi.spyOn(inspectorResizer, "getBoundingClientRect").mockReturnValue(
      rect(8),
    );
  });

  // The browser layout harness owns pixel geometry checks. This unit fixture
  // covers the reduction order and preference bookkeeping around the layout
  // coordinator without treating jsdom as a layout engine.
  it("shrinks the inspector first, then the sidebar, without changing preferences", async () => {
    localStorage.setItem("s3-sidekick.sidebar.width", "420");
    localStorage.setItem("s3-sidekick.inspector.width", "560");

    const layout = await import("../app-layout.ts");
    layout.wireLayoutControls();
    layout.wireInspectorControls();
    document.getElementById("inspector-panel")!.removeAttribute("hidden");
    document.getElementById("inspector-resizer")!.removeAttribute("hidden");
    layout.syncPanelWidths();

    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("280px");
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("344px");
    expect(localStorage.getItem("s3-sidekick.sidebar.width")).toBe("420");
    expect(localStorage.getItem("s3-sidekick.inspector.width")).toBe("560");
    expect(
      document
        .getElementById("inspector-resizer")
        ?.getAttribute("aria-valuenow"),
    ).toBe("280");
  });

  it("restores preferred widths when the viewport has room again", async () => {
    localStorage.setItem("s3-sidekick.sidebar.width", "420");
    localStorage.setItem("s3-sidekick.inspector.width", "560");

    const layout = await import("../app-layout.ts");
    layout.wireLayoutControls();
    layout.wireInspectorControls();
    document.getElementById("inspector-panel")!.removeAttribute("hidden");
    document.getElementById("inspector-resizer")!.removeAttribute("hidden");
    layout.syncPanelWidths();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    layout.syncPanelWidths();

    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("560px");
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("420px");
  });

  it("anchors resizer input to fitted widths and preserves new preferences", async () => {
    localStorage.setItem("s3-sidekick.sidebar.width", "420");
    localStorage.setItem("s3-sidekick.inspector.width", "560");

    const layout = await import("../app-layout.ts");
    layout.wireLayoutControls();
    layout.wireInspectorControls();

    const inspector = document.getElementById("inspector-panel")!;
    const inspectorResizer = document.getElementById("inspector-resizer")!;
    const sidebarResizer = document.getElementById("sidebar-resizer")!;
    const contentMain = document.querySelector<HTMLElement>(".content-main")!;
    inspector.removeAttribute("hidden");
    inspectorResizer.removeAttribute("hidden");

    vi.spyOn(contentMain, "getBoundingClientRect").mockImplementation(() => {
      const width = (name: string, fallback: number): number =>
        Number.parseFloat(
          document.documentElement.style.getPropertyValue(name),
        ) || fallback;
      const sidebarWidth = width("--sidebar-width", 240);
      const inspectorWidth = width("--inspector-width", 360);
      const inspectorVisible = !inspector.hidden;
      return rect(
        window.innerWidth -
          sidebarWidth -
          8 -
          (inspectorVisible ? inspectorWidth + 8 : 0),
      );
    });

    // No resize event is dispatched: fitting must happen as the resizer
    // interaction itself updates the preferred width.
    layout.syncPanelWidths();
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("344px");
    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("280px");

    // Begin from the visible fitted sidebar (344px), then shrink it by 40px.
    // The preferred 420px value must not make the handle appear stuck.
    sidebarResizer.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 60 }),
    );

    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("304px");
    expect(contentMain.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      360,
    );
    expect(sidebarResizer.getAttribute("aria-valuenow")).toBe("304");
    expect(localStorage.getItem("s3-sidekick.sidebar.width")).toBe("420");

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(localStorage.getItem("s3-sidekick.sidebar.width")).toBe("304");

    // The inspector is now visibly fitted to 320px. Shrinking from that
    // effective width must move it immediately and save 280px on release.
    inspectorResizer.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 500,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 540 }),
    );
    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("280px");
    expect(contentMain.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      360,
    );
    expect(inspectorResizer.getAttribute("aria-valuenow")).toBe("280");
    expect(localStorage.getItem("s3-sidekick.inspector.width")).toBe("560");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(localStorage.getItem("s3-sidekick.inspector.width")).toBe("280");

    // Arrow keys use the visible fitted width as their anchor too.
    sidebarResizer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("288px");
    expect(sidebarResizer.getAttribute("aria-valuenow")).toBe("288");
    expect(localStorage.getItem("s3-sidekick.sidebar.width")).toBe("288");

    inspectorResizer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("296px");
    expect(inspectorResizer.getAttribute("aria-valuenow")).toBe("296");
    expect(localStorage.getItem("s3-sidekick.inspector.width")).toBe("296");

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    layout.syncPanelWidths();
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("288px");
    expect(
      document.documentElement.style.getPropertyValue("--inspector-width"),
    ).toBe("296px");
  });
});
