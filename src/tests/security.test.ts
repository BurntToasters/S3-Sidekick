import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(isCredentialRemovedError("The credential was removed from the system")).toBe(true);
  });

  it("returns true for error strings containing 'no longer valid'", async () => {
    const { isCredentialRemovedError } = await loadSecurityModule();
    expect(isCredentialRemovedError("Biometric key is no longer valid")).toBe(true);
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
});
