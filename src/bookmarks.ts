import { invoke } from "@tauri-apps/api/core";
import { escapeHtml } from "./utils.ts";

export interface Bookmark {
  name: string;
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
}

let bookmarks: Bookmark[] = [];

export function getBookmarks(): Bookmark[] {
  return bookmarks;
}

export async function loadBookmarks(): Promise<void> {
  const raw = await invoke<string>("load_settings");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const stored = parsed._bookmarks;
  if (Array.isArray(stored)) {
    bookmarks = stored.filter(
      (b): b is Bookmark =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as Bookmark).name === "string" &&
        typeof (b as Bookmark).endpoint === "string"
    );
  } else {
    bookmarks = [];
  }
}

async function persistBookmarks(): Promise<void> {
  const raw = await invoke<string>("load_settings");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  parsed._bookmarks = bookmarks;
  await invoke("save_settings", { json: JSON.stringify(parsed, null, 2) });
}

export async function addBookmark(bookmark: Bookmark): Promise<void> {
  const exists = bookmarks.some(
    (b) => b.endpoint === bookmark.endpoint && b.access_key === bookmark.access_key
  );
  if (exists) return;
  bookmarks.push(bookmark);
  await persistBookmarks();
}

export async function removeBookmark(index: number): Promise<void> {
  bookmarks.splice(index, 1);
  await persistBookmarks();
}

export function renderBookmarkList(
  listEl: HTMLElement,
  onSelect: (bookmark: Bookmark) => void,
  onDelete: (index: number) => void
): void {
  if (bookmarks.length === 0) {
    listEl.innerHTML = `<li class="bookmark-empty">No bookmarks saved</li>`;
    return;
  }

  listEl.innerHTML = bookmarks
    .map(
      (b, i) =>
        `<li class="bookmark-item" data-index="${i}">
          <div style="flex:1;min-width:0">
            <div class="bookmark__name">${escapeHtml(b.name)}</div>
            <div class="bookmark__endpoint">${escapeHtml(b.endpoint)} (${escapeHtml(b.region)})</div>
          </div>
          <button class="bookmark__delete" data-delete="${i}" title="Remove bookmark">&#10005;</button>
        </li>`
    )
    .join("");

  listEl.onclick = (e) => {
    const deleteBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-delete]");
    if (deleteBtn) {
      e.stopPropagation();
      const idx = parseInt(deleteBtn.dataset.delete!, 10);
      onDelete(idx);
      return;
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bookmark-item");
    if (item) {
      const idx = parseInt(item.dataset.index!, 10);
      onSelect(bookmarks[idx]);
    }
  };
}
