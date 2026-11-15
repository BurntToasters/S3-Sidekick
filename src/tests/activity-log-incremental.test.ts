import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <button id="transfer-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
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
        <div id="drawer-panel-activity" class="bottom-drawer__panel">
          <div id="activity-list" class="activity-list" role="log" aria-live="polite"></div>
        </div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" hidden>
          <div id="transfer-list" class="transfer-list"></div>
        </div>
      </div>
    </div>
  `;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function entries(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("#activity-list .activity-entry"),
  );
}

describe("activity log incremental rendering (UX audit 0.12.0)", () => {
  beforeEach(() => {
    vi.resetModules();
    renderFixture();
  });

  it("appends new entries without rebuilding the rows already shown", async () => {
    const { logActivity } = await import("../activity-log.ts");
    logActivity("first");
    logActivity("second");
    await flush();
    const [first, second] = entries();
    expect(first.textContent).toContain("first");

    logActivity("third");
    await flush();

    const after = entries();
    expect(
      after.map((row) => row.querySelector(".activity-msg")?.textContent),
    ).toEqual(["first", "second", "third"]);
    expect(after[0]).toBe(first);
    expect(after[1]).toBe(second);
  });

  it("keeps the DOM bounded to the activity cap", async () => {
    const { logActivity } = await import("../activity-log.ts");
    for (let i = 0; i < 205; i += 1) logActivity(`entry ${i}`);
    await flush();
    expect(entries()).toHaveLength(200);
    expect(entries().at(-1)?.querySelector(".activity-msg")?.textContent).toBe(
      "entry 204",
    );
  });

  it("clears the rows and shows the empty state", async () => {
    const { logActivity, clearActivityLog } =
      await import("../activity-log.ts");
    logActivity("gone");
    await flush();
    clearActivityLog();
    await flush();
    expect(entries()).toHaveLength(0);
    expect(
      document.querySelector("#activity-list .activity-empty"),
    ).not.toBeNull();
  });

  it("does not raise the unread badge while the Activity tab is visible", async () => {
    const { logActivity } = await import("../activity-log.ts");
    const { openDrawer } = await import("../bottom-drawer.ts");
    openDrawer("activity");

    logActivity("while reading");
    logActivity("still reading");
    const badge = document.getElementById("activity-badge")!;
    expect(badge.style.display).toBe("none");
    expect(badge.textContent).toBe("");
  });

  it("counts entries logged while the drawer is closed or on Transfers", async () => {
    const { logActivity } = await import("../activity-log.ts");
    const { openDrawer, closeDrawer } = await import("../bottom-drawer.ts");
    openDrawer("transfers");
    logActivity("in background");
    closeDrawer();
    logActivity("closed");
    const badge = document.getElementById("activity-badge")!;
    expect(badge.textContent).toBe("2");
    expect(badge.style.display).toBe("");
  });
});
