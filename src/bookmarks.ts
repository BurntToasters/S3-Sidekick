import { invoke } from "./ipc.ts";
import { escapeHtml, getIconHtml, parseJsonArray } from "./utils.ts";

export interface Bookmark {
  name: string;
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
  session_token?: string;
}

let bookmarks: Bookmark[] = [];
/**
 * Why the last load could not read the stored bookmarks, or null when it
 * could. While set, mutations are refused: saving the in-memory (empty) list
 * would overwrite the only stored copies, including encrypted ones the
 * backend deliberately refused to read.
 */
let loadError: string | null = null;
let persistPromise: Promise<void> = Promise.resolve();
let onChangeCallback: (() => void) | null = null;
export const MAX_IMPORT_BYTES = 1_048_576;
const MAX_IMPORT_BOOKMARKS = 1_000;
const MAX_BOOKMARK_NAME_LENGTH = 256;
const MAX_BOOKMARK_ENDPOINT_LENGTH = 2_048;
const MAX_BOOKMARK_REGION_LENGTH = 128;
const MAX_BOOKMARK_ACCESS_KEY_LENGTH = 256;
const MAX_BOOKMARK_SECRET_KEY_LENGTH = 4_096;
const MAX_BOOKMARK_SESSION_TOKEN_LENGTH = 16_384;

export function setBookmarkChangeHandler(handler: () => void): void {
  onChangeCallback = handler;
}

export function getBookmarks(): Bookmark[] {
  return bookmarks;
}

export function clearBookmarks(): void {
  bookmarks = [];
  // Cleared on lock: nothing is loaded, so nothing may be saved over storage.
  loadError = "Encrypted storage is locked.";
}

export function getBookmarkLoadError(): string | null {
  return loadError;
}

function requireBookmarksLoaded(): void {
  if (loadError !== null) {
    throw new Error(
      `Saved bookmarks could not be loaded (${loadError}) Resolve that before changing bookmarks.`,
    );
  }
}

function sameBookmark(
  left: Pick<Bookmark, "endpoint" | "access_key">,
  right: Pick<Bookmark, "endpoint" | "access_key">,
): boolean {
  return (
    left.endpoint === right.endpoint && left.access_key === right.access_key
  );
}

export function isEndpointBookmarked(
  endpoint: string,
  accessKey?: string,
): boolean {
  // Composite key: same endpoint with different credentials is distinct.
  if (accessKey !== undefined) {
    return bookmarks.some(
      (b) => b.endpoint === endpoint && b.access_key === accessKey,
    );
  }
  return bookmarks.some((b) => b.endpoint === endpoint);
}

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Bookmark;
  return (
    typeof row.name === "string" &&
    row.name.length > 0 &&
    row.name.length <= MAX_BOOKMARK_NAME_LENGTH &&
    typeof row.endpoint === "string" &&
    row.endpoint.length > 0 &&
    row.endpoint.length <= MAX_BOOKMARK_ENDPOINT_LENGTH &&
    typeof row.region === "string" &&
    row.region.length <= MAX_BOOKMARK_REGION_LENGTH &&
    typeof row.access_key === "string" &&
    row.access_key.length > 0 &&
    row.access_key.length <= MAX_BOOKMARK_ACCESS_KEY_LENGTH &&
    typeof row.secret_key === "string" &&
    row.secret_key.length <= MAX_BOOKMARK_SECRET_KEY_LENGTH &&
    (row.session_token === undefined ||
      (typeof row.session_token === "string" &&
        row.session_token.length <= MAX_BOOKMARK_SESSION_TOKEN_LENGTH))
  );
}

