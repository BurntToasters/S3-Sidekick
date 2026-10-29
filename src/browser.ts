import { state, dom, type ObjectInfo } from "./state.ts";
import {
  cancelPendingFilterRender,
  registerObjectTableRenderer,
  registerSelectionRestorer,
} from "./layout-render-bridge.ts";
import {
  escapeHtml,
  formatSize,
  formatDate,
  basename,
  getIconHtml,
  friendlyError,
  parseJsonObject,
} from "./utils.ts";
import { refreshObjects, MAX_ACCUMULATED_LISTING_ITEMS } from "./connection.ts";
import {
  closeInspectorOnMobile,
  isInspectorOpen,
  markInspectorHasContent,
  syncInspectorFromSelection,
} from "./inspector.ts";
import {
  confirmDiscardInfoProperties,
  hasUnsavedInfoChanges,
} from "./info-panel.ts";
import {
  addSelection,
  clearAllSelection,
  entryFromRow,
  fileEntry,
  folderEntry,
  getSelectedFileKeys,
  getSelectionEntries,
  isSameEntry,
  isSelected,
  removeSelection,
  selectionCount,
  type SelectionEntry,
} from "./app-selection.ts";

type SortColumn = "name" | "size" | "modified";

// Row height follows the --row-height density token. The fallback is the
// default 36px row and is used whenever the token is not set.
const OBJECT_ROW_HEIGHT_FALLBACK = 36;
const OBJECT_VIRTUALIZE_THRESHOLD = 250;
const OBJECT_VIRTUAL_OVERSCAN = 8;
const OBJECT_VIRTUAL_FALLBACK_VIEWPORT = 600;
const TYPE_AHEAD_IDLE_MS = 1000;
const ROW_NAV_KEYS: readonly string[] = [
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
];

let objectRowHeight = OBJECT_ROW_HEIGHT_FALLBACK;

function readObjectRowHeight(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--row-height")
    .trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : OBJECT_ROW_HEIGHT_FALLBACK;
}

type FileRowIconName =
  | "file"
  | "file-text"
  | "file-image"
  | "file-code"
  | "file-archive"
  | "file-video"
  | "file-audio";

const TEXT_DATA_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "html",
  "htm",
  "log",
]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);
const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "sql",
  "rb",
  "php",
  "swift",
  "kt",
  "lua",
  "wasm",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "wmv",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "opus",
]);

function fileExtensionFromName(name: string): string {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

function resolveFileRowIconName(name: string): FileRowIconName {
  const ext = fileExtensionFromName(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "file-image";
  if (TEXT_DATA_EXTENSIONS.has(ext)) return "file-text";
  if (CODE_EXTENSIONS.has(ext)) return "file-code";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "file-archive";
  if (VIDEO_EXTENSIONS.has(ext)) return "file-video";
  if (AUDIO_EXTENSIONS.has(ext)) return "file-audio";
  return "file";
}

function rowIconHtml(iconName: string, fileKind: string): string {
  const html = getIconHtml(iconName, {
    className: "lucide-icon lucide-icon--inline",
    decorative: true,
  });
  if (!html) return "";
  return html.replace("<svg", `<svg data-file-kind="${fileKind}"`);
}

// Row icons are static markup: build once instead of per row per render.
const FOLDER_ROW_ICON_HTML = rowIconHtml("folder", "folder");
const FILE_ROW_ICON_HTML_BY_KIND: Record<FileRowIconName, string> = {
  file: rowIconHtml("file", "file"),
  "file-text": rowIconHtml("file-text", "file-text"),
  "file-image": rowIconHtml("file-image", "file-image"),
  "file-code": rowIconHtml("file-code", "file-code"),
  "file-archive": rowIconHtml("file-archive", "file-archive"),
  "file-video": rowIconHtml("file-video", "file-video"),
  "file-audio": rowIconHtml("file-audio", "file-audio"),
};

let lastInspectorSelectionSignature: string | null = null;

// Revision lookup for the inspector signature. Rebuilt when the listing
// itself changes (new array ref, length, or content revision); per-selection
// signature calls then cost O(picked) plus one cheap O(listing) revision hash
// instead of scanning every object per click. The index stores live object
// references (not snapshots), so in-place metadata mutations are still
// observed without a rescan.
let objectRevisionIndex: Map<string, ObjectInfo> | null = null;
let indexedObjects: typeof state.objects | null = null;
let indexedListingSizes = "";

function listingContentRevision(): string {
  // Cheap FNV-1a over key/size/mtime so a same-length in-place replacement
  // (same array ref and length, swapped element) still invalidates the index
  // and resyncs the inspector.
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const object of state.objects) {
    mix(object.key);
    mix(":");
    mix(object.is_folder ? "folder" : "file");
    mix(":");
    mix(String(object.size));
    mix(":");
    mix(object.last_modified);
    mix(";");
  }
  for (const prefix of state.prefixes) {
    mix(prefix);
    mix(";");
  }
  return (hash >>> 0).toString(16);
}

function selectedObjectRevisions(entries: SelectionEntry[]): string[] {
  const sizes = `${state.objects.length}:${state.prefixes.length}:${listingContentRevision()}`;
  if (
    objectRevisionIndex === null ||
    indexedObjects !== state.objects ||
    indexedListingSizes !== sizes
  ) {
    const index = new Map<string, ObjectInfo>();
    for (const object of state.objects) {
      if (!object.is_folder) {
        index.set(object.key, object);
      }
    }
    objectRevisionIndex = index;
    indexedObjects = state.objects;
    indexedListingSizes = sizes;
  }
  const index = objectRevisionIndex;
  // JSON per entry keeps kind, key and revision unambiguous for any key text.
  return entries
    .map((entry) => {
      if (entry.kind === "folder") return JSON.stringify(["folder", entry.key]);
      const object = index.get(entry.key);
      return JSON.stringify([
        "file",
        entry.key,
        object?.size ?? null,
        object?.last_modified ?? null,
      ]);
    })
    .sort();
}

function getInspectorSelectionSignature(): string {
  return JSON.stringify([
    state.connectionIdentity,
    state.connectionId,
    state.currentBucket,
    state.currentPrefix,
    selectedObjectRevisions(getSelectionEntries()),
  ]);
}

const SORT_PREFERENCE_KEY = "s3-sidekick.browse-sort";
const SORT_COLUMNS: readonly SortColumn[] = ["name", "size", "modified"];

export interface SortPreference {
  column: SortColumn;
  asc: boolean;
}

// Finder and Explorer order: "img2" before "img10", and letter case is ignored.
const listingNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareListingNames(a: string, b: string): number {
  return listingNameCollator.compare(a, b);
}

export function serializeSortPreference(preference: SortPreference): string {
  return JSON.stringify(preference);
}

export function parseSortPreference(raw: string | null): SortPreference | null {
  if (raw === null) return null;
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const column = parsed.column;
  const asc = parsed.asc;
  if (typeof asc !== "boolean") return null;
  if (!SORT_COLUMNS.some((candidate) => candidate === column)) return null;
  return { column: column as SortColumn, asc };
}

function writeSortPreference(): void {
  try {
    window.localStorage.setItem(
      SORT_PREFERENCE_KEY,
      serializeSortPreference({ column: state.sortColumn, asc: state.sortAsc }),
    );
  } catch {
    // Storage unavailable (private mode); the sort simply resets next launch.
  }
}

function restoreSortPreference(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SORT_PREFERENCE_KEY);
  } catch {
    return;
  }
  const preference = parseSortPreference(raw);
  if (!preference) return;
  state.sortColumn = preference.column;
  state.sortAsc = preference.asc;
}

restoreSortPreference();

const LAST_BUCKET_KEY = "s3-sidekick.last-bucket";

export function readLastBucket(): string | null {
  try {
    return window.localStorage.getItem(LAST_BUCKET_KEY);
  } catch {
    return null;
  }
}

function writeLastBucket(name: string): void {
  try {
    window.localStorage.setItem(LAST_BUCKET_KEY, name);
  } catch {
    // Storage unavailable (private mode); last-bucket restore is best-effort.
  }
}

function syncInspectorForSemanticSelectionChange(): void {
  // Signature computation walks the whole accumulated listing; skip it
  // entirely while the inspector is closed (opening it syncs fresh).
  if (!isInspectorOpen()) return;
  const signature = getInspectorSelectionSignature();
  if (signature === lastInspectorSelectionSignature) return;
  lastInspectorSelectionSignature = signature;
  void syncInspectorFromSelection(getSelectionEntries());
}

export function invalidateInspectorSelectionSync(): void {
  lastInspectorSelectionSignature = null;
}

function hasAccelModifier(e: MouseEvent | KeyboardEvent): boolean {
  if (state.platformName === "macos") {
    return e.metaKey && !e.ctrlKey;
  }
  return e.ctrlKey;
}

function setStatus(text: string, autoResetMs?: number): void {
  if (state.statusTimeout !== undefined) {
    clearTimeout(state.statusTimeout);
    state.statusTimeout = undefined;
  }
  const el = document.getElementById("status");
  if (el) el.textContent = text;
  if (autoResetMs && autoResetMs > 0) {
    state.statusTimeout = setTimeout(() => {
      state.statusTimeout = undefined;
      if (typeof document === "undefined") return;
      const el2 = document.getElementById("status");
      if (el2) el2.textContent = "";
    }, autoResetMs);
  }
}

export function getSelectableEntries(): SelectionEntry[] {
  const { sortedFiles, sortedPrefixes } = getCachedSortedListing();
  return [
    ...sortedPrefixes.map(folderEntry),
    ...sortedFiles.map((object) => fileEntry(object.key)),
  ];
}

