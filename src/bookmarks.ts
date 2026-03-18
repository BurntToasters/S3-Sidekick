import { invoke } from "@tauri-apps/api/core";
import { escapeHtml, twemojiIcon } from "./utils.ts";

export interface Bookmark {
  name: string;
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
}

let bookmarks: Bookmark[] = [];
let persistPromise: Promise<void> = Promise.resolve();
let onChangeCallback: (() => void) | null = null;

export function setBookmarkChangeHandler(handler: () => void): void {
  onChangeCallback = handler;
}

export function getBookmarks(): Bookmark[] {
  return bookmarks;
}

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Bookmark;
  return (
    typeof row.name === "string" &&
    typeof row.endpoint === "string" &&
    typeof row.region === "string" &&
    typeof row.access_key === "string" &&
    typeof row.secret_key === "string"
  );
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readBookmarksField(data: Record<string, unknown>): {
  values: Bookmark[];
  corrupted: boolean;
} {
  if (!Object.hasOwn(data, "_bookmarks")) {
    return { values: [], corrupted: false };
  }
  const raw = data._bookmarks;
  if (!Array.isArray(raw)) {
    return { values: [], corrupted: true };
  }
  if (!raw.every(isBookmark)) {
    return { values: [], corrupted: true };
  }
  return { values: [...raw], corrupted: false };
}

async function loadBackupBookmarks(): Promise<Bookmark[] | null> {
  let raw = "[]";
  try {
    raw = await invoke<string>("load_bookmarks_backup");
  } catch {
    return null;
  }
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isBookmark)) {
    return null;
  }
  return [...parsed];
}

async function saveBookmarksBackupSafe(next: Bookmark[]): Promise<void> {
  try {
    await invoke("save_bookmarks_backup", {
      json: JSON.stringify(next, null, 2),
    });
  } catch (err) {
    console.warn("Failed to update bookmark backup:", err);
  }
}

async function repairSettingsBookmarks(
  parsed: Record<string, unknown>,
  next: Bookmark[],
): Promise<void> {
  parsed._bookmarks = next;
  await invoke("save_settings", { json: JSON.stringify(parsed, null, 2) });
}

export async function loadBookmarks(): Promise<void> {
  let raw = "{}";
  try {
    raw = await invoke<string>("load_settings");
  } catch {
    const backup = await loadBackupBookmarks();
    bookmarks = backup ?? [];
    return;
  }
  const parsed = parseJsonObject(raw);
  if (parsed) {
    const primary = readBookmarksField(parsed);
    if (!primary.corrupted) {
      bookmarks = primary.values;
      await saveBookmarksBackupSafe(bookmarks);
      return;
    }
  }
  const backup = await loadBackupBookmarks();
  if (backup) {
    bookmarks = backup;
    if (parsed) {
      try {
        await repairSettingsBookmarks(parsed, bookmarks);
      } catch {}
    }
    return;
  }
  bookmarks = [];
}

async function persistBookmarks(): Promise<void> {
  persistPromise = persistPromise.then(async () => {
    const raw = await invoke<string>("load_settings");
    const parsed = parseJsonObject(raw) ?? {};
    parsed._bookmarks = bookmarks;
    await invoke("save_settings", { json: JSON.stringify(parsed, null, 2) });
    await saveBookmarksBackupSafe(bookmarks);
  });
  await persistPromise;
}

export async function addBookmark(bookmark: Bookmark): Promise<boolean> {
  const exists = bookmarks.some(
    (b) =>
      b.endpoint === bookmark.endpoint && b.access_key === bookmark.access_key,
  );
  if (exists) return false;
  bookmarks.push(bookmark);
  await persistBookmarks();
  onChangeCallback?.();
  return true;
}

export async function removeBookmark(index: number): Promise<void> {
  if (index < 0 || index >= bookmarks.length) return;
  bookmarks.splice(index, 1);
  await persistBookmarks();
  onChangeCallback?.();
}

export function renderBookmarkBar(
  barEl: HTMLElement,
  onSelect: (bookmark: Bookmark) => void,
): void {
  barEl.innerHTML = "";
  if (bookmarks.length === 0) return;

  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    const chip = document.createElement("button");
    chip.className = "bookmark-chip";
    chip.title = b.endpoint;
    const regionSuffix = b.region
      ? ` <span class="bookmark-chip__region">${escapeHtml(b.region)}</span>`
      : "";
    chip.innerHTML = escapeHtml(b.name) + regionSuffix;
    chip.addEventListener("click", () => onSelect(b));
    barEl.appendChild(chip);
  }
}

export function renderBookmarkList(
  listEl: HTMLElement,
  onSelect: (bookmark: Bookmark) => void,
  onDelete: (index: number) => void,
): void {
  if (bookmarks.length === 0) {
    listEl.innerHTML = `<li class="bookmark-empty">No bookmarks saved</li>`;
    return;
  }

  listEl.innerHTML = bookmarks
    .map((b, i) => {
      const regionPart = b.region ? ` (${escapeHtml(b.region)})` : "";
      return `<li class="bookmark-item" data-index="${i}">
          <div style="flex:1;min-width:0">
            <div class="bookmark__name">${escapeHtml(b.name)}</div>
            <div class="bookmark__endpoint">${escapeHtml(b.endpoint)}${regionPart}</div>
          </div>
          <button class="bookmark__delete" data-delete="${i}" title="Remove bookmark">${twemojiIcon("274c", { className: "twemoji-icon twemoji-icon--bookmark-delete", decorative: true })}</button>
        </li>`;
    })
    .join("");

  listEl.onclick = (e) => {
    const deleteBtn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-delete]",
    );
    if (deleteBtn) {
      e.stopPropagation();
      const idx = parseInt(deleteBtn.dataset.delete!, 10);
      onDelete(idx);
      return;
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>(
      ".bookmark-item",
    );
    if (item) {
      const idx = parseInt(item.dataset.index!, 10);
      if (idx >= 0 && idx < bookmarks.length) onSelect(bookmarks[idx]);
    }
  };
}