function parseBookmarksArray(raw: string): Bookmark[] | null {
  const parsed = parseJsonArray(raw);
  if (parsed === null) return null;
  // Filter out invalid entries instead of rejecting the whole file so one
  // corrupt bookmark doesn't wipe the rest. A non-empty file where every
  // entry is invalid is corruption, not an empty list: returning [] here
  // would overwrite the good backup with nothing.
  const valid = parsed.filter(isBookmark);
  if (parsed.length > 0 && valid.length === 0) return null;
  return valid;
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
  let primaryError: string | null = null;
  try {
    const raw = await invoke<string>("load_bookmarks");
    const primary = parseBookmarksArray(raw);
    if (primary !== null) {
      bookmarks = primary;
      loadError = null;
      await saveBookmarksBackupSafe(bookmarks);
      return;
    }
    if (raw.trim().length > 0) primaryError = "the bookmark file is corrupt.";
  } catch (err) {
    // Primary unavailable (vault locked or IO error): fall through to backup.
    primaryError = `${err instanceof Error ? err.message : String(err)}`;
  }
  const backup = await loadBackupBookmarks();
  if (backup !== null) {
    bookmarks = backup;
    loadError = null;
    return;
  }
  bookmarks = [];
  loadError = primaryError;
}

async function persistBookmarksSnapshot(next: Bookmark[]): Promise<void> {
  const serialized = JSON.stringify(next, null, 2);
  persistPromise = persistPromise
    // Prior persist failure must not break the chain; it was already surfaced.
    .catch(() => undefined)
    .then(async () => {
      await invoke("save_bookmarks", { json: serialized });
      await saveBookmarksBackupSafe(next);
    });
  await persistPromise;
}

let mutationQueue: Promise<void> = Promise.resolve();

function enqueueBookmarkMutation<T>(work: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function addBookmark(bookmark: Bookmark): Promise<boolean> {
  return enqueueBookmarkMutation(async () => {
    requireBookmarksLoaded();
    const exists = bookmarks.some(
      (b) =>
        b.endpoint === bookmark.endpoint &&
        b.access_key === bookmark.access_key,
    );
    if (exists) return false;
    const next = [...bookmarks, bookmark];
    await persistBookmarksSnapshot(next);
    bookmarks = next;
    onChangeCallback?.();
    return true;
  });
}

/// Remove by identity, not list position: a queued second delete (or a
/// render older than the list) must never hit whichever bookmark shifted
/// into the clicked slot.
export async function removeBookmark(
  target: Pick<Bookmark, "endpoint" | "access_key">,
): Promise<void> {
  return enqueueBookmarkMutation(async () => {
    requireBookmarksLoaded();
    if (!bookmarks.some((b) => sameBookmark(b, target))) return;
    const next = bookmarks.filter((b) => !sameBookmark(b, target));
    await persistBookmarksSnapshot(next);
    bookmarks = next;
    onChangeCallback?.();
  });
}

/**
 * Name suggested when saving a connection. Endpoint, region, and a masked
 * access key tell apart connections that share a host or a generic name.
 * Keys of eight characters or fewer are omitted rather than partly shown.
 */
export function suggestBookmarkName(
  endpoint: string,
  region: string,
  accessKey: string,
): string {
  const parts = [deriveProviderLabelFromEndpoint(endpoint)];
  const trimmedRegion = region.trim();
  if (trimmedRegion) parts.push(trimmedRegion);
  const key = accessKey.trim();
  if (key.length > 8) parts.push(`${key.slice(0, 4)}…${key.slice(-4)}`);
  return parts.join(" · ");
}

export type BookmarkPatch = Partial<
  Pick<
    Bookmark,
    | "name"
    | "endpoint"
    | "region"
    | "access_key"
    | "secret_key"
    | "session_token"
  >
>;

/**
 * Edit a saved connection in place, matched by identity like removeBookmark.
 * Resolves false when it is no longer saved, so a stale edit cannot re-add it.
 * Rejects, and saves nothing, when the edited row would not load again or
 * would duplicate another saved endpoint and access key.
 */
export async function updateBookmark(
  target: Pick<Bookmark, "endpoint" | "access_key">,
  patch: BookmarkPatch,
): Promise<boolean> {
  return enqueueBookmarkMutation(async () => {
    requireBookmarksLoaded();
    if (!bookmarks.some((b) => sameBookmark(b, target))) return false;
    const edited = bookmarks
      .filter((b) => sameBookmark(b, target))
      .map((b) => ({ ...b, ...patch }));
    if (!edited.every(isBookmark)) {
      throw new Error(
        "Those details are not valid for a saved connection. Check the name, endpoint, and access key.",
      );
    }
    for (const row of edited) {
      const clash = bookmarks.some(
        (b) => !sameBookmark(b, target) && sameBookmark(b, row),
      );
      if (clash) {
        throw new Error(
          "Another saved connection already uses this endpoint and access key.",
        );
      }
    }
    const next = bookmarks.map((b) =>
      sameBookmark(b, target) ? { ...b, ...patch } : b,
    );
    await persistBookmarksSnapshot(next);
    bookmarks = next;
    onChangeCallback?.();
    return true;
  });
}

export function renderBookmarkBar(
  barEl: HTMLElement,
  onSelect: (bookmark: Bookmark) => void,
  activeEndpoint?: string,
  onNewTab?: () => void,
  activeAccessKey?: string,
): void {
  barEl.innerHTML = "";
  if (bookmarks.length === 0 && !onNewTab) return;

  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    const chip = document.createElement("button");
    // The endpoint alone is shared by every key saved for one host.
    const isActive =
      activeEndpoint !== undefined &&
      b.endpoint === activeEndpoint &&
      (activeAccessKey === undefined || b.access_key === activeAccessKey);
    chip.className = isActive
      ? "bookmark-chip bookmark-chip--active"
      : "bookmark-chip";
    chip.type = "button";
    const label = document.createElement("span");
    label.className = "bookmark-chip__label";
    label.textContent = b.name;
    chip.appendChild(label);
    // The title carries the full name (the label may be truncated) and the endpoint.
    const where = b.region ? `${b.endpoint} (${b.region})` : b.endpoint;
    chip.title = `${b.name} · ${where}`;
    chip.setAttribute("aria-label", b.name);
    chip.addEventListener("click", () => onSelect(b));
    barEl.appendChild(chip);
  }

  if (onNewTab) {
    const plusBtn = document.createElement("button");
    plusBtn.className = "bookmark-chip bookmark-chip--new";
    plusBtn.type = "button";
    plusBtn.title = "New connection";
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", onNewTab);
    barEl.appendChild(plusBtn);
  }
}

