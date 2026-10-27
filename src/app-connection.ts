import { state, dom } from "./state.ts";
import {
  connect,
  disconnect,
  saveConnection,
  refreshBuckets,
  currentConnectionGeneration,
  finishConnecting,
} from "./connection.ts";
import {
  renderBucketList,
  renderBucketListSkeleton,
  selectBucket,
  reportNavFailure,
  showEmptyState,
  clearSelection,
  clearNavHistory,
  readLastBucket,
} from "./browser.ts";
import {
  addBookmark,
  getBookmarks,
  renderBookmarkBar,
  isEndpointBookmarked,
  renderBookmarkList,
  removeBookmark,
  suggestBookmarkName,
  updateBookmark,
  type Bookmark,
} from "./bookmarks.ts";
import { friendlyError, isLocalEndpoint, plural } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { clearFilterInputDebounce, setSidebarOpen } from "./app-layout.ts";
import { setInspectorOpen } from "./inspector.ts";
import { showConfirm, showPrompt } from "./dialogs.ts";
import { showToast } from "./toast.ts";
import { editSavedConnection } from "./settings.ts";
import {
  recoverPendingTransfers,
  resumeRecoveredTransfersAfterConnect,
} from "./transfers.ts";

/** One user-initiated connect. Cancel flips `cancelled` so the flow discards its result. */
interface ConnectAttempt {
  cancelled: boolean;
}

const CREDENTIAL_FIELD_IDS = [
  "conn-endpoint",
  "conn-region",
  "conn-access-key",
  "conn-secret-key",
  "conn-session-token",
];

let pendingConnectAttempt: ConnectAttempt | null = null;
/** Access key of the live session; identifies the active saved connection. */
let connectedAccessKey = "";
/** Startup or explicit lock: saved connections are unavailable until unlocked. */
let savedConnectionsLocked = false;
let unlockHandler: (() => Promise<boolean>) | null = null;

export function awsRegionalEndpoint(region: string): string {
  const trimmed = region.trim() || "us-east-1";
  return `https://s3.${trimmed}.amazonaws.com`;
}

export function getConnectionInputs() {
  const endpoint = (
    document.getElementById("conn-endpoint") as HTMLInputElement
  ).value.trim();
  const region = (
    document.getElementById("conn-region") as HTMLInputElement
  ).value.trim();
  const accessKey = (
    document.getElementById("conn-access-key") as HTMLInputElement
  ).value.trim();
  const secretKey = (
    document.getElementById("conn-secret-key") as HTMLInputElement
  ).value.trim();
  const sessionToken =
    (
      document.getElementById("conn-session-token") as HTMLInputElement | null
    )?.value.trim() ?? "";
  return { endpoint, region, accessKey, secretKey, sessionToken };
}

export function setConnectionInputs(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken = "",
): void {
  (document.getElementById("conn-endpoint") as HTMLInputElement).value =
    endpoint;
  (document.getElementById("conn-region") as HTMLInputElement).value = region;
  (document.getElementById("conn-access-key") as HTMLInputElement).value =
    accessKey;
  (document.getElementById("conn-secret-key") as HTMLInputElement).value =
    secretKey;
  const sessionInput = document.getElementById(
    "conn-session-token",
  ) as HTMLInputElement | null;
  if (sessionInput) sessionInput.value = sessionToken;
  updateBookmarkBtn();
}

export function updateBookmarkBtn(): void {
  const btn = document.getElementById("bookmark-save-btn");
  if (!btn) return;
  const { endpoint, accessKey } = getConnectionInputs();
  const active = endpoint
    ? isEndpointBookmarked(endpoint, accessKey || undefined)
    : false;
  btn.classList.toggle("bookmark-save-btn--active", active);
}

/** Whether saved connections are hidden behind an Unlock action. */
export function isSavedConnectionsLocked(): boolean {
  return savedConnectionsLocked;
}

/**
 * Lock or unlock the saved-connections view (startup, auto-lock, unlock).
 * Callers refresh the lists afterwards.
 */
export function setSavedConnectionsLocked(locked: boolean): void {
  savedConnectionsLocked = locked;
}

/** Registers the unlock flow used by the locked saved-connections Unlock button. */
export function setUnlockSavedConnectionsHandler(
  handler: () => Promise<boolean>,
): void {
  unlockHandler = handler;
}

/**
 * Ask before a teardown that would pause running or queued transfers.
 * Resolves true immediately when nothing would be interrupted.
 */
