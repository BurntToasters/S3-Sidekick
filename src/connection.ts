import { invoke, type InvokeCall, type S3InvokeCall } from "./ipc.ts";
import { clearAllSelection } from "./app-selection.ts";
import { state } from "./state.ts";
import { showToast } from "./toast.ts";
import type { BucketInfo, ObjectInfo } from "./state.ts";
import {
  FULL_CREATE_ONLY_CAPABILITIES,
  NO_CREATE_ONLY_CAPABILITIES,
  type CreateOnlyCapabilities,
} from "./create-only-capabilities.ts";
import {
  formatSftpEndpoint,
  isSftpSettings,
  isValidSftpEndpoint,
  looksLikeSftpEndpoint,
  parseSftpConnectStep,
  parseSftpEndpoint,
  parseSftpListResponse,
  sftpCreateOnlyCapabilities,
  sftpListingToObjects,
  sftpPathFromKey,
  sftpVirtualBucket,
  type SftpAuthMethod,
  type SftpConnectStep,
  type SftpHostKeyUnknownStep,
  type SftpPromptStep,
  type SftpSettings,
} from "./sftp.ts";

interface ConnectionConfig {
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
  session_token?: string;
  protocol?: "sftp";
  sftp?: SftpSettings;
}

interface ConnectResult {
  region: string;
  connection_id: string;
  connection_identity: string;
  create_only_capabilities?: unknown;
  conditional_delete_supported?: unknown;
}

interface ListObjectsResponse {
  objects: ObjectInfo[];
  prefixes: string[];
  truncated: boolean;
  next_continuation_token: string;
}

let connectionGeneration = 0;
let connectionAccessLocked = false;
let connectionAccessGeneration = 0;
let listingGeneration = 0;
let activeListingRequest: number | null = null;
let paginationRequest = 0;
let bucketRequest = 0;

// Upper bound for paginated "Load more" accumulation in one listing.
export const MAX_ACCUMULATED_LISTING_ITEMS = 5000;

interface TrailingListingRefresh {
  connectionId: string;
  bucket: string;
  prefix: string;
  /** Kept only while every coalesced request asked to keep the selection. */
  preserveSelection: boolean;
  promise: Promise<boolean>;
  settle: (result: boolean | PromiseLike<boolean>) => void;
}

let trailingListingRefresh: TrailingListingRefresh | null = null;

function invalidateListingOwnership(): void {
  listingGeneration += 1;
  activeListingRequest = null;
  paginationRequest += 1;
  const trailing = trailingListingRefresh;
  trailingListingRefresh = null;
  trailing?.settle(false);
}

function parseCreateOnlyCapabilities(value: unknown): CreateOnlyCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...NO_CREATE_ONLY_CAPABILITIES };
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.put_object !== "boolean" ||
    typeof row.complete_multipart !== "boolean" ||
    typeof row.copy_object !== "boolean"
  ) {
    return { ...NO_CREATE_ONLY_CAPABILITIES };
  }
  return {
    put_object: row.put_object,
    complete_multipart: row.complete_multipart,
    copy_object: row.copy_object,
  };
}

/** Only an explicit `true` grants move authority; anything else is unsupported. */
function parseConditionalDeleteSupported(value: unknown): boolean {
  return value === true;
}

export function currentConnectionId(): string {
  if (!state.connectionId) {
    throw new Error("Not connected");
  }
  return state.connectionId;
}

export function currentConnectionGeneration(): number {
  return connectionGeneration;
}

/** Generation of the object listing currently owned by the view. */
export function currentListingGeneration(): number {
  return listingGeneration;
}

/** Storage key for the per-saved-connection bucket/prefix memory. */
export const CONNECTION_MEMORY_STORAGE_KEY = "s3-sidekick.connection-memory";

/** Location memory is keyed on the saved connection's name and endpoint only. */
export function connectionMemoryKey(name: string, endpoint: string): string {
  return `${name}\n${endpoint}`;
}

/**
 * Drop the remembered bucket/prefix for a saved connection. Called when the
 * connection is deleted or its name/endpoint changes, so a stale key can never
 * redirect a later connection to the wrong place.
 */
