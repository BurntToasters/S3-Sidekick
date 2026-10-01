import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { saveArtifact } from "./helpers";
import {
  openMockListing,
  readMockCallLog,
  releaseMockDisconnect,
  setMockCommandError,
} from "./tauri-layout";

const ARTIFACT_SUITE = "fixes-0.11.1/lock-security";

async function recordStage(
  page: Page,
  testInfo: TestInfo,
  name: string,
  details: Record<string, unknown>,
): Promise<void> {
  const calls = await readMockCallLog(page);
  const observed = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const ipcModule = "/ipc.ts";
    const { state } = await import(stateModule);
    const { invoke } = await import(ipcModule);
    return {
      connected: state.connected,
      connectionId: state.connectionId ?? null,
      connectionIdentity: state.connectionIdentity ?? null,
      connecting: state.connecting,
      transfersHeldForDisconnect: state.transfersHeldForDisconnect,
      security: await invoke("get_security_status"),
      mainLayoutVisible:
        getComputedStyle(document.getElementById("main-layout")!).display !==
        "none",
      connectionScreenVisible:
        getComputedStyle(document.getElementById("connection-screen")!)
          .display !== "none",
      unlockPromptVisible:
        document
          .getElementById("dialog-overlay")
          ?.classList.contains("active") ?? false,
    };
  });
  const directory = path.join(
    "test-results",
    ARTIFACT_SUITE,
    testInfo.project.name,
    name,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "observed.json"),
    `${JSON.stringify({ ...observed, ...details }, null, 2)}\n`,
  );
  await saveArtifact(page, testInfo, ARTIFACT_SUITE, name, calls);
}

async function commandCount(page: Page, command: string): Promise<number> {
  return (await readMockCallLog(page)).filter(
    (call) => call.command === command,
  ).length;
}

test("auto-lock retries failed retirement, blocks S3 access, then stays closed after unlock dismissal", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await openMockListing(page, {
    objectCount: 1,
    prefixes: [],
    security: {
      encryption_enabled: true,
      unlocked: true,
      lock_timeout_minutes: 1,
    },
    autoLockAfterMs: 60_000,
    disconnectFailures: 1,
  });

  for (let interval = 0; interval < 12; interval += 1) {
    if ((await commandCount(page, "disconnect")) > 0) break;
    await page.clock.runFor(15_000);
  }
  await expect.poll(() => commandCount(page, "disconnect")).toBeGreaterThan(0);
  expect(await commandCount(page, "disconnect")).toBe(1);
  const firstPromptVisible = await page
    .locator("#dialog-overlay")
    .evaluate((element) => element.classList.contains("active"));
  if (firstPromptVisible) await page.locator("#dialog-cancel").click();

  const previewAttempt = await page.evaluate(async () => {
    const connectionModule = "/connection.ts";
    const connection = await import(connectionModule);
    try {
      await connection.invokeS3For(
        "browser-layout-connection-1",
        "preview_object",
        {
          bucket: "layout-test-bucket",
          key: "reports/000-sample-object.txt",
        },
      );
      return { rejected: false, error: null };
    } catch (error) {
      return { rejected: true, error: String(error) };
    }
  });
  const previewCallsAfterFirstAttempt = await commandCount(
    page,
    "preview_object",
  );
  await recordStage(page, testInfo, "disconnect-rejected", {
    disconnectAttempts: await commandCount(page, "disconnect"),
    firstPromptVisible,
    previewAttempt,
    previewCallsAfterFirstAttempt,
  });

  await setMockCommandError(page, "disconnect", null);
  await page.clock.runFor(15_000);
  const disconnectAttemptsAfterRetry = await commandCount(page, "disconnect");
  const retryPromptVisible = await page
    .locator("#dialog-overlay")
    .evaluate((element) => element.classList.contains("active"));
  if (retryPromptVisible) await page.locator("#dialog-cancel").click();

  await page.clock.runFor(180_000);
  const afterDismissal = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const connectionModule = "/connection.ts";
    const { state } = await import(stateModule);
    const connection = await import(connectionModule);
    let previewRejected = false;
    try {
      await connection.invokeS3For(
        "browser-layout-connection-1",
        "preview_object",
        { bucket: "layout-test-bucket", key: "reports/000-sample-object.txt" },
      );
    } catch {
      previewRejected = true;
    }
    return {
      connected: state.connected,
      hasConnectionId: Boolean(state.connectionId),
      previewRejected,
      previewCalls:
        (
          window as typeof window & {
            __S3_LAYOUT_TEST__?: { callLog: { command: string }[] };
          }
        ).__S3_LAYOUT_TEST__?.callLog.filter(
          (call) => call.command === "preview_object",
        ).length ?? 0,
      mainLayoutVisible:
        getComputedStyle(document.getElementById("main-layout")!).display !==
        "none",
      unlockPromptVisible:
        document
          .getElementById("dialog-overlay")
          ?.classList.contains("active") ?? false,
    };
  });
  await recordStage(page, testInfo, "retry-cleanup-dismissed", {
    disconnectAttempts: disconnectAttemptsAfterRetry,
    retryPromptVisible,
    afterDismissal,
  });

  expect
    .soft(firstPromptVisible, "Unlock must wait until retirement succeeds")
    .toBe(false);
  expect
    .soft(
      previewAttempt.rejected,
      "The locked frontend must reject preview IPC",
    )
    .toBe(true);
  expect.soft(previewCallsAfterFirstAttempt).toBe(0);
  expect.soft(disconnectAttemptsAfterRetry).toBe(2);
  expect
    .soft(
      retryPromptVisible,
      "Successful cleanup should prompt once for unlock",
    )
    .toBe(true);
  expect.soft(afterDismissal.connected).toBe(false);
  expect.soft(afterDismissal.hasConnectionId).toBe(false);
  expect.soft(afterDismissal.previewRejected).toBe(true);
  expect.soft(afterDismissal.previewCalls).toBe(0);
  expect.soft(afterDismissal.mainLayoutVisible).toBe(false);
  expect.soft(afterDismissal.unlockPromptVisible).toBe(false);
  expect(await commandCount(page, "disconnect")).toBe(2);
});

