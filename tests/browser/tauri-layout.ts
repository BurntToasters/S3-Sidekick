import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { IpcCommand } from "../../src/generated/ipc-contract.ts";

/**
 * Commands the mock answers. Typed against the generated Rust contract, so
 * a renamed or removed native command fails the type check here too.
 */
type MockedCommand = IpcCommand | `plugin:${string}`;

export type LayoutScenario = "normal" | "empty" | "loading" | "error";

export interface CreateOnlyCapabilities {
  put_object: boolean;
  complete_multipart: boolean;
  copy_object: boolean;
}

export interface MockListOverride {
  objects?: Array<Record<string, unknown>>;
  prefixes?: string[];
}

export interface MockSecurityStatus {
  initialized: boolean;
  encryption_enabled: boolean;
  unlocked: boolean;
  lock_timeout_minutes: number;
  biometric_available: boolean;
  biometric_enrolled: boolean;
}

export interface LayoutMockOptions {
  objectCount?: number;
  longFileCount?: number;
  scenario?: LayoutScenario;
  /** Provider create-only support reported by `connect`. Default: all true. */
  createOnlyCapabilities?: CreateOnlyCapabilities;
  /** Extra persisted settings merged into the `load_settings` response. */
  settings?: Record<string, unknown>;
  /** Prefixes rendered in the root listing. */
  prefixes?: string[];
  /** Responses for delimiter-less destination existence/listing probes. */
  listObjectsByPrefix?: Record<string, MockListOverride>;
  /** Persisted bookmark rows returned by the mock backend. */
  bookmarks?: unknown[];
  /** Optional independent backup rows. Defaults to `bookmarks`. */
  bookmarkBackup?: unknown[];
  /** Buckets returned by `list_buckets`. Defaults to one layout-test bucket. */
  buckets?: Array<{ name: string; creation_date?: string }>;
  /** Security state returned by the mock backend. */
  security?: Partial<MockSecurityStatus>;
  /** Passwords accepted by `unlock_security`; an empty list accepts any. */
  unlockPasswords?: string[];
  /** Hold a successful unlock until `releaseMockUnlock` is called. */
  deferUnlock?: boolean;
  /** Endpoint entered by `openMockListing`. */
  endpoint?: string;
  /** Native command failures, keyed by command name. */
  errors?: Record<string, string>;
  /** Exact transfer manifest returned during recovery hydration. */
  transferManifestJson?: string;
  /** Copy receipt proof shape for move-safety regressions; "missing" mimics a legacy receipt. */
  copyReceiptOwnershipAmbiguous?: boolean | "missing";
  /** Fail this many disconnect attempts before allowing retirement to finish. */
  disconnectFailures?: number;
  /** Hold disconnect until `releaseMockDisconnect` is called. */
  holdDisconnect?: boolean;
  /**
   * Emulate the native transfer registry for `copy_object_to`: running
   * commands can be cancelled, and a cancel that arrives while nothing is
   * registered stays pending for 30s and cancels the next command with
   * that transfer ID (the Rust `pending_cancels` contract).
   */
  transferBackend?: {
    /** Fail this many `copy_object_to` calls with a retryable 503 first. */
    copyFailures?: number;
    /** Hold each `copy_object_to` until `releaseMockCopies` is called. */
    holdCopies?: boolean;
  };
  /**
   * Emulate the native auto-lock: the vault reports locked once this many
   * ms pass without `touch_security_activity` or an unlock.
   */
  autoLockAfterMs?: number;
  /** Platform reported by `get_platform_info`. Default: "linux". */
  platform?: "linux" | "macos" | "windows";
  /** Hold a biometric unlock until `releaseMockBiometric` is called. */
  holdBiometric?: boolean;
  /** The last saved connection `load_connection` returns. Absent means nothing saved. */
  savedConnection?: Record<string, unknown>;
  /**
   * Emulate an SFTP server behind the `sftp_*` commands and
   * `pick_ssh_private_key`. Without this option those commands fall through to
   * the layout mock's defaults.
   */
  sftp?: MockSftpOptions;
}

export interface MockCall {
  command: string;
  args: unknown;
}

/**
 * How the mock SFTP server answers the host key check.
 * - "unknown": the server key is not pinned; the client must ask the user.
 * - "pinned-ok": the server key matches the pin the client sends.
 * - "changed": the server presents a key that differs from the pinned one.
 */
export type MockSftpHostKey = "unknown" | "pinned-ok" | "changed";

/**
 * How the mock SFTP server answers authentication.
 * - "success": the password, key, and empty keyboard-interactive round succeed.
 * - "wrong-password": password auth is refused; key and keyboard-interactive succeed.
 * - "keyboard-interactive": password and key are refused; keyboard-interactive prompts.
 */
export type MockSftpAuth =
  "success" | "wrong-password" | "keyboard-interactive";

/** One seeded remote path. Parents are created as folders when missing. */
/** Entry kinds the mock lists. Symlinks are shown but not followed. */
export type MockSftpKind = "file" | "dir" | "symlink" | "other";

export interface MockSftpEntry {
  /** Absolute remote path, for example `/home/demo/notes.txt`. */
  path: string;
  kind?: MockSftpKind;
  /** Bytes; files only. Text files default to their UTF-8 length. */
  size?: number;
  /** Unix seconds. */
  mtime?: number;
  /** Unix permission bits, for example 0o644 = 420. */
  permissions?: number;
  owner?: string;
  group?: string;
  /** Text content, previewed as text. */
  text?: string;
  /** Base64 content. An `image/*` content type is previewed as an image. */
  base64?: string;
  contentType?: string;
}

export interface MockSftpKey {
  file_name: string;
  algorithm: string;
  encrypted: boolean;
  key_text: string;
}

export interface MockSftpOptions {
  /** Host key behaviour. Default: "unknown". */
  hostKey?: MockSftpHostKey;
  /** Authentication behaviour. Default: "success". */
  auth?: MockSftpAuth;
  /** Password the server accepts. Default: "sftp-password". */
  password?: string;
  /** Passphrase that decrypts an encrypted key. Default: "key-passphrase". */
  keyPassphrase?: string;
  /** Keyboard-interactive challenge, answered by `answers` in order. */
  keyboardInteractive?: {
    name?: string;
    instructions?: string;
    prompts: Array<{ text: string; echo: boolean }>;
    answers: string[];
  };
  /** Key returned by `pick_ssh_private_key`. Null (default) means the dialog was cancelled. */
  privateKey?: MockSftpKey | null;
  /** Home directory. Default: "/home/demo". */
  homePath?: string;
  /** Seeded remote tree. Default: a small home directory with a text file and an image. */
  files?: MockSftpEntry[];
  /**
   * create_only_supported reported by `sftp_connect`. Default false, as the
   * mock has always answered. A real server with hardlinks reports true.
   */
  createOnlySupported?: boolean;
  /**
   * Hold `sftp_connect` before it reports a step, as a server that accepts TCP
   * and never answers does. Only `sftp_connect_cancel_pending` ends it, with
   * "SFTP connect cancelled", as the native side does.
   */
  holdConnect?: boolean;
  /**
   * Local side of the transfer tests: the native pickers answer with these
   * grants, and the in-flight transfer commands can be held and cancelled.
   * Absent means the pickers keep their layout-mock answers.
   */
  transfers?: MockSftpTransfers;
}