export async function confirmSessionTeardown(action: string): Promise<boolean> {
  const count = state.activeTransferCount;
  if (count <= 0) return true;
  const verb = count === 1 ? "is" : "are";
  const pronoun = count === 1 ? "it" : "them";
  return showConfirm(
    "Transfers in progress",
    `${plural(count, "transfer")} ${verb} still running or queued. ${action} will pause ${pronoun} until you reconnect. Downloads can resume, but in-progress uploads start over.`,
    { okLabel: "Continue", cancelLabel: "Cancel", okDanger: true },
  );
}

function renderLockedSavedConnections(list: HTMLElement): void {
  list.innerHTML =
    `<li class="conn-saved-empty conn-saved-empty--locked">` +
    `<p class="conn-saved-empty__title">Saved connections are locked</p>` +
    `<p class="conn-saved-empty__text">Unlock encrypted storage to use your saved connections.</p>` +
    `<button type="button" class="btn btn--sm" data-unlock>Unlock</button>` +
    `</li>`;
  list.onclick = (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-unlock]")) {
      void unlockHandler?.();
    }
  };
  list.onkeydown = null;
}

async function renameSavedConnection(bookmark: Bookmark): Promise<void> {
  const entered = await showPrompt(
    "Rename saved connection",
    "New name for this saved connection:",
    {
      inputDefault: bookmark.name,
      okLabel: "Rename",
      validate: async (value: string) =>
        value.trim().length > 0 || "Enter a name for this connection.",
    },
  );
  if (entered === null) return;
  const name = entered.trim();
  if (name === bookmark.name) return;
  try {
    const updated = await updateBookmark(bookmark, { name });
    if (updated) {
      showToast(`Renamed to "${name}".`, { type: "success" });
    } else {
      setStatus("That saved connection is no longer saved.", 5000);
    }
  } catch (err) {
    setStatus(`Could not rename: ${friendlyError(err)}`, 8000);
  }
}

export function refreshSavedConnectionsList(): void {
  const savedList = document.getElementById("conn-saved-list");
  if (!savedList) return;
  if (isSavedConnectionsLocked()) {
    renderLockedSavedConnections(savedList);
    return;
  }
  renderBookmarkList(
    savedList,
    (bookmark) => {
      void switchToBookmark(
        bookmark.name,
        bookmark.endpoint,
        bookmark.region,
        bookmark.access_key,
        bookmark.secret_key,
        bookmark.session_token ?? "",
      );
    },
    (bookmark) => {
      void (async () => {
        const confirmed = await showConfirm(
          "Delete Saved Connection",
          `Delete saved connection "${bookmark.name}"? Its stored credentials are removed.`,
          { okLabel: "Delete", okDanger: true },
        );
        if (!confirmed) return;
        try {
          await removeBookmark(bookmark);
        } catch (err) {
          const message = `Could not delete "${bookmark.name}": ${friendlyError(err)}`;
          logActivity(message, "error");
          setStatus(message, 8000);
        }
      })();
    },
    {
      layout: "connection",
      emptyTitle: "No saved connections yet",
      emptyMessage:
        "Enter credentials and choose Save connection to keep them here.",
      onRename: (bookmark) => {
        void renameSavedConnection(bookmark);
      },
      onEdit: (bookmark) => {
        editSavedConnection(bookmark);
      },
    },
  );
}

export function focusConnectionScreen(): void {
  const endpoint = document.getElementById(
    "conn-endpoint",
  ) as HTMLInputElement | null;
  endpoint?.focus();
}

export function refreshBookmarkBar(): void {
  const bar = document.getElementById("bookmark-bar");
  if (bar) {
    renderBookmarkBar(
      bar,
      (bookmark) => {
        void switchToBookmark(
          bookmark.name,
          bookmark.endpoint,
          bookmark.region,
          bookmark.access_key,
          bookmark.secret_key,
          bookmark.session_token ?? "",
        );
      },
      state.connected ? state.endpoint : undefined,
      () => {
        void handleNewConnection();
      },
      state.connected ? connectedAccessKey : undefined,
    );
  }
  refreshSavedConnectionsList();
  updateBookmarkBtn();
}

export async function handleNewConnection(): Promise<void> {
  if (state.connected) {
    if (!(await confirmSessionTeardown("Starting a new connection"))) return;
    if (!(await handleDisconnect())) return;
  }
  setConnectionInputs("", "", "", "");
  setConnectionFormError(null);
  (document.getElementById("conn-endpoint") as HTMLInputElement).focus();
  setStatus("Ready for a new connection.", 5000);
}

