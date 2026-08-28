import { state, dom } from "./state.ts";
import {
  escapeHtml,
  formatSize,
  formatDate,
  basename,
  getIconHtml,
  friendlyError,
} from "./utils.ts";
import { refreshObjects } from "./connection.ts";
import {
  closeInspectorOnMobile,
  markInspectorHasContent,
  syncInspectorFromSelection,
} from "./inspector.ts";
import {
  confirmDiscardInfoProperties,
  hasUnsavedInfoChanges,
} from "./info-panel.ts";
import { getSelectedFileKeys } from "./app-selection.ts";

function hasAccelModifier(e: MouseEvent): boolean {
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
      const el2 = document.getElementById("status");
      if (el2) el2.textContent = "";
      state.statusTimeout = undefined;
    }, autoResetMs);
  }
}

export function getSelectableKeys(): string[] {
  const keys: string[] = [];
  for (const prefix of state.prefixes) {
    keys.push("prefix:" + prefix);
  }
  for (const obj of state.objects) {
    if (obj.is_folder) continue;
    keys.push(obj.key);
  }
  return keys;
}

function getVisibleSelectableKeys(): string[] {
  const filter = state.filterText.toLowerCase();
  const keys: string[] = [];
  for (const prefix of state.prefixes) {
    if (!filter || basename(prefix).toLowerCase().includes(filter)) {
      keys.push("prefix:" + prefix);
    }
  }
  for (const obj of state.objects) {
    if (
      !obj.is_folder &&
      (!filter || basename(obj.key).toLowerCase().includes(filter))
    ) {
      keys.push(obj.key);
    }
  }
  return keys;
}

export function clearSelection(): void {
  state.selectedKeys.clear();
  updateSelectionUI();
}

export function pruneStaleSelection(): void {
  const valid = new Set(getVisibleSelectableKeys());
  for (const key of state.selectedKeys) {
    if (!valid.has(key)) {
      state.selectedKeys.delete(key);
    }
  }
}

function clearFilter(): void {
  state.filterText = "";
  const input = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  if (input) input.value = "";
}

export function updateSelectionUI(): void {
  pruneStaleSelection();

  const rows = dom.objectTbody.querySelectorAll<HTMLElement>(".object-row");
  for (const row of rows) {
    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    const cb = row.querySelector<HTMLInputElement>(".row-check");
    const selected = state.selectedKeys.has(key);
    row.classList.toggle("object-row--selected", selected);
    if (cb) cb.checked = selected;
  }
  const allKeys = getVisibleSelectableKeys();
  const selectAll = document.getElementById(
    "select-all",
  ) as HTMLInputElement | null;
  if (selectAll) {
    selectAll.checked =
      allKeys.length > 0 && allKeys.every((k) => state.selectedKeys.has(k));
    selectAll.indeterminate =
      !selectAll.checked && allKeys.some((k) => state.selectedKeys.has(k));
  }

  const batchToolbar = document.getElementById(
    "batch-toolbar",
  ) as HTMLDivElement | null;
  const batchCount = document.getElementById(
    "batch-count",
  ) as HTMLSpanElement | null;
  if (batchToolbar && batchCount) {
    const selectedFileCount = Array.from(state.selectedKeys).filter(
      (key) => !key.startsWith("prefix:"),
    ).length;
    const selectedFolderCount = Array.from(state.selectedKeys).filter((key) =>
      key.startsWith("prefix:"),
    ).length;
    const totalSelected = selectedFileCount + selectedFolderCount;
    if (totalSelected >= 1) {
      const parts: string[] = [];
      if (selectedFileCount > 0)
        parts.push(
          `${selectedFileCount} file${selectedFileCount === 1 ? "" : "s"}`,
        );
      if (selectedFolderCount > 0)
        parts.push(
          `${selectedFolderCount} folder${selectedFolderCount === 1 ? "" : "s"}`,
        );
      batchCount.textContent = `${parts.join(" + ")} selected`;
      batchToolbar.hidden = false;
    } else {
      batchToolbar.hidden = true;
    }

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
      batchDownload.disabled = !canDownloadFiles;
      batchDownload.title = canDownloadFiles
        ? `Download ${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"}`
        : hasOnlyFolders
          ? "Download applies to files only"
          : "Select files to download";
    }
    if (batchDelete) {
      batchDelete.disabled = totalSelected === 0;
      batchDelete.title =
        totalSelected > 0
          ? `Delete ${totalSelected} selected item${totalSelected === 1 ? "" : "s"}`
          : "Select items to delete";
    }
    if (batchProperties) {
      batchProperties.disabled = totalSelected === 0;
      batchProperties.title =
        totalSelected > 0
          ? `Properties for ${totalSelected} selected`
          : "Select items for properties";
    }
    if (batchCopyUrls) {
      batchCopyUrls.disabled = !canDownloadFiles;
      batchCopyUrls.title = canDownloadFiles
        ? "Copy presigned URLs for selected files"
        : "Select files to copy URLs";
    }
  }

  const downloadBtn = document.getElementById(
    "btn-download",
  ) as HTMLButtonElement | null;
  if (downloadBtn) {
    downloadBtn.disabled = getSelectedFileKeys().length === 0;
    downloadBtn.title =
      getSelectedFileKeys().length > 0
        ? `Download ${getSelectedFileKeys().length} selected file${getSelectedFileKeys().length === 1 ? "" : "s"}`
        : "Select files to download";
  }

  if (state.selectedKeys.size > 0) {
    markInspectorHasContent();
  }
  void syncInspectorFromSelection(state.selectedKeys);
}