export interface MockSftpTransfers {
  /** Files `pick_upload_files` returns. */
  uploadFiles?: Array<{ name: string; size: number }>;
  /** Folder `pick_upload_folder` returns, and the files `list_local_files_recursive` lists under it. */
  uploadFolder?: {
    name: string;
    files: Array<{ relativePath: string; size: number }>;
  };
  /**
   * Hold each `sftp_upload`, `sftp_upload_bytes` and `sftp_download` until
   * `releaseMockSftpTransfers` runs. A `cancel_transfer` for a held command
   * rejects it with "Transfer cancelled", as the native registry does.
   */
  holdTransfers?: boolean;
}

/** Server key and fingerprint the mock presents, shared with the specs. */
export const MOCK_SFTP_SERVER_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaywrightSftpServerKey";
export const MOCK_SFTP_SERVER_FINGERPRINT =
  "SHA256:PlaywrightSftpServerFingerprint00000000000000";
/** A different key, presented when hostKey is "changed". */
export const MOCK_SFTP_CHANGED_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaywrightSftpChangedKey";
export const MOCK_SFTP_CHANGED_FINGERPRINT =
  "SHA256:PlaywrightSftpChangedFingerprint000000000000";

const MOCK_SFTP_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function defaultSftpFiles(homePath: string): MockSftpEntry[] {
  return [
    { path: "/etc", kind: "dir", owner: "root", group: "root" },
    { path: homePath, kind: "dir", owner: "demo", group: "demo" },
    {
      path: `${homePath}/notes.txt`,
      size: 42,
      mtime: 1_700_000_000,
      permissions: 0o644,
      owner: "demo",
      group: "demo",
      text: "Meeting notes\nFirst line of the seeded notes file.",
    },
    {
      path: `${homePath}/photos`,
      kind: "dir",
      mtime: 1_700_000_100,
      owner: "demo",
      group: "demo",
    },
    {
      path: `${homePath}/photos/logo.png`,
      mtime: 1_700_000_200,
      permissions: 0o644,
      owner: "demo",
      group: "demo",
      base64: MOCK_SFTP_PNG_BASE64,
      contentType: "image/png",
    },
  ];
}

interface SftpBridgeInit {
  hostKey: MockSftpHostKey;
  auth: MockSftpAuth;
  password: string;
  keyPassphrase: string;
  keyboardInteractive: {
    name: string;
    instructions: string;
    prompts: Array<{ text: string; echo: boolean }>;
    answers: string[];
  };
  privateKey: MockSftpKey | null;
  homePath: string;
  files: MockSftpEntry[];
  serverKey: string;
  serverFingerprint: string;
  changedKey: string;
  changedFingerprint: string;
  createOnlySupported: boolean;
  holdConnect: boolean;
  transfers: MockSftpTransfers | null;
}

interface LayoutMockInit {
  objectCount: number;
  longFileCount: number;
  scenario: LayoutScenario;
  createOnlyCapabilities: CreateOnlyCapabilities;
  settings: Record<string, unknown>;
  prefixes: string[];
  listObjectsByPrefix: Record<string, MockListOverride>;
  bookmarks: unknown[];
  bookmarkBackup: unknown[];
  buckets: Array<{ name: string; creation_date?: string }>;
  security: MockSecurityStatus;
  unlockPasswords: string[];
  deferUnlock: boolean;
  errors: Record<string, string>;
  transferManifestJson: string;
  copyReceiptOwnershipAmbiguous: boolean | "missing";
  disconnectFailures: number;
  holdDisconnect: boolean;
  copyFailures: number;
  holdCopies: boolean;
  autoLockAfterMs: number;
  platform: string;
  holdBiometric: boolean;
  savedConnectionJson: string;
  appVersion: string;
}

/** Version reported by `plugin:app|version`, read from package.json. */
const APP_VERSION = (
  JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
).version;

/**
 * Install a browser-side Tauri IPC/event bridge before the production entry
 * module runs. The page still loads src/index.html, src/main.ts, and the
 * production renderers/styles; this bridge only supplies deterministic native
 * responses for layout tests.
 */
