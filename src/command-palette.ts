import { escapeHtml, twemojiIcon } from "./utils.ts";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  action: () => void;
  available?: () => boolean;
}

let commands: PaletteCommand[] = [];
let activeIndex = 0;
let filtered: PaletteCommand[] = [];

export function registerCommands(cmds: PaletteCommand[]): void {
  commands = cmds;
}

export function openPalette(): void {
  const overlay = document.getElementById(
    "palette-overlay",
  ) as HTMLDivElement | null;
  const input = document.getElementById(
    "palette-input",
  ) as HTMLInputElement | null;
  if (!overlay || !input) return;

  overlay.hidden = false;
  input.value = "";
  activeIndex = 0;
  filterAndRender("");
  input.focus();
}

export function closePalette(): void {
  const overlay = document.getElementById(
    "palette-overlay",
  ) as HTMLDivElement | null;
  if (overlay) overlay.hidden = true;
}

export function isPaletteOpen(): boolean {
  const overlay = document.getElementById(
    "palette-overlay",
  ) as HTMLDivElement | null;
  return overlay ? !overlay.hidden : false;
}

export function initPalette(): void {
  const overlay = document.getElementById(
    "palette-overlay",
  ) as HTMLDivElement | null;
  const input = document.getElementById(
    "palette-input",
  ) as HTMLInputElement | null;
  const results = document.getElementById(
    "palette-results",
  ) as HTMLDivElement | null;
  if (!overlay || !input || !results) return;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePalette();
  });

  input.addEventListener("input", () => {
    activeIndex = 0;
    filterAndRender(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      renderResults();
      scrollActiveIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderResults();
      scrollActiveIntoView();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIndex]) {
        closePalette();
        filtered[activeIndex].action();
      }
    }
  });

  results.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(
      ".palette__item",
    ) as HTMLElement | null;
    if (!item) return;
    const idx = parseInt(item.dataset.index ?? "", 10);
    if (isNaN(idx) || !filtered[idx]) return;
    closePalette();
    filtered[idx].action();
  });
}

function filterAndRender(query: string): void {
  const q = query.toLowerCase().trim();
  filtered = commands.filter((cmd) => {
    if (cmd.available && !cmd.available()) return false;
    if (!q) return true;
    return (
      cmd.label.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q)
    );
  });
  renderResults();
}

function renderResults(): void {
  const results = document.getElementById("palette-results");
  if (!results) return;

  if (filtered.length === 0) {
    results.innerHTML = `<div class="palette__empty">No commands found</div>`;
    return;
  }

  results.innerHTML = filtered
    .map((cmd, i) => {
      const icon = twemojiIcon(cmd.icon, {
        className: "twemoji-icon",
        decorative: true,
      });
      const activeClass = i === activeIndex ? " palette__item--active" : "";
      const shortcut = cmd.shortcut
        ? `<span class="palette__item-shortcut">${escapeHtml(cmd.shortcut)}</span>`
        : "";
      return (
        `<div class="palette__item${activeClass}" data-index="${i}">` +
        `<span class="palette__item-icon">${icon}</span>` +
        `<span class="palette__item-label">${escapeHtml(cmd.label)}</span>` +
        shortcut +
        `</div>`
      );
    })
    .join("");
}

function scrollActiveIntoView(): void {
  const results = document.getElementById("palette-results");
  if (!results) return;
  const active = results.querySelector(
    ".palette__item--active",
  ) as HTMLElement | null;
  if (active) active.scrollIntoView({ block: "nearest" });
}
