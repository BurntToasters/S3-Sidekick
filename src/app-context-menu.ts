import { state } from "./state.ts";
import {
  navigateToFolder,
  reportNavFailure,
  selectBucket,
  updateSelectionUI,
} from "./browser.ts";
import { showContextMenu, type MenuItem } from "./context-menu.ts";
import { openInfoPanel } from "./info-panel.ts";
import { canPreview, openPreview } from "./preview.ts";
import { basename, friendlyError, plural } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { closeSidebarOnMobile } from "./app-layout.ts";
import {
  addSelection,
  clearAllSelection,
  getSelectedFileKeys,
  getSelectedPrefixes,
  entryFromRow,
  getSelectionEntries,
  isSelected,
} from "./app-selection.ts";
import {
  handleDelete,
  handleCopyUrl,
  handleCopyPresignedUrl,
  handleCopyKey,
  handleCopyArn,
  handleRename,
  handleCreateFolder,
  handleRefresh,
  handleRefreshBuckets,
  isAwsEndpoint,
} from "./app-objects.ts";
import { handleDownload } from "./app-downloads.ts";
import { handleUploadButton, handleUploadFolderButton } from "./app-upload.ts";
import { openCopyMoveDialog } from "./app-copy-move.ts";

/** The selection an object context menu is built from. */
export interface ObjectMenuSelection {
  files: string[];
  folders: string[];
  /** The one selected file has a preview type. */
  canPreview: boolean;
  /** The endpoint is AWS, so ARNs describe the object. */
  arnSupported: boolean;
  /** The provider verifies conditional DELETE, so Move is offered. */
  moveSupported: boolean;
}

const MOVE_UNSUPPORTED_REASON =
  "This provider can't safely delete the source. Use Copy, then Delete.";
const FOLDER_DOWNLOAD_REASON =
  "Folders can't be downloaded. Select files only.";
const FOLDER_URL_REASON = "Folders have no URL. Select files only.";
const PRESIGNED_MULTI_REASON =
  "Pre-signed URLs are made for one file at a time.";
const RENAME_MULTI_REASON = "Select one item to rename.";

function pushCopyMove(items: MenuItem[], moveSupported: boolean): void {
  if (moveSupported) {
    items.push({ label: "Copy / Move to...", action: "copy-move" });
    return;
  }
  items.push({ label: "Copy to...", action: "copy-move" });
  items.push({
    label: "Move to...",
    action: "copy-move",
    disabled: true,
    disabledReason: MOVE_UNSUPPORTED_REASON,
  });
}

/**
 * Menu entries for a selection. Actions that only apply to some selected
 * kinds stay visible but disabled with the reason, so mixed selections never
 * offer an action that would silently skip part of the selection.
 */
export function buildObjectMenuItems(
  selection: ObjectMenuSelection,
): MenuItem[] {
  const { files, folders, canPreview: previewable } = selection;
  const total = files.length + folders.length;
  const items: MenuItem[] = [];
  if (total === 0) return items;

  if (total === 1 && folders.length === 1) {
    items.push({ label: "Open", action: "open-folder" });
    items.push({ label: "Properties", action: "info" });
    items.push({ label: "Copy Path", action: "copy-key" });
    if (selection.arnSupported) {
      items.push({ label: "Copy ARN", action: "copy-arn" });
    }
    items.push({ label: "Rename", action: "rename", shortcut: "F2" });
    pushCopyMove(items, selection.moveSupported);
    items.push({ separator: true });
    items.push({ label: "Delete Folder", action: "delete" });
    return items;
  }

  if (total === 1) {
    if (previewable) items.push({ label: "Preview", action: "preview" });
    items.push({ label: "Properties", action: "info" });
    items.push({ label: "Download", action: "download" });
    items.push({ label: "Copy URL", action: "copy-url" });
    items.push({ label: "Copy Pre-Signed URL", action: "copy-presigned-url" });
    items.push({ label: "Copy Key", action: "copy-key" });
    if (selection.arnSupported) {
      items.push({ label: "Copy ARN", action: "copy-arn" });
    }
    items.push({ label: "Rename", action: "rename", shortcut: "F2" });
    pushCopyMove(items, selection.moveSupported);
    items.push({ separator: true });
    items.push({ label: "Delete", action: "delete" });
    return items;
  }

  const mixed = files.length > 0 && folders.length > 0;
  items.push({
    label: `Properties (${plural(total, "item")})`,
    action: "info",
  });
  if (files.length > 0) {
    items.push({
      label: `Download ${plural(files.length, "file")}`,
      action: "download",
      disabled: mixed,
      disabledReason: mixed ? FOLDER_DOWNLOAD_REASON : undefined,
    });
  }
  items.push({
    label: `Copy ${plural(total, files.length === 0 ? "path" : "key")}`,
    action: "copy-key",
  });
  if (files.length > 0) {
    items.push({
      label: `Copy ${plural(files.length, "URL")}`,
      action: "copy-url",
      disabled: mixed,
      disabledReason: mixed ? FOLDER_URL_REASON : undefined,
    });
    items.push({
      label: "Copy Pre-Signed URL",
      action: "copy-presigned-url",
      disabled: true,
      disabledReason: PRESIGNED_MULTI_REASON,
    });
  }
  if (selection.arnSupported) {
    items.push({ label: `Copy ${plural(total, "ARN")}`, action: "copy-arn" });
  }
  items.push({
    label: "Rename",
    action: "rename",
    disabled: true,
    disabledReason: RENAME_MULTI_REASON,
  });
  pushCopyMove(items, selection.moveSupported);
  items.push({ separator: true });
  const deleteLabel =
    files.length > 0 && folders.length > 0
      ? `Delete ${plural(files.length, "file")} and ${plural(folders.length, "folder")}`
      : folders.length > 0
        ? `Delete ${plural(folders.length, "folder")}`
        : `Delete ${plural(files.length, "item")}`;
  items.push({ label: deleteLabel, action: "delete" });
  return items;
}

