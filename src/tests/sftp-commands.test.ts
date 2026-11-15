import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const CONNECTION_ID = "sftp-1";

const FILE_ENTRY = {
  name: "a.txt",
  path: "/a.txt",
  kind: "file",
  size: 3,
  mtime: null,
  permissions: null,
  uid: null,
  gid: null,
  owner: null,
  group: null,
  name_lossy: false,
};

const PREVIEW = {
  content_type: "text/plain",
  data: "abc",
  is_text: true,
  truncated: false,
  total_size: 3,
};

const PRIVATE_KEY = {
  key_text: "-----BEGIN OPENSSH PRIVATE KEY-----",
  algorithm: "ssh-ed25519",
  encrypted: true,
  file_name: "id_ed25519",
};

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
});

async function loadCommands() {
  return import("../sftp-commands.ts");
}

describe("SFTP command wrappers", () => {
  it("lists a directory through sftp_list_dir with the session id", async () => {
    const listing = { path: "/", entries: [FILE_ENTRY], truncated: false };
    mockInvoke.mockResolvedValueOnce(listing);
    const commands = await loadCommands();

    await expect(commands.sftpListDir(CONNECTION_ID, "/")).resolves.toEqual(
      listing,
    );
    expect(mockInvoke).toHaveBeenCalledWith("sftp_list_dir", {
      connectionId: CONNECTION_ID,
      path: "/",
    });
  });

  it("sends each filesystem command under its contract name and argument keys", async () => {
    mockInvoke.mockImplementation(async (command) => {
      switch (command) {
        case "sftp_stat":
          return FILE_ENTRY;
        case "sftp_exists":
          return true;
        case "sftp_create_dir":
          return null;
        case "sftp_rename":
          return { warning: null };
        case "sftp_delete":
          return { deleted: ["/a.txt"], failed: [] };
        case "sftp_delete_dir":
          return { deleted: [], failed: [] };
        case "sftp_preview":
          return PREVIEW;
        default:
          throw new Error(`Unexpected invoke command: ${String(command)}`);
      }
    });
    const commands = await loadCommands();

    await expect(commands.sftpStat(CONNECTION_ID, "/a.txt")).resolves.toEqual(
      FILE_ENTRY,
    );
    await expect(commands.sftpExists(CONNECTION_ID, "/a.txt")).resolves.toBe(
      true,
    );
    await expect(
      commands.sftpCreateDir(CONNECTION_ID, "/new"),
    ).resolves.toBeUndefined();
    await expect(
      commands.sftpRename(CONNECTION_ID, "/a.txt", "/b.txt", true),
    ).resolves.toBeUndefined();
    await expect(
      commands.sftpDelete(CONNECTION_ID, ["/a.txt"]),
    ).resolves.toEqual({ deleted: ["/a.txt"], failed: [] });
    await expect(
      commands.sftpDeleteDir(CONNECTION_ID, "/old"),
    ).resolves.toEqual({ deleted: [], failed: [] });
    await expect(
      commands.sftpPreview(CONNECTION_ID, "/a.txt"),
    ).resolves.toEqual(PREVIEW);

    expect(mockInvoke).toHaveBeenCalledWith("sftp_stat", {
      connectionId: CONNECTION_ID,
      path: "/a.txt",
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_exists", {
      connectionId: CONNECTION_ID,
      path: "/a.txt",
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_create_dir", {
      connectionId: CONNECTION_ID,
      path: "/new",
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_rename", {
      connectionId: CONNECTION_ID,
      fromPath: "/a.txt",
      toPath: "/b.txt",
      overwrite: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_delete", {
      connectionId: CONNECTION_ID,
      paths: ["/a.txt"],
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_delete_dir", {
      connectionId: CONNECTION_ID,
      path: "/old",
      transferId: null,
    });
    expect(mockInvoke).toHaveBeenCalledWith("sftp_preview", {
      connectionId: CONNECTION_ID,
      path: "/a.txt",
    });
  });

  it("passes a transfer id through to a folder delete so it can be cancelled", async () => {
    mockInvoke.mockResolvedValueOnce({ deleted: [], failed: [] });
    const commands = await loadCommands();

    await commands.sftpDeleteDir(CONNECTION_ID, "/old", 7);
    expect(mockInvoke).toHaveBeenCalledWith("sftp_delete_dir", {
      connectionId: CONNECTION_ID,
      path: "/old",
      transferId: 7,
    });
  });

  it("rejects a malformed result from each command instead of returning it", async () => {
    const commands = await loadCommands();

    mockInvoke.mockResolvedValueOnce({});
    await expect(commands.sftpListDir(CONNECTION_ID, "/")).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce({ name: "a.txt" });
    await expect(commands.sftpStat(CONNECTION_ID, "/a.txt")).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce("true");
    await expect(
      commands.sftpExists(CONNECTION_ID, "/a.txt"),
    ).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce(false);
    await expect(
      commands.sftpCreateDir(CONNECTION_ID, "/new"),
    ).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce(false);
    await expect(
      commands.sftpRename(CONNECTION_ID, "/a.txt", "/b.txt", false),
    ).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce({ deleted: "/a.txt", failed: [] });
    await expect(
      commands.sftpDelete(CONNECTION_ID, ["/a.txt"]),
    ).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce({ deleted: [] });
    await expect(
      commands.sftpDeleteDir(CONNECTION_ID, "/old"),
    ).rejects.toThrow();
    mockInvoke.mockResolvedValueOnce({ data: "abc" });
    await expect(
      commands.sftpPreview(CONNECTION_ID, "/a.txt"),
    ).rejects.toThrow();
  });

  it("reports a rename's cleanup warning in the activity log and as a lasting toast", async () => {
    const logActivity = vi.fn();
    const showToast = vi.fn();
    vi.doMock("../activity-log.ts", () => ({ logActivity }));
    vi.doMock("../toast.ts", () => ({ showToast }));
    const warning =
      "/b.txt was replaced, but the previous version could not be removed and is still on the server at /.b.txt.s3sk-bak-0011223344556677. Delete it once it is no longer needed.";
    mockInvoke.mockResolvedValueOnce({ warning });
    const commands = await loadCommands();

    await commands.sftpRename(CONNECTION_ID, "/a.txt", "/b.txt", true);

    expect(logActivity).toHaveBeenCalledWith(warning, "warning");
    expect(showToast).toHaveBeenCalledWith(warning, {
      type: "warning",
      duration: 0,
    });

    mockInvoke.mockResolvedValueOnce({ warning: null });
    await commands.sftpRename(CONNECTION_ID, "/a.txt", "/c.txt", true);
    expect(logActivity).toHaveBeenCalledTimes(1);
    vi.doUnmock("../activity-log.ts");
    vi.doUnmock("../toast.ts");
  });

  it("refuses a rename outcome whose warning is not a non-empty string", async () => {
    const commands = await loadCommands();
    for (const bad of [null, { warning: 3 }, { warning: "" }]) {
      mockInvoke.mockResolvedValueOnce(bad);
      await expect(
        commands.sftpRename(CONNECTION_ID, "/a.txt", "/b.txt", true),
      ).rejects.toThrow();
    }
  });

  it("propagates a native error unchanged", async () => {
    mockInvoke.mockRejectedValueOnce("Connection changed");
    const commands = await loadCommands();

    await expect(commands.sftpStat(CONNECTION_ID, "/a.txt")).rejects.toBe(
      "Connection changed",
    );
  });

  it("refuses to send a command without a session id or while storage is locked", async () => {
    const commands = await loadCommands();
    const connection = await import("../connection.ts");

    await expect(commands.sftpListDir("", "/")).rejects.toThrow(
      "Connection id is required",
    );
    expect(mockInvoke).not.toHaveBeenCalled();

    connection.setConnectionAccessLocked(true);
    try {
      await expect(commands.sftpStat(CONNECTION_ID, "/a.txt")).rejects.toThrow(
        "Encrypted storage is locked",
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    } finally {
      connection.setConnectionAccessLocked(false);
    }
  });
});

describe("pickSshPrivateKey", () => {
  it("returns the picked key, or null when the dialog is cancelled", async () => {
    const commands = await loadCommands();

    mockInvoke.mockResolvedValueOnce(null);
    await expect(commands.pickSshPrivateKey()).resolves.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("pick_ssh_private_key");

    mockInvoke.mockResolvedValueOnce(PRIVATE_KEY);
    await expect(commands.pickSshPrivateKey()).resolves.toEqual(PRIVATE_KEY);
  });

  it("does not put key text into the error for a malformed picker result", async () => {
    const commands = await loadCommands();
    mockInvoke.mockResolvedValueOnce({
      ...PRIVATE_KEY,
      key_text: "-----BEGIN SECRET KEY-----",
      encrypted: "yes",
    });

    let message = "";
    try {
      await commands.pickSshPrivateKey();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("SECRET");
  });
});
