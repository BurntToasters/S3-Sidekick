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

const OBJECT_ROW_HEIGHT = 36;
const OBJECT_VIRTUALIZE_THRESHOLD = 250;
const OBJECT_VIRTUAL_OVERSCAN = 8;
const OBJECT_VIRTUAL_FALLBACK_VIEWPORT = 600;

let lastInspectorSelectionSignature: string | null = null;

function getInspectorSelectionSignature(): string {
  const selectedKeys = Array.from(state.selectedKeys).sort();
  const objectRevisions = new Map(
    state.objects
      .filter((object) => !object.is_folder)
      .map(
        (object) =>
          [object.key, `${object.size}:${object.last_modified}`] as const,
      ),
  );
  const selectedRevisions = selectedKeys.map((key) =>
    key.startsWith("prefix:")
      ? key
      : `${key}:${objectRevisions.get(key) ?? "missing"}`,
  );
  return JSON.stringify([
    state.connectionIdentity,
    state.connectionId,
    state.currentBucket,
    state.currentPrefix,
    selectedRevisions,
  ]);
}

function syncInspectorForSemanticSelectionChange(): void {
  const signature = getInspectorSelectionSignature();
  if (signature === lastInspectorSelectionSignature) return;
  lastInspectorSelectionSignature = signature;
  void syncInspectorFromSelection(new Set(state.selectedKeys));
}

export function invalidateInspectorSelectionSync(): void {
  lastInspectorSelectionSignature = null;
}

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

export function pruneStaleSelection(validKeys?: readonly string[]): void {
  const valid = new Set(validKeys ?? getVisibleSelectableKeys());
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
  const allKeys = getVisibleSelectableKeys();
  pruneStaleSelection(allKeys);

  const rows = dom.objectTbody.querySelectorAll<HTMLElement>(".object-row");
  for (const row of rows) {
    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    const cb = row.querySelector<HTMLInputElement>(".row-check");
    const selected = state.selectedKeys.has(key);
    row.classList.toggle("object-row--selected", selected);
    if (cb) cb.checked = selected;
  }

  let visibleSelectedCount = 0;
  for (const key of allKeys) {
    if (state.selectedKeys.has(key)) visibleSelectedCount += 1;
  }
  const selectAll = document.getElementById(
    "select-all",
  ) as HTMLInputElement | null;
  if (selectAll) {
    selectAll.checked =
      allKeys.length > 0 && visibleSelectedCount === allKeys.length;
    selectAll.indeterminate =
      visibleSelectedCount > 0 && visibleSelectedCount < allKeys.length;
  }

  const selectedFileCount = getSelectedFileKeys().length;
  const totalSelected = state.selectedKeys.size;
  const selectedFolderCount = totalSelected - selectedFileCount;
  const batchToolbar = document.getElementById(
    "batch-toolbar",
  ) as HTMLDivElement | null;
  const batchCount = document.getElementById(
    "batch-count",
  ) as HTMLSpanElement | null;
  if (batchToolbar && batchCount) {
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
      const deleteInFlight = batchDelete.dataset.operationInFlight === "true";
      batchDelete.disabled = totalSelected === 0 || deleteInFlight;
      batchDelete.title = deleteInFlight
        ? "Delete in progress"
        : totalSelected > 0
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
    downloadBtn.disabled = selectedFileCount === 0;
    downloadBtn.title =
      selectedFileCount > 0
        ? `Download ${selectedFileCount} selected file${selectedFileCount === 1 ? "" : "s"}`
        : "Select files to download";
  }

  if (totalSelected > 0) {
    markInspectorHasContent();
  }
  syncInspectorForSemanticSelectionChange();
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
  rowHeight = OBJECT_ROW_HEIGHT,
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
let renderedTableMaxSize = 0;
let objectPanelListenerTarget: HTMLElement | null = null;
let virtualRenderScheduled = false;

function createObjectRow(): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.innerHTML = `<td class="col-check"><input type="checkbox" class="row-check" /></td>
    <td class="object-name"><span class="object-kind-icon"></span><span class="object-name__text"></span></td>
    <td class="object-size"></td>
    <td class="object-modified"></td>`;
  return row;
}