// Navigation failures used to only flash a 5s status line. Report them two
// ways so they survive long enough to act on: the status line, the one
// announced region, and an inline table row (prepended after the re-render
// below, so it is not wiped by it) with its own Retry button. An error toast
// would announce the same failure a second time.
export function reportNavFailure(message: string, retry: () => void): void {
  setStatus(message, 8000);
  const tbody = document.getElementById("object-tbody");
  if (!tbody) return;
  tbody.querySelector("[data-nav-error]")?.remove();
  // An "empty" placeholder would read as a successful, empty listing.
  for (const placeholder of tbody.querySelectorAll(
    "[data-table-placeholder]",
  )) {
    placeholder.remove();
  }
  const row = document.createElement("tr");
  row.setAttribute("role", "row");
  row.setAttribute("aria-rowindex", "2");
  row.dataset.navError = "true";
  const cell = document.createElement("td");
  cell.setAttribute("role", "gridcell");
  cell.colSpan = 4;
  cell.className = "table-error";
  const text = document.createElement("span");
  text.textContent = message;
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn--sm";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => {
    row.remove();
    retry();
  });
  cell.append(text, retryBtn);
  row.appendChild(cell);
  tbody.prepend(row);
}

// Memoized lowercased basenames: filter ticks re-evaluate every row, so
// avoid recomputing basename+toLowerCase per row per keystroke. Pure in the
// key, so entries stay valid across listings; bounded to avoid growth.
const LOWER_BASENAME_CACHE_MAX = 10000;
const lowerBasenameCache = new Map<string, string>();

function lowerBasename(key: string): string {
  let lower = lowerBasenameCache.get(key);
  if (lower === undefined) {
    lower = basename(key).toLowerCase();
    if (lowerBasenameCache.size >= LOWER_BASENAME_CACHE_MAX) {
      lowerBasenameCache.clear();
    }
    lowerBasenameCache.set(key, lower);
  }
  return lower;
}

// Full sort order depends only on the listing + sort settings, not on the
// filter text. Cache it so 120ms filter ticks skip the O(n log n) re-sort
// and only re-filter. Lengths are part of the key because Load More mutates
// the arrays in place via push.
let sortedListingCache: {
  objects: ObjectInfo[];
  prefixes: string[];
  objectsLen: number;
  prefixesLen: number;
  sortColumn: typeof state.sortColumn;
  sortAsc: boolean;
  listingRevision: string;
  sortedFiles: ObjectInfo[];
  sortedPrefixes: string[];
} | null = null;

function getCachedSortedListing(): {
  sortedFiles: ObjectInfo[];
  sortedPrefixes: string[];
} {
  const cached = sortedListingCache;
  const listingRevision = listingContentRevision();
  if (
    cached?.objects === state.objects &&
    cached.prefixes === state.prefixes &&
    cached.objectsLen === state.objects.length &&
    cached.prefixesLen === state.prefixes.length &&
    cached.sortColumn === state.sortColumn &&
    cached.sortAsc === state.sortAsc &&
    cached.listingRevision === listingRevision
  ) {
    return cached;
  }
  const col = state.sortColumn;
  const asc = state.sortAsc;
  const sortedFiles = state.objects.filter((o) => !o.is_folder);
  sortedFiles.sort((a, b) => {
    let cmp = 0;
    if (col === "name") {
      cmp = compareListingNames(basename(a.key), basename(b.key));
    } else if (col === "size") {
      cmp = a.size - b.size;
    } else if (col === "modified") {
      cmp = a.last_modified.localeCompare(b.last_modified);
    }
    return asc ? cmp : -cmp;
  });
  // Folders follow the direction only for the name column. Size and date keep
  // them A to Z, listed ahead of the files.
  const sortedPrefixes = [...state.prefixes].sort((a, b) => {
    const cmp = compareListingNames(a, b);
    return col === "name" && !asc ? -cmp : cmp;
  });
  sortedListingCache = {
    objects: state.objects,
    prefixes: state.prefixes,
    objectsLen: state.objects.length,
    prefixesLen: state.prefixes.length,
    sortColumn: col,
    sortAsc: asc,
    listingRevision,
    sortedFiles,
    sortedPrefixes,
  };
  return sortedListingCache;
}

interface FilteredListing {
  sortedFiles: ObjectInfo[];
  sortedPrefixes: string[];
}

function getFilteredListing(filterText = state.filterText): FilteredListing {
  const { sortedFiles, sortedPrefixes } = getCachedSortedListing();
  const filter = filterText.trim().toLowerCase();
  if (!filter) return { sortedFiles, sortedPrefixes };
  return {
    sortedFiles: sortedFiles.filter((object) =>
      lowerBasename(object.key).includes(filter),
    ),
    sortedPrefixes: sortedPrefixes.filter((prefix) =>
      lowerBasename(prefix).includes(filter),
    ),
  };
}

/**
 * Return the logical row order used by the table, including rows outside the
 * currently mounted virtual window. Folders and files intentionally share the
 * same order as renderObjectTable so shift ranges never depend on DOM rows.
 */
export function getVisibleSelectableEntries(): SelectionEntry[] {
  const { sortedFiles, sortedPrefixes } = getFilteredListing();
  return [
    ...sortedPrefixes.map(folderEntry),
    ...sortedFiles.map((object) => fileEntry(object.key)),
  ];
}

export function clearSelection(): void {
  rangeBaseEntries = null;
  clearAllSelection();
  updateSelectionUI();
}

export function pruneStaleSelection(
  validEntries?: readonly SelectionEntry[],
): void {
  // Omit the filter from the default validity set: a hidden item is still in
  // the loaded listing and must remain actionable after the filter changes.
  const valid = validEntries ?? getSelectableEntries();
  const validFiles = new Set(
    valid.filter((entry) => entry.kind === "file").map((entry) => entry.key),
  );
  const validFolders = new Set(
    valid.filter((entry) => entry.kind === "folder").map((entry) => entry.key),
  );
  for (const key of state.selectedKeys) {
    if (!validFiles.has(key)) {
      state.selectedKeys.delete(key);
    }
  }
  for (const prefix of state.selectedPrefixes) {
    if (!validFolders.has(prefix)) {
      state.selectedPrefixes.delete(prefix);
    }
  }
}

export function updateFilterClearButton(): void {
  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  const clearButton = document.getElementById(
    "filter-clear",
  ) as HTMLButtonElement | null;
  if (!clearButton) return;
  const inputFilter = filterInput?.value.trim();
  const hasFilter = [inputFilter, state.filterText.trim()].some(Boolean);
  clearButton.disabled = !hasFilter;
  clearButton.setAttribute("aria-hidden", String(!hasFilter));
  clearButton.classList.toggle("filter-clear--visible", hasFilter);
}

/** Empty the filter and re-render, so every loaded row shows at once. */
export function clearFilter(): void {
  resetFilterText();
  renderObjectTable();
}

/**
 * Empty the filter without rendering. Navigation uses this because it renders
 * the new listing itself. A filter render still pending is cancelled.
 */
function resetFilterText(): void {
  cancelPendingFilterRender();
  state.filterText = "";
  const input = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  if (input) input.value = "";
  updateFilterClearButton();
}

