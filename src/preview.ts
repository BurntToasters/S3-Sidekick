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

/** Matches the native `MAX_PREVIEW` read limit in s3/preview.rs. */
const PREVIEW_LIMIT_BYTES = 1_048_576;

const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
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
      if (resp.total_size > PREVIEW_LIMIT_BYTES) {
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
        html += `<div class="preview-image"><img src="${url}" alt="${escapeHtml(basename(key))}" /></div>`;
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
        html += `<div class="preview-image"><img src="${src}" alt="${escapeHtml(basename(key))}" /></div>`;
      }
    } else if (resp.is_text) {
      html += `<pre class="preview-text">${escapeHtml(resp.data)}</pre>`;
    } else {
      html += unsupportedMarkup();
    }

    if (resp.truncated) {
      html += `<div class="preview-truncated">Showing first 1 MB of ${formatSize(resp.total_size)}</div>`;
    }

    body.setAttribute("aria-busy", "false");
    body.innerHTML = html;
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