export async function installLayoutTauriMock(
  page: Page,
  options: LayoutMockOptions = {},
): Promise<void> {
  const init: LayoutMockInit = {
    objectCount: options.objectCount ?? 12,
    longFileCount: Math.max(
      0,
      Math.min(options.longFileCount ?? 1, options.objectCount ?? 12),
    ),
    scenario: options.scenario ?? "normal",
    createOnlyCapabilities: options.createOnlyCapabilities ?? {
      put_object: true,
      complete_multipart: true,
      copy_object: true,
    },
    settings: options.settings ?? {},
    prefixes:
      options.prefixes ?? ((options.objectCount ?? 12) > 0 ? ["archive/"] : []),
    listObjectsByPrefix: options.listObjectsByPrefix ?? {},
    bookmarks: options.bookmarks ?? [],
    bookmarkBackup: options.bookmarkBackup ?? options.bookmarks ?? [],
    buckets: options.buckets ?? [],
    security: {
      initialized: true,
      encryption_enabled: false,
      unlocked: true,
      lock_timeout_minutes: 30,
      biometric_available: false,
      biometric_enrolled: false,
      ...options.security,
    },
    unlockPasswords: options.unlockPasswords ?? [],
    deferUnlock: options.deferUnlock ?? false,
    errors: options.errors ?? {},
    transferManifestJson: options.transferManifestJson ?? "",
    copyReceiptOwnershipAmbiguous:
      options.copyReceiptOwnershipAmbiguous ?? false,
    disconnectFailures: Math.max(0, options.disconnectFailures ?? 0),
    holdDisconnect: options.holdDisconnect ?? false,
    copyFailures: options.transferBackend?.copyFailures ?? 0,
    holdCopies: options.transferBackend?.holdCopies ?? false,
    autoLockAfterMs: options.autoLockAfterMs ?? 0,
    platform: options.platform ?? "linux",
    holdBiometric: options.holdBiometric ?? false,
    savedConnectionJson: options.savedConnection
      ? JSON.stringify(options.savedConnection)
      : "",
    appVersion: APP_VERSION,
  };

  await page.addInitScript(
    ({
      objectCount,
      longFileCount,
      scenario,
      createOnlyCapabilities,
      settings,
      prefixes,
      listObjectsByPrefix,
      bookmarks,
      bookmarkBackup,
      buckets,
      security,
      unlockPasswords,
      deferUnlock,
      errors,
      transferManifestJson,
      copyReceiptOwnershipAmbiguous,
      disconnectFailures,
      holdDisconnect,
      copyFailures,
      holdCopies,
      autoLockAfterMs,
      platform,
      holdBiometric,
      savedConnectionJson,
      appVersion,
    }: LayoutMockInit) => {
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<string, Set<number>>();
      let callbackId = 1;

      const longName =
        "quarterly-report-with-a-name-long-enough-to-exercise-the-real-table-layout-and-confirmation-dialog-with-many-wrapping-segments-and-accessible-overflow";
      const objects = Array.from(
        { length: Math.max(0, objectCount) },
        (_, i) => ({
          key:
            i < longFileCount
              ? `reports/${longName}-${i}.csv`
              : `reports/${String(i).padStart(3, "0")}-sample-object.txt`,
          size: 512 + i * 4096,
          last_modified: new Date(
            Date.UTC(2025, 0, 1, 12, i % 60),
          ).toISOString(),
          is_folder: false,
        }),
      );
      const listing = {
        objects,
        prefixes,
        truncated: false,
        next_continuation_token: "",
      };
      let storedConnectionJson = savedConnectionJson;
      let storedBookmarks = [...bookmarks];
      let storedBookmarkBackup = [...bookmarkBackup];
      const storedBuckets =
        buckets.length > 0
          ? buckets
          : [
              {
                name: "layout-test-bucket",
                creation_date: "2025-01-01T00:00:00.000Z",
              },
            ];
      const securityState = { ...security };
      const testState = {
        scenario,
        objectCount,
        calls: [] as string[],
        callLog: [] as { command: string; args: unknown }[],
        readCallLog: undefined as
          (() => { command: string; args: unknown }[]) | undefined,
        releaseListing: undefined as (() => void) | undefined,
        releaseUnlock: undefined as (() => void) | undefined,
        releaseDisconnect: undefined as (() => void) | undefined,
        releaseBiometric: undefined as (() => void) | undefined,
        biometricReleased: false,
        releaseCopies: [] as (() => void)[],
        setCommandError: undefined as
          ((command: string, error: string | null) => void) | undefined,
        emit: undefined as
          ((event: string, payload: unknown) => void) | undefined,
      };
      // Tests assert against the raw arguments. Artifact writers redact secret
      // fields when they persist the log (see saveArtifact in helpers.ts).
      testState.readCallLog = () => testState.callLog;
      const recordCall = (
        command: string,
        args: Record<string, unknown> | null,
      ): void => {
        const raw = JSON.parse(JSON.stringify(args ?? null)) as unknown;
        testState.callLog.push({ command, args: raw });
      };

      const addListener = (event: string, id: number): void => {
        let ids = listeners.get(event);
        if (!ids) {
          ids = new Set<number>();
          listeners.set(event, ids);
        }
        ids.add(id);
      };
      const removeListener = (event: string, id: number): void => {
        listeners.get(event)?.delete(id);
      };
      const emit = (event: string, payload: unknown): void => {
        for (const id of listeners.get(event) ?? []) {
          const callback = callbacks.get(id);
          callback?.({ event, id, payload });
        }
      };

      const PENDING_CANCEL_TTL_MS = 30_000;
      const runningTransfers = new Map<number, (reason: Error) => void>();
      const pendingCancels = new Map<number, number>();
      let copyFailuresLeft = copyFailures;
      let disconnectFailuresLeft = disconnectFailures;
      let disconnectHeld = holdDisconnect;
      let connectSequence = 0;
      const commandErrors = { ...errors };
      let lastVaultActivity = Date.now();
      const logEvent = (command: string, args: unknown): void => {
        recordCall(
          command,
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : null,
        );
      };
      const vaultExpired = (): boolean =>
        autoLockAfterMs > 0 &&
        securityState.encryption_enabled &&
        securityState.unlocked &&
        Date.now() - lastVaultActivity >= autoLockAfterMs;
      const expireVaultIfIdle = (): void => {
        if (vaultExpired()) {
          securityState.unlocked = false;
          logEvent("mock:auto-locked", null);
        }
      };
      /** Register a native command the way `TransferGuard::register` does. */
      const runTransfer = async <T>(
        transferId: number,
        work: () => Promise<T>,
      ): Promise<T> => {
        const pendingAt = pendingCancels.get(transferId);
        pendingCancels.delete(transferId);
        if (
          pendingAt !== undefined &&
          Date.now() - pendingAt <= PENDING_CANCEL_TTL_MS
        ) {
          logEvent("mock:pending-cancel-consumed", { transferId });
          throw new Error("Transfer cancelled");
        }
        let cancel: (reason: Error) => void = () => undefined;
        const cancelled = new Promise<never>((_, reject) => {
          cancel = reject;
        });
        runningTransfers.set(transferId, cancel);
        try {
          return await Promise.race([work(), cancelled]);
        } finally {
          runningTransfers.delete(transferId);
        }
      };

      const invoke = async (
        command: MockedCommand,
        args: Record<string, unknown>,
      ) => {
        testState.calls.push(command);
        if (!command.startsWith("plugin:")) {
          recordCall(command, args);
        }

        if (command === "plugin:event|listen") {
          const id = Number(args.handler);
          addListener(String(args.event ?? ""), id);
          return id;
        }
        if (command === "plugin:event|unlisten") {
          removeListener(
            String(args.event ?? ""),
            Number(args.eventId ?? args.id),
          );
          return null;
        }
        if (command === "plugin:event|emit") {
          emit(String(args.event ?? ""), args.payload);
          return null;
        }

        const configuredError = commandErrors[command];
        if (command !== "disconnect" && configuredError !== undefined) {
          throw new Error(configuredError);
        }

        switch (command) {
          case "get_platform_info":
            return platform;
          case "plugin:app|version":
            return appVersion;
          case "load_settings":
            return JSON.stringify({
              _schemaVersion: 2,
              _setupComplete: true,
              supportPromptDismissed: true,
              autoCheckUpdates: false,
              openTransferDrawerOnStart: false,
              ...settings,
            });
          case "load_connection":
            return storedConnectionJson;
          case "load_bookmarks":
            return JSON.stringify(storedBookmarks);
          case "load_bookmarks_state":
            return {
              primary: {
                present: true,
                contents: JSON.stringify(storedBookmarks),
                error: null,
              },
              backup: {
                present: true,
                contents: JSON.stringify(storedBookmarkBackup),
                error: null,
              },
            };
          case "load_bookmarks_backup":
            return JSON.stringify(storedBookmarkBackup);
          case "save_bookmarks": {
            const parsed = JSON.parse(String(args.json ?? "[]")) as unknown;
            storedBookmarks = Array.isArray(parsed) ? parsed : [];
            return null;
          }
          case "save_bookmarks_backup": {
            const parsed = JSON.parse(String(args.json ?? "[]")) as unknown;
            storedBookmarkBackup = Array.isArray(parsed) ? parsed : [];
            return null;
          }
          case "get_security_status":
            expireVaultIfIdle();
            return { ...securityState };
          case "touch_security_activity":
            expireVaultIfIdle();
            if (securityState.unlocked) lastVaultActivity = Date.now();
            return null;
          case "disconnect": {
            // The native disconnect cancels every registered transfer.
            for (const cancel of runningTransfers.values()) {
              cancel(new Error("Transfer cancelled"));
            }
            if (disconnectFailuresLeft > 0) {
              disconnectFailuresLeft -= 1;
              throw new Error(
                commandErrors.disconnect ??
                  "Timed out while stopping active transfers for disconnect",
              );
            }
            if (configuredError !== undefined) {
              throw new Error(configuredError);
            }
            if (disconnectHeld) {
              await new Promise<void>((resolve) => {
                testState.releaseDisconnect = resolve;
              });
              disconnectHeld = false;
            }
            return null;
          }
          case "cancel_transfer": {
            const transferId = Number(args.transferId);
            const cancel = runningTransfers.get(transferId);
            if (cancel) {
              cancel(new Error("Transfer cancelled"));
            } else {
              pendingCancels.set(transferId, Date.now());
              logEvent("mock:pending-cancel-recorded", { transferId });
            }
            return null;
          }
          case "unlock_security": {
            const password = String(args.password ?? "");
            if (
              unlockPasswords.length > 0 &&
              !unlockPasswords.includes(password)
            ) {
              throw new Error("Invalid password");
            }
            if (deferUnlock) {
              await new Promise<void>((resolve) => {
                testState.releaseUnlock = resolve;
              });
            }
            securityState.unlocked = true;
            lastVaultActivity = Date.now();
            return { ...securityState };
          }
          case "initialize_security": {
            securityState.initialized = true;
            securityState.encryption_enabled = args.enableEncryption === true;
            securityState.unlocked = true;
            return { ...securityState };
          }
          case "lock_security":
            securityState.unlocked = false;
            return { ...securityState };
          case "unlock_biometric":
            if (holdBiometric && !testState.biometricReleased) {
              await new Promise<void>((resolve) => {
                testState.releaseBiometric = resolve;
              });
            }
            securityState.unlocked = true;
            lastVaultActivity = Date.now();
            return { ...securityState };
          case "enable_biometric":
            securityState.biometric_enrolled = true;
            return { ...securityState };
          case "disable_biometric":
            securityState.biometric_enrolled = false;
            return { ...securityState };
          case "set_security_encryption":
            securityState.initialized = true;
            securityState.encryption_enabled = args.enableEncryption === true;
            securityState.unlocked = true;
            return { ...securityState };
          case "change_security_password":
            securityState.unlocked = true;
            return { ...securityState };
          case "load_transfer_manifest":
            return {
              recovery_session: "a".repeat(64),
              manifest_json: transferManifestJson,
              legacy_import_allowed: false,
            };
          case "transfer_checkpoint_gc":
            return 0;
          case "connect":
            connectSequence += 1;
            return {
              region: "us-east-1",
              connection_id: `browser-layout-connection-${connectSequence}`,
              connection_identity: "browser-layout-identity",
              create_only_capabilities: createOnlyCapabilities,
              // Models AWS, the only provider that verifies conditional DELETE,
              // so Move flows stay available.
              conditional_delete_supported: true,
            };
          case "list_buckets":
            return storedBuckets.map((bucket) => ({
              name: bucket.name,
              creation_date: bucket.creation_date ?? "2025-01-01T00:00:00.000Z",
            }));
          case "list_objects":
            if (scenario === "error") {
              throw new Error("Mock listing failed");
            }
            if (scenario === "loading") {
              await new Promise<void>((resolve) => {
                testState.releaseListing = resolve;
              });
            }
            if (String(args.delimiter ?? "") === "") {
              const override = listObjectsByPrefix[String(args.prefix ?? "")];
              if (override) {
                return {
                  objects: override.objects ?? [],
                  prefixes: override.prefixes ?? [],
                  truncated: false,
                  next_continuation_token: "",
                };
              }
            }
            return listing;
          case "generate_presigned_url": {
            const key = encodeURIComponent(String(args.key ?? "object"));
            const expires = Number(args.expiresInSecs ?? 3600);
            return `https://layout-test.invalid/presigned/${key}?X-Amz-Expires=${expires}`;
          }
          case "updater_support_info":
            return {
              mode: "manual",
              release_url: "https://example.invalid/releases",
            };
          case "is_app_translocated":
            return false;
          case "object_exists":
          case "path_exists":
            return false;
          case "head_object":
            return { content_length: 1024 };
          case "copy_object_to": {
            const sourceKey = String(args.srcKey ?? "source");
            const destinationKey = String(args.dstKey ?? "destination");
            const fingerprint = "a".repeat(64);
            const transferId = Number(args.transferId);
            if (Number.isFinite(transferId)) {
              await runTransfer(transferId, async () => {
                if (copyFailuresLeft > 0) {
                  copyFailuresLeft -= 1;
                  throw new Error("HTTP 503 SlowDown: mock transient failure");
                }
                if (holdCopies) {
                  await new Promise<void>((resolve) => {
                    testState.releaseCopies.push(resolve);
                  });
                }
              });
            }
            const receipt: Record<string, unknown> = {
              source_key: sourceKey,
              source_etag: "mock-source-etag",
              source_fingerprint: fingerprint,
              source_acl_fingerprint: fingerprint,
              source_tag_fingerprint: fingerprint,
              source_version_id: null,
              destination_key: destinationKey,
              destination_etag: "mock-destination-etag",
              destination_fingerprint: fingerprint,
              destination_acl_fingerprint: fingerprint,
              destination_tag_fingerprint: fingerprint,
              destination_version_id: null,
            };
            if (copyReceiptOwnershipAmbiguous !== "missing") {
              receipt.ownership_ambiguous = copyReceiptOwnershipAmbiguous;
            }
            return receipt;
          }
          case "copy_prefix_to": {
            const sourcePrefix = String(args.srcPrefix ?? "source/");
            const destinationPrefix = String(args.dstPrefix ?? "destination/");
            const fingerprint = "a".repeat(64);
            return [
              {
                source_key: `${sourcePrefix}sample.txt`,
                source_etag: "mock-source-etag",
                source_fingerprint: fingerprint,
                source_acl_fingerprint: fingerprint,
                source_tag_fingerprint: fingerprint,
                source_version_id: null,
                destination_key: `${destinationPrefix}sample.txt`,
                destination_etag: "mock-destination-etag",
                destination_fingerprint: fingerprint,
                destination_acl_fingerprint: fingerprint,
                destination_tag_fingerprint: fingerprint,
                destination_version_id: null,
                ownership_ambiguous:
                  copyReceiptOwnershipAmbiguous === "missing"
                    ? undefined
                    : copyReceiptOwnershipAmbiguous,
              },
            ];
          }
          case "delete_copied_objects": {
            const receipts = Array.isArray(args.receipts)
              ? (args.receipts as Array<Record<string, unknown>>)
              : [];
            if (
              receipts.some((receipt) => receipt.ownership_ambiguous === true)
            ) {
              throw new Error(
                "Copy receipt ownership is ambiguous; source deletion was refused.",
              );
            }
            return null;
          }
          case "save_connection":
            storedConnectionJson = String(args.json ?? "");
            return null;
          case "create_folder":
          case "save_settings":
          case "clear_transfer_manifest":
          case "transfer_checkpoint_remove":
          case "plugin:window|set_size":
          case "plugin:webview|set_webview_auto_resize":
            return null;
          default:
            // Unsupported native calls are harmless for these read-only tests.
            // Returning null keeps optional startup integrations from opening
            // real dialogs, storage clients, or update endpoints.
            return null;
        }
      };

      testState.setCommandError = (command, error) => {
        if (error === null) delete commandErrors[command];
        else commandErrors[command] = error;
      };

      const internals = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        callbacks,
        transformCallback(callback: (value: unknown) => void, once = false) {
          const id = callbackId++;
          callbacks.set(id, (value) => {
            if (once) callbacks.delete(id);
            callback(value);
          });
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        runCallback(id: number, value: unknown) {
          callbacks.get(id)?.(value);
        },
        invoke,
      };

      (
        window as typeof window & {
          __TAURI_INTERNALS__: typeof internals;
          __TAURI_EVENT_PLUGIN_INTERNALS__: {
            unregisterListener: typeof removeListener;
          };
          __S3_LAYOUT_TEST__: typeof testState & { emit: typeof emit };
        }
      ).__TAURI_INTERNALS__ = internals;
      (
        window as typeof window & {
          __TAURI_EVENT_PLUGIN_INTERNALS__: {
            unregisterListener: typeof removeListener;
          };
        }
      ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: removeListener,
      };
      testState.emit = emit;
      (
        window as typeof window & {
          __S3_LAYOUT_TEST__: typeof testState;
        }
      ).__S3_LAYOUT_TEST__ = testState;
    },
    init,
  );

  if (options.sftp) {
    await page.addInitScript(
      installSftpBridge,
      buildSftpBridgeInit(options.sftp),
    );
  }
}