export function handleContextMenu(e: MouseEvent): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".object-row");
  if (!row) {
    if ((e.target as HTMLElement).closest("#object-panel")) {
      e.preventDefault();
      showContextMenu(
        e.clientX,
        e.clientY,
        [
          { label: "New Folder", action: "new-folder" },
          { label: "Upload Files", action: "upload-files" },
          { label: "Upload Folder", action: "upload-folder" },
          { separator: true },
          { label: "Refresh", action: "refresh" },
        ],
        (action) => {
          if (action === "new-folder") void handleCreateFolder();
          else if (action === "upload-files") void handleUploadButton();
          else if (action === "upload-folder") void handleUploadFolderButton();
          else if (action === "refresh") void handleRefresh();
        },
      );
    }
    return;
  }
  e.preventDefault();

  const rowEntry = entryFromRow(row);
  if (rowEntry && !isSelected(rowEntry)) {
    clearAllSelection();
    addSelection(rowEntry);
    updateSelectionUI();
  }

  const fileKeys = getSelectedFileKeys();
  const folderKeys = getSelectedPrefixes();
  const items = buildObjectMenuItems({
    files: fileKeys,
    folders: folderKeys,
    canPreview:
      fileKeys.length === 1 &&
      folderKeys.length === 0 &&
      canPreview(basename(fileKeys[0])),
    arnSupported: isAwsEndpoint(state.endpoint),
    moveSupported: state.conditionalDeleteSupported,
  });
  if (items.length === 0) return;

  const selectedEntries = getSelectionEntries();

  showContextMenu(e.clientX, e.clientY, items, (action) => {
    if (action === "preview") void openPreview(fileKeys[0]);
    else if (action === "info") void openInfoPanel(selectedEntries);
    else if (action === "download") void handleDownload();
    else if (action === "copy-url") void handleCopyUrl();
    else if (action === "copy-presigned-url") void handleCopyPresignedUrl();
    else if (action === "copy-key") void handleCopyKey();
    else if (action === "copy-arn") void handleCopyArn();
    else if (action === "rename") void handleRename();
    else if (action === "copy-move") openCopyMoveDialog();
    else if (action === "delete") void handleDelete();
    else if (action === "open-folder") {
      const prefix = folderKeys[0];
      const open = (): void => {
        void navigateToFolder(prefix).catch((err) => {
          reportNavFailure(
            `Failed to open folder: ${friendlyError(err)}`,
            open,
          );
        });
      };
      open();
    }
  });
}

export function handleBucketContextMenu(e: MouseEvent): void {
  if (!state.connected) return;

  const bucketButton = (e.target as HTMLElement).closest<HTMLElement>(
    ".list__item-btn",
  );
  const inBucketPanel = (e.target as HTMLElement).closest("#bucket-panel");
  if (!inBucketPanel) return;

  e.preventDefault();

  if (bucketButton?.dataset.bucket) {
    const bucket = bucketButton.dataset.bucket;
    const menuItems: MenuItem[] = [
      { label: "Open Bucket", action: "open-bucket" },
      { label: "Copy Bucket Name", action: "copy-bucket-name" },
    ];
    if (isAwsEndpoint(state.endpoint)) {
      menuItems.push({ label: "Copy Bucket ARN", action: "copy-bucket-arn" });
    }
    menuItems.push({ separator: true });
    menuItems.push({ label: "Refresh Buckets", action: "refresh-buckets" });

    showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
      if (action === "open-bucket") {
        const open = (): void => {
          void selectBucket(bucket)
            .then(() => closeSidebarOnMobile())
            .catch((err) => {
              reportNavFailure(
                `Failed to open bucket "${bucket}": ${friendlyError(err)}`,
                open,
              );
            });
        };
        open();
      } else if (action === "copy-bucket-name") {
        void navigator.clipboard
          .writeText(bucket)
          .then(() => setStatus(`Copied bucket name "${bucket}".`, 3000))
          .catch((err) => setStatus(`Failed to copy bucket name: ${err}`));
      } else if (action === "copy-bucket-arn") {
        const arn = `arn:aws:s3:::${bucket}`;
        void navigator.clipboard
          .writeText(arn)
          .then(() => setStatus(`Copied bucket ARN.`, 3000))
          .catch((err) => setStatus(`Failed to copy ARN: ${err}`));
      } else if (action === "refresh-buckets") {
        void handleRefreshBuckets();
      }
    });
    return;
  }

  showContextMenu(
    e.clientX,
    e.clientY,
    [{ label: "Refresh Buckets", action: "refresh-buckets" }],
    () => {
      void handleRefreshBuckets();
    },
  );
}
