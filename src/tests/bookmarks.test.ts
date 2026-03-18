import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();

const alphaBookmark = {
  name: "alpha",
  endpoint: "https://alpha.example.com",
  region: "us-east-1",
  access_key: "AKIAALPHA",
  secret_key: "secret-alpha",
};

const betaBookmark = {
  name: "beta",
  endpoint: "https://beta.example.com",
  region: "us-west-2",
  access_key: "AKIABETA",
  secret_key: "secret-beta",
};

async function loadBookmarksModule() {
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: mockInvoke,
  }));
  return import("../bookmarks.ts");
}

function commandCalls(command: string) {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
}

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
});

describe("bookmarks fallback and backup sync", () => {
  it("loads valid bookmarks from settings and refreshes backup", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_settings") {
        return JSON.stringify({ _bookmarks: [alphaBookmark] });
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark]);
    expect(mockInvoke).toHaveBeenCalledWith("save_bookmarks_backup", {
      json: JSON.stringify([alphaBookmark], null, 2),
    });
  });

  it("falls back to backup when settings JSON is malformed", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_settings") return "{broken";
      if (command === "load_bookmarks_backup") {
        return JSON.stringify([betaBookmark]);
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([betaBookmark]);
    expect(commandCalls("save_settings")).toHaveLength(0);
  });

  it("falls back to backup when settings read fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_settings") throw new Error("settings unavailable");
      if (command === "load_bookmarks_backup") {
        return JSON.stringify([alphaBookmark]);
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark]);
    expect(commandCalls("save_settings")).toHaveLength(0);
  });

  it("repairs primary settings from backup when _bookmarks is corrupted", async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "load_settings") {
        return JSON.stringify({ theme: "dark", _bookmarks: "invalid" });
      }
      if (command === "load_bookmarks_backup") {
        return JSON.stringify([alphaBookmark, betaBookmark]);
      }
      if (command === "save_settings") {
        const payload = args as { json: string };
        const repaired = JSON.parse(payload.json) as Record<string, unknown>;
        expect(repaired.theme).toBe("dark");
        expect(repaired._bookmarks).toEqual([alphaBookmark, betaBookmark]);
        return undefined;
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark, betaBookmark]);
    expect(commandCalls("save_settings")).toHaveLength(1);
  });

  it("persists bookmark changes to settings and backup", async () => {
    let settingsPayload: Record<string, unknown> = {};
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "load_settings") return JSON.stringify(settingsPayload);
      if (command === "save_settings") {
        settingsPayload = JSON.parse((args as { json: string }).json);
        return undefined;
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    await bookmarks.addBookmark(alphaBookmark);
    await bookmarks.removeBookmark(0);

    expect(settingsPayload._bookmarks).toEqual([]);
    const backupSaves = commandCalls("save_bookmarks_backup");
    expect(backupSaves.length).toBeGreaterThan(0);
    const lastBackupJson = (
      backupSaves[backupSaves.length - 1][1] as { json: string }
    ).json;
    expect(JSON.parse(lastBackupJson)).toEqual([]);
  });
});

function standardMock(initial: unknown[] = []) {
  let settingsPayload: Record<string, unknown> = { _bookmarks: initial };
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "load_settings") return JSON.stringify(settingsPayload);
    if (command === "save_settings") {
      settingsPayload = JSON.parse((args as { json: string }).json);
      return undefined;
    }
    if (command === "save_bookmarks_backup") return undefined;
    throw new Error(`Unexpected invoke command: ${String(command)}`);
  });
}

describe("renderBookmarkBar", () => {
  it("creates bookmark chip buttons for loaded bookmarks", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(container, () => {});

    const chips = container.querySelectorAll("button.bookmark-chip");
    expect(chips).toHaveLength(2);
  });

  it("shows the bookmark name on each chip", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(container, () => {});

    const chips = container.querySelectorAll("button.bookmark-chip");
    expect(chips[0].textContent).toContain("alpha");
    expect(chips[1].textContent).toContain("beta");
  });

  it("includes a region span when the bookmark has a region", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(container, () => {});

    const regionSpan = container.querySelector(".bookmark-chip__region");
    expect(regionSpan).not.toBeNull();
    expect(regionSpan!.textContent).toBe("us-east-1");
  });

  it("calls onSelect with the correct bookmark when a chip is clicked", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const onSelect = vi.fn();
    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(container, onSelect);

    const chips = container.querySelectorAll("button.bookmark-chip");
    (chips[1] as HTMLButtonElement).click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(betaBookmark);
  });

  it("renders nothing when the bookmarks array is empty", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    container.innerHTML = "<span>placeholder</span>";
    bookmarks.renderBookmarkBar(container, () => {});

    expect(container.innerHTML).toBe("");
    expect(container.children).toHaveLength(0);
  });
});

describe("setBookmarkChangeHandler", () => {
  it("invokes the handler when addBookmark is called", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const handler = vi.fn();
    bookmarks.setBookmarkChangeHandler(handler);
    await bookmarks.addBookmark(alphaBookmark);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("invokes the handler when removeBookmark is called", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const handler = vi.fn();
    bookmarks.setBookmarkChangeHandler(handler);
    await bookmarks.removeBookmark(0);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
