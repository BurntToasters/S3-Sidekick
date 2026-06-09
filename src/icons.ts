import settings from "lucide-static/icons/settings.svg?raw";
import bookmark from "lucide-static/icons/bookmark.svg?raw";
import database from "lucide-static/icons/database.svg?raw";
import arrowLeft from "lucide-static/icons/arrow-left.svg?raw";
import arrowRight from "lucide-static/icons/arrow-right.svg?raw";
import refreshCw from "lucide-static/icons/refresh-cw.svg?raw";
import folder from "lucide-static/icons/folder.svg?raw";
import folderPlus from "lucide-static/icons/folder-plus.svg?raw";
import folderUp from "lucide-static/icons/folder-up.svg?raw";
import info from "lucide-static/icons/info.svg?raw";
import download from "lucide-static/icons/download.svg?raw";
import trash2 from "lucide-static/icons/trash-2.svg?raw";
import cloud from "lucide-static/icons/cloud.svg?raw";
import clipboardList from "lucide-static/icons/clipboard-list.svg?raw";
import chevronDown from "lucide-static/icons/chevron-down.svg?raw";
import x from "lucide-static/icons/x.svg?raw";
import lock from "lucide-static/icons/lock.svg?raw";
import search from "lucide-static/icons/search.svg?raw";
import heart from "lucide-static/icons/heart.svg?raw";
import hand from "lucide-static/icons/hand.svg?raw";
import palette from "lucide-static/icons/palette.svg?raw";
import eye from "lucide-static/icons/eye.svg?raw";
import eyeOff from "lucide-static/icons/eye-off.svg?raw";
import rocket from "lucide-static/icons/rocket.svg?raw";
import checkCircle from "lucide-static/icons/check-circle.svg?raw";
import alertTriangle from "lucide-static/icons/alert-triangle.svg?raw";
import alertCircle from "lucide-static/icons/alert-circle.svg?raw";
import arrowUp from "lucide-static/icons/arrow-up.svg?raw";
import arrowDown from "lucide-static/icons/arrow-down.svg?raw";
import file from "lucide-static/icons/file.svg?raw";
import folderOpen from "lucide-static/icons/folder-open.svg?raw";
import fileText from "lucide-static/icons/file-text.svg?raw";
import clock from "lucide-static/icons/clock.svg?raw";
import skipForward from "lucide-static/icons/skip-forward.svg?raw";
import compass from "lucide-static/icons/compass.svg?raw";
import save from "lucide-static/icons/save.svg?raw";
import checkSquare from "lucide-static/icons/check-square.svg?raw";
import xSquare from "lucide-static/icons/x-square.svg?raw";
import check from "lucide-static/icons/check.svg?raw";

const registry: Record<string, string> = {
  settings,
  bookmark,
  database,
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,
  "refresh-cw": refreshCw,
  folder,
  "folder-plus": folderPlus,
  "folder-up": folderUp,
  info,
  download,
  "trash-2": trash2,
  cloud,
  "clipboard-list": clipboardList,
  "chevron-down": chevronDown,
  x,
  lock,
  search,
  heart,
  hand,
  palette,
  eye,
  "eye-off": eyeOff,
  rocket,
  "check-circle": checkCircle,
  "alert-triangle": alertTriangle,
  "alert-circle": alertCircle,
  "arrow-up": arrowUp,
  "arrow-down": arrowDown,
  file,
  "folder-open": folderOpen,
  "file-text": fileText,
  clock,
  "skip-forward": skipForward,
  compass,
  save,
  "check-square": checkSquare,
  "x-square": xSquare,
  check,
};

export function getIconHtml(
  name: string,
  options: { className?: string; alt?: string; decorative?: boolean } = {},
): string {
  const svg = registry[name];
  if (!svg) return "";
  const className = (options.className ?? "lucide-icon").replace(
    /"/g,
    "&quot;",
  );
  const alt = (options.alt ?? "").replace(/"/g, "&quot;");
  const decorative = options.decorative ?? alt.length === 0;
  const extraAttrs = [
    `data-icon="${name}"`,
    decorative ? 'aria-hidden="true"' : "",
    alt ? `role="img" aria-label="${alt}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  let modified = svg.replace(/class="[^"]*"/, `class="${className}"`);
  if (extraAttrs) {
    modified = modified.replace("<svg", `<svg ${extraAttrs}`);
  }
  return modified;
}

export function initializeIcons(): void {
  const elements = document.querySelectorAll("[data-icon]");
  for (const el of elements) {
    const name = el.getAttribute("data-icon");
    if (name) {
      const className = el.getAttribute("class") ?? "lucide-icon";
      el.outerHTML = getIconHtml(name, { className });
    }
  }
}
