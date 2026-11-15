// Failure modes covered before implementation (SFTP transfer routing):
// - An SFTP row reaches an S3 command, or an S3 row runs on an SFTP session
//   (or the reverse) when the connection identities match.
// - A folder upload writes before its remote parents exist.
// - A download sizes itself with head_object or drops the checkpoint id.
// - A folder download queues symlinks, names that are not UTF-8, or a truncated listing.
// - A lost SFTP connection fails the row, or "already exists" is not a conflict.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPickDownloadFile =
  vi.fn<(fileName?: string, title?: string) => Promise<unknown>>();
const mockShowConfirm = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const mockShowChoiceDialog = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockListen =
  vi.fn<
    (event: string, callback: (event: unknown) => void) => Promise<() => void>
  >();
const TEST_RECOVERY_SESSION = "b".repeat(64);
const SFTP_CONNECTION = "sftp-connection-1";
const SFTP_IDENTITY = "sftp-identity-1";
const EMPTY_HYDRATION = {
  recovery_session: TEST_RECOVERY_SESSION,
  manifest_json: "",
  legacy_import_allowed: false,
};
let disposeTransfers: (() => void) | undefined;
const removeNetworkListeners: Array<() => void> = [];

function renderFixture(): void {
  document.body.innerHTML = `
    <button id="activity-toggle"></button>
    <span id="activity-badge" style="display:none"></span>
    <button id="transfer-toggle">
      <span id="transfer-badge" style="display:none"></span>
    </button>
    <div id="bottom-drawer" class="bottom-drawer" hidden>
      <div class="bottom-drawer__resize-handle"></div>
      <div class="bottom-drawer__header">
        <div class="bottom-drawer__tabs">
          <button class="bottom-drawer__tab bottom-drawer__tab--active" id="drawer-tab-activity" role="tab" aria-selected="true" aria-controls="drawer-panel-activity" tabindex="0">Activity <span id="drawer-activity-badge" class="drawer-badge" style="display:none"></span></button>
          <button class="bottom-drawer__tab" id="drawer-tab-transfers" role="tab" aria-selected="false" aria-controls="drawer-panel-transfers" tabindex="-1">Transfers <span id="drawer-transfer-badge" class="drawer-badge" style="display:none"></span></button>
        </div>
        <div class="bottom-drawer__actions">
          <button id="drawer-clear" class="btn btn--ghost btn--sm">Clear</button>
          <button id="drawer-minimize" class="btn btn--icon"></button>
          <button id="drawer-close" class="btn btn--icon"></button>
        </div>
      </div>
      <div class="bottom-drawer__body">
        <div id="drawer-panel-activity" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-activity">
          <div id="activity-list" class="activity-list"></div>
        </div>
        <div id="drawer-panel-transfers" class="bottom-drawer__panel" role="tabpanel" aria-labelledby="drawer-tab-transfers" hidden>
          <div id="transfer-list" class="transfer-list"></div>
        </div>
      </div>
    </div>
  `;
}

async function loadModules() {
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
  vi.doMock("@tauri-apps/api/event", () => ({ listen: mockListen }));
  vi.doMock("../path-grants.ts", () => ({
    pickDownloadFile: (fileName?: string, title?: string) =>
      mockPickDownloadFile(fileName, title),
    pickUploadFiles: () => Promise.resolve([]),
  }));
  vi.doMock("../dialogs.ts", () => ({
    showConfirm: mockShowConfirm,
    showChoiceDialog: mockShowChoiceDialog,
    showConfirmWithCheckbox: (...args: unknown[]) =>
      mockShowConfirm(...args).then((confirmed) => ({
        confirmed,
        checked: false,
      })),
  }));
  const drawer = await import("../bottom-drawer.ts");
  drawer.initDrawer();
  const transfers = await import("../transfers.ts");
  disposeTransfers = transfers.disposeTransferQueueUI;
  // Hydrate recovery so the queue has the session that checkpoints need.
  await transfers.recoverPendingTransfers();
  const { state } = await import("../state.ts");
  state.protocol = "sftp";
  state.connectionId = SFTP_CONNECTION;
  state.connectionIdentity = SFTP_IDENTITY;
  state.connected = true;
  state.currentBucket = "files.example.test";
  state.createOnlyCapabilities = {
    put_object: true,
    complete_multipart: true,
    copy_object: false,
  };
  return { transfers, state };
}