export function forgetConnectionLocation(name: string, endpoint: string): void {
  try {
    const raw = window.localStorage.getItem(CONNECTION_MEMORY_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return;
    }
    const store = parsed as Record<string, unknown>;
    const key = connectionMemoryKey(name, endpoint);
    if (!(key in store)) return;
    delete store[key];
    window.localStorage.setItem(
      CONNECTION_MEMORY_STORAGE_KEY,
      JSON.stringify(store),
    );
  } catch {
    // Storage unavailable; nothing to clean up.
  }
}

/** Close every frontend S3 admission path after encrypted storage locks. */
export function setConnectionAccessLocked(locked: boolean): void {
  if (connectionAccessLocked === locked) return;
  connectionAccessLocked = locked;
  connectionAccessGeneration += 1;
  if (locked) {
    connectionGeneration += 1;
    state.connecting = false;
    state.connected = false;
  }
}

export function isConnectionAccessLocked(): boolean {
  return connectionAccessLocked;
}

export function currentBucketRequest(): number {
  return bucketRequest;
}

/**
 * Synthesize delimiter prefixes from trailing-`/` folder-marker objects.
 * The backend may return zero-byte `foo/` keys with `is_folder` without a
 * matching entry in `prefixes`; the object table renders folders from
 * `prefixes` only, so derive the immediate child prefix here (small frontend
 * blast radius, no backend change).
 */
export function synthesizeMissingPrefixes(
  objects: ObjectInfo[],
  prefixes: string[],
  currentPrefix: string,
): string[] {
  const existing = new Set(prefixes);
  const synthesized: string[] = [];
  for (const obj of objects) {
    if (!obj.key.endsWith("/")) continue;
    if (!obj.key.startsWith(currentPrefix)) continue;
    if (obj.key === currentPrefix) continue;
    const remainder = obj.key.slice(currentPrefix.length);
    const slash = remainder.indexOf("/");
    if (slash < 0) continue;
    const immediate = currentPrefix + remainder.slice(0, slash + 1);
    if (!existing.has(immediate)) {
      existing.add(immediate);
      synthesized.push(immediate);
    }
  }
  return synthesized;
}

export interface ConnectionSnapshot {
  connectionId: string;
  connectionIdentity: string;
  endpoint: string;
  bucket: string;
  prefix: string;
}

export function captureConnectionSnapshot(): ConnectionSnapshot {
  if (
    !state.connected ||
    !state.connectionId ||
    !state.connectionIdentity ||
    !state.currentBucket
  ) {
    throw new Error("Not connected");
  }
  return {
    connectionId: state.connectionId,
    connectionIdentity: state.connectionIdentity,
    endpoint: state.endpoint,
    bucket: state.currentBucket,
    prefix: state.currentPrefix,
  };
}

export function connectionIdentityChanged(
  snap: Pick<
    ConnectionSnapshot,
    "connectionId" | "connectionIdentity" | "endpoint" | "bucket"
  >,
): boolean {
  return (
    !state.connected ||
    state.connectionId !== snap.connectionId ||
    state.connectionIdentity !== snap.connectionIdentity ||
    state.endpoint !== snap.endpoint ||
    state.currentBucket !== snap.bucket
  );
}

export function connectionSnapshotChanged(snap: ConnectionSnapshot): boolean {
  return connectionIdentityChanged(snap) || state.currentPrefix !== snap.prefix;
}

export function invokeS3For<T>(
  connectionId: string,
  ...call: S3InvokeCall
): Promise<T> {
  if (connectionAccessLocked) {
    throw new Error("Encrypted storage is locked; S3 access is unavailable.");
  }
  if (!connectionId) {
    throw new Error("Connection id is required");
  }
  const [cmd, args] = call;
  // The spread keeps each command's own argument check; connectionId is the
  // one key the contract requires that callers never pass themselves.
  return invoke<T>(...([cmd, { ...args, connectionId }] as InvokeCall));
}

export function invokeS3<T>(...call: S3InvokeCall): Promise<T> {
  return invokeS3For<T>(currentConnectionId(), ...call);
}

