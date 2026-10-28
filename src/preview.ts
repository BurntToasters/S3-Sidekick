import { invokeS3 } from "./connection.ts";
import { escapeHtml, formatSize, basename, friendlyError } from "./utils.ts";
import { state } from "./state.ts";
import {
  getPreviewTitleEl,
  getPreviewBodyEl,
  showPreviewOverlay,
  hidePreviewOverlay,
  shouldUseInspectorMount,
} from "./inspector-mount.ts";
import {
  ensureInspectorOpenForPane,
  focusInspectorPreviewPane,
  markInspectorHasContent,
} from "./inspector-host.ts";

interface PreviewResponse {
  content_type: string;
  data: string;
  is_text: boolean;
  truncated: boolean;
  total_size: number;
}

/** Matches the native text read limit in s3/preview.rs. */
export const PREVIEW_LIMIT_BYTES = 1_048_576;
/** Matches the native image read cap in s3/preview.rs. */
export const PREVIEW_IMAGE_LIMIT_BYTES = 16_777_216;

/** Rows shown for CSV/TSV previews; the rest stays a count. */
const CSV_ROW_LIMIT = 200;

const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
]);

/**
 * Extensions whose content is never rendered. They are refused before any
 * request, so the Preview tab is disabled and no bytes are fetched. Unknown
 * extensions still reach the native command, which decides from the HEAD
 * content type.
 */
const NON_PREVIEWABLE_EXTENSIONS = new Set([
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "xz",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "iso",
  "dmg",
  "msi",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "mp3",
  "wav",
  "flac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "woff",
  "woff2",
]);

const UNSUPPORTED_MESSAGE = "Preview not available for this file type.";

type TextPreviewKind = "json" | "csv" | "tsv" | "text";

let activePreviewObjectUrl: string | null = null;
let previewSeq = 0;

/**
 * Whether Preview can render this file name. Decided from the extension only,
 * so a known binary never costs a request.
 */
export function canPreview(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return true;
  const extension = trimmed.slice(dot + 1).toLowerCase();
  return !NON_PREVIEWABLE_EXTENSIONS.has(extension);
}

function clearActivePreviewObjectUrl(): void {
  if (activePreviewObjectUrl) {
    URL.revokeObjectURL(activePreviewObjectUrl);
    activePreviewObjectUrl = null;
  }
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function base64ToBlobUrl(base64: string, type: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type });
  return URL.createObjectURL(blob);
}

function unsupportedMarkup(): string {
  return `<div class="preview-unsupported" role="status">${UNSUPPORTED_MESSAGE}</div>`;
}

function tooLargeMarkup(totalSize: number): string {
  return (
    `<div class="preview-too-large">` +
    `<p class="preview-unsupported" role="status">Too large to preview (${escapeHtml(formatSize(totalSize))}). ` +
    `Download the file to open it.</p>` +
    `<button type="button" class="btn btn--sm" data-preview-download>Download</button>` +
    `</div>`
  );
}

function wireDownloadAction(body: HTMLElement): void {
  body
    .querySelector<HTMLButtonElement>("[data-preview-download]")
    ?.addEventListener("click", () => {
      // The preview always belongs to the single selected file, so the toolbar
      // download acts on the object being shown.
      document.getElementById("btn-download")?.click();
    });
}

function fileExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1);
}

/**
 * Which text rendering a preview gets. Markdown deliberately has no kind of
 * its own: it renders as plain text so stored markup can never execute, and
 * the content security policy is not widened for it.
 */
export function textPreviewKind(
  contentType: string,
  key: string,
): TextPreviewKind {
  const type = mediaType(contentType);
  const ext = fileExtension(basename(key));
  if (type === "application/json" || type.endsWith("+json") || ext === "json") {
    return "json";
  }
  if (type === "text/csv" || ext === "csv") return "csv";
  if (type === "text/tab-separated-values" || ext === "tsv") return "tsv";
  return "text";
}

function jsonToken(kind: string, text: string): string {
  return `<span class="${kind}">${escapeHtml(text)}</span>`;
}

