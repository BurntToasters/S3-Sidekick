import { invoke } from "@tauri-apps/api/core";
import {
  $,
  escapeHtml,
  formatSize,
  formatDate,
  basename,
  twemojiIcon,
} from "./utils.ts";
import { state } from "./state.ts";

interface HeadObjectResponse {
  content_type: string;
  content_length: number;
  last_modified: string;
  etag: string;
  storage_class: string;
  cache_control: string;
  content_disposition: string;
  content_encoding: string;
  server_side_encryption: string;
  metadata: Record<string, string>;
}

interface AclGrant {
  grantee: string;
  permission: string;
}

interface AclResponse {
  owner: string;
  grants: AclGrant[];
}

type ObjectVisibility = "private" | "public-read";
type VisibilitySelection = "unchanged" | ObjectVisibility;

let currentKey = "";
let batchKeys: string[] = [];
let headData: HeadObjectResponse | null = null;
let aclData: AclResponse | null = null;
let metadataRows: { key: string; value: string }[] = [];
let activeTab = "general";
let panelRequestToken = 0;
let metadataDirty = false;
let aclDirty = false;
let selectedVisibility: VisibilitySelection = "unchanged";
let initialSingleVisibility: ObjectVisibility | null = null;

const HEADER_SUGGESTIONS: string[] = [
  "Content-Type",
  "Cache-Control",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Expires",
];

const VALUE_SUGGESTIONS: Record<string, string[]> = {
  "Content-Type": [
    "application/json",
    "application/octet-stream",
    "application/pdf",
    "application/xml",
    "application/zip",
    "application/gzip",
    "application/javascript",
    "audio/mpeg",
    "audio/ogg",
    "font/woff2",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
    "text/css",
    "text/csv",
    "text/html",
    "text/plain",
    "video/mp4",
    "video/webm",
  ],
  "Cache-Control": [
    "no-cache",
    "no-store",
    "max-age=3600",
    "max-age=86400",
    "max-age=31536000",
    "max-age=31536000, immutable",
    "public, max-age=3600",
    "public, max-age=86400",
    "private, max-age=3600",
    "no-cache, no-store, must-revalidate",
  ],
  "Content-Disposition": ["inline", "attachment"],
  "Content-Encoding": ["gzip", "br", "deflate", "identity"],
  "Content-Language": [
    "en",
    "en-US",
    "es",
    "fr",
    "de",
    "ja",
    "zh",
    "pt",
    "ar",
    "ru",
  ],
};

function normalizeVisibility(value: string): ObjectVisibility | null {
  if (value === "private" || value === "public-read") {
    return value;
  }
  return null;
}

function deriveAclVisibility(data: AclResponse): ObjectVisibility {
  const hasPublicRead = data.grants.some((grant) => {
    const permission = grant.permission.trim().toUpperCase();
    if (permission !== "READ") return false;
    const grantee = grant.grantee.toLowerCase();
    return grantee.includes("allusers") || grantee.includes("/global/allusers");
  });
  return hasPublicRead ? "public-read" : "private";
}

function resetEditorState(): void {
  metadataDirty = false;
  aclDirty = false;
  selectedVisibility = "unchanged";
  initialSingleVisibility = null;
}

