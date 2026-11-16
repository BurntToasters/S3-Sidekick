import { describe, expect, it, vi } from "vitest";

// The registry only needs the pure rules here, so the modules it drives are
// replaced with empty stand-ins (the same graph the context-menu suite uses).
vi.mock("../browser.ts", () => ({}));
vi.mock("../info-panel.ts", () => ({
  infoPanelShowsEntries: () => false,
  openInfoPanel: () => Promise.resolve(),
}));
vi.mock("../preview.ts", () => ({}));
vi.mock("../app-objects.ts", () => ({}));
vi.mock("../app-downloads.ts", () => ({}));
vi.mock("../app-upload.ts", () => ({}));
vi.mock("../app-copy-move.ts", () => ({}));
vi.mock("../activity-log.ts", () => ({}));
vi.mock("../app-status.ts", () => ({}));
vi.mock("../app-layout.ts", () => ({}));
vi.mock("../connection.ts", () => ({ invokeS3: () => Promise.resolve("") }));

import {
  getObjectAction,
  isOfferedFor,
  resolveActionLabel,
  type ObjectActionContext,
} from "../object-actions.ts";
import { state } from "../state.ts";
import { SFTP_LOSSY_REASON } from "../sftp-move.ts";

/*
 * Failure modes, written before the change:
 * - An S3-only action (copy URL, share link, S3 URI, ARN, copy to) is offered
 *   for an SFTP selection.
 * - "Copy path" copies or labels as a key, or an SFTP move is labelled copy.
 * - A non-UTF-8 selection leaves rename, delete or move enabled.
 * - S3 selections lose an action or gain the SFTP-only label.
 * - An SFTP folder-only, single-folder or mixed selection has no Download,
 *   so the folder download the backend supports is unreachable.
 * - An S3 folder-only selection gains Download (folders are not downloadable
 *   on S3).
 */

function context(
  overrides: Partial<ObjectActionContext> = {},
): ObjectActionContext {
  return {
    fileKeys: [],
    folderPrefixes: [],
    total: 0,
    arnSupported: false,
    moveSupported: false,
    canPreviewSingle: false,
    listingLoading: false,
    deleteInFlight: false,
    ...overrides,
  };
}

function available(id: string, value: ObjectActionContext): boolean {
  const action = getObjectAction(id);
  if (!action) throw new Error(`no action ${id}`);
  return action.isAvailable(value);
}

const sftpFile = (overrides: Partial<ObjectActionContext> = {}) =>
  context({
    protocol: "sftp",
    fileKeys: ["home/demo/notes.txt"],
    total: 1,
    moveSupported: true,
    ...overrides,
  });

describe("object actions over SFTP", () => {
  it("hides the S3-only actions for an SFTP selection", () => {
    state.currentBucket = "files.example.test";
    const value = sftpFile({ arnSupported: false });
    expect(available("copy-url", value)).toBe(false);
    expect(available("share-link", value)).toBe(false);
    expect(available("copy-s3-uri", value)).toBe(false);
    expect(available("copy-arns", value)).toBe(false);
  });

  it("keeps the actions SFTP supports", () => {
    const value = sftpFile();
    expect(
      available("preview", context({ ...value, canPreviewSingle: true })),
    ).toBe(true);
    expect(available("properties", value)).toBe(true);
    expect(available("rename", value)).toBe(true);
    expect(available("delete", value)).toBe(true);
    expect(available("download", value)).toBe(true);
    expect(available("copy-keys", value)).toBe(true);
    expect(available("copy-move", value)).toBe(true);
  });

  it("offers Move instead of Copy and never the separate Move entry", () => {
    const value = sftpFile();
    const copyMove = getObjectAction("copy-move");
    expect(copyMove && resolveActionLabel(copyMove, value)).toBe("Move to…");
    expect(available("move", value)).toBe(false);
  });

  it("names the copied text as a path", () => {
    const one = getObjectAction("copy-keys");
    const many = getObjectAction("copy-keys");
    expect(one && resolveActionLabel(one, sftpFile())).toBe("Copy path");
    expect(
      many &&
        resolveActionLabel(
          many,
          sftpFile({
            fileKeys: ["home/demo/a.txt", "home/demo/b.txt"],
            total: 2,
          }),
        ),
    ).toBe("Copy 2 paths");
  });

  it("disables rename, delete and move for a non-UTF-8 selection with the reason", () => {
    const lossy = sftpFile({ lossySelection: true });
    for (const id of ["rename", "delete", "copy-move"]) {
      const action = getObjectAction(id);
      expect(action?.disabledReason?.(lossy)).toBe(SFTP_LOSSY_REASON);
    }
    const clean = sftpFile({ lossySelection: false });
    for (const id of ["rename", "delete", "copy-move"]) {
      expect(getObjectAction(id)?.disabledReason?.(clean)).toBeNull();
    }
  });
});

