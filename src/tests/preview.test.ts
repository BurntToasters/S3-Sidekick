import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("preview module", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockInvoke.mockReset();
    document.body.innerHTML = `
      <div id="preview-overlay" class="modal-overlay">
        <h2 id="preview-title"></h2>
        <div id="preview-body"></div>
      </div>
    `;
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
  });

  it("canPreview rejects known binary extensions before any request", async () => {
    const preview = await import("../preview.ts");
    expect(preview.canPreview("readme.md")).toBe(true);
    expect(preview.canPreview("photo.jpeg")).toBe(true);
    expect(preview.canPreview("README")).toBe(true);
    expect(preview.canPreview("")).toBe(false);
    // Known archives, executables and media never fetch content.
    expect(preview.canPreview("archive.zip")).toBe(false);
    expect(preview.canPreview("ARCHIVE.TAR.GZ")).toBe(false);
    expect(preview.canPreview("setup.exe")).toBe(false);
    expect(preview.canPreview("movie.MP4")).toBe(false);
  });

  it("shows a friendly unsupported message without the raw content type", async () => {
    mockInvoke.mockResolvedValueOnce({
      content_type: "application/zip",
      data: "",
      is_text: false,
      truncated: false,
      total_size: 2048,
    });
    const preview = await import("../preview.ts");
    await preview.openPreview("bundles/archive.dat");

    const body = document.getElementById("preview-body") as HTMLDivElement;
    expect(body.textContent).toContain(
      "Preview not available for this file type.",
    );
    expect(body.textContent).not.toContain("application/zip");
    expect(body.querySelector("img")).toBeNull();
  });

  it("renders an image over the preview limit as Too large with a Download action", async () => {
    mockInvoke.mockResolvedValueOnce({
      content_type: "image/png",
      data: "",
      is_text: false,
      truncated: false,
      total_size: 5_000_000,
    });
    const preview = await import("../preview.ts");
    await preview.openPreview("images/huge.png");

    const body = document.getElementById("preview-body") as HTMLDivElement;
    expect(body.textContent).toContain("Too large to preview");
    expect(body.querySelector("img")).toBeNull();
    const download = body.querySelector<HTMLButtonElement>(
      "[data-preview-download]",
    );
    expect(download?.type).toBe("button");
    expect(download?.textContent).toBe("Download");
  });

  it("renders text preview and truncated size hint", async () => {
    mockInvoke.mockResolvedValueOnce({
      content_type: "text/plain",
      data: "<hello>",
      is_text: true,
      truncated: true,
      total_size: 2_097_152,
    });

    const preview = await import("../preview.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";

    await preview.openPreview("notes/readme.txt");

    const overlay = document.getElementById(
      "preview-overlay",
    ) as HTMLDivElement;
    const title = document.getElementById(
      "preview-title",
    ) as HTMLHeadingElement;
    const body = document.getElementById("preview-body") as HTMLDivElement;

    expect(overlay.classList.contains("active")).toBe(true);
    expect(title.textContent).toBe("readme.txt");
    expect(body.querySelector(".preview-text")?.textContent).toBe("<hello>");
    expect(body.textContent).toContain("Showing first 1 MB");
    expect(mockInvoke).toHaveBeenCalledWith("preview_object", {
      bucket: "bucket-a",
      key: "notes/readme.txt",
      connectionId: "test-connection",
    });
  });

  it("renders svg previews using object URLs and revokes URL on close", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:preview-1");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    mockInvoke.mockResolvedValueOnce({
      content_type: "image/svg+xml",
      data: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      is_text: false,
      truncated: false,
      total_size: 64,
    });

    const preview = await import("../preview.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";

    await preview.openPreview("icons/logo.svg");
    const img = document.querySelector("#preview-body img") as HTMLImageElement;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(img.src).toContain("blob:preview-1");

    preview.closePreview();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(
      (
        document.getElementById("preview-overlay") as HTMLDivElement
      ).classList.contains("active"),
    ).toBe(false);
  });

  it("renders unsupported and error states", async () => {
    const preview = await import("../preview.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";

    await preview.openPreview("bin/blob.bin");
    expect(
      (document.getElementById("preview-body") as HTMLDivElement).textContent,
    ).toContain("Preview not available");
    expect(mockInvoke).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValueOnce(new Error("network error"));
    // .bin is refused before any request now, so the network error needs a
    // previewable name to reach the fetch.
    await preview.openPreview("bin/error.json");
    const body = document.getElementById("preview-body") as HTMLDivElement;
    expect(body.textContent).toContain("Failed to load preview");
    expect(body.querySelector("[role='alert']")).not.toBeNull();
    expect(body.querySelector("[data-preview-retry]")).not.toBeNull();
  });

  it("renders non-SVG image previews using a blob object URL", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:preview-png");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    mockInvoke.mockResolvedValueOnce({
      content_type: "image/png",
      data: "AAAA",
      is_text: false,
      truncated: false,
      total_size: 4,
    });
    const preview = await import("../preview.ts");
    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";

    await preview.openPreview("images/photo.png");
    const img = document.querySelector("#preview-body img") as HTMLImageElement;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(img.getAttribute("src")).toBe("blob:preview-png");

    preview.closePreview();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-png");
  });
});