/** Let the queue run to its first await point; negative checks need real time. */
function settleQueue(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Commands sent to the backend, in order, excluding event plumbing. */
function commandNames(): string[] {
  return mockInvoke.mock.calls
    .map(([command]) => String(command))
    .filter((command) => !command.startsWith("plugin:"));
}

function argsFor(command: string): Array<Record<string, unknown>> {
  return mockInvoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => payload as Record<string, unknown>);
}

beforeEach(() => {
  vi.resetModules();
  const addWindowListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type, listener, options) => {
      if (type === "online" || type === "offline") {
        removeNetworkListeners.push(() =>
          window.removeEventListener(type, listener, options),
        );
      }
      addWindowListener(type, listener, options);
    },
  );
  mockPickDownloadFile.mockReset();
  mockPickDownloadFile.mockImplementation(async (fileName) => ({
    token: "sftp-download-grant",
    path: `/Users/demo/Downloads/${fileName ?? "download.bin"}`,
    name: fileName ?? "download.bin",
    isDir: false,
    directoryToken: null,
    directoryPath: null,
  }));
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd) => {
    if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
    if (cmd === "transfer_checkpoint_gc") return 0;
    if (cmd === "path_exists") return false;
    if (cmd === "sftp_exists") return false;
    if (cmd === "sftp_create_dir") return null;
    if (cmd === "sftp_upload") return { bytes_written: 2048, warning: null };
    if (cmd === "sftp_download") return 512;
    if (cmd === "sftp_stat") {
      return {
        name: "a.txt",
        path: "/bundle/a.txt",
        kind: "file",
        size: 512,
        mtime: 1_700_000_000,
        permissions: 420,
        uid: 1000,
        gid: 1000,
        owner: "demo",
        group: "demo",
        name_lossy: false,
      };
    }
    if (cmd === "save_transfer_manifest") return null;
    return undefined;
  });
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  mockShowConfirm.mockReset();
  mockShowConfirm.mockResolvedValue(false);
  mockShowChoiceDialog.mockReset();
  mockShowChoiceDialog.mockResolvedValue("later");
  localStorage.clear();
  localStorage.setItem("s3-sidekick.transfer-id-sequence.v1", "1");
  renderFixture();
});

afterEach(async () => {
  disposeTransfers?.();
  disposeTransfers = undefined;
  for (const removeListener of removeNetworkListeners.splice(0)) {
    removeListener();
  }
  vi.useRealTimers();
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
});

describe("SFTP path helpers", () => {
  it("lists every remote ancestor folder of a key, top first", async () => {
    const { sftpAncestorPaths } = await import("../transfers.ts");
    expect(sftpAncestorPaths).toBeTypeOf("function");
    expect(sftpAncestorPaths("docs/photos/2024/a.jpg")).toEqual([
      "/docs",
      "/docs/photos",
      "/docs/photos/2024",
    ]);
    expect(sftpAncestorPaths("a.txt")).toEqual([]);
    expect(sftpAncestorPaths("docs/a.txt")).toEqual(["/docs"]);
  });

  it("refuses to derive ancestors from a key that is not a remote path", async () => {
    const { sftpAncestorPaths } = await import("../transfers.ts");
    expect(sftpAncestorPaths).toBeTypeOf("function");
    expect(() => sftpAncestorPaths("docs/../etc/passwd")).toThrow();
  });

  it("plans a folder download: skips symlinks, lossy names, subfolders and other entries", async () => {
    const { planSftpFolderDownload } = await import("../app-downloads.ts");
    const plan = planSftpFolderDownload(
      {
        path: "/bundle",
        truncated: false,
        entries: [
          fileEntry("a.txt", 5),
          {
            ...fileEntry("link", null),
            kind: "symlink",
          },
          fileEntry("bad�name.txt", 3, true),
          { ...fileEntry("sub", null), kind: "dir" },
          { ...fileEntry("socket", null), kind: "other" },
        ],
      },
      "bundle/",
    );
    expect(plan.files).toEqual([
      { key: "bundle/a.txt", name: "a.txt", size: 5 },
    ]);
    expect(plan.skipped.map((row) => [row.name, row.reason])).toEqual([
      ["link", "symbolic link"],
      ["bad�name.txt", "name is not valid UTF-8"],
      ["sub", "subfolder"],
      ["socket", "not a regular file"],
    ]);
  });

  it("refuses a truncated listing rather than downloading part of a folder", async () => {
    const { planSftpFolderDownload } = await import("../app-downloads.ts");
    expect(planSftpFolderDownload).toBeTypeOf("function");
    expect(() =>
      planSftpFolderDownload(
        { path: "/bundle", truncated: true, entries: [fileEntry("a.txt", 5)] },
        "bundle/",
      ),
    ).toThrow(/more entries/);
  });
});

