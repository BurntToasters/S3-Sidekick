import { state } from "./state.ts";
import {
  getSelectedFileKeys,
  getSelectedPrefixes,
  getSelectionEntries,
} from "./app-selection.ts";
import { canPreview, openPreview } from "./preview.ts";
import { openInfoPanel } from "./info-panel.ts";
import { basename, friendlyError, plural } from "./utils.ts";
import { invokeS3 } from "./connection.ts";
import {
  isAwsEndpoint,
  handleCopyArn,
  handleCopyKey,
  handleCopyUrl,
  handleDelete,
  handleRename,
} from "./app-objects.ts";
import { handleDownload } from "./app-downloads.ts";
import { openCopyMoveDialog } from "./app-copy-move.ts";
import { setStatus } from "./app-status.ts";
import { logActivity } from "./activity-log.ts";
import { SHORTCUTS } from "./shortcut-catalog.ts";
import {
  navigateToFolder,
  reportNavFailure,
  clearSelection,
} from "./browser.ts";

/**
 * The one registry for object actions. The selection bar, the batch More
 * menu, the object context menu and the palette's selection commands all
 * render from these entries, so a label or availability rule exists exactly
 * once. Shortcut hints come from `SHORTCUTS` in shortcut-catalog.ts, never
 * from a second list.
 */
export interface ObjectActionContext {
  fileKeys: string[];
  folderPrefixes: string[];
  total: number;
  arnSupported: boolean;
  moveSupported: boolean;
  canPreviewSingle: boolean;
  listingLoading: boolean;
  deleteInFlight: boolean;
}

export type ObjectActionGroup =
  "open" | "transfer" | "clipboard" | "danger" | "selection";

/** A label is either fixed or derived from the live selection context. */
export type ObjectActionLabel =
  string | ((context: ObjectActionContext) => string);

export interface ObjectAction {
  id: string;
  label: ObjectActionLabel;
  icon: string;
  shortcut?: string;
  danger?: boolean;
  group: ObjectActionGroup;
  /** Extra words that find the command in the palette. */
  keywords?: string[];
  /** Whether the palette lists this action (default true). */
  palette?: boolean;
  isAvailable: (context: ObjectActionContext) => boolean;
  run: (context: ObjectActionContext) => void;
}

const MOVE_UNSUPPORTED_REASON =
  "This provider can't safely delete the source. Use Copy, then Delete.";

export function currentActionContext(): ObjectActionContext {
  const fileKeys = getSelectedFileKeys();
  const folderPrefixes = getSelectedPrefixes();
  const objectPanel = document.getElementById("object-panel");
  const deleteButton = document.getElementById("batch-delete");
  return {
    fileKeys,
    folderPrefixes,
    total: fileKeys.length + folderPrefixes.length,
    arnSupported: isAwsEndpoint(state.endpoint),
    moveSupported: state.conditionalDeleteSupported,
    canPreviewSingle:
      fileKeys.length === 1 && canPreview(basename(fileKeys[0])),
    listingLoading: objectPanel?.getAttribute("aria-busy") === "true",
    deleteInFlight: deleteButton?.dataset.operationInFlight === "true",
  };
}

export function getObjectAction(id: string): ObjectAction | undefined {
  return OBJECT_ACTIONS.find((action) => action.id === id);
}

export function resolveActionLabel(
  action: ObjectAction,
  context: ObjectActionContext,
): string {
  return typeof action.label === "function"
    ? action.label(context)
    : action.label;
}

/** Platform shortcut hint from the shared catalog, or undefined. */
export function shortcutLabelFor(catalogAction: string): string | undefined {
  const entry = SHORTCUTS.find(
    (candidate) => candidate.action === catalogAction,
  );
  if (!entry) return undefined;
  const keys = state.platformName === "macos" ? entry.macos : entry.other;
  return keys[keys.length - 1];
}

/** Runs a registry action by id against the given context. */
export function runObjectAction(
  id: string,
  context: ObjectActionContext,
): void {
  getObjectAction(id)?.run(context);
}

function downloadLabel(context: ObjectActionContext): string {
  const files = context.fileKeys.length;
  return files > 1 ? `Download ${plural(files, "file")}` : "Download";
}

