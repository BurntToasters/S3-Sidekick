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

describe("copy/move validation", () => {
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
    state.objects = [];
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.currentSettings.conflictPolicy = "ask";
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    };
  });

  it("rejects an empty destination path", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "   ";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "Destination path is required",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
  });

  it("skips a single file when the destination exists and user skips", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return true;
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
    mockShowConfirm.mockResolvedValue(false);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "Skipped",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
  });

  it("cancels a single file when unguarded write is declined", async () => {
    const { state } = await import("../state.ts");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowConfirm.mockResolvedValue(false);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "unconditional write was not authorized",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
  });

  it("queues overwrite true when policy is replace and destination exists", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return true;
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
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ overwrite: true })],
        expect.anything(),
      );
    });
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("includes known source size in the queued entry", async () => {
    const { state } = await import("../state.ts");
    state.objects = [
      { key: "docs/file.txt", size: 42, last_modified: "", is_folder: false },
    ];
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ size: 42 })],
        expect.anything(),
      );
    });
  });

  it("labels single file vs multi-select destinations", async () => {
    const { state } = await import("../state.ts");
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    expect(
      document.querySelector('label[for="copy-move-path"]')?.textContent,
    ).toBe("Destination key");
    expect(
      (document.getElementById("copy-move-desc") as HTMLElement).textContent,
    ).toContain("File:");

    state.selectedKeys.clear();
    state.selectedKeys.add("docs/a.txt");
    state.selectedKeys.add("docs/b.txt");
    state.selectedPrefixes.add("docs/folder/");
    openCopyMoveDialog();
    expect(
      (document.getElementById("copy-move-desc") as HTMLElement).textContent,
    ).toContain("2 files");
    expect(
      (document.getElementById("copy-move-desc") as HTMLElement).textContent,
    ).toContain("1 folder");
    expect(
      document.querySelector('label[for="copy-move-path"]')?.textContent,
    ).toBe("Destination prefix");
  });

  it("falls back to the current bucket when no buckets are listed", async () => {
    const { state } = await import("../state.ts");
    state.buckets = [];
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    const select = document.getElementById(
      "copy-move-bucket",
    ) as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.value).toBe("bucket-a");
  });

  it("close and cancel buttons dismiss the dialog", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    const overlay = document.getElementById(
      "copy-move-overlay",
    ) as HTMLDivElement;
    expect(overlay.classList.contains("active")).toBe(true);
    (document.getElementById("copy-move-cancel") as HTMLButtonElement).click();
    expect(overlay.classList.contains("active")).toBe(false);
    openCopyMoveDialog();
    (document.getElementById("copy-move-close") as HTMLButtonElement).click();
    expect(overlay.classList.contains("active")).toBe(false);
  });
});

describe("copy/move conflict routing", () => {
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
    state.objects = [];
    state.selectedKeys.clear();
    state.currentSettings.conflictPolicy = "ask";
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    };
  });

  it("queues multi-file destinations under a normalized prefix", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.add("docs/a.txt");
    state.selectedKeys.add("docs/b.txt");
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalled();
    });
    const entries = mockEnqueueCopyMoveEntries.mock.calls[0][0] as Array<{
      destinationKey: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0].destinationKey).toBe("archive/a.txt");
    expect(entries[1].destinationKey).toBe("archive/b.txt");
  });

  it("counts skipped files and folders in a mixed batch", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.add("docs/a.txt");
    state.selectedKeys.add("docs/b.txt");
    state.selectedPrefixes.add("docs/folder/");
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === "object_exists") {
        const key = (args as { key?: string }).key ?? "";
        return key.endsWith("a.txt");
      }
      if (cmd === "list_objects") {
        const prefix = (args as { prefix?: string }).prefix ?? "";
        if (prefix.includes("folder")) {
          return {
            objects: [{ key: "bucket-a/docs/folder/x" }],
            prefixes: [],
            truncated: false,
            next_continuation_token: "",
          };
        }
        return {
          objects: [],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      return undefined;
    });
    mockShowConfirm.mockResolvedValue(false);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalled();
    });
    const entries = mockEnqueueCopyMoveEntries.mock.calls[0][0] as unknown[];
    expect(entries).toHaveLength(1);
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "Skipped 2",
      );
    });
  });

  it("creates a lone folder without conflict as overwrite when policy is replace", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    state.selectedPrefixes.add("docs/folder/");
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ overwrite: true })],
        expect.anything(),
      );
    });
  });

  it("accepts unguarded folder creation when consent is given", async () => {
    const { state } = await import("../state.ts");
    state.selectedPrefixes.add("docs/folder/");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowConfirm.mockResolvedValue(true);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ overwrite: true })],
        expect.anything(),
      );
    });
  });

  it("cancels folder creation when unguarded consent is declined", async () => {
    const { state } = await import("../state.ts");
    state.selectedPrefixes.add("docs/folder/");
    state.createOnlyCapabilities = {
      put_object: false,
      complete_multipart: false,
      copy_object: false,
    };
    mockShowConfirm.mockResolvedValue(false);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "unconditional writes were not authorized",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
  });

  it("skips conflicting folders under skip policy without prompting", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "skip";
    state.selectedPrefixes.add("docs/folder/");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") {
        return {
          objects: [{ key: "x" }],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      return undefined;
    });
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "all conflicts were skipped",
      );
    });
    expect(mockEnqueueCopyMoveEntries).not.toHaveBeenCalled();
    expect(mockShowConfirm).not.toHaveBeenCalled();
  });

  it("replaces conflicting folders when the user confirms", async () => {
    const { state } = await import("../state.ts");
    state.selectedPrefixes.add("docs/folder/");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") {
        return {
          objects: [{ key: "x" }],
          prefixes: [],
          truncated: false,
          next_continuation_token: "",
        };
      }
      return undefined;
    });
    mockShowConfirm.mockResolvedValue(true);
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ overwrite: true })],
        expect.anything(),
      );
    });
  });

  it("treats folder existence probe errors as conflicts", async () => {
    const { state } = await import("../state.ts");
    state.currentSettings.conflictPolicy = "replace";
    state.selectedPrefixes.add("docs/folder/");
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") throw new Error("throttled");
      return undefined;
    });
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalledWith(
        [expect.objectContaining({ overwrite: true })],
        expect.anything(),
      );
    });
  });

  it("maps enqueue failures to user-facing messages", async () => {
    mockEnqueueCopyMoveEntries.mockImplementation(() => {
      throw new Error("403 Forbidden");
    });
    const { state } = await import("../state.ts");
    state.selectedKeys.add("docs/file.txt");
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toContain(
        "Access denied",
      );
    });
  });

  it("remembers successful destinations for later picks", async () => {
    const { state } = await import("../state.ts");
    state.selectedKeys.add("docs/file.txt");
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (document.getElementById("copy-move-path") as HTMLInputElement).value =
      "archive/file.txt";
    (
      document.getElementById("copy-move-copy-btn") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(mockEnqueueCopyMoveEntries).toHaveBeenCalled();
    });
    const raw = localStorage.getItem(
      "s3-sidekick.recent-copy-move-destinations.v1",
    );
    expect(raw).toContain("archive/file.txt");
  });
});

