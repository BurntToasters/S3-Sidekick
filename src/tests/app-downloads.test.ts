import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSave = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockOpen = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const mockEnqueueDownloads = vi.fn();
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

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

describe("download chooser account binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockSave.mockReset();
    mockOpen.mockReset();
    mockEnqueueDownloads.mockReset();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(false);
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
