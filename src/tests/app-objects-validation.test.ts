import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockShowPrompt = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockSave = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockRenderObjectTable = vi.fn();
const mockRenderBreadcrumb = vi.fn();
const mockNavigateToFolder = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockClearSelection = vi.fn();
const mockClipboardWrite = vi.fn<(data: string) => Promise<void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: (...args: unknown[]) => mockShowConfirm(...args),
  showPrompt: (...args: unknown[]) => mockShowPrompt(...args),
  showAlert: vi.fn(async () => undefined),
  isDialogActive: vi.fn(() => false),
}));

vi.mock("../browser.ts", () => ({
  renderObjectTable: (...args: unknown[]) => mockRenderObjectTable(...args),
  renderBreadcrumb: (...args: unknown[]) => mockRenderBreadcrumb(...args),
  renderBucketList: vi.fn(),
  navigateToFolder: (...args: unknown[]) => mockNavigateToFolder(...args),
  clearSelection: (...args: unknown[]) => mockClearSelection(...args),
  updateSelectionUI: vi.fn(),
  invalidateInspectorSelectionSync: vi.fn(),
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <span id="status"></span>
    <button id="batch-delete"><span class="batch-toolbar__label">Delete</span></button>
    <input id="filter-input" />
  `;
}

function defaultInvoke(cmd: unknown, args?: Record<string, unknown>): unknown {
  if (cmd === "object_exists") return false;
  if (cmd === "path_exists") return false;
  if (cmd === "list_objects") {
    return {
      objects: [],
      prefixes: [],
      truncated: false,
      next_continuation_token: "",
    };
  }
  if (cmd === "delete_objects") {
    return { deleted: 1, failed: 0, incomplete: false, errors: [] };
  }
  if (cmd === "delete_prefix") {
    return { deleted: 2, failed: 0, incomplete: false, errors: [] };
  }
  if (cmd === "rename_object") return undefined;
  if (cmd === "rename_prefix") return undefined;
  if (cmd === "create_folder") return undefined;
  if (cmd === "build_object_url") {
    return `https://example.com/${String(args?.key ?? "")}`;
  }
  if (cmd === "generate_presigned_url") {
    return `https://signed/${String(args?.key ?? "")}`;
  }
  if (cmd === "write_text_file") return undefined;
  return undefined;
}

async function setupConnected(): Promise<typeof import("../state.ts")["state"]> {
  const { state } = await import("../state.ts");
  state.connected = true;
  state.connectionId = "test-connection";
  state.connectionIdentity = "test-identity";
  state.endpoint = "https://s3.example.com";
  state.currentBucket = "bucket-a";
  state.currentPrefix = "docs/";
  state.buckets = [{ name: "bucket-a", creation_date: "" }];
  state.objects = [];
  state.prefixes = [];
  state.selectedKeys.clear();
  state.currentSettings.conflictPolicy = "ask";
  state.createOnlyCapabilities = {
    put_object: true,
    complete_multipart: true,
    copy_object: true,
  };
  state.currentSettings.presignedUrlExpiration = 3600;
  return state;
}

beforeEach(async () => {
  vi.resetModules();
  mockInvoke.mockReset();
  mockShowConfirm.mockReset();
  mockShowPrompt.mockReset();
  mockSave.mockReset();
  mockRenderObjectTable.mockReset();
  mockRenderBreadcrumb.mockReset();
  mockNavigateToFolder.mockReset();
  mockNavigateToFolder.mockResolvedValue(undefined);
  mockClearSelection.mockReset();
  mockClipboardWrite.mockReset();
  mockClipboardWrite.mockResolvedValue(undefined);
  mockInvoke.mockImplementation(async (cmd, payload) =>
    defaultInvoke(cmd, payload as Record<string, unknown>),
  );
  mockShowConfirm.mockResolvedValue(true);
  mockShowPrompt.mockResolvedValue(null);
  mockSave.mockResolvedValue(null);
  renderFixture();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWrite },
    configurable: true,
  });
  const { clearActivityLog } = await import("../activity-log.ts");
  clearActivityLog();
  await setupConnected();
});

