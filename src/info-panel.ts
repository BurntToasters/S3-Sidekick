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

let currentKey = "";
let headData: HeadObjectResponse | null = null;
let aclData: AclResponse | null = null;
let metadataRows: { key: string; value: string }[] = [];
let activeTab = "general";
let panelRequestToken = 0;

export async function openInfoPanel(keys: string[]): Promise<void> {
  const overlay = $("info-overlay");
  const title = $("info-title");
  const saveBtn = $<HTMLButtonElement>("info-save");

  if (keys.length > 1) {
    panelRequestToken += 1;
    currentKey = "";
    title.textContent = `${keys.length} items selected`;
    overlay.classList.add("active");
    saveBtn.style.display = "none";
    setTabsVisible(false);
    const body = $("info-body");
    const listItems = keys
      .map((k) => `<li>${escapeHtml(basename(k))}</li>`)
      .join("");
    body.innerHTML =
      `<div class="metadata-batch-info">` +
      `<p>Selected ${keys.length} items:</p>` +
      `<ul class="metadata-batch-list">${listItems}</ul>` +
      `</div>`;
    return;
  }

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

  const body = $("info-body");
  body.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading&#8230;</div>`;

  try {
    const nextHeadData = await invoke<HeadObjectResponse>("head_object", {
      bucket: state.currentBucket,
      key: selectedKey,
    });
    if (requestToken !== panelRequestToken || currentKey !== selectedKey)
      return;
    headData = nextHeadData;

    metadataRows = [{ key: "Content-Type", value: headData.content_type }];
    for (const [k, v] of Object.entries(headData.metadata)) {
      metadataRows.push({ key: k, value: v });
    }

    saveBtn.disabled = false;
    renderTab();
  } catch (err) {
    if (requestToken !== panelRequestToken || currentKey !== selectedKey)
      return;
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
    renderPermissions(body);
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
    /* ignore */
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

  let html = infoRow("Owner", aclData.owner || "N/A");

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
}

function renderMetadata(body: HTMLElement): void {
  let html = `<div id="metadata-entries"></div>`;
  html += `<button id="metadata-add-row" class="btn btn--ghost metadata-add-btn">+ Add header</button>`;
  body.innerHTML = html;
  renderEntryRows();
  $("metadata-add-row").addEventListener("click", () => {
    metadataRows.push({ key: "", value: "" });
    renderEntryRows();
  });
}

function renderEntryRows(): void {
  const container = $("metadata-entries");
  container.innerHTML = "";

  for (let i = 0; i < metadataRows.length; i++) {
    const row = document.createElement("div");
    row.className = "metadata-entry";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "field metadata-entry__key";
    keyInput.value = metadataRows[i].key;
    keyInput.placeholder = "Header name";
    keyInput.readOnly = i === 0;
    keyInput.addEventListener("input", () => {
      metadataRows[i].key = keyInput.value;
    });

    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "field metadata-entry__value";
    valInput.value = metadataRows[i].value;
    valInput.placeholder = "Value";
    valInput.addEventListener("input", () => {
      metadataRows[i].value = valInput.value;
    });

    row.appendChild(keyInput);
    row.appendChild(valInput);

    if (i > 0) {
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn--icon metadata-entry__delete";
      delBtn.innerHTML = twemojiIcon("274c", { decorative: true });
      delBtn.title = "Remove";
      delBtn.setAttribute("aria-label", "Remove metadata row");
      delBtn.addEventListener("click", () => {
        metadataRows.splice(i, 1);
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

export async function saveInfoPanel(): Promise<void> {
  const selectedKey = currentKey;
  if (!selectedKey) return;

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

  const saveBtn = $<HTMLButtonElement>("info-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving\u2026";

  try {
    await invoke("update_metadata", {
      bucket: state.currentBucket,
      key: selectedKey,
      contentType,
      metadata: customMeta,
    });
    closeInfoPanel();
    setStatus("Metadata updated.", 5000);
  } catch (err) {
    setStatus(`Failed to update metadata: ${err}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

export function closeInfoPanel(): void {
  panelRequestToken += 1;
  $("info-overlay").classList.remove("active");
  headData = null;
  aclData = null;
  metadataRows = [];
  currentKey = "";
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
      if (el) el.textContent = "";
      state.statusTimeout = undefined;
    }, autoResetMs);
  }
}
