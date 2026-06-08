import { state, dom } from "./state.ts";
import {
  connect,
  disconnect,
  saveConnection,
  refreshBuckets,
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
} from "./bookmarks.ts";
import { friendlyError } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { clearFilterInputDebounce } from "./app-layout.ts";

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

export function refreshBookmarkBar(): void {
  const bar = document.getElementById("bookmark-bar");
  if (!bar) return;
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
  updateBookmarkBtn();
}

export async function handleNewConnection(): Promise<void> {
  if (state.connected) {
    await handleDisconnect();
  }
  setConnectionInputs("", "", "", "");
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
  const wasConnected = state.connected;
  if (wasConnected) {
    await handleDisconnect();
  }
  setConnectionInputs(endpoint, region, accessKey, secretKey);
  if (wasConnected) {
    await handleConnect();
  } else {
    setStatus(`Loaded bookmark "${name}".`, 5000);
  }
}

export function setConnectionUI(connected: boolean): void {
  const badge = dom.connectionStatus;
  if (connected) {
    badge.textContent = "Connected";
    badge.className = "connection-badge connection-badge--on";
    dom.connectBtn.style.display = "none";
    dom.disconnectBtn.style.display = "";
  } else {
    badge.textContent = "Disconnected";
    badge.className = "connection-badge connection-badge--off";
    dom.connectBtn.style.display = "";
    dom.disconnectBtn.style.display = "none";
  }
  refreshBookmarkBar();
}

export async function handleConnect(): Promise<void> {
  if (state.connecting) return;
  const { endpoint, region, accessKey, secretKey } = getConnectionInputs();
  if (!endpoint || !accessKey || !secretKey) {
    setStatus("Endpoint, access key, and secret key are required.");
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    setStatus("Endpoint must start with http:// or https://.");
    return;
  }

  dom.connectBtn.disabled = true;
  setStatus("Connecting...");

  try {
    const resolvedRegion = await connect(
      endpoint,
      region,
      accessKey,
      secretKey,
    );
    (document.getElementById("conn-region") as HTMLInputElement).value =
      resolvedRegion;
    setConnectionUI(true);
    setStatus("Connected.", 5000);
    logActivity(`Connected to ${endpoint}.`, "success");
    try {
      await saveConnection(endpoint, resolvedRegion, accessKey, secretKey);
    } catch (saveErr) {
      setStatus(`Connected (credentials not saved: ${saveErr}).`, 5000);
      logActivity(
        `Connected, but failed to save credentials: ${saveErr}`,
        "warning",
      );
    }
    renderBucketListSkeleton();
    await refreshBuckets();
    renderBucketList();
    if (state.buckets.length > 0) {
      await selectBucket(state.buckets[0].name);
    }
  } catch (e) {
    renderBucketList();
    setStatus(`Connection failed: ${friendlyError(e)}`);
    setConnectionUI(false);
    logActivity(`Connection failed: ${friendlyError(e)}`, "error");
  } finally {
    dom.connectBtn.disabled = false;
  }
}

export async function handleDisconnect(): Promise<void> {
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
  }
  clearNavHistory();
  clearSelection();
  setConnectionUI(false);
  showEmptyState();
  setStatus("Disconnected.", 5000);
  logActivity("Disconnected from endpoint.", "info");
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
