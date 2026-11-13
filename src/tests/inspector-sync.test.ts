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
    <button type="button" data-inspector-tab="details">Details</button>
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

    await inspector.syncInspectorFromSelection(
      (await import("../app-selection.ts")).getSelectionEntries(),
    );

    const body = document.getElementById("inspector-preview-body");
    expect(body?.textContent).toContain('"ok"');
    expect(
      (document.getElementById("inspector-pane-preview") as HTMLElement).hidden,
    ).toBe(false);
  });

  it("opens preview (rendered unavailable) for a binary single file on select", async () => {
    appendInfoFixture();
    mockInvoke.mockResolvedValueOnce({
      content_type: "application/octet-stream",
      data: "AAAA",
      is_text: false,
      truncated: false,
      total_size: 12,
    });

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("bin/release.exe");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorPreviewPane();

    await inspector.syncInspectorFromSelection(
      (await import("../app-selection.ts")).getSelectionEntries(),
      {
        reason: "selection",
      },
    );

    // A known-binary extension never reaches the preview fetch: the selection
    // opens Properties and the Preview tab is marked unavailable.
    expect(inspector.getInspectorTab()).toBe("details");
    expect(
      (document.getElementById("inspector-empty") as HTMLElement).hidden,
    ).toBe(true);
    expect(
      (document.getElementById("inspector-pane-info") as HTMLElement).hidden,
    ).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "preview_object",
      expect.anything(),
    );
    const previewTab = document.querySelector(
      '[data-inspector-tab="preview"]',
    ) as HTMLButtonElement;
    // The unavailable tab is truly inert now: disabled, not just faded.
    expect(previewTab.disabled).toBe(true);
    expect(previewTab.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Preview tab with unavailable copy when opened explicitly", async () => {
    appendInfoFixture();
    mockInvoke.mockResolvedValue({
      content_type: "application/octet-stream",
      data: "AAAA",
      is_text: false,
      truncated: false,
      total_size: 12,
    });

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedKeys.add("bin/release.exe");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    await inspector.syncInspectorFromSelection(
      (await import("../app-selection.ts")).getSelectionEntries(),
      {
        reason: "selection",
      },
    );
    // Selection lands on Properties because Preview does not apply.
    expect(inspector.getInspectorTab()).toBe("details");

    inspector.setInspectorTab("preview");
    // setInspectorTab kicks off async sync — wait for the preview to settle.
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
    // openPreview renders binary content as an unavailable message
    // (.preview-unsupported); the explicit-tab unavailable card
    // (.inspector-preview-unavailable) only applies when preview is gated.
    await vi.waitFor(() => {
      expect(
        document.getElementById("inspector-preview-body")?.textContent,
      ).toMatch(/not available/i);
    });
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
    await inspector.syncInspectorFromSelection(
      (await import("../app-selection.ts")).getSelectionEntries(),
    );

    expect(
      document.getElementById("inspector-preview-body")?.childElementCount,
    ).toBeGreaterThan(0);

    state.selectedKeys.clear();
    await inspector.syncInspectorFromSelection(
      (await import("../app-selection.ts")).getSelectionEntries(),
    );

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
    state.selectedPrefixes.add("folder/");

    const inspector = await import("../inspector.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorInfoPane("details");

    await inspector.syncInspectorFromSelection(undefined, {
      reason: "selection",
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(document.getElementById("inspector-info-body")?.textContent).toMatch(
      /folder/i,
    );
  });

  it("keeps explicit Properties pane when opening inspector for a previewable file", async () => {
    vi.useFakeTimers();
    try {
      appendInfoFixture();
      mockInvoke.mockResolvedValue({
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
      state.selectedKeys.add("latest-linux-beta-x86_64.json");

      const inspector = await import("../inspector.ts");
      expect(inspector.isInspectorOpen()).toBe(false);

      inspector.ensureInspectorOpenForPane("details");
      expect(inspector.isInspectorOpen()).toBe(true);
      expect(inspector.getInspectorTab()).toBe("details");

      await vi.advanceTimersByTimeAsync(400);
      expect(inspector.getInspectorTab()).toBe("details");
      expect(mockInvoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit Properties wins over in-flight selection preview", async () => {
    vi.useFakeTimers();
    try {
      appendInfoFixture();
      mockInvoke.mockResolvedValue({
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
      state.selectedKeys.add("latest-linux-beta-x86_64.json");

      const inspector = await import("../inspector.ts");
      inspector.setInspectorOpen(true, { syncSelection: false });
      const syncPromise = inspector.syncInspectorFromSelection(
        (await import("../app-selection.ts")).getSelectionEntries(),
      );
      inspector.ensureInspectorOpenForPane("details");
      await vi.advanceTimersByTimeAsync(400);
      await syncPromise;

      expect(inspector.getInspectorTab()).toBe("details");
      expect(mockInvoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders after the info panel closes instead of reusing the old signature", async () => {
    appendInfoFixture();

    const { state } = await import("../state.ts");
    state.currentBucket = "bucket-a";
    state.connectionId = "test-connection";
    state.connectionIdentity = "test-identity";
    state.selectedKeys.clear();
    state.selectedPrefixes.clear();
    state.selectedPrefixes.add("folder/");

    const inspector = await import("../inspector.ts");
    const info = await import("../info-panel.ts");
    inspector.setInspectorOpen(true);
    inspector.focusInspectorInfoPane("details");
    await inspector.syncInspectorFromSelection(undefined, {
      reason: "selection",
    });

    expect(document.getElementById("inspector-info-body")?.textContent).toMatch(
      /folder/i,
    );

    info.closeInfoPanel();
    expect(
      document.getElementById("inspector-info-body")?.childElementCount,
    ).toBe(0);

    // The explicit resync after Cancel must render again; the previous
    // completed-selection signature cannot suppress it.
    await inspector.syncInspectorFromSelection();
    expect(document.getElementById("inspector-info-body")?.textContent).toMatch(
      /folder/i,
    );
  });

  it("keeps A visible when selection goes A → B → A during preview debounce", async () => {
    vi.useFakeTimers();
    try {
      mockInvoke.mockImplementation(async (command, args) => {
        if (command !== "preview_object") return undefined;
        const key = String((args as { key?: string }).key ?? "");
        return {
          content_type: "application/json",
          data: JSON.stringify({ key }),
          is_text: true,
          truncated: false,
          total_size: 10,
        };
      });

      const { state } = await import("../state.ts");
      state.currentBucket = "bucket-a";
      state.connectionId = "test-connection";
      state.connectionIdentity = "test-identity";
      state.objects = [
        {
          key: "a.json",
          size: 10,
          last_modified: "2025-01-01T00:00:00Z",
          is_folder: false,
        },
        {
          key: "b.json",
          size: 10,
          last_modified: "2025-01-01T00:00:00Z",
          is_folder: false,
        },
      ];
      state.selectedKeys.clear();
      state.selectedKeys.add("a.json");

      const inspector = await import("../inspector.ts");
      const selection = await import("../app-selection.ts");
      inspector.setInspectorOpen(true);
      inspector.focusInspectorPreviewPane();
      const initialSync = inspector.syncInspectorFromSelection(
        selection.getSelectionEntries(),
      );
      await vi.advanceTimersByTimeAsync(400);
      await initialSync;
      expect(
        document.getElementById("inspector-preview-body")?.textContent,
      ).toContain("a.json");

      // B starts loading, then A is selected again before B's debounce fires.
      state.selectedKeys.clear();
      state.selectedKeys.add("b.json");
      const pendingB = inspector.syncInspectorFromSelection(
        selection.getSelectionEntries(),
      );
      state.selectedKeys.clear();
      state.selectedKeys.add("a.json");
      const pendingA = inspector.syncInspectorFromSelection(
        selection.getSelectionEntries(),
      );
      await vi.advanceTimersByTimeAsync(400);
      await Promise.all([pendingB, pendingA]);

      expect(
        document.getElementById("inspector-preview-body")?.textContent,
      ).toContain("a.json");
      expect(
        document.getElementById("inspector-preview-title")?.textContent,
      ).toBe("a.json");
    } finally {
      vi.useRealTimers();
    }
  });
});
