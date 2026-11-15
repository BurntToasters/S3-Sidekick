import { isSftpRemotePath } from "./sftp.ts";
import { friendlyError, plural } from "./utils.ts";

/*
 * SFTP object rules that do not touch IPC: child-name validation, the
 * move-by-rename plan, the per-entry loop, and the one-line summary. A move on
 * SFTP is a rename per entry. There are no copy receipts, no transfer rows and
 * no source-deletion step.
 */

/*
 * Connection-loss seam. Owned modules report a lost SFTP connection through
 * reportSftpConnectionLost. The disconnect flow registers itself once, from
 * object-actions.ts, so these modules do not import app-connection.ts: its
 * load-time graph would couple every module that loads it to the connection
 * layer's mocks and cycle.
 */
type SftpLossHandler = (error: unknown) => Promise<boolean>;

let sftpLossHandler: SftpLossHandler = () => Promise.resolve(false);

export function setSftpConnectionLostHandler(handler: SftpLossHandler): void {
  sftpLossHandler = handler;
}

/** Resolves true when the error was a lost SFTP connection and was handled. */
export function reportSftpConnectionLost(error: unknown): Promise<boolean> {
  return sftpLossHandler(error);
}

/** U+FFFD, the character the native side writes for a name that is not UTF-8. */
const REPLACEMENT_CHARACTER = "\uFFFD";

export const SFTP_LOSSY_REASON =
  "Names that are not valid UTF-8 are read-only in this beta.";

/** True when the server's name could not be decoded; the native side marks the same names. */
export function isSftpNameLossy(name: string): boolean {
  return name.includes(REPLACEMENT_CHARACTER);
}

/** Why a child name is refused, or null when the name can be used. */
export function sftpChildNameProblem(
  name: string,
  kind: "file" | "folder" = "file",
): string | null {
  const noun = kind === "folder" ? "Folder name" : "Name";
  if (name.trim() === "") return `${noun} cannot be empty.`;
  if (name === "." || name === "..") return `${noun} cannot be "." or "..".`;
  if (name.includes("/")) return `${noun} cannot contain "/".`;
  if (name.includes("\0")) return `${noun} cannot contain a null character.`;
  if (name.includes(REPLACEMENT_CHARACTER)) return SFTP_LOSSY_REASON;
  return null;
}

export interface SftpMoveItem {
  name: string;
  fromPath: string;
  toPath: string;
}

export interface SftpMovePlan {
  items: SftpMoveItem[];
  /** Why the whole move is refused before anything runs, or null. */
  refusal: string | null;
}

/** The folder that holds an absolute remote path; "/" for the root's children. */
export function sftpParentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** The last segment of an absolute remote path. */
export function sftpLeafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A child path under a folder, without a doubled slash at the root. */
export function sftpJoinPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

/**
 * Map each source onto the destination folder. A refused plan has no items:
 * the first problem stops the whole move, so nothing is renamed half-way.
 */
export function planSftpMove(
  sources: readonly string[],
  destinationFolder: string,
): SftpMovePlan {
  const refuse = (refusal: string): SftpMovePlan => ({ items: [], refusal });
  if (sources.length === 0) return { items: [], refusal: null };
  // The native side refuses any path with a non-UTF-8 name, destinations included.
  if (destinationFolder.includes(REPLACEMENT_CHARACTER)) {
    return refuse(SFTP_LOSSY_REASON);
  }
  if (!isSftpRemotePath(destinationFolder)) {
    return refuse("Destination is not a valid remote path.");
  }
  const items: SftpMoveItem[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    if (!isSftpRemotePath(source)) {
      return refuse("An item is not a valid remote path.");
    }
    const name = sftpLeafName(source);
    if (isSftpNameLossy(name)) return refuse(SFTP_LOSSY_REASON);
    const folderOfTarget =
      destinationFolder === "/" ? "/" : `${destinationFolder}/`;
    if (
      destinationFolder === source ||
      folderOfTarget.startsWith(`${source}/`)
    ) {
      return refuse(`"${name}" cannot be moved into itself.`);
    }
    if (sftpParentPath(source) === destinationFolder) {
      return refuse(`"${name}" is already in that folder.`);
    }
    if (seenNames.has(name)) {
      return refuse(`Two items share the name "${name}".`);
    }
    seenNames.add(name);
    items.push({
      name,
      fromPath: source,
      toPath: sftpJoinPath(destinationFolder, name),
    });
  }
  return { items, refusal: null };
}

