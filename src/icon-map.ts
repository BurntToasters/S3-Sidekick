/**
 * Canonical file-extension to icon mapping for object rows and the inspector.
 * browser.ts and inspector.ts both consume this module so their listings cannot
 * drift apart.
 */
export type FileIconName =
  | "file"
  | "file-text"
  | "file-image"
  | "file-code"
  | "file-archive"
  | "file-video"
  | "file-audio";

const TEXT_DATA_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "htm",
  "log",
]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "bmp",
]);
const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "sql",
  "rb",
  "php",
  "swift",
  "kt",
  "lua",
  "wasm",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "wmv",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "opus",
]);

export function fileExtensionFromName(name: string): string {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

export function iconForFileName(name: string): FileIconName {
  const ext = fileExtensionFromName(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "file-image";
  if (TEXT_DATA_EXTENSIONS.has(ext)) return "file-text";
  if (CODE_EXTENSIONS.has(ext)) return "file-code";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "file-archive";
  if (VIDEO_EXTENSIONS.has(ext)) return "file-video";
  if (AUDIO_EXTENSIONS.has(ext)) return "file-audio";
  return "file";
}
