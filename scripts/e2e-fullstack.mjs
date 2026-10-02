#!/usr/bin/env node
// Full-stack E2E: the real app (webview, IPC access control, Rust backend)
// through tauri-driver against throwaway MinIO. Linux only (WebKitWebDriver).
// Rerun: npm run tauri -- build --debug --no-bundle, then
//   xvfb-run npm run test:e2e:fullstack
// Writes test-results/fullstack/report.json and final.png incrementally.

// Failure modes checked first: runtime capabilities deny required UI commands;
// setup, bucket listing, or folder persistence fails; missing checks still pass;
// real app data changes or MinIO remains; operations exceed their deadlines;
// failure evidence is not saved before cleanup. Session timeouts must capture
// evidence before process stop; diagnostic commands stay bounded, missing tools
// stay visible, and retained driver logs stay capped while reaching CI output.
// A stalled status body stays within the fetch deadline and driver-ready phase.
// HTTP 200 with value.ready=false must poll without premature POST /session.

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
  // CI debug build needs ~36s main-entry to setup on cold fontconfig
  // (main thread blocked in pango_fc_font_map_get_config). Keep 120s.
  120_000,
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
const DRIVER_LOG_MAX_BYTES = 512 * 1024;
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
let driverLogPath;
let driverLogBytes = 0;
let driverLogTruncated = false;
let driverLogWriteError = null;
let sessionDiagnostics = null;

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
    failureDiagnostics: sessionDiagnostics
      ? {
          captured: sessionDiagnostics.captured,
          file: sessionDiagnostics.file ?? null,
          triggerPhase: sessionDiagnostics.triggerPhase,
          commandCount: sessionDiagnostics.commands?.length ?? 0,
          driverLogBytes: sessionDiagnostics.driverLogBytes,
          driverLogTruncated: sessionDiagnostics.driverLogTruncated,
          error: sessionDiagnostics.error ?? null,
        }
      : null,
    missingChecks,
    checks,
    cleanup,
    artifacts: {
      report: "report.json",
      tauriDriverLog:
        driverLogPath && fs.existsSync(driverLogPath)
          ? path.basename(driverLogPath)
          : null,
      sessionDiagnostics: fs.existsSync(
        path.join(outDir, "session-diagnostics.txt"),
      )
        ? "session-diagnostics.txt"
        : null,
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

async function fetchOnce(url, signal, isReady = (response) => response?.ok) {
  const requestController = new AbortController();
  const timer = setTimeout(() => requestController.abort(), FETCH_TIMEOUT_MS);
  const stop = () => requestController.abort();
  let response;
  signal?.addEventListener("abort", stop, { once: true });
  try {
    response = await fetch(url, { signal: requestController.signal });
    return response?.ok && (await isReady(response));
  } catch (error) {
    if (signal?.aborted) throw interruption ?? error;
    return false;
  } finally {
    if (response?.body && !response.bodyUsed) {
      try {
        await response.body.cancel();
      } catch {
        // An abort may already have closed the response body.
      }
    }
    requestController.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

async function waitFor(
  url,
  timeoutMs,
  signal,
  childProcess = undefined,
  isReady = (response) => response?.ok,
) {
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
      if (await fetchOnce(url, signal, isReady)) return;
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

async function webDriverStatusReady(response) {
  try {
    const status = await response.json();
    return status?.value?.ready === true;
  } catch {
    return false;
  }
}

function runDiagnosticCommand(
  command,
  args,
  filterOutput = (output) => output,
  timeoutMs = 600,
) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = filterOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    return {
      command: [command, ...args].join(" "),
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      output: output.slice(0, 24_000),
      truncated: result.error?.code === "ENOBUFS" || output.length > 24_000,
    };
  } catch (error) {
    return {
      command: [command, ...args].join(" "),
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
      output: "",
      truncated: false,
    };
  }
}

function applicationPidFromProcessSnapshot(output, expectedProcessGroup) {
  const applicationName = path.basename(application);
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length >= 7 &&
      fields[5] === applicationName &&
      Number(fields[2]) === expectedProcessGroup
    ) {
      const pid = Number(fields[0]);
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
  }
  return null;
}

function captureSessionDiagnostics(error) {
  const capturedAt = new Date().toISOString();
  const trackedPids = new Set(
    [process.pid, driverProcess?.pid].filter(Number.isInteger).map(String),
  );
  const processPattern =
    /s3-sidekick|tauri-driver|WebKit(?:WebDriver|NetworkProcess|WebProcess)|Xvfb|dbus-daemon/i;
  const filterProcessOutput = (output) =>
    output
      .split("\n")
      .filter(
        (line, index) =>
          index === 0 ||
          trackedPids.has(line.trim().split(/\s+/, 1)[0]) ||
          processPattern.test(line),
      )
      .join("\n");
  const processSnapshot = runDiagnosticCommand(
    "ps",
    ["-eo", "pid,ppid,pgid,stat,etime,comm,args"],
    filterProcessOutput,
  );
  const commands = [
    processSnapshot,
    runDiagnosticCommand("ss", ["-ltnp"]),
    runDiagnosticCommand("xwininfo", ["-root", "-tree"]),
  ];
  if (!testMode && process.platform === "linux") {
    const applicationPid = applicationPidFromProcessSnapshot(
      processSnapshot.output,
      driverProcess?.pid,
    );
    if (applicationPid) {
      commands.push(
        runDiagnosticCommand(
          "sudo",
          [
            "--non-interactive",
            "gdb",
            "--batch",
            "--nx",
            "--quiet",
            "-iex",
            "set auto-load off",
            "-iex",
            "set debuginfod enabled off",
            "-ex",
            "set pagination off",
            "-ex",
            "set width 0",
            "-ex",
            "set print frame-arguments none",
            "-ex",
            "thread 1",
            "-ex",
            "bt 48",
            "-ex",
            "thread apply all bt 12",
            "-p",
            String(applicationPid),
          ],
          undefined,
          8_000,
        ),
      );
    } else {
      commands.push({
        command: "sudo --non-interactive gdb --batch --nx --quiet -p <app-pid>",
        exitCode: null,
        signal: null,
        error:
          "s3-sidekick process not found in the tauri-driver process group",
        output: "",
        truncated: false,
      });
    }
  }

  const profile = {
    DISPLAY: process.env.DISPLAY ?? null,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
    XDG_DATA_HOME: xdgHome ? path.join(xdgHome, "data") : null,
    XDG_CONFIG_HOME: xdgHome ? path.join(xdgHome, "config") : null,
    XDG_CACHE_HOME: xdgHome ? path.join(xdgHome, "cache") : null,
    XDG_STATE_HOME: xdgHome ? path.join(xdgHome, "state") : null,
  };
  const driverLogSize =
    driverLogPath && fs.existsSync(driverLogPath)
      ? fs.statSync(driverLogPath).size
      : 0;
  const detail = {
    capturedAt,
    triggerPhase: currentPhase,
    failure: normalizedError(error, currentPhase),
    runnerPid: process.pid,
    tauriDriverPid: driverProcess?.pid ?? null,
    tauriDriverProcessGroup: driverProcessGroup,
    isolatedXdgProfile: xdgHome ?? null,
    profile,
    driverLog: {
      file: driverLogPath ? path.basename(driverLogPath) : null,
      bytes: driverLogSize,
      truncated: driverLogTruncated,
      writeError: driverLogWriteError,
    },
    commands,
  };
  const contents = [
    `Captured before process cleanup at ${capturedAt}`,
    `Failure: ${detail.failure.kind} during ${detail.failure.phase}: ${detail.failure.message}`,
    `Runner PID: ${detail.runnerPid}`,
    `tauri-driver PID: ${detail.tauriDriverPid ?? "unavailable"}`,
    `tauri-driver process group: ${detail.tauriDriverProcessGroup}`,
    `Isolated XDG profile: ${detail.isolatedXdgProfile ?? "unavailable"}`,
    `Display/profile environment: ${JSON.stringify(profile)}`,
    `tauri-driver log: ${detail.driverLog.file ?? "unavailable"} (${driverLogSize} bytes; truncated=${driverLogTruncated}; writeError=${driverLogWriteError ?? "none"})`,
    ...commands.flatMap((entry) => [
      "",
      `$ ${entry.command}`,
      `exit=${entry.exitCode ?? "unavailable"} signal=${entry.signal ?? "none"} error=${entry.error ?? "none"} truncated=${entry.truncated}`,
      entry.output.trimEnd() || "<no output>",
    ]),
  ];
  const file = "session-diagnostics.txt";
  let writeError = null;
  try {
    fs.writeFileSync(path.join(outDir, file), `${contents.join("\n")}\n`);
  } catch (writeFailure) {
    writeError =
      writeFailure instanceof Error
        ? writeFailure.message
        : String(writeFailure);
  }
  sessionDiagnostics = {
    captured: writeError === null,
    file: writeError === null ? file : null,
    triggerPhase: currentPhase,
    commands: commands.map(
      ({ command, exitCode, signal, error, truncated }) => ({
        command,
        exitCode,
        signal,
        error,
        truncated,
      }),
    ),
    driverLogBytes: driverLogSize,
    driverLogTruncated,
    error: writeError,
  };
  persistReport();
}

async function captureAcceptanceDiagnostics() {
  // Connect submitted but main layout never visible. Record error text,
  // button state, and layout display before cleanup. Bounded, never throws.
  const lines = [`Captured at ${new Date().toISOString()} during acceptance`];
  try {
    const snapshot = await withDeadline(
      driver.executeScript(() => {
        const text = (id) =>
          document.getElementById(id)?.textContent?.trim() ?? "<absent>";
        const display = (id) =>
          document.getElementById(id)?.style?.display ?? "<absent>";
        return {
          formError: text("conn-form-error"),
          connectBtn: text("connect-btn"),
          connectDisabled:
            document.getElementById("connect-btn")?.disabled ?? null,
          connectBusy:
            document.getElementById("connect-btn")?.dataset?.busy ?? null,
          status: text("connection-status"),
          mainLayoutDisplay: display("main-layout"),
          connScreenDisplay: display("connection-screen"),
          endpoint:
            document.getElementById("conn-endpoint")?.value ?? "<absent>",
          url: location.href,
          title: document.title,
        };
      }),
      15_000,
      "acceptance DOM snapshot",
    );
    lines.push(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    lines.push(
      `DOM snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const source = await withDeadline(
      driver.getPageSource(),
      15_000,
      "acceptance page source",
    );
    lines.push(`--- page source (${source.length} chars, first 4000) ---`);
    lines.push(source.slice(0, 4000));
  } catch (error) {
    lines.push(
      `Page source failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.writeFileSync(
      path.join(outDir, "acceptance-failure.txt"),
      `${lines.join("\n")}\n`,
    );
  } catch {
    // Artifact best effort; CI log below still carries the snapshot.
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function forwardDriverOutput(channel, chunk) {
  const output = channel === "stdout" ? process.stdout : process.stderr;
  output.write(chunk);
  if (!driverLogPath || driverLogTruncated || driverLogWriteError) return;

  const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const tagged = Buffer.concat([Buffer.from(`[${channel}] `), content]);
  const remaining = DRIVER_LOG_MAX_BYTES - driverLogBytes;
  if (remaining <= 0) {
    driverLogTruncated = true;
    return;
  }
  const retained = tagged.subarray(0, remaining);
  try {
    fs.appendFileSync(driverLogPath, retained);
    driverLogBytes += retained.length;
    if (retained.length < tagged.length) driverLogTruncated = true;
  } catch (error) {
    driverLogWriteError =
      error instanceof Error ? error.message : String(error);
  }
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
  await type(webDriver, "conn-region", "us-east-1");
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
  driverLogPath = path.join(outDir, "tauri-driver.log");
  fs.writeFileSync(driverLogPath, "");
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(xdgHome, "data"),
        XDG_CONFIG_HOME: path.join(xdgHome, "config"),
        XDG_CACHE_HOME: path.join(xdgHome, "cache"),
        XDG_STATE_HOME: path.join(xdgHome, "state"),
      },
    });
    driverProcess.stdout.on("data", (chunk) =>
      forwardDriverOutput("stdout", chunk),
    );
    driverProcess.stderr.on("data", (chunk) =>
      forwardDriverOutput("stderr", chunk),
    );
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
        webDriverStatusReady,
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
    const caught = interruption ?? error;
    const phase = interruption?.phase ?? currentPhase;
    setFailure(caught, phase);
    const failureDetails = normalizedError(caught, phase);
    if (
      failureDetails.phase === "session-create" &&
      failureDetails.kind === "timeout"
    ) {
      captureSessionDiagnostics(caught);
    }
    if (failureDetails.phase === "acceptance" && driver) {
      await captureAcceptanceDiagnostics();
    }
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