function copyUrlLabel(context: ObjectActionContext): string {
  const files = context.fileKeys.length;
  return files > 1 ? "Copy URLs" : "Copy URL";
}

function copyKeysLabel(context: ObjectActionContext): string {
  return context.total > 1
    ? `Copy ${plural(context.total, "key")}`
    : "Copy keys";
}

function copyArnsLabel(context: ObjectActionContext): string {
  return context.total > 1
    ? `Copy ${plural(context.total, "ARN")}`
    : "Copy ARNs";
}

function propertiesLabel(context: ObjectActionContext): string {
  return context.total > 1
    ? `Properties (${plural(context.total, "item")})`
    : "Properties";
}

function deleteLabel(context: ObjectActionContext): string {
  const { fileKeys, folderPrefixes, total } = context;
  if (total === 1) {
    return folderPrefixes.length === 1 ? "Delete Folder" : "Delete";
  }
  if (fileKeys.length > 0 && folderPrefixes.length > 0) {
    return `Delete ${plural(fileKeys.length, "file")} and ${plural(folderPrefixes.length, "folder")}`;
  }
  if (folderPrefixes.length > 0) {
    return `Delete ${plural(folderPrefixes.length, "folder")}`;
  }
  return `Delete ${plural(fileKeys.length, "item")}`;
}

function runOpenFolder(context: ObjectActionContext): void {
  const prefix = context.folderPrefixes[0];
  if (prefix === undefined) return;
  const open = (): void => {
    void navigateToFolder(prefix).catch((err) => {
      reportNavFailure(`Failed to open folder: ${friendlyError(err)}`, open);
    });
  };
  open();
}

async function copyS3Uris(context: ObjectActionContext): Promise<void> {
  const bucket = state.currentBucket;
  if (!bucket) return;
  const uris = [...context.fileKeys, ...context.folderPrefixes].map(
    (key) => `s3://${bucket}/${key}`,
  );
  if (uris.length === 0) return;
  try {
    await navigator.clipboard.writeText(uris.join("\n"));
    setStatus(
      uris.length === 1
        ? "S3 URI copied to clipboard."
        : `Copied ${uris.length} S3 URIs to clipboard.`,
      5000,
    );
    logActivity(
      uris.length === 1
        ? `Copied S3 URI: ${uris[0]}`
        : `Copied ${uris.length} S3 URIs.`,
      "success",
    );
  } catch (err) {
    setStatus(`Failed to copy S3 URI: ${friendlyError(err)}`);
    logActivity(`Failed to copy S3 URI: ${friendlyError(err)}`, "error");
  }
}

