import { state, dom } from "./state.ts";
import { invoke } from "./ipc.ts";
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
  navigateToFolder,
} from "./browser.ts";
import {
  addBookmark,
  clearBookmarks,
  getBookmarks,
  renderBookmarkList,
  isEndpointBookmarked,
  removeBookmark,
  suggestBookmarkName,
  updateBookmark,
  type Bookmark,
} from "./bookmarks.ts";
import { friendlyError, isLocalEndpoint, plural, escapeHtml } from "./utils.ts";
import { logActivity } from "./activity-log.ts";
import { setStatus } from "./app-status.ts";
import { clearFilterInputDebounce, setSidebarOpen } from "./app-layout.ts";
import { setInspectorOpen } from "./inspector.ts";
import { showConfirm, showPrompt } from "./dialogs.ts";
import { showToast } from "./toast.ts";
import { openSettingsModal, switchSettingsTab } from "./settings.ts";
import { handleLockNow } from "./security.ts";
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

/* ==========================================================================
 * Per-connection location memory.
 *
 * The last bucket and prefix are remembered per saved connection so
 * switching connections lands where the user left off. The memory is keyed
 * on the connection NAME + ENDPOINT only — never on credentials — and
 * carries no secret material: a record is `{ bucket, prefix, lastUsedAt }`.
 * ========================================================================== */

export interface ConnectionLocationMemory {
  bucket: string;
  prefix: string;
  /** Epoch ms of the most recent use; drives the last-used markers. */
  lastUsedAt: number;
}

const CONNECTION_MEMORY_KEY = "s3-sidekick.connection-memory";

/** The memory key is the connection name and endpoint alone. */
export function connectionMemoryKey(name: string, endpoint: string): string {
  return `${name}\n${endpoint}`;
}

function readConnectionMemoryStore(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(CONNECTION_MEMORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Corrupt or unreadable storage reads as "nothing remembered".
    return {};
  }
}

function sanitizeLocationRecord(
  value: unknown,
): ConnectionLocationMemory | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const lastUsedAt = row.lastUsedAt;
  if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt)) {
    return null;
  }
  if (typeof row.bucket !== "string") return null;
  return {
    bucket: row.bucket,
    prefix: typeof row.prefix === "string" ? row.prefix : "",
    lastUsedAt,
  };
}

/** Last remembered bucket/prefix for one saved connection, or null. */
export function readConnectionLocation(
  name: string,
  endpoint: string,
): ConnectionLocationMemory | null {
  try {
    const store = readConnectionMemoryStore();
    return sanitizeLocationRecord(store[connectionMemoryKey(name, endpoint)]);
  } catch {
    return null;
  }
}

/**
 * Record the last bucket/prefix (and use time) for one saved connection.
 * Best effort: private-mode storage failures never break the flow.
 */
