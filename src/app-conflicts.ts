import { invoke } from "./ipc.ts";
import { invokeS3For } from "./connection.ts";
import { state } from "./state.ts";
import { showConfirm, showConfirmWithCheckbox } from "./dialogs.ts";
import { saveSettings } from "./settings.ts";
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

export interface UnguardedWriteDecision {
  proceed: boolean;
  /// True when no further prompt should follow for this write, because the
  /// warning is turned off or the user just chose "Don't ask again".
  suppressed: boolean;
}

/**
 * Ask before a write the provider cannot make create-only. Honors the
 * `confirmUnguardedWrites` setting; "Don't ask again" is persisted only when
 * the user also chooses "Write anyway".
 */
export async function promptUnguardedWrite(): Promise<UnguardedWriteDecision> {
  if (state.currentSettings.confirmUnguardedWrites === false) {
    return { proceed: true, suppressed: true };
  }
  const { confirmed, checked } = await showConfirmWithCheckbox(
    "Unconditional Write",
    "This storage provider cannot enforce create-only writes. Another client could create the same key before this transfer finishes. Write anyway?",
    {
      okLabel: "Write anyway",
      cancelLabel: "Cancel",
      okDanger: true,
      checkboxLabel: "Don't ask again",
    },
  );
  if (!confirmed) return { proceed: false, suppressed: false };
  if (!checked) return { proceed: true, suppressed: false };

  state.currentSettings.confirmUnguardedWrites = false;
  try {
    await saveSettings();
    logActivity(
      "Unconditional write warnings turned off. Turn them back on in Settings > Transfers.",
      "info",
    );
  } catch (err) {
    logActivity(
      `Could not save "Don't ask again" (${friendlyError(err)}). The warning is off until restart.`,
      "warning",
    );
  }
  return { proceed: true, suppressed: true };
}

async function confirmUnguardedWrite(
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<boolean> {
  if (session.unguardedWriteAuthorized) return true;
  const { proceed, suppressed } = await promptUnguardedWrite();
  if (!proceed) return false;
  if (hasBatchRemainder && !suppressed) {
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

export interface ConflictChoiceOptions {
  /// Conflicts still waiting after this one. The apply-to-all question names
  /// this count so the user knows how far the choice reaches.
  remainingCount?: number;
}

/**
 * Ask about a destination known to exist. The batch question (when any
 * conflicts remain) lets one answer cover the rest of the batch.
 */
export async function resolveConflictChoice(
  label: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
  options: ConflictChoiceOptions = {},
): Promise<Exclude<ConflictPolicy, "ask">> {
  if (session.applyAll) return session.applyAll;
  const replace = await showConfirm(
    "Replace existing file?",
    `${label} already exists. Replace it?`,
    { okLabel: "Replace", cancelLabel: "Skip", okDanger: true },
  );
  const decision: Exclude<ConflictPolicy, "ask"> = replace ? "replace" : "skip";
  const remainingCount = options.remainingCount;
  const showApplyAll =
    hasBatchRemainder && (remainingCount === undefined || remainingCount > 0);
  if (showApplyAll) {
    const verb = decision === "replace" ? "Replace" : "Skip";
    const scope =
      remainingCount === undefined
        ? "remaining conflicts"
        : `up to ${remainingCount} remaining conflicts`;
    const applyAll = await showConfirm(
      "Apply to remaining conflicts?",
      `Apply "${verb}" to ${scope}?`,
      {
        okLabel: "Apply to all remaining conflicts",
        cancelLabel: "This one only",
      },
    );
    if (applyAll) {
      session.applyAll = decision;
    }
  }
  return decision;
}

/**
 * Ask about a destination whose existence could not be checked. The user
 * decides for this item only: an unknown state never becomes a batch rule.
 */
async function resolveUnknownDestination(
  label: string,
  reason: string,
): Promise<Exclude<ConflictPolicy, "ask">> {
  const replace = await showConfirm(
    "Destination not checked",
    `Couldn't check whether ${label} exists (${reason}). Replace if present?`,
    { okLabel: "Replace", cancelLabel: "Skip", okDanger: true },
  );
  return replace ? "replace" : "skip";
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
      { remainingCount: remainingConflicts - 1 },
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
  /// Conflicts still waiting after this item, for the apply-to-all question.
  remainingCount?: number;
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
  connectionId: string,
  bucket: string,
  key: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
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
    const reason = friendlyError(err).replace(/\.$/, "");
    logActivity(
      `Could not check whether ${bucket}/${key} exists (${reason}). ` +
        "Treating it as a conflict.",
      "warning",
    );
    if (conflictPolicy === "replace" || session.applyAll === "replace") {
      return { overwrite: true };
    }
    if (conflictPolicy === "skip" || session.applyAll === "skip") return "skip";
    const unknownDecision = await resolveUnknownDestination(
      `${bucket}/${key}`,
      reason,
    );
    return unknownDecision === "replace" ? { overwrite: true } : "skip";
  }
  if (!exists) {
    if (conflictPolicy === "replace" || session.applyAll === "replace") {
      return { overwrite: true };
    }
    return resolveAbsentObjectWriteIntent(session, hasBatchRemainder, options);
  }
  if (conflictPolicy === "replace") return { overwrite: true };
  if (conflictPolicy === "skip") return "skip";
  const decision = await resolveConflictChoice(
    `${bucket}/${key}`,
    session,
    hasBatchRemainder,
    { remainingCount: options.remainingCount },
  );
  return decision === "replace" ? { overwrite: true } : "skip";
}