describe("file rename validation", () => {
  it("does nothing when the prompt is dismissed", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce(null);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_object",
      expect.anything(),
    );
  });

  it("does nothing when the name is unchanged", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("file.txt");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_object",
      expect.anything(),
    );
  });

  it("rejects blank names after trimming", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("   ");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "Name cannot be empty",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_object",
      expect.anything(),
    );
  });

  it("treats whitespace-padded same name as unchanged", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("  file.txt  ");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_object",
      expect.anything(),
    );
  });

  it("rejects names containing slashes", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("bad/name");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      'Name cannot contain "/"',
    );
  });

  it("cancels when the location changes before the probe", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockImplementation(async () => {
      state.currentPrefix = "other/";
      return "new.txt";
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "location changed",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "object_exists",
      expect.anything(),
    );
  });

  it("skips when the new key already exists and user skips", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("taken.txt");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return true;
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValue(false);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "already exists",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_object",
      expect.anything(),
    );
  });

  it("cancels when unguarded consent is declined", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowPrompt.mockResolvedValueOnce("new.txt");
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "unconditional write was not authorized",
    );
  });

  it("renames with overwrite false on a guarded absent destination", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("renamed.txt");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).toHaveBeenCalledWith("rename_object", {
      bucket: "bucket-a",
      oldKey: "docs/file.txt",
      newKey: "docs/renamed.txt",
      overwrite: false,
      connectionId: "test-connection",
    });
    expect(document.getElementById("status")?.textContent).toContain("Renamed");
  });

  it("maps rename backend errors to user messages", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowPrompt.mockResolvedValueOnce("renamed.txt");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "rename_object") throw new Error("403 Forbidden");
      return defaultInvoke(cmd);
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "Access denied",
    );
  });

  it("cancels rename when not connected", async () => {
    const { state } = await import("../state.ts");
    state.connected = false;
    state.connectionId = "";
    state.selectedKeys.add("docs/file.txt");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "Rename cancelled",
    );
  });
});

describe("folder rename rules", () => {
  it("does nothing when folder prompt is dismissed or unchanged", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce(null);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_prefix",
      expect.anything(),
    );
    mockShowPrompt.mockResolvedValueOnce("folder");
    await handleRename();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_prefix",
      expect.anything(),
    );
  });

  it("rejects folder names with slashes", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("bad/name");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "cannot contain slashes",
    );
  });

  it("skips conflicting folder under skip policy", async () => {
    const state = await setupConnected();
    state.currentSettings.conflictPolicy = "skip";
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("taken");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") {
        return { objects: [{ key: "x" }], prefixes: [] };
      }
      return defaultInvoke(cmd);
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "already exists",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_prefix",
      expect.anything(),
    );
  });

  it("replaces conflicting folder under replace policy", async () => {
    const state = await setupConnected();
    state.currentSettings.conflictPolicy = "replace";
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("taken");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") {
        return { objects: [{ key: "x" }], prefixes: [] };
      }
      return defaultInvoke(cmd);
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).toHaveBeenCalledWith(
      "rename_prefix",
      expect.objectContaining({ overwrite: true }),
    );
  });

  it("asks before replacing a conflicting folder and honors skip", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("taken");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") {
        return { objects: [{ key: "x" }], prefixes: [] };
      }
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "already exists",
    );
  });

  it("treats folder probe errors as conflicts", async () => {
    const state = await setupConnected();
    state.currentSettings.conflictPolicy = "replace";
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("new-folder");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") throw new Error("denied");
      return defaultInvoke(cmd);
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).toHaveBeenCalledWith(
      "rename_prefix",
      expect.objectContaining({ overwrite: true }),
    );
  });

  it("requires consent for unguarded folder creation and honors decline", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "unconditional write was not authorized",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "rename_prefix",
      expect.anything(),
    );
  });

  it("renames an absent guarded folder create-only", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("fresh");
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(mockInvoke).toHaveBeenCalledWith(
      "rename_prefix",
      expect.objectContaining({ overwrite: false }),
    );
  });

  it("maps folder rename errors to user messages", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "rename_prefix") throw new Error("Rate limited 429");
      return defaultInvoke(cmd);
    });
    const { handleRename } = await import("../app-objects.ts");
    await handleRename();
    expect(document.getElementById("status")?.textContent).toContain(
      "Rate limited",
    );
  });
});

