import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativePathGrant } from "../path-grants.ts";

function fileGrant(path: string): NativePathGrant {
  const name = path.split("/").pop() ?? path;
  const dir = path.slice(0, path.lastIndexOf("/"));
  return {
    token: `grant-${path}`,
    path,
    name,
    isDir: false,
    directoryToken: `grant-dir-${dir}`,
    directoryPath: dir,
  };
}

function directoryGrant(path: string): NativePathGrant {
  return {
    token: `grant-dir-${path}`,
    path,
    name: path.split("/").pop() ?? path,
    isDir: true,
    directoryToken: null,
    directoryPath: null,
  };
}

const mockPickFile =
  vi.fn<
    (
      fileName?: string,
      title?: string,
      defaultDirectory?: string,
    ) => Promise<NativePathGrant | null>
  >();
const mockPickDirectory =
  vi.fn<
    (
      title?: string,
      defaultDirectory?: string,
    ) => Promise<NativePathGrant | null>
  >();
const mockEnqueueDownloads = vi.fn();
const ENQUEUE_ACCEPTED = { accepted: true, count: 1 };
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("../path-grants.ts", () => ({
  pickDownloadFile: (
    fileName?: string,
    title?: string,
    defaultDirectory?: string,
  ) => mockPickFile(fileName, title, defaultDirectory),
  pickDownloadDirectory: (title?: string, defaultDirectory?: string) =>
    mockPickDirectory(title, defaultDirectory),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../transfers.ts", () => ({
  enqueueDownloads: (...args: unknown[]) => mockEnqueueDownloads(...args),
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: (...args: unknown[]) => mockShowConfirm(...args),
}));

describe("download chooser account binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockPickFile.mockReset();
    mockPickDirectory.mockReset();
    mockEnqueueDownloads.mockReset();
    mockEnqueueDownloads.mockImplementation(() => ENQUEUE_ACCEPTED);
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    mockInvoke.mockResolvedValue(false);
    localStorage.clear();
    document.body.innerHTML = `<span id="status"></span>`;

    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.endpoint = "https://s3.example.com";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.platformName = "macos";
    state.objects = [];
    state.currentSettings.conflictPolicy = "replace";
  });

  it("queues against the snapshot identity captured before the save dialog", async () => {
    mockPickFile.mockResolvedValue(fileGrant("/tmp/file.txt"));
    // Unknown sizes fail the disk preflight closed (M3); provide a size.
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "path_exists") return false;
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();

    expect(mockEnqueueDownloads).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          bucket: "bucket-a",
          key: "docs/file.txt",
          destination: "/tmp/file.txt",
          destinationToken: "grant-/tmp/file.txt",
        }),
      ],
      {
        bucket: "bucket-a",
        connectionId: "conn-1",
        connectionIdentity: "ident-1",
      },
    );
  });

  it("forwards the remembered download folder to both pickers", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockPickFile.mockResolvedValue(fileGrant("/tmp/dl/file.txt"));
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockPickFile).toHaveBeenCalledWith(
      "file.txt",
      "Save file.txt",
      "/tmp/dl",
    );

    const { state } = await import("../state.ts");
    state.selectedKeys.add("docs/other.txt");
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dl"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 1 };
      return undefined;
    });
    await handleDownload();
    expect(mockPickDirectory).toHaveBeenCalledWith(undefined, "/tmp/dl");
  });

  it("aborts when the account changes while the save dialog is open", async () => {
    mockPickFile.mockImplementation(async () => {
      const { state } = await import("../state.ts");
      state.connectionId = "conn-2";
      state.connectionIdentity = "ident-2";
      return fileGrant("/tmp/file.txt");
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();

    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain(
      "connection or location changed",
    );
  });
});