function renderJsonValue(value: unknown, depth: number): string {
  if (value === null) return jsonToken("tok-null", "null");
  if (typeof value === "boolean") {
    return jsonToken("tok-bool", String(value));
  }
  if (typeof value === "number") return jsonToken("tok-num", String(value));
  if (typeof value === "string") {
    return jsonToken("tok-str", JSON.stringify(value));
  }
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value
      .map((item) => pad + renderJsonValue(item, depth + 1))
      .join(",\n");
    return `[\n${items}\n${close}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const lines = entries
    .map(
      ([key, item]) =>
        `${pad}${jsonToken("tok-key", JSON.stringify(key))}: ${renderJsonValue(item, depth + 1)}`,
    )
    .join(",\n");
  return `{\n${lines}\n${close}}`;
}

/**
 * Pretty-printed JSON as HTML lines, or null when the text is not JSON.
 * Every value is escaped inside its token span, so hostile keys or strings
 * cannot inject markup.
 */
export function formatJsonHtml(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return renderJsonValue(value, 0);
}

export interface DelimitedTable {
  header: string[];
  rows: string[][];
  totalRows: number;
}

/**
 * Delimited-text parser with quoted-field support ("" escapes inside quotes).
 * Returns the header, at most `maxRows` data rows, and the full row count so
 * the caller can note the cut.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number,
): DelimitedTable {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  const header = rows.length > 0 ? rows[0] : [];
  return {
    header,
    rows: rows.slice(1, 1 + maxRows),
    totalRows: Math.max(0, rows.length - 1),
  };
}

function delimitedTableHtml(text: string, delimiter: string): string {
  const { header, rows, totalRows } = parseDelimited(
    text,
    delimiter,
    CSV_ROW_LIMIT,
  );
  const head = header
    .map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  const note =
    totalRows > rows.length
      ? `<div class="preview-table-note" role="status">Showing first ${rows.length} of ${totalRows} rows</div>`
      : "";
  return `<table class="preview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}`;
}

/** One preview line: a gutter number and the (already escaped) content. */
function codeLineHtml(numeral: number, lineHtml: string): string {
  return (
    `<div class="preview-code__line">` +
    `<span class="preview-code__num" aria-hidden="true">${numeral}</span>` +
    `<span class="preview-code__text">${lineHtml}</span>` +
    `</div>`
  );
}

/**
 * The shared code-view shell: line-number gutter, wrap toggle and Copy.
 * `linesHtml` entries are pre-escaped, so callers must escape before this.
 */
function codeBlockHtml(linesHtml: string[]): string {
  const lines = linesHtml
    .map((line, index) => codeLineHtml(index + 1, line || "&#8203;"))
    .join("");
  return (
    `<div class="preview-code" data-wrap="on">` +
    `<div class="preview-code__tools">` +
    `<button type="button" class="btn btn--ghost btn--sm" data-preview-wrap aria-pressed="true">Wrap</button>` +
    `<button type="button" class="btn btn--ghost btn--sm" data-preview-copy>Copy</button>` +
    `</div>` +
    `<div class="preview-code__lines">${lines}</div>` +
    `</div>`
  );
}

function wireCopyButton(root: ParentNode, raw: string): void {
  root
    .querySelector<HTMLButtonElement>("[data-preview-copy]")
    ?.addEventListener("click", () => {
      void navigator.clipboard.writeText(raw).then(
        () => undefined,
        () => undefined,
      );
    });
}

function wireCodeTools(container: HTMLElement, raw: string): void {
  container
    .querySelector<HTMLButtonElement>("[data-preview-wrap]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const block = container.querySelector<HTMLElement>(".preview-code");
      if (!block) return;
      const next = block.dataset.wrap === "on" ? "off" : "on";
      block.dataset.wrap = next;
      button.setAttribute("aria-pressed", String(next === "on"));
    });
  wireCopyButton(container, raw);
}

function tableToolsHtml(): string {
  return (
    `<div class="preview-code__tools">` +
    `<button type="button" class="btn btn--ghost btn--sm" data-preview-copy>Copy</button>` +
    `</div>`
  );
}

/**
 * Text previews. JSON gets a pretty-print with token spans, CSV/TSV a table,
 * everything else (including Markdown) an escaped plain-text listing — never
 * rendered HTML.
 */
function textPreviewHtml(
  contentType: string,
  key: string,
  raw: string,
): string {
  const kind = textPreviewKind(contentType, key);
  if (kind === "csv" || kind === "tsv") {
    const table = delimitedTableHtml(raw, kind === "csv" ? "," : "\t");
    return `<div class="preview-code preview-code--table" data-wrap="on">${tableToolsHtml()}${table}</div>`;
  }
  if (kind === "json") {
    const pretty = formatJsonHtml(raw);
    if (pretty !== null) {
      return codeBlockHtml(pretty.split("\n"));
    }
    // Malformed JSON falls through to the plain-text listing.
  }
  return codeBlockHtml(raw.split("\n").map((line) => escapeHtml(line)));
}