export function exportBookmarksJson(includeSecrets = false): string {
  const exported = includeSecrets
    ? bookmarks
    : bookmarks.map(({ secret_key: _secretKey, ...bookmark }) => ({
        ...bookmark,
        secret_key: "",
      }));
  return JSON.stringify(exported, null, 2);
}

export interface BookmarkImportResult {
  imported: number;
  /** Entries not imported: `duplicates` plus `invalid`. */
  skipped: number;
  duplicates?: number;
  invalid?: number;
  error?: string;
}

export async function importBookmarksJson(
  json: string,
): Promise<BookmarkImportResult> {
  if (typeof json !== "string" || json.length > MAX_IMPORT_BYTES) {
    return { imported: 0, skipped: 0, error: "Bookmark import is too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { imported: 0, skipped: 0, error: "Invalid JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { imported: 0, skipped: 0, error: "Expected a JSON array" };
  }
  if (parsed.length > MAX_IMPORT_BOOKMARKS) {
    return {
      imported: 0,
      skipped: 0,
      error: `Bookmark import is limited to ${MAX_IMPORT_BOOKMARKS} entries`,
    };
  }

  const valid = parsed.filter(isBookmark);
  const invalid = parsed.length - valid.length;
  if (valid.length === 0) {
    return { imported: 0, skipped: parsed.length, duplicates: 0, invalid };
  }

  try {
    return await enqueueBookmarkMutation(async () => {
      requireBookmarksLoaded();
      let imported = 0;
      let duplicates = 0;
      const nextBookmarks = [...bookmarks];
      for (const b of valid) {
        const exists = nextBookmarks.some(
          (existing) =>
            existing.endpoint === b.endpoint &&
            existing.access_key === b.access_key,
        );
        if (exists) {
          duplicates++;
        } else {
          nextBookmarks.push(b);
          imported++;
        }
      }

      if (imported > 0) {
        await persistBookmarksSnapshot(nextBookmarks);
        bookmarks = nextBookmarks;
        onChangeCallback?.();
      }

      return {
        imported,
        skipped: duplicates + invalid,
        duplicates,
        invalid,
      };
    });
  } catch (err) {
    return {
      imported: 0,
      skipped: parsed.length,
      error: `Failed to save imported bookmarks: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function deriveProviderLabelFromEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "Custom";
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return "Local";
    if (host.includes("amazonaws.com")) return "AWS";
    if (host.includes("digitaloceanspaces.com")) return "Spaces";
    if (host.includes("backblazeb2.com")) return "B2";
    if (host.includes("r2.cloudflarestorage.com")) return "R2";
    if (host.includes("wasabisys.com")) return "Wasabi";
    return host.length > 24 ? `${host.slice(0, 21)}…` : host;
  } catch {
    return trimmed.length > 24 ? `${trimmed.slice(0, 21)}…` : trimmed;
  }
}

export function renderBookmarkList(
  listEl: HTMLElement,
  onSelect: (bookmark: Bookmark) => void,
  onDelete: (bookmark: Bookmark) => void,
  options: {
    emptyMessage?: string;
    emptyTitle?: string;
    layout?: "default" | "connection";
    onRename?: (bookmark: Bookmark) => void;
    onEdit?: (bookmark: Bookmark) => void;
    onDuplicate?: (bookmark: Bookmark) => void;
    /** Case-insensitive name/endpoint filter for the connection layout. */
    filterText?: string;
    /** Ready-made last-used marker text for a row, or null to hide it. */
    lastUsedLabel?: (bookmark: Bookmark) => string | null;
  } = {},
): void {
  const layout = options.layout ?? "default";
  // Handlers resolve rows against this render's snapshot, so a click on a
  // list rendered before a change still names the bookmark it shows.
  const filter = options.filterText?.trim().toLowerCase() ?? "";
  const all = [...bookmarks];
  const rendered = filter
    ? all.filter(
        (b) =>
          b.name.toLowerCase().includes(filter) ||
          b.endpoint.toLowerCase().includes(filter),
      )
    : all;
  const lastUsed = options.lastUsedLabel ?? (() => null);
  if (rendered.length === 0) {
    const emptyDueToFilter = filter && all.length > 0;
    const message = emptyDueToFilter
      ? "No saved connections match that filter."
      : (options.emptyMessage ?? "No bookmarks saved");
    if (layout === "connection") {
      const title = options.emptyTitle ?? "No saved connections";
      listEl.innerHTML =
        `<li class="conn-saved-empty">` +
        `<p class="conn-saved-empty__title">${escapeHtml(emptyDueToFilter ? "No matches" : title)}</p>` +
        `<p class="conn-saved-empty__text">${escapeHtml(message)}</p>` +
        `</li>`;
    } else {
      listEl.innerHTML = `<li class="bookmark-empty">${escapeHtml(message)}</li>`;
    }
    listEl.onkeydown = null;
    listEl.onclick = null;
    return;
  }

  const deleteButton = (b: Bookmark, i: number) =>
    `<button type="button" class="bookmark__delete" data-delete="${i}" aria-label="Delete ${escapeHtml(b.name)}" title="Delete ${escapeHtml(b.name)}">${getIconHtml("x", { className: "lucide-icon bookmark__delete-icon", decorative: true })}</button>`;
  const editButton = (b: Bookmark, i: number) =>
    `<button type="button" class="bookmark__edit" data-edit="${i}" aria-label="Edit ${escapeHtml(b.name)}" title="Edit ${escapeHtml(b.name)}">Edit</button>`;

  // The icon registry has no ellipsis glyph; more-horizontal is the ⋯ menu.
  const rowMenuButton = (b: Bookmark, i: number) =>
    `<button type="button" class="bookmark__menu" data-menu="${i}" aria-label="More actions for ${escapeHtml(b.name)}" aria-haspopup="menu" aria-expanded="false" title="More actions for ${escapeHtml(b.name)}">${getIconHtml("more-horizontal", { className: "lucide-icon bookmark__menu-icon", decorative: true })}</button>`;
  const rowMenu = (b: Bookmark, i: number) =>
    `<div class="bookmark-row-menu" role="menu" aria-label="Actions for ${escapeHtml(b.name)}" hidden>` +
    (options.onEdit
      ? `<button type="button" class="bookmark-row-menu__item" role="menuitem" data-edit="${i}" aria-label="Edit ${escapeHtml(b.name)}">Edit</button>`
      : "") +
    (options.onRename
      ? `<button type="button" class="bookmark-row-menu__item" role="menuitem" data-rename="${i}" aria-label="Rename ${escapeHtml(b.name)}">Rename</button>`
      : "") +
    (options.onDuplicate
      ? `<button type="button" class="bookmark-row-menu__item" role="menuitem" data-duplicate="${i}" aria-label="Duplicate ${escapeHtml(b.name)}">Duplicate</button>`
      : "") +
    `<button type="button" class="bookmark-row-menu__item bookmark-row-menu__item--danger" role="menuitem" data-delete="${i}" aria-label="Delete ${escapeHtml(b.name)}">Delete</button>` +
    `</div>`;

  listEl.innerHTML = rendered
    .map((b, i) => {
      const regionPart = b.region ? ` (${escapeHtml(b.region)})` : "";
      if (layout === "connection") {
        const provider = escapeHtml(
          deriveProviderLabelFromEndpoint(b.endpoint),
        );
        const used = lastUsed(b);
        const usedMarker = used
          ? `<span class="bookmark__last-used">${escapeHtml(used)}</span>`
          : "";
        return `<li class="bookmark-item bookmark-item--connection" data-index="${i}" title="${escapeHtml(b.endpoint)}${regionPart}">
          <button type="button" class="bookmark-item__connect" data-connect="${i}">
            <span class="bookmark-item__connect-body">
              <span class="bookmark-item__top">
                <span class="bookmark__name">${escapeHtml(b.name)}</span>
                <span class="bookmark__provider">${provider}</span>
              </span>
              <span class="bookmark__endpoint">${escapeHtml(b.endpoint)}${regionPart}</span>
            </span>
            ${usedMarker}
          </button>
          ${rowMenuButton(b, i)}
          ${rowMenu(b, i)}
        </li>`;
      }
      return `<li class="bookmark-item" data-index="${i}" role="button" tabindex="0" title="${escapeHtml(b.endpoint)}${regionPart}">
          <div style="flex:1;min-width:0">
            <div class="bookmark__name">${escapeHtml(b.name)}</div>
            <div class="bookmark__endpoint">${escapeHtml(b.endpoint)}${regionPart}</div>
          </div>
          ${options.onEdit ? editButton(b, i) : ""}
          ${deleteButton(b, i)}
        </li>`;
    })
    .join("");

  const closeRowMenus = (except?: HTMLElement): void => {
    listEl.querySelectorAll<HTMLElement>(".bookmark-row-menu").forEach((el) => {
      if (el === except) return;
      el.hidden = true;
    });
    listEl
      .querySelectorAll<HTMLElement>(".bookmark__menu")
      .forEach((el) => el.setAttribute("aria-expanded", "false"));
  };

  listEl.onclick = (e) => {
    const target = e.target as HTMLElement;
    const menuButton = target.closest<HTMLElement>("[data-menu]");
    if (menuButton) {
      e.stopPropagation();
      const idx = parseInt(menuButton.dataset.menu!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        const li = menuButton.closest<HTMLElement>(".bookmark-item");
        const menu = li?.querySelector<HTMLElement>(".bookmark-row-menu");
        if (menu) {
          const open = menu.hidden;
          closeRowMenus(open ? menu : undefined);
          menu.hidden = !open;
          menuButton.setAttribute("aria-expanded", String(open));
        }
      }
      return;
    }
    // Any other click (an item, the Connect button, a row) dismisses the menus.
    closeRowMenus();
    const deleteBtn = target.closest<HTMLElement>("[data-delete]");
    if (deleteBtn) {
      e.stopPropagation();
      const idx = parseInt(deleteBtn.dataset.delete!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        onDelete(rendered[idx]);
      }
      return;
    }
    const renameBtn = target.closest<HTMLElement>("[data-rename]");
    if (renameBtn) {
      e.stopPropagation();
      const idx = parseInt(renameBtn.dataset.rename!, 10);
      if (
        options.onRename &&
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < rendered.length
      ) {
        options.onRename(rendered[idx]);
      }
      return;
    }
    const editBtn = target.closest<HTMLElement>("[data-edit]");
    if (editBtn) {
      e.stopPropagation();
      const idx = parseInt(editBtn.dataset.edit!, 10);
      if (
        options.onEdit &&
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < rendered.length
      ) {
        options.onEdit(rendered[idx]);
      }
      return;
    }
    const duplicateBtn = target.closest<HTMLElement>("[data-duplicate]");
    if (duplicateBtn) {
      e.stopPropagation();
      const idx = parseInt(duplicateBtn.dataset.duplicate!, 10);
      if (
        options.onDuplicate &&
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < rendered.length
      ) {
        options.onDuplicate(rendered[idx]);
      }
      return;
    }
    const connectBtn = target.closest<HTMLElement>("[data-connect]");
    if (connectBtn) {
      const idx = parseInt(connectBtn.dataset.connect!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        onSelect(rendered[idx]);
      }
      return;
    }
    const item = target.closest<HTMLElement>(".bookmark-item");
    if (item && layout !== "connection") {
      highlightBookmarkListItem(listEl, item);
      const idx = parseInt(item.dataset.index!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        onSelect(rendered[idx]);
      }
    }
  };

  listEl.onkeydown = (e) => {
    // Controls inside a row keep their own keys: Enter on Delete must ask
    // to delete, not connect through the row.
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "[data-delete], [data-rename], [data-edit], [data-duplicate], [data-menu]",
      )
    ) {
      if (e.key === "Escape") {
        closeRowMenus();
        const menuBtn = target.closest<HTMLElement>(".bookmark-item");
        menuBtn?.querySelector<HTMLElement>(".bookmark__menu")?.focus();
      }
      return;
    }
    if (e.key === "Escape") {
      closeRowMenus();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const connectButton = target.closest<HTMLElement>(
      ".bookmark-item__connect",
    );
    if (connectButton) {
      e.preventDefault();
      const idx = parseInt(connectButton.dataset.connect!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        onSelect(rendered[idx]);
      }
      return;
    }
    const item = target.closest<HTMLElement>(".bookmark-item");
    if (item && layout !== "connection") {
      e.preventDefault();
      highlightBookmarkListItem(listEl, item);
      const idx = parseInt(item.dataset.index!, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < rendered.length) {
        onSelect(rendered[idx]);
      }
    }
  };

  // Close any open row menu when the pointer goes down elsewhere on the page.
  wireRowMenuOutsideClose();
}

/** One document-level listener closes whichever row menu is open. */
let rowMenuOutsideCloseWired = false;
function wireRowMenuOutsideClose(): void {
  if (rowMenuOutsideCloseWired) return;
  rowMenuOutsideCloseWired = true;
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".bookmark-row-menu, .bookmark__menu")) return;
    document
      .querySelectorAll<HTMLElement>(".bookmark-row-menu")
      .forEach((el) => {
        el.hidden = true;
      });
    document
      .querySelectorAll<HTMLElement>(".bookmark__menu")
      .forEach((el) => el.setAttribute("aria-expanded", "false"));
  });
}

function highlightBookmarkListItem(
  listEl: HTMLElement,
  active: HTMLElement,
): void {
  listEl.querySelectorAll(".bookmark-item").forEach((el) => {
    el.classList.toggle("bookmark-item--selected", el === active);
  });
}
