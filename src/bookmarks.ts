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

export function clearBookmarks(): void {
  bookmarks = [];
}

export function isEndpointBookmarked(endpoint: string): boolean {
  return bookmarks.some((b) => b.endpoint === endpoint);
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

function parseBookmarksArray(raw: string): Bookmark[] | null {
  let parsed: unknown;
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

async function loadBackupBookmarks(): Promise<Bookmark[] | null> {
  try {
    const raw = await invoke<string>("load_bookmarks_backup");
    return parseBookmarksArray(raw);
  } catch {
    return null;
  }
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

export async function loadBookmarks(): Promise<void> {
  try {
    const raw = await invoke<string>("load_bookmarks");
    const primary = parseBookmarksArray(raw);
    if (primary !== null) {
      bookmarks = primary;
      await saveBookmarksBackupSafe(bookmarks);
      return;
    }
  } catch {
    // primary unavailable (vault locked or IO error) — fall through to backup
  }
  bookmarks = (await loadBackupBookmarks()) ?? [];
}

async function persistBookmarks(): Promise<void> {
  persistPromise = persistPromise.catch(() => {}).then(async () => {
    await invoke("save_bookmarks", { json: JSON.stringify(bookmarks, null, 2) });
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
  activeEndpoint?: string,
  onNewTab?: () => void,
): void {
  barEl.innerHTML = "";
  if (bookmarks.length === 0 && !onNewTab) return;

  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    const chip = document.createElement("button");
    const isActive =
      activeEndpoint !== undefined && b.endpoint === activeEndpoint;
    chip.className = isActive
      ? "bookmark-chip bookmark-chip--active"
      : "bookmark-chip";
    chip.title = b.endpoint;
    const regionSuffix = b.region
      ? ` <span class="bookmark-chip__region">${escapeHtml(b.region)}</span>`
      : "";
    chip.innerHTML = escapeHtml(b.name) + regionSuffix;
    chip.addEventListener("click", () => onSelect(b));
    barEl.appendChild(chip);
  }

  if (onNewTab) {
    const plusBtn = document.createElement("button");
    plusBtn.className = "bookmark-chip bookmark-chip--new";
    plusBtn.title = "New connection";
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", onNewTab);
    barEl.appendChild(plusBtn);
  }
}

export function exportBookmarksJson(): string {
  return JSON.stringify(bookmarks, null, 2);
}

export async function importBookmarksJson(
  json: string,
): Promise<{ imported: number; skipped: number; error?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { imported: 0, skipped: 0, error: "Invalid JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { imported: 0, skipped: 0, error: "Expected a JSON array" };
  }

  const valid = parsed.filter(isBookmark);
  if (valid.length === 0) {
    return { imported: 0, skipped: parsed.length };
  }

  let imported = 0;
  let skipped = 0;
  for (const b of valid) {
    const exists = bookmarks.some(
      (existing) =>
        existing.endpoint === b.endpoint &&
        existing.access_key === b.access_key,
    );
    if (exists) {
      skipped++;
    } else {
      bookmarks.push(b);
      imported++;
    }
  }

  if (imported > 0) {
    await persistBookmarks();
    onChangeCallback?.();
  }

  return { imported, skipped };
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
      if (Number.isInteger(idx) && idx >= 0 && idx < bookmarks.length) {
        onDelete(idx);
      }
      return;
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>(
      ".bookmark-item",
    );
    if (item) {
      const idx = parseInt(item.dataset.index!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < bookmarks.length) {
        onSelect(bookmarks[idx]);
      }
    }
  };
}
