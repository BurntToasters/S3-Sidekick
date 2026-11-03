/**
 * The one list of keyboard shortcuts shown to the user. Every entry must be
 * handled by the app: global chords in `wireKeyboardShortcuts` (keyboard.ts),
 * row and bucket navigation in browser.ts, Space/Enter in app-events.ts, and
 * tab/resizer keys in app-layout.ts.
 */
export interface ShortcutEntry {
  /** What the shortcut does, shown before the keys. */
  action: string;
  /** Key labels on macOS, where the accelerator is Command. */
  macos: readonly string[];
  /** Key labels on Windows and Linux, where the accelerator is Ctrl. */
  other: readonly string[];
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    action: "Delete selected items",
    macos: ["Delete", "⌘⌫"],
    other: ["Delete"],
  },
  { action: "Rename selected item", macos: ["F2"], other: ["F2"] },
  { action: "Select all objects", macos: ["⌘A"], other: ["Ctrl+A"] },
  { action: "Upload files", macos: ["⌘U"], other: ["Ctrl+U"] },
  { action: "Upload folder", macos: ["⌘⇧U"], other: ["Ctrl+Shift+U"] },
  { action: "New folder", macos: ["⌘N"], other: ["Ctrl+N"] },
  { action: "Filter objects", macos: ["⌘F"], other: ["Ctrl+F"] },
  {
    action: "Toggle inspector (connected only)",
    macos: ["⌘⇧I"],
    other: ["Ctrl+Shift+I"],
  },
  { action: "Refresh", macos: ["F5", "⌘R"], other: ["F5", "Ctrl+R"] },
  {
    action: "Go up one folder",
    macos: ["Backspace", "⌥↑"],
    other: ["Backspace", "Alt+↑"],
  },
  { action: "Back", macos: ["⌥←"], other: ["Alt+←"] },
  { action: "Forward", macos: ["⌥→"], other: ["Alt+→"] },
  { action: "Edit location", macos: ["⌘L"], other: ["Ctrl+L"] },
  { action: "Command palette", macos: ["⌘K"], other: ["Ctrl+K"] },
  { action: "Keyboard shortcuts", macos: ["⌘/"], other: ["Ctrl+/"] },
  {
    action: "Close the topmost panel, dialog, or palette",
    macos: ["Escape"],
    other: ["Escape"],
  },
  // Object table navigation. Arrow/Home/End/Page keys are handled by
  // browser.ts; Space and Enter by app-events.ts.
  { action: "Move between objects", macos: ["↑", "↓"], other: ["↑", "↓"] },
  {
    action: "Extend selection between objects",
    macos: ["⇧↑", "⇧↓"],
    other: ["Shift+↑", "Shift+↓"],
  },
  {
    action: "Jump to the first or last object",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  {
    action: "Page through objects",
    macos: ["Page Up", "Page Down"],
    other: ["Page Up", "Page Down"],
  },
  {
    action: "Toggle the focused object's selection",
    macos: ["Space"],
    other: ["Space"],
  },
  {
    action: "Open or preview the focused object",
    macos: ["Enter"],
    other: ["Enter"],
  },
  {
    action: "Open the focused object's context menu",
    macos: ["⇧F10", "Context Menu"],
    other: ["Shift+F10", "Context Menu"],
  },
  {
    action: "Jump to an object by typing its name",
    macos: ["Type letters"],
    other: ["Type letters"],
  },
  // Bucket list roving focus.
  {
    action: "Move between buckets",
    macos: ["↑", "↓"],
    other: ["↑", "↓"],
  },
  {
    action: "Jump to the first or last bucket",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  // Inspector tabs and the sidebar/inspector resizers.
  {
    action: "Move between tabs",
    macos: ["←", "→", "Home", "End"],
    other: ["←", "→", "Home", "End"],
  },
  {
    action: "Resize the sidebar or inspector",
    macos: ["←", "→"],
    other: ["←", "→"],
  },
  {
    action: "Jump to a panel width limit",
    macos: ["Home", "End"],
    other: ["Home", "End"],
  },
  {
    action: "Resize in larger steps",
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
