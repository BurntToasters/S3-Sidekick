#!/usr/bin/env node
// Full-stack E2E: the real app (webview, IPC access control, Rust backend)
// through tauri-driver against throwaway MinIO. Linux only (WebKitWebDriver).
// Rerun: npm run tauri -- build --debug --no-bundle, then
//   xvfb-run npm run test:e2e:fullstack
// Writes test-results/fullstack/report.json and final.png incrementally.

// Failure modes checked before implementation: capabilities deny a command
// the UI needs (only the real runtime shows it); first-run setup cannot finish;
// the real client cannot list buckets; a folder create never reaches the
// server; a silent step still passes (every check recorded, incomplete sets
// fail); the run touches real app data or leaves MinIO running; a driver,
// screenshot, quit, Docker, or fetch operation outlives its own deadline; a
// failure/cancellation is not saved before cleanup begins.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By, until } from "selenium-webdriver";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testMode = process.env.S3_SIDEKICK_FULLSTACK_TEST_MODE === "1";
const testValue = (name, fallback) => {
  if (!testMode) return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const testOverride = (name, fallback) =>
  testMode && process.env[name] ? process.env[name] : fallback;
const outDir =
  (testMode && process.env.S3_SIDEKICK_FULLSTACK_OUT_DIR) ||
  path.join(root, "test-results", "fullstack");
const application =
  (testMode && process.env.S3_SIDEKICK_FULLSTACK_APP_PATH) ||
  path.join(root, "src-tauri", "target", "debug", "s3-sidekick");
const image =
  process.env.S3_SIDEKICK_E2E_MINIO_IMAGE ??
  "bitnamilegacy/minio:2025.5.24-debian-12-r5@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c";
const container = `s3sk-fullstack-minio-${process.pid}`;
const endpoint = testOverride(
  "S3_SIDEKICK_FULLSTACK_ENDPOINT",
  "http://127.0.0.1:9000",
);
const webDriverUrl = testOverride(
  "S3_SIDEKICK_FULLSTACK_WEBDRIVER_URL",
  "http://127.0.0.1:4444/",
);
const dockerBin = testOverride("S3_SIDEKICK_FULLSTACK_DOCKER_BIN", "docker");
const driverBin = testOverride(
  "S3_SIDEKICK_FULLSTACK_DRIVER_BIN",
  "tauri-driver",
);
const accessKey = "e2eadmin";
const secretKey = "e2eadmin-secret";
const bucket = "s3sk-fullstack";
const folder = "smoke-folder";
const CHECK_NAMES = [
  "first-run setup completes",
  "connects to MinIO through the real backend",
  "lists the seeded bucket",
  "created folder appears in the listing",
  "folder marker reached the server",
];
const EXPECTED_CHECKS = CHECK_NAMES.length;
const STEP_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_TEST_TIMEOUT_MS",
  30_000,
);
const ACCEPTANCE_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_ACCEPTANCE_TIMEOUT_MS",
  EXPECTED_CHECKS * STEP_TIMEOUT_MS + 5_000,
);
const SESSION_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_SESSION_TIMEOUT_MS",
  30_000,
);
const DRIVER_READY_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_DRIVER_READY_TIMEOUT_MS",
  30_000,
);
const HEALTH_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_HEALTH_TIMEOUT_MS",
  60_000,
);
const FETCH_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_FETCH_TIMEOUT_MS",
  2_000,
);
const COMMAND_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_COMMAND_TIMEOUT_MS",
  30_000,
);
const CLEANUP_TIMEOUT_MS = testValue(
  "S3_SIDEKICK_FULLSTACK_CLEANUP_TIMEOUT_MS",
  10_000,
);
const POLL_INTERVAL_MS = testValue("S3_SIDEKICK_FULLSTACK_POLL_MS", 500);
const checks = [];
const cleanup = [];
const abortController = new AbortController();
const reportPath = path.join(outDir, "report.json");
let currentPhase = "initialization";
let failure = null;
let interruption = null;
let driverProcess;
let driver;
let driverProcessGroup = false;
let dockerLaunchAttempted = false;
let xdgHome;
let cleanupComplete = false;

