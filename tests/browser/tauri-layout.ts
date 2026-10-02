import { expect, type Page } from "@playwright/test";
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
}

export interface MockCall {
  command: string;
  args: unknown;
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
}

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
      let storedBookmarks = [...bookmarks];
      let storedBookmarkBackup = [...bookmarkBackup];
      const securityState = { ...security };
      const testState = {
        scenario,
        objectCount,
        calls: [] as string[],
        callLog: [] as { command: string; args: unknown }[],
        releaseListing: undefined as (() => void) | undefined,
        releaseUnlock: undefined as (() => void) | undefined,
        releaseDisconnect: undefined as (() => void) | undefined,
        releaseCopies: [] as (() => void)[],
        setCommandError: undefined as
          ((command: string, error: string | null) => void) | undefined,
        emit: undefined as
          ((event: string, payload: unknown) => void) | undefined,
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
        testState.callLog.push({ command, args });
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
          testState.callLog.push({
            command,
            args: JSON.parse(JSON.stringify(args ?? null)) as unknown,
          });
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
            return "linux";
          case "plugin:app|version":
            return "0.11.0-beta.7";
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
            return "";
          case "load_bookmarks":
            return JSON.stringify(storedBookmarks);
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
            };
          case "list_buckets":
            return [
              {
                name: "layout-test-bucket",
                creation_date: "2025-01-01T00:00:00.000Z",
              },
            ];
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
          case "create_folder":
          case "save_settings":
          case "save_connection":
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
}

export async function readMockCallLog(page: Page): Promise<MockCall[]> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __S3_LAYOUT_TEST__?: { callLog: { command: string; args: unknown }[] };
      }
    ).__S3_LAYOUT_TEST__;
    return state ? [...state.callLog] : [];
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
