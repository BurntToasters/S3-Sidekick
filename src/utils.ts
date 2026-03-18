export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
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