function formatItemCounts(folderCount: number, fileCount: number): string {
  const parts: string[] = [];
  if (folderCount > 0) {
    parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "0 objects";
}

function getLoadedListingCounts(): { folders: number; files: number } {
  return {
    folders: state.prefixes.length,
    files: state.objects.filter((object) => !object.is_folder).length,
  };
}

function getListingSummaryText(): string {
  const summary = getLoadedSummaryText();
  // Totals and select-all only cover what has been fetched so far; say so
  // while more pages remain, so a count is never read as the bucket total.
  if (!state.hasMore) return summary;
  return `${summary} · more available · counts cover loaded items only`;
}

function getLoadedSummaryText(): string {
  const { folders: loadedFolders, files: loadedFiles } =
    getLoadedListingCounts();
  const loadedText = formatItemCounts(loadedFolders, loadedFiles);
  const filter = state.filterText.trim();
  if (!filter) return `${loadedText} loaded`;

  const { sortedFiles, sortedPrefixes } = getFilteredListing();
  const matchingText = formatItemCounts(
    sortedPrefixes.length,
    sortedFiles.length,
  );
  const prefix =
    sortedPrefixes.length + sortedFiles.length > 0
      ? `${matchingText} matching`
      : "No objects match filter";
  return `${prefix} · ${loadedText} loaded · Filter searches loaded listing only`;
}

function getSelectionCountText(
  selectedFileCount: number,
  selectedFolderCount: number,
  totalSelected: number,
  hiddenSelectedCount: number,
): string {
  const parts: string[] = [];
  if (selectedFileCount > 0) {
    parts.push(
      `${selectedFileCount} file${selectedFileCount === 1 ? "" : "s"}`,
    );
  }
  if (selectedFolderCount > 0) {
    parts.push(
      `${selectedFolderCount} folder${selectedFolderCount === 1 ? "" : "s"}`,
    );
  }
  const selectedText =
    parts.length > 0
      ? `${parts.join(" + ")} selected`
      : `${totalSelected} selected`;
  if (hiddenSelectedCount > 0 && state.filterText.trim()) {
    return `${selectedText} · ${totalSelected} selected · ${hiddenSelectedCount} hidden by filter`;
  }
  return selectedText;
}

function getCompactSelectionCountText(
  totalSelected: number,
  hiddenSelectedCount: number,
): string {
  const hiddenText =
    hiddenSelectedCount > 0 && state.filterText.trim()
      ? ` · ${hiddenSelectedCount} hidden`
      : "";
  return `${totalSelected} selected${hiddenText}`;
}

/**
 * Accessible name for the select-all checkbox. While more pages remain it
 * selects only the loaded rows, so it says so; a complete listing keeps the
 * plain label.
 */
function selectAllLabel(filtered: boolean): string {
  if (state.hasMore) {
    return filtered
      ? "Select loaded items that match the filter"
      : "Select loaded items only";
  }
  return filtered ? "Select all (filtered)" : "Select all";
}

// Announcement state for the batch summary (see announceBatchStatus).
const FILTER_SETTLE_ANNOUNCE_MS = 500;
let announcedSelectionCount = 0;
let announcedFilterText = "";
let filterSettleTimer: ReturnType<typeof setTimeout> | undefined;

/** Hidden status node that carries batch announcements, created on first use. */
function ensureBatchAnnouncer(toolbar: HTMLElement): HTMLElement {
  const existing = toolbar.querySelector<HTMLElement>("[data-batch-announcer]");
  if (existing) return existing;
  const announcer = document.createElement("span");
  announcer.className = "sr-only";
  announcer.dataset.batchAnnouncer = "";
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("aria-atomic", "true");
  toolbar.appendChild(announcer);
  return announcer;
}

/**
 * Announce the selection count when it changes, and the filter summary once
 * the filter has settled. The visible count is rewritten on every filter tick,
 * so it is never the announced region.
 */
function announceBatchStatus(
  toolbar: HTMLElement,
  batchCount: HTMLElement,
  totalSelected: number,
  filterText: string,
): void {
  const announcer = ensureBatchAnnouncer(toolbar);
  if (totalSelected !== announcedSelectionCount) {
    announcedSelectionCount = totalSelected;
    announcer.textContent = batchCount.textContent ?? "";
  }
  if (filterText === announcedFilterText) return;
  announcedFilterText = filterText;
  if (filterSettleTimer !== undefined) clearTimeout(filterSettleTimer);
  filterSettleTimer = setTimeout(() => {
    filterSettleTimer = undefined;
    announcer.textContent = batchCount.textContent ?? "";
  }, FILTER_SETTLE_ANNOUNCE_MS);
}

export function updateSelectionUI(): void {
  // Retain selection across filter input; only prune keys that left the
  // listing itself. Filtering merely hides rows, it must not deselect them.
  updateFilterClearButton();
  pruneStaleSelection(getSelectableEntries());
  const allEntries = getVisibleSelectableEntries();

  const rows = dom.objectTbody.querySelectorAll<HTMLElement>(".object-row");
  for (const row of rows) {
    const entry = entryFromRow(row);
    const cb = row.querySelector<HTMLInputElement>(".row-check");
    const selected = entry !== null && isSelected(entry);
    row.classList.toggle("object-row--selected", selected);
    row.setAttribute("aria-selected", String(selected));
    if (cb) cb.checked = selected;
  }

  let visibleSelectedCount = 0;
  for (const entry of allEntries) {
    if (isSelected(entry)) visibleSelectedCount += 1;
  }
  const selectAll = document.getElementById(
    "select-all",
  ) as HTMLInputElement | null;
  if (selectAll) {
    selectAll.checked =
      allEntries.length > 0 && visibleSelectedCount === allEntries.length;
    selectAll.indeterminate =
      visibleSelectedCount > 0 && visibleSelectedCount < allEntries.length;
    const label = selectAllLabel(state.filterText.trim().length > 0);
    selectAll.title = label;
    selectAll.setAttribute("aria-label", label);
  }

  const selectedFileCount = getSelectedFileKeys().length;
  const totalSelected = selectionCount();
  const selectedFolderCount = totalSelected - selectedFileCount;
  const hiddenSelectedCount = totalSelected - visibleSelectedCount;
  const listingLoading = dom.objectPanel.getAttribute("aria-busy") === "true";
  const batchToolbar = document.getElementById(
    "batch-toolbar",
  ) as HTMLDivElement | null;
  const batchCount = document.getElementById(
    "batch-count",
  ) as HTMLSpanElement | null;
  if (batchToolbar && batchCount) {
    batchToolbar.hidden = false;
    batchToolbar.dataset.selectionState =
      totalSelected > 0 ? "selected" : listingLoading ? "loading" : "idle";
    batchToolbar.setAttribute("aria-busy", String(listingLoading));
    const batchCountText =
      totalSelected > 0
        ? getSelectionCountText(
            selectedFileCount,
            selectedFolderCount,
            totalSelected,
            hiddenSelectedCount,
          )
        : listingLoading
          ? "Loading listing…"
          : getListingSummaryText();
    batchCount.textContent = batchCountText;
    batchCount.title = batchCount.textContent;
    batchCount.setAttribute("aria-label", batchCountText);
    // Not a live region itself: the summary is rewritten on every filter tick.
    batchCount.setAttribute("aria-live", "off");
    announceBatchStatus(
      batchToolbar,
      batchCount,
      totalSelected,
      state.filterText.trim(),
    );
    if (totalSelected > 0) {
      batchCount.dataset.compactCount = getCompactSelectionCountText(
        totalSelected,
        hiddenSelectedCount,
      );
    } else {
      delete batchCount.dataset.compactCount;
    }
    const batchActions = document.getElementById(
      "batch-toolbar-actions",
    ) as HTMLDivElement | null;
    if (batchActions) batchActions.hidden = totalSelected === 0;

    const batchDownload = document.getElementById(
      "batch-download",
    ) as HTMLButtonElement | null;
    const batchDelete = document.getElementById(
      "batch-delete",
    ) as HTMLButtonElement | null;
    const batchProperties = document.getElementById(
      "batch-properties",
    ) as HTMLButtonElement | null;
    const batchCopyUrls = document.getElementById(
      "batch-copy-urls",
    ) as HTMLButtonElement | null;
    const canDownloadFiles = selectedFileCount > 0;
    const hasOnlyFolders = selectedFolderCount > 0 && selectedFileCount === 0;

    if (batchDownload) {
      batchDownload.disabled = !canDownloadFiles || listingLoading;
      batchDownload.title = canDownloadFiles
        ? listingLoading
          ? "Download unavailable while listing loads"
          : `Download ${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"}`
        : hasOnlyFolders
          ? "Download applies to files only"
          : "Select files to download";
    }
    if (batchDelete) {
      const deleteInFlight = batchDelete.dataset.operationInFlight === "true";
      batchDelete.disabled =
        totalSelected === 0 || deleteInFlight || listingLoading;
      batchDelete.title = deleteInFlight
        ? "Delete in progress"
        : listingLoading
          ? "Delete unavailable while listing loads"
          : totalSelected > 0
            ? `Delete ${totalSelected} selected item${totalSelected === 1 ? "" : "s"}`
            : "Select items to delete";
    }
    if (batchProperties) {
      batchProperties.disabled = totalSelected === 0 || listingLoading;
      batchProperties.title = listingLoading
        ? "Properties unavailable while listing loads"
        : totalSelected > 0
          ? `Properties for ${totalSelected} selected`
          : "Select items for properties";
    }
    if (batchCopyUrls) {
      batchCopyUrls.disabled = !canDownloadFiles || listingLoading;
      batchCopyUrls.title = canDownloadFiles
        ? listingLoading
          ? "Copy URLs unavailable while listing loads"
          : "Copy URLs for selected files"
        : "Select files to copy URLs";
    }
    const batchDeselect = document.getElementById(
      "batch-deselect",
    ) as HTMLButtonElement | null;
    if (batchDeselect) {
      batchDeselect.disabled = totalSelected === 0;
      batchDeselect.title =
        totalSelected > 0 ? "Deselect all selected items" : "No items selected";
    }
    const batchMore = document.getElementById(
      "batch-more",
    ) as HTMLButtonElement | null;
    if (batchMore) {
      batchMore.hidden = totalSelected === 0;
      batchMore.disabled = totalSelected === 0;
      batchMore.setAttribute("aria-label", "More selection actions");
      batchMore.title = "More selection actions";
    }
  }

  const downloadBtn = document.getElementById(
    "btn-download",
  ) as HTMLButtonElement | null;
  if (downloadBtn) {
    downloadBtn.disabled = selectedFileCount === 0 || listingLoading;
    downloadBtn.title = listingLoading
      ? "Download unavailable while listing loads"
      : selectedFileCount > 0
        ? `Download ${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"}`
        : "Select files to download";
  }

  if (totalSelected > 0) {
    markInspectorHasContent();
  }
  syncInspectorForSemanticSelectionChange();
}

let lastClickedEntry: SelectionEntry | null = null;
// Selection the open Shift range grows from. Captured on the first Shift
// extension after an anchor is set, so the range can grow and shrink without
// dropping rows selected before it. Any other selection action clears it.
let rangeBaseEntries: SelectionEntry[] | null = null;

/** Set the Shift-range anchor and start a new range base. */
function setAnchor(entry: SelectionEntry | null): void {
  lastClickedEntry = entry;
  rangeBaseEntries = null;
}

export function setLastClickedEntry(entry: SelectionEntry | null): void {
  setAnchor(entry);
}

/**
 * Select the rows between the anchor and `targetIndex` on top of the selection
 * from before the range began. Shift+click and Shift+Arrow share this, so the
 * range can grow or shrink without dropping rows selected before it.
 */
function selectShiftRange(
  ordered: readonly SelectionEntry[],
  anchorIndex: number,
  targetIndex: number,
): void {
  rangeBaseEntries ??= getSelectionEntries();
  clearAllSelection();
  for (const entry of rangeBaseEntries) addSelection(entry);
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (let i = from; i <= to; i += 1) {
    addSelection(ordered[i]);
  }
}

export function handleRowClick(entry: SelectionEntry, e: MouseEvent): void {
  const allEntries = getVisibleSelectableEntries();
  const indexOfEntry = (target: SelectionEntry | null): number =>
    target === null
      ? -1
      : allEntries.findIndex((candidate) => isSameEntry(candidate, target));

  if (e.shiftKey && lastClickedEntry) {
    const startIdx = indexOfEntry(lastClickedEntry);
    const endIdx = indexOfEntry(entry);
    if (startIdx >= 0 && endIdx >= 0) {
      // The range grows from the old anchor. The clicked row then becomes the
      // anchor, so the next Shift+click extends from it.
      selectShiftRange(allEntries, startIdx, endIdx);
      setAnchor(entry);
    } else {
      // A filter can hide the anchor while the clicked row remains visible.
      // Treat that range as a normal click so Shift-click always selects the
      // row instead of silently doing nothing.
      clearAllSelection();
      addSelection(entry);
      setAnchor(entry);
    }
  } else if (hasAccelModifier(e)) {
    if (isSelected(entry)) {
      removeSelection(entry);
    } else {
      addSelection(entry);
    }
    setAnchor(entry);
  } else {
    clearAllSelection();
    addSelection(entry);
    setAnchor(entry);
  }

  for (const row of dom.objectTbody.querySelectorAll<HTMLElement>(
    ".object-row",
  )) {
    row.tabIndex = -1;
  }
  const clickedRow = Array.from(
    dom.objectTbody.querySelectorAll<HTMLElement>(".object-row"),
  ).find((row) => {
    const rowEntry = entryFromRow(row);
    return rowEntry !== null && isSameEntry(rowEntry, entry);
  });
  if (clickedRow) clickedRow.tabIndex = 0;
  updateSelectionUI();
}

export function handleSelectAll(checked: boolean): void {
  rangeBaseEntries = null;
  const allEntries = getVisibleSelectableEntries();
  if (checked) {
    for (const selectable of allEntries) addSelection(selectable);
  } else {
    for (const selectable of allEntries) removeSelection(selectable);
  }
  updateSelectionUI();
}

export function toggleSort(column: SortColumn): void {
  if (state.sortColumn === column) {
    state.sortAsc = !state.sortAsc;
  } else {
    // Names start A to Z; size and date start with the largest or newest.
    state.sortColumn = column;
    state.sortAsc = column === "name";
  }
  writeSortPreference();
  updateSortIndicators();
  renderObjectTable();
}

function updateSortIndicators(): void {
  const cols: ("name" | "size" | "modified")[] = ["name", "size", "modified"];
  for (const col of cols) {
    const el = document.getElementById("sort-" + col);
    if (el) {
      if (state.sortColumn === col) {
        el.innerHTML = state.sortAsc
          ? getIconHtml("arrow-up", {
              className: "lucide-icon lucide-icon--sort",
              decorative: true,
            })
          : getIconHtml("arrow-down", {
              className: "lucide-icon lucide-icon--sort",
              decorative: true,
            });
      } else {
        el.innerHTML = "";
      }
    }
    const th = document.querySelector<HTMLElement>(`th[data-sort="${col}"]`);
    if (th) {
      th.setAttribute(
        "aria-sort",
        state.sortColumn === col
          ? state.sortAsc
            ? "ascending"
            : "descending"
          : "none",
      );
    }
  }
}

export function renderBucketList(): void {
  const el = dom.bucketList;
  // Preserve focus + scroll across the innerHTML rebuild (same pattern as the
  // object table's activeRowId restore) so filtering/selection keystrokes
  // don't destroy sidebar focus.
  const activeBucket =
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.closest<HTMLElement>(".list__item-btn")?.dataset
          .bucket ?? null)
      : null;
  const scrollTop =
    (el as HTMLElement).scrollTop ??
    (el.parentElement as HTMLElement | null)?.scrollTop ??
    0;
  const scrollParent = el.parentElement as HTMLElement | null;
  const parentScrollTop = scrollParent?.scrollTop ?? 0;
  el.setAttribute("aria-busy", "false");
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", "Buckets");
  el.setAttribute("aria-multiselectable", "false");
  if (state.buckets.length === 0) {
    el.innerHTML = bucketSidebarEmptyHtml(
      "No buckets found",
      "This account has no buckets you can list here.",
    );
    return;
  }
  const filter = state.bucketFilterText.trim().toLowerCase();
  const visibleBuckets = filter
    ? state.buckets.filter((bucket) =>
        bucket.name.toLowerCase().includes(filter),
      )
    : state.buckets;
  if (visibleBuckets.length === 0) {
    el.innerHTML = bucketSidebarEmptyHtml(
      "No buckets match filter",
      "Try a different term in the bucket filter.",
    );
    return;
  }
  const bucketIcon = getIconHtml("database", {
    className: "lucide-icon bucket-icon",
    decorative: true,
  });
  // Roving tabindex: active bucket (or first visible) is tabbable, the rest
  // are reachable via arrow keys handled in handleBucketListKeydown.
  const activeBucketIsVisible = visibleBuckets.some(
    (bucket) => bucket.name === state.currentBucket,
  );
  const rovingBucket = activeBucketIsVisible
    ? state.currentBucket
    : visibleBuckets[0].name;
  el.innerHTML = visibleBuckets
    .map(
      (b) =>
        `<li class="list__item${b.name === state.currentBucket ? " list__item--active" : ""}" role="presentation">` +
        `<button type="button" class="list__item-btn" role="option" aria-selected="${b.name === state.currentBucket ? "true" : "false"}" tabindex="${b.name === rovingBucket ? "0" : "-1"}" data-bucket="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}" aria-label="Open bucket ${escapeHtml(b.name)}"${b.name === state.currentBucket ? ' aria-current="true"' : ""}>` +
        bucketIcon +
        `<span class="list__item-label">${escapeHtml(b.name)}</span>` +
        `</button>` +
        `</li>`,
    )
    .join("");
  if (scrollParent) scrollParent.scrollTop = parentScrollTop;
  (el as HTMLElement).scrollTop = scrollTop;
  // Only restore focus when it was inside the list before the rebuild.
  // Unconditionally focusing the roving button pulls focus away from the
  // filter input, dialogs, or other panels on every refresh.
  if (activeBucket === null) return;
  const restoreName = activeBucket;
  const restoreTarget =
    Array.from(el.querySelectorAll<HTMLElement>(".list__item-btn")).find(
      (btn) => btn.dataset.bucket === restoreName,
    ) ??
    Array.from(el.querySelectorAll<HTMLElement>(".list__item-btn")).find(
      (btn) => btn.dataset.bucket === rovingBucket,
    ) ??
    null;
  (restoreTarget as HTMLElement | null)?.focus?.({ preventScroll: true });
}