function buildSftpBridgeInit(options: MockSftpOptions): SftpBridgeInit {
  const homePath = options.homePath ?? "/home/demo";
  return {
    hostKey: options.hostKey ?? "unknown",
    auth: options.auth ?? "success",
    password: options.password ?? "sftp-password",
    keyPassphrase: options.keyPassphrase ?? "key-passphrase",
    keyboardInteractive: {
      name: options.keyboardInteractive?.name ?? "Server sign-in",
      instructions:
        options.keyboardInteractive?.instructions ?? "Answer the challenge.",
      prompts: options.keyboardInteractive?.prompts ?? [],
      answers: options.keyboardInteractive?.answers ?? [],
    },
    privateKey: options.privateKey ?? null,
    homePath,
    files: options.files ?? defaultSftpFiles(homePath),
    serverKey: MOCK_SFTP_SERVER_KEY,
    serverFingerprint: MOCK_SFTP_SERVER_FINGERPRINT,
    changedKey: MOCK_SFTP_CHANGED_KEY,
    changedFingerprint: MOCK_SFTP_CHANGED_FINGERPRINT,
    createOnlySupported: options.createOnlySupported ?? false,
    holdConnect: options.holdConnect ?? false,
    transfers: options.transfers ?? null,
  };
}

/**
 * Init-script bridge for the SFTP commands. It wraps the layout mock's invoke,
 * so S3 commands keep their existing answers. It must be a self-contained
 * function: Playwright serializes it into the page.
 */