const OBJECT_ACTIONS: readonly ObjectAction[] = [
  {
    id: "preview",
    label: "Preview",
    icon: "eye",
    group: "open",
    isAvailable: (context) =>
      context.total === 1 &&
      context.fileKeys.length === 1 &&
      context.canPreviewSingle,
    run: (context) => void openPreview(context.fileKeys[0]),
  },
  {
    id: "open-folder",
    label: "Open",
    icon: "folder-open",
    group: "open",
    palette: false,
    isAvailable: (context) =>
      context.total === 1 && context.folderPrefixes.length === 1,
    run: runOpenFolder,
  },
  {
    id: "properties",
    label: propertiesLabel,
    icon: "info",
    group: "open",
    keywords: ["info", "details"],
    isAvailable: (context) => context.total > 0 && !context.listingLoading,
    run: () => {
      const entries = getSelectionEntries();
      if (entries.length > 0) void openInfoPanel(entries);
    },
  },
  {
    id: "download",
    label: downloadLabel,
    icon: "download",
    group: "transfer",
    isAvailable: (context) => context.fileKeys.length > 0,
    run: () => void handleDownload(),
  },
  {
    id: "copy-move",
    label: (context) =>
      context.moveSupported ? "Copy / Move\u2026" : "Copy to\u2026",
    icon: "folder",
    group: "transfer",
    keywords: ["duplicate", "destination"],
    isAvailable: (context) => context.total > 0,
    run: () => openCopyMoveDialog(),
  },
  {
    id: "move",
    label: "Move to\u2026",
    icon: "folder",
    group: "transfer",
    palette: false,
    isAvailable: (context) => context.total > 0 && !context.moveSupported,
    run: () => openCopyMoveDialog(),
  },
  {
    id: "rename",
    label: "Rename",
    icon: "pencil",
    group: "transfer",
    shortcut: shortcutLabelFor("Rename selected item"),
    keywords: ["move", "name"],
    isAvailable: (context) => context.total === 1,
    run: () => void handleRename(),
  },
  {
    id: "copy-url",
    label: copyUrlLabel,
    icon: "external-link",
    group: "clipboard",
    keywords: ["link", "url"],
    isAvailable: (context) => context.fileKeys.length > 0,
    run: () => void handleCopyUrl(),
  },
  {
    id: "share-link",
    label: "Share link\u2026",
    icon: "share-2",
    group: "clipboard",
    keywords: ["presigned", "url", "link", "share"],
    isAvailable: (context) =>
      context.total === 1 && context.fileKeys.length === 1,
    run: () => openShareLinkDialog(),
  },
  {
    id: "copy-keys",
    label: copyKeysLabel,
    icon: "copy",
    group: "clipboard",
    keywords: ["path", "name"],
    isAvailable: (context) => context.total > 0,
    run: () => void handleCopyKey(),
  },
  {
    id: "copy-arns",
    label: copyArnsLabel,
    icon: "copy",
    group: "clipboard",
    keywords: ["amazon resource name"],
    isAvailable: (context) => context.total > 0 && context.arnSupported,
    run: () => void handleCopyArn(),
  },
  {
    id: "copy-s3-uri",
    label: "Copy S3 URI",
    icon: "copy",
    group: "clipboard",
    keywords: ["uri", "bucket"],
    isAvailable: (context) => context.total > 0 && state.currentBucket !== "",
    run: (context) => void copyS3Uris(context),
  },
  {
    id: "delete",
    label: deleteLabel,
    icon: "trash-2",
    group: "danger",
    danger: true,
    shortcut: shortcutLabelFor("Delete selected items"),
    keywords: ["trash", "remove"],
    isAvailable: (context) => context.total > 0,
    run: () => void handleDelete(),
  },
  {
    id: "deselect-all",
    label: "Deselect All",
    icon: "x-square",
    group: "selection",
    isAvailable: (context) => context.total > 0,
    run: () => clearSelection(),
  },
];

/** The fixed batch More menu: the actions the bar itself does not show. */
export const MORE_MENU_ACTION_IDS = [
  "copy-keys",
  "copy-arns",
  "share-link",
  "copy-s3-uri",
  "properties",
] as const;

/** Selection-bar buttons, in display order, mapped from registry ids. */
const BAR_BUTTON_BY_ACTION: Readonly<Record<string, string>> = {
  download: "batch-download",
  "copy-move": "batch-copy-move",
  rename: "batch-rename",
  "copy-url": "batch-copy-urls",
  delete: "batch-delete",
  "deselect-all": "batch-deselect",
};

/**
 * Syncs the selection bar's labels and visibility from the registry. Called
 * whenever the bar's selection state changes, so the bar shows "Copy URL"
 * for one file, "Copy URLs" for many, and Rename only for a single item.
 */
export function syncSelectionBar(): void {
  const actions = document.getElementById("batch-toolbar-actions");
  if (!actions || actions.hidden) return;
  const context = currentActionContext();
  if (context.total === 0) return;

  for (const [id, buttonId] of Object.entries(BAR_BUTTON_BY_ACTION)) {
    const entry = getObjectAction(id);
    const button = document.getElementById(buttonId);
    if (!entry || !button) continue;
    const text = resolveActionLabel(entry, context);
    const label = button.querySelector<HTMLElement>(".batch-toolbar__label");
    if (label) label.textContent = text;
  }

  const renameButton = document.getElementById(
    "batch-rename",
  ) as HTMLButtonElement | null;
  if (renameButton) {
    renameButton.hidden = context.total !== 1;
    renameButton.disabled = context.listingLoading;
  }
}