function normalizedError(error, phase = currentPhase) {
  if (error && typeof error === "object" && error.kind && error.phase) {
    return {
      kind: error.kind,
      phase: error.phase,
      message: error.message ?? String(error),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const kind =
    error?.name === "TimeoutError" || error?.code === "ETIMEDOUT"
      ? "timeout"
      : "failure";
  return { kind, phase, message };
}

function persistReport() {
  const missingChecks = CHECK_NAMES.filter(
    (name) => !checks.some((entry) => entry.name === name),
  );
  const cleanupPassed = cleanup.every((entry) => entry.passed);
  const passed =
    failure === null &&
    cleanupComplete &&
    checks.length === EXPECTED_CHECKS &&
    missingChecks.length === 0 &&
    checks.every((entry) => entry.passed) &&
    cleanupPassed;
  const report = {
    suite: "fullstack-real-app",
    passed,
    phase: currentPhase,
    failure,
    timedOut: failure?.kind === "timeout",
    image,
    testMode,
    checkCount: checks.length,
    expectedCheckCount: EXPECTED_CHECKS,
    cleanupComplete,
    missingChecks,
    checks,
    cleanup,
    artifacts: {
      report: "report.json",
      screenshot: fs.existsSync(path.join(outDir, "final.png"))
        ? "final.png"
        : null,
    },
  };
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporaryPath, reportPath);
  return report;
}

function setFailure(error, phase = currentPhase) {
  if (failure === null || error?.kind === "cancelled") {
    failure = normalizedError(error, phase);
  }
  persistReport();
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} exceeded ${timeoutMs} ms`);
  error.kind = "timeout";
  error.phase = currentPhase;
  return error;
}

function withDeadline(operation, timeoutMs, label, signal = undefined) {
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
  });
  const stopped = signal
    ? new Promise((_, reject) => {
        abortHandler = () =>
          reject(interruption ?? new Error("Full-stack E2E cancelled"));
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      })
    : new Promise(() => {});
  return Promise.race([Promise.resolve(operation), timeout, stopped]).finally(
    () => {
      clearTimeout(timer);
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    },
  );
}

function requestCancellation(signalName) {
  if (interruption !== null) return;
  interruption = new Error(`Full-stack E2E cancelled by ${signalName}`);
  interruption.kind = "cancelled";
  interruption.phase = currentPhase;
  setFailure(interruption, currentPhase);
  abortController.abort();
}

process.on("SIGTERM", () => requestCancellation("SIGTERM"));
process.on("SIGINT", () => requestCancellation("SIGINT"));

function check(name, passed, observed = undefined) {
  checks.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
  persistReport();
  if (!passed) {
    const error = new Error(`check failed: ${name}`);
    error.kind = "acceptance";
    error.phase = currentPhase;
    throw error;
  }
}

function docker(...args) {
  const result = spawnSync(dockerBin, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    const error = new Error(
      result.error.code === "ETIMEDOUT"
        ? `docker ${args[0]} timed out after ${COMMAND_TIMEOUT_MS} ms`
        : `docker ${args[0]} could not run: ${result.error.message}`,
    );
    error.kind = result.error.code === "ETIMEDOUT" ? "timeout" : "spawn";
    error.phase = currentPhase;
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `docker ${args[0]} failed${result.signal ? ` (${result.signal})` : ""}: ${
        result.stderr?.trim() || `exit status ${result.status}`
      }`,
    );
    error.kind = "command";
    error.phase = currentPhase;
    throw error;
  }
  return result.stdout.trim();
}

async function fetchOnce(url, signal) {
  const requestController = new AbortController();
  const timer = setTimeout(() => requestController.abort(), FETCH_TIMEOUT_MS);
  const stop = () => requestController.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    return await fetch(url, { signal: requestController.signal });
  } catch (error) {
    if (signal?.aborted) throw interruption ?? error;
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

async function waitFor(url, timeoutMs, signal, childProcess = undefined) {
  const poll = async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw interruption ?? new Error("E2E cancelled");
      if (childProcess && childProcess.exitCode !== null) {
        const error = new Error(
          `tauri-driver exited before ${url} became ready (status ${childProcess.exitCode})`,
        );
        error.kind = "spawn";
        error.phase = currentPhase;
        throw error;
      }
      const response = await fetchOnce(url, signal);
      if (response?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const error = new Error(
      `${url} did not become ready within ${timeoutMs} ms`,
    );
    error.kind = "timeout";
    error.phase = currentPhase;
    throw error;
  };
  return withDeadline(
    poll(),
    timeoutMs + FETCH_TIMEOUT_MS,
    `waiting for ${url}`,
    signal,
  );
}

async function click(webDriver, id) {
  const element = await webDriver.wait(
    until.elementLocated(By.id(id)),
    STEP_TIMEOUT_MS,
  );
  await webDriver.wait(until.elementIsVisible(element), STEP_TIMEOUT_MS);
  await element.click();
}

async function type(webDriver, id, value) {
  const element = await webDriver.wait(
    until.elementLocated(By.id(id)),
    STEP_TIMEOUT_MS,
  );
  await element.clear();
  await element.sendKeys(value);
}

async function run(webDriver) {
  // First run: skip encryption and automatic update checks.
  await click(webDriver, "setup-welcome-next");
  await click(webDriver, "setup-theme-next");
  await click(webDriver, "setup-enc-skip");
  const autoUpdates = await webDriver.wait(
    until.elementLocated(By.id("setup-auto-updates")),
    STEP_TIMEOUT_MS,
  );
  if (await autoUpdates.isSelected()) await autoUpdates.click();
  await click(webDriver, "setup-updates-next");
  await click(webDriver, "setup-done-btn");
  const overlay = await webDriver.findElement(By.id("setup-wizard-overlay"));
  await webDriver.wait(until.elementIsNotVisible(overlay), STEP_TIMEOUT_MS);
  check("first-run setup completes", true);

  await type(webDriver, "conn-endpoint", endpoint);
  await type(webDriver, "conn-access-key", accessKey);
  await type(webDriver, "conn-secret-key", secretKey);
  await click(webDriver, "connect-btn");
  const layout = await webDriver.wait(
    until.elementLocated(By.id("main-layout")),
    STEP_TIMEOUT_MS,
  );
  await webDriver.wait(until.elementIsVisible(layout), STEP_TIMEOUT_MS);
  check("connects to MinIO through the real backend", true);

  const bucketButton = await webDriver.wait(
    until.elementLocated(
      By.xpath(
        `//*[@id="bucket-list"]//*[contains(@class,"list__item-btn")][contains(normalize-space(.),"${bucket}")]`,
      ),
    ),
    STEP_TIMEOUT_MS,
  );
  check("lists the seeded bucket", true, bucket);
  await bucketButton.click();

  await click(webDriver, "btn-new-folder");
  await type(webDriver, "dialog-input", folder);
  await click(webDriver, "dialog-ok");
  await webDriver.wait(
    until.elementLocated(By.css(`tr[data-prefix="${folder}/"]`)),
    STEP_TIMEOUT_MS,
  );
  check("created folder appears in the listing", true, `${folder}/`);

  const stored = docker(
    "exec",
    container,
    "sh",
    "-c",
    `ls /bitnami/minio/data/${bucket}`,
  );
  check("folder marker reached the server", stored.includes(folder), stored);
}