async function promptForMissingSecret(name: string): Promise<string | null> {
  const entered = await showPrompt(
    "Secret key needed",
    `"${name}" was saved without its secret key. Enter it to connect.`,
    {
      inputType: "password",
      inputPlaceholder: "Secret key",
      okLabel: "Connect",
      validate: async (value: string) =>
        value.trim().length > 0 || "Enter the secret key.",
    },
  );
  if (entered === null) {
    setStatus("Connection cancelled.", 5000);
    return null;
  }
  return entered.trim();
}

async function offerToStoreSecret(
  name: string,
  endpoint: string,
  accessKey: string,
  secretKey: string,
): Promise<void> {
  const store = await showConfirm(
    "Store secret key?",
    `Save the secret key with "${name}" so you are not asked for it next time?`,
    { okLabel: "Store" },
  );
  if (!store) return;
  try {
    const updated = await updateBookmark(
      { endpoint, access_key: accessKey },
      { secret_key: secretKey },
    );
    setStatus(
      updated
        ? `Stored the secret key for "${name}".`
        : "That saved connection is no longer saved.",
      5000,
    );
  } catch (err) {
    setStatus(`Could not store the secret key: ${friendlyError(err)}`, 8000);
  }
}

export async function switchToBookmark(
  name: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken = "",
): Promise<void> {
  let secret = secretKey;
  let secretWasPrompted = false;
  if (!secret) {
    const entered = await promptForMissingSecret(name);
    if (entered === null) return;
    secret = entered;
    secretWasPrompted = true;
  }
  if (state.connected) {
    if (!(await confirmSessionTeardown("Switching connections"))) return;
    if (!(await handleDisconnect())) return;
  }
  // Supersede instead of dropping: a rapid second click updates inputs and
  // starts a newer connect generation that wins via generation guards.
  setConnectionInputs(endpoint, region, accessKey, secret, sessionToken);
  setStatus(`Connecting to "${name}"...`, 5000);
  await handleConnect();
  if (
    secretWasPrompted &&
    state.connected &&
    state.endpoint === endpoint &&
    connectedAccessKey === accessKey
  ) {
    await offerToStoreSecret(name, endpoint, accessKey, secret);
  }
}

/**
 * Show a form-level error. When `invalidFieldId` is given, that field is
 * marked aria-invalid, described by the error, and focused.
 */
export function setConnectionFormError(
  message: string | null,
  invalidFieldId?: string,
): void {
  for (const id of CREDENTIAL_FIELD_IDS) {
    const field = document.getElementById(id);
    if (!field) continue;
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
  }
  const el = document.getElementById("conn-form-error");
  if (el) {
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }
  if (message && invalidFieldId) {
    const field = document.getElementById(invalidFieldId);
    if (field) {
      field.setAttribute("aria-invalid", "true");
      if (el) field.setAttribute("aria-describedby", "conn-form-error");
      field.focus();
    }
  }
}

function focusConnectionField(id: string): void {
  (document.getElementById(id) as HTMLElement | null)?.focus();
}

function setConnectButtonBusy(busy: boolean): void {
  const btn = dom.connectBtn;
  btn.disabled = false;
  if (busy) {
    // While connecting the same control cancels the attempt.
    btn.dataset.busy = "true";
    btn.innerHTML = `<span class="spinner spinner--btn" aria-hidden="true"></span> Cancel`;
  } else {
    delete btn.dataset.busy;
    btn.textContent = "Connect";
  }
  setConnectionFormDisabled(busy);
}

function setConnectionFormDisabled(disabled: boolean): void {
  const ids = [
    "conn-provider-preset",
    "conn-endpoint",
    "conn-region",
    "conn-access-key",
    "conn-secret-key",
    "conn-session-token",
    "conn-new-btn",
    "bookmark-save-btn",
  ];
  for (const id of ids) {
    const el = document.getElementById(id) as
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null;
    if (el) el.disabled = disabled;
  }
  const savedList = document.getElementById("conn-saved-list");
  if (savedList) {
    savedList.classList.toggle("conn-saved-list--disabled", disabled);
    savedList
      .querySelectorAll<HTMLElement>(".bookmark-item")
      .forEach((item) => {
        item.tabIndex = disabled ? -1 : 0;
      });
  }
}

