import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictPromptSession } from "../app-conflicts.ts";

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

describe("app-conflicts choice and consent branches", () => {
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

  it("resolveConflictChoice short-circuits when applyAll is set", async () => {
    const { resolveConflictChoice } = await import("../app-conflicts.ts");
    const decision = await resolveConflictChoice(
      "bucket/k",
      {
        applyAll: "skip",
      },
      true,
    );
    expect(decision).toBe("skip");
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("resolveConflictChoice replace without batch asks once", async () => {
    mockShowConfirm.mockResolvedValueOnce(true);
    const { resolveConflictChoice } = await import("../app-conflicts.ts");
    const session = { applyAll: null as null | "replace" | "skip" };
    await expect(
      resolveConflictChoice("bucket/k", session, false),
    ).resolves.toBe("replace");
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(session.applyAll).toBeNull();
  });

  it("resolveConflictChoice skip with apply-to-all records decision", async () => {
    mockShowConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { resolveConflictChoice } = await import("../app-conflicts.ts");
    const session = { applyAll: null as null | "replace" | "skip" };
    await expect(
      resolveConflictChoice("bucket/k", session, true),
    ).resolves.toBe("skip");
    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
    expect(session.applyAll).toBe("skip");
  });

  it("resolveConflictChoice replace without apply-to-all keeps session open", async () => {
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { resolveConflictChoice } = await import("../app-conflicts.ts");
    const session = { applyAll: null as null | "replace" | "skip" };
    await expect(
      resolveConflictChoice("bucket/k", session, true),
    ).resolves.toBe("replace");
    expect(session.applyAll).toBeNull();
  });

  it("resolveAbsentObjectWriteIntent returns create-only when caps are full", async () => {
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "upload",
        byteLength: 10,
      }),
    ).resolves.toEqual({ overwrite: false });
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, true, {
        operation: "copy",
        byteLength: 10,
      }),
    ).resolves.toEqual({ overwrite: false });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("resolveAbsentObjectWriteIntent declines unguarded upload", async () => {
    mockShowConfirm.mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "upload",
      }),
    ).resolves.toBe("cancel");
  });

  it("resolveAbsentObjectWriteIntent accepts once without batch remainder", async () => {
    mockShowConfirm.mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: true,
      copy_object: true,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    const session: ConflictPromptSession = { applyAll: null };
    await expect(
      resolveAbsentObjectWriteIntent(session, false, { operation: "upload" }),
    ).resolves.toEqual({ overwrite: true });
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(session.unguardedWriteAuthorized).toBeUndefined();
  });

  it("resolveAbsentObjectWriteIntent records apply-to-all for batch unguarded writes", async () => {
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    const session: ConflictPromptSession = { applyAll: null };
    await expect(
      resolveAbsentObjectWriteIntent(session, true, { operation: "copy" }),
    ).resolves.toEqual({ overwrite: true });
    expect(session.unguardedWriteAuthorized).toBe(true);
    // Second batch item short-circuits on the recorded authorization.
    mockShowConfirm.mockClear();
    await expect(
      resolveAbsentObjectWriteIntent(session, true, { operation: "copy" }),
    ).resolves.toEqual({ overwrite: true });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("resolveAbsentObjectWriteIntent keeps single-item authorization unrecorded", async () => {
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    const session: ConflictPromptSession = { applyAll: null };
    await expect(
      resolveAbsentObjectWriteIntent(session, true, { operation: "upload" }),
    ).resolves.toEqual({ overwrite: true });
    expect(session.unguardedWriteAuthorized).toBeUndefined();
  });

  it("large uploads only require multipart capability", async () => {
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: true,
      copy_object: false,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "upload",
        byteLength: 200 * 1024 * 1024,
      }),
    ).resolves.toEqual({ overwrite: false });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("large copies only require multipart capability", async () => {
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: false,
    };
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "copy",
        byteLength: 6 * 1024 * 1024 * 1024,
      }),
    ).resolves.toEqual({ overwrite: false });
  });

  it("small uploads require put capability and small copies require copy capability", async () => {
    const { state } = await import("../state.ts");
    const { resolveAbsentObjectWriteIntent } =
      await import("../app-conflicts.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: true,
      copy_object: true,
    };
    mockShowConfirm.mockResolvedValueOnce(true);
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "upload",
        byteLength: 5,
      }),
    ).resolves.toEqual({ overwrite: true });
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: false,
    };
    mockShowConfirm.mockResolvedValueOnce(true);
    await expect(
      resolveAbsentObjectWriteIntent({ applyAll: null }, false, {
        operation: "copy",
        byteLength: 5,
      }),
    ).resolves.toEqual({ overwrite: true });
  });
});

describe("app-conflicts object and download routing", () => {
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

  it("absent destination with replace policy overwrites without consent", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toEqual({ overwrite: true });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("absent destination honors session applyAll replace", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: "replace" }, true, {
        operation: "upload",
      }),
    ).resolves.toEqual({ overwrite: true });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("absent guarded destination stays create-only under skip policy", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "upload",
      }),
    ).resolves.toEqual({ overwrite: false });
  });

  it("absent unguarded destination cancel propagates", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    mockShowConfirm.mockResolvedValueOnce(false);
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "upload",
      }),
    ).resolves.toBe("cancel");
  });

  it("existing destination with skip policy skips without prompting", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toBe("skip");
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("existing destination with ask replace overwrites", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    mockShowConfirm.mockResolvedValueOnce(true);
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toEqual({ overwrite: true });
  });

  it("existing destination with ask skip skips", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    mockShowConfirm.mockResolvedValueOnce(false);
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toBe("skip");
  });

  it("probe error under replace still overwrites fail-closed", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("denied"));
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    const { resolveObjectConflict } = await import("../app-conflicts.ts");
    await expect(
      resolveObjectConflict("conn", "b", "k", { applyAll: null }, false, {
        operation: "copy",
      }),
    ).resolves.toEqual({ overwrite: true });
  });

  it("download entries pass through when nothing exists", async () => {
    mockInvoke.mockResolvedValue(false);
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("download entries overwrite under replace policy", async () => {
    mockInvoke.mockResolvedValue(true);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ conflictResolution: "replace" });
  });

  it("download entries skip under skip policy", async () => {
    mockInvoke.mockResolvedValue(true);
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(0);
  });

  it("download entries ask replace for a single conflict", async () => {
    mockInvoke.mockResolvedValue(true);
    mockShowConfirm.mockResolvedValueOnce(true);
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
  });

  it("download entries ask skip for a single conflict", async () => {
    mockInvoke.mockResolvedValue(true);
    mockShowConfirm.mockResolvedValueOnce(false);
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(0);
  });

  it("download probe errors are treated as conflicts", async () => {
    mockInvoke.mockRejectedValue(new Error("unreadable"));
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
    ]);
    expect(out).toHaveLength(0);
  });

  it("download batch apply-to-all replace covers remaining conflicts", async () => {
    mockInvoke.mockResolvedValue(true);
    mockShowConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const { resolveDownloadEntriesWithConflicts } =
      await import("../app-conflicts.ts");
    const out = await resolveDownloadEntriesWithConflicts([
      { bucket: "b", key: "a.txt", destination: "/tmp/a.txt" } as never,
      { bucket: "b", key: "b.txt", destination: "/tmp/b.txt" } as never,
    ]);
    expect(out).toHaveLength(2);
    expect(mockShowConfirm).toHaveBeenCalledTimes(2);
  });
});
