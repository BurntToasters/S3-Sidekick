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
import upload from "lucide-static/icons/upload.svg?raw";
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
import fileImage from "lucide-static/icons/file-image.svg?raw";
import fileCode from "lucide-static/icons/file-code.svg?raw";
import fileArchive from "lucide-static/icons/file-archive.svg?raw";
import fileVideo from "lucide-static/icons/file-video.svg?raw";
import fileAudio from "lucide-static/icons/file-audio.svg?raw";
import clock from "lucide-static/icons/clock.svg?raw";
import skipForward from "lucide-static/icons/skip-forward.svg?raw";
import compass from "lucide-static/icons/compass.svg?raw";
import save from "lucide-static/icons/save.svg?raw";
import checkSquare from "lucide-static/icons/check-square.svg?raw";
import xSquare from "lucide-static/icons/x-square.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import panelRight from "lucide-static/icons/panel-right.svg?raw";
import moreHorizontal from "lucide-static/icons/more-horizontal.svg?raw";
import minus from "lucide-static/icons/minus.svg?raw";
import square from "lucide-static/icons/square.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import pause from "lucide-static/icons/pause.svg?raw";
import play from "lucide-static/icons/play.svg?raw";
import copy from "lucide-static/icons/copy.svg?raw";
import rotateCcw from "lucide-static/icons/rotate-ccw.svg?raw";
import pencil from "lucide-static/icons/pencil.svg?raw";
import history from "lucide-static/icons/history.svg?raw";
import keyboard from "lucide-static/icons/keyboard.svg?raw";
import gripVertical from "lucide-static/icons/grip-vertical.svg?raw";
import layers from "lucide-static/icons/layers.svg?raw";
import filter from "lucide-static/icons/filter.svg?raw";
import externalLink from "lucide-static/icons/external-link.svg?raw";
import columns3 from "lucide-static/icons/columns-3.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import chevronLeft from "lucide-static/icons/chevron-left.svg?raw";
import chevronsUpDown from "lucide-static/icons/chevrons-up-down.svg?raw";
import sun from "lucide-static/icons/sun.svg?raw";
import moon from "lucide-static/icons/moon.svg?raw";
import rows3 from "lucide-static/icons/rows-3.svg?raw";
import share2 from "lucide-static/icons/share-2.svg?raw";
import folderInput from "lucide-static/icons/folder-input.svg?raw";
import unlock from "lucide-static/icons/unlock.svg?raw";
import fingerprint from "lucide-static/icons/fingerprint.svg?raw";

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
  upload,
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
  "file-image": fileImage,
  "file-code": fileCode,
  "file-archive": fileArchive,
  "file-video": fileVideo,
  "file-audio": fileAudio,
  clock,
  "skip-forward": skipForward,
  compass,
  save,
  "check-square": checkSquare,
  "x-square": xSquare,
  check,
  sidebar: panelRight,
  "panel-right": panelRight,
  "more-horizontal": moreHorizontal,
  minus,
  square,
  plus,
  pause,
  play,
  copy,
  "rotate-ccw": rotateCcw,
  pencil,
  history,
  keyboard,
  "grip-vertical": gripVertical,
  layers,
  filter,
  "external-link": externalLink,
  "columns-3": columns3,
  "chevron-right": chevronRight,
  "chevron-left": chevronLeft,
  "chevrons-up-down": chevronsUpDown,
  sun,
  moon,
  "rows-3": rows3,
  "share-2": share2,
  "folder-input": folderInput,
  unlock,
  fingerprint,
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