/** Cancel the in-flight connect. Any session it establishes is torn down. */
export function cancelPendingConnect(): void {
  const attempt = pendingConnectAttempt;
  if (!attempt || attempt.cancelled) return;
  attempt.cancelled = true;
  pendingConnectAttempt = null;
  state.connecting = false;
  setConnectButtonBusy(false);
  setConnectionFormError(null);
  setStatus("Connection cancelled.", 5000);
}

/** Connect button: starts a connect, or cancels the one in flight. */
export function handleConnectButton(): void {
  if (dom.connectBtn.dataset.busy === "true") {
    cancelPendingConnect();
    return;
  }
  void handleConnect();
}

export function setConnectionUI(connected: boolean): void {
  const badge = dom.connectionStatus;
  const mainLayout = document.getElementById("main-layout");
  const connScreen = document.getElementById("connection-screen");

  if (connected) {
    badge.textContent = "Connected";
    badge.className = "connection-badge connection-badge--on";
    dom.connectBtn.style.display = "none";
    dom.disconnectBtn.style.display = "";
    if (mainLayout) mainLayout.style.display = "flex";
    if (connScreen) connScreen.style.display = "none";
    setConnectionFormError(null);
  } else {
    badge.textContent = "Disconnected";
    badge.className = "connection-badge connection-badge--off";
    dom.connectBtn.style.display = "";
    dom.disconnectBtn.style.display = "none";
    if (mainLayout) mainLayout.style.display = "none";
    if (connScreen) connScreen.style.display = "flex";
  }
  refreshBookmarkBar();
}

function isGenerationCurrent(
  generation: number,
  connectionId: string,
): boolean {
  return (
    currentConnectionGeneration() === generation &&
    state.connectionId === connectionId
  );
}

/** Restore the last-used bucket after the layout is visible. */
async function restoreLastBucket(
  generation: number,
  connectionId: string,
): Promise<void> {
  // Restore the last bucket if still present; otherwise stay unselected
  // rather than auto-selecting buckets[0].
  const lastBucket = readLastBucket();
  const restoreTarget = lastBucket
    ? state.buckets.find((b) => b.name === lastBucket)?.name
    : undefined;
  if (!restoreTarget) {
    showEmptyState();
    // showEmptyState also clears the bucket list; the connection is still
    // usable and must leave the fetched buckets available for selection.
    renderBucketList();
    return;
  }
  try {
    await selectBucket(restoreTarget);
  } catch (restoreError) {
    if (!isGenerationCurrent(generation, connectionId)) return;
    // A listing failure is not a connection failure: keep the session and
    // the bucket list so the user can retry or choose another bucket.
    const message = `Connected, but failed to list "${restoreTarget}": ${friendlyError(restoreError)}`;
    // Same surface as every other bucket or folder failure: toast, status line
    // and an inline Retry row. Retry reports its own failure the same way.
    const retry = (): void => {
      selectBucket(restoreTarget).catch((err: unknown) => {
        if (!isGenerationCurrent(generation, connectionId)) return;
        reportNavFailure(
          `Failed to open bucket "${restoreTarget}": ${friendlyError(err)}`,
          retry,
        );
      });
    };
    reportNavFailure(message, retry);
    logActivity(message, "warning");
    renderBucketList();
  }
}

