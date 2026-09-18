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
} from "./inspector.ts";

interface PreviewResponse {
  content_type: string;
  data: string;
  is_text: boolean;
  truncated: boolean;
  total_size: number;
}

const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
]);

let activePreviewObjectUrl: string | null = null;
let previewSeq = 0;

function canPreview(name: string): boolean {
  // Always offer Preview; rendering is decided by content_type/is_text
  // below, not by extension. Keep a non-empty guard for menu affordance.
  return name.trim().length > 0;
}

export { canPreview };

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
  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<div class="metadata-loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading preview&#8230;</div>`;

  try {
    const resp = await invokeS3<PreviewResponse>("preview_object", {
      bucket,
      key,
    });

    if (
      seq !== previewSeq ||
      previewKey !== key ||
      state.currentBucket !== bucket ||
      state.connectionId !== connectionId ||
      state.connectionIdentity !== connectionIdentity
    )
      return;

    let html = "";
    const type = mediaType(resp.content_type);

    if (PREVIEWABLE_IMAGE_TYPES.has(type)) {
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
      html += `<div class="preview-unsupported">Preview not available for ${escapeHtml(resp.content_type)}</div>`;
    }

    if (resp.truncated) {
      html += `<div class="preview-truncated">Showing first 1 MB of ${formatSize(resp.total_size)}</div>`;
    }

    body.setAttribute("aria-busy", "false");
    body.innerHTML = html;
  } catch (err) {
    if (
      seq !== previewSeq ||
      previewKey !== key ||
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