describe("create-folder overwrite retry", () => {
  it("requires a connection", async () => {
    const { state } = await import("../state.ts");
    state.connected = false;
    state.currentBucket = "";
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "Connect to a bucket first",
    );
  });

  it("rejects empty and slash names", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("   ");
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "cannot be empty",
    );
    mockShowPrompt.mockResolvedValueOnce("bad/name");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      'cannot contain "/"',
    );
  });

  it("skips when the folder already exists", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("taken");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return true;
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "already exists",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "create_folder",
      expect.anything(),
    );
  });

  it("cancels when unguarded consent is declined", async () => {
    const state = await setupConnected();
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "unconditional write was not authorized",
    );
  });

  it("creates guarded folders create-only", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("fresh");
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_folder",
      expect.objectContaining({ overwrite: false }),
    );
    expect(document.getElementById("status")?.textContent).toContain("Created");
  });

  it("retries with overwrite after an already-exists race", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("fresh");
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "create_folder") {
        calls += 1;
        if (calls === 1) throw new Error("Folder already exists");
        return undefined;
      }
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(true);
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(calls).toBe(2);
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_folder",
      expect.objectContaining({ overwrite: true }),
    );
    expect(document.getElementById("status")?.textContent).toContain("Created");
  });

  it("honors decline on the overwrite retry prompt", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "create_folder") throw new Error("already exists");
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "already exists",
    );
  });

  it("reports retry failures to the user", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "create_folder") throw new Error("already exists");
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "create_folder") {
        const hasRetried = mockShowConfirm.mock.calls.length > 0;
        if (!hasRetried) throw new Error("already exists");
        throw new Error("network down");
      }
      return defaultInvoke(cmd);
    });
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain("Failed");
  });

  it("does not retry when the first attempt already overwrote", async () => {
    const state = await setupConnected();
    state.currentSettings.conflictPolicy = "replace";
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return true;
      if (cmd === "create_folder") throw new Error("already exists");
      return defaultInvoke(cmd);
    });
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(mockShowConfirm).not.toHaveBeenCalledWith(
      "Folder Exists",
      expect.anything(),
      expect.anything(),
    );
    expect(document.getElementById("status")?.textContent).toContain("Failed");
  });

  it("reports generic creation failures", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce("fresh");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "create_folder") throw new Error("timeout waiting");
      return defaultInvoke(cmd);
    });
    const { handleCreateFolder } = await import("../app-objects.ts");
    await handleCreateFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "timed out",
    );
  });
});

describe("delete confirmations", () => {
  it("does nothing with an empty selection", async () => {
    await setupConnected();
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_objects",
      expect.anything(),
    );
  });

  it("does nothing when the confirmation is declined", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_objects",
      expect.anything(),
    );
  });

  it("deletes files and reports success", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockResolvedValueOnce(true);
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_objects",
      expect.objectContaining({ keys: ["docs/file.txt"] }),
    );
    expect(document.getElementById("status")?.textContent).toContain("Deleted");
  });

  it("tolerates the legacy numeric delete receipt", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "delete_objects") return 1;
      return defaultInvoke(cmd);
    });
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(document.getElementById("status")?.textContent).toContain("Deleted");
  });

  it("reports partial delete failures with counts", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "delete_objects") {
        return { deleted: 0, failed: 1, incomplete: true, errors: ["denied"] };
      }
      return defaultInvoke(cmd);
    });
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(document.getElementById("status")?.textContent).toContain(
      "Delete failed",
    );
  });

  it("maps invalid delete receipts to failures", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockResolvedValueOnce(true);
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "delete_objects") return "bogus";
      return defaultInvoke(cmd);
    });
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(document.getElementById("status")?.textContent).toContain(
      "Delete failed",
    );
  });

  it("deletes folders via delete_prefix", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("prefix:docs/folder/");
    mockShowConfirm.mockResolvedValueOnce(true);
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(mockInvoke).toHaveBeenCalledWith(
      "delete_prefix",
      expect.objectContaining({ prefix: "docs/folder/" }),
    );
  });

  it("cancels when the selection changes during confirmation", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockShowConfirm.mockImplementation(async () => {
      state.selectedKeys.clear();
      state.selectedKeys.add("docs/other.txt");
      return true;
    });
    const { handleDelete } = await import("../app-objects.ts");
    await handleDelete();
    expect(document.getElementById("status")?.textContent).toContain(
      "connection or selection changed",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "delete_objects",
      expect.anything(),
    );
  });
});

