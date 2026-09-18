import { expect, type Page } from "@playwright/test";

export type LayoutScenario = "normal" | "empty" | "loading" | "error";

export interface LayoutMockOptions {
  objectCount?: number;
  longFileCount?: number;
  scenario?: LayoutScenario;
}

interface LayoutMockInit {
  objectCount: number;
  longFileCount: number;
  scenario: LayoutScenario;
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
  };

  await page.addInitScript(
    ({ objectCount, longFileCount, scenario }: LayoutMockInit) => {
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
        prefixes: objectCount > 0 ? ["archive/"] : [],
        truncated: false,
        next_continuation_token: "",
      };
      const testState = {
        scenario,
        objectCount,
        calls: [] as string[],
        releaseListing: undefined as (() => void) | undefined,
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

      const invoke = async (command: string, args: Record<string, unknown>) => {
        testState.calls.push(command);

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
            });
          case "load_connection":
            return "";
          case "load_bookmarks":
          case "load_bookmarks_backup":
            return "[]";
          case "get_security_status":
            return {
              initialized: true,
              encryption_enabled: false,
              unlocked: true,
              lock_timeout_minutes: 30,
              biometric_available: false,
              biometric_enrolled: false,
            };
          case "load_transfer_manifest":
            return {
              recovery_session: "a".repeat(64),
              manifest_json: "",
              legacy_import_allowed: false,
            };
          case "transfer_checkpoint_gc":
            return 0;
          case "connect":
            return {
              region: "us-east-1",
              connection_id: "browser-layout-connection",
              connection_identity: "browser-layout-identity",
              create_only_capabilities: {
                put_object: true,
                complete_multipart: true,
                copy_object: true,
              },
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
          case "save_settings":
          case "save_connection":
          case "save_bookmarks":
          case "save_bookmarks_backup":
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

export async function openMockListing(
  page: Page,
  options: LayoutMockOptions = {},
): Promise<void> {
  await installLayoutTauriMock(page, options);
  await page.goto("/");
  await expect(page.locator("#connection-screen")).toBeVisible();
  await page.locator("#conn-endpoint").fill("https://layout-test.invalid");
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
