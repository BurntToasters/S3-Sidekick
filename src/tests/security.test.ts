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
