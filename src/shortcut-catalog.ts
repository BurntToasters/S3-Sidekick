/**
 * The one list of keyboard shortcuts shown to the user. Every entry must be
 * handled by the app: global chords in `wireKeyboardShortcuts` (keyboard.ts),
 * row and bucket navigation in browser.ts, Space/Enter in app-events.ts, and
 * tab/resizer keys in app-layout.ts.
 */

/** Headings for the shortcuts dialog, in display order. */
export const SHORTCUT_GROUPS = [
  "Files and folders",
  "Navigation",
  "Objects",
  "Panels",
  "App",
] as const;

export type ShortcutGroupTitle = (typeof SHORTCUT_GROUPS)[number];

export interface ShortcutEntry {
  /** What the shortcut does, shown before the keys. */
  action: string;
  /** Dialog heading this entry is listed under. */
  group: ShortcutGroupTitle;
  /** Key labels on macOS, where the accelerator is Command. */
  macos: readonly string[];
  /** Key labels on Windows and Linux, where the accelerator is Ctrl. */
  other: readonly string[];
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    action: "Delete selected items",
    group: "Files and folders",
    macos: ["Delete", "⌘⌫"],
    other: ["Delete"],
  },
  {
    action: "Rename selected item",
    group: "Files and folders",
    macos: ["F2"],
    other: ["F2"],
  },
  {
    action: "Select all objects",
    group: "Objects",
    macos: ["⌘A"],
    other: ["Ctrl+A"],
  },
  {
    action: "Upload files",
    group: "Files and folders",
    macos: ["⌘U"],
    other: ["Ctrl+U"],
  },
  {
    action: "Upload folder",
    group: "Files and folders",
    macos: ["⌘⇧U"],
    other: ["Ctrl+Shift+U"],
  },
  {
    action: "New folder",
    group: "Files and folders",
    macos: ["⌘N"],
    other: ["Ctrl+N"],
  },
  {
    action: "Filter objects",
    group: "Navigation",
    macos: ["⌘F"],
    other: ["Ctrl+F"],
  },
  {
    action: "Toggle inspector (connected only)",
    group: "Panels",
    macos: ["⌘⇧I"],
    other: ["Ctrl+Shift+I"],
  },
  {
    action: "Refresh",
    group: "Navigation",
    macos: ["F5", "⌘R"],
    other: ["F5", "Ctrl+R"],
  },
  {
    action: "Go up one folder",
    group: "Navigation",
    macos: ["Backspace", "⌥↑"],
    other: ["Backspace", "Alt+↑"],
  },
  { action: "Back", group: "Navigation", macos: ["⌥←"], other: ["Alt+←"] },
  { action: "Forward", group: "Navigation", macos: ["⌥→"], other: ["Alt+→"] },
  {
    action: "Edit location",
    group: "Navigation",
    macos: ["⌘L"],
    other: ["Ctrl+L"],
  },
  {
    action: "Command palette",
    group: "App",
    macos: ["⌘K"],
    other: ["Ctrl+K"],
  },
  {
    action: "Keyboard shortcuts",
    group: "App",
    macos: ["⌘/"],
    other: ["Ctrl+/"],
  },
  {
    action: "Close the topmost panel, dialog, or palette",
    group: "App",
    macos: ["Escape"],
    other: ["Escape"],
  },
  // Object table navigation. Arrow/Home/End/Page keys are handled by
  // browser.ts; Space and Enter by app-events.ts.
  {
    action: "Move between objects",
    group: "Objects",
    macos: ["↑", "↓"],
    other: ["↑", "↓"],
  },
  {
    action: "Extend selection between objects",
    group: "Objects",
    macos: ["⇧↑", "⇧↓"],
    other: ["Shift+↑", "Shift+↓"],
  },
  {
    action: "Jump to the first or last object",
    group: "Objects",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  {
    action: "Page through objects",
    group: "Objects",
    macos: ["Page Up", "Page Down"],
    other: ["Page Up", "Page Down"],
  },
  {
    action: "Toggle the focused object's selection",
    group: "Objects",
    macos: ["Space"],
    other: ["Space"],
  },
  {
    action: "Open or preview the focused object",
    group: "Objects",
    macos: ["Enter"],
    other: ["Enter"],
  },
  {
    action: "Open the focused object's context menu",
    group: "Objects",
    macos: ["⇧F10", "Context Menu"],
    other: ["Shift+F10", "Context Menu"],
  },
  {
    action: "Jump to an object by typing its name",
    group: "Objects",
    macos: ["Type letters"],
    other: ["Type letters"],
  },
  // Bucket list roving focus.
  {
    action: "Move between buckets",
    group: "Navigation",
    macos: ["↑", "↓"],
    other: ["↑", "↓"],
  },
  {
    action: "Jump to the first or last bucket",
    group: "Navigation",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  // Inspector tabs and the sidebar/inspector resizers.
  {
    action: "Move between tabs",
    group: "Panels",
    macos: ["←", "→", "Home", "End"],
    other: ["←", "→", "Home", "End"],
  },
  {
    action: "Resize the sidebar or inspector",
    group: "Panels",
    macos: ["←", "→"],
    other: ["←", "→"],
  },
  {
    action: "Jump to a panel width limit",
    group: "Panels",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  {
    action: "Resize in larger steps",
    group: "Panels",
    macos: ["⇧←", "⇧→"],
    other: ["Shift+←", "Shift+→"],
  },
];

/** One line per shortcut for the platform, such as "Refresh: F5 or ⌘R". */
export function shortcutLines(platformName: string): string[] {
  const isMac = platformName === "macos";
  return SHORTCUTS.map((entry) => {
    const keys = isMac ? entry.macos : entry.other;
    return `${entry.action}: ${keys.join(" or ")}`;
  });
}

/** Plain text for the dialog message; the dialog renders it with pre-line. */
export function shortcutListText(platformName: string): string {
  return shortcutLines(platformName).join("\n");
}

/** Modifier glyphs that prefix a macOS key label, such as "⌘⇧U". */
const MODIFIER_GLYPHS = /^([⌘⇧⌥⌃]+)(.+)$/u;

/**
 * Split one key label into the keys a chip should show: "Ctrl+Shift+U" gives
 * three keys, "⌘⇧U" gives three glyph/letter keys, and multi-word names such as
 * "Page Up" stay whole.
 */
export function shortcutKeyChips(label: string): string[] {
  if (label.length > 1 && label.includes("+") && !label.endsWith("+")) {
    return label.split("+");
  }
  const glyphs = MODIFIER_GLYPHS.exec(label);
  if (glyphs) {
    return [...Array.from(glyphs[1]), glyphs[2]];
  }
  return [label];
}

export interface ShortcutGroup {
  title: ShortcutGroupTitle;
  entries: ShortcutEntry[];
}

/** The catalog grouped under its headings, empty headings omitted. */
export function shortcutGroups(): ShortcutGroup[] {
  return SHORTCUT_GROUPS.map((title) => ({
    title,
    entries: SHORTCUTS.filter((entry) => entry.group === title),
  })).filter((group) => group.entries.length > 0);
}