function installSftpBridge(init: SftpBridgeInit): void {
  type SftpNode = {
    kind: MockSftpKind;
    size: number;
    mtime: number;
    permissions: number;
    owner: string;
    group: string;
    text: string | null;
    base64: string | null;
    contentType: string | null;
  };
  type PendingAttempt = {
    stage: "host-key" | "prompt";
    host: string;
    port: number;
    username: string;
    authMethod: string;
    password: string | null;
    passphrase: string | null;
    serverKey: string;
    fingerprint: string;
  };
  const bridge = window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => Promise<unknown>;
    };
    __S3_LAYOUT_TEST__?: { callLog: { command: string; args: unknown }[] };
  };
  const original = bridge.__TAURI_INTERNALS__.invoke;
  const attempts = new Map<string, PendingAttempt>();
  const nodes = new Map<string, SftpNode>();
  let attemptSequence = 0;
  let connectionSequence = 0;
  let session: { connectionId: string; homePath: string } | null = null;
  // Errors queued by `__S3_SFTP_MOCK__.failNext`, consumed by the next call.
  const queuedFailures = new Map<string, string[]>();
  // Cleanup warnings queued by `__S3_SFTP_MOCK__.warnNext`, returned by the
  // next successful upload or rename.
  const queuedWarnings = new Map<string, string[]>();
  const nextWarning = (command: string): string | null =>
    queuedWarnings.get(command)?.shift() ?? null;
  // Paths a different client creates right after the next existence check.
  const racedPaths = new Set<string>();
  // Held transfer commands: cancel rejects, release lets them run.
  const runningTransfers = new Map<number, (reason: Error) => void>();
  const transferReleases: Array<() => void> = [];
  // Held connects, ended only by sftp_connect_cancel_pending.
  const heldConnects: Array<(reason: Error) => void> = [];

  const parentOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash <= 0 ? "/" : path.slice(0, slash);
  };
  const baseOf = (path: string): string =>
    path.slice(path.lastIndexOf("/") + 1);
  const decodedLength = (base64: string): number => {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  };
  const newNode = (kind: MockSftpKind, owner: string): SftpNode => ({
    kind,
    size: 0,
    mtime: 1_700_000_000,
    permissions: kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644,
    owner,
    group: owner,
    text: null,
    base64: null,
    contentType: null,
  });
  const ensureDirChain = (path: string): void => {
    if (path === "/" || nodes.has(path)) return;
    ensureDirChain(parentOf(path));
    nodes.set(path, newNode("dir", "root"));
  };
  nodes.set("/", newNode("dir", "root"));
  for (const seed of init.files) {
    ensureDirChain(parentOf(seed.path));
    const kind = seed.kind ?? "file";
    const node = newNode(kind, seed.owner ?? "root");
    node.group = seed.group ?? node.owner;
    node.mtime = seed.mtime ?? node.mtime;
    node.permissions = seed.permissions ?? node.permissions;
    if (kind === "file") {
      node.text = seed.text ?? null;
      node.base64 = seed.base64 ?? null;
      node.contentType = seed.contentType ?? null;
      node.size =
        seed.size ??
        (seed.text !== undefined
          ? new TextEncoder().encode(seed.text).length
          : seed.base64 !== undefined
            ? decodedLength(seed.base64)
            : 0);
    }
    nodes.set(seed.path, node);
  }

  const childrenOf = (path: string): string[] =>
    [...nodes.keys()].filter((key) => key !== "/" && parentOf(key) === path);
  const subtreeOf = (path: string): string[] =>
    [...nodes.keys()].filter(
      (key) => key === path || key.startsWith(`${path}/`),
    );
  const entryFor = (path: string, node: SftpNode) => ({
    name: baseOf(path),
    path,
    kind: node.kind,
    size: node.kind === "dir" ? null : node.size,
    mtime: node.mtime,
    permissions: node.permissions,
    uid: node.owner === "root" ? 0 : 1000,
    gid: node.group === "root" ? 0 : 1000,
    owner: node.owner,
    group: node.group,
    name_lossy: baseOf(path).includes("\uFFFD"),
  });
  const requireSession = (args: Record<string, unknown>): void => {
    if (!session || args.connectionId !== session.connectionId) {
      throw new Error("Connection changed");
    }
  };
  const requireNode = (path: string): SftpNode => {
    const node = nodes.get(path);
    if (!node) throw new Error(`No such file or directory: ${path}`);
    return node;
  };
  const requireParentDir = (path: string): void => {
    const parent = nodes.get(parentOf(path));
    if (parent?.kind !== "dir") {
      throw new Error("The parent folder does not exist.");
    }
  };
  // Same refusal as the native side for a name that is not valid UTF-8.
  const requireWritablePath = (path: string): void => {
    if (path.includes("\uFFFD")) {
      throw new Error(
        "Remote path contains a name that could not be decoded as UTF-8 and cannot be addressed safely",
      );
    }
  };
  const previewOf = (node: SftpNode) => {
    if (node.text !== null) {
      return {
        content_type: "text/plain; charset=utf-8",
        data: node.text,
        is_text: true,
        truncated: false,
        total_size: new TextEncoder().encode(node.text).length,
      };
    }
    return {
      content_type: node.contentType ?? "application/octet-stream",
      data: node.base64 ?? "",
      is_text: false,
      truncated: false,
      total_size: node.size,
    };
  };
  const connectedStep = (attempt: PendingAttempt): Record<string, unknown> => {
    connectionSequence += 1;
    const connectionId = `mock-sftp-connection-${connectionSequence}`;
    session = { connectionId, homePath: init.homePath };
    return {
      step: "connected",
      connection_id: connectionId,
      connection_identity: `mock-sftp-identity-${connectionSequence}`,
      endpoint: `sftp://${attempt.host}:${attempt.port}`,
      home_path: init.homePath,
      host_key: attempt.serverKey,
      host_key_fingerprint: attempt.fingerprint,
      create_only_supported: init.createOnlySupported,
    };
  };
  const authenticate = (attempt: PendingAttempt): Record<string, unknown> => {
    if (attempt.authMethod === "password") {
      if (init.auth !== "success" || attempt.password !== init.password) {
        throw new Error("Authentication failed.");
      }
      return connectedStep(attempt);
    }
    if (attempt.authMethod === "key") {
      if (!init.privateKey) {
        throw new Error("A private key is required for key authentication.");
      }
      if (init.auth === "keyboard-interactive") {
        throw new Error("Authentication failed.");
      }
      if (init.privateKey.encrypted) {
        if (!attempt.passphrase) {
          throw new Error(
            "The private key is encrypted. Enter its passphrase.",
          );
        }
        if (attempt.passphrase !== init.keyPassphrase) {
          throw new Error("The private key passphrase is incorrect.");
        }
      }
      return connectedStep(attempt);
    }
    if (init.auth !== "keyboard-interactive") return connectedStep(attempt);
    attemptSequence += 1;
    const attemptId = `mock-sftp-attempt-${attemptSequence}`;
    attempts.set(attemptId, { ...attempt, stage: "prompt" });
    return {
      step: "prompt",
      attempt_id: attemptId,
      name: init.keyboardInteractive.name,
      instructions: init.keyboardInteractive.instructions,
      prompts: init.keyboardInteractive.prompts.map((prompt) => ({
        text: prompt.text,
        echo: prompt.echo,
      })),
    };
  };

  const handleSftp = (
    command: string,
    args: Record<string, unknown>,
  ): unknown => {
    const queued = queuedFailures.get(command);
    if (queued && queued.length > 0) {
      const message = queued.shift() ?? "";
      // A lost connection ends the session, as the native side does.
      if (message.startsWith("SFTP connection lost")) session = null;
      throw new Error(message);
    }
    switch (command) {
      case "pick_ssh_private_key":
        return init.privateKey
          ? {
              key_text: init.privateKey.key_text,
              algorithm: init.privateKey.algorithm,
              encrypted: init.privateKey.encrypted,
              file_name: init.privateKey.file_name,
            }
          : null;
      case "sftp_connect": {
        const host = String(args.host ?? "").toLowerCase();
        const port = Number(args.port ?? 22);
        const authMethod = String(args.authMethod ?? "password");
        const password =
          typeof args.password === "string" ? args.password : null;
        const passphrase =
          typeof args.passphrase === "string" ? args.passphrase : null;
        const pinned =
          typeof args.pinnedHostKey === "string" ? args.pinnedHostKey : "";
        const endpoint = `sftp://${host}:${port}`;
        const serverKey =
          init.hostKey === "changed" ? init.changedKey : init.serverKey;
        const fingerprint =
          init.hostKey === "changed"
            ? init.changedFingerprint
            : init.serverFingerprint;
        const attempt: PendingAttempt = {
          stage: "host-key",
          host,
          port,
          username: String(args.username ?? ""),
          authMethod,
          password,
          passphrase,
          serverKey,
          fingerprint,
        };
        if (pinned.length > 0) {
          if (pinned !== serverKey) {
            throw new Error(
              `The SSH host key for ${endpoint} changed. The server presented ${fingerprint}, which does not match the saved host key. Reset the saved host key only if the change is expected.`,
            );
          }
          return authenticate(attempt);
        }
        attemptSequence += 1;
        const attemptId = `mock-sftp-attempt-${attemptSequence}`;
        attempts.set(attemptId, attempt);
        return {
          step: "host_key_unknown",
          attempt_id: attemptId,
          key_type: "ssh-ed25519",
          fingerprint_sha256: fingerprint,
          host_key: serverKey,
        };
      }
      case "sftp_connect_continue": {
        const attemptId = String(args.attemptId ?? "");
        const attempt = attempts.get(attemptId);
        if (!attempt) throw new Error("Connection attempt expired");
        attempts.delete(attemptId);
        if (attempt.stage === "host-key") {
          if (args.trustHostKey !== true) {
            throw new Error(
              "The host key was not trusted, so the connection was closed.",
            );
          }
          return authenticate(attempt);
        }
        const responses = Array.isArray(args.responses) ? args.responses : [];
        if (
          responses.length !== init.keyboardInteractive.prompts.length ||
          JSON.stringify(responses) !==
            JSON.stringify(init.keyboardInteractive.answers)
        ) {
          throw new Error("Authentication failed.");
        }
        return connectedStep(attempt);
      }
      case "sftp_connect_cancel":
        attempts.delete(String(args.attemptId ?? ""));
        return null;
      case "sftp_connect_cancel_pending":
        for (const cancel of heldConnects.splice(0)) {
          cancel(new Error("SFTP connect cancelled"));
        }
        attempts.clear();
        return null;
      case "sftp_list_dir": {
        requireSession(args);
        const path = String(args.path ?? "/");
        const node = requireNode(path);
        if (node.kind !== "dir") throw new Error(`Not a folder: ${path}`);
        const entries = childrenOf(path)
          .map((child) => entryFor(child, requireNode(child)))
          .sort((left, right) => left.name.localeCompare(right.name));
        return { path, entries, truncated: false };
      }
      case "sftp_stat": {
        requireSession(args);
        const path = String(args.path ?? "/");
        return entryFor(path, requireNode(path));
      }
      case "sftp_exists": {
        requireSession(args);
        const path = String(args.path ?? "");
        if (racedPaths.has(path)) {
          racedPaths.delete(path);
          const raced = newNode("file", "demo");
          raced.size = 1;
          nodes.set(path, raced);
          return false;
        }
        return nodes.has(path);
      }
      case "sftp_create_dir": {
        requireSession(args);
        const path = String(args.path ?? "");
        requireWritablePath(path);
        if (nodes.has(path)) {
          throw new Error(`Remote path already exists: ${path}`);
        }
        requireParentDir(path);
        nodes.set(path, newNode("dir", "demo"));
        return null;
      }
      case "sftp_rename": {
        requireSession(args);
        const fromPath = String(args.fromPath ?? "");
        const toPath = String(args.toPath ?? "");
        requireWritablePath(fromPath);
        requireWritablePath(toPath);
        const source = requireNode(fromPath);
        requireParentDir(toPath);
        if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
          throw new Error(
            "A folder cannot be moved into itself or one of its descendants",
          );
        }
        if (nodes.has(toPath)) {
          // The native side refuses an existing target unless overwrite is set,
          // and never replaces a folder or puts a folder over a file.
          if (args.overwrite !== true) {
            throw new Error(`Remote path already exists: ${toPath}`);
          }
          const target = requireNode(toPath);
          if (target.kind === "dir") {
            throw new Error(`Refusing to replace the folder ${toPath}`);
          }
          if (source.kind === "dir") {
            throw new Error(
              `Refusing to replace the file ${toPath} with a folder`,
            );
          }
          nodes.delete(toPath);
        }
        const moved = subtreeOf(fromPath).map((key) => ({
          key,
          node: nodes.get(key) as SftpNode,
        }));
        for (const { key } of moved) nodes.delete(key);
        for (const { key, node } of moved) {
          nodes.set(`${toPath}${key.slice(fromPath.length)}`, node);
        }
        return { warning: nextWarning(command) };
      }
      case "sftp_delete": {
        requireSession(args);
        const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
        // One bad path refuses the whole batch, before anything is removed.
        for (const path of paths) requireWritablePath(path);
        const deleted: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const path of paths) {
          const node = nodes.get(path);
          if (!node) {
            failed.push({ path, error: "No such file or directory." });
          } else if (node.kind === "dir") {
            failed.push({
              path,
              error: "Use folder delete for directories.",
            });
          } else {
            nodes.delete(path);
            deleted.push(path);
          }
        }
        return { deleted, failed };
      }
      case "sftp_delete_dir": {
        requireSession(args);
        const path = String(args.path ?? "");
        requireWritablePath(path);
        const node = nodes.get(path);
        if (path === "/") {
          return {
            deleted: [],
            failed: [{ path, error: "The root folder cannot be deleted." }],
          };
        }
        if (node?.kind !== "dir") {
          return {
            deleted: [],
            failed: [{ path, error: "No such folder." }],
          };
        }
        const removed = subtreeOf(path);
        for (const key of removed) nodes.delete(key);
        return { deleted: removed, failed: [] };
      }
      case "sftp_preview": {
        requireSession(args);
        const path = String(args.path ?? "");
        const node = requireNode(path);
        if (node.kind === "dir") throw new Error("A folder has no preview.");
        // Symlinks are not followed, and only regular files are read.
        if (node.kind !== "file") {
          throw new Error(`Remote path is not a regular file: ${path}`);
        }
        return previewOf(node);
      }
      case "sftp_upload": {
        requireSession(args);
        const path = String(args.path ?? "");
        if (nodes.has(path) && args.overwrite !== true) {
          throw new Error(`Remote path already exists: ${path}`);
        }
        requireParentDir(path);
        const node = newNode("file", "demo");
        node.size = 2048;
        nodes.set(path, node);
        return { bytes_written: 2048, warning: nextWarning(command) };
      }
      case "sftp_upload_bytes": {
        requireSession(args);
        const path = String(args.path ?? "");
        if (nodes.has(path) && args.overwrite !== true) {
          throw new Error(`Remote path already exists: ${path}`);
        }
        requireParentDir(path);
        const base64 = String(args.bytesBase64 ?? "");
        const node = newNode("file", "demo");
        node.base64 = base64;
        node.size = decodedLength(base64);
        nodes.set(path, node);
        return { bytes_written: node.size, warning: nextWarning(command) };
      }
      case "sftp_download":
        requireSession(args);
        return requireNode(String(args.path ?? "")).size;
      default:
        throw new Error(`Unsupported SFTP command in the mock: ${command}`);
    }
  };

  // Test hook: the next call to `command` fails with `message`. A message that
  // starts with "SFTP connection lost" also ends the session.
  (window as unknown as { __S3_SFTP_MOCK__: unknown }).__S3_SFTP_MOCK__ = {
    failNext(command: string, message: string): void {
      const queue = queuedFailures.get(command) ?? [];
      queue.push(message);
      queuedFailures.set(command, queue);
    },
    // The next successful `command` (an upload or a rename) reports `message`
    // as a cleanup warning, as the native side does for a leftover file.
    warnNext(command: string, message: string): void {
      const queue = queuedWarnings.get(command) ?? [];
      queue.push(message);
      queuedWarnings.set(command, queue);
    },
    // Another client creates `path` between the next existence check and the write.
    createAfterNextExists(path: string): void {
      racedPaths.add(path);
    },
  };

  const transfers = init.transfers;
  const localGrant = (name: string, isDir: boolean, size?: number) => ({
    token: `local-${isDir ? "dir" : "file"}-${name}`,
    path: `/local/${name}`,
    name,
    isDir,
    size,
    directoryToken: null,
    directoryPath: null,
  });
  const localPick = (
    command: string,
    payload: Record<string, unknown>,
  ): unknown => {
    if (command === "pick_upload_files") {
      return (transfers?.uploadFiles ?? []).map((file) =>
        localGrant(file.name, false, file.size),
      );
    }
    if (command === "pick_upload_folder") {
      return transfers?.uploadFolder
        ? [localGrant(transfers.uploadFolder.name, true)]
        : [];
    }
    if (command === "list_local_files_recursive") {
      const folder = transfers?.uploadFolder;
      const entries = (folder?.files ?? []).map((file, index) => ({
        file_path: `/local/${folder?.name}/${file.relativePath}`,
        relative_path: file.relativePath,
        size: file.size,
        file_token: `local-file-${index}-${file.relativePath}`,
      }));
      return { entries, warnings: [], warning_count: 0 };
    }
    if (command === "pick_download_file") {
      const fileName = String(payload.fileName ?? "download.bin");
      return {
        token: "local-download-file",
        path: `/Users/demo/Downloads/${fileName}`,
        name: fileName,
        isDir: false,
        directoryToken: null,
        directoryPath: null,
      };
    }
    // pick_download_directory
    return {
      token: "local-download-dir",
      path: "/Users/demo/Downloads",
      name: "Downloads",
      isDir: true,
      directoryToken: "local-download-dir",
      directoryPath: "/Users/demo/Downloads",
    };
  };

  bridge.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (
      command === "disconnect" &&
      session !== null &&
      payload.connectionId === session.connectionId
    ) {
      session = null;
    }
    if (transfers) {
      if (command === "cancel_transfer") {
        const cancel = runningTransfers.get(Number(payload.transferId));
        if (cancel) {
          bridge.__S3_LAYOUT_TEST__?.callLog.push({
            command,
            args: JSON.parse(JSON.stringify(payload)) as unknown,
          });
          cancel(new Error("Transfer cancelled"));
          return null;
        }
        return original(command, args);
      }
      if (
        command === "pick_upload_files" ||
        command === "pick_upload_folder" ||
        command === "list_local_files_recursive" ||
        command === "pick_download_file" ||
        command === "pick_download_directory"
      ) {
        bridge.__S3_LAYOUT_TEST__?.callLog.push({
          command,
          args: JSON.parse(JSON.stringify(payload)) as unknown,
        });
        return localPick(command, payload);
      }
    }
    if (!command.startsWith("sftp_") && command !== "pick_ssh_private_key") {
      return original(command, args);
    }
    bridge.__S3_LAYOUT_TEST__?.callLog.push({
      command,
      args: JSON.parse(JSON.stringify(payload)) as unknown,
    });
    if (init.holdConnect && command === "sftp_connect") {
      await new Promise<never>((_resolve, reject) => {
        heldConnects.push(reject);
      });
    }
    if (
      transfers?.holdTransfers &&
      (command === "sftp_upload" ||
        command === "sftp_upload_bytes" ||
        command === "sftp_download")
    ) {
      const transferId = Number(payload.transferId);
      const held = new Promise<void>((resolve, reject) => {
        runningTransfers.set(transferId, reject);
        transferReleases.push(resolve);
      });
      try {
        await held;
      } finally {
        runningTransfers.delete(transferId);
      }
    }
    return handleSftp(command, payload);
  };
  (
    window as unknown as {
      __S3_SFTP_TRANSFERS__: { release(): void };
    }
  ).__S3_SFTP_TRANSFERS__ = {
    release(): void {
      for (const release of transferReleases.splice(0)) release();
    },
  };
}

