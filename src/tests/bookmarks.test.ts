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
