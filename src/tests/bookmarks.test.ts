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
  it("loads valid bookmarks from primary and refreshes backup", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") {
        return JSON.stringify([alphaBookmark]);
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

  it("falls back to backup when primary returns invalid JSON", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") return "{broken";
      if (command === "load_bookmarks_backup") {
        return JSON.stringify([betaBookmark]);
      }
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([betaBookmark]);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });

  it("falls back to backup when primary throws (vault locked)", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") throw new Error("vault locked");
      if (command === "load_bookmarks_backup") {
        return JSON.stringify([alphaBookmark]);
      }
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark]);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });

  it("falls back to empty when both primary and backup fail", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") throw new Error("vault locked");
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(bookmarks.getBookmarks()).toEqual([]);
  });

  it("persists bookmark changes to primary and backup", async () => {
    let primaryPayload: unknown[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "load_bookmarks") return JSON.stringify(primaryPayload);
      if (command === "save_bookmarks") {
        primaryPayload = JSON.parse((args as { json: string }).json);
        return undefined;
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    await bookmarks.addBookmark(alphaBookmark);
    await bookmarks.removeBookmark(bookmarks.getBookmarks()[0]);

    expect(primaryPayload).toEqual([]);
    const backupSaves = commandCalls("save_bookmarks_backup");
    expect(backupSaves.length).toBeGreaterThan(0);
    const lastBackupJson = (
      backupSaves[backupSaves.length - 1][1] as { json: string }
    ).json;
    expect(JSON.parse(lastBackupJson)).toEqual([]);
  });
});

function standardMock(initial: unknown[] = []) {
  let primaryPayload: unknown[] = initial;
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "load_bookmarks") return JSON.stringify(primaryPayload);
    if (command === "save_bookmarks") {
      primaryPayload = JSON.parse((args as { json: string }).json);
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
    expect(chips[0].textContent).toBe("alpha");
    expect(chips[1].textContent).toBe("beta");
  });

  it("sets tooltip to endpoint and region without region label in chip text", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(container, () => {});

    const chip = container.querySelector(
      "button.bookmark-chip",
    ) as HTMLButtonElement;
    expect(chip.querySelector(".bookmark-chip__region")).toBeNull();
    expect(chip.textContent).toBe("alpha");
    expect(chip.title).toBe("alpha · https://alpha.example.com (us-east-1)");
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
    await bookmarks.removeBookmark(bookmarks.getBookmarks()[0]);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("bookmark import/export/list rendering", () => {
  it("exports bookmarks and validates import payloads", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    expect(JSON.parse(bookmarks.exportBookmarksJson())).toEqual([
      { ...alphaBookmark, secret_key: "" },
    ]);
    expect(JSON.parse(bookmarks.exportBookmarksJson(true))).toEqual([
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
      duplicates: 0,
      invalid: 1,
    });

    const handler = vi.fn();
    bookmarks.setBookmarkChangeHandler(handler);
    await expect(
      bookmarks.importBookmarksJson(
        JSON.stringify([alphaBookmark, betaBookmark, { nope: true }]),
      ),
    ).resolves.toEqual({
      imported: 1,
      skipped: 2,
      duplicates: 1,
      invalid: 1,
    });
    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark, betaBookmark]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("imports a redacted export that has empty secrets", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const redacted = JSON.stringify([{ ...alphaBookmark, secret_key: "" }]);
    await expect(bookmarks.importBookmarksJson(redacted)).resolves.toEqual({
      imported: 1,
      skipped: 0,
      duplicates: 0,
      invalid: 0,
    });
    expect(bookmarks.getBookmarks()).toEqual([
      { ...alphaBookmark, secret_key: "" },
    ]);
  });

  it("rolls memory back when addBookmark persist fails", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "save_bookmarks") throw new Error("disk full");
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    await expect(bookmarks.addBookmark(alphaBookmark)).rejects.toThrow(
      "disk full",
    );
    expect(bookmarks.getBookmarks()).toEqual([]);
  });

  it("rolls memory back when removeBookmark persist fails", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "save_bookmarks") throw new Error("disk full");
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    await expect(
      bookmarks.removeBookmark(bookmarks.getBookmarks()[0]),
    ).rejects.toThrow("disk full");
    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark]);
  });

  it("does not roll a later mutation back when an earlier persist fails", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "save_bookmarks") {
        saveCalls += 1;
        if (saveCalls === 1) {
          await firstSaveGate;
          throw new Error("disk full");
        }
        return undefined;
      }
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const first = bookmarks.addBookmark(alphaBookmark);
    await Promise.resolve();
    await Promise.resolve();
    const second = bookmarks.addBookmark(betaBookmark);
    releaseFirstSave?.();
    await expect(first).rejects.toThrow("disk full");
    await second;
    expect(bookmarks.getBookmarks()).toEqual([betaBookmark]);
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
    expect(onDelete).toHaveBeenCalledWith(alphaBookmark);

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

  it("ignores removeBookmark for a bookmark that is not saved", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockClear();

    await bookmarks.removeBookmark({
      endpoint: "https://missing.invalid",
      access_key: "missing",
    });

    expect(commandCalls("save_bookmarks")).toHaveLength(0);
    expect(commandCalls("save_bookmarks_backup")).toHaveLength(0);
  });

  it("handles invalid primary and backup bookmark payloads", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") return "[]";
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
      if (command === "save_bookmarks_backup") return undefined;
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });

    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    expect(bookmarks.getBookmarks()).toEqual([]);

    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") throw new Error("vault locked");
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
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
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
    expect(commandCalls("save_bookmarks_backup")).toHaveLength(0);

    await expect(
      bookmarks.importBookmarksJson(JSON.stringify([alphaBookmark])),
    ).resolves.toEqual({
      imported: 0,
      skipped: 1,
      duplicates: 1,
      invalid: 0,
    });
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
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
    const chip = bar.querySelector("button.bookmark-chip") as HTMLButtonElement;
    expect(chip.querySelector(".bookmark-chip__region")).toBeNull();
    expect(chip.title).toBe(
      `${alphaBookmark.name} · ${alphaBookmark.endpoint}`,
    );

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