async function cleanupStep(name, operation, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const started = Date.now();
  try {
    await withDeadline(operation(), timeoutMs, name);
    cleanup.push({ name, passed: true, durationMs: Date.now() - started });
  } catch (error) {
    const normalized = normalizedError(error, "cleanup");
    cleanup.push({
      name,
      passed: false,
      timedOut: normalized.kind === "timeout",
      durationMs: Date.now() - started,
      error: normalized.message,
    });
    if (failure === null) {
      failure = {
        kind: normalized.kind === "timeout" ? "timeout" : "cleanup",
        phase: "cleanup",
        message: normalized.message,
      };
    }
  }
  persistReport();
}

function waitForChildExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalDriverProcessTree(signal) {
  if (!driverProcess?.pid) return;
  if (driverProcessGroup) {
    try {
      process.kill(-driverProcess.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  if (driverProcess.exitCode === null && driverProcess.signalCode === null) {
    driverProcess.kill(signal);
  }
}

async function waitForDriverProcessTreeExit(timeoutMs) {
  if (!driverProcess) return;
  if (!driverProcessGroup || !driverProcess.pid) {
    return withDeadline(
      waitForChildExit(driverProcess),
      timeoutMs,
      "waiting for tauri-driver process exit",
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(driverProcess.pid)) {
    if (Date.now() >= deadline) {
      throw timeoutError(
        "waiting for tauri-driver process group exit",
        timeoutMs,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopDriverProcessTree() {
  if (!driverProcess) return;
  const gracefulTimeoutMs = Math.max(1, Math.floor(CLEANUP_TIMEOUT_MS / 2));
  const forceTimeoutMs = Math.max(1, CLEANUP_TIMEOUT_MS - gracefulTimeoutMs);
  signalDriverProcessTree("SIGTERM");
  try {
    await waitForDriverProcessTreeExit(gracefulTimeoutMs);
    return;
  } catch (error) {
    if (error?.kind !== "timeout") throw error;
  }

  signalDriverProcessTree("SIGKILL");
  await waitForDriverProcessTreeExit(forceTimeoutMs);
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  persistReport();

  try {
    if (
      testMode &&
      (!process.env.S3_SIDEKICK_FULLSTACK_APP_PATH ||
        !process.env.S3_SIDEKICK_FULLSTACK_OUT_DIR)
    ) {
      throw new Error(
        "Harness test mode requires isolated app and output paths.",
      );
    }
    if (!testMode && process.platform !== "linux") {
      throw new Error(
        "The full-stack E2E needs Linux (tauri-driver + WebKitWebDriver).",
      );
    }
    if (!fs.existsSync(application)) {
      throw new Error(
        `App binary missing: ${application}. Run: npm run tauri -- build --debug --no-bundle`,
      );
    }

    // Isolated XDG profile roots keep Linux app state out of the developer's
    // normal profile during this throwaway run.
    xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-fullstack-"));
    currentPhase = "docker-start";
    persistReport();
    dockerLaunchAttempted = true;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      endpoint.endsWith(":9000")
        ? "127.0.0.1:9000:9000"
        : `${new URL(endpoint).host}:9000:9000`,
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      "-e",
      `MINIO_DEFAULT_BUCKETS=${bucket}`,
      image,
    );

    currentPhase = "minio-ready";
    persistReport();
    await waitFor(
      `${endpoint}/minio/health/live`,
      HEALTH_TIMEOUT_MS,
      abortController.signal,
    );

    currentPhase = "driver-start";
    persistReport();
    driverProcessGroup = process.platform !== "win32";
    driverProcess = spawn(driverBin, [], {
      detached: driverProcessGroup,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(xdgHome, "data"),
        XDG_CONFIG_HOME: path.join(xdgHome, "config"),
        XDG_CACHE_HOME: path.join(xdgHome, "cache"),
        XDG_STATE_HOME: path.join(xdgHome, "state"),
      },
    });
    const driverSpawnFailure = new Promise((_, reject) => {
      driverProcess.once("error", (error) => {
        error.kind = "spawn";
        error.phase = "driver-ready";
        reject(error);
      });
    });
    currentPhase = "driver-ready";
    persistReport();
    await Promise.race([
      waitFor(
        `${webDriverUrl.replace(/\/$/, "")}/status`,
        DRIVER_READY_TIMEOUT_MS,
        abortController.signal,
        driverProcess,
      ),
      driverSpawnFailure,
    ]);

    currentPhase = "session-create";
    persistReport();
    driver = await withDeadline(
      new Builder()
        .usingServer(`${webDriverUrl.replace(/\/$/, "")}/`)
        .withCapabilities({
          browserName: "wry",
          "tauri:options": { application },
        })
        .build(),
      SESSION_TIMEOUT_MS,
      "WebDriver session creation",
      abortController.signal,
    );

    currentPhase = "acceptance";
    persistReport();
    await withDeadline(
      run(driver),
      ACCEPTANCE_TIMEOUT_MS,
      "full-stack acceptance checks",
      abortController.signal,
    );
  } catch (error) {
    setFailure(interruption ?? error, interruption?.phase ?? currentPhase);
  } finally {
    if (driver) {
      await cleanupStep("WebDriver screenshot", async () => {
        const png = await driver.takeScreenshot();
        fs.writeFileSync(path.join(outDir, "final.png"), png, "base64");
      });
      await cleanupStep("WebDriver quit", () => driver.quit());
    }
    if (driverProcess) {
      await cleanupStep(
        "tauri-driver process stop",
        stopDriverProcessTree,
        CLEANUP_TIMEOUT_MS + 250,
      );
    }
    if (dockerLaunchAttempted) {
      currentPhase = "cleanup";
      await cleanupStep("MinIO container removal", async () => {
        docker("rm", "-f", container);
      });
    }
    if (xdgHome) {
      await cleanupStep("isolated app profile removal", async () => {
        fs.rmSync(xdgHome, { recursive: true, force: true });
      });
    }
    cleanupComplete = true;
    persistReport();
  }

  const missingChecks = CHECK_NAMES.filter(
    (name) => !checks.some((entry) => entry.name === name),
  );
  if (failure === null && missingChecks.length > 0) {
    const error = new Error(
      `Acceptance checks incomplete: expected ${EXPECTED_CHECKS}, recorded ${checks.length}`,
    );
    error.kind = "incomplete";
    error.phase = "acceptance";
    setFailure(error, "acceptance");
  }
  const report = persistReport();
  process.stdout.write(
    `\nFull-stack E2E: ${report.passed ? "PASS" : "FAIL"} (${checks.filter((entry) => entry.passed).length}/${EXPECTED_CHECKS})${failure ? `: ${failure.message}` : ""}\n`,
  );
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  setFailure(error);
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
