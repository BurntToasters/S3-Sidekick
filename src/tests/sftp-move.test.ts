import { describe, expect, it, vi } from "vitest";
import {
  describeSftpMoveSummary,
  formatSftpPermissions,
  isSftpNameLossy,
  planSftpMove,
  runSftpMove,
  sftpChildNameProblem,
  sftpDeleteConfirmation,
  type SftpMoveItem,
} from "../sftp-move.ts";

/*
 * Failure modes, written before the module:
 * - A move into a folder inside itself, or into its own folder, reaches the server.
 * - A non-UTF-8 name is moved, or a destination that is not an absolute path is accepted.
 * - Two items with the same name map onto one target and the second clobbers the first.
 * - A failed rename stops the batch, or a connection loss keeps renaming.
 * - The summary claims success when an item failed, or names no failure.
 * - A folder or name rule accepts "/", "", ".", or "..".
 */

describe("sftpChildNameProblem", () => {
  it("refuses empty, dot, dot-dot, slash and null names", () => {
    expect(sftpChildNameProblem("")).toBe("Name cannot be empty.");
    expect(sftpChildNameProblem(".")).toMatch(/"\." or "\.\."/);
    expect(sftpChildNameProblem("..")).toMatch(/"\." or "\.\."/);
    expect(sftpChildNameProblem("a/b")).toMatch(/"\/"/);
    expect(sftpChildNameProblem("a\0b")).toMatch(/null/);
  });

  it("names the folder in the message when the name is for a folder", () => {
    expect(sftpChildNameProblem("", "folder")).toBe(
      "Folder name cannot be empty.",
    );
    expect(sftpChildNameProblem("..", "folder")).toBe(
      'Folder name cannot be "." or "..".',
    );
    expect(sftpChildNameProblem("a/b", "folder")).toBe(
      'Folder name cannot contain "/".',
    );
  });

  it("accepts an ordinary name, including dots inside it", () => {
    expect(sftpChildNameProblem("report.v2.txt")).toBeNull();
    expect(sftpChildNameProblem("...")).toBeNull();
  });

  it("refuses a name that holds the replacement character", () => {
    expect(sftpChildNameProblem("bad�name")).toMatch(/read-only/);
  });
});

describe("isSftpNameLossy", () => {
  it("flags only names that carry the replacement character", () => {
    expect(isSftpNameLossy("bad�name.txt")).toBe(true);
    expect(isSftpNameLossy("notes.txt")).toBe(false);
  });
});

describe("planSftpMove", () => {
  it("maps each source onto the destination folder with its own name", () => {
    const plan = planSftpMove(
      ["/home/demo/notes.txt", "/home/demo/report.txt"],
      "/home/demo/archive",
    );
    expect(plan.refusal).toBeNull();
    expect(plan.items).toEqual<SftpMoveItem[]>([
      {
        name: "notes.txt",
        fromPath: "/home/demo/notes.txt",
        toPath: "/home/demo/archive/notes.txt",
      },
      {
        name: "report.txt",
        fromPath: "/home/demo/report.txt",
        toPath: "/home/demo/archive/report.txt",
      },
    ]);
  });

  it("does not double the slash when the destination is the root", () => {
    const plan = planSftpMove(["/home/demo/notes.txt"], "/");
    expect(plan.items[0]?.toPath).toBe("/notes.txt");
  });

  it("refuses a folder moved into itself or one of its descendants", () => {
    expect(planSftpMove(["/home/demo/a"], "/home/demo/a").refusal).toMatch(
      /into itself/,
    );
    expect(planSftpMove(["/home/demo/a"], "/home/demo/a/b").refusal).toMatch(
      /into itself/,
    );
  });

  it("refuses a move into the folder the item already sits in", () => {
    const plan = planSftpMove(["/home/demo/notes.txt"], "/home/demo");
    expect(plan.items).toEqual([]);
    expect(plan.refusal).toMatch(/already in that folder/);
  });

  it("refuses a non-UTF-8 source, a relative destination, and duplicate names", () => {
    expect(planSftpMove(["/home/demo/bad�.txt"], "/home").refusal).toMatch(
      /read-only/,
    );
    expect(planSftpMove(["/home/demo/a.txt"], "home").refusal).toMatch(
      /valid remote path/,
    );
    expect(
      planSftpMove(["/home/demo/a.txt", "/home/other/a.txt"], "/home/archive")
        .refusal,
    ).toMatch(/share the name/);
  });

  it("refuses an empty selection without a destination error", () => {
    expect(planSftpMove([], "/home/demo/archive")).toEqual({
      items: [],
      refusal: null,
    });
  });
});

