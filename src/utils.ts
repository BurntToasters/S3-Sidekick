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
  const cached = formatDateCache.get(iso);
  if (cached !== undefined) return cached;
  const formatted = formatDateUncached(iso);
  if (formatDateCache.size >= FORMAT_DATE_CACHE_MAX) formatDateCache.clear();
  formatDateCache.set(iso, formatted);
  return formatted;
}

const FORMAT_DATE_CACHE_MAX = 2000;
const formatDateCache = new Map<string, string>();

function formatDateUncached(iso: string): string {
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

const WINDOWS_ILLEGAL_NAME_CHARS = /[%<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_TRAILING_DOTS_SPACES = /[ .]+$/;

function percentEncodeAscii(value: string): string {
  return Array.from(
    value,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
}

/**
 * Map an S3 object key to a file name that is legal on `platform`.
 *
 * Keys may contain characters no Windows filesystem accepts (`< > : " / \ | ?
 * *`, control characters) and the special names `.` and `..`. Unsafe code
 * units are percent-encoded so the mapping stays injective and can never
 * traverse out of the destination directory (`%` itself is encoded). Unicode
 * is folded to NFC because APFS treats NFC/NFD spellings as one file.
 */
export function safeFileName(key: string, platform: string): string {
  const normalized = basename(key).normalize("NFC");
  const base = normalized.length > 0 ? normalized : "unnamed";
  if (platform !== "windows") {
    return base === "." || base === ".." ? percentEncodeAscii(base) : base;
  }
  let name = base.replace(WINDOWS_ILLEGAL_NAME_CHARS, percentEncodeAscii);
  const stem = name.split(".")[0] ?? "";
  if (WINDOWS_RESERVED_NAME.test(stem)) {
    name = percentEncodeAscii(name[0] ?? "u") + name.slice(1);
  }
  name = name.replace(WINDOWS_TRAILING_DOTS_SPACES, percentEncodeAscii);
  return name.length > 0 ? name : "unnamed";
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

export { getIconHtml } from "./icons.ts";

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

const TRANSFER_ERROR_PREFIX = "__S3_SIDEKICK_TRANSFER_ERROR__";

/// Structured backend errors carry a JSON envelope; only its message is meant
/// for people.
function unwrapTransferErrorEnvelope(msg: string): string {
  if (!msg.startsWith(TRANSFER_ERROR_PREFIX)) return msg;
  try {
    const parsed = JSON.parse(msg.slice(TRANSFER_ERROR_PREFIX.length)) as {
      message?: unknown;
    };
    return typeof parsed.message === "string" ? parsed.message : msg;
  } catch {
    return msg;
  }
}

/// A status code standing alone, not part of a key or path such as
/// "error-500-logs" or "/404/".
function statusToken(code: number): RegExp {
  return new RegExp(`(?<![\\w\\-./%])${code}(?![\\w\\-./%])`);
}

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = unwrapTransferErrorEnvelope(raw.replace(/^Error:\s*/u, ""));
  // Backend messages quote keys, bucket names and paths. Classify only the
  // surrounding text so a name like "timeout-dns-500" cannot rewrite it.
  const text = msg.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  if (statusToken(403).test(text) || /Forbidden|AccessDenied/i.test(text))
    return "Access denied. Check your credentials and permissions.";
  if (
    statusToken(404).test(text) ||
    /NoSuchBucket|NoSuchKey|NotFound/i.test(text)
  )
    return "Resource not found. It may have been deleted or moved.";
  if (/\btimeout\b|\btimed?\s*out\b|ETIMEDOUT/i.test(text))
    return "Request timed out. Check your network connection and endpoint.";
  if (
    /\bnetwork\b|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|\bdns\b/i.test(
      text,
    )
  )
    return "Network error. Verify the endpoint URL and your internet connection.";
  if (
    statusToken(401).test(text) ||
    /Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(text)
  )
    return "Authentication failed. Verify your access key and secret key.";
  if (statusToken(500).test(text) || /InternalError/i.test(text))
    return "Server error. The storage service may be experiencing issues.";
  if (
    /slow\s*down|TooManyRequests|throttl/i.test(text) ||
    statusToken(429).test(text)
  )
    return "Rate limited. Too many requests \u2014 wait a moment and try again.";
  return msg;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // Malformed JSON is an expected input shape here; callers branch on null.
    return null;
  }
}

export function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Malformed JSON is an expected input shape here; callers branch on null.
    return null;
  }
}

export function reportError(message: string, err: unknown): string {
  const detail = friendlyError(err);
  return detail ? `${message}: ${detail}` : message;
}

/// Endpoints on this machine or the local network. They stay reachable when
/// the OS reports no internet connection, and cleartext HTTP to them does not
/// cross the internet.
export function isLocalEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps IPv6 literals bracketed ("[::1]").
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host.endsWith(".local")) return true;
  const ipv4 = host.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    const a = Number(ipv4[0]);
    const b = Number(ipv4[1]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}
