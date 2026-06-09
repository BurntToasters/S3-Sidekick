import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";
import { showConfirm } from "./dialogs.ts";
import { logActivity } from "./activity-log.ts";
import { basename } from "./utils.ts";
import type { ConflictPolicy } from "./settings-model.ts";
import type { DownloadQueueEntry } from "./app-downloads.ts";

export interface ConflictPromptSession {
  applyAll: Exclude<ConflictPolicy, "ask"> | null;
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
      } catch {
        return false;
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

export async function resolveObjectConflict(
  bucket: string,
  key: string,
  session: ConflictPromptSession,
  hasBatchRemainder: boolean,
): Promise<Exclude<ConflictPolicy, "ask">> {
  const conflictPolicy = state.currentSettings.conflictPolicy;
  let exists = false;
  try {
    exists = await invoke<boolean>("object_exists", { bucket, key });
  } catch {
    exists = false;
  }
  if (!exists) return "replace";
  if (conflictPolicy === "replace") return "replace";
  if (conflictPolicy === "skip") return "skip";
  return resolveConflictChoice(`${bucket}/${key}`, session, hasBatchRemainder);
}