export function handleBucketListKeydown(e: KeyboardEvent): void {
  if (
    e.key !== "ArrowDown" &&
    e.key !== "ArrowUp" &&
    e.key !== "Home" &&
    e.key !== "End"
  ) {
    return;
  }
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    ".list__item-btn",
  );
  if (!target) return;
  const buttons = Array.from(
    dom.bucketList.querySelectorAll<HTMLElement>(".list__item-btn"),
  );
  const index = buttons.indexOf(target);
  if (index < 0) return;
  e.preventDefault();
  let nextIndex = index;
  if (e.key === "ArrowDown") nextIndex = (index + 1) % buttons.length;
  else if (e.key === "ArrowUp")
    nextIndex = (index - 1 + buttons.length) % buttons.length;
  else if (e.key === "Home") nextIndex = 0;
  else if (e.key === "End") nextIndex = buttons.length - 1;
  const next = buttons[nextIndex];
  if (!next) return;
  for (const btn of buttons) btn.tabIndex = btn === next ? 0 : -1;
  next.focus();
}

export function renderBucketListSkeleton(rowCount = 6): void {
  const item =
    `<li class="list__item list__item--skeleton" aria-hidden="true">` +
    `<span class="skeleton skeleton--text"></span>` +
    `</li>`;
  dom.bucketList.innerHTML = item.repeat(rowCount);
  dom.bucketList.setAttribute("aria-busy", "true");
}

// Warm navigations finish in a few milliseconds. Painting the skeleton at once
// flashed on every click, so it appears only if the listing is still loading
// after this delay; until then the previous rows stay in place.
const SKELETON_DELAY_MS = 150;
let skeletonTimer: ReturnType<typeof setTimeout> | undefined;

function cancelPendingSkeleton(): void {
  if (skeletonTimer === undefined) return;
  clearTimeout(skeletonTimer);
  skeletonTimer = undefined;
}

function paintObjectTableSkeleton(rowCount: number): void {
  // Body rows start at aria-rowindex 2; the header is row 1.
  const rows = Array.from(
    { length: rowCount },
    (_, index) =>
      `<tr class="object-row object-row--skeleton" aria-hidden="true" aria-rowindex="${index + 2}">` +
      `<td class="col-check"><span class="skeleton skeleton--check"></span></td>` +
      `<td class="object-name"><div class="object-name__inner"><span class="skeleton skeleton--icon"></span><span class="skeleton skeleton--text"></span></div></td>` +
      `<td class="object-size"><span class="skeleton skeleton--text skeleton--sm"></span></td>` +
      `<td class="object-modified"><span class="skeleton skeleton--text skeleton--md"></span></td>` +
      `</tr>`,
  );
  dom.objectTbody.innerHTML = rows.join("");
}

export function renderObjectTableSkeleton(rowCount = 8): void {
  dom.objectPanel.style.display = "";
  dom.objectPanel.setAttribute("aria-busy", "true");
  dom.emptyState.style.display = "none";
  const loadMore = document.getElementById("load-more-row");
  if (loadMore) loadMore.style.display = "none";
  updateSelectionUI();
  cancelPendingSkeleton();
  skeletonTimer = setTimeout(() => {
    skeletonTimer = undefined;
    if (dom.objectPanel.getAttribute("aria-busy") !== "true") return;
    paintObjectTableSkeleton(rowCount);
  }, SKELETON_DELAY_MS);
}

function bucketSidebarEmptyHtml(title: string, text: string): string {
  return (
    `<li class="list__empty browse-sidebar-empty">` +
    `<div class="browse-sidebar-empty__content">` +
    `${getIconHtml("database", { className: "lucide-icon empty-state__icon", decorative: true })}` +
    `<p class="browse-sidebar-empty__title">${escapeHtml(title)}</p>` +
    `<p class="browse-sidebar-empty__text">${escapeHtml(text)}</p>` +
    `</div></li>`
  );
}

function emptyFolderRowHtml(atBucketRoot: boolean): string {
  const title = atBucketRoot ? "Empty bucket" : "Empty folder";
  const text = atBucketRoot ? "This bucket is empty" : "This folder is empty";
  return (
    `<tr role="row" aria-rowindex="2" data-table-placeholder><td role="gridcell" colspan="4" class="table-empty">` +
    `<div class="table-empty__content browse-empty">` +
    `${getIconHtml("folder", { className: "lucide-icon empty-state__icon", decorative: true })}` +
    `<h3 class="browse-empty__title">${title}</h3>` +
    `<p class="browse-empty__text">${text}</p>` +
    `<div class="table-empty__actions">` +
    `<button type="button" class="btn btn--sm btn--primary" data-empty-action="upload">Upload files</button>` +
    `<button type="button" class="btn btn--sm" data-empty-action="new-folder">New folder</button>` +
    `</div></div></td></tr>`
  );
}