describe("object actions over S3 are unchanged by SFTP rules", () => {
  it("keeps the S3 copy and share actions for an S3 selection", () => {
    state.currentBucket = "reports";
    const value = context({
      protocol: "s3",
      fileKeys: ["a.txt"],
      total: 1,
      moveSupported: true,
      canPreviewSingle: true,
    });
    expect(available("copy-url", value)).toBe(true);
    expect(available("share-link", value)).toBe(true);
    expect(available("copy-s3-uri", value)).toBe(true);
    const copyMove = getObjectAction("copy-move");
    expect(copyMove && resolveActionLabel(copyMove, value)).toBe(
      "Copy / move…",
    );
    expect(available("move", value)).toBe(false);
  });

  it("labels Copy to when the S3 provider cannot move", () => {
    const value = context({
      protocol: "s3",
      fileKeys: ["a.txt"],
      total: 1,
      moveSupported: false,
    });
    const copyMove = getObjectAction("copy-move");
    expect(copyMove && resolveActionLabel(copyMove, value)).toBe("Copy to…");
    expect(available("move", value)).toBe(true);
  });

  it("never disables an S3 action for a lossy-looking key", () => {
    const value = context({
      protocol: "s3",
      fileKeys: ["bad�name.txt"],
      total: 1,
      lossySelection: false,
    });
    expect(getObjectAction("delete")?.disabledReason?.(value)).toBeNull();
    expect(getObjectAction("rename")?.disabledReason?.(value)).toBeNull();
  });
});

describe("isOfferedFor", () => {
  it("withholds the S3-only entries from SFTP and offers the rest", () => {
    const sftpValue = sftpFile();
    for (const id of ["copy-url", "share-link", "copy-s3-uri", "copy-arns"]) {
      expect(isOfferedFor(id, sftpValue), id).toBe(false);
    }
    for (const id of [
      "rename",
      "delete",
      "download",
      "copy-keys",
      "copy-move",
    ]) {
      expect(isOfferedFor(id, sftpValue), id).toBe(true);
    }
  });

  it("offers every entry for S3 and refuses an unknown id", () => {
    const s3 = context({ protocol: "s3", fileKeys: ["a.txt"], total: 1 });
    expect(isOfferedFor("copy-url", s3)).toBe(true);
    expect(isOfferedFor("no-such-action", s3)).toBe(false);
  });
});

describe("download availability for folders", () => {
  const sftpFolder = (overrides: Partial<ObjectActionContext> = {}) =>
    context({
      protocol: "sftp",
      folderPrefixes: ["home/demo/bundle/"],
      total: 1,
      ...overrides,
    });

  it("offers Download for an SFTP folder-only selection", () => {
    const value = sftpFolder({
      folderPrefixes: ["home/demo/bundle/", "home/demo/archive/"],
      total: 2,
    });
    expect(available("download", value)).toBe(true);
  });

  it("offers Download for a single SFTP folder", () => {
    expect(available("download", sftpFolder())).toBe(true);
  });

  it("offers Download for an SFTP mixed selection", () => {
    const value = sftpFolder({
      fileKeys: ["home/demo/notes.txt"],
      total: 2,
    });
    expect(available("download", value)).toBe(true);
  });

  it("keeps Download unavailable for an S3 folder-only selection", () => {
    const value = context({
      protocol: "s3",
      folderPrefixes: ["reports/2024/"],
      total: 1,
    });
    expect(available("download", value)).toBe(false);
  });

  it("keeps Download available for an S3 file selection", () => {
    const value = context({
      protocol: "s3",
      fileKeys: ["reports/a.csv"],
      total: 1,
    });
    expect(available("download", value)).toBe(true);
  });
});
