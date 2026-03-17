import { beforeEach, describe, expect, it, vi } from "vitest";

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <div id="activity-overlay" class="activity-popup" hidden>
      <div class="activity-popup__header">
        <span>Activity</span>
        <div class="activity-popup__actions">
          <button id="activity-collapse" aria-expanded="true"></button>
          <button id="activity-close"></button>
        </div>
      </div>
      <div id="activity-list" class="activity-list"></div>
    </div>
    <span id="activity-badge" style="display:none"></span>
  `;
}

describe("activity log collapse state", () => {
  beforeEach(() => {
    vi.resetModules();
    renderFixture();
  });

  it("toggles collapsed class and aria state when visible", async () => {
    const activity = await import("../activity-log.ts");

    activity.toggleActivityLog();
    const overlay = document.getElementById(
      "activity-overlay",
    ) as HTMLDivElement;
    const collapseButton = document.getElementById(
      "activity-collapse",
    ) as HTMLButtonElement;

    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains("activity-popup--collapsed")).toBe(false);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    activity.toggleActivityCollapsed();
    expect(overlay.classList.contains("activity-popup--collapsed")).toBe(true);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("false");

    activity.toggleActivityCollapsed();
    expect(overlay.classList.contains("activity-popup--collapsed")).toBe(false);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("preserves pre-toggled collapsed state when panel opens", async () => {
    const activity = await import("../activity-log.ts");
    const overlay = document.getElementById(
      "activity-overlay",
    ) as HTMLDivElement;

    expect(overlay.hidden).toBe(true);
    activity.toggleActivityCollapsed();
    activity.toggleActivityLog();

    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains("activity-popup--collapsed")).toBe(true);
  });
});
