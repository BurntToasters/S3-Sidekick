import { sftpPathFromKey } from "./sftp.ts";

/**
 * User-visible words for the two session kinds. An SFTP session has one
 * virtual bucket named after the server, so its sidebar, menus and messages say
 * server and folder. The S3 words are the defaults and what every disconnected
 * or locked state shows.
 */

export type LocationProtocol = "s3" | "sftp";

export interface ProtocolLabels {
  sidebarTitle: string;
  sidebarLabel: string;
  sidebarResizeLabel: string;
  sidebarToggleLabel: string;
  filterLabel: string;
  filterPlaceholder: string;
  noEntriesTitle: string;
  noEntriesText: string;
  noMatchTitle: string;
  noMatchText: string;
  chooseTitle: string;
  chooseText: string;
  showListLabel: string;
  emptyRootTitle: string;
  emptyRootText: string;
  openAction: string;
  copyNameAction: string;
  copiedName: string;
  copyNameFailed: string;
  refreshAction: string;
  refreshing: string;
  refreshed: string;
  refreshFailed: string;
  retryRefresh: string;
  openFailed: string;
  connectFirst: string;
  pathHint: string;
  pathPlaceholder: string;
  goToLabel: string;
  goToPrompt: string;
  goToPlaceholder: string;
}

const S3_LABELS: ProtocolLabels = {
  sidebarTitle: "Buckets",
  sidebarLabel: "Buckets",
  sidebarResizeLabel: "Resize bucket sidebar",
  sidebarToggleLabel: "Toggle buckets",
  filterLabel: "Filter buckets",
  filterPlaceholder: "Filter buckets…",
  noEntriesTitle: "No buckets found",
  noEntriesText: "This account has no buckets you can list here.",
  noMatchTitle: "No buckets match filter",
  noMatchText: "Try a different term in the bucket filter.",
  chooseTitle: "Choose a bucket",
  chooseText: "Select a bucket from the sidebar to browse objects.",
  showListLabel: "Show buckets",
  emptyRootTitle: "Empty bucket",
  emptyRootText: "This bucket is empty",
  openAction: "Open bucket",
  copyNameAction: "Copy bucket name",
  copiedName: "Copied bucket name",
  copyNameFailed: "Failed to copy bucket name",
  refreshAction: "Refresh buckets",
  refreshing: "Refreshing buckets…",
  refreshed: "Buckets refreshed.",
  refreshFailed: "Failed to refresh buckets",
  retryRefresh: "Retry bucket refresh",
  openFailed: "Failed to open bucket",
  connectFirst: "Connect to a bucket first.",
  pathHint: "Enter a path like bucket/prefix/",
  pathPlaceholder: "bucket/prefix/",
  goToLabel: "Go to key/prefix",
  goToPrompt: "Enter key or prefix:",
  goToPlaceholder: "e.g. folder/file.txt or folder/subfolder/",
};

const SFTP_LABELS: ProtocolLabels = {
  sidebarTitle: "Servers",
  sidebarLabel: "Servers",
  sidebarResizeLabel: "Resize server sidebar",
  sidebarToggleLabel: "Toggle servers",
  filterLabel: "Filter servers",
  filterPlaceholder: "Filter…",
  noEntriesTitle: "No servers found",
  noEntriesText: "This connection has no server to list.",
  noMatchTitle: "No servers match filter",
  noMatchText: "Try a different term in the filter.",
  chooseTitle: "Choose a server",
  chooseText: "Select a server from the sidebar to browse its files.",
  showListLabel: "Show servers",
  emptyRootTitle: "Empty folder",
  emptyRootText: "This folder is empty",
  openAction: "Open",
  copyNameAction: "Copy host name",
  copiedName: "Copied host name",
  copyNameFailed: "Failed to copy host name",
  refreshAction: "Refresh server list",
  refreshing: "Refreshing servers…",
  refreshed: "Servers refreshed.",
  refreshFailed: "Failed to refresh servers",
  retryRefresh: "Retry server refresh",
  openFailed: "Failed to open server",
  connectFirst: "Connect to a server first.",
  pathHint: "Enter a path like /path/to/folder",
  pathPlaceholder: "/path/to/folder",
  goToLabel: "Go to path",
  goToPrompt: "Enter a path, such as /path/to/folder:",
  goToPlaceholder: "e.g. /path/to/folder",
};

export function protocolLabels(protocol: LocationProtocol): ProtocolLabels {
  return protocol === "sftp" ? SFTP_LABELS : S3_LABELS;
}

/**
 * The protocol the screen should speak. A disconnected or locked state shows
 * S3 words even if a stale protocol field is still set.
 */
export function sessionProtocol(session: {
  connected: boolean;
  protocol: LocationProtocol;
}): LocationProtocol {
  return session.connected && session.protocol === "sftp" ? "sftp" : "s3";
}

/**
 * The location text a user reads: `bucket/key` on S3, and the absolute remote
 * path on SFTP (`/` for the root, no trailing slash for a folder).
 */
export function displayLocation(
  protocol: LocationProtocol,
  bucket: string,
  key: string,
): string {
  if (protocol === "s3") return `${bucket}/${key}`;
  try {
    return sftpPathFromKey(key);
  } catch {
    // A key the path rules refuse is still shown, so a message never throws.
    return `/${key}`;
  }
}