export function rememberConnectionLocation(
  name: string,
  endpoint: string,
  bucket: string,
  prefix: string,
  lastUsedAt: number = Date.now(),
): void {
  if (!name || !endpoint) return;
  try {
    const store = readConnectionMemoryStore();
    store[connectionMemoryKey(name, endpoint)] = {
      bucket,
      prefix,
      lastUsedAt,
    };
    window.localStorage.setItem(CONNECTION_MEMORY_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable; the memory is best effort.
  }
}

/** Drop the memory of a removed connection so the key is never stale. */
export function forgetConnectionLocation(name: string, endpoint: string): void {
  try {
    const store = readConnectionMemoryStore();
    const key = connectionMemoryKey(name, endpoint);
    if (!(key in store)) return;
    delete store[key];
    window.localStorage.setItem(CONNECTION_MEMORY_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable; nothing to clean up.
  }
}

/**
 * The saved connection used most recently, restricted to connections that
 * still exist in the saved list. Drives the "Reconnect to <last>" card.
 */
export function mostRecentRememberedConnection(
  bookmarks: ReadonlyArray<Pick<Bookmark, "name" | "endpoint">>,
): { name: string; endpoint: string; lastUsedAt: number } | null {
  let best: { name: string; endpoint: string; lastUsedAt: number } | null =
    null;
  for (const bookmark of bookmarks) {
    const memory = readConnectionLocation(bookmark.name, bookmark.endpoint);
    if (!memory) continue;
    if (!best || memory.lastUsedAt > best.lastUsedAt) {
      best = {
        name: bookmark.name,
        endpoint: bookmark.endpoint,
        lastUsedAt: memory.lastUsedAt,
      };
    }
  }
  return best;
}

/** Short relative label for a last-used marker, or null when it should hide. */
export function lastUsedLabel(timestamp: number, now: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const elapsed = now - timestamp;
  if (elapsed < 0) return null;
  if (elapsed < 45_000) return "just now";
  const minutes = Math.max(1, Math.floor(elapsed / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(elapsed / 86_400_000);
  if (days > 30) return null;
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The saved connection matching the live session, or null. */
function activeSavedConnection(): Bookmark | null {
  if (!state.connected || !state.endpoint || !connectedAccessKey) return null;
  return (
    getBookmarks().find(
      (b) =>
        b.endpoint === state.endpoint && b.access_key === connectedAccessKey,
    ) ?? null
  );
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

/* ==========================================================================
 * Header connection switcher.
 *
 * Replaces the old chip strip + status badge + header Disconnect button.
 * The button shows the status dot, the active connection name, and the
 * endpoint host; its menu lists the saved connections (current one marked
 * with aria-current) and the New/Manage/Disconnect/Lock-now actions.
 * ========================================================================== */

let switcherWired = false;
/** Cached "vault on and unlocked" verdict; refreshed on every menu open. */
let switcherVaultUnlocked: boolean | null = null;

function setSwitcherDot(dotState: "on" | "busy" | "off"): void {
  const dot = document.getElementById("conn-switcher-dot");
  if (dot) dot.dataset.state = dotState;
}

function isSwitcherMenuOpen(): boolean {
  const menu = document.getElementById("conn-switcher-menu");
  return Boolean(menu && !menu.hidden);
}

function setSwitcherMenuOpen(open: boolean): void {
  const menu = document.getElementById("conn-switcher-menu");
  const btn = document.getElementById("conn-switcher-btn");
  if (!menu || !btn) return;
  if (open) renderSwitcherMenu();
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) void refreshSwitcherVaultStatus();
}

function closeSwitcherMenu(): void {
  if (isSwitcherMenuOpen()) setSwitcherMenuOpen(false);
}

/**
 * Vault state for the Lock now item, fetched fresh on every menu open.
 * Fail closed: when the status cannot be read, Lock now stays hidden.
 */
async function refreshSwitcherVaultStatus(): Promise<void> {
  const lockItem = document.getElementById("conn-switcher-lock");
  if (!lockItem) return;
  try {
    const status = await invoke<{
      encryption_enabled?: boolean;
      unlocked?: boolean;
    }>("get_security_status");
    switcherVaultUnlocked =
      status.encryption_enabled === true && status.unlocked === true;
  } catch {
    switcherVaultUnlocked = false;
  }
  lockItem.hidden = !switcherVaultUnlocked;
}

/** Mirror of the settings-modal Lock now flow, reachable from the switcher. */
async function handleSwitcherLockNow(): Promise<void> {
  if (state.connected || state.activeTransferCount > 0) {
    if (!(await confirmSessionTeardown("Lock now"))) return;
  }
  if (state.connected && !(await handleDisconnect())) return;
  const locked = await handleLockNow(setStatus);
  if (locked) {
    setConnectionInputs("", "", "", "");
    setSavedConnectionsLocked(true);
    clearBookmarks();
    refreshBookmarkBar();
  }
}

/** Repaint the switcher button: status dot, connection name, host. */
export function refreshConnectionSwitcher(): void {
  const btn = document.getElementById("conn-switcher-btn");
  if (!btn) return;
  const nameEl = document.getElementById("conn-switcher-name");
  const hostEl = document.getElementById("conn-switcher-host");
  const dotState = state.connected ? "on" : state.connecting ? "busy" : "off";
  setSwitcherDot(dotState);

  let name = "No connection";
  let host = "";
  if (state.connected) {
    const active = activeSavedConnection();
    host = endpointHost(state.endpoint);
    name = active?.name ?? host;
  } else if (state.connecting) {
    name = "Connecting…";
  }
  if (nameEl) nameEl.textContent = name;
  if (hostEl) hostEl.textContent = host;
  if (isSwitcherMenuOpen()) renderSwitcherMenu();
}

/** (Re)render the switcher menu body: saved connections then the actions. */
function renderSwitcherMenu(): void {
  const saved = document.getElementById("conn-switcher-saved");
  if (!saved) return;
  if (isSavedConnectionsLocked()) {
    saved.innerHTML =
      `<p class="conn-switcher__locked">Saved connections are locked.</p>` +
      `<button type="button" class="conn-switcher__connection" data-unlock>Unlock</button>`;
    saved.onclick = (event) => {
      if ((event.target as HTMLElement | null)?.closest("[data-unlock]")) {
        closeSwitcherMenu();
        void unlockHandler?.();
      }
    };
    return;
  }
  const bookmarks = getBookmarks();
  if (bookmarks.length === 0) {
    saved.innerHTML = `<p class="conn-switcher__locked">No saved connections yet.</p>`;
    saved.onclick = null;
    return;
  }
  const active = activeSavedConnection();
  saved.innerHTML = bookmarks
    .map((bookmark) => {
      const current =
        active !== null &&
        active.endpoint === bookmark.endpoint &&
        active.access_key === bookmark.access_key;
      return (
        `<button type="button" class="conn-switcher__connection"${current ? ' aria-current="true"' : ""} data-index="${bookmarks.indexOf(bookmark)}">` +
        `<span class="conn-switcher__connection-name">${escapeHtml(bookmark.name)}</span>` +
        `<span class="conn-switcher__connection-host">${escapeHtml(endpointHost(bookmark.endpoint))}</span>` +
        `</button>`
      );
    })
    .join("");
  saved.onclick = (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".conn-switcher__connection",
    );
    if (!row?.dataset.index) return;
    const bookmark = bookmarks[Number(row.dataset.index)];
    if (!bookmark) return;
    closeSwitcherMenu();
    void switchToBookmark(
      bookmark.name,
      bookmark.endpoint,
      bookmark.region,
      bookmark.access_key,
      bookmark.secret_key,
      bookmark.session_token ?? "",
    );
  };
}

/** Wire the header switcher (idempotent; called from the form wiring). */
export function wireConnectionSwitcher(): void {
  const btn = document.getElementById("conn-switcher-btn");
  if (!btn || switcherWired) return;
  switcherWired = true;
  btn.addEventListener("click", () => {
    setSwitcherMenuOpen(!isSwitcherMenuOpen());
  });
  document.addEventListener("pointerdown", (event) => {
    if (!isSwitcherMenuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".conn-switcher-wrap")) return;
    closeSwitcherMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isSwitcherMenuOpen()) return;
    closeSwitcherMenu();
    btn.focus();
  });

  const newBtn = document.getElementById("conn-switcher-new");
  newBtn?.addEventListener("click", () => {
    closeSwitcherMenu();
    void handleNewConnection();
  });
  const manageBtn = document.getElementById("conn-switcher-manage");
  manageBtn?.addEventListener("click", () => {
    closeSwitcherMenu();
    openSettingsModal();
    switchSettingsTab("bookmarks");
  });
  const disconnectBtn = document.getElementById("conn-switcher-disconnect");
  disconnectBtn?.addEventListener("click", () => {
    closeSwitcherMenu();
    void handleDisconnectRequest();
  });
  const lockBtn = document.getElementById("conn-switcher-lock");
  lockBtn?.addEventListener("click", () => {
    closeSwitcherMenu();
    void handleSwitcherLockNow();
  });
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

/**
 * Edit a saved connection inline on the connect screen: the form is prefilled
 * with its credentials and Save updates that row instead of adding a new one.
 */
let inlineEditingBookmark: Bookmark | null = null;
/**
 * True while the form holds a Duplicate of a saved connection. A copy shares
 * the endpoint and access key until one of them changes, and a saved
 * connection's identity is that pair, so the save must say so.
 */
let duplicateDraft = false;

function isInlineEditing(): boolean {
  return inlineEditingBookmark !== null;
}

function setInlineEditBookmark(bookmark: Bookmark | null): void {
  inlineEditingBookmark = bookmark;
  duplicateDraft = false;
  const saveBtn = document.getElementById("bookmark-save-btn");
  if (saveBtn)
    saveBtn.textContent = bookmark ? "Update connection" : "Save connection";
  const nameInput = document.getElementById(
    "conn-name",
  ) as HTMLInputElement | null;
  if (nameInput) nameInput.value = bookmark ? bookmark.name : "";
}

/** Open the connect form prefilled for editing one saved connection. */
export function editSavedConnectionInline(bookmark: Bookmark): void {
  setInlineEditBookmark(bookmark);
  setConnectionInputs(
    bookmark.endpoint,
    bookmark.region,
    bookmark.access_key,
    bookmark.secret_key,
    bookmark.session_token ?? "",
  );
  setConnectionFormError(null);
  if (state.connected) {
    void (async () => {
      if (await confirmSessionTeardown("Editing a saved connection")) {
        await handleDisconnect();
      }
    })();
  }
  const endpoint = document.getElementById(
    "conn-endpoint",
  ) as HTMLInputElement | null;
  endpoint?.focus();
  setStatus(`Editing "${bookmark.name}". Save to keep your changes.`, 5000);
}

/** Load a copy of a saved connection into the form as a new connection. */
function duplicateSavedConnection(bookmark: Bookmark): void {
  setInlineEditBookmark(null);
  setConnectionInputs(
    bookmark.endpoint,
    bookmark.region,
    bookmark.access_key,
    bookmark.secret_key,
    bookmark.session_token ?? "",
  );
  duplicateDraft = true;
  const nameInput = document.getElementById(
    "conn-name",
  ) as HTMLInputElement | null;
  if (nameInput) nameInput.value = `${bookmark.name} (copy)`;
  setConnectionFormError(null);
  (document.getElementById("conn-name") as HTMLInputElement | null)?.focus();
  setStatus(
    `Duplicated "${bookmark.name}". Adjust the details and save.`,
    5000,
  );
}

export function refreshSavedConnectionsList(): void {
  const savedList = document.getElementById("conn-saved-list");
  if (!savedList) return;
  const locked = isSavedConnectionsLocked();
  const filterInput = document.getElementById(
    "conn-saved-filter",
  ) as HTMLInputElement | null;
  if (filterInput) {
    const showFilter = !locked && getBookmarks().length > 8;
    if (!showFilter) filterInput.value = "";
    filterInput.hidden = !showFilter;
  }
  if (locked) {
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
          forgetConnectionLocation(bookmark.name, bookmark.endpoint);
          if (isInlineEditing()) setInlineEditBookmark(null);
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
      filterText: filterInput?.value ?? "",
      lastUsedLabel: (bookmark) => {
        const memory = readConnectionLocation(bookmark.name, bookmark.endpoint);
        return memory ? lastUsedLabel(memory.lastUsedAt, Date.now()) : null;
      },
      onRename: (bookmark) => {
        void renameSavedConnection(bookmark);
      },
      onEdit: (bookmark) => {
        editSavedConnectionInline(bookmark);
      },
      onDuplicate: (bookmark) => {
        duplicateSavedConnection(bookmark);
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

/** Show or hide the "Reconnect to <last>" card on the connect screen. */
function refreshReconnectCard(): void {
  const card = document.getElementById("reconnect-card");
  if (!card) return;
  const recent =
    !isSavedConnectionsLocked() && !state.connected
      ? mostRecentRememberedConnection(getBookmarks())
      : null;
  if (!recent) {
    card.hidden = true;
    return;
  }
  const nameEl = document.getElementById("reconnect-card-name");
  const endpointEl = document.getElementById("reconnect-card-endpoint");
  if (nameEl) nameEl.textContent = recent.name;
  if (endpointEl) endpointEl.textContent = endpointHost(recent.endpoint);
  card.hidden = false;
}

export function refreshBookmarkBar(): void {
  refreshSavedConnectionsList();
  refreshReconnectCard();
  refreshConnectionSwitcher();
  updateBookmarkBtn();
}

export async function handleNewConnection(): Promise<void> {
  if (state.connected) {
    if (!(await confirmSessionTeardown("Starting a new connection"))) return;
    if (!(await handleDisconnect())) return;
  }
  setConnectionInputs("", "", "", "");
  setInlineEditBookmark(null);
  resetProviderPresetFields();
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
  // A switch supersedes any inline edit of the form.
  setInlineEditBookmark(null);
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
 * marked aria-invalid and described by the error. Pass `{ focus: false }`
 * for per-field blur validation, which must not steal focus back.
 */
export function setConnectionFormError(
  message: string | null,
  invalidFieldId?: string,
  options: { focus?: boolean } = {},
): void {
  const shouldFocus = options.focus ?? true;
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
      if (shouldFocus) field.focus();
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
  refreshConnectionSwitcher();
}

function setConnectionFormDisabled(disabled: boolean): void {
  const ids = [
    "conn-provider-preset",
    "conn-name",
    "conn-endpoint",
    "conn-region",
    "conn-r2-account",
    "conn-access-key",
    "conn-secret-key",
    "conn-session-token",
    "conn-new-btn",
    "conn-saved-filter",
    "bookmark-save-btn",
  ];
  for (const id of ids) {
    const el = document.getElementById(id) as
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null;
    if (el) el.disabled = disabled;
  }
  // Test connection is never available over a live session or another test.
  const testBtn = document.getElementById(
    "conn-test-btn",
  ) as HTMLButtonElement | null;
  if (testBtn) {
    testBtn.disabled = disabled || state.connected || testConnectionInFlight;
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
  const mainLayout = document.getElementById("main-layout");
  const connScreen = document.getElementById("connection-screen");

  if (connected) {
    dom.connectBtn.style.display = "none";
    if (mainLayout) mainLayout.style.display = "flex";
    if (connScreen) connScreen.style.display = "none";
    setConnectionFormError(null);
  } else {
    dom.connectBtn.style.display = "";
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

/**
 * Snapshot the live location under the active saved connection's name+endpoint
 * key (never under credentials). No-op when the session is not a saved one.
 */
function rememberActiveConnectionLocation(): void {
  const active = activeSavedConnection();
  if (!active) return;
  rememberConnectionLocation(
    active.name,
    active.endpoint,
    state.currentBucket,
    state.currentPrefix,
  );
}

/**
 * Mark the active saved connection as just used without touching its
 * remembered bucket and prefix: those are still needed by the restore that
 * follows the connect, and the fresh session has not selected anything yet.
 */
function touchActiveConnectionUse(): void {
  const active = activeSavedConnection();
  if (!active) return;
  const memory = readConnectionLocation(active.name, active.endpoint);
  rememberConnectionLocation(
    active.name,
    active.endpoint,
    memory?.bucket ?? "",
    memory?.prefix ?? "",
  );
}

/** Restore the remembered bucket and prefix after the layout is visible. */
async function restoreLastBucket(
  generation: number,
  connectionId: string,
): Promise<void> {
  // Per-connection memory wins; the global last bucket is the fallback for
  // connections that were never saved.
  const active = activeSavedConnection();
  const memory = active
    ? readConnectionLocation(active.name, active.endpoint)
    : null;
  const rememberedBucket = memory?.bucket;
  const lastBucket =
    rememberedBucket && rememberedBucket.length > 0
      ? rememberedBucket
      : readLastBucket();
  const restorePrefix = memory?.prefix ?? "";
  // Restore the last bucket if still present; otherwise stay unselected
  // rather than auto-selecting buckets[0].
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
  const restoreLocation = async (): Promise<void> => {
    await selectBucket(restoreTarget);
    if (restorePrefix && state.currentBucket === restoreTarget) {
      await navigateToFolder(restorePrefix);
    }
    rememberActiveConnectionLocation();
  };
  try {
    await restoreLocation();
  } catch (restoreError) {
    if (!isGenerationCurrent(generation, connectionId)) return;
    // A listing failure is not a connection failure: keep the session and
    // the bucket list so the user can retry or choose another bucket.
    const message = `Connected, but failed to list "${restoreTarget}": ${friendlyError(restoreError)}`;
    // Same surface as every other bucket or folder failure: toast, status line
    // and an inline Retry row. Retry reports its own failure the same way.
    const retry = (): void => {
      restoreLocation().catch((err: unknown) => {
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

/**
 * Plain HTTP to a non-local host sends credentials unencrypted, so it asks
 * first. Resolves true when the endpoint is not cleartext to a remote host.
 */
async function confirmCleartextEndpoint(endpoint: string): Promise<boolean> {
  if (!/^http:\/\//i.test(endpoint) || isLocalEndpoint(endpoint)) return true;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // URL parse failure is reported by the endpoint format check instead.
    return true;
  }
  logActivity(
    `Warning: connecting over plain HTTP to ${host}. Credentials will be sent in cleartext.`,
    "warning",
  );
  return showConfirm(
    "Insecure connection",
    `Credentials and object traffic will be sent without TLS to ${host}. Connect anyway?`,
    {
      okLabel: "Connect anyway",
      cancelLabel: "Cancel",
      okDanger: true,
    },
  );
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
    if (!(await confirmCleartextEndpoint(endpoint))) {
      setStatus("Connection cancelled.", 5000);
      return;
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
    // Mark the saved connection (if any) as just used for the reconnect card
    // and the last-used markers; the bucket/prefix memory updates on restore
    // and on disconnect.
    touchActiveConnectionUse();
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
  // Snapshot the location under the saved connection's name+endpoint before
  // the teardown clears state, so switching back restores it.
  rememberActiveConnectionLocation();
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

/* ==========================================================================
 * Test connection: verify credentials without keeping a session.
 * ========================================================================== */

let testConnectionInFlight = false;

function setTestButtonBusy(busy: boolean): void {
  const btn = document.getElementById(
    "conn-test-btn",
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = busy || state.connected || state.connecting;
  if (busy) {
    btn.dataset.busy = "true";
    btn.innerHTML = `<span class="spinner spinner--btn" aria-hidden="true"></span> Testing…`;
  } else {
    delete btn.dataset.busy;
    btn.textContent = "Test connection";
  }
}

/**
 * Close the throwaway session minted for a connection test. Only the exact
 * session connect() published is torn down: a session that was superseded by
 * a newer workflow is left to its own owner.
 */
async function endTestSession(testSessionId: string | null): Promise<void> {
  if (!testSessionId) return;
  if (state.connectionId !== testSessionId) return;
  const closed = await disconnect(testSessionId);
  if (!closed) throw new Error("Could not close the test session.");
}

/**
 * Test connection: connect → list_buckets → disconnect. No session is kept:
 * fail closed, the throwaway session is torn down even when the listing
 * fails, and a missing session id never becomes a retained one.
 */
export async function handleTestConnection(): Promise<void> {
  if (state.connected || state.connecting || testConnectionInFlight) return;
  const { endpoint, region, accessKey, secretKey, sessionToken } =
    getConnectionInputs();
  const missingField = !endpoint
    ? "conn-endpoint"
    : !accessKey
      ? "conn-access-key"
      : !secretKey
        ? "conn-secret-key"
        : null;
  if (missingField) {
    const message = "Endpoint, access key, and secret key are required.";
    setConnectionFormError(message, missingField);
    setStatus(message);
    return;
  }
  if (!/^https?:\/\/.+/i.test(endpoint)) {
    const message = "Endpoint must start with http:// or https://.";
    setConnectionFormError(message, "conn-endpoint");
    setStatus(message);
    return;
  }

  testConnectionInFlight = true;
  setTestButtonBusy(true);
  setConnectionFormDisabled(true);
  let testSessionId: string | null = null;
  try {
    if (!(await confirmCleartextEndpoint(endpoint))) {
      setStatus("Connection test cancelled.", 5000);
      return;
    }
    setStatus("Testing connection...");
    const resolvedRegion = await connect(
      endpoint,
      region,
      accessKey,
      secretKey,
      sessionToken,
    );
    testSessionId = state.connectionId;
    try {
      await refreshBuckets();
    } finally {
      await endTestSession(testSessionId);
    }
    const regionInput = document.getElementById(
      "conn-region",
    ) as HTMLInputElement | null;
    if (regionInput && resolvedRegion) regionInput.value = resolvedRegion;
    setStatus("Connection test succeeded.", 5000);
    logActivity(`Connection test to ${endpoint} succeeded.`, "success");
  } catch (err) {
    const message = `Connection test failed: ${friendlyError(err)}`;
    setStatus(message, 8000);
    logActivity(message, "error");
  } finally {
    // Belt and braces: a test never leaves a live session behind.
    try {
      await endTestSession(testSessionId);
    } catch {
      // Already reported through the catch path above when relevant.
    }
    testSessionId = null;
    testConnectionInFlight = false;
    setConnectionFormDisabled(false);
    setTestButtonBusy(false);
    refreshConnectionSwitcher();
  }
}

/* ==========================================================================
 * Provider presets, per-field blur validation, and form wiring.
 * ========================================================================== */

/** Prefill the endpoint/region for a provider preset selection. */
export function applyProviderPreset(preset: string): void {
  const endpointInput = document.getElementById(
    "conn-endpoint",
  ) as HTMLInputElement | null;
  const regionInput = document.getElementById(
    "conn-region",
  ) as HTMLInputElement | null;
  const r2Row = document.getElementById("conn-r2-account-row");
  const r2Account = document.getElementById(
    "conn-r2-account",
  ) as HTMLInputElement | null;
  if (r2Row) r2Row.hidden = preset !== "cloudflare";
  if (preset !== "cloudflare" && r2Account) r2Account.value = "";

  if (preset === "aws") {
    // Selecting AWS prefills the default region; editing the region then
    // rewrites the endpoint from it.
    if (endpointInput) endpointInput.value = awsRegionalEndpoint("us-east-1");
    if (regionInput) regionInput.value = "us-east-1";
  } else if (preset === "do") {
    if (endpointInput)
      endpointInput.value = "https://nyc3.digitaloceanspaces.com";
    if (regionInput) regionInput.value = "nyc3";
  } else if (preset === "backblaze") {
    if (endpointInput)
      endpointInput.value = "https://s3.us-west-004.backblazeb2.com";
    if (regionInput) regionInput.value = "us-west-004";
  } else if (preset === "cloudflare") {
    // The endpoint is built from the Account ID as it is typed.
    if (endpointInput) endpointInput.value = "";
    if (regionInput) regionInput.value = "auto";
    r2Account?.focus();
  } else if (preset === "minio") {
    if (endpointInput) endpointInput.value = "http://localhost:9000";
    if (regionInput) regionInput.value = "us-east-1";
  } else if (preset === "wasabi") {
    if (endpointInput) endpointInput.value = "https://s3.wasabisys.com";
    if (regionInput) regionInput.value = "us-east-1";
  }
  // "custom" and the empty choice prefill nothing.
  updateBookmarkBtn();
}

/** Reset preset-derived fields (New connection, after saving an edit). */
function resetProviderPresetFields(): void {
  const preset = document.getElementById(
    "conn-provider-preset",
  ) as HTMLSelectElement | null;
  if (preset) preset.value = "";
  const r2Row = document.getElementById("conn-r2-account-row");
  if (r2Row) r2Row.hidden = true;
  const r2Account = document.getElementById(
    "conn-r2-account",
  ) as HTMLInputElement | null;
  if (r2Account) r2Account.value = "";
}

/** Per-field validation for blur; null when the field is acceptable. */
function validateConnectionField(fieldId: string): string | null {
  const input = document.getElementById(fieldId) as HTMLInputElement | null;
  const value = input?.value.trim() ?? "";
  switch (fieldId) {
    case "conn-endpoint":
      if (!value) return "Endpoint is required.";
      if (!/^https?:\/\/.+/i.test(value)) {
        return "Endpoint must start with http:// or https://.";
      }
      return null;
    case "conn-access-key":
      return value ? null : "Access key is required.";
    case "conn-secret-key":
      return value ? null : "Secret key is required.";
    case "conn-r2-account":
      return value ? null : "Account ID is required for Cloudflare R2.";
    default:
      return null;
  }
}

let connectionScreenExtrasWired = false;

/**
 * Wire everything this screen owns that is not in app-events: the header
 * switcher, the test-connection button, the saved-list filter, the reconnect
 * card, preset-derived fields, and per-field blur validation. Idempotent.
 */
export function wireConnectionScreenExtras(): void {
  if (connectionScreenExtrasWired) return;
  connectionScreenExtrasWired = true;
  wireConnectionSwitcher();

  document.getElementById("conn-test-btn")?.addEventListener("click", () => {
    void handleTestConnection();
  });

  const filterInput = document.getElementById("conn-saved-filter");
  filterInput?.addEventListener("input", () => {
    refreshSavedConnectionsList();
  });

  document
    .getElementById("reconnect-card-btn")
    ?.addEventListener("click", () => {
      const recent = mostRecentRememberedConnection(getBookmarks());
      const bookmark = recent
        ? getBookmarks().find(
            (b) => b.name === recent.name && b.endpoint === recent.endpoint,
          )
        : undefined;
      if (!bookmark) return;
      void switchToBookmark(
        bookmark.name,
        bookmark.endpoint,
        bookmark.region,
        bookmark.access_key,
        bookmark.secret_key,
        bookmark.session_token ?? "",
      );
    });

  const presetSelect = document.getElementById(
    "conn-provider-preset",
  ) as HTMLSelectElement | null;
  const endpointInput = document.getElementById(
    "conn-endpoint",
  ) as HTMLInputElement | null;
  const regionInput = document.getElementById(
    "conn-region",
  ) as HTMLInputElement | null;
  const r2Account = document.getElementById(
    "conn-r2-account",
  ) as HTMLInputElement | null;

  // Hand-editing the endpoint drops the preset to Custom.
  endpointInput?.addEventListener("input", () => {
    if (presetSelect && presetSelect.value !== "custom") {
      presetSelect.value = "custom";
    }
    const r2Row = document.getElementById("conn-r2-account-row");
    if (r2Row) r2Row.hidden = true;
    updateBookmarkBtn();
  });

  // Changing the AWS region rewrites the AWS endpoint from it.
  regionInput?.addEventListener("input", () => {
    if (presetSelect?.value !== "aws" || !endpointInput) return;
    const region = regionInput.value.trim() || "us-east-1";
    endpointInput.value = awsRegionalEndpoint(region);
  });

  // The R2 preset builds the endpoint from the Account ID.
  r2Account?.addEventListener("input", () => {
    if (presetSelect?.value !== "cloudflare" || !endpointInput) return;
    const account = r2Account.value.trim();
    endpointInput.value = account
      ? `https://${account}.r2.cloudflarestorage.com`
      : "";
    updateBookmarkBtn();
  });

  // Validate on blur with a per-field error through setConnectionFormError.
  let blurErrorOwner: string | null = null;
  const reportBlurError = (fieldId: string): void => {
    const error = validateConnectionField(fieldId);
    if (error) {
      blurErrorOwner = fieldId;
      setConnectionFormError(error, fieldId, { focus: false });
    } else if (blurErrorOwner === fieldId) {
      blurErrorOwner = null;
      setConnectionFormError(null);
    }
  };
  for (const fieldId of [
    "conn-endpoint",
    "conn-region",
    "conn-r2-account",
    "conn-access-key",
    "conn-secret-key",
    "conn-name",
  ]) {
    const input = document.getElementById(fieldId);
    input?.addEventListener("blur", () => reportBlurError(fieldId));
    input?.addEventListener("input", () => {
      if (blurErrorOwner === fieldId && !validateConnectionField(fieldId)) {
        blurErrorOwner = null;
        setConnectionFormError(null);
      }
    });
  }
}

/** Apply an inline edit to the saved connection it was opened from. */
async function saveInlineBookmarkEdit(
  target: Bookmark,
  values: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    sessionToken: string;
    providedName: string;
  },
): Promise<void> {
  const name = values.providedName || target.name;
  if (!values.endpoint || !values.accessKey) {
    const invalidField = values.endpoint ? "conn-access-key" : "conn-endpoint";
    const message = "Fill in endpoint and access key to save a connection.";
    setConnectionFormError(message, invalidField);
    setStatus(message);
    return;
  }
  try {
    const updated = await updateBookmark(
      { endpoint: target.endpoint, access_key: target.access_key },
      {
        name,
        endpoint: values.endpoint,
        region: values.region,
        access_key: values.accessKey,
        secret_key: values.secretKey,
        ...(values.sessionToken ? { session_token: values.sessionToken } : {}),
      },
    );
    if (!updated) {
      setStatus("That saved connection is no longer saved.", 5000);
    } else {
      showToast(`Updated "${name}".`, { type: "success" });
      setConnectionInputs(
        values.endpoint,
        values.region,
        values.accessKey,
        values.secretKey,
        values.sessionToken,
      );
    }
    setInlineEditBookmark(null);
    updateBookmarkBtn();
  } catch (err) {
    setConnectionFormError(`Could not update "${name}": ${friendlyError(err)}`);
  }
}

export async function handleBookmarkSave(): Promise<void> {
  const { endpoint, region, accessKey, secretKey, sessionToken } =
    getConnectionInputs();
  const nameInput = document.getElementById(
    "conn-name",
  ) as HTMLInputElement | null;
  const providedName = nameInput?.value.trim() ?? "";

  if (inlineEditingBookmark) {
    await saveInlineBookmarkEdit(inlineEditingBookmark, {
      endpoint,
      region,
      accessKey,
      secretKey,
      sessionToken,
      providedName,
    });
    return;
  }

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
  if (existing && duplicateDraft) {
    const message =
      "A saved connection already uses this endpoint and access key. Change the access key or endpoint to save a copy.";
    setConnectionFormError(message, "conn-access-key");
    setStatus(message);
    return;
  }
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

  let name: string;
  if (providedName) {
    name = providedName;
  } else {
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
    name = entered.trim();
  }

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
