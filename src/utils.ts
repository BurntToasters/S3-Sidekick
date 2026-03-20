export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

export function $$<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document,
): T {
  const el = parent.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches: ${selector}`);
  return el;
}

export function findClosest<T extends HTMLElement = HTMLElement>(
  e: Event,
  selector: string,
): T | null {
  return (e.target as HTMLElement).closest<T>(selector);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_URL_PATTERN = /^https?:\/\//i;

export function safeHref(url: string): string {
  return SAFE_URL_PATTERN.test(url) ? escapeHtml(url) : "#";
}

export function formatSize(bytes: number): string {
  if (bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function basename(key: string): string {
  if (key.endsWith("/")) {
    const trimmed = key.slice(0, -1);
    const idx = trimmed.lastIndexOf("/");
    return idx >= 0 ? trimmed.slice(idx + 1) + "/" : trimmed + "/";
  }
  const idx = key.lastIndexOf("/");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

interface TwemojiIconOptions {
  className?: string;
  alt?: string;
  decorative?: boolean;
}

export function isEditableElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    el.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

export function twemojiAsset(codepoint: string): string {
  return `/twemoji/${codepoint}.svg`;
}

export function twemojiIcon(
  codepoint: string,
  options: TwemojiIconOptions = {},
): string {
  const className = options.className ?? "twemoji-icon";
  const alt = options.alt ?? "";
  const decorative = options.decorative ?? alt.length === 0;
  return (
    `<img class="${escapeHtml(className)}" src="${twemojiAsset(codepoint)}" alt="${escapeHtml(alt)}"` +
    `${decorative ? ' aria-hidden="true"' : ""} draggable="false" />`
  );
}

export function splitNameExt(fileName: string): { stem: string; ext: string } {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) {
    return { stem: fileName, ext: "" };
  }
  return { stem: fileName.slice(0, idx), ext: fileName.slice(idx) };
}

export function pathSeparator(platform: string): string {
  if (platform === "windows") return "\\";
  return "/";
}

export function joinPath(base: string, leaf: string, platform: string): string {
  const sep = pathSeparator(platform);
  const trimmed = base.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${leaf}`;
}

export function friendlyError(err: unknown): string {
  const msg = String(err);
  if (/403|Forbidden/i.test(msg))
    return "Access denied. Check your credentials and permissions.";
  if (/404|NoSuchBucket|NoSuchKey|NotFound/i.test(msg))
    return "Resource not found. It may have been deleted or moved.";
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(msg))
    return "Request timed out. Check your network connection and endpoint.";
  if (/network|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|dns/i.test(msg))
    return "Network error. Verify the endpoint URL and your internet connection.";
  if (/401|Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(msg))
    return "Authentication failed. Verify your access key and secret key.";
  if (/500|InternalError/i.test(msg))
    return "Server error. The storage service may be experiencing issues.";
  if (/slow\s*down|429|TooManyRequests|throttl/i.test(msg))
    return "Rate limited. Too many requests \u2014 wait a moment and try again.";
  return msg;
}