describe("saved connection naming, identity, and editing", () => {
  it("suggests a provider, region, and masked access key as the name", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();

    expect(
      bookmarks.suggestBookmarkName(
        "https://s3.us-east-1.amazonaws.com",
        "us-east-1",
        "AKIAABCDEFGH1234",
      ),
    ).toBe("AWS · us-east-1 · AKIA…1234");
    expect(
      bookmarks.suggestBookmarkName("http://localhost:9000", "", "minioadmin"),
    ).toBe("Local · mini…dmin");
    // Short keys are never shown in part: the name must not reveal them.
    expect(
      bookmarks.suggestBookmarkName(
        "https://nyc3.digitaloceanspaces.com",
        "nyc3",
        "DO00ABC",
      ),
    ).toBe("Spaces · nyc3");
  });

  it("marks only the chip whose endpoint and access key match as active", async () => {
    const sameEndpointOtherKey = {
      ...alphaBookmark,
      name: "alpha-2",
      access_key: "AKIAOTHER",
    };
    standardMock([alphaBookmark, sameEndpointOtherKey]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const container = document.createElement("div");
    bookmarks.renderBookmarkBar(
      container,
      () => {},
      alphaBookmark.endpoint,
      undefined,
      alphaBookmark.access_key,
    );

    const chips = container.querySelectorAll("button.bookmark-chip");
    expect(chips[0].classList.contains("bookmark-chip--active")).toBe(true);
    expect(chips[1].classList.contains("bookmark-chip--active")).toBe(false);
  });

  it("reports invalid and duplicate imports as separate counts", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(
      bookmarks.importBookmarksJson(
        JSON.stringify([alphaBookmark, { nope: true }, betaBookmark]),
      ),
    ).resolves.toEqual({
      imported: 1,
      skipped: 2,
      duplicates: 1,
      invalid: 1,
    });
  });

  it("renames a saved connection and persists the change", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(
      bookmarks.updateBookmark(alphaBookmark, { name: "Renamed" }),
    ).resolves.toBe(true);

    expect(bookmarks.getBookmarks()[0].name).toBe("Renamed");
    const saves = commandCalls("save_bookmarks");
    expect(
      JSON.parse((saves.at(-1)![1] as { json: string }).json)[0].name,
    ).toBe("Renamed");
  });

  it("stores a secret key for a connection that has none", async () => {
    standardMock([{ ...alphaBookmark, secret_key: "" }]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await bookmarks.updateBookmark(alphaBookmark, {
      secret_key: "stored-now",
    });

    expect(bookmarks.getBookmarks()[0].secret_key).toBe("stored-now");
  });

  it("returns false when updating a connection that is no longer saved", async () => {
    standardMock([]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(
      bookmarks.updateBookmark(alphaBookmark, { name: "gone" }),
    ).resolves.toBe(false);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });

  it("refuses to edit saved connections while the stored copy is unreadable", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "load_bookmarks") throw new Error("vault locked");
      if (command === "load_bookmarks_backup") return '{"not":"array"}';
      throw new Error(`Unexpected invoke command: ${String(command)}`);
    });
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(
      bookmarks.updateBookmark(alphaBookmark, { name: "nope" }),
    ).rejects.toThrow(/could not be loaded/);
  });

  it("names row controls and keeps row keys from triggering delete", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    const list = document.createElement("ul");
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    bookmarks.renderBookmarkList(list, onSelect, onDelete, {
      layout: "connection",
      onRename: vi.fn(),
    });

    const row = list.querySelector(".bookmark-item") as HTMLLIElement;
    // The row is a Connect button plus a ⋯ menu with per-row labels.
    const connectBtn = row.querySelector(
      ".bookmark-item__connect",
    ) as HTMLButtonElement;
    expect(connectBtn).not.toBeNull();
    expect(connectBtn.textContent).toContain("alpha");
    const menuButton = row.querySelector(
      ".bookmark__menu",
    ) as HTMLButtonElement;
    expect(menuButton.getAttribute("aria-label")).toBe(
      "More actions for alpha",
    );
    const deleteBtn = row.querySelector(
      '[role="menuitem"][data-delete]',
    ) as HTMLButtonElement;
    expect(deleteBtn.getAttribute("aria-label")).toBe("Delete alpha");
    expect(
      row.querySelector('button[aria-label="Rename alpha"]'),
    ).not.toBeNull();

    deleteBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onSelect).not.toHaveBeenCalled();

    connectBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledWith(alphaBookmark);
  });
});

