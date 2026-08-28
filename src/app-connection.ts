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
  showEmptyState,
  clearSelection,
  clearNavHistory,
} from "./browser.ts";
import {
  addBookmark,
  renderBookmarkBar,
  isEndpointBookmarked,
  renderBookmarkList,
  removeBookmark,
} from "./bookmarks.ts";
import { friendlyError } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { clearFilterInputDebounce } from "./app-layout.ts";
import { setInspectorOpen } from "./inspector.ts";
import { showConfirm } from "./dialogs.ts";

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
  return { endpoint, region, accessKey, secretKey };
}

export function setConnectionInputs(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): void {
  (document.getElementById("conn-endpoint") as HTMLInputElement).value =
    endpoint;
  (document.getElementById("conn-region") as HTMLInputElement).value = region;
  (document.getElementById("conn-access-key") as HTMLInputElement).value =
    accessKey;
  (document.getElementById("conn-secret-key") as HTMLInputElement).value =
    secretKey;
  updateBookmarkBtn();
}

export function updateBookmarkBtn(): void {
  const btn = document.getElementById("bookmark-save-btn");
  if (!btn) return;
  const { endpoint } = getConnectionInputs();
  const active = endpoint ? isEndpointBookmarked(endpoint) : false;
  btn.classList.toggle("bookmark-save-btn--active", active);
}

export function refreshSavedConnectionsList(): void {
  const savedList = document.getElementById("conn-saved-list");
  if (!savedList) return;
  renderBookmarkList(
    savedList,
    (bookmark) => {
      void switchToBookmark(
        bookmark.name,
        bookmark.endpoint,
        bookmark.region,
        bookmark.access_key,
        bookmark.secret_key,
      );
    },
    (index) => {
      void removeBookmark(index);
    },
    {
      emptyMessage:
        "No saved connections yet. Connect using the form, or save a bookmark after you connect.",
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
        );
      },
      state.connected ? state.endpoint : undefined,
      () => {
        void handleNewConnection();
      },
    );
  }
  refreshSavedConnectionsList();
  updateBookmarkBtn();
}

export async function handleNewConnection(): Promise<void> {
  if (state.connected) {
    if (!(await handleDisconnect())) return;
  }
  setConnectionInputs("", "", "", "");
  setConnectionFormError(null);
  (document.getElementById("conn-endpoint") as HTMLInputElement).focus();
  setStatus("Ready for a new connection.", 5000);
}

export async function switchToBookmark(
  name: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): Promise<void> {
  if (state.connecting) return;
  if (state.connected) {
    if (!(await handleDisconnect())) return;
  }
  setConnectionInputs(endpoint, region, accessKey, secretKey);
  setStatus(`Connecting to "${name}"...`, 5000);
  await handleConnect();
}

