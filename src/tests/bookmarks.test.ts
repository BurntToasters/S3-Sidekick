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

describe("bookmark import/export/list rendering", () => {
  it("exports bookmarks and validates import payloads", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(JSON.parse(bookmarks.exportBookmarksJson())).toEqual([
      alphaBookmark,
    ]);

    await expect(bookmarks.importBookmarksJson("{bad-json")).resolves.toEqual({
      imported: 0,
      skipped: 0,
      error: "Invalid JSON",
    });
    await expect(
      bookmarks.importBookmarksJson('{"not":"array"}'),
    ).resolves.toEqual({
      imported: 0,
      skipped: 0,
      error: "Expected a JSON array",
    });
    await expect(
      bookmarks.importBookmarksJson('[{"bad":"shape"}]'),
    ).resolves.toEqual({
      imported: 0,
      skipped: 1,
    });

    const handler = vi.fn();
    bookmarks.setBookmarkChangeHandler(handler);
    await expect(
      bookmarks.importBookmarksJson(
        JSON.stringify([alphaBookmark, betaBookmark, { nope: true }]),
      ),
    ).resolves.toEqual({
      imported: 1,
      skipped: 1,
    });
    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark, betaBookmark]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("renders bookmark list and routes select/delete callbacks", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const list = document.createElement("ul");
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    bookmarks.renderBookmarkList(list, onSelect, onDelete);

    const second = list.querySelector(
      '.bookmark-item[data-index="1"]',
    ) as HTMLLIElement;
    second.click();
    expect(onSelect).toHaveBeenCalledWith(betaBookmark);

    const deleteBtn = list.querySelector(
      '[data-delete="0"]',
    ) as HTMLButtonElement;
    deleteBtn.click();
    expect(onDelete).toHaveBeenCalledWith(0);

    standardMock([]);
    const bookmarksEmpty = await loadBookmarksModule();
    await bookmarksEmpty.loadBookmarks();
    const emptyList = document.createElement("ul");
    bookmarksEmpty.renderBookmarkList(
      emptyList,
      () => {},
      () => {},
    );
    expect(emptyList.textContent).toContain("No bookmarks saved");
  });

  it("ignores removeBookmark when index is out of range", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockClear();

    await bookmarks.removeBookmark(-1);
    await bookmarks.removeBookmark(5);

    expect(commandCalls("save_settings")).toHaveLength(0);
    expect(commandCalls("save_bookmarks_backup")).toHaveLength(0);
  });

  it("handles invalid primary and backup bookmark payloads", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_settings") return "[]";
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    expect(bookmarks.getBookmarks()).toEqual([]);

    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_settings") throw new Error("settings unavailable");
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });
    await bookmarks.loadBookmarks();
    expect(bookmarks.getBookmarks()).toEqual([]);
  });

  it("rejects duplicate addBookmark and duplicate-only import without persisting", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(bookmarks.addBookmark(alphaBookmark)).resolves.toBe(true);
    mockInvoke.mockClear();
    await expect(bookmarks.addBookmark(alphaBookmark)).resolves.toBe(false);
    expect(commandCalls("save_settings")).toHaveLength(0);
    expect(commandCalls("save_bookmarks_backup")).toHaveLength(0);

    await expect(
      bookmarks.importBookmarksJson(JSON.stringify([alphaBookmark])),
    ).resolves.toEqual({
      imported: 0,
      skipped: 1,
    });
    expect(commandCalls("save_settings")).toHaveLength(0);
    expect(commandCalls("save_bookmarks_backup")).toHaveLength(0);
  });

  it("renders bookmark entries without region suffix when region is empty", async () => {
    standardMock([
      {
        ...alphaBookmark,
        region: "",
      },
    ]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const bar = document.createElement("div");
    bookmarks.renderBookmarkBar(bar, () => {});
    expect(bar.querySelector(".bookmark-chip__region")).toBeNull();

    const list = document.createElement("ul");
    bookmarks.renderBookmarkList(
      list,
      () => {},
      () => {},
    );
    expect(list.textContent).toContain(alphaBookmark.endpoint);
    expect(list.textContent).not.toContain("()");
  });

  it("ignores invalid bookmark list click targets and indices", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const list = document.createElement("ul");
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    bookmarks.renderBookmarkList(list, onSelect, onDelete);

    const invalidDelete = document.createElement("button");
    invalidDelete.dataset.delete = "-1";
    list.appendChild(invalidDelete);
    invalidDelete.click();

    const invalidDeleteNaN = document.createElement("button");
    invalidDeleteNaN.dataset.delete = "abc";
    list.appendChild(invalidDeleteNaN);
    invalidDeleteNaN.click();

    const invalidItem = document.createElement("li");
    invalidItem.className = "bookmark-item";
    invalidItem.dataset.index = "999";
    list.appendChild(invalidItem);
    invalidItem.click();

    list.click();

    expect(onDelete).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