function filterMissRowHtml(): string {
  return (
    `<tr role="row" aria-rowindex="2" data-table-placeholder><td role="gridcell" colspan="4" class="table-empty">` +
    `<div class="table-empty__content browse-empty">` +
    `${getIconHtml("search", { className: "lucide-icon empty-state__icon", decorative: true })}` +
    `<h3 class="browse-empty__title">Nothing matched</h3>` +
    `<p class="browse-empty__text">Try a different term in the object filter.</p>` +
    `<div class="table-empty__actions">` +
    `<button type="button" class="btn btn--sm btn--primary" data-empty-action="clear-filter">Clear filter</button>` +
    `</div></div></td></tr>`
  );
}

interface ObjectTableEntry {
  id: string;
  kind: "file" | "folder";
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

export interface ObjectVirtualRange {
  start: number;
  end: number;
}

export function calculateObjectVirtualRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = objectRowHeight,
  overscan = OBJECT_VIRTUAL_OVERSCAN,
): ObjectVirtualRange {
  if (total <= 0) return { start: 0, end: 0 };
  const safeRowHeight = Math.max(1, rowHeight);
  const unclampedVisibleStart = Math.floor(
    Math.max(0, scrollTop) / safeRowHeight,
  );
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / safeRowHeight));
  const visibleStart = Math.min(
    unclampedVisibleStart,
    Math.max(0, total - visibleCount),
  );
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(total, visibleStart + visibleCount + overscan);
  return { start, end };
}

let renderedTableEntries: ObjectTableEntry[] = [];
let objectPanelListenerTarget: HTMLElement | null = null;
let virtualRenderScheduled = false;

function createObjectRow(): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.setAttribute("role", "row");
  // The row itself is the Tab stop (roving); its checkbox stays clickable.
  row.innerHTML = `<td role="gridcell" class="col-check"><input type="checkbox" class="row-check" tabindex="-1" /></td>
    <td role="gridcell" class="object-name"><div class="object-name__inner"><span class="object-kind-icon"></span><span class="object-name__text"></span></div></td>
    <td role="gridcell" class="object-size"></td>
    <td role="gridcell" class="object-modified"></td>`;
  return row;
}

function updateObjectRow(
  row: HTMLTableRowElement,
  entry: ObjectTableEntry,
  logicalIndex: number,
): void {
  row.className = `object-row object-row--${entry.kind}`;
  row.dataset.rowId = entry.id;
  row.dataset.logicalIndex = String(logicalIndex);
  row.setAttribute("aria-rowindex", String(logicalIndex + 2));
  if (entry.kind === "folder") {
    row.dataset.prefix = entry.key;
    row.removeAttribute("data-key");
  } else {
    row.dataset.key = entry.key;
    row.removeAttribute("data-prefix");
  }

  const checkbox = row.querySelector<HTMLInputElement>(".row-check");
  const nameCell = row.querySelector<HTMLElement>(".object-name");
  const nameText = row.querySelector<HTMLElement>(".object-name__text");
  const icon = row.querySelector<HTMLElement>(".object-kind-icon");
  const sizeCell = row.querySelector<HTMLElement>(".object-size");
  const modifiedCell = row.querySelector<HTMLElement>(".object-modified");
  const selected = isSelected(
    entry.kind === "folder" ? folderEntry(entry.key) : fileEntry(entry.key),
  );

  if (checkbox) {
    checkbox.setAttribute("aria-label", `Select ${entry.kind} ${entry.name}`);
    checkbox.checked = selected;
  }
  row.classList.toggle("object-row--selected", selected);
  row.setAttribute("aria-selected", String(selected));
  if (nameCell) nameCell.title = entry.name;
  if (nameText) {
    nameText.textContent = entry.name;
    nameText.title = entry.name;
  }
  if (icon) {
    icon.className = `object-kind-icon icon-${entry.kind}`;
    if (entry.kind === "folder") {
      icon.innerHTML = FOLDER_ROW_ICON_HTML;
    } else {
      const iconName = resolveFileRowIconName(entry.name);
      icon.innerHTML = FILE_ROW_ICON_HTML_BY_KIND[iconName];
    }
  }
  if (sizeCell) {
    sizeCell.className =
      entry.kind === "folder"
        ? "object-size object-size--folder"
        : "object-size";
    sizeCell.textContent =
      entry.kind === "folder" ? "Folder" : formatSize(entry.size);
  }
  if (modifiedCell) {
    modifiedCell.className =
      entry.kind === "folder"
        ? "object-modified object-modified--muted"
        : "object-modified";
    modifiedCell.textContent =
      entry.kind === "folder" ? "\u2014" : formatDate(entry.lastModified);
  }
}

function createVirtualSpacer(
  height: number,
  position: "top" | "bottom",
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = `object-virtual-spacer object-virtual-spacer--${position}`;
  row.setAttribute("aria-hidden", "true");
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.style.height = `${Math.max(0, height)}px`;
  row.appendChild(cell);
  return row;
}

function renderCurrentObjectWindow(
  scrollTop = dom.objectPanel.scrollTop,
): void {
  const tbody = dom.objectTbody;
  const entries = renderedTableEntries;
  if (entries.length === 0) return;

  const panel = dom.objectPanel;
  const virtualized = entries.length >= OBJECT_VIRTUALIZE_THRESHOLD;
  const viewportHeight =
    panel.clientHeight > 0
      ? panel.clientHeight
      : OBJECT_VIRTUAL_FALLBACK_VIEWPORT;
  const range = virtualized
    ? calculateObjectVirtualRange(
        entries.length,
        scrollTop,
        viewportHeight,
        objectRowHeight,
      )
    : { start: 0, end: entries.length };

  const activeRow =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>(".object-row")
      : null;
  const activeRowId = activeRow?.dataset.rowId ?? null;
  const rovingRow = tbody.querySelector<HTMLElement>(
    '.object-row[tabindex="0"]',
  );
  const rovingRowId = activeRowId ?? rovingRow?.dataset.rowId ?? null;
  const existingRows = new Map<string, HTMLTableRowElement>();
  for (const row of tbody.querySelectorAll<HTMLTableRowElement>(
    ".object-row[data-row-id]",
  )) {
    const id = row.dataset.rowId;
    if (id) existingRows.set(id, row);
  }

  const fragment = document.createDocumentFragment();
  if (virtualized && range.start > 0) {
    fragment.appendChild(
      createVirtualSpacer(range.start * objectRowHeight, "top"),
    );
  }

  // A focused row that scrolled out of the window is kept mounted as a
  // zero-height "parked" row next to the spacer it belongs beside. Removing it
  // would drop keyboard focus to <body>; keeping it keeps focus on the row the
  // user chose, so arrow keys continue from there.
  const parkIndex =
    virtualized && activeRowId
      ? entries.findIndex((entry) => entry.id === activeRowId)
      : -1;
  const parkBefore = parkIndex >= 0 && parkIndex < range.start;
  const parkAfter = parkIndex >= range.end;
  const appendParkedRow = (): void => {
    const entry = entries[parkIndex];
    const row = existingRows.get(entry.id) ?? createObjectRow();
    updateObjectRow(row, entry, parkIndex);
    row.classList.add("object-row--parked");
    row.tabIndex = 0;
    fragment.appendChild(row);
  };
  if (parkBefore) appendParkedRow();

  let rovingAssigned = parkBefore || parkAfter;
  for (let index = range.start; index < range.end; index += 1) {
    const entry = entries[index];
    const row = existingRows.get(entry.id) ?? createObjectRow();
    updateObjectRow(row, entry, index);
    const isRoving = entry.id === rovingRowId;
    row.tabIndex = isRoving ? 0 : -1;
    rovingAssigned ||= isRoving;
    fragment.appendChild(row);
  }
  if (parkAfter) appendParkedRow();

  if (virtualized && range.end < entries.length) {
    fragment.appendChild(
      createVirtualSpacer(
        (entries.length - range.end) * objectRowHeight,
        "bottom",
      ),
    );
  }

  tbody.replaceChildren(fragment);
  const mountedRows =
    tbody.querySelectorAll<HTMLTableRowElement>(".object-row");
  if (!rovingAssigned && mountedRows[0]) mountedRows[0].tabIndex = 0;
  if (activeRowId) {
    // Refocus only the row that was focused. If it scrolled out of the virtual
    // window, focus is left alone: moving it to another row would act on a
    // row the user did not choose. The first mounted row keeps the tab stop.
    const restored = Array.from(mountedRows).find(
      (row) => row.dataset.rowId === activeRowId,
    );
    if (restored) {
      for (const row of mountedRows) row.tabIndex = -1;
      restored.tabIndex = 0;
      restored.focus({ preventScroll: true });
    }
  }
}

function scheduleVirtualWindowRender(): void {
  if (
    renderedTableEntries.length < OBJECT_VIRTUALIZE_THRESHOLD ||
    virtualRenderScheduled
  ) {
    return;
  }
  virtualRenderScheduled = true;
  const render = () => {
    virtualRenderScheduled = false;
    renderCurrentObjectWindow();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(render);
  } else {
    queueMicrotask(render);
  }
}

/**
 * Extend the selection from the anchor to `index`, on top of the selection that
 * was in place before the range began. Without an anchor (or when it is
 * filtered away) only the target row is selected. The anchor does not move, so
 * repeated Shift+Arrow grows and shrinks the same range.
 */
function extendSelectionTo(index: number): void {
  const anchor = lastClickedEntry;
  const anchorIndex = anchor
    ? renderedTableEntries.findIndex((candidate) =>
        isSameEntry(candidate, anchor),
      )
    : -1;
  if (anchorIndex < 0) {
    selectRowOnly(index);
    return;
  }
  selectShiftRange(renderedTableEntries, anchorIndex, index);
}

/** Select only the rendered row at `index` and make it the anchor. */
function selectRowOnly(index: number): void {
  const target = renderedTableEntries[index];
  clearAllSelection();
  addSelection(target);
  setAnchor(target);
}

/** Rows in one visible page, below the sticky header. Used by PageUp/PageDown. */
function visibleRowCount(): number {
  const panel = dom.objectPanel;
  const viewportHeight =
    panel.clientHeight > 0
      ? panel.clientHeight
      : OBJECT_VIRTUAL_FALLBACK_VIEWPORT;
  const headerHeight = panel.querySelector("thead")?.offsetHeight ?? 0;
  return Math.max(
    1,
    Math.floor((viewportHeight - headerHeight) / objectRowHeight),
  );
}

