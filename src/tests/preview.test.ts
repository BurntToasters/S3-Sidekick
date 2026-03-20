import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("preview module", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    document.body.innerHTML = `
      <div id="preview-overlay" class="modal-overlay">
        <h2 id="preview-title"></h2>
        <div id="preview-body"></div>
      </div>
    `;
  });

  it("canPreview handles supported and unsupported extensions", async () => {
    const preview = await import("../preview.ts");
    expect(preview.canPreview("readme.md")).toBe(true);
    expect(preview.canPreview("photo.jpeg")).toBe(true);
    expect(preview.canPreview("archive.zip")).toBe(false);
    expect(preview.canPreview("README")).toBe(false);
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

    mockInvoke.mockResolvedValueOnce({
      content_type: "application/octet-stream",
      data: "AAAA",
      is_text: false,
      truncated: false,
      total_size: 4,
    });
    await preview.openPreview("bin/blob.bin");
    expect(
      (document.getElementById("preview-body") as HTMLDivElement).textContent,
    ).toContain("Preview not available");

    mockInvoke.mockRejectedValueOnce(new Error("network error"));
    await preview.openPreview("bin/error.bin");
    expect(
      (document.getElementById("preview-body") as HTMLDivElement).textContent,
    ).toContain("Failed to load preview");
  });

  it("renders non-SVG image previews using a base64 data URL", async () => {
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
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });
});