describe("copy/move browser and recents", () => {
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
    state.objects = [];
    state.selectedKeys.clear();
    state.selectedKeys.add("docs/file.txt");
    state.currentSettings.conflictPolicy = "ask";
    state.createOnlyCapabilities = {
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    };
  });

  it("hides recents when storage holds invalid JSON", async () => {
    localStorage.setItem(
      "s3-sidekick.recent-copy-move-destinations.v1",
      "{bad json",
    );
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    expect(
      (document.getElementById("copy-move-recent-wrap") as HTMLElement).hidden,
    ).toBe(true);
  });

  it("hides recents when storage holds a non-array payload", async () => {
    localStorage.setItem(
      "s3-sidekick.recent-copy-move-destinations.v1",
      JSON.stringify({ bucket: "bucket-a", path: "x" }),
    );
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    expect(
      (document.getElementById("copy-move-recent-wrap") as HTMLElement).hidden,
    ).toBe(true);
  });

  it("renders recent destinations with preferred bucket first", async () => {
    localStorage.setItem(
      "s3-sidekick.recent-copy-move-destinations.v1",
      JSON.stringify([
        { bucket: "bucket-b", path: "other/" },
        { bucket: "bucket-a", path: "archive/" },
        { bucket: "", path: "" },
        { bucket: "bucket-a", path: "archive/" },
      ]),
    );
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    const wrap = document.getElementById(
      "copy-move-recent-wrap",
    ) as HTMLElement;
    expect(wrap.hidden).toBe(false);
    const items = Array.from(
      document.querySelectorAll(".copy-move-recent-item"),
    ).map((el) => el.textContent);
    expect(items[0]).toContain("bucket-a/archive/");
    (items[0]
      ? (document.querySelector(".copy-move-recent-item") as HTMLButtonElement)
      : null
    )?.click();
    expect(
      (document.getElementById("copy-move-path") as HTMLInputElement).value,
    ).toBe("archive/");
  });

  it("browses subfolders and picks a destination on click", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "object_exists") return false;
      if (cmd === "list_objects") {
        return {
          objects: [],
          prefixes: ["docs/sub/"],
          truncated: false,
          next_continuation_token: "",
        };
      }
      return undefined;
    });
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (
      document.getElementById("copy-move-browse-toggle") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(document.querySelector(".copy-move-folder-item")).not.toBeNull();
    });
    expect(
      (document.getElementById("copy-move-browser-crumbs") as HTMLElement)
        .textContent,
    ).toContain("docs");
    (
      document.querySelector(".copy-move-folder-item") as HTMLButtonElement
    ).click();
    expect(
      (document.getElementById("copy-move-path") as HTMLInputElement).value,
    ).toBe("docs/sub/file.txt");
  });

  it("shows an empty state when a folder has no subfolders", async () => {
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (
      document.getElementById("copy-move-browse-toggle") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("copy-move-browser-list") as HTMLElement)
          .textContent,
      ).toContain("No subfolders");
    });
  });

  it("shows a failure state when folder listing fails", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "list_objects") throw new Error("boom");
      return false;
    });
    const { openCopyMoveDialog } = await import("../app-copy-move.ts");
    openCopyMoveDialog();
    (
      document.getElementById("copy-move-browse-toggle") as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        (document.getElementById("copy-move-browser-list") as HTMLElement)
          .textContent,
      ).toContain("Failed to load folders");
    });
  });
});
