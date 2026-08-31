import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: mockShowConfirm,
}));

describe("app-conflicts", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "ask";
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    };
  });

  it("resolveObjectConflict returns create-only intent when destination is absent", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { resolveObjectConflict } = await import("../app-conflicts.ts");

    const intent = await resolveObjectConflict(
      "frozen-connection",
      "bucket-a",
      "docs/new.txt",
      { applyAll: null },
      false,
      { operation: "copy" },
    );

    expect(intent).toEqual({ overwrite: false });
    expect(mockInvoke).toHaveBeenCalledWith("object_exists", {
      bucket: "bucket-a",
      key: "docs/new.txt",
      connectionId: "frozen-connection",
    });
  });

  it("resolveObjectConflict returns overwrite when destination exists and policy is replace", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");

    const intent = await resolveObjectConflict(
      "frozen-connection",
      "bucket-a",
      "docs/existing.txt",
      { applyAll: null },
      false,
      { operation: "copy" },
    );

    expect(intent).toEqual({ overwrite: true });
  });

  it("resolveObjectConflict fails closed when the existence probe errors", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("throttled"));
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");

    const intent = await resolveObjectConflict(
      "frozen-connection",
      "bucket-a",
      "docs/new.txt",
      { applyAll: null },
      false,
      { operation: "upload" },
    );

    expect(intent).toBe("skip");
  });

  it("resolveObjectConflict confirms unguarded writes on unsupported providers", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    mockShowConfirm.mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveObjectConflict } = await import("../app-conflicts.ts");

    const intent = await resolveObjectConflict(
      "frozen-connection",
      "bucket-a",
      "docs/new.txt",
      { applyAll: null },
      false,
      { operation: "upload" },
    );

    expect(intent).toEqual({ overwrite: true });
    expect(mockShowConfirm).toHaveBeenCalled();
  });

  it("distinguishes declined unconditional writes from destination conflicts", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    mockShowConfirm.mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveObjectConflict } = await import("../app-conflicts.ts");

    const intent = await resolveObjectConflict(
      "frozen-connection",
      "bucket-a",
      "docs/new.txt",
      { applyAll: null },
      false,
      { operation: "copy" },
    );

    expect(intent).toBe("cancel");
  });

  it("conservatively confirms unknown-size multipart copy capability", async () => {
    mockShowConfirm.mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: false,
      copy_object: true,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");

    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toEqual({ overwrite: true });
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
  });
});
