import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectedFiles: ["docs/file.txt"] as string[],
  selectedPrefixes: [] as string[],
  captureConnectionSnapshot: vi.fn(() => ({
    connectionId: "connection-a",
    bucket: "bucket-a",
    prefix: "docs/",
  })),
  connectionSnapshotChanged: vi.fn(() => false),
  invokeS3For: vi.fn(),
  refreshObjects: vi.fn(async () => true),
  showConfirm: vi.fn(),
  updateSelectionUI: vi.fn(),
  invalidateInspectorSelectionSync: vi.fn(),
  logActivity: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../connection.ts", () => ({
  captureConnectionSnapshot: mocks.captureConnectionSnapshot,
  connectionSnapshotChanged: mocks.connectionSnapshotChanged,
  invokeS3: vi.fn(),
  invokeS3For: mocks.invokeS3For,
  refreshObjects: mocks.refreshObjects,
  refreshBuckets: vi.fn(),
}));
vi.mock("../browser.ts", () => ({
  renderObjectTable: vi.fn(),
  renderBreadcrumb: vi.fn(),
  renderBucketList: vi.fn(),
  navigateToFolder: vi.fn(),
  clearSelection: vi.fn(() => {
    mocks.selectedFiles = [];
    mocks.selectedPrefixes = [];
  }),
  updateSelectionUI: mocks.updateSelectionUI,
  invalidateInspectorSelectionSync: mocks.invalidateInspectorSelectionSync,
}));
vi.mock("../dialogs.ts", () => ({
  showConfirm: mocks.showConfirm,
  showPrompt: vi.fn(),
}));
vi.mock("../activity-log.ts", () => ({
  logActivity: mocks.logActivity,
  exportActivityLogText: vi.fn(),
}));
vi.mock("../app-status.ts", () => ({ setStatus: mocks.setStatus }));
vi.mock("../app-selection.ts", () => ({
  getSelectedFileKeys: () => [...mocks.selectedFiles],
  getSelectedPrefixes: () => [...mocks.selectedPrefixes],
}));
vi.mock("../app-conflicts.ts", () => ({
  resolveAbsentObjectWriteIntent: vi.fn(),
  resolveObjectConflict: vi.fn(),
  resolveConflictChoice: vi.fn(),
}));

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="batch-delete">
      <span class="batch-toolbar__label">Delete</span>
    </button>
  `;
}

describe("destructive delete single-flight", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.selectedFiles = ["docs/file.txt"];
    mocks.selectedPrefixes = [];
    mocks.captureConnectionSnapshot.mockClear();
    mocks.connectionSnapshotChanged.mockClear().mockReturnValue(false);
    mocks.invokeS3For.mockReset().mockResolvedValue({
      deleted: 1,
      failed: 0,
      incomplete: false,
      errors: [],
    });
    mocks.refreshObjects.mockClear().mockResolvedValue(true);
    mocks.showConfirm.mockReset();
    mocks.updateSelectionUI.mockClear();
    mocks.invalidateInspectorSelectionSync.mockClear();
    mocks.logActivity.mockClear();
    mocks.setStatus.mockClear();
    renderFixture();
  });

  it("shares one confirmation and backend operation across duplicate activation", async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    mocks.showConfirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const objects = await import("../app-objects.ts");

    const first = objects.handleDelete();
    const duplicate = objects.handleDelete();
    const button = document.getElementById("batch-delete") as HTMLButtonElement;

    expect(duplicate).toBe(first);
    expect(objects.isDeleteInProgress()).toBe(true);
    expect(mocks.showConfirm).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Deleting");

    resolveConfirmation?.(true);
    await first;

    expect(mocks.invokeS3For).toHaveBeenCalledTimes(1);
    expect(mocks.invokeS3For).toHaveBeenCalledWith(
      "connection-a",
      "delete_objects",
      { bucket: "bucket-a", keys: ["docs/file.txt"] },
    );
    expect(objects.isDeleteInProgress()).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.textContent).toContain("Delete");

    mocks.selectedFiles = ["docs/other.txt"];
    mocks.showConfirm.mockResolvedValueOnce(false);
    await objects.handleDelete();
    expect(mocks.showConfirm).toHaveBeenCalledTimes(2);
    expect(mocks.invokeS3For).toHaveBeenCalledTimes(1);
  });

  it("invalidates inspector data after an explicit object refresh", async () => {
    const { state } = await import("../state.ts");
    state.connected = true;
    state.currentBucket = "bucket-a";
    state.currentPrefix = "docs/";
    const objects = await import("../app-objects.ts");

    await objects.handleRefresh();

    expect(mocks.refreshObjects).toHaveBeenCalledWith("bucket-a", "docs/");
    expect(mocks.invalidateInspectorSelectionSync).toHaveBeenCalledTimes(1);
  });
});
