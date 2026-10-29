import { afterEach } from "vitest";

// Cancel the status auto-reset a test leaves pending. After vi.resetModules()
// the next test's setStatus() holds a fresh state and cannot cancel it, and the
// timer clears #status by id, blanking text that a later test asserts on.
afterEach(async () => {
  const { state } = await import("../../state.ts");
  clearTimeout(state.statusTimeout);
  state.statusTimeout = undefined;
});
