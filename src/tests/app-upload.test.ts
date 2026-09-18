import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpen =
  vi.fn<(...args: unknown[]) => Promise<string | string[] | null>>();
const mockEnqueuePaths = vi.fn();
const mockEnqueueFolderEntries = vi.fn();
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../transfers.ts", () => ({
  enqueuePaths: (...args: unknown[]) => mockEnqueuePaths(...args),
  enqueueFolderEntries: (...args: unknown[]) =>
    mockEnqueueFolderEntries(...args),
}));

describe("upload chooser account binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockOpen.mockReset();
    mockEnqueuePaths.mockReset();
    mockEnqueueFolderEntries.mockReset();
    mockInvoke.mockReset();
    document.body.innerHTML = `<span id="status"></span>`;

    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.endpoint = "https://s3.example.com";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "uploads/";
  });

  it("queues files against the snapshot identity captured before the dialog", async () => {
    mockOpen.mockResolvedValue(["/tmp/photo.png"]);
    const { handleUploadButton } = await import("../app-upload.ts");
    await handleUploadButton();

    expect(mockEnqueuePaths).toHaveBeenCalledWith(
      ["/tmp/photo.png"],
      "uploads/",
      {
        bucket: "bucket-a",
        connectionId: "conn-1",
        connectionIdentity: "ident-1",
      },
    );
  });

  it("aborts when credentials change for the same endpoint and bucket", async () => {
    mockOpen.mockImplementation(async () => {
      const { state } = await import("../state.ts");
      state.connectionIdentity = "ident-2";
      state.connectionId = "conn-2";
      return ["/tmp/photo.png"];
    });
    const { handleUploadButton } = await import("../app-upload.ts");
    await handleUploadButton();

    expect(mockEnqueuePaths).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain(
      "destination changed",
    );
  });
});