export async function openInfoPanel(keys: string[]): Promise<void> {
  const overlay = $("info-overlay");
  const title = $("info-title");
  const saveBtn = $<HTMLButtonElement>("info-save");
  saveBtn.textContent = "Save";

  if (keys.length > 1) {
    panelRequestToken += 1;
    currentKey = "";
    batchKeys = keys.filter((k) => !k.startsWith("prefix:"));
    metadataRows = [{ key: "", value: "" }];
    headData = null;
    aclData = null;
    resetEditorState();

    if (batchKeys.length === 0) {
      title.textContent = `${keys.length} items selected`;
      overlay.classList.add("active");
      saveBtn.style.display = "none";
      setTabsVisible(false);
      const body = $("info-body");
      body.innerHTML =
        `<div class="metadata-batch-info">` +
        `<p>Selected ${keys.length} folder(s). Properties editing applies to files only.</p>` +
        `</div>`;
      return;
    }

    title.textContent = `${batchKeys.length} items selected`;
    overlay.classList.add("active");
    saveBtn.style.display = "";
    saveBtn.disabled = false;
    setTabsVisible(false);
    renderBatchView($("info-body"), batchKeys);
    return;
  }

  batchKeys = [];

  const requestToken = ++panelRequestToken;
  currentKey = keys[0];
  const selectedKey = currentKey;
  title.textContent = basename(currentKey);
  overlay.classList.add("active");
  saveBtn.style.display = "";
  saveBtn.disabled = true;
  setTabsVisible(true);
  activeTab = "general";
  updateTabUI();

  headData = null;
  aclData = null;
  metadataRows = [];
  resetEditorState();

  const body = $("info-body");
  body.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading&#8230;</div>`;

  try {
    const nextHeadData = await invoke<HeadObjectResponse>("head_object", {
      bucket: state.currentBucket,
      key: selectedKey,
    });
    if (requestToken !== panelRequestToken || currentKey !== selectedKey) {
      return;
    }
    headData = nextHeadData;

    metadataRows = [{ key: "Content-Type", value: headData.content_type }];
    for (const [k, v] of Object.entries(headData.metadata)) {
      metadataRows.push({ key: k, value: v });
    }

    saveBtn.disabled = false;
    renderTab();
  } catch (err) {
    if (requestToken !== panelRequestToken || currentKey !== selectedKey) {
      return;
    }
    body.innerHTML = `<div class="metadata-loading">Failed to load: ${escapeHtml(String(err))}</div>`;
  }
}

function setTabsVisible(visible: boolean): void {
  const tabs = document.querySelector(".info-tabs") as HTMLElement | null;
  if (tabs) tabs.style.display = visible ? "" : "none";
}

