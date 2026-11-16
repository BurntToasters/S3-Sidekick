import {
  NO_CREATE_ONLY_CAPABILITIES,
  type CreateOnlyCapabilities,
} from "./create-only-capabilities.ts";
import type { ObjectInfo } from "./state.ts";

/**
 * Pure SFTP model: wire types, guards for native results, endpoint and path
 * rules, and the mapping onto the bucket/key listing model. It performs no
 * IPC; sftp-commands.ts and connection.ts do.
 */

export type SftpAuthMethod = "password" | "key" | "keyboard-interactive";

/** Auth settings persisted with a saved SFTP connection or bookmark. */
export interface SftpSettings {
  auth: SftpAuthMethod;
  private_key?: string;
  host_key?: string;
}

export const MAX_SFTP_PRIVATE_KEY_LENGTH = 16_384;
export const MAX_SFTP_HOST_KEY_LENGTH = 8_192;

/** Longest remote path accepted, in UTF-8 bytes. Matches the Rust limit. */
const MAX_SFTP_PATH_BYTES = 4_096;
const ENDPOINT_SCHEME = "sftp://";
const SFTP_AUTH_METHODS: readonly SftpAuthMethod[] = [
  "password",
  "key",
  "keyboard-interactive",
];

export interface SftpPrompt {
  text: string;
  echo: boolean;
}

export interface SftpConnectedStep {
  step: "connected";
  connection_id: string;
  connection_identity: string;
  endpoint: string;
  home_path: string;
  host_key: string;
  host_key_fingerprint: string;
  create_only_supported: boolean;
}

export interface SftpHostKeyUnknownStep {
  step: "host_key_unknown";
  attempt_id: string;
  key_type: string;
  fingerprint_sha256: string;
  host_key: string;
}

export interface SftpPromptStep {
  step: "prompt";
  attempt_id: string;
  name: string;
  instructions: string;
  prompts: SftpPrompt[];
}

export type SftpConnectStep =
  SftpConnectedStep | SftpHostKeyUnknownStep | SftpPromptStep;

export type SftpEntryKind = "file" | "dir" | "symlink" | "other";

export interface SftpEntry {
  name: string;
  path: string;
  kind: SftpEntryKind;
  size: number | null;
  /** Unix seconds. */
  mtime: number | null;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
  owner: string | null;
  group: string | null;
  name_lossy: boolean;
}

export interface SftpListResponse {
  path: string;
  entries: SftpEntry[];
  truncated: boolean;
}

export interface SftpDeleteFailure {
  path: string;
  error: string;
}

export interface SftpDeleteResult {
  deleted: string[];
  failed: SftpDeleteFailure[];
}

export interface SshPrivateKeyInfo {
  key_text: string;
  algorithm: string;
  encrypted: boolean;
  file_name: string;
}

/** Same fields as the S3 `PreviewResponse` in preview.ts. */
export interface SftpPreviewResponse {
  content_type: string;
  data: string;
  is_text: boolean;
  truncated: boolean;
  total_size: number;
}

/** Prefix of the message for a connection the server dropped mid-session. */
export const SFTP_CONNECTION_LOST = "SFTP connection lost";
/**
 * Prefix of the native refusal for a target that already exists. Matches
 * `already_exists` in `src-tauri/src/sftp/fs.rs`; only an error that starts with
 * it is a conflict, so a path that merely contains the words is not.
 */
export const SFTP_ALREADY_EXISTS = "Remote path already exists: ";

type Row = Record<string, unknown>;

const MALFORMED = "SFTP returned a malformed response.";

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isSafeCount(value);
}