describe("SFTP transfer routing", () => {
  it("uploads with sftp_upload and sends no S3-only arguments", async () => {
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/a.txt", token: "upload-token-a", size: 2048 }],
      "docs/",
      target("sftp"),
    );
    await vi.waitFor(() => expect(argsFor("sftp_upload")).toHaveLength(1));

    const payload = argsFor("sftp_upload")[0];
    expect(payload).toEqual({
      connectionId: SFTP_CONNECTION,
      path: "/docs/a.txt",
      uploadToken: "upload-token-a",
      transferId: expect.any(Number),
      attempt: 1,
      overwrite: false,
      bandwidthLimitMbps: expect.any(Number),
    });
    for (const key of [
      "bucket",
      "key",
      "contentType",
      "partSizeMb",
      "partConcurrency",
      "checksumVerification",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(commandNames()).not.toContain("upload_object");
    expect(commandNames()).not.toContain("head_object");
  });

  it("creates each missing remote parent before the upload", async () => {
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueueFolderEntries(
      [
        {
          file_path: "/local/project/src/deep/a.ts",
          relative_path: "src/deep/a.ts",
          size: 10,
          file_token: "upload-token-deep",
        },
      ],
      "site/",
      target("sftp"),
    );
    await vi.waitFor(() => expect(argsFor("sftp_upload")).toHaveLength(1));

    const creates = argsFor("sftp_create_dir").map((args) => args.path);
    expect(creates).toEqual(["/site", "/site/src", "/site/src/deep"]);
    const names = commandNames();
    expect(names.indexOf("sftp_create_dir")).toBeLessThan(
      names.indexOf("sftp_upload"),
    );
  });

  it("tolerates an already-existing remote parent and still uploads", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "sftp_exists") return false;
      if (cmd === "sftp_create_dir") {
        throw new Error("Remote path already exists: /site");
      }
      if (cmd === "sftp_upload") return { bytes_written: 2048, warning: null };
      return undefined;
    });
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/b.txt", token: "upload-token-b", size: 2048 }],
      "site/",
      target("sftp"),
    );
    await vi.waitFor(() => expect(argsFor("sftp_upload")).toHaveLength(1));
  });

  it("downloads with sftp_download, a checkpoint id and the recovery session", async () => {
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueueDownloads(
      [
        {
          bucket: "files.example.test",
          key: "bundle/a.txt",
          destination: "/Users/demo/Downloads/a.txt",
          destinationToken: "sftp-download-grant",
        },
      ],
      target("sftp"),
    );
    await vi.waitFor(() => expect(argsFor("sftp_download")).toHaveLength(1));

    const payload = argsFor("sftp_download")[0];
    expect(payload).toMatchObject({
      connectionId: SFTP_CONNECTION,
      path: "/bundle/a.txt",
      destinationToken: "sftp-download-grant",
      transferId: expect.any(Number),
      overwrite: false,
      checkpointId: expect.any(String),
      recoverySession: TEST_RECOVERY_SESSION,
      enableResume: true,
    });
    expect(String(payload.checkpointId).length).toBeGreaterThan(0);
    expect(commandNames()).not.toContain("head_object");
    expect(commandNames()).not.toContain("download_object");
    expect(commandNames()).not.toContain("download_object_parallel");
  });

  it("does not run an S3 item against a live SFTP session", async () => {
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/c.txt", token: "upload-token-c", size: 10 }],
      "docs/",
      target("s3"),
    );
    await settleQueue();

    expect(commandNames()).not.toContain("upload_object");
    expect(commandNames()).not.toContain("sftp_upload");
    expect(commandNames()).not.toContain("head_object");
  });

  it("does not run an SFTP item against a live S3 session", async () => {
    const { transfers, state } = await loadModules();
    state.protocol = "s3";
    await transfers.initTransferQueueUI();
    transfers.enqueueDownloads(
      [
        {
          bucket: "files.example.test",
          key: "bundle/a.txt",
          destination: "/Users/demo/Downloads/a.txt",
          destinationToken: "sftp-download-grant",
        },
      ],
      target("sftp"),
    );
    await settleQueue();

    expect(commandNames()).not.toContain("sftp_download");
    expect(commandNames()).not.toContain("download_object");
    // The S3 size probe is the first thing an S3 download would send.
    expect(commandNames()).not.toContain("head_object");
  });

  it("writes the protocol into the saved manifest only for SFTP rows", async () => {
    const { transfers } = await loadModules();
    await transfers.recoverPendingTransfers();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "sftp_exists") return false;
      if (cmd === "sftp_upload") return new Promise(() => undefined);
      return undefined;
    });
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/d.txt", token: "upload-token-d", size: 10 }],
      "docs/",
      target("sftp"),
    );
    await vi.waitFor(() => {
      const saved = argsFor("save_transfer_manifest").at(-1);
      expect(String(saved?.json ?? "")).toContain('"protocol":"sftp"');
    });
  });

  it("parks a row on a lost SFTP connection instead of failing it", async () => {
    const { transfers, state } = await loadModules();
    const { setSftpConnectionLostHandler } = await import("../sftp-move.ts");
    setSftpConnectionLostHandler(async (error) => {
      if (!String(error).includes("SFTP connection lost")) return false;
      state.connected = false;
      state.transfersHeldForDisconnect = true;
      return true;
    });
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "sftp_exists") return false;
      if (cmd === "sftp_upload") {
        throw new Error("SFTP connection lost: the server closed the session.");
      }
      return undefined;
    });
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/e.txt", token: "upload-token-e", size: 10 }],
      "docs/",
      target("sftp"),
    );
    await vi.waitFor(() => expect(argsFor("sftp_upload")).toHaveLength(1));
    await settleQueue();

    expect(argsFor("sftp_upload")).toHaveLength(1);
    const list = document.getElementById("transfer-list");
    expect(list).not.toBeNull();
    expect(list?.textContent ?? "").not.toContain("Failed");
    expect(list?.textContent ?? "").toContain("Disconnected");
    setSftpConnectionLostHandler(() => Promise.resolve(false));
  });

  it("turns an already-exists refusal from a create-only upload into a conflict prompt", async () => {
    let uploads = 0;
    mockInvoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "load_transfer_manifest") return EMPTY_HYDRATION;
      if (cmd === "transfer_checkpoint_gc") return 0;
      if (cmd === "sftp_exists") return false;
      if (cmd === "sftp_create_dir") return null;
      if (cmd === "sftp_upload") {
        uploads += 1;
        const overwrite = (payload as { overwrite?: boolean }).overwrite;
        if (overwrite !== true) {
          throw new Error("Remote path already exists: /docs/f.txt");
        }
        return 2048;
      }
      return undefined;
    });
    mockShowConfirm.mockResolvedValue(true);
    const { transfers } = await loadModules();
    await transfers.initTransferQueueUI();
    transfers.enqueuePaths(
      [{ path: "/local/f.txt", token: "upload-token-f", size: 2048 }],
      "docs/",
      target("sftp"),
    );
    await vi.waitFor(() => expect(uploads).toBe(2));

    expect(mockShowConfirm).toHaveBeenCalledWith(
      "Transfer conflict",
      "/docs/f.txt already exists. Replace it?",
      expect.any(Object),
    );
    const overwrites = argsFor("sftp_upload").map((args) => args.overwrite);
    expect(overwrites).toEqual([false, true]);
  });
});

function fileEntry(name: string, size: number | null, lossy = false) {
  return {
    name,
    path: `/bundle/${name}`,
    kind: "file" as const,
    size,
    mtime: 1_700_000_000,
    permissions: 420,
    uid: 1000,
    gid: 1000,
    owner: "demo",
    group: "demo",
    name_lossy: lossy,
  };
}

function target(protocol: "s3" | "sftp") {
  return {
    bucket: "files.example.test",
    connectionId: SFTP_CONNECTION,
    connectionIdentity: SFTP_IDENTITY,
    protocol,
  };
}