/* Share link dialog: an expiry select plus a Copy action over the existing
   generate_presigned_url command. */

const SHARE_EXPIRY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21600, label: "6 hours" },
  { value: 43200, label: "12 hours" },
  { value: 86400, label: "24 hours" },
  { value: 604800, label: "7 days" },
];

function formatExpiration(seconds: number): string {
  const withUnit = (value: number, unit: "minute" | "hour" | "day") =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 3600) {
    return withUnit(Math.max(1, Math.round(seconds / 60)), "minute");
  }
  if (seconds < 86400) return withUnit(Math.round(seconds / 3600), "hour");
  return withUnit(Math.round(seconds / 86400), "day");
}

function closeShareLinkDialog(
  overlay: HTMLElement,
  opener: HTMLElement | null,
): void {
  overlay.remove();
  if (opener && document.contains(opener)) opener.focus();
}

/**
 * Share link… for one selected file: pick an expiry (defaulting to the
 * user's settings) and copy a pre-signed URL for it.
 */
export function openShareLinkDialog(): void {
  const keys = getSelectedFileKeys();
  if (keys.length !== 1 || !state.currentBucket) return;
  const key = keys[0];
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const overlay = document.createElement("div");
  overlay.id = "share-link-overlay";
  overlay.className = "dialog-overlay active share-link-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "share-link-title");

  const box = document.createElement("div");
  box.className = "dialog-box share-link-dialog";

  const title = document.createElement("div");
  title.id = "share-link-title";
  title.className = "dialog-box__title";
  title.textContent = "Share link\u2026";
  box.appendChild(title);

  const message = document.createElement("p");
  message.className = "dialog-box__message";
  message.textContent = `Create a pre-signed share link for ${basename(key)}.`;
  box.appendChild(message);

  const fieldLabel = document.createElement("label");
  fieldLabel.className = "share-link-field";
  const fieldText = document.createElement("span");
  fieldText.textContent = "Expires in";
  const select = document.createElement("select");
  select.id = "share-link-expiry";
  select.className = "field field--sm";
  for (const option of SHARE_EXPIRY_OPTIONS) {
    const optionEl = document.createElement("option");
    optionEl.value = String(option.value);
    optionEl.textContent = option.label;
    select.appendChild(optionEl);
  }
  const fallbackExpiry = SHARE_EXPIRY_OPTIONS.some(
    (option) => option.value === state.currentSettings.presignedUrlExpiration,
  )
    ? state.currentSettings.presignedUrlExpiration
    : 3600;
  select.value = String(fallbackExpiry);
  fieldLabel.append(fieldText, select);
  box.appendChild(fieldLabel);

  const actions = document.createElement("div");
  actions.className = "dialog-box__actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "share-link-cancel";
  cancel.className = "btn btn--ghost";
  cancel.textContent = "Cancel";
  const copy = document.createElement("button") as HTMLButtonElement;
  copy.type = "button";
  copy.id = "share-link-copy";
  copy.className = "btn btn--primary";
  copy.textContent = "Copy";
  actions.append(cancel, copy);
  box.appendChild(actions);
  overlay.appendChild(box);

  const close = (): void => closeShareLinkDialog(overlay, opener);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  cancel.addEventListener("click", close);
  copy.addEventListener("click", () => {
    copy.disabled = true;
    void (async () => {
      const expiresInSecs = Number.parseInt(select.value, 10);
      try {
        const url = await invokeS3<string>("generate_presigned_url", {
          bucket: state.currentBucket,
          key,
          expiresInSecs,
        });
        await navigator.clipboard.writeText(url);
        setStatus(
          `Share link copied (expires in ${formatExpiration(expiresInSecs)}).`,
          5000,
        );
        logActivity(`Copied share link for ${basename(key)}.`, "success");
      } catch (err) {
        setStatus(`Failed to create share link: ${friendlyError(err)}`);
        logActivity(
          `Failed to create share link: ${friendlyError(err)}`,
          "error",
        );
      } finally {
        close();
      }
    })();
  });

  document.body.appendChild(overlay);
  select.focus();
}

export { MOVE_UNSUPPORTED_REASON };
