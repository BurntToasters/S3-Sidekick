import { state } from "./state.ts";
import { protocolLabels, sessionProtocol } from "./protocol-labels.ts";
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
  isOfferedFor,
  isSftpContext,
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

  // A registry entry's disabled reason (a non-UTF-8 name, for example) becomes
  // the menu item's disabled state, so the menu and the bar agree.
  const entry = (id: string): MenuAction => {
    const action = getObjectAction(id);
    if (!action) throw new Error(`Unknown object action: ${id}`);
    const blocked = action.disabledReason?.(selection) ?? null;
    return {
      label: resolveActionLabel(action, selection),
      action: id,
      icon: action.icon,
      shortcut: action.shortcut,
      danger: action.danger,
      ...(blocked === null ? {} : { disabled: true, disabledReason: blocked }),
    };
  };
  const disabledEntry = (id: string, reason: string): MenuAction => ({
    ...entry(id),
    disabled: true,
    disabledReason: reason,
  });
  // The registry decides what the menu offers for this selection. S3-only
  // entries are left out over SFTP; no menu keeps its own list of them.
  const offer = (id: string): void => {
    if (isOfferedFor(id, selection)) items.push(entry(id));
  };
  const offerDisabled = (id: string, reason: string): void => {
    if (isOfferedFor(id, selection)) items.push(disabledEntry(id, reason));
  };
  const moveUnsupported = !selection.moveSupported;

  if (total === 1 && folderPrefixes.length === 1) {
    items.push(entry("open-folder"));
    items.push(entry("properties"));
    // SFTP only: a folder downloads the files directly inside it.
    if (isSftpContext(selection)) items.push(entry("download"));
    items.push(entry("copy-keys"));
    if (selection.arnSupported) offer("copy-arns");
    offer("copy-s3-uri");
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
    offer("copy-url");
    offer("share-link");
    items.push(entry("copy-keys"));
    if (selection.arnSupported) offer("copy-arns");
    offer("copy-s3-uri");
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
  if (isSftpContext(selection)) {
    // SFTP downloads files and folders alike (a folder's own files), so a
    // mixed or folder-only selection offers Download.
    items.push(entry("download"));
  } else if (fileKeys.length > 0) {
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
      offerDisabled("copy-url", "Folders have no URL. Select files only.");
    } else {
      offer("copy-url");
    }
    offerDisabled(
      "share-link",
      "Pre-signed URLs are made for one file at a time.",
    );
  }
  if (selection.arnSupported) offer("copy-arns");
  offer("copy-s3-uri");
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
          { label: "Upload files", action: "upload-files" },
          { label: "Upload folder", action: "upload-folder" },
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
    const labels = protocolLabels(sessionProtocol(state));
    const menuItems: MenuItem[] = [
      { label: labels.openAction, action: "open-bucket" },
      { label: labels.copyNameAction, action: "copy-bucket-name" },
    ];
    if (isAwsEndpoint(state.endpoint)) {
      menuItems.push({ label: "Copy bucket ARN", action: "copy-bucket-arn" });
    }
    menuItems.push({ separator: true });
    menuItems.push({ label: labels.refreshAction, action: "refresh-buckets" });

    showContextMenu(e.clientX, e.clientY, menuItems, (action) => {
      if (action === "open-bucket") {
        const open = (): void => {
          void selectBucket(bucket)
            .then(() => closeSidebarOnMobile())
            .catch((err) => {
              reportNavFailure(
                `${labels.openFailed} "${bucket}": ${friendlyError(err)}`,
                open,
              );
            });
        };
        open();
      } else if (action === "copy-bucket-name") {
        void navigator.clipboard
          .writeText(bucket)
          .then(() => setStatus(`${labels.copiedName} "${bucket}".`, 3000))
          .catch((err) => setStatus(`${labels.copyNameFailed}: ${err}`));
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
    [
      {
        label: protocolLabels(sessionProtocol(state)).refreshAction,
        action: "refresh-buckets",
      },
    ],
    () => {
      void handleRefreshBuckets();
    },
  );
}
