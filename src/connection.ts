import { invoke } from "@tauri-apps/api/core";
import { clearAllSelection } from "./app-selection.ts";
import { state } from "./state.ts";
import { showToast } from "./toast.ts";
import type { BucketInfo, ObjectInfo } from "./state.ts";
import {
  FULL_CREATE_ONLY_CAPABILITIES,
  NO_CREATE_ONLY_CAPABILITIES,
  type CreateOnlyCapabilities,
} from "./create-only-capabilities.ts";

interface ConnectionConfig {
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
  session_token?: string;
}

interface ConnectResult {
  region: string;
  connection_id: string;
  connection_identity: string;
  create_only_capabilities?: unknown;
}

interface ListObjectsResponse {
  objects: ObjectInfo[];
  prefixes: string[];
  truncated: boolean;
  next_continuation_token: string;
}

let connectionGeneration = 0;
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

export function currentConnectionId(): string {
  if (!state.connectionId) {
    throw new Error("Not connected");
  }
  return state.connectionId;
}

export function currentConnectionGeneration(): number {
  return connectionGeneration;
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
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!connectionId) {
    throw new Error("Connection id is required");
  }
  return invoke<T>(cmd, { ...args, connectionId });
}

export function invokeS3<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return invokeS3For(currentConnectionId(), cmd, args);
}

export async function connect(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken = "",
): Promise<string> {
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
    if (generation !== connectionGeneration) {
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
    state.endpoint = endpoint;
    state.region = result.region;
    state.connectionId = result.connection_id;
    state.connectionIdentity = result.connection_identity;
    state.createOnlyCapabilities = parseCreateOnlyCapabilities(
      result.create_only_capabilities,
    );
    return result.region;
  } catch (err) {
    if (generation === connectionGeneration) {
      state.connecting = false;
    }
    throw err;
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
  try {
    await invoke("disconnect", { connectionId: expectedId ?? "" });
  } catch (error) {
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

export async function loadConnection(): Promise<ConnectionConfig | null> {
  const raw = await invoke<string>("load_connection");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).endpoint === "string" &&
      typeof (parsed as Record<string, unknown>).region === "string" &&
      typeof (parsed as Record<string, unknown>).access_key === "string" &&
      typeof (parsed as Record<string, unknown>).secret_key === "string" &&
      ((parsed as Record<string, unknown>).session_token === undefined ||
        typeof (parsed as Record<string, unknown>).session_token === "string")
    ) {
      return parsed as ConnectionConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function refreshBuckets(): Promise<void> {
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

  trailing.settle(runObjectRefresh(trailing.bucket, trailing.prefix));
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
    paginationRequest += 1;
    let response: ListObjectsResponse;
    try {
      response = await invokeS3For<ListObjectsResponse>(
        connectionId,
        "list_objects",
        {
          bucket,
          prefix,
          delimiter: "/",
          continuationToken: "",
        },
      );
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
    state.objects = response.objects;
    // Frontend synthesis (preferred): surface empty folders whose only
    // evidence is a trailing-`/` marker object without a prefixes entry.
    state.prefixes = [
      ...response.prefixes,
      ...synthesizeMissingPrefixes(response.objects, response.prefixes, prefix),
    ];
    state.continuationToken = response.next_continuation_token;
    state.hasMore = response.truncated;
    state.listingCapped = false;
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
    return queueTrailingListingRefresh(bucket, prefix);
  }
  return runObjectRefresh(bucket, prefix, options.preserveSelection ?? false);
}

export async function loadMoreObjects(): Promise<void> {
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