let lastClickedKey: string | null = null;

export function setLastClickedKey(key: string | null): void {
  lastClickedKey = key;
}

export function handleRowClick(key: string, e: MouseEvent): void {
  const allKeys = getVisibleSelectableKeys();

  if (e.shiftKey && lastClickedKey) {
    const startIdx = allKeys.indexOf(lastClickedKey);
    const endIdx = allKeys.indexOf(key);
    if (startIdx >= 0 && endIdx >= 0) {
      const [from, to] =
        startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      for (let i = from; i <= to; i++) {
        state.selectedKeys.add(allKeys[i]);
      }
    }
  } else if (hasAccelModifier(e)) {
    if (state.selectedKeys.has(key)) {
      state.selectedKeys.delete(key);
    } else {
      state.selectedKeys.add(key);
    }
  } else {
    state.selectedKeys.clear();
    state.selectedKeys.add(key);
  }

  for (const row of dom.objectTbody.querySelectorAll<HTMLElement>(
    ".object-row",
  )) {
    row.tabIndex = -1;
  }
  const clickedRow = Array.from(
    dom.objectTbody.querySelectorAll<HTMLElement>(".object-row"),
  ).find(
    (row) =>
      row.dataset.key === key ||
      (key.startsWith("prefix:") &&
        row.dataset.prefix === key.slice("prefix:".length)),
  );
  if (clickedRow) clickedRow.tabIndex = 0;
  lastClickedKey = key;
  updateSelectionUI();
}

export function handleSelectAll(checked: boolean): void {
  const allKeys = getVisibleSelectableKeys();
  if (checked) {
    for (const k of allKeys) state.selectedKeys.add(k);
  } else {
    for (const k of allKeys) state.selectedKeys.delete(k);
  }
  updateSelectionUI();
}

function getSortedObjects() {
  const filter = state.filterText.toLowerCase();
  const files = state.objects.filter(
    (o) =>
      !o.is_folder &&
      (!filter || basename(o.key).toLowerCase().includes(filter)),
  );
  const col = state.sortColumn;
  const asc = state.sortAsc;

  files.sort((a, b) => {
    let cmp = 0;
    if (col === "name") {
      cmp = basename(a.key).localeCompare(basename(b.key));
    } else if (col === "size") {
      cmp = a.size - b.size;
    } else if (col === "modified") {
      cmp = a.last_modified.localeCompare(b.last_modified);
    }
    return asc ? cmp : -cmp;
  });

  return files;
}

