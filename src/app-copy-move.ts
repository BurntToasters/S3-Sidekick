import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";
import { clearSelection } from "./browser.ts";
import {
  enqueueCopyMoveEntries,
  type CopyMoveQueueEntry,
} from "./transfers.ts";
import { basename, friendlyError } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { getSelectedFileKeys, getSelectedPrefixes } from "./app-selection.ts";
import {
  resolveObjectConflict,
  resolveConflictChoice,
  type ConflictPromptSession,
} from "./app-conflicts.ts";
import type { ConflictPolicy } from "./settings-model.ts";

interface RecentCopyMoveDestination {
  bucket: string;
  path: string;
}

const RECENT_COPY_MOVE_DESTS_STORAGE_KEY =
  "s3-sidekick.recent-copy-move-destinations.v1";
const RECENT_DESTINATION_LIMIT = 8;

function readRecentCopyMoveDestinations(): RecentCopyMoveDestination[] {
  try {
    const raw = localStorage.getItem(RECENT_COPY_MOVE_DESTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const rows: RecentCopyMoveDestination[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const bucket = String(
        (entry as { bucket?: unknown }).bucket ?? "",
      ).trim();
      const path = String((entry as { path?: unknown }).path ?? "").trim();
      if (!bucket || !path) continue;
      const key = `${bucket}\n${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ bucket, path });
      if (rows.length >= RECENT_DESTINATION_LIMIT) break;
    }
    return rows;
  } catch {
    return [];
  }
}

function writeRecentCopyMoveDestinations(
  entries: RecentCopyMoveDestination[],
): void {
  try {
    localStorage.setItem(
      RECENT_COPY_MOVE_DESTS_STORAGE_KEY,
      JSON.stringify(entries.slice(0, RECENT_DESTINATION_LIMIT)),
    );
  } catch {
    // best effort
  }
}

function rememberCopyMoveDestination(bucket: string, path: string): void {
  const normalizedBucket = bucket.trim();
  const normalizedPath = path.trim().replace(/^\/+/, "");
  if (!normalizedBucket || !normalizedPath) return;
  const current = readRecentCopyMoveDestinations().filter(
    (entry) =>
      !(entry.bucket === normalizedBucket && entry.path === normalizedPath),
  );
  current.unshift({ bucket: normalizedBucket, path: normalizedPath });
  writeRecentCopyMoveDestinations(current);
}

export function openCopyMoveDialog(): void {
  const fileKeys = getSelectedFileKeys();
  const prefixes = getSelectedPrefixes();
  if (fileKeys.length === 0 && prefixes.length === 0) return;

  const overlay = document.getElementById("copy-move-overlay")!;
  const descEl = document.getElementById("copy-move-desc") as HTMLElement;
  const bucketSelect = document.getElementById(
    "copy-move-bucket",
  ) as HTMLSelectElement;
  const pathInput = document.getElementById(
    "copy-move-path",
  ) as HTMLInputElement;
  const pathLabel = document.querySelector(
    'label[for="copy-move-path"]',
  ) as HTMLLabelElement;
  const copyBtn = document.getElementById(
    "copy-move-copy-btn",
  ) as HTMLButtonElement;
  const moveBtn = document.getElementById(
    "copy-move-move-btn",
  ) as HTMLButtonElement;
  const cancelBtn = document.getElementById(
    "copy-move-cancel",
  ) as HTMLButtonElement;
  const closeBtn = document.getElementById(
    "copy-move-close",
  ) as HTMLButtonElement;
  const recentWrap = document.getElementById(
    "copy-move-recent-wrap",
  ) as HTMLElement | null;
  const recentList = document.getElementById(
    "copy-move-recent-list",
  ) as HTMLElement | null;

  bucketSelect.innerHTML = "";
  for (const b of state.buckets) {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    if (b.name === state.currentBucket) opt.selected = true;
    bucketSelect.appendChild(opt);
  }
  if (bucketSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = state.currentBucket;
    opt.textContent = state.currentBucket;
    bucketSelect.appendChild(opt);
  }

  const isSingleFile = fileKeys.length === 1 && prefixes.length === 0;
  const isSingleFolder = prefixes.length === 1 && fileKeys.length === 0;

  if (isSingleFile) {
    descEl.textContent = `File: ${fileKeys[0]}`;
    pathInput.value = fileKeys[0];
    pathLabel.textContent = "Destination key";
  } else if (isSingleFolder) {
    descEl.textContent = `Folder: ${prefixes[0]}`;
    pathInput.value = prefixes[0];
    pathLabel.textContent = "Destination prefix";
  } else {
    const parts: string[] = [];
    if (fileKeys.length > 0)
      parts.push(`${fileKeys.length} file${fileKeys.length !== 1 ? "s" : ""}`);
    if (prefixes.length > 0)
      parts.push(
        `${prefixes.length} folder${prefixes.length !== 1 ? "s" : ""}`,
      );
    descEl.textContent = `${parts.join(" + ")} — items placed under destination prefix`;
    pathInput.value = state.currentPrefix;
    pathLabel.textContent = "Destination prefix";
  }

  const browserPanel = document.getElementById(
    "copy-move-browser",
  ) as HTMLElement;
  const browserToggle = document.getElementById(
    "copy-move-browse-toggle",
  ) as HTMLButtonElement;
  const browserCrumbs = document.getElementById(
    "copy-move-browser-crumbs",
  ) as HTMLElement;
  const browserList = document.getElementById(
    "copy-move-browser-list",
  ) as HTMLElement;

  function renderRecentDestinations(): void {
    if (!recentWrap || !recentList) return;
    const recent = readRecentCopyMoveDestinations();
    if (recent.length === 0) {
      recentWrap.hidden = true;
      recentList.innerHTML = "";
      return;
    }
    const preferredBucket = bucketSelect.value || state.currentBucket;
    const ordered = [
      ...recent.filter((entry) => entry.bucket === preferredBucket),
      ...recent.filter((entry) => entry.bucket !== preferredBucket),
    ].slice(0, RECENT_DESTINATION_LIMIT);
    if (ordered.length === 0) {
      recentWrap.hidden = true;
      recentList.innerHTML = "";
      return;
    }
    recentWrap.hidden = false;
    recentList.innerHTML = "";
    for (const entry of ordered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-move-recent-item";
      button.textContent = `${entry.bucket}/${entry.path}`;
      button.title = `${entry.bucket}/${entry.path}`;
      button.addEventListener("click", () => {
        bucketSelect.value = entry.bucket;
        pathInput.value = entry.path;
        pathInput.focus();
      });
      recentList.appendChild(button);
    }
  }

  browserPanel.hidden = true;
  browserToggle.textContent = "Browse folders ▶";
  renderRecentDestinations();

  let loadFolderSeq = 0;

  async function loadFolders(prefix: string): Promise<void> {
    const seq = ++loadFolderSeq;
    browserList.innerHTML = "";
    browserList.insertAdjacentHTML(
      "beforeend",
      '<div class="copy-move-browser-loading">Loading…</div>',
    );
    renderBrowserCrumbs(prefix);

    try {
      const bucket = bucketSelect.value;
      const resp = await invoke<{ prefixes: string[] }>("list_objects", {
        bucket,
        prefix,
        delimiter: "/",
        continuationToken: "",
      });

      if (seq !== loadFolderSeq) return;

      browserList.innerHTML = "";

      if (resp.prefixes.length === 0) {
        browserList.insertAdjacentHTML(
          "beforeend",
          '<div class="copy-move-browser-empty">No subfolders</div>',
        );
        return;
      }

      for (const p of resp.prefixes) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-move-folder-item";
        btn.textContent = "\uD83D\uDCC1 " + name;
        btn.addEventListener("dblclick", () => void loadFolders(p));
        btn.addEventListener("click", () => {
          pathInput.value = isSingleFile ? p + basename(fileKeys[0]) : p;
        });
        btn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void loadFolders(p);
        });
        browserList.appendChild(btn);
      }
    } catch {
      browserList.innerHTML =
        '<div class="copy-move-browser-empty">Failed to load folders</div>';
    }
  }

  function renderBrowserCrumbs(prefix: string): void {
    browserCrumbs.innerHTML = "";
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.textContent = "/";
    rootBtn.addEventListener("click", () => void loadFolders(""));
    browserCrumbs.appendChild(rootBtn);

    if (prefix) {
      const parts = prefix.replace(/\/$/, "").split("/");
      let accumulated = "";
      for (let i = 0; i < parts.length; i++) {
        accumulated += parts[i] + "/";
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        browserCrumbs.appendChild(sep);

        if (i === parts.length - 1) {
          const current = document.createElement("span");
          current.className = "crumb-current";
          current.textContent = parts[i];
          browserCrumbs.appendChild(current);
        } else {
          const crumbBtn = document.createElement("button");
          crumbBtn.type = "button";
          crumbBtn.textContent = parts[i];
          const target = accumulated;
          crumbBtn.addEventListener("click", () => void loadFolders(target));
          browserCrumbs.appendChild(crumbBtn);
        }
      }
    }
  }

  browserToggle.onclick = () => {
    const willShow = browserPanel.hidden;
    browserPanel.hidden = !willShow;
    browserToggle.textContent = willShow
      ? "Browse folders ▼"
      : "Browse folders ▶";
    if (willShow) void loadFolders(state.currentPrefix);
  };

  bucketSelect.onchange = () => {
    renderRecentDestinations();
    if (!browserPanel.hidden) void loadFolders("");
  };

  const closeFn = () => {
    overlay.classList.remove("active");
    browserPanel.hidden = true;
  };

  const srcBucket = state.currentBucket;
  const conflictSession: ConflictPromptSession = { applyAll: null };

  const runCopy = async (move: boolean) => {
    const dstBucket = bucketSelect.value;
    const dstPath = pathInput.value.trim();
    if (!dstPath) {
      setStatus("Destination path is required.", 5000);
      pathInput.focus();
      return;
    }
    const action = move ? "move" : "copy";

    try {
      setStatus(`Preparing ${action} transfer(s)...`);
      const queuedEntries: CopyMoveQueueEntry[] = [];
      let skippedFiles = 0;
      let skippedFolders = 0;

      if (isSingleFile) {
        const decision = await resolveObjectConflict(
          dstBucket,
          dstPath,
          conflictSession,
          false,
        );
        if (decision === "skip") {
          setStatus(
            `Skipped "${basename(fileKeys[0])}" (destination exists).`,
            5000,
          );
          return;
        }
        queuedEntries.push({
          operation: move ? "move" : "copy",
          sourceBucket: srcBucket,
          fileName: basename(fileKeys[0]),
          sourceKey: fileKeys[0],
          destinationBucket: dstBucket,
          destinationKey: dstPath,
          conflictResolution: decision,
        });
      } else {
        const prefix = dstPath.endsWith("/") ? dstPath : dstPath + "/";
        for (const key of fileKeys) {
          const dstKey = prefix + basename(key);
          const decision = await resolveObjectConflict(
            dstBucket,
            dstKey,
            conflictSession,
            true,
          );
          if (decision === "skip") {
            skippedFiles += 1;
            continue;
          }
          queuedEntries.push({
            operation: move ? "move" : "copy",
            sourceBucket: srcBucket,
            fileName: basename(key),
            sourceKey: key,
            destinationBucket: dstBucket,
            destinationKey: dstKey,
            conflictResolution: decision,
          });
        }
        for (const srcPrefix of prefixes) {
          const folderName = basename(srcPrefix.replace(/\/$/, ""));
          const dstPrefix = isSingleFolder ? prefix : prefix + folderName + "/";
          let folderHasConflict = false;
          try {
            const existing = await invoke<{
              objects: Array<{ key: string }>;
              prefixes: string[];
            }>("list_objects", {
              bucket: dstBucket,
              prefix: dstPrefix,
              delimiter: "",
              continuationToken: "",
            });
            folderHasConflict =
              existing.objects.length > 0 || existing.prefixes.length > 0;
          } catch {
            folderHasConflict = false;
          }
          if (folderHasConflict) {
            let decision: Exclude<ConflictPolicy, "ask">;
            if (conflictSession.applyAll) {
              decision = conflictSession.applyAll;
            } else if (state.currentSettings.conflictPolicy === "replace") {
              decision = "replace";
            } else if (state.currentSettings.conflictPolicy === "skip") {
              decision = "skip";
            } else {
              decision = await resolveConflictChoice(
                `${dstBucket}/${dstPrefix}`,
                conflictSession,
                true,
              );
            }
            if (decision === "skip") {
              skippedFolders += 1;
              continue;
            }
            queuedEntries.push({
              operation: move ? "move" : "copy",
              sourceBucket: srcBucket,
              fileName: folderName,
              sourcePrefix: srcPrefix,
              destinationBucket: dstBucket,
              destinationPrefix: dstPrefix,
              conflictResolution: decision,
            });
            continue;
          }
          queuedEntries.push({
            operation: move ? "move" : "copy",
            sourceBucket: srcBucket,
            fileName: folderName,
            sourcePrefix: srcPrefix,
            destinationBucket: dstBucket,
            destinationPrefix: dstPrefix,
          });
        }
      }

      if (queuedEntries.length === 0) {
        setStatus(
          "No copy/move transfers queued (all conflicts skipped).",
          5000,
        );
        return;
      }

      enqueueCopyMoveEntries(queuedEntries);
      rememberCopyMoveDestination(dstBucket, dstPath);
      const skippedTotal = skippedFiles + skippedFolders;
      const skippedLabel =
        skippedTotal > 0
          ? ` Skipped ${skippedTotal} due to destination conflicts.`
          : "";
      setStatus(
        `Queued ${queuedEntries.length} ${action} transfer(s).${skippedLabel}`,
        5000,
      );
      logActivity(
        `Queued ${queuedEntries.length} ${action} transfer(s) to "${dstBucket}/${dstPath}".${skippedLabel}`,
        "success",
      );
      closeFn();
      clearSelection();
    } catch (err) {
      setStatus(`${move ? "Move" : "Copy"} failed: ${friendlyError(err)}`);
      logActivity(
        `${move ? "Move" : "Copy"} failed: ${friendlyError(err)}`,
        "error",
      );
    }
  };

  copyBtn.onclick = () => void runCopy(false);
  moveBtn.onclick = () => void runCopy(true);
  cancelBtn.onclick = closeFn;
  closeBtn.onclick = closeFn;

  overlay.classList.add("active");
  pathInput.focus();
  pathInput.select();
}
