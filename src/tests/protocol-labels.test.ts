import { describe, expect, it } from "vitest";
import {
  displayLocation,
  protocolLabels,
  sessionProtocol,
} from "../protocol-labels.ts";

/**
 * Failure-mode inventory, written before src/protocol-labels.ts:
 * - An S3 word changes, so an S3 session shows different text than before.
 * - An SFTP session keeps a "bucket" word on a surface the user reads.
 * - A disconnected or locked state keeps SFTP words after a session ends.
 * - displayLocation prints the S3 "bucket/key" form on SFTP, or drops the
 *   leading slash, or prints the root as an empty string.
 * - displayLocation throws for an SFTP key that sftpPathFromKey refuses, which
 *   would break a status message or a conflict prompt.
 * - The SFTP refresh word repeats the object refresh word in the palette.
 * - A folder key keeps its trailing slash on SFTP, so the display differs from
 *   the path the server sees.
 */

const SFTP_HOST = "files.example.test";

describe("protocolLabels", () => {
  it("keeps every S3 word exactly as the S3 screens print it", () => {
    expect(protocolLabels("s3")).toEqual({
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
    });
  });

  it("uses server and folder words in an SFTP session", () => {
    const sftp = protocolLabels("sftp");
    expect(sftp.sidebarTitle).toBe("Servers");
    expect(sftp.filterPlaceholder).toBe("Filter…");
    expect(sftp.emptyRootTitle).toBe("Empty folder");
    expect(sftp.emptyRootText).toBe("This folder is empty");
    expect(sftp.openAction).toBe("Open");
    expect(sftp.copyNameAction).toBe("Copy host name");
    expect(sftp.refreshAction).toBe("Refresh server list");
    expect(sftp.goToLabel).toBe("Go to path");
    expect(sftp.goToPrompt).toBe("Enter a path, such as /path/to/folder:");
    expect(sftp.goToPlaceholder).toBe("e.g. /path/to/folder");
    expect(sftp.connectFirst).toBe("Connect to a server first.");
    expect(sftp.pathPlaceholder).toBe("/path/to/folder");
    expect(sftp.pathHint).toBe("Enter a path like /path/to/folder");
  });

  it("keeps the word bucket out of every SFTP label", () => {
    for (const [key, value] of Object.entries(protocolLabels("sftp"))) {
      expect(value, key).not.toMatch(/bucket/i);
    }
  });

  it("gives every key a non-empty label in both protocols", () => {
    for (const protocol of ["s3", "sftp"] as const) {
      for (const [key, value] of Object.entries(protocolLabels(protocol))) {
        expect(value, `${protocol}.${key}`).not.toBe("");
      }
    }
  });
});

describe("sessionProtocol", () => {
  it("reports SFTP only for a connected SFTP session", () => {
    expect(sessionProtocol({ connected: true, protocol: "sftp" })).toBe("sftp");
  });

  it("reports S3 when disconnected or locked, even if the protocol field is left over", () => {
    expect(sessionProtocol({ connected: false, protocol: "sftp" })).toBe("s3");
    expect(sessionProtocol({ connected: true, protocol: "s3" })).toBe("s3");
    expect(sessionProtocol({ connected: false, protocol: "s3" })).toBe("s3");
  });
});

describe("displayLocation", () => {
  it("prints the S3 bucket/key form exactly as the S3 call sites do", () => {
    expect(displayLocation("s3", "photos", "")).toBe("photos/");
    expect(displayLocation("s3", "photos", "2024/")).toBe("photos/2024/");
    expect(displayLocation("s3", "photos", "2024/a.jpg")).toBe(
      "photos/2024/a.jpg",
    );
  });

  it("prints the SFTP root as /", () => {
    expect(displayLocation("sftp", SFTP_HOST, "")).toBe("/");
  });

  it("prints a nested SFTP file as an absolute remote path", () => {
    expect(displayLocation("sftp", SFTP_HOST, "home/demo/notes.txt")).toBe(
      "/home/demo/notes.txt",
    );
  });

  it("prints an SFTP folder without its trailing slash", () => {
    expect(displayLocation("sftp", SFTP_HOST, "home/demo/")).toBe("/home/demo");
  });

  it("does not throw for a key the path rules refuse", () => {
    expect(displayLocation("sftp", SFTP_HOST, "home/../etc")).toBe(
      "/home/../etc",
    );
  });
});