export async function connect(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken = "",
): Promise<string> {
  if (connectionAccessLocked) {
    throw new Error("Encrypted storage is locked; unlock before connecting.");
  }
  const accessGeneration = connectionAccessGeneration;
  const generation = ++connectionGeneration;
  invalidateListingOwnership();
  state.connecting = true;
  try {
    const result = await invoke<ConnectResult>("connect", {
      endpoint,
      region,
      accessKey,
      secretKey,
      sessionToken: sessionToken || null,
    });
    if (
      generation !== connectionGeneration ||
      accessGeneration !== connectionAccessGeneration ||
      connectionAccessLocked
    ) {
      throw new Error("Connection attempt superseded");
    }
    if (
      !result ||
      typeof result.region !== "string" ||
      typeof result.connection_id !== "string" ||
      result.connection_id.length === 0 ||
      typeof result.connection_identity !== "string" ||
      result.connection_identity.length === 0
    ) {
      throw new Error("Connection did not return a session identity");
    }
    // Requests started against the previous session while connect was pending
    // cannot own the newly published connection.
    invalidateListingOwnership();
    state.connected = true;
    state.protocol = "s3";
    state.sftpHomePath = "";
    state.endpoint = endpoint;
    state.region = result.region;
    state.connectionId = result.connection_id;
    state.connectionIdentity = result.connection_identity;
    state.createOnlyCapabilities = parseCreateOnlyCapabilities(
      result.create_only_capabilities,
    );
    state.conditionalDeleteSupported = parseConditionalDeleteSupported(
      result.conditional_delete_supported,
    );
    return result.region;
  } catch (err) {
    if (generation === connectionGeneration) {
      state.connecting = false;
    }
    throw err;
  }
}

export interface SftpConnectParams {
  host: string;
  port: number;
  username: string;
  authMethod: SftpAuthMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  pinnedHostKey?: string;
}

/** The user's answers to the two interactive steps of the SFTP connect flow. */
export interface SftpConnectCallbacks {
  /** Resolve true only when the user trusts the presented host key. */
  onHostKeyUnknown(info: SftpHostKeyUnknownStep): Promise<boolean>;
  /** Resolve with one answer per prompt, or null when the user cancels. */
  onPrompt(info: SftpPromptStep): Promise<string[] | null>;
  /**
   * True once the user cancelled this connect. Checked before each dialog and
   * before each reply, so a cancelled attempt opens nothing and answers nothing.
   */
  isCancelled?: () => boolean;
}

export interface SftpConnectOutcome {
  endpoint: string;
  hostKey: string;
  hostKeyFingerprint: string;
  homePath: string;
}

const SUPERSEDED_CONNECT = "Connection attempt superseded";
const CANCELLED_CONNECT = "Connection cancelled";

/** Generation of the SFTP connect in flight, or null when none is. */
let sftpConnectInFlight: number | null = null;

/**
 * Cancel the SFTP connect in flight on the backend, including one that has not
 * reported its first step yet and so has no attempt ID the webview could name.
 * Best effort: a connect that already finished makes this a no-op.
 */
export function cancelSftpConnectInFlight(): void {
  if (sftpConnectInFlight === null) return;
  void invoke("sftp_connect_cancel_pending").catch(() => {
    // The connect's own result reports how it ended.
  });
}

/**
 * Connect an SFTP session. The backend holds an attempt open while it waits for
 * a host-key decision or prompt answers; every exit that does not continue it
 * cancels it, and no reply is sent once the attempt has been superseded.
 */
