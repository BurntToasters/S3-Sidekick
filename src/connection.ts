import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.ts";
import type { BucketInfo, ObjectInfo } from "./state.ts";

interface ConnectionConfig {
  endpoint: string;
  region: string;
  access_key: string;
  secret_key: string;
}

interface ListObjectsResponse {
  objects: ObjectInfo[];
  prefixes: string[];
  truncated: boolean;
  next_continuation_token: string;
}

export async function connect(
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string
): Promise<void> {
  state.connecting = true;
  try {
    await invoke("connect", {
      endpoint,
      region,
      accessKey,
      secretKey,
    });
    state.connected = true;
    state.endpoint = endpoint;
    state.region = region;
  } finally {
    state.connecting = false;
  }
}

export async function disconnect(): Promise<void> {
  await invoke("disconnect");
  state.connected = false;
  state.endpoint = "";
  state.region = "";
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
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string
): Promise<void> {
  const config: ConnectionConfig = {
    endpoint,
    region,
    access_key: accessKey,
    secret_key: secretKey,
  };
  await invoke("save_connection", { json: JSON.stringify(config) });
}

export async function loadConnection(): Promise<ConnectionConfig | null> {
  const raw = await invoke<string>("load_connection");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConnectionConfig;
  } catch {
    return null;
  }
}

export async function refreshBuckets(): Promise<void> {
  state.buckets = await invoke<BucketInfo[]>("list_buckets");
}

export async function refreshObjects(
  bucket: string,
  prefix: string
): Promise<void> {
  state.currentBucket = bucket;
  state.currentPrefix = prefix;
  const response = await invoke<ListObjectsResponse>("list_objects", {
    bucket,
    prefix,
    delimiter: "/",
    continuationToken: "",
  });
  state.objects = response.objects;
  state.prefixes = response.prefixes;
  state.continuationToken = response.next_continuation_token;
  state.hasMore = response.truncated;
  state.selectedKeys.clear();
}

export async function loadMoreObjects(): Promise<void> {
  if (!state.hasMore || !state.continuationToken) return;
  const response = await invoke<ListObjectsResponse>("list_objects", {
    bucket: state.currentBucket,
    prefix: state.currentPrefix,
    delimiter: "/",
    continuationToken: state.continuationToken,
  });
  state.objects = state.objects.concat(response.objects);
  state.prefixes = state.prefixes.concat(response.prefixes);
  state.continuationToken = response.next_continuation_token;
  state.hasMore = response.truncated;
}
