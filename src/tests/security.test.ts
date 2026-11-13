import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

async function loadSecurityModule() {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: mockInvoke,
  }));
  return import("../security.ts");
}

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
});

describe("isCredentialRemovedError", () => {
  it("returns true for error strings containing 'credential was removed'", async () => {
    const { isCredentialRemovedError } = await loadSecurityModule();
    expect(
      isCredentialRemovedError("The credential was removed from the system"),
    ).toBe(true);
  });

  it("returns true for error strings containing 'no longer valid'", async () => {
    const { isCredentialRemovedError } = await loadSecurityModule();
    expect(isCredentialRemovedError("Biometric key is no longer valid")).toBe(
      true,
    );
  });

  it("returns false for unrelated error strings", async () => {
    const { isCredentialRemovedError } = await loadSecurityModule();
    expect(isCredentialRemovedError("network timeout")).toBe(false);
    expect(isCredentialRemovedError("authentication failed")).toBe(false);
  });
});

describe("isCancellationError", () => {
  it("returns true for 'canceled'", async () => {
    const { isCancellationError } = await loadSecurityModule();
    expect(isCancellationError("Operation canceled by user")).toBe(true);
  });

  it("returns true for 'cancelled'", async () => {
    const { isCancellationError } = await loadSecurityModule();
    expect(isCancellationError("Request was cancelled")).toBe(true);
  });

  it("returns false for other errors", async () => {
    const { isCancellationError } = await loadSecurityModule();
    expect(isCancellationError("permission denied")).toBe(false);
    expect(isCancellationError("timeout")).toBe(false);
  });

  it("handles non-string error values", async () => {
    const { isCancellationError, isCredentialRemovedError } =
      await loadSecurityModule();
    expect(isCancellationError(404)).toBe(false);
    expect(isCredentialRemovedError({ code: "EKEY" })).toBe(false);
  });
});

describe("securityErrorMessage", () => {
  it("explains a wrong password and what to do next", async () => {
    const { securityErrorMessage } = await loadSecurityModule();
    const text = securityErrorMessage("Invalid password");
    expect(text).toMatch(/password is incorrect/i);
    expect(text).toMatch(/caps lock/i);
  });

  it("names the keychain and the fix when the system denies access", async () => {
    const { securityErrorMessage } = await loadSecurityModule();
    expect(
      securityErrorMessage("Keychain error: user denied access to item"),
    ).toMatch(/keychain denied access.*allow S3 Sidekick/i);
  });

  it("tells the user to unlock first when storage is locked", async () => {
    const { securityErrorMessage } = await loadSecurityModule();
    expect(
      securityErrorMessage(
        "Encrypted storage is locked; unlock before connecting.",
      ),
    ).toMatch(/locked.*unlock/i);
  });

  it("falls back to the friendly transport message for network failures", async () => {
    const { securityErrorMessage } = await loadSecurityModule();
    expect(securityErrorMessage("connection timeout")).toMatch(/timed out/i);
  });

  it("keeps unrecognized backend detail instead of dropping it", async () => {
    const { securityErrorMessage } = await loadSecurityModule();
    expect(securityErrorMessage("disk quota exceeded")).toContain(
      "disk quota exceeded",
    );
  });
});

const mockSetConnectionAccessLocked = vi.fn();
const mockState = {
  connected: false,
  connectionId: "",
  runningTransferCount: 0,
};

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    initialized: true,
    encryption_enabled: true,
    unlocked: true,
    lock_timeout_minutes: 15,
    biometric_available: false,
    biometric_enrolled: false,
    ...overrides,
  };
}

async function loadAutoLockWatcher() {
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
  vi.doMock("../state.ts", () => ({ state: mockState }));
  vi.doMock("../connection.ts", () => ({
    setConnectionAccessLocked: mockSetConnectionAccessLocked,
  }));
  return import("../security.ts");
}