export async function connectSftp(
  params: SftpConnectParams,
  callbacks: SftpConnectCallbacks,
): Promise<SftpConnectOutcome> {
  if (connectionAccessLocked) {
    throw new Error("Encrypted storage is locked; unlock before connecting.");
  }
  const accessGeneration = connectionAccessGeneration;
  const generation = ++connectionGeneration;
  invalidateListingOwnership();
  state.connecting = true;
  sftpConnectInFlight = generation;
  let pendingAttempt: string | null = null;
  const superseded = (): boolean =>
    generation !== connectionGeneration ||
    accessGeneration !== connectionAccessGeneration ||
    connectionAccessLocked;
  const stopIfEnded = (): void => {
    if (superseded()) throw new Error(SUPERSEDED_CONNECT);
    if (callbacks.isCancelled?.() === true) throw new Error(CANCELLED_CONNECT);
  };
  const cancelPending = async (): Promise<void> => {
    const attemptId = pendingAttempt;
    pendingAttempt = null;
    if (attemptId === null) return;
    try {
      await invoke("sftp_connect_cancel", { attemptId });
    } catch {
      // Best effort: the error that ended the attempt is the one reported.
    }
  };
  try {
    let step: SftpConnectStep = parseSftpConnectStep(
      await invoke<unknown>("sftp_connect", {
        host: params.host,
        port: params.port,
        username: params.username,
        authMethod: params.authMethod,
        password: params.password ?? null,
        privateKey: params.privateKey ?? null,
        passphrase: params.passphrase ?? null,
        pinnedHostKey: params.pinnedHostKey ?? null,
      }),
    );
    while (step.step !== "connected") {
      pendingAttempt = step.attempt_id;
      stopIfEnded();
      const attemptId = step.attempt_id;
      if (step.step === "host_key_unknown") {
        const trusted = await callbacks.onHostKeyUnknown(step);
        stopIfEnded();
        if (!trusted) throw new Error(CANCELLED_CONNECT);
        // Sending the reply consumes the attempt, so it is no longer pending.
        pendingAttempt = null;
        step = parseSftpConnectStep(
          await invoke<unknown>("sftp_connect_continue", {
            attemptId,
            trustHostKey: true,
          }),
        );
      } else {
        const answers = await callbacks.onPrompt(step);
        stopIfEnded();
        if (answers === null) throw new Error(CANCELLED_CONNECT);
        if (!Array.isArray(answers) || answers.length !== step.prompts.length) {
          throw new Error("The answers do not match the server's prompts.");
        }
        pendingAttempt = null;
        step = parseSftpConnectStep(
          await invoke<unknown>("sftp_connect_continue", {
            attemptId,
            responses: [...answers],
          }),
        );
      }
    }
    if (superseded()) throw new Error(SUPERSEDED_CONNECT);
    // Requests started against the previous session cannot own this one.
    invalidateListingOwnership();
    state.connected = true;
    state.protocol = "sftp";
    state.endpoint = step.endpoint;
    state.region = "";
    state.connectionId = step.connection_id;
    state.connectionIdentity = step.connection_identity;
    state.createOnlyCapabilities = sftpCreateOnlyCapabilities(
      step.create_only_supported,
    );
    state.conditionalDeleteSupported = false;
    state.sftpHomePath = step.home_path;
    return {
      endpoint: step.endpoint,
      hostKey: step.host_key,
      hostKeyFingerprint: step.host_key_fingerprint,
      homePath: step.home_path,
    };
  } catch (err) {
    await cancelPending();
    if (generation === connectionGeneration) {
      state.connecting = false;
    }
    throw err;
  } finally {
    if (sftpConnectInFlight === generation) sftpConnectInFlight = null;
  }
}

export function finishConnecting(generation: number): void {
  if (generation === connectionGeneration) {
    state.connecting = false;
  }
}

export async function disconnect(connectionId?: string): Promise<boolean> {
  const expectedId = connectionId ?? state.connectionId;
  // Invalidate connection workflows immediately so a pending connect cannot
  // publish after the user has requested a disconnect. Listing ownership is
  // invalidated only after the backend confirms this exact session closed.
  const generation = ++connectionGeneration;
  state.connecting = false;
  // Park the transfer queue before the backend closes the session: running
  // items then requeue instead of failing on "Transfer cancelled".
  state.transfersHeldForDisconnect = true;
  try {
    await invoke("disconnect", { connectionId: expectedId ?? "" });
  } catch (error) {
    state.transfersHeldForDisconnect = false;
    // The native command rejects a stale session as "Connection changed".
    // Once a newer frontend workflow or session owns state, that rejection is
    // a benign supersession and must not be reported as a failed disconnect.
    if (
      generation !== connectionGeneration ||
      (expectedId && state.connectionId && state.connectionId !== expectedId)
    ) {
      return false;
    }
    throw error;
  }
  if (generation !== connectionGeneration) return false;
  if (expectedId && state.connectionId && state.connectionId !== expectedId) {
    return false;
  }
  invalidateListingOwnership();
  state.connected = false;
  state.endpoint = "";
  state.region = "";
  state.connectionId = "";
  state.connectionIdentity = "";
  state.createOnlyCapabilities = { ...FULL_CREATE_ONLY_CAPABILITIES };
  state.conditionalDeleteSupported = false;
  state.protocol = "s3";
  state.sftpHomePath = "";
  state.currentBucket = "";
  state.currentPrefix = "";
  state.buckets = [];
  state.objects = [];
  state.prefixes = [];
  clearAllSelection();
  state.listingCapped = false;
  state.continuationToken = "";
  state.hasMore = false;
  return true;
}

