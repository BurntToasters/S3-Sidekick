import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";
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
let paginationRequest = 0;

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
): Promise<string> {
  const generation = ++connectionGeneration;
  listingGeneration++;
  paginationRequest++;
  state.connecting = true;
  try {
    const result = await invoke<ConnectResult>("connect", {
      endpoint,
      region,
      accessKey,
      secretKey,
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

export async function disconnect(connectionId?: string): Promise<void> {
  const expectedId = connectionId ?? state.connectionId;
  const generation = ++connectionGeneration;
  listingGeneration++;
  paginationRequest++;
  state.connecting = false;
  await invoke("disconnect", { connectionId: expectedId ?? "" });
  if (generation !== connectionGeneration) return;
  if (expectedId && state.connectionId && state.connectionId !== expectedId) {
    return;
  }
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
  state.selectedKeys.clear();
  state.continuationToken = "";
  state.hasMore = false;
}

export async function saveConnection(
  connectionId: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): Promise<void> {
  if (!connectionId) {
    throw new Error("Connection id is required");
  }
  const config: ConnectionConfig = {
    endpoint,
    region,
    access_key: accessKey,
    secret_key: secretKey,
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
      typeof (parsed as Record<string, unknown>).secret_key === "string"
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
  const buckets = await invokeS3<BucketInfo[]>("list_buckets");
  if (generation === connectionGeneration) {
    state.buckets = buckets;
  }
}

export async function refreshObjects(
  bucket: string,
  prefix: string,
): Promise<void> {
  const request = ++listingGeneration;
  paginationRequest++;
  state.currentBucket = bucket;
  state.currentPrefix = prefix;
  state.objects = [];
  state.prefixes = [];
  state.selectedKeys.clear();
  state.continuationToken = "";
  state.hasMore = false;
  let response: ListObjectsResponse;
  try {
    response = await invokeS3<ListObjectsResponse>("list_objects", {
      bucket,
      prefix,
      delimiter: "/",
      continuationToken: "",
    });
  } catch (error) {
    if (request === listingGeneration) throw error;
    return;
  }
  if (
    request !== listingGeneration ||
    state.currentBucket !== bucket ||
    state.currentPrefix !== prefix
  ) {
    return;
  }
  state.objects = response.objects;
  state.prefixes = response.prefixes;
  state.continuationToken = response.next_continuation_token;
  state.hasMore = response.truncated;
  state.selectedKeys.clear();
}

export async function loadMoreObjects(): Promise<void> {
  if (!state.hasMore || !state.continuationToken) return;
  const request = ++paginationRequest;
  const generation = listingGeneration;
  const bucket = state.currentBucket;
  const prefix = state.currentPrefix;
  const continuationToken = state.continuationToken;
  let response: ListObjectsResponse;
  try {
    response = await invokeS3<ListObjectsResponse>("list_objects", {
      bucket,
      prefix,
      delimiter: "/",
      continuationToken,
    });
  } catch (error) {
    if (request === paginationRequest && generation === listingGeneration) {
      throw error;
    }
    return;
  }
  if (
    request !== paginationRequest ||
    generation !== listingGeneration ||
    state.currentBucket !== bucket ||
    state.currentPrefix !== prefix ||
    state.continuationToken !== continuationToken
  ) {
    return;
  }
  state.objects = state.objects.concat(response.objects);
  const existingPrefixes = new Set(state.prefixes);
  for (const p of response.prefixes) {
    if (!existingPrefixes.has(p)) {
      state.prefixes.push(p);
    }
  }
  state.continuationToken = response.next_continuation_token;
  state.hasMore = response.truncated;
}
