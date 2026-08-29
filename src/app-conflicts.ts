import { invoke } from "@tauri-apps/api/core";
import { invokeS3For } from "./connection.ts";
import { state } from "./state.ts";
import { showConfirm } from "./dialogs.ts";
import { logActivity } from "./activity-log.ts";
import { friendlyError, basename } from "./utils.ts";
import type { ConflictPolicy } from "./settings-model.ts";
import type { DownloadQueueEntry } from "./app-downloads.ts";
import {
  lacksAtomicCreateForCopy,
  lacksAtomicCreateForUpload,
} from "./create-only-capabilities.ts";

export interface ConflictPromptSession {
  applyAll: Exclude<ConflictPolicy, "ask"> | null;
  unguardedWriteAuthorized?: boolean;
}

async function confirmUnguardedWrite(
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<boolean> {
  if (session.unguardedWriteAuthorized) return true;
  const proceed = await showConfirm(
    "Unconditional Write",
    "This storage provider cannot enforce create-only writes. Another client could create the same key before this transfer finishes. Write anyway?",
    { okLabel: "Write anyway", cancelLabel: "Cancel" },
  );
  if (!proceed) return false;
  if (hasBatchRemainder) {
    const applyAll = await showConfirm(
      "Apply Choice",
      'Apply "Write anyway" to remaining new destinations on this provider?',
      { okLabel: "Apply to all", cancelLabel: "Only this one" },
    );
    if (applyAll) {
      session.unguardedWriteAuthorized = true;
    }
  }
  return true;
}

export async function resolveConflictChoice(
  label: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<Exclude<ConflictPolicy, "ask">> {
  if (session.applyAll) return session.applyAll;
  const replace = await showConfirm(
    "Conflict",
    `${label} already exists. Replace it?`,
    { okLabel: "Replace", cancelLabel: "Skip", okDanger: true },
  );
  const decision: Exclude<ConflictPolicy, "ask"> = replace ? "replace" : "skip";
  if (hasBatchRemainder) {
    const applyAll = await showConfirm(
      "Apply Choice",
      `Apply "${decision}" to remaining conflicts?`,
      { okLabel: "Apply to all", cancelLabel: "Only this one" },
    );
    if (applyAll) {
      session.applyAll = decision;
    }
  }
  return decision;
}

export async function resolveDownloadEntriesWithConflicts(
  entries: DownloadQueueEntry[],
): Promise<DownloadQueueEntry[]> {
  const result: DownloadQueueEntry[] = [];
  const conflictPolicy = state.currentSettings.conflictPolicy;
  const session: ConflictPromptSession = { applyAll: null };
  let remainingConflicts = 0;

  const existingResults = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await invoke<boolean>("path_exists", {
          path: entry.destination,
        });
      } catch (err) {
        // Fail closed: an unreadable destination must not be taken as "free to
        // overwrite". Treat it as a conflict so the user is asked.
        logActivity(
          `Could not check whether ${entry.destination} exists (${friendlyError(err)}). ` +
            "Treating it as a conflict.",
          "warning",
        );
        return true;
      }
    }),
  );
  for (const exists of existingResults) {
    if (exists) remainingConflicts += 1;
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const exists = existingResults[i];
    if (!exists) {
      result.push({ ...entry });
      continue;
    }

    if (conflictPolicy === "replace") {
      result.push({ ...entry, conflictResolution: "replace" });
      remainingConflicts -= 1;
      continue;
    }
    if (conflictPolicy === "skip") {
      logActivity(
        `Skipped download for ${basename(entry.key)}: destination exists.`,
        "warning",
      );
      remainingConflicts -= 1;
      continue;
    }

    const decision = await resolveConflictChoice(
      entry.destination,
      session,
      remainingConflicts > 1,
    );
    remainingConflicts -= 1;
    if (decision === "replace") {
      result.push({ ...entry, conflictResolution: "replace" });
    } else {
      logActivity(
        `Skipped download for ${basename(entry.key)}: destination exists.`,
        "warning",
      );
    }
  }

  return result;
}

export type ObjectWriteIntent = "skip" | "cancel" | { overwrite: boolean };

export interface ObjectConflictOptions {
  operation: "upload" | "copy";
  byteLength?: number;
}

export async function resolveAbsentObjectWriteIntent(
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
  options: ObjectConflictOptions,
): Promise<Exclude<ObjectWriteIntent, "skip">> {
  const lacksAtomic =
    options.operation === "upload"
      ? lacksAtomicCreateForUpload(
          state.createOnlyCapabilities,
          options.byteLength,
        )
      : lacksAtomicCreateForCopy(
          state.createOnlyCapabilities,
          options.byteLength,
        );
  if (!lacksAtomic) return { overwrite: false };

  const authorized = await confirmUnguardedWrite(session, hasBatchRemainder);
  return authorized ? { overwrite: true } : "cancel";
}

export async function resolveObjectConflict(
  bucket: string,
  key: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
  connectionId: string,
  options: ObjectConflictOptions,
): Promise<ObjectWriteIntent> {
  const conflictPolicy = state.currentSettings.conflictPolicy;
  let exists: boolean;
  try {
    exists = await invokeS3For<boolean>(connectionId, "object_exists", {
      bucket,
      key,
    });
  } catch (err) {
    // Fail closed. A transient error or a denied HeadObject must not be read as
    // "the object is absent", which would silently authorise an overwrite.
    logActivity(
      `Could not check whether ${bucket}/${key} exists (${friendlyError(err)}). ` +
        "Treating it as a conflict.",
      "warning",
    );
    exists = true;
  }
  if (!exists) {
    return resolveAbsentObjectWriteIntent(session, hasBatchRemainder, options);
  }
  if (conflictPolicy === "replace") return { overwrite: true };
  if (conflictPolicy === "skip") return "skip";
  const decision = await resolveConflictChoice(
    `${bucket}/${key}`,
    session,
    hasBatchRemainder,
  );
  return decision === "replace" ? { overwrite: true } : "skip";
}
