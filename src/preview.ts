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

const PREVIEWABLE_TEXT_EXTS = new Set([
  "txt",
  "md",
  "json",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "ts",
  "csv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "log",
  "sh",
  "bat",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "svg",
]);

const PREVIEWABLE_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
]);

let activePreviewObjectUrl: string | null = null;
let previewSeq = 0;

function canPreview(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEWABLE_TEXT_EXTS.has(ext) || PREVIEWABLE_IMAGE_EXTS.has(ext);
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

  clearActivePreviewObjectUrl();
  title.textContent = basename(key);
  showPreviewOverlay(true);
  body.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading preview&#8230;</div>`;

  try {
    const resp = await invokeS3<PreviewResponse>("preview_object", {
      bucket,
      key,
    });

    if (seq !== previewSeq || state.currentBucket !== bucket) return;

    let html = "";
    const type = mediaType(resp.content_type);

    if (PREVIEWABLE_IMAGE_TYPES.has(type)) {
      if (type === "image/svg+xml") {
        const blob = new Blob([resp.data], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        activePreviewObjectUrl = url;
        html += `<div class="preview-image"><img src="${url}" alt="${escapeHtml(basename(key))}" /></div>`;
      } else {
        html += `<div class="preview-image"><img src="data:${type};base64,${resp.data}" alt="${escapeHtml(basename(key))}" /></div>`;
      }
    } else if (resp.is_text) {
      html += `<pre class="preview-text">${escapeHtml(resp.data)}</pre>`;
    } else {
      html += `<div class="preview-unsupported">Preview not available for ${escapeHtml(resp.content_type)}</div>`;
    }

    if (resp.truncated) {
      html += `<div class="preview-truncated">Showing first 1 MB of ${formatSize(resp.total_size)}</div>`;
    }

    body.innerHTML = html;
  } catch (err) {
    if (seq !== previewSeq || state.currentBucket !== bucket) return;
    body.innerHTML = `<div class="metadata-loading">Failed to load preview: ${escapeHtml(friendlyError(err))}</div>`;
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
