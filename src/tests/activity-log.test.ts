import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <div id="bottom-drawer" class="bottom-drawer" hidden>
      <div class="bottom-drawer__resize-handle"></div>
      <div class="bottom-drawer__header">
        <div class="bottom-drawer__tabs">
          <button class="bottom-drawer__tab bottom-drawer__tab--active" id="drawer-tab-activity" role="tab" aria-selected="true" aria-controls="drawer-panel-activity" tabindex="0">Activity <span id="drawer-activity-badge" class="drawer-badge" style="display:none"></span></button>
          <button class="bottom-drawer__tab" id="drawer-tab-transfers" role="tab" aria-selected="false" aria-controls="drawer-panel-transfers" tabindex="-1">Transfers <span id="drawer-transfer-badge" class="drawer-badge" style="display:none"></span></button>
        </div>
        <div class="bottom-drawer__actions">
          <button id="drawer-clear" class="btn btn--ghost btn--sm">Clear</button>
          <button id="drawer-minimize" class="btn btn--icon"></button>
          <button id="drawer-close" class="btn btn--icon"></button>
        </div>
      </div>
      <div class="bottom-drawer__body">
        <div id="drawer-panel-activity" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-activity">
          <div id="activity-list" class="activity-list"></div>
        </div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-transfers" hidden>
          <div id="transfer-list" class="transfer-list"></div>
        </div>
      </div>
    </div>
  `;
}

describe("activity log with drawer", () => {
  beforeEach(() => {
    vi.resetModules();
    renderFixture();
  });

  it("opens drawer on activity tab when toggled", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    const el = document.getElementById("bottom-drawer") as HTMLDivElement;
    expect(el.hidden).toBe(true);

    activity.toggleActivityLog();
    expect(el.hidden).toBe(false);
    expect(drawer.getActiveTab()).toBe("activity");
  });

  it("closes drawer when toggled again", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    activity.toggleActivityLog();
    activity.toggleActivityLog();

    const el = document.getElementById("bottom-drawer") as HTMLDivElement;
    expect(el.hidden).toBe(true);
  });

  it("updates both statusbar and drawer badges", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    activity.logActivity("test message", "info");

    const statusbarBadge = document.getElementById("activity-badge")!;
    const drawerBadge = document.getElementById("drawer-activity-badge")!;
    expect(statusbarBadge.textContent).toBe("1");
    expect(drawerBadge.textContent).toBe("1");
  });

  it("clears entries and updates badges", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    activity.logActivity("test message", "info");
    activity.clearActivityLog();

    const statusbarBadge = document.getElementById("activity-badge")!;
    expect(statusbarBadge.textContent).toBe("");
    expect(statusbarBadge.style.display).toBe("none");
  });
});
