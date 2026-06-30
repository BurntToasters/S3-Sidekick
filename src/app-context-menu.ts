import { state } from "./state.ts";
import {
  navigateToFolder,
  selectBucket,
  updateSelectionUI,
} from "./browser.ts";
import { showContextMenu, type MenuItem } from "./context-menu.ts";
import { openInfoPanel } from "./info-panel.ts";
import { canPreview, openPreview } from "./preview.ts";
import { basename, friendlyError } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { closeSidebarOnMobile } from "./app-layout.ts";
import { getSelectedFileKeys } from "./app-selection.ts";
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
} from "./app-objects.ts";
import { handleDownload } from "./app-downloads.ts";
import { handleUploadButton, handleUploadFolderButton } from "./app-upload.ts";
import { openCopyMoveDialog } from "./app-copy-move.ts";

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

  const key = row.dataset.key ?? "";
  const prefix = row.dataset.prefix ?? "";
  const isFolder = row.classList.contains("object-row--folder");
  const itemKey = isFolder ? "prefix:" + prefix : key;

  if (!state.selectedKeys.has(itemKey)) {
    state.selectedKeys.clear();
    state.selectedKeys.add(itemKey);
    updateSelectionUI();
  }

  const selectedCount = state.selectedKeys.size;
  const fileKeys = getSelectedFileKeys();
  const hasFiles = fileKeys.length > 0;

  const folderKeys = Array.from(state.selectedKeys).filter((k) =>
    k.startsWith("prefix:"),
  );
  const hasFolders = folderKeys.length > 0;
  const items: MenuItem[] = [];

  if (isFolder && selectedCount === 1) {
    items.push({ label: "Open", action: "open-folder" });
    items.push({ label: "Copy Path", action: "copy-key" });
    items.push({ label: "Copy ARN", action: "copy-arn" });
    items.push({ label: "Rename", action: "rename" });
    items.push({ label: "Copy / Move to...", action: "copy-move" });
    items.push({ separator: true });
    items.push({ label: "Delete Folder", action: "delete" });
  } else if (hasFiles) {
    if (selectedCount === 1 && !hasFolders) {
      const fileName = basename(fileKeys[0]);
      if (canPreview(fileName)) {
        items.push({ label: "Preview", action: "preview" });
      }
      items.push({ label: "Properties", action: "info" });
      items.push({ label: "Download", action: "download" });
      items.push({ label: "Copy URL", action: "copy-url" });
      items.push({
        label: "Copy Pre-Signed URL",
        action: "copy-presigned-url",
      });
      items.push({ label: "Copy Key", action: "copy-key" });
      items.push({ label: "Copy ARN", action: "copy-arn" });
      items.push({ label: "Rename", action: "rename" });
      items.push({ label: "Copy / Move to...", action: "copy-move" });
    } else {
      items.push({
        label: `Properties (${fileKeys.length} items)`,
        action: "info",
      });
      items.push({
        label: `Download ${fileKeys.length} items`,
        action: "download",
      });
      items.push({ label: "Copy Keys", action: "copy-key" });
      items.push({ label: "Copy URLs", action: "copy-url" });
      items.push({ label: "Copy ARNs", action: "copy-arn" });
      items.push({ label: "Copy / Move to...", action: "copy-move" });
    }
    items.push({ separator: true });
    const deleteLabel = hasFolders
      ? `Delete ${fileKeys.length} file${fileKeys.length === 1 ? "" : "s"} + ${folderKeys.length} folder${folderKeys.length === 1 ? "" : "s"}`
      : selectedCount === 1
        ? "Delete"
        : `Delete ${fileKeys.length} items`;
    items.push({ label: deleteLabel, action: "delete" });
  }

  if (items.length === 0) return;

  showContextMenu(e.clientX, e.clientY, items, (action) => {
    if (action === "preview") void openPreview(fileKeys[0]);
    else if (action === "info") void openInfoPanel(fileKeys);
    else if (action === "download") void handleDownload();
    else if (action === "copy-url") void handleCopyUrl();
    else if (action === "copy-presigned-url") void handleCopyPresignedUrl();
    else if (action === "copy-key") void handleCopyKey();
    else if (action === "copy-arn") void handleCopyArn();
    else if (action === "rename") void handleRename();
    else if (action === "copy-move") openCopyMoveDialog();
    else if (action === "delete") void handleDelete();
    else if (action === "open-folder") void navigateToFolder(prefix);
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
      { label: "Copy Bucket ARN", action: "copy-bucket-arn" },
      { separator: true },
      { label: "Refresh Buckets", action: "refresh-buckets" },
    ];

    showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
      if (action === "open-bucket") {
        void selectBucket(bucket)
          .then(() => closeSidebarOnMobile())
          .catch((err) => {
            setStatus(
              `Failed to open bucket "${bucket}": ${friendlyError(err)}`,
            );
            logActivity(
              `Failed to open bucket "${bucket}": ${friendlyError(err)}`,
              "error",
            );
          });
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