describe("object copy helpers and presigned expiry", () => {
  it("copies a single URL to the clipboard", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    const { handleCopyUrl } = await import("../app-objects.ts");
    await handleCopyUrl();
    expect(mockClipboardWrite).toHaveBeenCalledWith(
      "https://example.com/docs/file.txt",
    );
    expect(document.getElementById("status")?.textContent).toContain(
      "URL copied",
    );
  });

  it("does nothing when nothing is selected for URL copy", async () => {
    await setupConnected();
    const { handleCopyUrl } = await import("../app-objects.ts");
    await handleCopyUrl();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it("maps URL copy failures to user messages", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockInvoke.mockRejectedValueOnce(new Error("401 Unauthorized"));
    const { handleCopyUrl } = await import("../app-objects.ts");
    await handleCopyUrl();
    expect(document.getElementById("status")?.textContent).toContain(
      "Authentication failed",
    );
  });

  it("copies keys and ARNs for multi-select", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/a.txt");
    state.selectedKeys.add("prefix:docs/folder/");
    const { handleCopyKey, handleCopyArn } = await import("../app-objects.ts");
    await handleCopyKey();
    expect(mockClipboardWrite).toHaveBeenCalledWith(
      "docs/a.txt\ndocs/folder/",
    );
    await handleCopyArn();
    expect(mockClipboardWrite).toHaveBeenCalledWith(
      expect.stringContaining("arn:aws:s3:::bucket-a/docs/a.txt"),
    );
  });

  it("formats presigned expirations in minutes, hours, and days", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    const { handleCopyPresignedUrl } = await import("../app-objects.ts");
    state.currentSettings.presignedUrlExpiration = 120;
    await handleCopyPresignedUrl();
    expect(document.getElementById("status")?.textContent).toContain("minute");
    state.currentSettings.presignedUrlExpiration = 7200;
    await handleCopyPresignedUrl();
    expect(document.getElementById("status")?.textContent).toContain("hour");
    state.currentSettings.presignedUrlExpiration = 200000;
    await handleCopyPresignedUrl();
    expect(document.getElementById("status")?.textContent).toContain("day");
  });

  it("maps presigned failures to user messages", async () => {
    const state = await setupConnected();
    state.selectedKeys.add("docs/file.txt");
    mockInvoke.mockRejectedValueOnce(new Error("NoSuchBucket missing"));
    const { handleCopyPresignedUrl } = await import("../app-objects.ts");
    await handleCopyPresignedUrl();
    expect(document.getElementById("status")?.textContent).toContain(
      "Resource not found",
    );
  });
});

describe("export and go-to guards", () => {
  it("reports an empty activity log on export", async () => {
    await setupConnected();
    const { handleExportActivityLog } = await import("../app-objects.ts");
    await handleExportActivityLog();
    expect(document.getElementById("status")?.textContent).toContain(
      "No activity entries",
    );
  });

  it("exports the activity log and honors overwrite decline", async () => {
    const { logActivity } = await import("../activity-log.ts");
    logActivity("hello", "info");
    await setupConnected();
    const { state } = await import("../state.ts");
    state.connected = true;
    mockSave.mockResolvedValueOnce("/tmp/log.txt");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return true;
      return defaultInvoke(cmd);
    });
    mockShowConfirm.mockResolvedValueOnce(false);
    const { handleExportActivityLog } = await import("../app-objects.ts");
    await handleExportActivityLog();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "write_text_file",
      expect.anything(),
    );
    mockSave.mockResolvedValueOnce("/tmp/log.txt");
    mockShowConfirm.mockResolvedValueOnce(true);
    await handleExportActivityLog();
    expect(mockInvoke).toHaveBeenCalledWith(
      "write_text_file",
      expect.objectContaining({ overwrite: true }),
    );
  });

  it("go-to navigates to folders and selects files", async () => {
    const state = await setupConnected();
    state.objects = [
      { key: "docs/target.txt", size: 1, last_modified: "", is_folder: false },
    ];
    mockShowPrompt.mockResolvedValueOnce("docs/");
    const { handleGoToKeyOrPrefix } = await import("../app-objects.ts");
    await handleGoToKeyOrPrefix();
    expect(mockNavigateToFolder).toHaveBeenCalledWith("docs/");
    mockShowPrompt.mockResolvedValueOnce("docs/target.txt");
    await handleGoToKeyOrPrefix();
    expect(state.selectedKeys.has("docs/target.txt")).toBe(true);
  });

  it("go-to ignores empty input and connection changes", async () => {
    await setupConnected();
    mockShowPrompt.mockResolvedValueOnce(null);
    const { handleGoToKeyOrPrefix } = await import("../app-objects.ts");
    await handleGoToKeyOrPrefix();
    expect(mockNavigateToFolder).not.toHaveBeenCalled();
    const { state } = await import("../state.ts");
    mockShowPrompt.mockImplementation(async () => {
      state.currentBucket = "other-bucket";
      return "docs/x.txt";
    });
    await handleGoToKeyOrPrefix();
    expect(document.getElementById("status")?.textContent).toContain(
      "connection changed",
    );
  });
});