function imagePreviewHtml(src: string, alt: string): string {
  return (
    `<div class="preview-image preview-image--checker preview-image--fit">` +
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />` +
    `</div>` +
    `<div class="preview-code__tools">` +
    `<button type="button" class="btn btn--ghost btn--sm" data-preview-zoom>100%</button>` +
    `</div>`
  );
}

function wireZoomToggle(body: HTMLElement): void {
  body
    .querySelector<HTMLButtonElement>("[data-preview-zoom]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const frame = body.querySelector<HTMLElement>(".preview-image");
      if (!frame) return;
      const zoomed = frame.classList.toggle("preview-image--zoom-100");
      frame.classList.toggle("preview-image--fit", !zoomed);
      button.textContent = zoomed ? "Fit" : "100%";
    });
}

export async function openPreview(key: string): Promise<void> {
  ensureInspectorOpenForPane("preview");
  if (shouldUseInspectorMount()) {
    focusInspectorPreviewPane();
    markInspectorHasContent();
  }

  const title = getPreviewTitleEl();
  const body = getPreviewBodyEl();
  const seq = ++previewSeq;
  const bucket = state.currentBucket;
  const connectionId = state.connectionId;
  const connectionIdentity = state.connectionIdentity;
  const previewKey = key;

  clearActivePreviewObjectUrl();
  title.textContent = basename(key);
  showPreviewOverlay(true);

  if (!canPreview(basename(key))) {
    body.setAttribute("aria-busy", "false");
    body.innerHTML = unsupportedMarkup();
    return;
  }

  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<div class="metadata-loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading preview&#8230;</div>`;

  try {
    const resp = await invokeS3<PreviewResponse>("preview_object", {
      bucket,
      key,
    });

    if (
      seq !== previewSeq ||
      state.currentBucket !== bucket ||
      state.connectionId !== connectionId ||
      state.connectionIdentity !== connectionIdentity
    )
      return;

    let html = "";
    const type = mediaType(resp.content_type);

    if (PREVIEWABLE_IMAGE_TYPES.has(type)) {
      if (resp.total_size > PREVIEW_IMAGE_LIMIT_BYTES) {
        // A partial image draws as a broken picture, so nothing is drawn.
        body.setAttribute("aria-busy", "false");
        body.innerHTML = tooLargeMarkup(resp.total_size);
        wireDownloadAction(body);
        return;
      }
      if (type === "image/svg+xml") {
        const blob = new Blob([resp.data], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        activePreviewObjectUrl = url;
        html += imagePreviewHtml(url, basename(key));
      } else {
        // Blob URLs (same pattern as SVG above) keep large base64 payloads
        // out of the DOM; fall back to a data URL if decoding fails.
        let src = `data:${type};base64,${resp.data}`;
        try {
          const url = base64ToBlobUrl(resp.data, type);
          activePreviewObjectUrl = url;
          src = url;
        } catch {
          // Keep the data-URL fallback.
        }
        html += imagePreviewHtml(src, basename(key));
      }
    } else if (resp.is_text) {
      html += textPreviewHtml(resp.content_type, key, resp.data);
    } else {
      html += unsupportedMarkup();
    }

    if (resp.truncated) {
      html += `<div class="preview-truncated">Showing first 1 MB of ${formatSize(resp.total_size)}</div>`;
    }

    body.setAttribute("aria-busy", "false");
    body.innerHTML = html;
    const tableBlock = body.querySelector<HTMLElement>(".preview-code--table");
    if (tableBlock) {
      wireCopyButton(tableBlock, resp.data);
    } else {
      wireCodeTools(body, resp.is_text ? resp.data : "");
    }
    if (PREVIEWABLE_IMAGE_TYPES.has(type)) {
      wireZoomToggle(body);
    }
  } catch (err) {
    if (
      seq !== previewSeq ||
      state.currentBucket !== bucket ||
      state.connectionId !== connectionId ||
      state.connectionIdentity !== connectionIdentity
    )
      return;
    body.setAttribute("aria-busy", "false");
    body.innerHTML =
      `<div class="metadata-loading" role="alert">Failed to load preview: ${escapeHtml(friendlyError(err))} ` +
      `<button type="button" class="btn btn--sm" data-preview-retry>Retry</button></div>`;
    body
      .querySelector("[data-preview-retry]")
      ?.addEventListener("click", () => void openPreview(previewKey));
  }
}

export function closePreview(): void {
  previewSeq += 1;
  clearActivePreviewObjectUrl();
  for (const id of ["inspector-preview-body", "preview-body"]) {
    document.getElementById(id)?.replaceChildren();
  }
  hidePreviewOverlay();
}