export async function saveConnection(
  connectionId: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken = "",
): Promise<void> {
  if (!connectionId) {
    throw new Error("Connection id is required");
  }
  const config: ConnectionConfig = {
    endpoint,
    region,
    access_key: accessKey,
    secret_key: secretKey,
    ...(sessionToken ? { session_token: sessionToken } : {}),
  };
  await invoke("save_connection", {
    connectionId,
    json: JSON.stringify(config),
  });
}

export interface SftpSavedConnectionInput {
  endpoint: string;
  username: string;
  /** Account password, or the passphrase of the private key. */
  secret: string;
  auth: SftpAuthMethod;
  privateKey?: string;
  hostKey?: string;
}

/**
 * Save an SFTP connection. The backend binds the payload to the live session's
 * identity, so the endpoint is stored in its canonical form.
 */
export async function saveSftpConnection(
  connectionId: string,
  input: SftpSavedConnectionInput,
): Promise<void> {
  if (!connectionId) {
    throw new Error("Connection id is required");
  }
  const { host, port } = parseSftpEndpoint(input.endpoint);
  const sftp: SftpSettings = { auth: input.auth };
  if (input.privateKey) sftp.private_key = input.privateKey;
  if (input.hostKey) sftp.host_key = input.hostKey;
  if (!isSftpSettings(sftp)) {
    throw new Error("Those SFTP details are not valid for a saved connection.");
  }
  const config: ConnectionConfig = {
    protocol: "sftp",
    endpoint: formatSftpEndpoint(host, port),
    region: "",
    access_key: input.username,
    secret_key: input.secret,
    sftp,
  };
  await invoke("save_connection", {
    connectionId,
    json: JSON.stringify(config),
  });
}

/**
 * Why the last loadConnection() could not read the stored connection, or null
 * when it could (including "nothing saved"). Mirrors the bookmark loader so
 * startup can warn without treating a corrupt file as an empty one.
 */
let connectionLoadError: string | null = null;

export function getConnectionLoadError(): string | null {
  return connectionLoadError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An S3 record has no protocol and no SFTP fields. An SFTP record names the
 * protocol, carries valid SFTP settings, and has an SFTP endpoint. Anything
 * else is corrupt.
 */
function isSavedConnection(value: unknown): value is ConnectionConfig {
  if (!isRecord(value)) return false;
  const {
    endpoint,
    region,
    access_key,
    secret_key,
    session_token,
    protocol,
    sftp,
  } = value;
  if (
    typeof endpoint !== "string" ||
    typeof region !== "string" ||
    typeof access_key !== "string" ||
    typeof secret_key !== "string" ||
    (session_token !== undefined && typeof session_token !== "string")
  ) {
    return false;
  }
  if (protocol === undefined) {
    return sftp === undefined && !looksLikeSftpEndpoint(endpoint);
  }
  return (
    protocol === "sftp" && isValidSftpEndpoint(endpoint) && isSftpSettings(sftp)
  );
}

export async function loadConnection(): Promise<ConnectionConfig | null> {
  connectionLoadError = null;
  const raw = await invoke<string>("load_connection");
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSavedConnection(parsed)) {
      connectionLoadError = null;
      return parsed;
    }
    connectionLoadError = "the saved connection file is corrupt.";
    return null;
  } catch {
    connectionLoadError = "the saved connection could not be parsed.";
    return null;
  }
}

export async function refreshBuckets(): Promise<void> {
  if (state.protocol === "sftp") {
    // SFTP has no bucket list: the server is the one virtual bucket.
    bucketRequest += 1;
    state.buckets = [
      { name: sftpVirtualBucket(state.endpoint), creation_date: "" },
    ];
    return;
  }
  const generation = connectionGeneration;
  const request = ++bucketRequest;
  let buckets: BucketInfo[];
  try {
    buckets = await invokeS3<BucketInfo[]>("list_buckets");
  } catch (error) {
    // Ignore stale completions; only the latest request owns error reporting.
    if (request !== bucketRequest || generation !== connectionGeneration) {
      return;
    }
    throw error;
  }
  if (request !== bucketRequest || generation !== connectionGeneration) {
    return;
  }
  state.buckets = buckets;
}

