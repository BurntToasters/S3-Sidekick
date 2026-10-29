import { state } from "./state.ts";
import {
  reportNavFailure,
  selectBucket,
  updateSelectionUI,
} from "./browser.ts";
import {
  showContextMenu,
  type MenuItem,
  type MenuAction,
} from "./context-menu.ts";
import { friendlyError } from "./utils.ts";
import { setStatus } from "./app-status.ts";
import { closeSidebarOnMobile } from "./app-layout.ts";
import {
  addSelection,
  clearAllSelection,
  entryFromRow,
  isSelected,
} from "./app-selection.ts";
import {
  handleCreateFolder,
  handleRefresh,
  handleRefreshBuckets,
  isAwsEndpoint,
} from "./app-objects.ts";
import { handleUploadButton, handleUploadFolderButton } from "./app-upload.ts";
import {
  currentActionContext,
  getObjectAction,
  resolveActionLabel,
  runObjectAction,
  MOVE_UNSUPPORTED_REASON,
  type ObjectActionContext,
} from "./object-actions.ts";

/**
 * Menu entries for a selection, rendered from the shared object-actions
 * registry. Actions that only apply to some selected kinds stay visible but
 * disabled with the reason, so mixed selections never offer an action that
 * would silently skip part of the selection.
 */
export function buildObjectMenuItems(
  selection: ObjectActionContext,
): MenuItem[] {
  const { fileKeys, folderPrefixes, total } = selection;
  const items: MenuItem[] = [];
  if (total === 0) return items;

  const entry = (id: string): MenuAction => {
    const action = getObjectAction(id);
    if (!action) throw new Error(`Unknown object action: ${id}`);
    return {
      label: resolveActionLabel(action, selection),
      action: id,
      icon: action.icon,
      shortcut: action.shortcut,
      danger: action.danger,
    };
  };
  const disabledEntry = (id: string, reason: string): MenuAction => ({
    ...entry(id),
    disabled: true,
    disabledReason: reason,
  });
  const moveUnsupported = !selection.moveSupported;

  if (total === 1 && folderPrefixes.length === 1) {
    items.push(entry("open-folder"));
    items.push(entry("properties"));
    items.push(entry("copy-keys"));
    if (selection.arnSupported) items.push(entry("copy-arns"));
    items.push(entry("copy-s3-uri"));
    items.push(entry("rename"));
    if (moveUnsupported) {
      // "Copy to…" stays usable; Move is listed disabled with the reason.
      items.push(entry("copy-move"));
      items.push(disabledEntry("move", MOVE_UNSUPPORTED_REASON));
    } else {
      items.push(entry("copy-move"));
    }
    items.push({ separator: true });
    items.push(entry("delete"));
    return items;
  }

  if (total === 1) {
    if (selection.canPreviewSingle) items.push(entry("preview"));
    items.push(entry("properties"));
    items.push(entry("download"));
    items.push(entry("copy-url"));
    items.push(entry("share-link"));
    items.push(entry("copy-keys"));
    if (selection.arnSupported) items.push(entry("copy-arns"));
    items.push(entry("copy-s3-uri"));
    items.push(entry("rename"));
    if (moveUnsupported) {
      // "Copy to…" stays usable; Move is listed disabled with the reason.
      items.push(entry("copy-move"));
      items.push(disabledEntry("move", MOVE_UNSUPPORTED_REASON));
    } else {
      items.push(entry("copy-move"));
    }
    items.push({ separator: true });
    items.push(entry("delete"));
    return items;
  }

  const mixed = fileKeys.length > 0 && folderPrefixes.length > 0;
  items.push(entry("properties"));
  if (fileKeys.length > 0) {
    if (mixed) {
      items.push(
        disabledEntry(
          "download",
          "Folders can't be downloaded. Select files only.",
        ),
      );
    } else {
      items.push(entry("download"));
    }
  }
  items.push(entry("copy-keys"));
  if (fileKeys.length > 0) {
    if (mixed) {
      items.push(
        disabledEntry("copy-url", "Folders have no URL. Select files only."),
      );
    } else {
      items.push(entry("copy-url"));
    }
    items.push(
      disabledEntry(
        "share-link",
        "Pre-signed URLs are made for one file at a time.",
      ),
    );
  }
  if (selection.arnSupported) items.push(entry("copy-arns"));
  items.push(entry("copy-s3-uri"));
  items.push(disabledEntry("rename", "Select one item to rename."));
  // "Copy to…" stays usable for multi-selection; Move is listed disabled
  // with the reason when the provider can't move objects.
  items.push(entry("copy-move"));
  if (moveUnsupported) {
    items.push(disabledEntry("move", MOVE_UNSUPPORTED_REASON));
  }
  items.push({ separator: true });
  items.push(entry("delete"));
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
          { label: "New folder", action: "new-folder" },
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

  const context = currentActionContext();
  const items = buildObjectMenuItems(context);
  if (items.length === 0) return;

  showContextMenu(e.clientX, e.clientY, items, (action) => {
    runObjectAction(action, context);
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
