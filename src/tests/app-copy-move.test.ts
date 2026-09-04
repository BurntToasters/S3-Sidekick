import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnqueueCopyMoveEntries = vi.fn();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("../transfers.ts", () => ({
  enqueueCopyMoveEntries: (...args: unknown[]) =>
    mockEnqueueCopyMoveEntries(...args),
}));

vi.mock("../browser.ts", () => ({
  clearSelection: vi.fn(),
}));

vi.mock("../dialogs.ts", () => ({
  showConfirm: (...args: unknown[]) => mockShowConfirm(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function renderCopyMoveFixture(): void {
  document.body.innerHTML = `
    <div id="copy-move-overlay">
      <p id="copy-move-desc"></p>
      <select id="copy-move-bucket"></select>
      <label for="copy-move-path"></label>
      <input id="copy-move-path" />
      <button id="copy-move-copy-btn"></button>
      <button id="copy-move-move-btn"></button>
      <button id="copy-move-cancel"></button>
      <button id="copy-move-close"></button>
      <div id="copy-move-recent-wrap" hidden>
        <div id="copy-move-recent-list"></div>
      </div>
      <div id="copy-move-browser" hidden></div>
      <button id="copy-move-browse-toggle"></button>
      <div id="copy-move-browser-crumbs"></div>
      <div id="copy-move-browser-list"></div>
    </div>
    <span id="status"></span>
  `;
}

describe("copy/move chooser account binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockEnqueueCopyMoveEntries.mockReset();
    mockShowConfirm.mockReset();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "list_objects") {
        return {
          objects: [],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      return undefined;
    });
    localStorage.clear();
    renderCopyMoveFixture();

    const { state } = await import("../state.ts");
    state.connected = true;
    state.connectionId = "conn-1";
    state.connectionIdentity = "ident-1";
    state.endpoint = "https://s3.example.com";
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    state.buckets = [{ name: "bucket-a", creation_date: "" }];
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.currentSettings.conflictPolicy = "replace";
  });

  it("queues against the snapshot identity captured when the dialog opened", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            sourceBucket: "bucket-a",
            sourceKey: "docs/file.txt",
            destinationBucket: "bucket-a",
            destinationKey: "archive/file.txt",
          }),
        ],
        {
          bucket: "bucket-a",
          connectionId: "conn-1",
          connectionIdentity: "ident-1",
        },
      );
    });
  });

  it("aborts when the session changes before copy is submitted", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    const { state } = await import("../state.ts");
    state.connectionId = "conn-2";
    state.connectionIdentity = "ident-2";
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "connection or selection changed",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
  });

  it("queues moves without offering an unversioned deletion override", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-move-btn") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ operation: "move" })],
        expect.anything(),
      );
    });
    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(
      localStorage.getItem("s3-sidekick.move-unversioned-warning.v1"),
    ).toBeNull();
  });
});
