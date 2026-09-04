import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

function inspectorFixture(): void {
  document.body.innerHTML = `
    <div id="main-layout"></div>
    <aside id="inspector-panel" hidden></aside>
    <div id="inspector-resizer" hidden></div>
    <button id="btn-inspector"></button>
    <div id="inspector-pane-preview" hidden></div>
    <div id="inspector-pane-info" hidden></div>
    <div id="inspector-empty" hidden></div>
    <div id="inspector-preview-title"></div>
    <div id="inspector-preview-body"></div>
    <div id="inspector-header-title"></div>
    <button type="button" data-inspector-tab="preview">Preview</button>
    <button type="button" data-inspector-tab="properties">Properties</button>
    <div id="preview-overlay"></div>
    <div id="preview-body"></div>
  `;
}

function appendInfoFixture(): void {
  document.body.innerHTML += `
    <div id="inspector-info-title"></div>
    <div id="inspector-info-body"></div>
    <button id="inspector-info-save"></button>
    <div class="info-tabs" id="inspector-info-tabs"></div>
    <div class="inspector-panel__footer">
      <button id="inspector-info-cancel"></button>
    </div>
  `;
}

const octetHead = {
  content_type: "application/octet-stream",
  content_length: 12,
  last_modified: "",
  etag: "",
  storage_class: "",
  cache_control: "",
  content_disposition: "",
  content_encoding: "",
  server_side_encryption: "",
  metadata: {},
};

describe("syncInspectorFromSelection", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    inspectorFixture();
  });

  it("loads preview into the docked pane for a previewable file", async () => {
    mockInvoke.mockResolvedValueOnce({
      content_type: "application/json",
      data: '{"ok":true}',
      is_text: true,
      truncated: false,
      total_size: 12,
    });

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("config/app.json");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorPreviewPane();

    await inspector.syncInspectorFromSelection(state.selectedKeys);

    const body = document.getElementById("inspector-preview-body");
    expect(body?.textContent).toContain('"ok"');
    expect(
      (document.getElementById("inspector-pane-preview") as HTMLElement).hidden,
    ).toBe(false);
  });

  it("falls back to properties for a non-previewable single file on select", async () => {
    appendInfoFixture();
    mockInvoke.mockResolvedValueOnce(octetHead);

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("bin/release.exe");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorPreviewPane();

    await inspector.syncInspectorFromSelection(state.selectedKeys, {
      reason: "selection",
    });

    expect(inspector.getInspectorTab()).toBe("properties");
    expect(
      (document.getElementById("inspector-empty") as HTMLElement).hidden,
    ).toBe(true);
    expect(
      (document.getElementById("inspector-pane-info") as HTMLElement).hidden,
    ).toBe(false);
    expect(mockInvoke).toHaveBeenCalled();
    const previewTab = document.querySelector(
      '[data-inspector-tab="preview"]',
    ) as HTMLElement;
    expect(previewTab.classList.contains("inspector-tab--unavailable")).toBe(
      true,
    );
    expect(previewTab.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Preview tab with unavailable copy when opened explicitly", async () => {
    appendInfoFixture();
    mockInvoke.mockResolvedValueOnce(octetHead);

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("bin/release.exe");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    await inspector.syncInspectorFromSelection(state.selectedKeys, {
      reason: "selection",
    });
    expect(inspector.getInspectorTab()).toBe("properties");

    inspector.setInspectorTab("preview");
    // setInspectorTab kicks off async sync — wait a turn for it.
    await vi.waitFor(() => {
      expect(inspector.getInspectorTab()).toBe("preview");
      expect(
        document.getElementById("inspector-preview-body")?.textContent,
      ).toMatch(/not available/i);
    });

    expect(
      (document.getElementById("inspector-empty") as HTMLElement).hidden,
    ).toBe(true);
    expect(
      (document.getElementById("inspector-pane-preview") as HTMLElement).hidden,
    ).toBe(false);
    expect(
      document
        .getElementById("inspector-preview-body")
        ?.querySelector(".inspector-preview-unavailable"),
    ).toBeTruthy();
  });

  it("clears docked preview when selection is empty", async () => {
    mockInvoke.mockResolvedValueOnce({
      content_type: "application/json",
      data: "{}",
      is_text: true,
      truncated: false,
      total_size: 2,
    });

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("config/app.json");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorPreviewPane();
    await inspector.syncInspectorFromSelection(state.selectedKeys);

    expect(
      document.getElementById("inspector-preview-body")?.childElementCount,
    ).toBeGreaterThan(0);

    state.selectedKeys.clear();
    await inspector.syncInspectorFromSelection(state.selectedKeys);

    expect(
      document.getElementById("inspector-preview-body")?.childElementCount,
    ).toBe(0);
    expect(
      (document.getElementById("inspector-empty") as HTMLElement).hidden,
    ).toBe(false);
  });

  it("opens properties for folder-only selection", async () => {
    appendInfoFixture();

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("prefix:folder/");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorPropertiesPane();

    await inspector.syncInspectorFromSelection(state.selectedKeys, {
      reason: "selection",
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(document.getElementById("inspector-info-body")?.textContent).toMatch(
      /folder/i,
    );
  });
});
