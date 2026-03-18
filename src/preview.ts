import { invoke } from "@tauri-apps/api/core";
import { $, escapeHtml, formatSize, basename } from "./utils.ts";
import { state } from "./state.ts";

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

export async function openPreview(key: string): Promise<void> {
  const overlay = $("preview-overlay");
  const title = $("preview-title");
  const body = $("preview-body");

  clearActivePreviewObjectUrl();
  title.textContent = basename(key);
  overlay.classList.add("active");
  body.innerHTML = `<div class="metadata-loading"><span class="spinner"></span>Loading preview&#8230;</div>`;

  try {
    const resp = await invoke<PreviewResponse>("preview_object", {
      bucket: state.currentBucket,
      key,
    });

    let html = "";

    if (PREVIEWABLE_IMAGE_TYPES.has(resp.content_type)) {
      if (resp.content_type === "image/svg+xml") {
        const blob = new Blob([resp.data], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        activePreviewObjectUrl = url;
        html += `<div class="preview-image"><img src="${url}" alt="${escapeHtml(basename(key))}" /></div>`;
      } else {
        html += `<div class="preview-image"><img src="data:${resp.content_type};base64,${resp.data}" alt="${escapeHtml(basename(key))}" /></div>`;
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
    body.innerHTML = `<div class="metadata-loading">Failed to load preview: ${escapeHtml(String(err))}</div>`;
  }
}

export function closePreview(): void {
  clearActivePreviewObjectUrl();
  $("preview-overlay").classList.remove("active");
}