function updateObjectRow(
  row: HTMLTableRowElement,
  entry: ObjectTableEntry,
  maxSize: number,
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
  const semanticKey =
    entry.kind === "folder" ? `prefix:${entry.key}` : entry.key;

  if (checkbox) {
    checkbox.setAttribute("aria-label", `Select ${entry.kind} ${entry.name}`);
    checkbox.checked = state.selectedKeys.has(semanticKey);
  }
  row.classList.toggle(
    "object-row--selected",
    state.selectedKeys.has(semanticKey),
  );
  if (nameCell) nameCell.title = entry.name;
  if (nameText) nameText.textContent = entry.name;
  if (icon) {
    icon.className = `object-kind-icon icon-${entry.kind}`;
    icon.innerHTML = getIconHtml(entry.kind === "folder" ? "folder" : "file", {
      className: "lucide-icon lucide-icon--inline",
      decorative: true,
    });
  }
  if (sizeCell) {
    sizeCell.className =
      entry.kind === "folder"
        ? "object-size object-size--folder"
        : "object-size";
    sizeCell.textContent =
      entry.kind === "folder" ? "Folder" : formatSize(entry.size);
    const barPct =
      entry.kind === "file" && maxSize > 0
        ? Math.round((entry.size / maxSize) * 100)
        : 0;
    sizeCell.style.background =
      barPct > 0
        ? `linear-gradient(to right, var(--glow-accent) ${barPct}%, transparent ${barPct}%)`
        : "";
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

function renderCurrentObjectWindow(): void {
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
        panel.scrollTop,
        viewportHeight,
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
      createVirtualSpacer(range.start * OBJECT_ROW_HEIGHT, "top"),
    );
  }

  let rovingAssigned = false;
  for (let index = range.start; index < range.end; index += 1) {
    const entry = entries[index];
    const row = existingRows.get(entry.id) ?? createObjectRow();
    updateObjectRow(row, entry, renderedTableMaxSize, index);
    const isRoving = entry.id === rovingRowId;
    row.tabIndex = isRoving ? 0 : -1;
    rovingAssigned ||= isRoving;
    fragment.appendChild(row);
  }

  if (virtualized && range.end < entries.length) {
    fragment.appendChild(
      createVirtualSpacer(
        (entries.length - range.end) * OBJECT_ROW_HEIGHT,
        "bottom",
      ),
    );
  }

  tbody.replaceChildren(fragment);
  const mountedRows =
    tbody.querySelectorAll<HTMLTableRowElement>(".object-row");
  if (!rovingAssigned && mountedRows[0]) mountedRows[0].tabIndex = 0;
  if (activeRowId) {
    const restored = Array.from(mountedRows).find(
      (row) => row.dataset.rowId === activeRowId,
    );
    const previousIndex = entries.findIndex(
      (entry) => entry.id === activeRowId,
    );
    const nearestMounted =
      previousIndex >= range.end
        ? mountedRows[mountedRows.length - 1]
        : mountedRows[0];
    const focusTarget = restored ?? nearestMounted;
    if (focusTarget) {
      for (const row of mountedRows) row.tabIndex = -1;
      focusTarget.tabIndex = 0;
      focusTarget.focus({ preventScroll: true });
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

function handleVirtualTableKeydown(event: KeyboardEvent): void {
  if (renderedTableEntries.length < OBJECT_VIRTUALIZE_THRESHOLD) return;
  if (
    !(["ArrowDown", "ArrowUp", "Home", "End"] as string[]).includes(event.key)
  ) {
    return;
  }
  const target = event.target as HTMLElement;
  if (target.closest(".row-check")) return;
  const row = target.closest<HTMLElement>(".object-row");
  if (!row) return;
  const currentIndex = Number.parseInt(row.dataset.logicalIndex ?? "", 10);
  if (!Number.isInteger(currentIndex)) return;

  let nextIndex = currentIndex;
  if (event.key === "ArrowDown") nextIndex += 1;
  if (event.key === "ArrowUp") nextIndex -= 1;
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
  const panel = dom.objectPanel;
  const viewportHeight =
    panel.clientHeight > 0
      ? panel.clientHeight
      : OBJECT_VIRTUAL_FALLBACK_VIEWPORT;
  if (nextIndex * OBJECT_ROW_HEIGHT < panel.scrollTop) {
    panel.scrollTop = nextIndex * OBJECT_ROW_HEIGHT;
  } else if (
    (nextIndex + 1) * OBJECT_ROW_HEIGHT >
    panel.scrollTop + viewportHeight
  ) {
    panel.scrollTop = (nextIndex + 1) * OBJECT_ROW_HEIGHT - viewportHeight;
  }
  renderCurrentObjectWindow();
  tbodyRowAtLogicalIndex(nextIndex)?.focus();
}

function tbodyRowAtLogicalIndex(index: number): HTMLElement | null {
  return dom.objectTbody.querySelector<HTMLElement>(
    `.object-row[data-logical-index="${index}"]`,
  );
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
  dom.objectTbody.addEventListener("keydown", handleVirtualTableKeydown, true);
}

export function renderObjectTable(): void {
  const tbody = dom.objectTbody;
  const filter = state.filterText.toLowerCase();
  const sortedPrefixes = [...state.prefixes]
    .filter(
      (prefix) => !filter || basename(prefix).toLowerCase().includes(filter),
    )
    .sort((a, b) => (state.sortAsc ? a.localeCompare(b) : b.localeCompare(a)));
  const sortedFiles = getSortedObjects();

  renderedTableEntries = [
    ...sortedPrefixes.map((prefix): ObjectTableEntry => ({
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
  renderedTableMaxSize = sortedFiles.reduce(
    (max, object) => Math.max(max, object.size),
    0,
  );

  const table = tbody.closest("table");
  table?.setAttribute("aria-rowcount", String(renderedTableEntries.length + 1));
  if (renderedTableEntries.length === 0) {
    tbody.innerHTML =
      filter.length > 0
        ? `<tr><td colspan="4" class="table-empty">No objects match filter</td></tr>`
        : emptyFolderRowHtml();
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
  clearFilter();
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
    setStatus(`Navigation failed: ${friendlyError(err)}`, 5000);
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
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const targetIndex = navIndex - 1;
  const entry = navHistory[targetIndex];
  const bucketChanged = entry.bucket !== state.currentBucket;
  historySuppressRequest = request;
  clearFilter();
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
  } catch (err) {
    if (request !== navigationGeneration) return;
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
  const request = ++navigationGeneration;
  const snapshot = captureNavigationSnapshot();
  const targetIndex = navIndex + 1;
  const entry = navHistory[targetIndex];
  const bucketChanged = entry.bucket !== state.currentBucket;
  historySuppressRequest = request;
  clearFilter();
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
  } catch (err) {
    if (request !== navigationGeneration) return;
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
  const snapshot = captureNavigationSnapshot();
  const bucket = state.currentBucket;
  closeInspectorOnMobile();
  clearFilter();
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
  const snapshot = captureNavigationSnapshot();
  closeInspectorOnMobile();
  clearFilter();
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
  committedListingSnapshot = null;
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