export function toggleSort(column: "name" | "size" | "modified"): void {
  if (state.sortColumn === column) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortColumn = column;
    state.sortAsc = true;
  }
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
  el.setAttribute("aria-busy", "false");
  if (state.buckets.length === 0) {
    el.innerHTML = `<li class="list__empty">No buckets found</li>`;
    return;
  }
  const filter = state.bucketFilterText.trim().toLowerCase();
  const visibleBuckets = filter
    ? state.buckets.filter((bucket) =>
        bucket.name.toLowerCase().includes(filter),
      )
    : state.buckets;
  if (visibleBuckets.length === 0) {
    el.innerHTML = `<li class="list__empty">No buckets match filter</li>`;
    return;
  }
  const bucketIcon = getIconHtml("database", {
    className: "lucide-icon bucket-icon",
    decorative: true,
  });
  el.innerHTML = visibleBuckets
    .map(
      (b) =>
        `<li class="list__item${b.name === state.currentBucket ? " list__item--active" : ""}">` +
        `<button type="button" class="list__item-btn" data-bucket="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}" aria-label="Open bucket ${escapeHtml(b.name)}"${b.name === state.currentBucket ? ' aria-current="true"' : ""}>` +
        bucketIcon +
        `<span>${escapeHtml(b.name)}</span>` +
        `</button>` +
        `</li>`,
    )
    .join("");
}

export function renderBucketListSkeleton(rowCount = 6): void {
  const item =
    `<li class="list__item list__item--skeleton" aria-hidden="true">` +
    `<span class="skeleton skeleton--text"></span>` +
    `</li>`;
  dom.bucketList.innerHTML = item.repeat(rowCount);
  dom.bucketList.setAttribute("aria-busy", "true");
}

export function renderObjectTableSkeleton(rowCount = 8): void {
  const row =
    `<tr class="object-row object-row--skeleton" aria-hidden="true">` +
    `<td class="col-check"><span class="skeleton skeleton--check"></span></td>` +
    `<td class="object-name"><span class="skeleton skeleton--icon"></span><span class="skeleton skeleton--text"></span></td>` +
    `<td class="object-size"><span class="skeleton skeleton--text skeleton--sm"></span></td>` +
    `<td class="object-modified"><span class="skeleton skeleton--text skeleton--md"></span></td>` +
    `</tr>`;
  dom.objectTbody.innerHTML = row.repeat(rowCount);
  dom.objectPanel.style.display = "";
  dom.objectPanel.setAttribute("aria-busy", "true");
  dom.emptyState.style.display = "none";
  const loadMore = document.getElementById("load-more-row");
  if (loadMore) loadMore.style.display = "none";
}

function emptyFolderRowHtml(): string {
  return (
    `<tr><td colspan="4" class="table-empty">` +
    `<div class="table-empty__content">` +
    `${getIconHtml("folder", { className: "lucide-icon empty-state__icon", decorative: true })}` +
    `<p class="table-empty__text">This folder is empty</p>` +
    `<div class="table-empty__actions">` +
    `<button type="button" class="btn btn--sm btn--primary" data-empty-action="upload">Upload files</button>` +
    `<button type="button" class="btn btn--sm" data-empty-action="new-folder">New folder</button>` +
    `</div></div></td></tr>`
  );
}

