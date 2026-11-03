import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativePathGrant } from "../path-grants.ts";

const mockPickUploadFiles = vi.fn<() => Promise<NativePathGrant[]>>();
const mockPickUploadFolder = vi.fn<() => Promise<NativePathGrant[]>>();
const mockTakeDroppedUploadGrants = vi.fn<() => Promise<NativePathGrant[]>>();
const mockEnqueuePaths = vi.fn();
const mockEnqueueFolderEntries = vi.fn();
const ENQUEUE_ACCEPTED = { accepted: true, count: 1 };
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/plugin-dialog", () => ({}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../path-grants.ts", () => ({
  pickUploadFiles: () => mockPickUploadFiles(),
  pickUploadFolder: () => mockPickUploadFolder(),
  takeDroppedUploadGrants: () => mockTakeDroppedUploadGrants(),
}));

vi.mock("../transfers.ts", () => ({
  enqueuePaths: (...args: unknown[]) => mockEnqueuePaths(...args),
  enqueueFolderEntries: (...args: unknown[]) =>
    mockEnqueueFolderEntries(...args),
}));

function fileGrant(path: string): NativePathGrant {
  return {
    token: `grant-${path}`,
    path,
    name: path.split("/").pop() ?? path,
    isDir: false,
    directoryToken: null,
    directoryPath: null,
  };
}

describe("upload chooser account binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockPickUploadFiles.mockReset();
    mockPickUploadFolder.mockReset();
    mockTakeDroppedUploadGrants.mockReset();
    mockEnqueuePaths.mockReset();
    mockEnqueuePaths.mockImplementation(() => ENQUEUE_ACCEPTED);
    mockEnqueueFolderEntries.mockReset();
    mockEnqueueFolderEntries.mockImplementation(() => ENQUEUE_ACCEPTED);
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

  it("queues backend-granted files against the snapshot identity captured before the dialog", async () => {
    mockPickUploadFiles.mockResolvedValue([fileGrant("/tmp/photo.png")]);
    const { handleUploadButton } = await import("../app-upload.ts");
    await handleUploadButton();

    expect(mockEnqueuePaths).toHaveBeenCalledWith(
      [{ path: "/tmp/photo.png", token: "grant-/tmp/photo.png" }],
      "uploads/",
      {
        bucket: "bucket-a",
        connectionId: "conn-1",
        connectionIdentity: "ident-1",
      },
    );
  });

  it("aborts when credentials change for the same endpoint and bucket", async () => {
    mockPickUploadFiles.mockImplementation(async () => {
      const { state } = await import("../state.ts");
      state.connectionIdentity = "ident-2";
      state.connectionId = "conn-2";
      return [fileGrant("/tmp/photo.png")];
    });
    const { handleUploadButton } = await import("../app-upload.ts");
    await handleUploadButton();

    expect(mockEnqueuePaths).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain(
      "destination changed",
    );
  });

  it("scans folders only through the backend's upload-root grants", async () => {
    mockPickUploadFolder.mockResolvedValue([
      {
        token: "root-grant",
        path: "/tmp/photos",
        name: "photos",
        isDir: true,
        directoryToken: null,
        directoryPath: null,
      },
    ]);
    mockInvoke.mockResolvedValue([
      {
        file_path: "/tmp/photos/a.txt",
        relative_path: "photos/a.txt",
        size: 3,
        file_token: "file-grant-a",
      },
    ]);
    const { handleUploadFolderButton } = await import("../app-upload.ts");
    await handleUploadFolderButton();

    expect(mockInvoke).toHaveBeenCalledWith("list_local_files_recursive", {
      rootTokens: ["root-grant"],
    });
    expect(mockEnqueueFolderEntries).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          file_path: "/tmp/photos/a.txt",
          file_token: "file-grant-a",
        }),
      ],
      "uploads/",
      expect.anything(),
    );
  });

  it("never forwards renderer paths for a native drop", async () => {
    mockTakeDroppedUploadGrants.mockResolvedValue([]);
    const { queueDroppedPaths } = await import("../app-upload.ts");
    await queueDroppedPaths("uploads/");

    expect(mockTakeDroppedUploadGrants).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "list_local_files_recursive",
      expect.anything(),
    );
    expect(document.getElementById("status")?.textContent).toContain(
      "No dropped files",
    );
  });
});