function updateTabUI(): void {
  const tabs = document.querySelectorAll<HTMLElement>(".info-tab");
  for (const tab of tabs) {
    const isActive = tab.dataset.tab === activeTab;
    tab.classList.toggle("info-tab--active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
  }
}

export function switchTab(tab: string): void {
  activeTab = tab;
  updateTabUI();
  renderTab();
}

function renderTab(): void {
  if (!headData) return;
  const body = $("info-body");

  if (activeTab === "general") {
    renderGeneral(body);
  } else if (activeTab === "permissions") {
    void renderPermissions(body);
  } else if (activeTab === "metadata") {
    renderMetadata(body);
  } else if (activeTab === "s3") {
    renderS3(body);
  }
}

function renderGeneral(body: HTMLElement): void {
  if (!headData) return;

  body.innerHTML = [
    infoRow("Name", basename(currentKey)),
    infoRow("Path", currentKey),
    infoRow("Size", formatSize(headData.content_length)),
    infoRow("Content Type", headData.content_type),
    infoRow("Last Modified", formatDate(headData.last_modified)),
    infoRow("ETag", headData.etag, true),
    headData.cache_control
      ? infoRow("Cache-Control", headData.cache_control)
      : "",
    headData.content_disposition
      ? infoRow("Content-Disposition", headData.content_disposition)
      : "",
    headData.content_encoding
      ? infoRow("Content-Encoding", headData.content_encoding)
      : "",
  ]
    .filter(Boolean)
    .join("");

  void buildUrlAsync(body, currentKey, panelRequestToken);
}

async function buildUrlAsync(
  body: HTMLElement,
  expectedKey: string,
  requestToken: number,
): Promise<void> {
  try {
    const url = await invoke<string>("build_object_url", {
      bucket: state.currentBucket,
      key: expectedKey,
    });
    if (
      requestToken === panelRequestToken &&
      activeTab === "general" &&
      currentKey === expectedKey &&
      url
    ) {
      const urlRow = document.createElement("div");
      urlRow.className = "metadata-info-row";
      urlRow.innerHTML =
        `<span class="metadata-label">URL</span>` +
        `<span class="metadata-value-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>`;
      body.appendChild(urlRow);
    }
  } catch {
    return;
  }
}

async function renderPermissions(body: HTMLElement): Promise<void> {
  const requestToken = panelRequestToken;
  const selectedKey = currentKey;
  body.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading permissions&#8230;</div>`;

  if (!aclData) {
    try {
      const nextAclData = await invoke<AclResponse>("get_object_acl", {
        bucket: state.currentBucket,
        key: selectedKey,
      });
      if (
        requestToken !== panelRequestToken ||
        currentKey !== selectedKey ||
        activeTab !== "permissions"
      ) {
        return;
      }
      aclData = nextAclData;
    } catch (err) {
      if (
        requestToken !== panelRequestToken ||
        currentKey !== selectedKey ||
        activeTab !== "permissions"
      ) {
        return;
      }
      body.innerHTML = `<div class="metadata-loading">Failed to load permissions: ${escapeHtml(String(err))}</div>`;
      return;
    }
  }

  const currentVisibility = deriveAclVisibility(aclData);
  if (initialSingleVisibility === null) {
    initialSingleVisibility = currentVisibility;
    if (selectedVisibility === "unchanged") {
      selectedVisibility = currentVisibility;
    }
  }

  let html = infoRow("Owner", aclData.owner || "N/A");
  html += `<div class="setting-section">Visibility</div>`;
  html +=
    `<div class="metadata-permissions-editor">` +
    `<label for="permissions-visibility" class="metadata-label">Access</label>` +
    `<select id="permissions-visibility" class="field metadata-visibility-select">` +
    `<option value="private">Private</option>` +
    `<option value="public-read">Public (read-only)</option>` +
    `</select>` +
    `<p class="metadata-batch-hint">Public allows anonymous read access to this object.</p>` +
    `</div>`;

  if (aclData.grants.length > 0) {
    html += `<div class="setting-section">Grants</div>`;
    html += `<table class="acl-table">`;
    html += `<thead><tr><th>Grantee</th><th>Permission</th></tr></thead><tbody>`;
    for (const g of aclData.grants) {
      html += `<tr><td>${escapeHtml(g.grantee)}</td><td>${escapeHtml(g.permission)}</td></tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<div class="metadata-loading">No ACL grants found.</div>`;
  }

  body.innerHTML = html;

  const visibilitySelect = body.querySelector<HTMLSelectElement>(
    "#permissions-visibility",
  );
  if (!visibilitySelect || !initialSingleVisibility) {
    return;
  }

  const effectiveSelection =
    selectedVisibility === "unchanged"
      ? initialSingleVisibility
      : selectedVisibility;
  visibilitySelect.value = effectiveSelection;
  aclDirty = effectiveSelection !== initialSingleVisibility;

  visibilitySelect.addEventListener("change", () => {
    const next = normalizeVisibility(visibilitySelect.value);
    if (!next || !initialSingleVisibility) return;
    selectedVisibility = next;
    aclDirty = next !== initialSingleVisibility;
  });
}

function renderBatchView(body: HTMLElement, keys: string[]): void {
  const listItems = keys
    .map((k) => `<li>${escapeHtml(basename(k))}</li>`)
    .join("");
  body.innerHTML =
    `<div class="metadata-batch-info">` +
    `<p>Selected ${keys.length} file(s):</p>` +
    `<ul class="metadata-batch-list">${listItems}</ul>` +
    `</div>` +
    `<div class="setting-section">Permissions</div>` +
    `<div class="metadata-permissions-editor">` +
    `<label for="batch-visibility" class="metadata-label">Access</label>` +
    `<select id="batch-visibility" class="field metadata-visibility-select">` +
    `<option value="unchanged">Keep unchanged</option>` +
    `<option value="private">Set Private</option>` +
    `<option value="public-read">Set Public (read-only)</option>` +
    `</select>` +
    `<p class="metadata-batch-hint">Use this to set all selected files to private or publicly readable.</p>` +
    `</div>` +
    `<div class="setting-section">Metadata</div>` +
    `<p class="metadata-batch-hint">Headers below will be merged into each file's existing metadata.</p>` +
    `<div id="metadata-entries"></div>` +
    `<button id="metadata-add-row" class="btn btn--ghost metadata-add-btn">+ Add header</button>`;

  const visibilitySelect =
    body.querySelector<HTMLSelectElement>("#batch-visibility");
  if (visibilitySelect) {
    visibilitySelect.value = selectedVisibility;
    visibilitySelect.addEventListener("change", () => {
      const next = visibilitySelect.value;
      if (
        next === "unchanged" ||
        next === "private" ||
        next === "public-read"
      ) {
        selectedVisibility = next;
      } else {
        selectedVisibility = "unchanged";
      }
      aclDirty = selectedVisibility !== "unchanged";
    });
  }

  renderEntryRows();
  const addRowBtn = body.querySelector<HTMLButtonElement>("#metadata-add-row");
  if (addRowBtn) {
    addRowBtn.addEventListener("click", () => {
      metadataRows.push({ key: "", value: "" });
      metadataDirty = true;
      renderEntryRows();
    });
  }
}

function renderMetadata(body: HTMLElement): void {
  let html = `<div id="metadata-entries"></div>`;
  html += `<button id="metadata-add-row" class="btn btn--ghost metadata-add-btn">+ Add header</button>`;
  body.innerHTML = html;
  renderEntryRows();
  const addRowBtn = body.querySelector<HTMLButtonElement>("#metadata-add-row");
  if (addRowBtn) {
    addRowBtn.addEventListener("click", () => {
      metadataRows.push({ key: "", value: "" });
      metadataDirty = true;
      renderEntryRows();
    });
  }
}

function buildValueDatalist(
  id: string,
  headerName: string,
): HTMLDataListElement {
  const datalist = document.createElement("datalist");
  datalist.id = id;
  const suggestions = VALUE_SUGGESTIONS[headerName] ?? [];
  for (const s of suggestions) {
    const opt = document.createElement("option");
    opt.value = s;
    datalist.appendChild(opt);
  }
  return datalist;
}

function renderEntryRows(): void {
  const container = $("metadata-entries");
  container.innerHTML = "";
  const isBatch = batchKeys.length > 0;

  const keyDatalist = document.createElement("datalist");
  keyDatalist.id = "metadata-header-names";
  for (const name of HEADER_SUGGESTIONS) {
    const opt = document.createElement("option");
    opt.value = name;
    keyDatalist.appendChild(opt);
  }
  container.appendChild(keyDatalist);

  for (let i = 0; i < metadataRows.length; i++) {
    const row = document.createElement("div");
    row.className = "metadata-entry";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "field metadata-entry__key";
    keyInput.value = metadataRows[i].key;
    keyInput.placeholder = "Header name";
    keyInput.readOnly = !isBatch && i === 0;
    if (!keyInput.readOnly) {
      keyInput.setAttribute("list", "metadata-header-names");
    }

    const valDatalistId = `metadata-val-${i}`;
    const valDatalist = buildValueDatalist(valDatalistId, metadataRows[i].key);
    container.appendChild(valDatalist);

    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "field metadata-entry__value";
    valInput.value = metadataRows[i].value;
    valInput.placeholder = "Value";
    valInput.setAttribute("list", valDatalistId);

    keyInput.addEventListener("input", () => {
      metadataRows[i].key = keyInput.value;
      metadataDirty = true;
      const newDatalist = buildValueDatalist(valDatalistId, keyInput.value);
      const old = document.getElementById(valDatalistId);
      if (old) old.replaceWith(newDatalist);
    });

    valInput.addEventListener("input", () => {
      metadataRows[i].value = valInput.value;
      metadataDirty = true;
    });

    row.appendChild(keyInput);
    row.appendChild(valInput);

    if (isBatch || i > 0) {
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn--icon metadata-entry__delete";
      delBtn.innerHTML = twemojiIcon("274c", { decorative: true });
      delBtn.title = "Remove";
      delBtn.setAttribute("aria-label", "Remove metadata row");
      delBtn.addEventListener("click", () => {
        metadataRows.splice(i, 1);
        metadataDirty = true;
        renderEntryRows();
      });
      row.appendChild(delBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.style.width = "30px";
      spacer.style.flexShrink = "0";
      row.appendChild(spacer);
    }

    container.appendChild(row);
  }
}

function renderS3(body: HTMLElement): void {
  if (!headData) return;
  body.innerHTML = [
    infoRow("Storage Class", headData.storage_class || "STANDARD"),
    infoRow(
      "Server-Side Encryption",
      headData.server_side_encryption || "None",
    ),
    infoRow("ETag", headData.etag, true),
  ].join("");
}

function infoRow(label: string, value: string, mono = false): string {
  const cls = mono ? "metadata-value-mono" : "";
  return (
    `<div class="metadata-info-row">` +
    `<span class="metadata-label">${escapeHtml(label)}</span>` +
    `<span class="${cls}">${escapeHtml(value)}</span>` +
    `</div>`
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function collectSingleMetadata(): {
  contentType: string;
  metadata: Record<string, string>;
} {
  const contentType =
    metadataRows.length > 0
      ? metadataRows[0].value
      : "application/octet-stream";
  const customMeta: Record<string, string> = {};
  for (let i = 1; i < metadataRows.length; i++) {
    const k = metadataRows[i].key.trim();
    const v = metadataRows[i].value;
    if (k) customMeta[k] = v;
  }
  return { contentType, metadata: customMeta };
}

function collectBatchMetadata(): Record<string, string> {
  const newMeta: Record<string, string> = {};
  for (const row of metadataRows) {
    const k = row.key.trim();
    if (k) newMeta[k] = row.value;
  }
  return newMeta;
}

export async function saveInfoPanel(): Promise<void> {
  if (batchKeys.length > 0) {
    await saveBatchChanges();
    return;
  }
  await saveSingleChanges();
}

async function saveSingleChanges(): Promise<void> {
  const selectedKey = currentKey;
  if (!selectedKey) return;

  const requestedVisibility = normalizeVisibility(selectedVisibility);
  const shouldApplyAcl =
    aclDirty &&
    requestedVisibility !== null &&
    initialSingleVisibility !== null;
  const shouldApplyMetadata = metadataDirty;

  if (!shouldApplyAcl && !shouldApplyMetadata) {
    setStatus("No property changes to apply.", 3000);
    return;
  }

  const saveBtn = $<HTMLButtonElement>("info-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving\u2026";

  let metadataError: string | null = null;
  let aclError: string | null = null;

  if (shouldApplyMetadata) {
    try {
      const payload = collectSingleMetadata();
      await invoke("update_metadata", {
        bucket: state.currentBucket,
        key: selectedKey,
        contentType: payload.contentType,
        metadata: payload.metadata,
      });
    } catch (err) {
      metadataError = errorText(err);
    }
  }

  if (shouldApplyAcl && requestedVisibility) {
    try {
      await invoke("set_object_acl", {
        bucket: state.currentBucket,
        key: selectedKey,
        visibility: requestedVisibility,
      });
    } catch (err) {
      aclError = errorText(err);
    }
  }

  saveBtn.disabled = false;
  saveBtn.textContent = "Save";

  if (!metadataError && !aclError) {
    closeInfoPanel();
    if (shouldApplyMetadata && shouldApplyAcl) {
      setStatus("Properties updated.", 5000);
    } else if (shouldApplyAcl) {
      setStatus("Permissions updated.", 5000);
    } else {
      setStatus("Metadata updated.", 5000);
    }
    return;
  }

  if (metadataError && aclError) {
    setStatus(
      `Failed to update properties: metadata (${metadataError}); permissions (${aclError})`,
    );
    return;
  }

  if (metadataError) {
    setStatus(`Failed to update metadata: ${metadataError}`);
    return;
  }

  setStatus(`Failed to update permissions: ${aclError ?? "Unknown error"}`);
}

async function saveBatchChanges(): Promise<void> {
  const requestedVisibility = normalizeVisibility(selectedVisibility);
  const shouldApplyAcl = aclDirty && requestedVisibility !== null;

  const newMeta = collectBatchMetadata();
  const shouldApplyMetadata = metadataDirty && Object.keys(newMeta).length > 0;

  if (metadataDirty && !shouldApplyMetadata && !shouldApplyAcl) {
    setStatus("Add at least one metadata header to apply.");
    return;
  }

  if (!shouldApplyMetadata && !shouldApplyAcl) {
    setStatus("No property changes to apply.", 3000);
    return;
  }

  const saveBtn = $<HTMLButtonElement>("info-save");
  saveBtn.disabled = true;
  let succeeded = 0;
  let failed = 0;
  let partial = 0;

  const BATCH_CONCURRENCY = 6;
  let processed = 0;

  for (let i = 0; i < batchKeys.length; i += BATCH_CONCURRENCY) {
    const chunk = batchKeys.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (key) => {
        let metadataFailed = false;
        let aclFailed = false;

        if (shouldApplyMetadata) {
          try {
            const head = await invoke<HeadObjectResponse>("head_object", {
              bucket: state.currentBucket,
              key,
            });
            const merged: Record<string, string> = {
              ...head.metadata,
              ...newMeta,
            };
            await invoke("update_metadata", {
              bucket: state.currentBucket,
              key,
              contentType: head.content_type,
              metadata: merged,
            });
          } catch {
            metadataFailed = true;
          }
        }

        if (shouldApplyAcl && requestedVisibility) {
          try {
            await invoke("set_object_acl", {
              bucket: state.currentBucket,
              key,
              visibility: requestedVisibility,
            });
          } catch {
            aclFailed = true;
          }
        }

        return { metadataFailed, aclFailed };
      }),
    );

    for (const result of results) {
      processed++;
      saveBtn.textContent = `Saving ${processed}/${batchKeys.length}\u2026`;
      if (result.status === "rejected") {
        failed++;
      } else {
        const { metadataFailed, aclFailed } = result.value;
        if (metadataFailed || aclFailed) {
          failed++;
          if (
            shouldApplyMetadata &&
            shouldApplyAcl &&
            metadataFailed !== aclFailed
          ) {
            partial++;
          }
        } else {
          succeeded++;
        }
      }
    }
  }

  saveBtn.disabled = false;
  saveBtn.textContent = "Save";

  const actionLabel =
    shouldApplyMetadata && shouldApplyAcl
      ? "properties"
      : shouldApplyAcl
        ? "permissions"
        : "metadata";

  if (failed === 0) {
    closeInfoPanel();
    setStatus(
      `${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} updated on ${succeeded} file(s).`,
      5000,
    );
  } else {
    const partialSuffix =
      shouldApplyMetadata && shouldApplyAcl && partial > 0
        ? ` (${partial} partial)`
        : "";
    setStatus(
      `${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} updated on ${succeeded} file(s), ${failed} failed${partialSuffix}.`,
    );
  }
}

export function closeInfoPanel(): void {
  panelRequestToken += 1;
  $("info-overlay").classList.remove("active");
  headData = null;
  aclData = null;
  metadataRows = [];
  currentKey = "";
  batchKeys = [];
  resetEditorState();
  const saveBtn = document.getElementById(
    "info-save",
  ) as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
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
