import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <button id="transfer-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <span id="transfer-badge" style="display:none"></span>
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

  it("keeps toggle aria-expanded in sync when switching drawer tabs", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();

    const activityToggle = document.getElementById(
      "activity-toggle",
    ) as HTMLButtonElement;
    const transferToggle = document.getElementById(
      "transfer-toggle",
    ) as HTMLButtonElement;

    drawer.openDrawer("activity");
    expect(activityToggle.getAttribute("aria-expanded")).toBe("true");
    expect(transferToggle.getAttribute("aria-expanded")).toBe("false");

    drawer.switchDrawerTab("transfers");
    expect(activityToggle.getAttribute("aria-expanded")).toBe("false");
    expect(transferToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows/hides activity drawer only in activity-tab contexts", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");
    const el = document.getElementById("bottom-drawer") as HTMLDivElement;

    activity.showActivityLog();
    expect(el.hidden).toBe(false);

    drawer.switchDrawerTab("transfers");
    activity.hideActivityLog();
    expect(el.hidden).toBe(false);

    drawer.switchDrawerTab("activity");
    activity.hideActivityLog();
    expect(el.hidden).toBe(true);
  });

  it("caps activity history at 200 entries and renders warning/error icons", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    for (let i = 0; i < 205; i += 1) {
      activity.logActivity(`entry-${i}`, "info");
    }
    activity.logActivity("warn message", "warning");
    activity.logActivity("error message", "error");

    const list = document.getElementById("activity-list") as HTMLDivElement;
    const renderedEntries = list.querySelectorAll(".activity-entry");
    expect(renderedEntries.length).toBe(200);
    expect(list.innerHTML).toContain("warn message");
    expect(list.innerHTML).toContain("error message");
    expect(list.innerHTML).toContain("/twemoji/26a0.svg");
    expect(list.innerHTML).toContain("/twemoji/274c.svg");

    const statusbarBadge = document.getElementById(
      "activity-badge",
    ) as HTMLSpanElement;
    const drawerBadge = document.getElementById(
      "drawer-activity-badge",
    ) as HTMLSpanElement;
    expect(statusbarBadge.textContent).toBe("200");
    expect(drawerBadge.textContent).toBe("200");
  });

  it("tolerates missing activity list element when logging", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    const list = document.getElementById("activity-list");
    list?.remove();
    activity.logActivity("still updates badge", "success");

    const statusbarBadge = document.getElementById(
      "activity-badge",
    ) as HTMLSpanElement;
    expect(statusbarBadge.textContent).toBe("1");
    expect(statusbarBadge.style.display).toBe("");
  });

  it("handles missing badge elements when activity updates", async () => {
    const drawer = await import("../bottom-drawer.ts");
    drawer.initDrawer();
    const activity = await import("../activity-log.ts");

    document.getElementById("activity-badge")?.remove();
    document.getElementById("drawer-activity-badge")?.remove();
    expect(() => activity.logActivity("no badges", "info")).not.toThrow();
    expect(() => activity.clearActivityLog()).not.toThrow();
  });
});