export function renderObjectTable(): void {
  const tbody = dom.objectTbody;
  const rows: string[] = [];

  const filter = state.filterText.toLowerCase();

  const sortedPrefixes = [...state.prefixes]
    .filter((p) => !filter || basename(p).toLowerCase().includes(filter))
    .sort((a, b) => (state.sortAsc ? a.localeCompare(b) : b.localeCompare(a)));

  for (const prefix of sortedPrefixes) {
    const name = basename(prefix);
    rows.push(
      `<tr class="object-row object-row--folder" data-prefix="${escapeHtml(prefix)}" tabindex="0">
        <td class="col-check"><input type="checkbox" class="row-check" aria-label="Select folder ${escapeHtml(name)}" /></td>
        <td class="object-name" title="${escapeHtml(name)}"><span class="icon-folder">${getIconHtml("folder", { className: "lucide-icon lucide-icon--inline", decorative: true })}</span><span class="object-name__text">${escapeHtml(name)}</span></td>
        <td class="object-size object-size--folder">Folder</td>
        <td class="object-modified object-modified--muted">&mdash;</td>
      </tr>`,
    );
  }

  const sortedFiles = getSortedObjects();
  const maxSize = sortedFiles.reduce((m, o) => Math.max(m, o.size), 0);
  for (const obj of sortedFiles) {
    const name = basename(obj.key);
    const barPct = maxSize > 0 ? Math.round((obj.size / maxSize) * 100) : 0;
    const barStyle =
      barPct > 0
        ? ` style="background:linear-gradient(to right, var(--glow-accent) ${barPct}%, transparent ${barPct}%)"`
        : "";
    rows.push(
      `<tr class="object-row object-row--file" data-key="${escapeHtml(obj.key)}" tabindex="0">
        <td class="col-check"><input type="checkbox" class="row-check" aria-label="Select file ${escapeHtml(name)}" /></td>
        <td class="object-name" title="${escapeHtml(name)}"><span class="icon-file">${getIconHtml("file", { className: "lucide-icon lucide-icon--inline", decorative: true })}</span><span class="object-name__text">${escapeHtml(name)}</span></td>
        <td class="object-size"${barStyle}>${formatSize(obj.size)}</td>
        <td class="object-modified">${formatDate(obj.last_modified)}</td>
      </tr>`,
    );
  }

  if (rows.length === 0) {
    tbody.innerHTML =
      filter.length > 0
        ? `<tr><td colspan="4" class="table-empty">No objects match filter</td></tr>`
        : emptyFolderRowHtml();
  } else {
    tbody.innerHTML = rows.join("");
  }

  const renderedRows = tbody.querySelectorAll<HTMLElement>(".object-row");
  for (const row of renderedRows) row.tabIndex = -1;
  const firstRow = renderedRows[0];
  if (firstRow) firstRow.tabIndex = 0;

  dom.objectPanel.style.display = "";
  dom.objectPanel.setAttribute("aria-busy", "false");
  dom.emptyState.style.display = "none";

  updateSelectionUI();
  updateObjectCount();
  updateLoadMore();
  updateSortIndicators();
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
  if (row) row.style.display = state.hasMore ? "" : "none";
}

export function renderBreadcrumb(): void {
  const el = dom.breadcrumb;
  const parts: string[] = [];

  parts.push(
    `<button type="button" class="breadcrumb__segment breadcrumb__segment--root" data-prefix="" aria-label="Open bucket root ${escapeHtml(state.currentBucket)}">${escapeHtml(state.currentBucket)}</button>`,
  );

  if (state.currentPrefix) {
    const segments = state.currentPrefix.split("/").filter(Boolean);
    let accumulated = "";
    for (const seg of segments) {
      accumulated += seg + "/";
      parts.push(
        `<span class="breadcrumb__sep">/</span><button type="button" class="breadcrumb__segment" data-prefix="${escapeHtml(accumulated)}" title="${escapeHtml(accumulated)}" aria-label="Open folder ${escapeHtml(seg)}">${escapeHtml(seg)}</button>`,
      );
    }
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
  let prefix = input.slice(slash + 1).replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) {
    // Treat trailing path segments without slash as a folder prefix
    prefix = `${prefix}/`;
  }
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

  try {
    if (parsed.bucket !== state.currentBucket) {
      await selectBucket(parsed.bucket);
    }
    if (parsed.prefix !== state.currentPrefix) {
      await navigateToFolder(parsed.prefix);
    } else {
      syncPathInput();
    }
    return true;
  } catch (err) {
    setStatus(`Navigation failed: ${friendlyError(err)}`, 5000);
    syncPathInput();
    return false;
  }
}