test("a stale disconnect result cannot clear a newer connection generation", async ({
  page,
}, testInfo) => {
  await openMockListing(page, {
    objectCount: 1,
    prefixes: [],
    holdDisconnect: true,
  });
  const original = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const { state } = await import(stateModule);
    return state.connectionId;
  });

  await page.evaluate(() => {
    const app = window as typeof window & {
      __oldDisconnect?: Promise<boolean>;
    };
    const appConnectionModule = "/app-connection.ts";
    app.__oldDisconnect = import(appConnectionModule).then(
      ({ handleDisconnect }) => handleDisconnect(),
    );
  });
  await expect.poll(() => commandCount(page, "disconnect")).toBe(1);

  await page.evaluate(async () => {
    const appConnectionModule = "/app-connection.ts";
    const { handleConnect, setConnectionInputs } = await import(
      appConnectionModule
    );
    setConnectionInputs(
      "https://new-layout-test.invalid",
      "us-east-1",
      "layout-access-key",
      "layout-secret-key",
      "",
    );
    await handleConnect();
  });
  const newer = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const { state } = await import(stateModule);
    return state.connectionId;
  });
  await releaseMockDisconnect(page);
  await page.evaluate(async () => {
    const app = window as typeof window & {
      __oldDisconnect?: Promise<boolean>;
    };
    await app.__oldDisconnect;
  });

  const stateAfterStaleResult = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const { state } = await import(stateModule);
    return {
      connected: state.connected,
      connectionId: state.connectionId,
      transfersHeldForDisconnect: state.transfersHeldForDisconnect,
      layoutVisible:
        getComputedStyle(document.getElementById("main-layout")!).display !==
        "none",
    };
  });
  await recordStage(page, testInfo, "stale-generation", {
    originalConnectionId: original,
    newerConnectionId: newer,
    stateAfterStaleResult,
  });

  expect(newer).not.toBe(original);
  expect(stateAfterStaleResult.connected).toBe(true);
  expect(stateAfterStaleResult.connectionId).toBe(newer);
  expect(stateAfterStaleResult.transfersHeldForDisconnect).toBe(false);
  expect(stateAfterStaleResult.layoutVisible).toBe(true);
});

test("manual disconnect rejection keeps the current session visible and retryable", async ({
  page,
}, testInfo) => {
  await openMockListing(page, {
    objectCount: 1,
    prefixes: [],
    errors: {
      disconnect: "Timed out while stopping active transfers for disconnect",
    },
  });
  const original = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const { state } = await import(stateModule);
    return state.connectionId;
  });

  await page.locator("#disconnect-btn").click();
  await expect.poll(() => commandCount(page, "disconnect")).toBe(1);
  const observed = await page.evaluate(async () => {
    const stateModule = "/state.ts";
    const { state } = await import(stateModule);
    return {
      connected: state.connected,
      connectionId: state.connectionId,
      layoutVisible:
        getComputedStyle(document.getElementById("main-layout")!).display !==
        "none",
    };
  });
  await recordStage(page, testInfo, "manual-disconnect-rejected", {
    originalConnectionId: original,
    observed,
  });

  expect(observed.connected).toBe(true);
  expect(observed.connectionId).toBe(original);
  expect(observed.layoutVisible).toBe(true);
});
