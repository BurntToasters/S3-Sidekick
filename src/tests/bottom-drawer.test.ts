import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <button id="transfer-toggle"></button>
    <div id="bottom-drawer" class="bottom-drawer" hidden>
      <div class="bottom-drawer__resize-handle" tabindex="0"></div>
      <div class="bottom-drawer__header">
        <div class="bottom-drawer__tabs">
          <button class="bottom-drawer__tab bottom-drawer__tab--active" id="drawer-tab-activity" role="tab" aria-selected="true" aria-controls="drawer-panel-activity" tabindex="0">Activity <span id="drawer-activity-badge" class="drawer-badge"></span></button>
          <button class="bottom-drawer__tab" id="drawer-tab-transfers" role="tab" aria-selected="false" aria-controls="drawer-panel-transfers" tabindex="-1">Transfers <span id="drawer-transfer-badge" class="drawer-badge"></span></button>
        </div>
        <div class="bottom-drawer__actions">
          <button id="drawer-clear">Clear</button>
          <button id="drawer-minimize"></button>
          <button id="drawer-close"></button>
        </div>
      </div>
      <div class="bottom-drawer__body">
        <div id="drawer-panel-activity" class="bottom-drawer__panel"></div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" hidden></div>
      </div>
    </div>
  `;
}

describe("bottom drawer", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.removeItem("drawer-height");
    renderFixture();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  });

  it("opens, switches tabs, minimizes, and closes", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();

    drawer.openDrawer("activity");
    expect(drawer.isDrawerOpen()).toBe(true);
    expect(drawer.getActiveTab()).toBe("activity");
    expect(
      (
        document.getElementById("activity-toggle") as HTMLButtonElement
      ).getAttribute("aria-expanded"),
    ).toBe("true");

    drawer.switchDrawerTab("transfers");
    expect(drawer.getActiveTab()).toBe("transfers");
    expect(
      (document.getElementById("drawer-panel-transfers") as HTMLDivElement)
        .hidden,
    ).toBe(false);
    expect(
      (document.getElementById("drawer-clear") as HTMLButtonElement)
        .textContent,
    ).toBe("Clear done");

    (document.getElementById("drawer-minimize") as HTMLButtonElement).click();
    expect(
      (
        document.getElementById("bottom-drawer") as HTMLDivElement
      ).classList.contains("bottom-drawer--minimized"),
    ).toBe(true);
    (document.getElementById("drawer-minimize") as HTMLButtonElement).click();
    expect(
      (
        document.getElementById("bottom-drawer") as HTMLDivElement
      ).classList.contains("bottom-drawer--minimized"),
    ).toBe(false);

    drawer.toggleDrawer("transfers");
    expect(drawer.isDrawerOpen()).toBe(false);
    drawer.toggleDrawer("activity");
    expect(drawer.isDrawerOpen()).toBe(true);

    (document.getElementById("drawer-close") as HTMLButtonElement).click();
    expect(drawer.isDrawerOpen()).toBe(false);
  });

  it("resizes with mouse drag and keyboard shortcuts and persists height", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("activity");

    const drawerEl = document.getElementById("bottom-drawer") as HTMLDivElement;
    const handle = drawerEl.querySelector(
      ".bottom-drawer__resize-handle",
    ) as HTMLDivElement;
    vi.spyOn(drawerEl, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 240,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    } as DOMRect);

    handle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientY: 500,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientY: 450 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(localStorage.getItem("drawer-height")).toBeTruthy();
    expect(drawerEl.style.height).not.toBe("");

    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(drawerEl.style.height).toBe("120px");
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(parseInt(drawerEl.style.height, 10)).toBeLessThanOrEqual(450);
  });

  it("covers tab click wiring and no-op guards when drawer elements are missing", async () => {
    const drawer = await import("../bottom-drawer.ts");

    document.body.innerHTML = "";
    drawer.initDrawer();
    drawer.openDrawer("activity");
    drawer.closeDrawer();

    renderFixture();
    drawer.initDrawer();

    (
      document.getElementById("drawer-tab-transfers") as HTMLButtonElement
    ).click();
    expect(drawer.getActiveTab()).toBe("transfers");
    (
      document.getElementById("drawer-tab-activity") as HTMLButtonElement
    ).click();
    expect(drawer.getActiveTab()).toBe("activity");

    const drawerEl = document.getElementById("bottom-drawer") as HTMLDivElement;
    const handle = drawerEl.querySelector(
      ".bottom-drawer__resize-handle",
    ) as HTMLDivElement;
    const beforeHeight = drawerEl.style.height;
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
    );
    expect(drawerEl.style.height).toBe(beforeHeight);

    document.getElementById("drawer-clear")?.remove();
    drawer.updateClearButton();

    const minimize = document.getElementById(
      "drawer-minimize",
    ) as HTMLButtonElement;
    drawerEl.remove();
    minimize.click();
  });

  it("uses persisted drawer height, shift-resize step, and handles missing optional controls", async () => {
    vi.resetModules();
    localStorage.setItem("drawer-height", "300");
    renderFixture();

    const drawer = await import("../bottom-drawer.ts");
    (
      document.querySelector(".bottom-drawer__resize-handle") as HTMLElement
    ).remove();
    drawer.initDrawer();
    drawer.openDrawer("activity");
    expect(
      (document.getElementById("bottom-drawer") as HTMLDivElement).style.height,
    ).toBe("300px");

    renderFixture();
    drawer.initDrawer();
    const drawerEl = document.getElementById("bottom-drawer") as HTMLDivElement;
    const handle = drawerEl.querySelector(
      ".bottom-drawer__resize-handle",
    ) as HTMLDivElement;
    handle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(parseInt(drawerEl.style.height, 10)).toBeGreaterThanOrEqual(340);

    document.getElementById("activity-toggle")?.remove();
    document.getElementById("transfer-toggle")?.remove();
    drawer.openDrawer("transfers");
    drawer.closeDrawer();
  });
});