export async function handleConnect(): Promise<void> {
  // Allow superseding connects: rapid bookmark switches start a newer
  // generation in connect() that wins; stale flows exit via generation checks.
  const { endpoint, region, accessKey, secretKey, sessionToken } =
    getConnectionInputs();
  if (!endpoint || !accessKey || !secretKey) {
    const message = "Endpoint, access key, and secret key are required.";
    const invalidField = !endpoint
      ? "conn-endpoint"
      : !accessKey
        ? "conn-access-key"
        : "conn-secret-key";
    setConnectionFormError(message, invalidField);
    setStatus(message);
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    const message = "Endpoint must start with http:// or https://.";
    setConnectionFormError(message, "conn-endpoint");
    setStatus(message);
    return;
  }

  setConnectionFormError(null);
  state.connecting = true;
  const attempt: ConnectAttempt = { cancelled: false };
  pendingConnectAttempt = attempt;
  setConnectButtonBusy(true);
  const wasConnected = state.connected;
  let establishedConnectionId = "";
  let workflowGeneration = 0;
  let saveWarning: string | null = null;
  let focusAfterFailure: string | null = null;

  try {
    // Warn about cleartext HTTP for non-local endpoints (credentials sent unencrypted)
    if (/^http:\/\//i.test(endpoint)) {
      try {
        const host = new URL(endpoint).hostname;
        if (!isLocalEndpoint(endpoint)) {
          logActivity(
            `Warning: connecting over plain HTTP to ${host}. Credentials will be sent in cleartext.`,
            "warning",
          );
          const proceed = await showConfirm(
            "Insecure connection",
            `Credentials and object traffic will be sent without TLS to ${host}. Connect anyway?`,
            {
              okLabel: "Connect anyway",
              cancelLabel: "Cancel",
              okDanger: true,
            },
          );
          if (!proceed) {
            setStatus("Connection cancelled.", 5000);
            return;
          }
        }
      } catch {
        // URL parse failure handled by the regex check above
      }
    }

    setStatus("Connecting...");
    const connectionAttempt = connect(
      endpoint,
      region,
      accessKey,
      secretKey,
      sessionToken,
    );
    workflowGeneration = currentConnectionGeneration();
    const generation = workflowGeneration;
    const resolvedRegion = await connectionAttempt;
    establishedConnectionId = state.connectionId;
    if (attempt.cancelled) {
      // Cancel already restored the form; release the session this connect
      // published so a cancelled attempt does not stay connected.
      await disconnect(establishedConnectionId).catch((cleanupErr: unknown) => {
        logActivity(
          `Cleanup after a cancelled connect failed: ${friendlyError(cleanupErr)}`,
          "warning",
        );
        return false;
      });
      return;
    }
    (document.getElementById("conn-region") as HTMLInputElement).value =
      resolvedRegion;
    try {
      await saveConnection(
        establishedConnectionId,
        endpoint,
        resolvedRegion,
        accessKey,
        secretKey,
        sessionToken,
      );
    } catch (saveErr) {
      if (!isGenerationCurrent(generation, establishedConnectionId)) {
        return;
      }
      saveWarning = `Connected (credentials not saved: ${saveErr}).`;
      logActivity(
        `Connected, but failed to save credentials: ${saveErr}`,
        "warning",
      );
    }
    if (!isGenerationCurrent(generation, establishedConnectionId)) {
      return;
    }
    renderBucketListSkeleton();
    await refreshBuckets();
    if (!isGenerationCurrent(generation, establishedConnectionId)) {
      return;
    }
    state.bucketFilterText = "";
    const bucketFilterInput = document.getElementById(
      "bucket-filter-input",
    ) as HTMLInputElement | null;
    if (bucketFilterInput) bucketFilterInput.value = "";
    renderBucketList();
    connectedAccessKey = accessKey;
    // Show the connected layout before the last bucket's listing starts, so a
    // slow or stalled listing never looks like a hung reconnect.
    setConnectionUI(true);
    setStatus(saveWarning ?? "Connected.", 5000);
    logActivity(`Connected to ${endpoint}.`, "success");
    finishConnectAttempt(attempt, generation);

    await restoreLastBucket(generation, establishedConnectionId);
    if (!isGenerationCurrent(generation, establishedConnectionId)) {
      return;
    }
    try {
      await recoverPendingTransfers();
      await resumeRecoveredTransfersAfterConnect();
    } catch (recoveryError) {
      const message = `Connected, but transfer recovery is still pending: ${friendlyError(recoveryError)}`;
      setStatus(message, 8000);
      logActivity(message, "warning");
    }
  } catch (e) {
    if (attempt.cancelled) return;
    const stillOwnSession =
      Boolean(establishedConnectionId) &&
      state.connectionId === establishedConnectionId;
    if (stillOwnSession) {
      try {
        const disconnected = await disconnect(establishedConnectionId);
        if (!disconnected) return;
      } catch (disconnectErr) {
        const message = `Connection setup failed, and cleanup failed: ${friendlyError(disconnectErr)}`;
        setConnectionFormError(message);
        setStatus(message);
        setConnectionUI(state.connected);
        logActivity(message, "error");
        return;
      }
    } else if (establishedConnectionId) {
      return;
    }
    // Guard stale error renders: a superseded connect must not repaint.
    if (
      workflowGeneration &&
      currentConnectionGeneration() !== workflowGeneration
    ) {
      return;
    }
    renderBucketList();
    const message = `Connection failed: ${friendlyError(e)}`;
    setConnectionFormError(message);
    setStatus(message);
    setConnectionUI(wasConnected && state.connected);
    logActivity(message, "error");
    // Move focus off the (re-enabled) Connect button to the form so the
    // error is announced where the user is working.
    focusAfterFailure = "conn-endpoint";
  } finally {
    if (pendingConnectAttempt === attempt) pendingConnectAttempt = null;
    if (workflowGeneration) {
      finishConnecting(workflowGeneration);
    } else if (!state.connected) {
      state.connecting = false;
    }
    if (
      !workflowGeneration ||
      currentConnectionGeneration() === workflowGeneration
    ) {
      setConnectButtonBusy(false);
    }
    if (focusAfterFailure) focusConnectionField(focusAfterFailure);
  }
}