export interface RefreshObjectsOptions {
  /** Do not interrupt an already-owned listing transaction. */
  supersedePending?: boolean;
  /** Keep the current selection (manual refresh) instead of clearing it. */
  preserveSelection?: boolean;
}

function queueTrailingListingRefresh(
  bucket: string,
  prefix: string,
  preserveSelection: boolean,
): Promise<boolean> {
  let connectionId: string;
  try {
    connectionId = currentConnectionId();
  } catch (error) {
    return Promise.reject(error);
  }

  if (trailingListingRefresh) {
    // Coalesce automatic refreshes behind the current owner. Keep one shared
    // promise, but follow the most recently committed location requested.
    trailingListingRefresh.connectionId = connectionId;
    trailingListingRefresh.bucket = bucket;
    trailingListingRefresh.prefix = prefix;
    // One request that wants the selection cleared clears it for all of them.
    trailingListingRefresh.preserveSelection =
      trailingListingRefresh.preserveSelection && preserveSelection;
    return trailingListingRefresh.promise;
  }

  let settle!: (result: boolean | PromiseLike<boolean>) => void;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  trailingListingRefresh = {
    connectionId,
    bucket,
    prefix,
    preserveSelection,
    promise,
    settle,
  };
  return promise;
}

function releaseListingOwnership(request: number): void {
  // A superseded owner must not clear or drain work belonging to the newer one.
  if (activeListingRequest !== request) return;
  activeListingRequest = null;

  const trailing = trailingListingRefresh;
  trailingListingRefresh = null;
  if (!trailing) return;

  // The owner has now fully committed or failed. Launch only if the automatic
  // refresh still describes the same live connection and committed location.
  if (
    state.connectionId !== trailing.connectionId ||
    state.currentBucket !== trailing.bucket ||
    state.currentPrefix !== trailing.prefix
  ) {
    trailing.settle(false);
    return;
  }

  trailing.settle(
    runObjectRefresh(
      trailing.bucket,
      trailing.prefix,
      trailing.preserveSelection,
    ),
  );
}

/** One listing page in the object model, whichever backend produced it. */
interface ListingPage {
  objects: ObjectInfo[];
  prefixes: string[];
  hasMore: boolean;
  nextToken: string;
  /** SFTP listings are capped by the backend, not paginated. */
  capped: boolean;
}

async function fetchListingPage(
  connectionId: string,
  protocol: "s3" | "sftp",
  bucket: string,
  prefix: string,
  continuationToken: string,
): Promise<ListingPage> {
  if (protocol === "sftp") {
    const raw = await invokeS3For<unknown>(connectionId, "sftp_list_dir", {
      path: sftpPathFromKey(prefix),
    });
    const listing = parseSftpListResponse(raw);
    const mapped = sftpListingToObjects(listing, prefix);
    return {
      objects: mapped.objects,
      prefixes: mapped.prefixes,
      hasMore: false,
      nextToken: "",
      capped: listing.truncated,
    };
  }
  const response = await invokeS3For<ListObjectsResponse>(
    connectionId,
    "list_objects",
    {
      bucket,
      prefix,
      delimiter: "/",
      continuationToken,
    },
  );
  return {
    objects: response.objects,
    prefixes: response.prefixes,
    hasMore: response.truncated,
    nextToken: response.next_continuation_token,
    capped: false,
  };
}

async function runObjectRefresh(
  bucket: string,
  prefix: string,
  preserveSelection = false,
): Promise<boolean> {
  const request = ++listingGeneration;
  activeListingRequest = request;
  try {
    const connectionId = currentConnectionId();
    const protocol = state.protocol;
    paginationRequest += 1;
    let page: ListingPage;
    try {
      page = await fetchListingPage(connectionId, protocol, bucket, prefix, "");
    } catch (error) {
      if (
        request === listingGeneration &&
        state.connectionId === connectionId
      ) {
        throw error;
      }
      return false;
    }
    if (request !== listingGeneration || state.connectionId !== connectionId) {
      return false;
    }
    state.currentBucket = bucket;
    state.currentPrefix = prefix;
    state.objects = page.objects;
    // Frontend synthesis (preferred): surface empty folders whose only
    // evidence is a trailing-`/` marker object without a prefixes entry.
    state.prefixes = [
      ...page.prefixes,
      ...synthesizeMissingPrefixes(page.objects, page.prefixes, prefix),
    ];
    state.continuationToken = page.nextToken;
    state.hasMore = page.hasMore;
    state.listingCapped = page.capped;
    if (!preserveSelection) {
      clearAllSelection();
    }
    return true;
  } finally {
    releaseListingOwnership(request);
  }
}

