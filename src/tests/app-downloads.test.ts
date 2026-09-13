import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSave = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockOpen = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockEnqueueDownloads = vi.fn();
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
  open: (...args: unknown[]) => mockOpen(...args),
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
    mockSave.mockReset();
    mockOpen.mockReset();
    mockEnqueueDownloads.mockReset();
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
    mockSave.mockResolvedValue("/tmp/file.txt");
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();

    expect(mockEnqueueDownloads).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          bucket: "bucket-a",
          key: "docs/file.txt",
          destination: "/tmp/file.txt",
        }),
      ],
      {
        bucket: "bucket-a",
        connectionId: "conn-1",
        connectionIdentity: "ident-1",
      },
    );
  });

  it("aborts when the account changes while the save dialog is open", async () => {
    mockSave.mockImplementation(async () => {
      const { state } = await import("../state.ts");
      state.connectionId = "conn-2";
      state.connectionIdentity = "ident-2";
      return "/tmp/file.txt";
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
    mockSave.mockReset();
    mockOpen.mockReset();
    mockEnqueueDownloads.mockReset();
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
    mockSave.mockResolvedValue("/tmp/file.txt");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: 5 };
      return undefined;
    });
  }

  it("fails open when head_object throws (unknown size skips disk check)", async () => {
    await setupSingle();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") throw new Error("head boom");
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
  });

  it("treats invalid content_length as unknown and fails open", async () => {
    await setupSingle();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "head_object") return { content_length: -1 };
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
  });

  it("skips disk check when total is under the 128MB threshold", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.objects = [
      { key: "docs/file.txt", size: 5, last_modified: "", is_folder: false },
    ];
    mockSave.mockResolvedValue("/tmp/file.txt");
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
    mockOpen.mockResolvedValue("/tmp/dest");
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
      expect.objectContaining({ path: "/tmp/dest" }),
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
    mockSave.mockResolvedValue("/tmp/a.bin");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes") return 1;
      return undefined;
    });

    mockShowConfirm.mockResolvedValueOnce(true);
    const first = await import("../app-downloads.ts");
    await first.handleDownload();
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    expect(mockShowConfirm.mock.calls[0]?.[0]).toBe("Low Disk Space");
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

  it("warns but proceeds when the disk probe throws", async () => {
    const { state } = await import("../state.ts");
    const big = 200 * 1024 * 1024;
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/a.bin");
    state.objects = [
      { key: "docs/a.bin", size: big, last_modified: "", is_folder: false },
    ];
    mockSave.mockResolvedValue("/tmp/a.bin");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      if (cmd === "get_available_disk_bytes")
        throw new Error("disk probe boom");
      return undefined;
    });
    const { handleDownload } = await import("../app-downloads.ts");
    await handleDownload();
    expect(mockEnqueueDownloads).toHaveBeenCalledTimes(1);
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("dedupes same-basename multi downloads case-insensitively", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/File.txt");
    state.selectedKeys.add("other/file.txt");
    mockOpen.mockResolvedValue("/tmp/dest");
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
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.destination).toContain("File.txt");
    expect(entries[1]?.destination).toContain("(2)");
    expect(entries[0]?.destination).not.toBe(entries[1]?.destination);
  });
});

describe("last download folder", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockSave.mockReset();
    mockOpen.mockReset();
    mockEnqueueDownloads.mockReset();
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

  it("opens the remembered folder", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockInvoke.mockResolvedValueOnce(undefined);
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(mockInvoke).toHaveBeenCalledWith("open_local_path", {
      path: "/tmp/dl",
    });
    expect(document.getElementById("status")?.textContent).toContain("Opened");
  });

  it("maps open failures through friendlyError", async () => {
    localStorage.setItem("s3-sidekick.last-download-dir", "/tmp/dl");
    mockInvoke.mockRejectedValueOnce(new Error("403 Forbidden"));
    const { handleOpenLastDownloadFolder } =
      await import("../app-downloads.ts");
    await handleOpenLastDownloadFolder();
    expect(document.getElementById("status")?.textContent).toContain(
      "Access denied",
    );
  });
});