/**
 * Printable keys jump to the next row whose name starts with the characters
 * typed so far. The buffer resets after an idle second. Modifier chords and
 * keys typed into a field are left alone.
 */
let typeAheadBuffer = "";
let typeAheadAt = 0;

function handleTypeAhead(event: KeyboardEvent, currentIndex: number): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1 || event.key.trim() === "") return;
  if ((event.target as HTMLElement).closest("input, textarea, select")) return;
  const count = renderedTableEntries.length;
  if (count === 0) return;
  const now = Date.now();
  if (now - typeAheadAt > TYPE_AHEAD_IDLE_MS) typeAheadBuffer = "";
  typeAheadAt = now;
  typeAheadBuffer += event.key.toLowerCase();
  // A single key moves past the current row; a longer buffer may still match it.
  const start = typeAheadBuffer.length === 1 ? currentIndex + 1 : currentIndex;
  for (let step = 0; step < count; step += 1) {
    const index = (start + step) % count;
    if (
      renderedTableEntries[index].name.toLowerCase().startsWith(typeAheadBuffer)
    ) {
      revealLogicalIndex(index);
      selectRowOnly(index);
      focusLogicalRow(index);
      updateSelectionUI();
      return;
    }
  }
}

/**
 * Shift+F10 and the ContextMenu key open the row menu at the focused row's
 * on-screen position, as a right-click on that row would.
 */
function openFocusedRowContextMenu(event: KeyboardEvent): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".object-row");
  if (!row) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

// Sole owner of Arrow/Home/End/PageUp/PageDown row navigation, Shift+F10 and
// the ContextMenu key, and type-ahead for the object table (both virtualized
// and plain windows). Registered capture-phase so it runs before the app-events
// tbody handler, which only handles Space/Enter.
// Plain arrows move focus and select that row; Shift extends a range from the
// anchor; Ctrl/Cmd moves focus only. A focused row checkbox does not opt out.
function handleObjectTableKeydown(event: KeyboardEvent): void {
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    openFocusedRowContextMenu(event);
    return;
  }
  const row = (event.target as HTMLElement).closest<HTMLElement>(".object-row");
  if (!row) return;
  const currentIndex = Number.parseInt(row.dataset.logicalIndex ?? "", 10);
  if (!Number.isInteger(currentIndex)) return;
  if (!ROW_NAV_KEYS.includes(event.key)) {
    handleTypeAhead(event, currentIndex);
    return;
  }

  let nextIndex = currentIndex;
  if (event.key === "ArrowDown") nextIndex += 1;
  if (event.key === "ArrowUp") nextIndex -= 1;
  if (event.key === "PageDown") nextIndex += visibleRowCount();
  if (event.key === "PageUp") nextIndex -= visibleRowCount();
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = renderedTableEntries.length - 1;
  nextIndex = Math.max(0, Math.min(renderedTableEntries.length - 1, nextIndex));
  if (
    nextIndex === currentIndex &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  revealLogicalIndex(nextIndex);
  if (!hasAccelModifier(event)) {
    if (event.shiftKey) {
      extendSelectionTo(nextIndex);
    } else {
      selectRowOnly(nextIndex);
    }
  }
  focusLogicalRow(nextIndex);
  updateSelectionUI();
}

function tbodyRowAtLogicalIndex(index: number): HTMLElement | null {
  return dom.objectTbody.querySelector<HTMLElement>(
    `.object-row[data-logical-index="${index}"]`,
  );
}

/** Scroll offset that brings logical row `index` fully into a viewport. */
export function scrollTopToReveal(
  index: number,
  currentTop: number,
  viewportHeight: number,
): number {
  const rowTop = index * objectRowHeight;
  if (rowTop < currentTop) return rowTop;
  if (rowTop + objectRowHeight > currentTop + viewportHeight) {
    return rowTop + objectRowHeight - viewportHeight;
  }
  return currentTop;
}

/**
 * Make logical row `index` mounted. Non-virtualized tables scroll natively on
 * focus, so only the virtual window needs an explicit scroll and render.
 */
function revealLogicalIndex(index: number): void {
  if (renderedTableEntries.length < OBJECT_VIRTUALIZE_THRESHOLD) return;
  const panel = dom.objectPanel;
  const viewportHeight =
    panel.clientHeight > 0
      ? panel.clientHeight
      : OBJECT_VIRTUAL_FALLBACK_VIEWPORT;
  const top = scrollTopToReveal(index, panel.scrollTop, viewportHeight);
  if (top !== panel.scrollTop) panel.scrollTop = top;
  renderCurrentObjectWindow(top);
}

/** Make one row the only tab stop and move DOM focus to it. */
function focusLogicalRow(index: number): boolean {
  const target = tbodyRowAtLogicalIndex(index);
  if (!target) return false;
  for (const row of dom.objectTbody.querySelectorAll<HTMLElement>(
    ".object-row",
  )) {
    row.tabIndex = -1;
  }
  target.tabIndex = 0;
  target.focus();
  return true;
}

/** Rendered position of the first selected row, or -1 when none is selected. */
export function renderedIndexOfSelection(): number {
  return renderedTableEntries.findIndex((entry) => isSelected(entry));
}

/**
 * Scroll the object table so a row is mounted and focus it. Lets other flows
 * (Go to Key, post-delete, post-rename) land focus on a known row even when
 * it sits outside the virtual window. Returns false if nothing was focused.
 */
export function focusObjectTableRow(target: {
  entry?: SelectionEntry;
  logicalIndex?: number;
}): boolean {
  const count = renderedTableEntries.length;
  if (count === 0) return false;
  let index = -1;
  if (target.entry) {
    const wanted = target.entry;
    index = renderedTableEntries.findIndex((candidate) =>
      isSameEntry(candidate, wanted),
    );
  }
  if (index < 0 && target.logicalIndex !== undefined) {
    index = Math.min(count - 1, Math.max(0, target.logicalIndex));
  }
  if (index < 0) return false;
  revealLogicalIndex(index);
  return focusLogicalRow(index);
}

/**
 * Make `entry` the only selected row. Focus and scroll are left alone, so
 * Enter can select the focused row before it opens.
 */
export function selectOnlyEntry(entry: SelectionEntry): void {
  clearAllSelection();
  addSelection(entry);
  setAnchor(entry);
  updateSelectionUI();
}

/**
 * Select exactly one entry (as a plain click does), reveal and focus its row.
 * Returns false when the entry is not in the loaded listing. A filter that
 * hides the entry is cleared so the row can be shown.
 */
export function revealRow(key: string, kind: "file" | "folder"): boolean {
  const entry = kind === "folder" ? folderEntry(key) : fileEntry(key);
  if (
    !getSelectableEntries().some((candidate) => isSameEntry(candidate, entry))
  ) {
    return false;
  }
  if (
    !getVisibleSelectableEntries().some((candidate) =>
      isSameEntry(candidate, entry),
    )
  ) {
    clearFilter();
  }
  clearAllSelection();
  addSelection(entry);
  setAnchor(entry);
  const focused = focusObjectTableRow({ entry });
  updateSelectionUI();
  return focused;
}

function ensureObjectPanelListeners(): void {
  const panel = dom.objectPanel;
  if (objectPanelListenerTarget === panel) return;
  if (objectPanelListenerTarget) {
    objectPanelListenerTarget.removeEventListener(
      "scroll",
      scheduleVirtualWindowRender,
    );
  }
  objectPanelListenerTarget = panel;
  panel.addEventListener("scroll", scheduleVirtualWindowRender, {
    passive: true,
  });
  dom.objectTbody.addEventListener("keydown", handleObjectTableKeydown, true);
}

export function renderObjectTable(): void {
  cancelPendingSkeleton();
  const tbody = dom.objectTbody;
  const filter = state.filterText.trim().toLowerCase();
  // Reuse the exact filtered order used by getVisibleSelectableEntries so a
  // Shift-click range follows the rows shown to the user.
  const { sortedPrefixes: filteredPrefixes, sortedFiles } =
    getFilteredListing();

  renderedTableEntries = [
    ...filteredPrefixes.map((prefix): ObjectTableEntry => ({
      id: `prefix:${prefix}`,
      kind: "folder",
      key: prefix,
      name: basename(prefix),
      size: 0,
      lastModified: "",
    })),
    ...sortedFiles.map((object): ObjectTableEntry => ({
      id: `file:${object.key}`,
      kind: "file",
      key: object.key,
      name: basename(object.key),
      size: object.size,
      lastModified: object.last_modified,
    })),
  ];
  objectRowHeight = readObjectRowHeight();
  const table = tbody.closest("table");
  // The header is row 1; a placeholder row stands in for the empty body.
  table?.querySelector("thead tr")?.setAttribute("aria-rowindex", "1");
  table?.setAttribute(
    "aria-rowcount",
    String(Math.max(renderedTableEntries.length + 1, 2)),
  );
  if (renderedTableEntries.length === 0) {
    tbody.innerHTML =
      filter.length > 0
        ? filterMissRowHtml()
        : emptyFolderRowHtml(state.currentPrefix === "");
  } else {
    ensureObjectPanelListeners();
    renderCurrentObjectWindow();
  }

  dom.objectPanel.style.display = "";
  dom.objectPanel.setAttribute("aria-busy", "false");
  dom.emptyState.style.display = "none";

  updateSelectionUI();
  updateObjectCount();
  updateLoadMore();
  updateSortIndicators();
  committedListingSnapshot = captureListingSnapshot();
}

function updateObjectCount(): void {
  const fileCount = state.objects.filter((o) => !o.is_folder).length;
  const folderCount = state.prefixes.length;
  const parts: string[] = [];
  if (folderCount > 0)
    parts.push(`${folderCount} folder${folderCount !== 1 ? "s" : ""}`);
  if (fileCount > 0)
    parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);

  const countEl = document.getElementById("statusbar-count");
  if (countEl) countEl.textContent = parts.join(", ");

  const inlineCount = document.getElementById("object-count");
  if (inlineCount) inlineCount.textContent = parts.join(", ");
}