function isNullableU32(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 0xffffffff)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** An absolute, normalized remote path, as the Rust path rules accept. */
export function isSftpRemotePath(path: string): boolean {
  if (path === "" || path.includes("\0")) return false;
  if (utf8Length(path) > MAX_SFTP_PATH_BYTES) return false;
  if (!path.startsWith("/")) return false;
  const rest = path.slice(1);
  if (rest === "") return true;
  if (rest.endsWith("/")) return false;
  return rest
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isChildName(name: unknown): name is string {
  return (
    isNonEmptyString(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

function isEntryKind(value: unknown): value is SftpEntryKind {
  const kinds: readonly SftpEntryKind[] = ["file", "dir", "symlink", "other"];
  return kinds.some((kind) => kind === value);
}

/** Map a remote key onto the object model: `a/b/` becomes `/a/b`. */
export function sftpPathFromKey(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const path = trimmed === "" ? "/" : `/${trimmed}`;
  if (!isSftpRemotePath(path)) {
    throw new Error("SFTP key does not name a valid remote path");
  }
  return path;
}

/** Inverse of sftpPathFromKey: folders keep a trailing slash, the root is "". */
export function sftpKeyFromPath(path: string, isDir: boolean): string {
  if (!isSftpRemotePath(path)) {
    throw new Error("SFTP path is not a valid absolute remote path");
  }
  if (path === "/") {
    if (!isDir) throw new Error("The SFTP root is a folder");
    return "";
  }
  return isDir ? `${path.slice(1)}/` : path.slice(1);
}

/** Strict dotted IPv4: four decimal octets without leading zeros. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
  return octets;
}

function parseIpv6Groups(part: string, allowIpv4: boolean): number[] | null {
  if (part === "") return [];
  const pieces = part.split(":");
  const groups: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.includes(".")) {
      if (!allowIpv4 || index !== pieces.length - 1) return null;
      const octets = parseIpv4(piece);
      if (octets === null) return null;
      groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
    } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

/** Parse an IPv6 literal into eight 16-bit groups, or null when invalid. */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const compress = text.indexOf("::");
  if (compress !== text.lastIndexOf("::")) return null;
  if (compress < 0) {
    const groups = parseIpv6Groups(text, true);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const head = parseIpv6Groups(text.slice(0, compress), false);
  const tail = parseIpv6Groups(text.slice(compress + 2), true);
  if (head === null || tail === null) return null;
  const explicit = head.length + tail.length;
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...tail];
}

/** RFC 5952 text, with the IPv4-mapped form the native formatter uses. */
function formatIpv6(groups: number[]): string {
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6];
    const low = groups[7];
    return `::ffff:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = (values: number[]): string =>
    values.map((value) => value.toString(16)).join(":");
  if (bestLength < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(
    groups.slice(bestStart + bestLength),
  )}`;
}

function canonicalIpv6(text: string): string | null {
  const groups = parseIpv6(text);
  return groups === null ? null : formatIpv6(groups);
}

function validateHostname(host: string): string {
  if (utf8Length(host) > 253) {
    throw new Error("SFTP host exceeds the 253 byte limit");
  }
  for (const label of host.split(".")) {
    if (label === "")
      throw new Error("SFTP host must not contain empty labels");
    if (utf8Length(label) > 63) {
      throw new Error("SFTP host label exceeds the 63 byte limit");
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      throw new Error("SFTP host labels must not start or end with '-'");
    }
    if (!/^[A-Za-z0-9-]+$/.test(label)) {
      throw new Error(
        "SFTP host may contain only letters, digits, '-' and '.'",
      );
    }
  }
  return host.toLowerCase();
}

/** Canonical lowercase host without brackets, matching the native rules. */
function validateSftpHost(host: string): string {
  if (host === "") throw new Error("SFTP host is required");
  if (host.includes("://") || host.includes("/")) {
    throw new Error("SFTP host must not include a scheme or path");
  }
  if (host.includes("@")) {
    throw new Error("SFTP host must not include a username");
  }
  if (/[\s\p{Cc}]/u.test(host)) {
    throw new Error("SFTP host must not contain whitespace");
  }
  if (host.startsWith("[")) {
    const inner = host.slice(1);
    if (!inner.endsWith("]")) {
      throw new Error("SFTP host has an unclosed IPv6 bracket");
    }
    const canonical = canonicalIpv6(inner.slice(0, -1));
    if (canonical === null) {
      throw new Error("Only an IPv6 address may be bracketed");
    }
    return canonical;
  }
  if (host.includes("]")) throw new Error("SFTP host has an unmatched ']'");
  if (host.includes(":")) {
    const canonical = canonicalIpv6(host);
    if (canonical === null) {
      throw new Error(
        "SFTP host must not include a port; set the port separately",
      );
    }
    return canonical;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return ipv4.join(".");
  return validateHostname(host);
}

/** Decimal digits only, no sign, no leading zero, 1 to 65535. */
function parsePort(text: string): number {
  const canonical =
    /^[0-9]+$/.test(text) && (text === "0" || !text.startsWith("0"));
  if (!canonical) {
    throw new Error("SFTP port must be a decimal number without leading zeros");
  }
  const port = Number(text);
  if (port > 65535) throw new Error("SFTP port must be at most 65535");
  if (port === 0) throw new Error("SFTP port must be between 1 and 65535");
  return port;
}

/** Build the normalized `sftp://host:port` endpoint; IPv6 hosts are bracketed. */
export function formatSftpEndpoint(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SFTP port must be between 1 and 65535");
  }
  const canonical = validateSftpHost(host);
  return canonical.includes(":")
    ? `${ENDPOINT_SCHEME}[${canonical}]:${port}`
    : `${ENDPOINT_SCHEME}${canonical}:${port}`;
}

/** Inverse of formatSftpEndpoint. Requires the explicit port and nothing after it. */
export function parseSftpEndpoint(endpoint: string): {
  host: string;
  port: number;
} {
  if (!endpoint.startsWith(ENDPOINT_SCHEME)) {
    throw new Error("SFTP endpoint must start with sftp://");
  }
  const rest = endpoint.slice(ENDPOINT_SCHEME.length);
  if (rest.startsWith("[")) {
    const after = rest.slice(1);
    const close = after.indexOf("]");
    if (close < 0)
      throw new Error("SFTP endpoint has an unclosed IPv6 bracket");
    const literal = after.slice(0, close);
    if (parseIpv6(literal) === null) {
      throw new Error("Only an IPv6 address may be bracketed");
    }
    const remainder = after.slice(close + 1);
    if (!remainder.startsWith(":")) {
      throw new Error("SFTP endpoint must include an explicit port");
    }
    const port = parsePort(remainder.slice(1));
    return { host: validateSftpHost(literal), port };
  }
  const colon = rest.lastIndexOf(":");
  if (colon < 0) throw new Error("SFTP endpoint must include an explicit port");
  const host = rest.slice(0, colon);
  if (host.includes(":")) {
    throw new Error("An IPv6 SFTP host must be bracketed");
  }
  const port = parsePort(rest.slice(colon + 1));
  return { host: validateSftpHost(host), port };
}

export function isValidSftpEndpoint(endpoint: string): boolean {
  try {
    parseSftpEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive scheme check, for labels and for refusing S3 bookmarks. */
export function looksLikeSftpEndpoint(endpoint: string): boolean {
  return /^sftp:\/\//i.test(endpoint);
}

/** The single virtual bucket name for an SFTP session: the server host. */
export function sftpVirtualBucket(endpoint: string): string {
  return parseSftpEndpoint(endpoint).host;
}

export function isSftpAuthMethod(value: unknown): value is SftpAuthMethod {
  return SFTP_AUTH_METHODS.some((method) => method === value);
}

/** Auth settings with bounded key material, as bookmarks and saved connections store them. */
export function isSftpSettings(value: unknown): value is SftpSettings {
  if (!isRow(value)) return false;
  const { auth, private_key, host_key } = value;
  return (
    isSftpAuthMethod(auth) &&
    (private_key === undefined ||
      (typeof private_key === "string" &&
        private_key.length <= MAX_SFTP_PRIVATE_KEY_LENGTH)) &&
    (host_key === undefined ||
      (typeof host_key === "string" &&
        host_key.length <= MAX_SFTP_HOST_KEY_LENGTH))
  );
}

export function parseSftpEntry(value: unknown): SftpEntry {
  if (!isRow(value)) throw new Error(MALFORMED);
  const { name, path, kind, size, mtime, permissions, uid, gid, owner, group } =
    value;
  const { name_lossy } = value;
  if (
    !isChildName(name) ||
    typeof path !== "string" ||
    !isSftpRemotePath(path) ||
    lastSegment(path) !== name ||
    !isEntryKind(kind) ||
    !isNullableCount(size) ||
    !isNullableCount(mtime) ||
    !isNullableU32(permissions) ||
    !isNullableU32(uid) ||
    !isNullableU32(gid) ||
    !isNullableString(owner) ||
    !isNullableString(group) ||
    typeof name_lossy !== "boolean"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    name,
    path,
    kind,
    size,
    mtime,
    permissions,
    uid,
    gid,
    owner,
    group,
    name_lossy,
  };
}

export function parseSftpListResponse(value: unknown): SftpListResponse {
  if (!isRow(value)) throw new Error(MALFORMED);
  const { path, entries, truncated } = value;
  if (
    typeof path !== "string" ||
    !isSftpRemotePath(path) ||
    !Array.isArray(entries) ||
    typeof truncated !== "boolean"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    path,
    entries: entries.map((entry: unknown) => parseSftpEntry(entry)),
    truncated,
  };
}

function parseRemotePathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(MALFORMED);
  return value.map((path: unknown) => {
    if (typeof path !== "string" || !isSftpRemotePath(path)) {
      throw new Error(MALFORMED);
    }
    return path;
  });
}

export function parseSftpDeleteResult(value: unknown): SftpDeleteResult {
  if (!isRow(value)) throw new Error(MALFORMED);
  const { deleted, failed } = value;
  if (!Array.isArray(failed)) throw new Error(MALFORMED);
  return {
    deleted: parseRemotePathList(deleted),
    failed: failed.map((failure: unknown) => {
      if (!isRow(failure)) throw new Error(MALFORMED);
      const { path, error } = failure;
      if (
        typeof path !== "string" ||
        !isSftpRemotePath(path) ||
        typeof error !== "string"
      ) {
        throw new Error(MALFORMED);
      }
      return { path, error };
    }),
  };
}

export function parseSftpExists(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(MALFORMED);
  return value;
}

/** Result of an SFTP upload. `warning` names a file the cleanup left on the server. */
export interface SftpUploadOutcome {
  bytesWritten: number;
  warning: string | null;
}

function parseCleanupWarning(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(MALFORMED);
  }
  return value;
}

export function parseSftpUploadOutcome(value: unknown): SftpUploadOutcome {
  if (!isRow(value)) throw new Error(MALFORMED);
  const { bytes_written, warning } = value;
  if (!isSafeCount(bytes_written)) throw new Error(MALFORMED);
  return {
    bytesWritten: bytes_written,
    warning: parseCleanupWarning(warning),
  };
}

/** Result of an SFTP rename: the cleanup warning, or null. */
export function parseSftpRenameOutcome(value: unknown): string | null {
  if (!isRow(value)) throw new Error(MALFORMED);
  return parseCleanupWarning(value.warning);
}

/** A command that returns nothing: the native side sends `null`. */
export function parseSftpVoid(value: unknown): void {
  if (value !== null && value !== undefined) throw new Error(MALFORMED);
}

export function parseSftpPreviewResponse(value: unknown): SftpPreviewResponse {
  if (!isRow(value)) throw new Error(MALFORMED);
  const { content_type, data, is_text, truncated, total_size } = value;
  if (
    typeof content_type !== "string" ||
    typeof data !== "string" ||
    typeof is_text !== "boolean" ||
    typeof truncated !== "boolean" ||
    !isSafeCount(total_size)
  ) {
    throw new Error(MALFORMED);
  }
  return { content_type, data, is_text, truncated, total_size };
}

/** A cancelled picker dialog is `null`. The error never repeats the key text. */
export function parseSshPrivateKeyInfo(
  value: unknown,
): SshPrivateKeyInfo | null {
  if (value === null) return null;
  if (!isRow(value)) throw new Error(MALFORMED);
  const { key_text, algorithm, encrypted, file_name } = value;
  if (
    typeof key_text !== "string" ||
    typeof algorithm !== "string" ||
    typeof encrypted !== "boolean" ||
    typeof file_name !== "string"
  ) {
    throw new Error(MALFORMED);
  }
  return { key_text, algorithm, encrypted, file_name };
}

function parsePromptList(value: unknown): SftpPrompt[] {
  if (!Array.isArray(value)) throw new Error(MALFORMED);
  return value.map((item: unknown) => {
    if (!isRow(item)) throw new Error(MALFORMED);
    const { text, echo } = item;
    if (typeof text !== "string" || typeof echo !== "boolean") {
      throw new Error(MALFORMED);
    }
    return { text, echo };
  });
}

function parseConnectedStep(row: Row): SftpConnectedStep {
  const {
    connection_id,
    connection_identity,
    endpoint,
    home_path,
    host_key,
    host_key_fingerprint,
    create_only_supported,
  } = row;
  if (
    !isNonEmptyString(connection_id) ||
    !isNonEmptyString(connection_identity) ||
    typeof endpoint !== "string" ||
    !isValidSftpEndpoint(endpoint) ||
    typeof home_path !== "string" ||
    !isSftpRemotePath(home_path) ||
    !isNonEmptyString(host_key) ||
    !isNonEmptyString(host_key_fingerprint) ||
    typeof create_only_supported !== "boolean"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    step: "connected",
    connection_id,
    connection_identity,
    endpoint,
    home_path,
    host_key,
    host_key_fingerprint,
    create_only_supported,
  };
}

function parseHostKeyUnknownStep(row: Row): SftpHostKeyUnknownStep {
  const { attempt_id, key_type, fingerprint_sha256, host_key } = row;
  if (
    !isNonEmptyString(attempt_id) ||
    typeof key_type !== "string" ||
    typeof fingerprint_sha256 !== "string" ||
    typeof host_key !== "string"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    step: "host_key_unknown",
    attempt_id,
    key_type,
    fingerprint_sha256,
    host_key,
  };
}

function parsePromptStep(row: Row): SftpPromptStep {
  const { attempt_id, name, instructions, prompts } = row;
  if (
    !isNonEmptyString(attempt_id) ||
    typeof name !== "string" ||
    typeof instructions !== "string"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    step: "prompt",
    attempt_id,
    name,
    instructions,
    prompts: parsePromptList(prompts),
  };
}

/** One step of the connect flow. Any other tag, or a malformed field, is refused. */
export function parseSftpConnectStep(value: unknown): SftpConnectStep {
  if (!isRow(value)) throw new Error(MALFORMED);
  switch (value.step) {
    case "connected":
      return parseConnectedStep(value);
    case "host_key_unknown":
      return parseHostKeyUnknownStep(value);
    case "prompt":
      return parsePromptStep(value);
    default:
      throw new Error(MALFORMED);
  }
}

/** Create-only writes are not an SFTP guarantee; copy stays off. */
export function sftpCreateOnlyCapabilities(
  createOnlySupported: boolean,
): CreateOnlyCapabilities {
  if (!createOnlySupported) return { ...NO_CREATE_ONLY_CAPABILITIES };
  return { put_object: true, complete_multipart: true, copy_object: false };
}

/** Milliseconds-to-ISO for an mtime in seconds, or "" when it is out of range. */
function mtimeToIso(mtime: number | null): string {
  if (mtime === null) return "";
  const date = new Date(mtime * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * Map one directory listing onto the bucket/key model. Folders become
 * prefixes (they carry no metadata); every other entry (files, symlinks,
 * other) becomes an object that keeps its kind and name flag, so the table
 * can mark links and read-only names without a second request.
 */
export function sftpListingToObjects(
  response: SftpListResponse,
  prefix: string,
): { objects: ObjectInfo[]; prefixes: string[] } {
  const objects: ObjectInfo[] = [];
  const prefixes: string[] = [];
  for (const entry of response.entries) {
    if (entry.kind === "dir") {
      prefixes.push(`${prefix}${entry.name}/`);
      continue;
    }
    objects.push({
      key: `${prefix}${entry.name}`,
      size: entry.size ?? 0,
      last_modified: mtimeToIso(entry.mtime),
      is_folder: false,
      sftp_kind:
        entry.kind === "symlink"
          ? "symlink"
          : entry.kind === "other"
            ? "other"
            : "file",
      name_lossy: entry.name_lossy,
    });
  }
  return { objects, prefixes };
}

/** True when the native side refused because the target already exists. */
export function isSftpAlreadyExists(message: string): boolean {
  return message.startsWith(SFTP_ALREADY_EXISTS);
}

/** True when the error is the lost-connection error from the native side. */
export function isSftpConnectionLost(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return message.startsWith(SFTP_CONNECTION_LOST);
}

const ENCRYPTED_KEY_MESSAGE = /private key is encrypted/i;
const AUTH_FAILED_MESSAGE = "Authentication failed.";
const CHANGED_HOST_KEY_MESSAGE = /^The SSH host key for .+ changed\./;

/**
 * Control to focus after a failed SFTP connect. The error decides the field,
 * and a changed host key uses Reset only when the caller says it is shown.
 */
export function sftpFailureFocusTarget(
  errorText: string,
  auth: SftpAuthMethod,
  resetHostKeyVisible = false,
): string {
  if (ENCRYPTED_KEY_MESSAGE.test(errorText)) return "conn-sftp-passphrase";
  if (errorText.startsWith(AUTH_FAILED_MESSAGE)) {
    if (auth === "password") return "conn-sftp-password";
    if (auth === "key") return "conn-sftp-key-choose";
    return "conn-sftp-auth";
  }
  if (CHANGED_HOST_KEY_MESSAGE.test(errorText) && resetHostKeyVisible) {
    return "conn-sftp-reset-hostkey";
  }
  return "conn-sftp-host";
}

/** Notice shown when the remembered folder is gone and home opened instead. */
export function sftpHomeFallbackMessage(rememberedPrefix: string): string {
  let label = "The remembered folder";
  try {
    label = sftpPathFromKey(rememberedPrefix);
  } catch {
    // Keep the generic label for a key that does not map to a valid path.
  }
  return `${label} is no longer available. Opened your home folder.`;
}