/** Let every held SFTP transfer command run to completion. */
export async function releaseMockSftpTransfers(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as {
        __S3_SFTP_TRANSFERS__?: { release(): void };
      }
    ).__S3_SFTP_TRANSFERS__?.release();
  });
}

/** Make the next `sftp_exists` for `path` miss, and create the file right after it. */
export async function createSftpPathAfterNextExists(
  page: Page,
  path: string,
): Promise<void> {
  await page.evaluate((target) => {
    (
      window as unknown as {
        __S3_SFTP_MOCK__: { createAfterNextExists(path: string): void };
      }
    ).__S3_SFTP_MOCK__.createAfterNextExists(target);
  }, path);
}

export async function readMockCallLog(page: Page): Promise<MockCall[]> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: {
          callLog: { command: string; args: unknown }[];
          readCallLog?: () => { command: string; args: unknown }[];
        };
      }
    ).__S3_LAYOUT_TEST__;
    return state ? [...(state.readCallLog?.() ?? state.callLog)] : [];
  });
}

export async function releaseMockListing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { releaseListing?: () => void };
      }
    ).__S3_LAYOUT_TEST__;
    state?.releaseListing?.();
  });
}

export async function releaseMockDisconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { releaseDisconnect?: () => void };
      }
    ).__S3_LAYOUT_TEST__;
    state?.releaseDisconnect?.();
  });
}