function updateLoadMore(): void {
  const row = document.getElementById("load-more-row");
  if (row) {
    row.style.display = state.hasMore || state.listingCapped ? "" : "none";
  }
  const button = document.getElementById("btn-load-more");
  if (button) button.style.display = state.hasMore ? "" : "none";
  const notice = document.getElementById("listing-cap-notice");
  if (notice) {
    notice.hidden = !state.listingCapped;
    notice.textContent = state.listingCapped
      ? `Showing the first ${MAX_ACCUMULATED_LISTING_ITEMS.toLocaleString()} items. Narrow the prefix to reach the rest.`
      : "";
  }
}

export function renderBreadcrumb(): void {
  const el = dom.breadcrumb;
  const parts: string[] = [];

  // The segment for the current location is not a navigation control: it
  // is marked aria-current="page" and rendered as plain text.
  const rootIsCurrent = !state.currentPrefix;
  parts.push(
    rootIsCurrent
      ? `<span class="breadcrumb__segment breadcrumb__segment--root breadcrumb__segment--current" aria-current="page">${escapeHtml(state.currentBucket)}</span>`
      : `<button type="button" class="breadcrumb__segment breadcrumb__segment--root" data-prefix="" aria-label="Open bucket root ${escapeHtml(state.currentBucket)}">${escapeHtml(state.currentBucket)}</button>`,
  );

  if (state.currentPrefix) {
    // Keep empty segments: S3 keys may contain "//", and dropping the empty
    // part would build crumbs for prefixes that do not exist.
    const segments = state.currentPrefix.replace(/\/$/, "").split("/");
    let accumulated = "";
    segments.forEach((seg, index) => {
      accumulated += seg + "/";
      const label = seg === "" ? "(empty)" : seg;
      const isCurrent = index === segments.length - 1;
      parts.push(
        isCurrent
          ? `<span class="breadcrumb__sep">/</span><span class="breadcrumb__segment breadcrumb__segment--current" aria-current="page" title="${escapeHtml(accumulated)}">${escapeHtml(label)}</span>`
          : `<span class="breadcrumb__sep">/</span><button type="button" class="breadcrumb__segment" data-prefix="${escapeHtml(accumulated)}" title="${escapeHtml(accumulated)}" aria-label="Open folder ${escapeHtml(label)}">${escapeHtml(label)}</button>`,
      );
    });
  }

  el.innerHTML = parts.join("");
  syncPathInput();
  updateNavButtons();
}

export function formatLocationPath(bucket: string, prefix: string): string {
  if (!bucket) return "";
  return prefix ? `${bucket}/${prefix}` : `${bucket}/`;
}

export function parseLocationPath(
  raw: string,
): { bucket: string; prefix: string } | null {
  let input = raw.trim();
  if (!input) return null;
  if (/^s3:\/\//i.test(input)) {
    input = input.slice(5);
  }
  input = input.replace(/^\/+/, "");
  if (!input) return null;

  const slash = input.indexOf("/");
  if (slash < 0) {
    return { bucket: input, prefix: "" };
  }
  const bucket = input.slice(0, slash).trim();
  if (!bucket) return null;
  // Keep the prefix as typed. Without a trailing slash it may name a file or
  // a folder; navigateToLocationPath decides which once the parent is listed.
  const prefix = input.slice(slash + 1).replace(/^\/+/, "");
  return { bucket, prefix };
}

export function syncPathInput(): void {
  const input = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  if (!input || document.activeElement === input || isLocationEditMode())
    return;
  input.value = formatLocationPath(state.currentBucket, state.currentPrefix);
}

let locationEditMode = false;

export function isLocationEditMode(): boolean {
  return locationEditMode;
}

export function enterLocationEditMode(): void {
  const omnibar = document.getElementById("location-omnibar");
  const browse = document.getElementById("location-omnibar-browse");
  const edit = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  if (!omnibar || !browse || !edit) return;
  if (locationEditMode) {
    // Already editing: keep what the user typed, just move focus back.
    edit.focus();
    return;
  }
  locationEditMode = true;
  omnibar.classList.add("location-omnibar--edit");
  browse.hidden = true;
  edit.hidden = false;
  edit.value = formatLocationPath(state.currentBucket, state.currentPrefix);
  edit.focus();
  edit.select();
}

export function exitLocationEditMode(restorePath = true): void {
  const omnibar = document.getElementById("location-omnibar");
  const browse = document.getElementById("location-omnibar-browse");
  const edit = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  if (!omnibar || !browse || !edit) return;
  locationEditMode = false;
  omnibar.classList.remove("location-omnibar--edit");
  edit.hidden = true;
  browse.hidden = false;
  if (restorePath) {
    edit.value = formatLocationPath(state.currentBucket, state.currentPrefix);
  }
}

export async function navigateToLocationPath(raw: string): Promise<boolean> {
  const parsed = parseLocationPath(raw);
  if (!parsed) {
    setStatus("Enter a path like bucket/prefix/", 5000);
    return false;
  }

  const knownBuckets = state.buckets.map((b) => b.name);
  if (knownBuckets.length > 0 && !knownBuckets.includes(parsed.bucket)) {
    setStatus(`Unknown bucket: ${parsed.bucket}`, 5000);
    return false;
  }

  if (parsed.prefix !== "" && !parsed.prefix.endsWith("/")) {
    return navigateToLocationLeaf(parsed.bucket, parsed.prefix);
  }
  return navigateToLocationFolder(parsed);
}

/**
 * A path without a trailing slash names a file or a folder. List the parent
 * folder, then select the file if it is loaded, or open `key/` if that folder
 * is loaded. Only loaded pages are searched; no further pages are fetched.
 */
async function navigateToLocationLeaf(
  bucket: string,
  key: string,
): Promise<boolean> {
  const slash = key.lastIndexOf("/");
  const parent = slash < 0 ? "" : key.slice(0, slash + 1);
  const name = key.slice(slash + 1);
  if (!(await navigateToLocationFolder({ bucket, prefix: parent }))) {
    return false;
  }
  // A newer navigation may have replaced the parent listing while it loaded.
  if (state.currentBucket !== bucket || state.currentPrefix !== parent) {
    return false;
  }
  if (revealRow(key, "file")) return true;
  if (state.prefixes.includes(`${key}/`)) {
    return navigateToLocationFolder({ bucket, prefix: `${key}/` });
  }
  setStatus(
    state.hasMore
      ? `"${name}" is not in the loaded listing. Load more to search further.`
      : `No file or folder named "${name}" in this location.`,
    5000,
  );
  return true;
}

async function navigateToLocationFolder(parsed: {
  bucket: string;
  prefix: string;
}): Promise<boolean> {
  if (
    parsed.bucket === state.currentBucket &&
    parsed.prefix === state.currentPrefix
  ) {
    syncPathInput();
    return true;
  }
  if (!(await confirmDiscardThenNavigate())) {
    syncPathInput();
    return false;
  }

  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const bucketChanged = parsed.bucket !== snapshot.currentBucket;
  closeInspectorOnMobile();
  resetFilterText();
  renderObjectTableSkeleton();

  try {
    const committed = await refreshObjects(parsed.bucket, parsed.prefix);
    if (
      !committed ||
      request !== navigationGeneration ||
      state.currentBucket !== parsed.bucket ||
      state.currentPrefix !== parsed.prefix
    ) {
      if (request === navigationGeneration) {
        renderBucketList();
        renderObjectTable();
        renderBreadcrumb();
      }
      return false;
    }
    resetSelectionForListingChange();
    pushNav(parsed.bucket, parsed.prefix, request);
    if (bucketChanged) renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    return true;
  } catch (err) {
    if (request !== navigationGeneration) return false;
    restoreListingSnapshot(snapshot);
    if (bucketChanged) renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    reportNavFailure(
      `Navigation failed: ${friendlyError(err)}`,
      () =>
        void navigateToLocationPath(
          formatLocationPath(parsed.bucket, parsed.prefix),
        ),
    );
    return false;
  }
}

interface NavEntry {
  bucket: string;
  prefix: string;
  /** Scroll offset and focused row, saved when the user leaves this view. */
  scrollTop?: number;
  focusEntry?: SelectionEntry;
}

/** Object table row that currently holds DOM focus, if any. */
function focusedObjectEntry(): SelectionEntry | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !dom.objectTbody.contains(active)) {
    return null;
  }
  const row = active.closest<HTMLElement>(".object-row");
  return row ? entryFromRow(row) : null;
}

/** Record where the user was in the current history entry before leaving it. */
function rememberCurrentView(): void {
  const current: NavEntry | undefined = navHistory[navIndex];
  if (!current) return;
  current.scrollTop = dom.objectPanel.scrollTop;
  const focused = focusedObjectEntry();
  if (focused) current.focusEntry = focused;
}

/**
 * After a listing change, keep keyboard focus in the table if it was there
 * before. The skeleton removes the focused row, so focus is re-placed on the
 * remembered row, or the first row when there is none.
 */
function restoreTableFocusAfterListing(
  hadTableFocus: boolean,
  preferred?: SelectionEntry,
): void {
  if (!hadTableFocus) return;
  if (preferred && focusObjectTableRow({ entry: preferred })) return;
  focusObjectTableRow({ logicalIndex: 0 });
}

/** Back and Forward return to the scroll offset and focused row saved then. */
function restoreRememberedView(entry: NavEntry, hadTableFocus: boolean): void {
  // A view never left before has no saved offset; start it at the top rather
  // than inheriting the scroll position of the listing we just left.
  dom.objectPanel.scrollTop = entry.scrollTop ?? 0;
  renderCurrentObjectWindow();
  restoreTableFocusAfterListing(hadTableFocus, entry.focusEntry);
}

let navHistory: NavEntry[] = [];
let navIndex = -1;
let historySuppressRequest = 0;
let navigationGeneration = 0;

interface ListingSnapshot {
  currentBucket: string;
  currentPrefix: string;
  objects: typeof state.objects;
  prefixes: typeof state.prefixes;
  continuationToken: string;
  hasMore: boolean;
}

let committedListingSnapshot: ListingSnapshot | null = null;