export interface SftpMoveFailure {
  name: string;
  error: string;
}

export interface SftpMoveSummary {
  moved: string[];
  failed: SftpMoveFailure[];
  /** The error that ended the run because the connection was lost, or null. */
  lostError: unknown;
  /** Items after a lost connection that were never attempted. */
  notAttempted: number;
}

export interface SftpMoveRunner {
  rename(fromPath: string, toPath: string): Promise<void>;
  /** True for the lost-connection error, which ends the run. */
  isConnectionLost(error: unknown): boolean;
}

/**
 * Rename each item in order. A failure is recorded and the run continues. A
 * lost connection stops the run, because every later rename would fail too.
 */
export async function runSftpMove(
  items: readonly SftpMoveItem[],
  runner: SftpMoveRunner,
): Promise<SftpMoveSummary> {
  const moved: string[] = [];
  const failed: SftpMoveFailure[] = [];
  for (const [index, item] of items.entries()) {
    try {
      await runner.rename(item.fromPath, item.toPath);
      moved.push(item.name);
    } catch (error) {
      if (runner.isConnectionLost(error)) {
        return {
          moved,
          failed,
          lostError: error,
          notAttempted: items.length - index - 1,
        };
      }
      failed.push({ name: item.name, error: friendlyError(error) });
    }
  }
  return { moved, failed, lostError: null, notAttempted: 0 };
}

export interface SftpMoveSentence {
  tone: "success" | "error";
  message: string;
}

/** One status line for a finished move, naming every item that did not move. */
export function describeSftpMoveSummary(
  summary: SftpMoveSummary,
  total: number,
  folderName: string,
): SftpMoveSentence {
  const movedCount = summary.moved.length;
  if (summary.lostError !== null) {
    const notAttempted =
      summary.notAttempted > 0
        ? ` ${summary.notAttempted} ${summary.notAttempted === 1 ? "was" : "were"} not attempted.`
        : "";
    return {
      tone: "error",
      message: `Moved ${movedCount} of ${total} items to ${folderName} before the connection was lost.${notAttempted}`,
    };
  }
  if (summary.failed.length === 0) {
    return {
      tone: "success",
      message: `Moved ${plural(movedCount, "item")} to ${folderName}.`,
    };
  }
  const details = summary.failed
    .map((failure) => `${failure.name} (${failure.error})`)
    .join("; ");
  return {
    tone: "error",
    message: `Moved ${movedCount} of ${total} items to ${folderName}. ${summary.failed.length} could not be moved: ${details}.`,
  };
}

/** `rwxr-xr-x (0755)` for a mode word. The type bits are not part of the permissions. */
export function formatSftpPermissions(mode: number | null): string {
  if (mode === null) return "—";
  const bits = mode & 0o777;
  const triad = (shift: number): string => {
    const part = (bits >> shift) & 0o7;
    return `${part & 4 ? "r" : "-"}${part & 2 ? "w" : "-"}${part & 1 ? "x" : "-"}`;
  };
  const symbolic = `${triad(6)}${triad(3)}${triad(0)}`;
  const octal = (mode & 0o7777).toString(8).padStart(4, "0");
  return `${symbolic} (${octal})`;
}

/** Headline of the SFTP delete confirmation. Folders take everything inside them. */
export function sftpDeleteConfirmation(
  fileCount: number,
  folderCount: number,
): string {
  if (folderCount === 0) return `Delete ${plural(fileCount, "file")}?`;
  const folders = plural(folderCount, "folder");
  if (fileCount === 0) {
    return `Delete ${folders} and everything inside ${folderCount === 1 ? "it" : "them"}?`;
  }
  return `Delete ${plural(fileCount, "file")} and ${folders}? Each folder and everything inside it is deleted too.`;
}