describe("updateBookmark identity and validation", () => {
  const alphaIdentity = {
    endpoint: alphaBookmark.endpoint,
    access_key: alphaBookmark.access_key,
  };

  it("changing endpoint and access key updates only the matched row", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await expect(
      bookmarks.updateBookmark(alphaIdentity, {
        endpoint: "https://alpha-moved.example.com",
        access_key: "AKIAMOVED",
        secret_key: "rotated-secret",
      }),
    ).resolves.toBe(true);

    const rows = bookmarks.getBookmarks();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "alpha",
      endpoint: "https://alpha-moved.example.com",
      access_key: "AKIAMOVED",
      secret_key: "rotated-secret",
    });
    expect(rows[1]).toEqual(betaBookmark);
    const saves = commandCalls("save_bookmarks");
    expect(
      JSON.parse((saves.at(-1)![1] as { json: string }).json),
    ).toHaveLength(2);
  });

  it("keeps the stored secret when a patch does not include one", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();

    await bookmarks.updateBookmark(alphaIdentity, { region: "eu-west-1" });

    expect(bookmarks.getBookmarks()[0]).toMatchObject({
      region: "eu-west-1",
      secret_key: alphaBookmark.secret_key,
    });
  });

  it("rejects an empty endpoint or access key and persists nothing", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockClear();

    await expect(
      bookmarks.updateBookmark(alphaIdentity, { endpoint: "" }),
    ).rejects.toThrow();
    await expect(
      bookmarks.updateBookmark(alphaIdentity, { access_key: "" }),
    ).rejects.toThrow();

    expect(bookmarks.getBookmarks()[0]).toEqual(alphaBookmark);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });

  it("rejects a patch longer than the stored maximum so the row cannot vanish on reload", async () => {
    standardMock([alphaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockClear();

    await expect(
      bookmarks.updateBookmark(alphaIdentity, { name: "n".repeat(257) }),
    ).rejects.toThrow();

    expect(bookmarks.getBookmarks()[0]).toEqual(alphaBookmark);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });

  it("rejects an edit that would duplicate another saved endpoint and access key", async () => {
    standardMock([alphaBookmark, betaBookmark]);
    const bookmarks = await loadBookmarksModule();
    await bookmarks.loadBookmarks();
    mockInvoke.mockClear();

    await expect(
      bookmarks.updateBookmark(alphaIdentity, {
        endpoint: betaBookmark.endpoint,
        access_key: betaBookmark.access_key,
      }),
    ).rejects.toThrow(/already uses this endpoint and access key/);

    expect(bookmarks.getBookmarks()).toEqual([alphaBookmark, betaBookmark]);
    expect(commandCalls("save_bookmarks")).toHaveLength(0);
  });
});
