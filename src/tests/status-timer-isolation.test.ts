import { afterAll, describe, expect, it, vi } from "vitest";

// Failure mode: setStatus(text, ms) schedules a reset that clears #status by
// id. A test that calls vi.resetModules() gets a fresh state, so its own
// setStatus() cannot cancel the earlier test's timer. On a slow runner that
// timer fires mid-test and blanks the status the later test asserts on.
describe("status auto-reset timers do not leak across tests", () => {
  afterAll(() => {
    vi.useRealTimers();
  });

  it("leaves a pending auto-reset behind", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="status"></div>';
    const { setStatus } = await import("../app-status.ts");
    setStatus("earlier test", 5000);
    expect(document.getElementById("status")?.textContent).toBe("earlier test");
  });

  it("keeps a later test's status after the earlier reset is due", async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="status"></div>';
    const { setStatus } = await import("../app-status.ts");
    setStatus("later test");
    vi.advanceTimersByTime(6000);
    expect(document.getElementById("status")?.textContent).toBe("later test");
  });
});