interface NavEntry {
  bucket: string;
  prefix: string;
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

function restoreListingSnapshot(snapshot: ListingSnapshot): void {
  state.currentBucket = snapshot.currentBucket;
  state.currentPrefix = snapshot.currentPrefix;
  state.objects = [...snapshot.objects];
  state.prefixes = [...snapshot.prefixes];
  state.continuationToken = snapshot.continuationToken;
  state.hasMore = snapshot.hasMore;
}

function resetSelectionForListingChange(): void {
  state.selectedKeys.clear();
  lastClickedKey = null;
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
  updateNavButtons();
}

async function confirmDiscardThenNavigate(): Promise<boolean> {
  if (!hasUnsavedInfoChanges()) return true;
  return confirmDiscardInfoProperties();
}

export async function navigateBack(): Promise<void> {
  if (navIndex <= 0) return;
  if (!(await confirmDiscardThenNavigate())) return;
  const request = ++navigationGeneration;
  const snapshot = captureListingSnapshot();
  const prevIndex = navIndex;
  navIndex--;
  const entry = navHistory[navIndex];
  historySuppressRequest = request;
  clearFilter();
  resetSelectionForListingChange();
  renderObjectTableSkeleton();

  try {
    if (entry.bucket !== state.currentBucket) {
      await refreshObjects(entry.bucket, entry.prefix);
      renderBucketList();
    } else {
      await refreshObjects(entry.bucket, entry.prefix);
    }
    if (request !== navigationGeneration) return;
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    if (request !== navigationGeneration) return;
    navIndex = prevIndex;
    restoreListingSnapshot(snapshot);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    setStatus(`Navigation failed: ${friendlyError(err)}`, 5000);
  } finally {
    if (historySuppressRequest === request) {
      historySuppressRequest = 0;
    }
    updateNavButtons();
  }
}

export async function navigateForward(): Promise<void> {
  if (navIndex >= navHistory.length - 1) return;
  if (!(await confirmDiscardThenNavigate())) return;
  const request = ++navigationGeneration;
  const snapshot = captureListingSnapshot();
  const prevIndex = navIndex;
  navIndex++;
  const entry = navHistory[navIndex];
  historySuppressRequest = request;
  clearFilter();
  resetSelectionForListingChange();
  renderObjectTableSkeleton();

  try {
    if (entry.bucket !== state.currentBucket) {
      await refreshObjects(entry.bucket, entry.prefix);
      renderBucketList();
    } else {
      await refreshObjects(entry.bucket, entry.prefix);
    }
    if (request !== navigationGeneration) return;
    renderObjectTable();
    renderBreadcrumb();
  } catch (err) {
    if (request !== navigationGeneration) return;
    navIndex = prevIndex;
    restoreListingSnapshot(snapshot);
    renderBucketList();
    renderObjectTable();
    renderBreadcrumb();
    setStatus(`Navigation failed: ${friendlyError(err)}`, 5000);
  } finally {
    if (historySuppressRequest === request) {
      historySuppressRequest = 0;
    }
    updateNavButtons();
  }
}

export async function navigateToFolder(prefix: string): Promise<void> {
  if (!(await confirmDiscardThenNavigate())) return;
  const request = ++navigationGeneration;
  const snapshot = captureListingSnapshot();
  const bucket = state.currentBucket;
  closeInspectorOnMobile();
  clearFilter();
  resetSelectionForListingChange();
  renderObjectTableSkeleton();
  try {
    await refreshObjects(state.currentBucket, prefix);
    if (
      request !== navigationGeneration ||
      state.currentBucket !== bucket ||
      state.currentPrefix !== prefix
    ) {
      return;
    }
    pushNav(state.currentBucket, prefix, request);
    renderObjectTable();
    renderBreadcrumb();
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
  const trimmed = state.currentPrefix.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  const newPrefix = idx >= 0 ? trimmed.slice(0, idx + 1) : "";
  try {
    await navigateToFolder(newPrefix);
  } catch (err) {
    setStatus(`Navigation failed: ${friendlyError(err)}`, 5000);
  }
}

export async function selectBucket(name: string): Promise<void> {
  if (!(await confirmDiscardThenNavigate())) return;
  const request = ++navigationGeneration;
  const snapshot = captureListingSnapshot();
  closeInspectorOnMobile();
  clearFilter();
  resetSelectionForListingChange();
  state.currentPrefix = "";
  renderObjectTableSkeleton();
  try {
    await refreshObjects(name, "");
    if (request !== navigationGeneration || state.currentBucket !== name) {
      return;
    }
    pushNav(name, "", request);
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
  dom.objectPanel.style.display = "none";
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
  updateNavButtons();
}