/** Connect has produced a live session; release the busy form before listing buckets. */
function finishConnectAttempt(
  attempt: ConnectAttempt,
  generation: number,
): void {
  if (pendingConnectAttempt === attempt) pendingConnectAttempt = null;
  finishConnecting(generation);
  setConnectButtonBusy(false);
}

export async function handleDisconnect(): Promise<boolean> {
  let disconnected: boolean;
  try {
    disconnected = await disconnect();
  } catch (err) {
    logActivity(`Disconnect error: ${err}`, "error");
    setConnectionUI(state.connected);
    setStatus(`Disconnect failed: ${friendlyError(err)}`, 5000);
    setConnectButtonBusy(false);
    return false;
  }
  // A resolved old disconnect may have been superseded by a newer session.
  // Only the call that actually cleared connection state owns the UI teardown.
  if (!disconnected || state.connected) {
    setConnectButtonBusy(false);
    return false;
  }

  connectedAccessKey = "";
  clearFilterInputDebounce();
  state.filterText = "";
  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  if (filterInput) filterInput.value = "";
  state.bucketFilterText = "";
  const bucketFilterInput = document.getElementById(
    "bucket-filter-input",
  ) as HTMLInputElement | null;
  if (bucketFilterInput) bucketFilterInput.value = "";

  clearNavHistory();
  clearSelection();
  setInspectorOpen(false);
  // Release mobile sidebar-owned inert state before swapping to the reconnect UI.
  setSidebarOpen(false);
  setConnectionUI(false);
  setConnectButtonBusy(false);
  dom.connectBtn.focus();
  showEmptyState();
  setStatus("Disconnected.", 5000);
  logActivity("Disconnected from endpoint.", "info");
  return true;
}

/** Disconnect action: confirms first when transfers would be paused. */
export async function handleDisconnectRequest(): Promise<void> {
  if (state.connected) {
    if (!(await confirmSessionTeardown("Disconnecting"))) return;
  }
  await handleDisconnect();
}

export async function handleBookmarkSave(): Promise<void> {
  const { endpoint, region, accessKey, secretKey, sessionToken } =
    getConnectionInputs();
  if (!endpoint || !accessKey) {
    const invalidField = endpoint ? "conn-access-key" : "conn-endpoint";
    const message = "Fill in endpoint and access key to save a connection.";
    setConnectionFormError(message, invalidField);
    setStatus(message);
    return;
  }

  const existing = getBookmarks().find(
    (b) => b.endpoint === endpoint && b.access_key === accessKey,
  );
  if (existing) {
    if (secretKey && secretKey !== existing.secret_key) {
      const replace = await showConfirm(
        "Update saved connection",
        `"${existing.name}" already uses this endpoint and access key. Replace its stored secret key with the one you entered?`,
        { okLabel: "Replace" },
      );
      if (replace) {
        try {
          await updateBookmark(existing, { secret_key: secretKey });
          showToast(`Updated the secret key for "${existing.name}".`, {
            type: "success",
          });
        } catch (err) {
          setConnectionFormError(
            `Could not update "${existing.name}": ${friendlyError(err)}`,
          );
        }
      }
    } else {
      showToast(`"${existing.name}" is already saved.`);
    }
    updateBookmarkBtn();
    return;
  }

  const entered = await showPrompt(
    "Save connection",
    "Name this saved connection:",
    {
      inputDefault: suggestBookmarkName(endpoint, region, accessKey),
      okLabel: "Save",
      validate: async (value: string) =>
        value.trim().length > 0 || "Enter a name for this connection.",
    },
  );
  if (entered === null) return;
  const name = entered.trim();

  try {
    const added = await addBookmark({
      name,
      endpoint,
      region,
      access_key: accessKey,
      secret_key: secretKey,
      ...(sessionToken ? { session_token: sessionToken } : {}),
    });
    if (added) {
      showToast(`Saved connection "${name}".`, { type: "success" });
    } else {
      showToast(`"${name}" is already saved.`);
    }
  } catch (err) {
    setConnectionFormError(
      `Could not save the connection: ${friendlyError(err)}`,
    );
  }
  updateBookmarkBtn();
}