export function refreshObjects(
  bucket: string,
  prefix: string,
  options: RefreshObjectsOptions = {},
): Promise<boolean> {
  // Automatic refreshes are derived from the currently committed location. If
  // navigation already owns a request, queue one trailing refresh rather than
  // cancelling the navigation or silently dropping the refresh.
  // Note: mutations intentionally refresh from the start (full re-drive)
  // instead of preserving pagination tokens, so hasMore/token stay correct
  // after the listing changes. Paginated follow-ups dedupe by key above.
  if (options.supersedePending === false && activeListingRequest !== null) {
    return queueTrailingListingRefresh(
      bucket,
      prefix,
      options.preserveSelection ?? false,
    );
  }
  return runObjectRefresh(bucket, prefix, options.preserveSelection ?? false);
}

export async function loadMoreObjects(): Promise<void> {
  // An SFTP directory arrives whole; there is no next page to load.
  if (state.protocol === "sftp") return;
  if (!state.hasMore || !state.continuationToken) return;
  const request = ++paginationRequest;
  const generation = listingGeneration;
  const connectionId = currentConnectionId();
  const bucket = state.currentBucket;
  const prefix = state.currentPrefix;
  const continuationToken = state.continuationToken;
  let response: ListObjectsResponse;
  try {
    response = await invokeS3For<ListObjectsResponse>(
      connectionId,
      "list_objects",
      {
        bucket,
        prefix,
        delimiter: "/",
        continuationToken,
      },
    );
  } catch (error) {
    if (
      request === paginationRequest &&
      generation === listingGeneration &&
      state.connectionId === connectionId &&
      state.currentBucket === bucket &&
      state.currentPrefix === prefix &&
      state.continuationToken === continuationToken
    ) {
      throw error;
    }
    return;
  }
  if (
    request !== paginationRequest ||
    generation !== listingGeneration ||
    state.connectionId !== connectionId ||
    state.currentBucket !== bucket ||
    state.currentPrefix !== prefix ||
    state.continuationToken !== continuationToken
  ) {
    return;
  }
  // Dedupe objects by key on append; paginated listings can repeat the
  // boundary key across pages. Prefixes were already deduped below.
  const existingKeys = new Set(state.objects.map((o) => o.key));
  for (const obj of response.objects) {
    if (!existingKeys.has(obj.key)) {
      existingKeys.add(obj.key);
      state.objects.push(obj);
    }
  }
  const existingPrefixes = new Set(state.prefixes);
  for (const p of response.prefixes) {
    if (!existingPrefixes.has(p)) {
      existingPrefixes.add(p);
      state.prefixes.push(p);
    }
  }
  for (const p of synthesizeMissingPrefixes(
    response.objects,
    [...existingPrefixes],
    prefix,
  )) {
    if (!existingPrefixes.has(p)) {
      existingPrefixes.add(p);
      state.prefixes.push(p);
    }
  }
  // Bound unbounded "Load more" accumulation: huge listings otherwise grow
  // the in-memory table (and every re-sort/re-filter over it) without limit.
  // When capped, pagination stops with a notice instead of silently dropping.
  if (
    state.objects.length + state.prefixes.length >
    MAX_ACCUMULATED_LISTING_ITEMS
  ) {
    state.continuationToken = "";
    state.hasMore = false;
    state.listingCapped = true;
    showToast(
      `Listing capped at ${MAX_ACCUMULATED_LISTING_ITEMS.toLocaleString()} items to keep browsing responsive. Narrow the prefix to see more.`,
      { type: "warning" },
    );
    return;
  }
  state.continuationToken = response.next_continuation_token;
  state.hasMore = response.truncated;
}
