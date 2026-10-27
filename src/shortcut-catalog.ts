/**
 * The one list of keyboard shortcuts shown to the user. Every entry must be
 * handled by `wireKeyboardShortcuts` in keyboard.ts (or the Escape branch
 * there); do not list a chord the app does not act on.
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