describe("auto-lock watcher", () => {
  let stopWatcher: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.connected = false;
    mockState.connectionId = "";
    mockState.runningTransferCount = 0;
  });

  afterEach(() => {
    stopWatcher?.();
    stopWatcher = null;
    vi.useRealTimers();
    vi.doUnmock("../state.ts");
    vi.doUnmock("../connection.ts");
  });

  it("locks on focus without waiting for the 15s poll", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return makeStatus();
      if (command === "lock_security") return makeStatus({ unlocked: false });
      return undefined;
    });
    const security = await loadAutoLockWatcher();
    stopWatcher = security.stopAutoLockWatcher;
    const onLocked = vi.fn(async () => true);

    security.startAutoLockWatcher(onLocked);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onLocked).not.toHaveBeenCalled();

    // The backend expires the vault key while the window is in the background.
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status")
        return makeStatus({ unlocked: false });
      if (command === "lock_security") return makeStatus({ unlocked: false });
      return undefined;
    });

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("keeps the fail-closed cleanup when the status read is unknown", async () => {
    mockState.connected = true;
    mockState.connectionId = "conn-1";
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return makeStatus();
      if (command === "lock_security") return makeStatus({ unlocked: false });
      return undefined;
    });
    const security = await loadAutoLockWatcher();
    stopWatcher = security.stopAutoLockWatcher;
    const onLocked = vi.fn(async () => true);

    security.startAutoLockWatcher(onLocked);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLocked).not.toHaveBeenCalled();

    // Both the forced lock and the status read fail: state is unknown, which
    // must never read as unlocked or clear a pending cleanup.
    mockInvoke.mockImplementation(async () => {
      throw new Error("native state unavailable");
    });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(mockSetConnectionAccessLocked).toHaveBeenCalledWith(true);
    expect(onLocked).not.toHaveBeenCalled();

    // The next poll confirms the lock and the retained cleanup runs.
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status")
        return makeStatus({ unlocked: false });
      if (command === "lock_security") return makeStatus({ unlocked: false });
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("clears a pending cleanup when the vault is seen unlocked again (H2)", async () => {
    mockState.connected = true;
    mockState.connectionId = "conn-1";
    let unlocked = true;
    let lockCalls = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "get_security_status") return makeStatus({ unlocked });
      if (command === "lock_security") {
        lockCalls += 1;
        return makeStatus({ unlocked: false });
      }
      return undefined;
    });
    const security = await loadAutoLockWatcher();
    stopWatcher = security.stopAutoLockWatcher;
    const onLocked = vi.fn(async () => false);

    security.startAutoLockWatcher(onLocked);
    // First poll: still unlocked; watcher observes it, no forced lock.
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lockCalls).toBe(0);
    expect(onLocked).not.toHaveBeenCalled();

    // Backend expires the vault key; the next poll locks and runs cleanup.
    // onLocked declines (false), so pendingAutoLockCleanup stays set.
    unlocked = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(lockCalls).toBeGreaterThan(0);
    const lockCallsAfterLock = lockCalls;

    // The user unlocks again. The vault is now unlocked while the watcher
    // would run its pending-retry path: a forced lock here relocks the vault
    // underneath the active session. The watcher must observe the unlocked
    // status and stop without touching the backend lock.
    unlocked = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onLocked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onLocked).toHaveBeenCalledTimes(1);
    // Pre-fix the pending retry calls verifyNativeLock, which unconditionally
    // calls lock_security first: a freshly unlocked vault gets re-locked
    // underneath the user and onLocked runs again. Post-fix the unlocked
    // observation clears the pending flag and no lock call happens.
    expect(lockCalls).toBe(lockCallsAfterLock);
  });

  it("does not stack checks on repeated focus and detaches on stop", async () => {
    let resolveStatus: (value: unknown) => void = () => undefined;
    const statusReady = new Promise<unknown>((resolve) => {
      resolveStatus = resolve;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "get_security_status") return statusReady;
      if (command === "lock_security") {
        return Promise.resolve(makeStatus({ unlocked: false }));
      }
      return Promise.resolve(undefined);
    });
    const security = await loadAutoLockWatcher();
    stopWatcher = security.stopAutoLockWatcher;
    security.startAutoLockWatcher(async () => true);

    const statusReads = () =>
      mockInvoke.mock.calls.filter(
        ([command]) => command === "get_security_status",
      ).length;

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(statusReads()).toBe(1);

    resolveStatus(makeStatus());
    await vi.advanceTimersByTimeAsync(0);

    security.stopAutoLockWatcher();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(statusReads()).toBe(1);
  });
});