describe("runSftpMove", () => {
  const items: SftpMoveItem[] = [
    { name: "a", fromPath: "/x/a", toPath: "/y/a" },
    { name: "b", fromPath: "/x/b", toPath: "/y/b" },
    { name: "c", fromPath: "/x/c", toPath: "/y/c" },
  ];

  it("renames every item and reports them all as moved", async () => {
    const rename = vi.fn(() => Promise.resolve());
    const summary = await runSftpMove(items, {
      rename,
      isConnectionLost: () => false,
    });
    expect(rename.mock.calls).toEqual([
      ["/x/a", "/y/a"],
      ["/x/b", "/y/b"],
      ["/x/c", "/y/c"],
    ]);
    expect(summary).toEqual({
      moved: ["a", "b", "c"],
      failed: [],
      lostError: null,
      notAttempted: 0,
    });
  });

  it("keeps going after one item fails and lists that failure", async () => {
    const rename = vi.fn((from: string) =>
      from === "/x/b"
        ? Promise.reject(new Error("Remote path already exists: /y/b"))
        : Promise.resolve(),
    );
    const summary = await runSftpMove(items, {
      rename,
      isConnectionLost: () => false,
    });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(summary.moved).toEqual(["a", "c"]);
    expect(summary.failed).toEqual([
      { name: "b", error: "Remote path already exists: /y/b" },
    ]);
  });

  it("stops at a lost connection and counts the items it did not try", async () => {
    const lost = new Error("SFTP connection lost: rename /x/b");
    const rename = vi.fn((from: string) =>
      from === "/x/b" ? Promise.reject(lost) : Promise.resolve(),
    );
    const summary = await runSftpMove(items, {
      rename,
      isConnectionLost: (error) => error === lost,
    });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(summary.moved).toEqual(["a"]);
    expect(summary.failed).toEqual([]);
    expect(summary.lostError).toBe(lost);
    expect(summary.notAttempted).toBe(1);
  });
});

describe("describeSftpMoveSummary", () => {
  it("says how many moved and where, when nothing failed", () => {
    expect(
      describeSftpMoveSummary(
        { moved: ["a", "b"], failed: [], lostError: null, notAttempted: 0 },
        2,
        "archive",
      ),
    ).toEqual({ tone: "success", message: "Moved 2 items to archive." });
  });

  it("names each failed item in one summary when some did not move", () => {
    const result = describeSftpMoveSummary(
      {
        moved: ["a"],
        failed: [
          { name: "b", error: "Remote path already exists: /y/b" },
          { name: "c", error: "Permission denied" },
        ],
        lostError: null,
        notAttempted: 0,
      },
      3,
      "archive",
    );
    expect(result.tone).toBe("error");
    expect(result.message).toBe(
      "Moved 1 of 3 items to archive. 2 could not be moved: b (Remote path already exists: /y/b); c (Permission denied).",
    );
  });

  it("reports a partial run when the connection was lost", () => {
    const result = describeSftpMoveSummary(
      {
        moved: ["a"],
        failed: [],
        lostError: new Error("SFTP connection lost"),
        notAttempted: 1,
      },
      3,
      "archive",
    );
    expect(result.tone).toBe("error");
    expect(result.message).toBe(
      "Moved 1 of 3 items to archive before the connection was lost. 1 was not attempted.",
    );
  });
});

describe("formatSftpPermissions", () => {
  it("shows the permission bits in rwx form with the octal mode", () => {
    expect(formatSftpPermissions(0o755)).toBe("rwxr-xr-x (0755)");
    expect(formatSftpPermissions(0o640)).toBe("rw-r----- (0640)");
    expect(formatSftpPermissions(0o600)).toBe("rw------- (0600)");
  });

  it("ignores the file-type bits in the symbolic form", () => {
    // S_IFREG | 0644 and S_IFDIR | 0755 from a server mode word.
    expect(formatSftpPermissions(0o100644)).toBe("rw-r--r-- (0644)");
    expect(formatSftpPermissions(0o40755)).toBe("rwxr-xr-x (0755)");
  });

  it("shows the setuid bit in the octal form only", () => {
    expect(formatSftpPermissions(0o4755)).toBe("rwxr-xr-x (4755)");
  });

  it("shows a dash when the server sent no mode", () => {
    expect(formatSftpPermissions(null)).toBe("\u2014");
  });
});

describe("sftpDeleteConfirmation", () => {
  it("names files only when no folder is selected", () => {
    expect(sftpDeleteConfirmation(1, 0)).toBe("Delete 1 file?");
    expect(sftpDeleteConfirmation(2, 0)).toBe("Delete 2 files?");
  });

  it("says a folder takes everything inside it", () => {
    expect(sftpDeleteConfirmation(0, 1)).toBe(
      "Delete 1 folder and everything inside it?",
    );
    expect(sftpDeleteConfirmation(0, 2)).toBe(
      "Delete 2 folders and everything inside them?",
    );
    expect(sftpDeleteConfirmation(1, 1)).toBe(
      "Delete 1 file and 1 folder? Each folder and everything inside it is deleted too.",
    );
  });
});

describe("planSftpMove edge cases", () => {
  it("refuses a destination that holds a non-UTF-8 folder name", () => {
    expect(
      planSftpMove(["/home/demo/a.txt"], "/home/bad\uFFFD").refusal,
    ).toMatch(/read-only/);
  });

  it("refuses a source that is not an absolute remote path", () => {
    expect(planSftpMove(["home/demo/a.txt"], "/home/archive").refusal).toMatch(
      /not a valid remote path/,
    );
  });
});