function captureListingSnapshot(): ListingSnapshot {
  return {
    currentBucket: state.currentBucket,
    currentPrefix: state.currentPrefix,
    objects: [...state.objects],
    prefixes: [...state.prefixes],
    continuationToken: state.continuationToken,
    hasMore: state.hasMore,
  };
}

function captureNavigationSnapshot(): ListingSnapshot {
  const current = captureListingSnapshot();
  if (!committedListingSnapshot) return current;
  const locationIsTransitional =
    current.currentBucket !== committedListingSnapshot.currentBucket ||
    current.currentPrefix !== committedListingSnapshot.currentPrefix;
  const listingWasClearedForRequest =
    current.objects.length === 0 &&
    current.prefixes.length === 0 &&
    (committedListingSnapshot.objects.length > 0 ||
      committedListingSnapshot.prefixes.length > 0);
  return locationIsTransitional || listingWasClearedForRequest
    ? committedListingSnapshot
    : current;
}

function restoreListingSnapshot(snapshot: ListingSnapshot): void {
  state.currentBucket = snapshot.currentBucket;
  state.currentPrefix = snapshot.currentPrefix;
  state.objects = [...snapshot.objects];
  state.prefixes = [...snapshot.prefixes];
  state.continuationToken = snapshot.continuationToken;
  state.hasMore = snapshot.hasMore;
}

function resetSelectionForListingChange(): void {
  clearAllSelection();
  setAnchor(null);
  updateSelectionUI();
}

function pushNav(bucket: string, prefix: string, request: number): void {
  if (request !== navigationGeneration) return;
  if (historySuppressRequest === request) return;
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push({ bucket, prefix });
  navIndex = navHistory.length - 1;
  updateNavButtons();
}

function updateNavButtons(): void {
  const backBtn = document.getElementById(
    "nav-back",
  ) as HTMLButtonElement | null;
  const fwdBtn = document.getElementById(
    "nav-forward",
  ) as HTMLButtonElement | null;
  const upBtn = document.getElementById("nav-up") as HTMLButtonElement | null;
  if (backBtn) backBtn.disabled = navIndex <= 0;
  if (fwdBtn) fwdBtn.disabled = navIndex >= navHistory.length - 1;
  if (upBtn) upBtn.disabled = !state.currentPrefix;
}

export function clearNavHistory(): void {
  navigationGeneration += 1;
  navHistory = [];
  navIndex = -1;
  historySuppressRequest = 0;
  committedListingSnapshot = null;
  updateNavButtons();
}

async function confirmDiscardThenNavigate(): Promise<boolean> {
  if (!hasUnsavedInfoChanges()) return true;
  return confirmDiscardInfoProperties();
}

export async function navigateBack(): Promise<void> {
  if (navIndex <= 0) return;
  const expectedGeneration = navigationGeneration;
  const expectedIndex = navIndex;
  if (!(await confirmDiscardThenNavigate())) return;
  if (
    navigationGeneration !== expectedGeneration ||
    navIndex !== expectedIndex ||
    navIndex <= 0
  ) {
    return;
  }
  rememberCurrentView();
  const hadTableFocus = dom.objectTbody.contains(document.activeElement);
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const targetIndex = navIndex - 1;
  const entry = navHistory[targetIndex];
  const bucketChanged = entry.bucket !== state.currentBucket;
  historySuppressRequest = request;
  resetFilterText();
  renderObjectTableSkeleton();

  try {
    const committed = await refreshObjects(entry.bucket, entry.prefix);
    if (request !== navigationGeneration) return;
    if (!committed) {
      renderBucketList();
      renderObjectTable();
      renderBreadcrumb();
      return;
    }
    navIndex = targetIndex;
    resetSelectionForListingChange();
    if (bucketChanged) renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    restoreRememberedView(entry, hadTableFocus);
  } catch (err) {
    if (request !== navigationGeneration) return;
    restoreListingSnapshot(snapshot);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    reportNavFailure(
      `Navigation failed: ${friendlyError(err)}`,
      () => void navigateBack(),
    );
  } finally {
    if (historySuppressRequest === request) {
      historySuppressRequest = 0;
    }
    updateNavButtons();
  }
}

export async function navigateForward(): Promise<void> {
  if (navIndex >= navHistory.length - 1) return;
  const expectedGeneration = navigationGeneration;
  const expectedIndex = navIndex;
  if (!(await confirmDiscardThenNavigate())) return;
  if (
    navigationGeneration !== expectedGeneration ||
    navIndex !== expectedIndex ||
    navIndex >= navHistory.length - 1
  ) {
    return;
  }
  rememberCurrentView();
  const hadTableFocus = dom.objectTbody.contains(document.activeElement);
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const targetIndex = navIndex + 1;
  const entry = navHistory[targetIndex];
  const bucketChanged = entry.bucket !== state.currentBucket;
  historySuppressRequest = request;
  resetFilterText();
  renderObjectTableSkeleton();

  try {
    const committed = await refreshObjects(entry.bucket, entry.prefix);
    if (request !== navigationGeneration) return;
    if (!committed) {
      renderBucketList();
      renderObjectTable();
      renderBreadcrumb();
      return;
    }
    navIndex = targetIndex;
    resetSelectionForListingChange();
    if (bucketChanged) renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    restoreRememberedView(entry, hadTableFocus);
  } catch (err) {
    if (request !== navigationGeneration) return;
    restoreListingSnapshot(snapshot);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    reportNavFailure(
      `Navigation failed: ${friendlyError(err)}`,
      () => void navigateForward(),
    );
  } finally {
    if (historySuppressRequest === request) {
      historySuppressRequest = 0;
    }
    updateNavButtons();
  }
}

export interface NavigateToFolderOptions {
  /** Row to focus in the new listing when focus was in the table. */
  focusEntry?: SelectionEntry;
}

export async function navigateToFolder(
  prefix: string,
  options: NavigateToFolderOptions = {},
): Promise<void> {
  if (!(await confirmDiscardThenNavigate())) return;
  rememberCurrentView();
  const hadTableFocus = dom.objectTbody.contains(document.activeElement);
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const bucket = state.currentBucket;
  closeInspectorOnMobile();
  resetFilterText();
  renderObjectTableSkeleton();
  try {
    const committed = await refreshObjects(bucket, prefix);
    if (
      !committed ||
      request !== navigationGeneration ||
      state.currentBucket !== bucket ||
      state.currentPrefix !== prefix
    ) {
      if (request === navigationGeneration) {
        renderObjectTable();
        renderBreadcrumb();
      }
      return;
    }
    resetSelectionForListingChange();
    pushNav(bucket, prefix, request);
    dom.objectPanel.scrollTop = 0;
    renderObjectTable();
    renderBreadcrumb();
    restoreTableFocusAfterListing(hadTableFocus, options.focusEntry);
  } catch (err) {
    if (request !== navigationGeneration) return;
    restoreListingSnapshot(snapshot);
    renderObjectTable();
    renderBreadcrumb();
    throw err;
  }
}

export async function navigateUp(): Promise<void> {
  if (!state.currentPrefix) return;
  const cameFrom = state.currentPrefix;
  const trimmed = cameFrom.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  const newPrefix = idx >= 0 ? trimmed.slice(0, idx + 1) : "";
  try {
    // Going up lands on the folder we left, so Backspace keeps the place.
    await navigateToFolder(newPrefix, {
      focusEntry: folderEntry(cameFrom),
    });
  } catch (err) {
    reportNavFailure(
      `Navigation failed: ${friendlyError(err)}`,
      () => void navigateUp(),
    );
  }
}

export async function selectBucket(name: string): Promise<void> {
  if (!(await confirmDiscardThenNavigate())) return;
  rememberCurrentView();
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  closeInspectorOnMobile();
  resetFilterText();
  renderObjectTableSkeleton();
  try {
    const committed = await refreshObjects(name, "");
    if (
      !committed ||
      request !== navigationGeneration ||
      state.currentBucket !== name ||
      state.currentPrefix !== ""
    ) {
      if (request === navigationGeneration) {
        renderBucketList();
        renderObjectTable();
        renderBreadcrumb();
      }
      return;
    }
    resetSelectionForListingChange();
    pushNav(name, "", request);
    dom.objectPanel.scrollTop = 0;
    writeLastBucket(name);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    if (request !== navigationGeneration) return;
    restoreListingSnapshot(snapshot);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    throw err;
  }
}

export function showEmptyState(): void {
  cancelPendingSkeleton();
  committedListingSnapshot = null;
  dom.objectPanel.style.display = "none";
  dom.objectPanel.setAttribute("aria-busy", "false");
  dom.emptyState.style.display = "";
  dom.objectTbody.innerHTML = "";
  dom.breadcrumb.innerHTML = "";
  dom.bucketList.innerHTML = "";
  const countEl = document.getElementById("statusbar-count");
  if (countEl) countEl.textContent = "";
  const pathInput = document.getElementById(
    "location-omnibar-edit",
  ) as HTMLInputElement | null;
  if (pathInput) pathInput.value = "";
  const downloadBtn = document.getElementById(
    "btn-download",
  ) as HTMLButtonElement | null;
  if (downloadBtn) downloadBtn.disabled = true;
  updateSelectionUI();
  updateNavButtons();
}

registerObjectTableRenderer(renderObjectTable);

/**
 * Make `entries` the table selection again without re-syncing the inspector.
 * The inspector still shows them with unsaved edits, and a re-sync would
 * reload them and drop those edits.
 */
function restoreSelectionEntries(entries: readonly SelectionEntry[]): void {
  clearAllSelection();
  for (const entry of entries) addSelection(entry);
  setAnchor(entries[entries.length - 1] ?? null);
  lastInspectorSelectionSignature = getInspectorSelectionSignature();
  updateSelectionUI();
}

registerSelectionRestorer(restoreSelectionEntries);

// Density changes restyle the table without re-rendering it. Re-read the
// --row-height token and rebuild the virtual window so spacers keep matching.
if (
  typeof MutationObserver !== "undefined" &&
  typeof document !== "undefined"
) {
  new MutationObserver(() => {
    const next = readObjectRowHeight();
    if (next === objectRowHeight) return;
    objectRowHeight = next;
    renderCurrentObjectWindow();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-density"],
  });
}