describe("download disk preflight", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockPickFile.mockReset();
    mockPickDirectory.mockReset();
    mockEnqueueDownloads.mockReset();
    mockEnqueueDownloads.mockImplementation(() => ENQUEUE_ACCEPTED);
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    localStorage.clear();
    document.body.innerHTML = `<span id="status"></span>`;
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.endpoint = "https://s3.example.com";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();
    state.platformName = "macos";
    state.objects = [];
    state.currentSettings.conflictPolicy = "replace";
  });

  async function setupSingle(key = "docs/file.txt") {
    const { state } = await import("../state.ts");
    state.selectedKeys.clear();
    state.selectedKeys.add(key);
    mockPickFile.mockResolvedValue(fileGrant("/tmp/file.txt"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      return undefined;
    });
  }

  it("refuses the queue when head_object throws (unknown size fails closed, M3)", async () => {
    await setupSingle();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") throw new Error("head boom");
      if (cmd === "get_available_disk_bytes") return 1;
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "get_available_disk_bytes",
      expect.anything(),
    );
  });

  it("treats invalid content_length as unknown and refuses the queue (M3)", async () => {
    await setupSingle();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: -1 };
      if (cmd === "get_available_disk_bytes") return 1;
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "get_available_disk_bytes",
      expect.anything(),
    );
  });

  it("skips disk check when total is under the 128MB threshold", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.objects = [
      { key: "docs/file.txt", size: 5, last_modified: "", is_folder: false },
    ];
    mockPickFile.mockResolvedValue(fileGrant("/tmp/file.txt"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes") return 1;
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "get_available_disk_bytes",
      expect.anything(),
    );
    // Known size avoids the head_object fallback entirely.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "head_object",
      expect.anything(),
    );
  });

  it("checks disk for large totals and proceeds when space suffices", async () => {
    const { state } = await import("../state.ts");
    const big = 100 * 1024 * 1024;
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/a.bin");
    state.selectedKeys.add("docs/b.bin");
    state.objects = [
      { key: "docs/a.bin", size: big, last_modified: "", is_folder: false },
      { key: "docs/b.bin", size: big, last_modified: "", is_folder: false },
    ];
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dest"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes") return 1024 * 1024 * 1024;
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_available_disk_bytes",
      expect.objectContaining({ token: "grant-dir-/tmp/dest" }),
    );
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("prompts on shortage and queues only when confirmed", async () => {
    const { state } = await import("../state.ts");
    const big = 200 * 1024 * 1024;
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/a.bin");
    state.objects = [
      { key: "docs/a.bin", size: big, last_modified: "", is_folder: false },
    ];
    mockPickFile.mockResolvedValue(fileGrant("/tmp/a.bin"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes") return 1;
      return undefined;
    });

    mockShowConfirm.mockResolvedValueOnce(true);
    const first = await import("../app-downloads.ts");
    await first.handleDownload();
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(mockShowConfirm.mock.calls[0]?.[0]).toBe("Low disk space");
    expect(mockEnqueueDownloads).toHaveBeenCalledTimes(1);

    mockEnqueueDownloads.mockClear();
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValueOnce(false);
    // Re-import fresh module state after resetModules? Reuse same module.
    await first.handleDownload();
    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain(
      "cancelled by disk-space",
    );
  });

  it("refuses the queue when the disk probe throws (M3)", async () => {
    const { state } = await import("../state.ts");
    const big = 200 * 1024 * 1024;
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/a.bin");
    state.objects = [
      { key: "docs/a.bin", size: big, last_modified: "", is_folder: false },
    ];
    mockPickFile.mockResolvedValue(fileGrant("/tmp/a.bin"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes")
        throw new Error("disk probe boom");
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("dedupes same-basename multi downloads case-insensitively", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/File.txt");
    state.selectedKeys.add("other/file.txt");
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dest"));
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).toHaveBeenCalledTimes(1);
    const entries = mockEnqueueDownloads.mock.calls[0]?.[0] as Array<{
      destination: string;
      destinationToken?: string;
      destinationName?: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.destination).toContain("File.txt");
    expect(entries[1]?.destination).toContain("(2)");
    expect(entries[0]?.destination).not.toBe(entries[1]?.destination);
    // Every entry spends the folder grant and a single validated child name.
    expect(entries[0]?.destinationToken).toBe("grant-dir-/tmp/dest");
    expect(entries[0]?.destinationName).toBe("File.txt");
    expect(entries[1]?.destinationName).toBe("file (2).txt");
  });
});

describe("download child names and shell startup destinations", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockPickFile.mockReset();
    mockPickDirectory.mockReset();
    mockEnqueueDownloads.mockReset();
    mockEnqueueDownloads.mockImplementation(() => ENQUEUE_ACCEPTED);
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    mockInvoke.mockResolvedValue(false);
    localStorage.clear();
    document.body.innerHTML = `<span id="status"></span>`;
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.endpoint = "https://s3.example.com";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.selectedKeys.clear();
    state.platformName = "linux";
    state.objects = [];
    state.currentSettings.conflictPolicy = "replace";
  });

  it("trims candidates like the backend and encodes backslashes", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.add("a/report.txt ");
    state.selectedKeys.add("b/report.txt");
    state.selectedKeys.add("c/back\\slash.txt");
    // Unknown sizes fail the disk preflight closed (M3); provide sizes.
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "head_object") return { content_length: 5 };
      if (cmd === "path_exists") return false;
      return undefined;
    });
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dest"));
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();

    const entries = mockEnqueueDownloads.mock.calls[0]?.[0] as Array<{
      destinationName: string;
    }>;
    // A trailing space is encoded rather than silently trimmed, so the two
    // source keys stay distinct and both names remain Windows-portable (M10).
    expect(entries.map((entry) => entry.destinationName)).toEqual([
      "report.txt%20",
      "report.txt",
      "back%5Cslash.txt",
    ]);
  });

  it("requires explicit consent before replacing a shell startup file", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.add(".bashrc");
    mockPickFile.mockResolvedValue(fileGrant("/tmp/.bashrc"));
    mockShowConfirm.mockResolvedValue(false);
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();

    expect(mockShowConfirm).toHaveBeenCalledWith(
      "Replace shell startup file?",
      expect.stringContaining(".bashrc"),
      expect.anything(),
    );
    expect(mockEnqueueDownloads).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain(
      "shell startup file not replaced",
    );
  });
});

describe("last download folder", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockPickFile.mockReset();
    mockPickDirectory.mockReset();
    mockEnqueueDownloads.mockReset();
    mockEnqueueDownloads.mockImplementation(() => ENQUEUE_ACCEPTED);
    mockInvoke.mockReset();
    mockShowConfirm.mockReset();
    localStorage.clear();
    document.body.innerHTML = `<span id="status"></span>`;
    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.currentBucket = "bucket-a";
    state.platformName = "macos";
  });

  it("reports when no folder is remembered", async () => {
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "No remembered download folder",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("opens the remembered folder through a native folder grant", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dl"));
    mockInvoke.mockResolvedValueOnce(undefined);
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(mockPickDirectory).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("open_local_path", {
      token: "grant-dir-/tmp/dl",
    });
    expect(document.getElementById("status")?.textContent).toContain("Opened");
  });

  it("does not open the stored path when the picker is cancelled", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockPickDirectory.mockResolvedValue(null);
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "open_local_path",
      expect.anything(),
    );
  });

  it("maps open failures through friendlyError", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockPickDirectory.mockResolvedValue(directoryGrant("/tmp/dl"));
    mockInvoke.mockRejectedValueOnce(new Error("403 Forbidden"));
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "Access denied",
    );
  });
});
