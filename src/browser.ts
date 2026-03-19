import { state, dom } from "./state.ts";
import {
  escapeHtml,
  formatSize,
  formatDate,
  basename,
  twemojiIcon,
} from "./utils.ts";
import { refreshObjects } from "./connection.ts";

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

export function clearSelection(): void {
  state.selectedKeys.clear();
  updateSelectionUI();
}

export function pruneStaleSelection(): void {
  const valid = new Set(getSelectableKeys());
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
  const rows = dom.objectTbody.querySelectorAll<HTMLElement>(".object-row");
  for (const row of rows) {
    const key = row.dataset.key ?? "prefix:" + row.dataset.prefix;
    const cb = row.querySelector<HTMLInputElement>(".row-check");
    const selected = state.selectedKeys.has(key);
    row.classList.toggle("object-row--selected", selected);
    if (cb) cb.checked = selected;
  }
  const allKeys = getSelectableKeys();
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
    const count = state.selectedKeys.size;
    if (count >= 2) {
      batchCount.textContent = `${count} items selected`;
      batchToolbar.hidden = false;
    } else {
      batchToolbar.hidden = true;
    }
  }
}

let lastClickedKey: string | null = null;

export function handleRowClick(key: string, e: MouseEvent): void {
  const allKeys = getSelectableKeys();

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
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selectedKeys.has(key)) {
      state.selectedKeys.delete(key);
    } else {
      state.selectedKeys.add(key);
    }
  } else {
    state.selectedKeys.clear();
    state.selectedKeys.add(key);
  }

  lastClickedKey = key;
  updateSelectionUI();
}

export function handleSelectAll(checked: boolean): void {
  const allKeys = getSelectableKeys();
  if (checked) {
    for (const k of allKeys) state.selectedKeys.add(k);
  } else {
    state.selectedKeys.clear();
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
          ? twemojiIcon("2b06", {
              className: "twemoji-icon twemoji-icon--sort",
              decorative: true,
            })
          : twemojiIcon("2b07", {
              className: "twemoji-icon twemoji-icon--sort",
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
  if (state.buckets.length === 0) {
    el.innerHTML = `<li class="list__empty">No buckets found</li>`;
    return;
  }
  el.innerHTML = state.buckets
    .map(
      (b) =>
        `<li class="list__item${b.name === state.currentBucket ? " list__item--active" : ""}">` +
        `<button type="button" class="list__item-btn" data-bucket="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}" aria-label="Open bucket ${escapeHtml(b.name)}"${b.name === state.currentBucket ? ' aria-current="true"' : ""}>` +
        `${escapeHtml(b.name)}` +
        `</button>` +
        `</li>`,
    )
    .join("");
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
        <td class="object-name" title="${escapeHtml(name)}"><span class="icon-folder">${twemojiIcon("1f4c1", { className: "twemoji-icon twemoji-icon--inline", decorative: true })}</span><span class="object-name__text">${escapeHtml(name)}</span></td>
        <td class="object-size">&mdash;</td>
        <td class="object-modified">&mdash;</td>
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
        <td class="object-name" title="${escapeHtml(name)}"><span class="icon-file">${twemojiIcon("1f4c4", { className: "twemoji-icon twemoji-icon--inline", decorative: true })}</span><span class="object-name__text">${escapeHtml(name)}</span></td>
        <td class="object-size"${barStyle}>${formatSize(obj.size)}</td>
        <td class="object-modified">${formatDate(obj.last_modified)}</td>
      </tr>`,
    );
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No objects</td></tr>`;
  } else {
    tbody.innerHTML = rows.join("");
  }

  dom.objectPanel.style.display = "";
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
}

export async function navigateToFolder(prefix: string): Promise<void> {
  clearFilter();
  await refreshObjects(state.currentBucket, prefix);
  renderObjectTable();
  renderBreadcrumb();
}

export async function navigateUp(): Promise<void> {
  if (!state.currentPrefix) return;
  const trimmed = state.currentPrefix.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  const newPrefix = idx >= 0 ? trimmed.slice(0, idx + 1) : "";
  await navigateToFolder(newPrefix);
}

export async function selectBucket(name: string): Promise<void> {
  clearFilter();
  state.currentPrefix = "";
  await refreshObjects(name, "");
  renderBucketList();
  renderObjectTable();
  renderBreadcrumb();
}

export function showEmptyState(): void {
  dom.objectPanel.style.display = "none";
  dom.emptyState.style.display = "";
  dom.objectTbody.innerHTML = "";
  dom.breadcrumb.innerHTML = "";
  dom.bucketList.innerHTML = "";
  const countEl = document.getElementById("statusbar-count");
  if (countEl) countEl.textContent = "";
}