export function setConnectionFormError(message: string | null): void {
  const el = document.getElementById("conn-form-error");
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function setConnectButtonBusy(busy: boolean): void {
  const btn = dom.connectBtn;
  if (busy) {
    btn.disabled = true;
    btn.dataset.busy = "true";
    btn.innerHTML = `<span class="spinner spinner--btn" aria-hidden="true"></span> Connecting…`;
  } else {
    btn.disabled = false;
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

export async function handleConnect(): Promise<void> {
  if (state.connecting) return;
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !accessKey || !secretKey) {
    const message = "Endpoint, access key, and secret key are required.";
    setConnectionFormError(message);
    setStatus(message);
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    const message = "Endpoint must start with http:// or https://.";
    setConnectionFormError(message);
    setStatus(message);
    return;
  }

  setConnectionFormError(null);
  state.connecting = true;
  setConnectButtonBusy(true);
  const wasConnected = state.connected;
  let establishedConnectionId = "";
  let workflowGeneration = 0;
  let saveWarning: string | null = null;

  try {
    // Warn about cleartext HTTP for non-local endpoints (credentials sent unencrypted)
    if (/^http:\/\//i.test(endpoint)) {
      try {
        const host = new URL(endpoint).hostname;
        const isLocal =
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "::1" ||
          host.endsWith(".local");
        if (!isLocal) {
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
    const connectionAttempt = connect(endpoint, region, accessKey, secretKey);
    workflowGeneration = currentConnectionGeneration();
    const generation = workflowGeneration;
    const resolvedRegion = await connectionAttempt;
    establishedConnectionId = state.connectionId;
    (document.getElementById("conn-region") as HTMLInputElement).value =
      resolvedRegion;
    try {
      await saveConnection(
        establishedConnectionId,
        endpoint,
        resolvedRegion,
        accessKey,
        secretKey,
      );
    } catch (saveErr) {
      if (
        currentConnectionGeneration() !== generation ||
        state.connectionId !== establishedConnectionId
      ) {
        return;
      }
      saveWarning = `Connected (credentials not saved: ${saveErr}).`;
      logActivity(
        `Connected, but failed to save credentials: ${saveErr}`,
        "warning",
      );
    }
    if (
      currentConnectionGeneration() !== generation ||
      state.connectionId !== establishedConnectionId
    ) {
      return;
    }
    renderBucketListSkeleton();
    await refreshBuckets();
    if (
      currentConnectionGeneration() !== generation ||
      state.connectionId !== establishedConnectionId
    ) {
      return;
    }
    renderBucketList();
    if (state.buckets.length > 0) {
      await selectBucket(state.buckets[0].name);
    }
    if (
      currentConnectionGeneration() !== generation ||
      state.connectionId !== establishedConnectionId
    ) {
      return;
    }
    setConnectionUI(true);
    setStatus(saveWarning ?? "Connected.", 5000);
    logActivity(`Connected to ${endpoint}.`, "success");
  } catch (e) {
    const stillOwnSession =
      Boolean(establishedConnectionId) &&
      state.connectionId === establishedConnectionId;
    if (stillOwnSession) {
      try {
        await disconnect(establishedConnectionId);
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
    renderBucketList();
    const message = `Connection failed: ${friendlyError(e)}`;
    setConnectionFormError(message);
    setStatus(message);
    setConnectionUI(wasConnected && state.connected);
    logActivity(message, "error");
  } finally {
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
  }
}

export async function handleDisconnect(): Promise<boolean> {
  clearFilterInputDebounce();
  state.filterText = "";
  const filterInput = document.getElementById(
    "filter-input",
  ) as HTMLInputElement | null;
  if (filterInput) filterInput.value = "";

  try {
    await disconnect();
  } catch (err) {
    logActivity(`Disconnect error: ${err}`, "error");
    setConnectionUI(state.connected);
    setStatus(`Disconnect failed: ${friendlyError(err)}`, 5000);
    setConnectButtonBusy(false);
    return false;
  }
  clearNavHistory();
  clearSelection();
  setInspectorOpen(false);
  setConnectionUI(false);
  setConnectButtonBusy(false);
  showEmptyState();
  setStatus("Disconnected.", 5000);
  logActivity("Disconnected from endpoint.", "info");
  return true;
}

export async function handleBookmarkSave(): Promise<void> {
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !accessKey) {
    setStatus("Fill in endpoint and access key to bookmark.");
    return;
  }

  let name = endpoint;
  try {
    const url = new URL(endpoint);
    name = url.hostname.split(".")[0] || endpoint;
  } catch {
    name = endpoint.replace(/^https?:\/\//, "").split(/[:/]/)[0] || endpoint;
  }

  try {
    const added = await addBookmark({
      name,
      endpoint,
      region,
      access_key: accessKey,
      secret_key: secretKey,
    });
    if (added) {
      setStatus(`Bookmarked "${name}".`, 5000);
    } else {
      setStatus(`Bookmark for this endpoint already exists.`, 5000);
    }
  } catch (err) {
    setStatus(`Failed to save bookmark: ${err}`);
  }
  updateBookmarkBtn();
}