export async function setMockCommandError(
  page: Page,
  command: string,
  error: string | null,
): Promise<void> {
  await page.evaluate(
    ({ command, error }) => {
      const state = (
        window as typeof window & {
          __S3_LAYOUT_TEST__?: {
            setCommandError?: (command: string, error: string | null) => void;
          };
        }
      ).__S3_LAYOUT_TEST__;
      state?.setCommandError?.(command, error);
    },
    { command, error },
  );
}

export async function releaseMockCopies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { releaseCopies: (() => void)[] };
      }
    ).__S3_LAYOUT_TEST__;
    for (const release of state?.releaseCopies.splice(0) ?? []) release();
  });
}

export async function releaseMockBiometric(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: {
          releaseBiometric?: () => void;
          biometricReleased?: boolean;
        };
      }
    ).__S3_LAYOUT_TEST__;
    if (state) state.biometricReleased = true;
    state?.releaseBiometric?.();
  });
}

export async function releaseMockUnlock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { releaseUnlock?: () => void };
      }
    ).__S3_LAYOUT_TEST__;
    state?.releaseUnlock?.();
  });
}

export async function openMockListing(
  page: Page,
  options: LayoutMockOptions = {},
): Promise<void> {
  await installLayoutTauriMock(page, options);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  await connectMockListing(page, options.endpoint);
}

/** Connect after a test has handled a startup security prompt. */
export async function connectMockListing(
  page: Page,
  endpoint = "https://layout-test.invalid",
): Promise<void> {
  await page.locator("#conn-endpoint").fill(endpoint);
  await page.locator("#conn-access-key").fill("layout-access-key");
  await page.locator("#conn-secret-key").fill("layout-secret-key");
  await page.locator("#connect-btn").click();
  await expect(page.locator("#main-layout")).toBeVisible();
  if ((await page.evaluate(() => window.innerWidth)) <= 900) {
    const layout = page.locator("#main-layout");
    const sidebarOpen = await layout.evaluate((element) =>
      element.classList.contains("main-layout--sidebar-open"),
    );
    if (!sidebarOpen) await page.locator("#sidebar-toggle").click();
    await expect(layout).toHaveClass(/main-layout--sidebar-open/);
  }
  const bucket = page.locator("#bucket-list .list__item-btn").first();
  await expect(bucket).toBeVisible();
  await bucket.click();
  await expect(page.locator("#object-panel")).toBeVisible();
}
