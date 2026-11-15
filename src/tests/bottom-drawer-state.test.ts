import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <button id="transfer-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <span id="transfer-badge" style="display:none"></span>
    <div id="bottom-drawer" class="bottom-drawer" hidden>
      <div class="bottom-drawer__resize-handle" tabindex="0"></div>
      <div class="bottom-drawer__header">
        <div class="bottom-drawer__tabs">
          <button class="bottom-drawer__tab bottom-drawer__tab--active" id="drawer-tab-activity" role="tab" aria-selected="true" aria-controls="drawer-panel-activity" tabindex="0">Activity <span id="drawer-activity-badge" class="drawer-badge" style="display:none"></span></button>
          <button class="bottom-drawer__tab" id="drawer-tab-transfers" role="tab" aria-selected="false" aria-controls="drawer-panel-transfers" tabindex="-1">Transfers <span id="drawer-transfer-badge" class="drawer-badge" style="display:none"></span></button>
        </div>
        <div class="bottom-drawer__actions">
          <button id="drawer-clear">Clear</button>
          <button id="drawer-minimize"></button>
          <button id="drawer-close"></button>
        </div>
      </div>
      <div class="bottom-drawer__body">
        <div id="drawer-panel-activity" class="bottom-drawer__panel"></div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" hidden>
          <div role="group" aria-label="Filter transfers">
            <button type="button" id="filter-all" data-transfer-filter="all" aria-pressed="true">All</button>
            <button type="button" id="filter-active" data-transfer-filter="active" aria-pressed="false">Active</button>
            <button type="button" id="filter-failed" data-transfer-filter="failed" aria-pressed="false">Failed</button>
            <button type="button" id="filter-completed" data-transfer-filter="completed" aria-pressed="false">Completed</button>
          </div>
          <div id="transfer-filter-empty" hidden></div>
          <div id="transfer-list" class="transfer-list"></div>
        </div>
      </div>
    </div>
  `;
}

function addRow(status: string, id: number): void {
  const row = document.createElement("div");
  row.className = "transfer-item";
  row.dataset.id = String(id);
  row.dataset.status = status;
  document.getElementById("transfer-list")!.appendChild(row);
}

function filterEmpty(): HTMLElement {
  return document.getElementById("transfer-filter-empty")!;
}

describe("bottom drawer state persistence (UX audit 0.12.0)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    renderFixture();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  });

  it("reopens on the same tab after a reload", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("transfers");

    vi.resetModules();
    renderFixture();
    const reloaded = await import("../bottom-drawer.ts");
    reloaded.initDrawer();

    expect(reloaded.isDrawerOpen()).toBe(true);
    expect(reloaded.getActiveTab()).toBe("transfers");
    expect(
      document
        .getElementById("drawer-tab-transfers")!
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("stays closed after the user closes it", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("activity");
    drawer.closeDrawer();

    vi.resetModules();
    renderFixture();
    const reloaded = await import("../bottom-drawer.ts");
    reloaded.initDrawer();
    expect(reloaded.isDrawerOpen()).toBe(false);
  });

  it("restores the minimized state", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("activity");
    document.getElementById("drawer-minimize")!.click();

    vi.resetModules();
    renderFixture();
    const reloaded = await import("../bottom-drawer.ts");
    reloaded.initDrawer();
    expect(
      document
        .getElementById("bottom-drawer")!
        .classList.contains("bottom-drawer--minimized"),
    ).toBe(true);
  });

  it("labels the transfers clear action as Clear completed", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.switchDrawerTab("transfers");
    expect(document.getElementById("drawer-clear")!.textContent).toBe(
      "Clear completed",
    );
  });
});

describe("transfer list filter (UX audit 0.12.0)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    renderFixture();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  });

  it("shows only failed rows and marks the filter as pressed", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("transfers");
    addRow("queued", 1);
    addRow("error", 2);
    addRow("done", 3);

    document.getElementById("filter-failed")!.click();

    const list = document.getElementById("transfer-list")!;
    expect(list.dataset.filter).toBe("failed");
    expect(
      document.getElementById("filter-failed")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.getElementById("filter-all")!.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(filterEmpty().hidden).toBe(true);
  });

  it("explains an empty filter result instead of showing a blank list", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("transfers");
    addRow("done", 1);

    document.getElementById("filter-failed")!.click();

    expect(filterEmpty().hidden).toBe(false);
    expect(filterEmpty().textContent).toBe("No failed transfers");
  });

  it("maps Active to queued and uploading rows and Completed to done rows", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    drawer.openDrawer("transfers");
    addRow("uploading", 1);
    addRow("done", 2);

    document.getElementById("filter-active")!.click();
    expect(filterEmpty().hidden).toBe(true);
    document.getElementById("filter-completed")!.click();
    expect(filterEmpty().hidden).toBe(true);
  });
});
