import { escapeHtml, getIconHtml } from "./utils.ts";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  /** Extra words that find the command, such as "mkdir" for Create Folder. */
  keywords?: string[];
  action: () => void;
  available?: () => boolean;
}

let commands: PaletteCommand[] = [];
let activeIndex = 0;
let filtered: PaletteCommand[] = [];
let previouslyFocused: HTMLElement | null = null;

const WORD_SEPARATORS = /[\s/\-_.]+/;
/** Keyword matches rank below label matches of the same kind. */
const KEYWORD_WEIGHT = 0.8;
const ID_WEIGHT = 0.6;

function wordsOf(text: string): string[] {
  return text.split(WORD_SEPARATORS).filter((word) => word.length > 0);
}

function isSubsequence(token: string, text: string): boolean {
  let next = 0;
  for (const char of text) {
    if (char === token[next]) next += 1;
    if (next === token.length) return true;
  }
  return token.length === 0;
}

/**
 * How well one search token matches one text. Stronger matches score higher:
 * whole label, label prefix, word prefix, word initials, then plain substring
 * and finally a loose letter-order match.
 */
function tokenScore(token: string, text: string, weight: number): number {
  const lower = text.toLowerCase();
  const words = wordsOf(lower);
  const initials = words.map((word) => word[0]).join("");
  let best = 0;
  if (lower === token) best = 100;
  else if (lower.startsWith(token)) best = 90;
  else if (words.some((word) => word.startsWith(token))) best = 75;
  else if (initials === token) best = 85;
  else if (token.length >= 2 && initials.startsWith(token)) best = 70;
  else if (lower.includes(token)) best = 50;
  else if (token.length >= 2 && isSubsequence(token, lower)) best = 25;
  return best * weight;
}

/**
 * Commands that match every word of the query, best match first. Commands
 * whose `available` check is false are never returned. An empty query keeps
 * registration order.
 */
export function rankCommands(
  list: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const available = list.filter((cmd) => !cmd.available || cmd.available());
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return available;

  const scored: { cmd: PaletteCommand; index: number; total: number }[] = [];
  available.forEach((cmd, index) => {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let best = Math.max(
        tokenScore(token, cmd.label, 1),
        tokenScore(token, cmd.id.replace(/-/g, " "), ID_WEIGHT),
      );
      for (const keyword of cmd.keywords ?? []) {
        best = Math.max(best, tokenScore(token, keyword, KEYWORD_WEIGHT));
      }
      if (best === 0) {
        matchedAll = false;
        break;
      }
      total += best;
    }
    if (matchedAll) scored.push({ cmd, index, total });
  });
  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  return scored.map((entry) => entry.cmd);
}

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

  if (document.activeElement instanceof HTMLElement) {
    previouslyFocused = document.activeElement;
  }
  overlay.hidden = false;
  input.value = "";
  input.setAttribute("aria-expanded", "true");
  activeIndex = 0;
  filterAndRender("");
  input.focus();
}

/**
 * Returns focus to the opener. `#app` stays inert until the modal layer
 * observer releases it, and focus inside an inert subtree is a no-op, so the
 * restore is tried again once that observer has run.
 */
function restoreOpenerFocus(opener: HTMLElement): void {
  const restore = (): void => {
    if (!opener.isConnected) return;
    // A command may have opened another dialog; that dialog owns focus.
    if (
      document.querySelector(
        ".modal-overlay.active, .dialog-overlay.active, .support-overlay:not([hidden]), .setup-wizard-overlay:not([hidden])",
      ) !== null
    ) {
      return;
    }
    if (document.activeElement !== opener) opener.focus();
  };
  restore();
  // The modal layer may restore its own remembered element once `#app` is no
  // longer inert, so the opener is claimed again after that observer has run.
  window.setTimeout(restore, 0);
}

export function closePalette(): void {
  const overlay = document.getElementById(
    "palette-overlay",
  ) as HTMLDivElement | null;
  const input = document.getElementById(
    "palette-input",
  ) as HTMLInputElement | null;
  if (overlay) overlay.hidden = true;
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-activedescendant", "");
  }
  const restore = previouslyFocused;
  previouslyFocused = null;
  if (restore) restoreOpenerFocus(restore);
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

  // Focus trap: keep focus inside the palette while open
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // Only the input is focusable inside the palette, so prevent Tab escape
      e.preventDefault();
      input.focus();
    }
  });

  input.addEventListener("input", () => {
    activeIndex = 0;
    filterAndRender(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Stop here: the global shortcut handler would otherwise see a closed
      // palette and close the next layer underneath in the same keypress.
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      updateActiveOption();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveOption();
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

  // The pointer moves the active option, so hover and keyboard never mark two
  // different options as selected.
  results.addEventListener("mousemove", (e) => {
    const item = (e.target as HTMLElement).closest(
      ".palette__item",
    ) as HTMLElement | null;
    if (!item) return;
    const idx = parseInt(item.dataset.index ?? "", 10);
    if (isNaN(idx) || idx === activeIndex || !filtered[idx]) return;
    activeIndex = idx;
    updateActiveOption();
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

function updateActiveOption(): void {
  const results = document.getElementById("palette-results");
  const input = document.getElementById(
    "palette-input",
  ) as HTMLInputElement | null;
  if (results) {
    for (const option of results.querySelectorAll<HTMLElement>(
      ".palette__item",
    )) {
      const active = option.dataset.index === String(activeIndex);
      option.classList.toggle("palette__item--active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
  if (input) {
    const id = filtered[activeIndex] ? `palette-option-${activeIndex}` : "";
    input.setAttribute("aria-activedescendant", id);
  }
  scrollActiveIntoView();
}

function filterAndRender(query: string): void {
  filtered = rankCommands(commands, query);
  renderResults();
  updateActiveOption();
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
      const icon = getIconHtml(cmd.icon, {
        className: "lucide-icon",
        decorative: true,
      });
      const activeClass = i === activeIndex ? " palette__item--active" : "";
      const ariaSelected = i === activeIndex ? "true" : "false";
      const shortcut = cmd.shortcut
        ? `<span class="palette__item-shortcut">${escapeHtml(cmd.shortcut)}</span>`
        : "";
      return (
        `<div class="palette__item${activeClass}" id="palette-option-${i}" role="option" aria-selected="${ariaSelected}" data-index="${i}">` +
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
