#!/usr/bin/env node
// Failure-first runner E2E uses fake app, Docker/driver processes, local HTTP,
// and isolated outputs; it never starts Docker or opens app data. Timeout
// evidence must exist before process cleanup; native diagnostics stay bounded,
// and missing X11/listener tools remain visible. A `/status` body can stall
// after HTTP 200 headers but must remain inside the fetch deadline. A false
// ready value must delay the sole POST /session until a later true value.
// Malformed or stalled bodies must not poison later polls, and a stalled body
// must close before session creation so no polling socket leaks.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, "scripts", "e2e-fullstack.mjs");
const outDir = path.join(
  root,
  "test-results",
  "fixes-0.11.1",
  "transfer-publication",
  "fullstack-harness",
);
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "s3sk-fullstack-harness-"),
);
const checks = [];
const reports = [];

function record(name, passed, observed = undefined) {
  checks.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

function startHealthServer(mode) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (mode === "health-stall") return;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function writeDockerFixture(file) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.S3_TEST_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run" && process.env.S3_TEST_DOCKER_MODE === "docker-failure") {
  process.stderr.write("injected docker startup failure");
  process.exit(23);
} else if (args[0] === "run" && process.env.S3_TEST_DOCKER_MODE === "docker-stall") {
  setTimeout(() => process.exit(0), 5000);
} else if (args[0] === "run") {
  process.stdout.write("fake-container-id\\n");
  process.exit(0);
} else if (args[0] === "exec") {
  process.stdout.write("smoke-folder\\n");
  process.exit(0);
} else if (args[0] === "rm" && process.env.S3_TEST_DOCKER_MODE === "cleanup-stall") {
  setTimeout(() => process.exit(0), 5000);
} else {
  process.exit(0);
}
`,
  );
  fs.chmodSync(file, 0o755);
}

function writeDriverFixture(file) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
const mode = process.env.S3_TEST_DRIVER_MODE;
const log = process.env.S3_TEST_DRIVER_LOG;
const elements = new Map();
let nextElement = 0;
let statusChecks = 0;
let stalledStatusClosed = false;
if (mode === "session-stall") {
  process.stderr.write("session-stall-driver-marker\\n");
  process.stderr.write("x".repeat(600 * 1024));
}
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  const fakeApp = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: "ignore" },
  );
  fakeApp.once("spawn", () =>
    fs.writeFileSync(process.env.S3_TEST_APP_PID_FILE, String(fakeApp.pid)),
  );
  fs.writeFileSync(process.env.S3_TEST_DRIVER_PID_FILE, String(process.pid));
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2kQAAAAASUVORK5CYII=";
function record(method, url, body) {
  fs.appendFileSync(log, JSON.stringify({ method, url, body }) + "\\n");
}
function reply(response, status, value, headers = {}) {
  const body = JSON.stringify({ value });
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://127.0.0.1");
    const command = body ? JSON.parse(body) : {};
    record(
      request.method,
      request.url,
      JSON.stringify({
        using: command.using,
        value: command.value,
        script: command.script?.slice(0, 80),
        args: command.args,
      }),
    );
    if (url.pathname === "/status") {
      statusChecks += 1;
      if (
        mode === "status-body-stall" ||
        (mode === "status-body-stall-once" && statusChecks === 1)
      ) {
        response.once("close", () => {
          stalledStatusClosed = true;
          record("EVENT", "/status-body-closed", "");
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        return;
      }
      if (mode === "status-malformed-once" && statusChecks === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{malformed");
        return;
      }
      const ready =
        mode === "status-not-ready"
          ? statusChecks >= 4
          : mode === "status-body-stall-once"
            ? stalledStatusClosed
            : true;
      return reply(response, 200, {
        ready,
        message: ready ? "" : "native WebDriver is starting",
      });
    }
    if (request.method === "POST" && url.pathname === "/session") {
      if (mode === "status-not-ready" && statusChecks < 4) {
        return reply(response, 500, {
          error: "unknown error",
          message: "fixture rejects session before status readiness",
        });
      }
      if (mode === "status-body-stall-once" && !stalledStatusClosed) {
        return reply(response, 500, {
          error: "unknown error",
          message: "fixture rejects session while stalled status body is open",
        });
      }
      if (mode === "session-stall") return;
      return reply(response, 200, { sessionId: "fixture-session", capabilities: { browserName: "wry" } });
    }
    if (
      mode === "driver-stall" &&
      request.method === "POST" &&
      (url.pathname.endsWith("/elements") || url.pathname.endsWith("/element"))
    ) {
      setTimeout(
        () =>
          reply(response, 200, [
            { "element-6066-11e4-a52e-4f735466cecf": "late-element" },
          ]),
        5000,
      );
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/elements")) {
      const selector = JSON.parse(body || "{}").value || "";
      if (mode === "incomplete" && selector.includes("connect-btn")) {
        return reply(response, 200, []);
      }
      const element = "fixture-element-" + nextElement++;
      elements.set(element, selector);
      return reply(response, 200, [{ "element-6066-11e4-a52e-4f735466cecf": element }]);
    }
    if (request.method === "POST" && url.pathname.endsWith("/element")) {
      const selector = JSON.parse(body || "{}").value || "";
      if (mode === "incomplete" && selector.includes("connect-btn")) {
        return reply(response, 404, { error: "no such element", message: "injected missing connect button", stacktrace: "" });
      }
      const element = "fixture-element-" + nextElement++;
      elements.set(element, selector);
      return reply(response, 200, { "element-6066-11e4-a52e-4f735466cecf": element });
    }
    if (request.method === "GET" && url.pathname.endsWith("/displayed")) {
      const element = url.pathname.split("/").at(-2);
      return reply(response, 200, !elements.get(element)?.includes("setup-wizard-overlay"));
    }
    if (request.method === "POST" && url.pathname.endsWith("/execute/sync")) {
      const element = command.args?.[0];
      const elementId =
        element?.["element-6066-11e4-a52e-4f735466cecf"] ?? element?.ELEMENT;
      return reply(
        response,
        200,
        !elements.get(elementId)?.includes("setup-wizard-overlay"),
      );
    }
    if (request.method === "GET" && url.pathname.endsWith("/selected")) return reply(response, 200, false);
    if (request.method === "GET" && url.pathname.endsWith("/screenshot")) {
      if (mode === "driver-stall") return;
      return reply(response, 200, png);
    }
    if (request.method === "DELETE" && url.pathname.endsWith("/session/fixture-session") && mode === "cleanup-stall") return;
    if (request.method === "DELETE" && url.pathname.endsWith("/session/fixture-session")) return reply(response, 200, null);
    return reply(response, 200, null);
  });
});
server.listen(Number(process.env.S3_TEST_DRIVER_PORT), "127.0.0.1");
`,
  );
  fs.chmodSync(file, 0o755);
}

function spawnRunner(env) {
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    output: () => ({ stdout, stderr }),
    close: async ({ timeoutMs = 6000, onTimeout = undefined } = {}) => {
      let watchdogFired = false;
      const timeout = setTimeout(() => {
        watchdogFired = true;
        child.kill("SIGKILL");
        onTimeout?.();
      }, timeoutMs);
      const result = await closed;
      clearTimeout(timeout);
      return { ...result, stdout, stderr, watchdogFired };
    },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function runCase(name, mode, options = {}) {
  const startedAt = Date.now();
  const caseRoot = path.join(fixtureRoot, name);
  fs.mkdirSync(caseRoot, { recursive: true });
  const app = path.join(caseRoot, "fake-app");
  fs.writeFileSync(app, "throwaway app marker\n");
  const docker = path.join(caseRoot, "docker-fixture.mjs");
  const driver = path.join(caseRoot, "tauri-driver-fixture.mjs");
  const dockerLog = path.join(caseRoot, "docker.jsonl");
  const driverLog = path.join(caseRoot, "driver.jsonl");
  const driverPidFile = path.join(caseRoot, "driver.pid");
  const appPidFile = path.join(caseRoot, "app.pid");
  const caseOut = path.join(outDir, name);
  fs.mkdirSync(caseOut, { recursive: true });
  fs.writeFileSync(dockerLog, "");
  fs.writeFileSync(driverLog, "");
  writeDockerFixture(docker);
  writeDriverFixture(driver);

  const health = await startHealthServer(mode);
  const driverPort = await unusedPort();
  const configuredDriver = options.missingDriver
    ? path.join(caseRoot, "missing-driver")
    : driver;
  const env = {
    S3_SIDEKICK_FULLSTACK_TEST_MODE: "1",
    S3_SIDEKICK_FULLSTACK_APP_PATH: app,
    S3_SIDEKICK_FULLSTACK_OUT_DIR: caseOut,
    S3_SIDEKICK_FULLSTACK_DOCKER_BIN: docker,
    S3_SIDEKICK_FULLSTACK_DRIVER_BIN: configuredDriver,
    S3_SIDEKICK_FULLSTACK_ENDPOINT: health.endpoint,
    S3_SIDEKICK_FULLSTACK_WEBDRIVER_URL: `http://127.0.0.1:${driverPort}`,
    S3_SIDEKICK_FULLSTACK_TEST_TIMEOUT_MS: String(options.timeoutMs ?? 240),
    S3_SIDEKICK_FULLSTACK_SESSION_TIMEOUT_MS: String(
      options.sessionTimeoutMs ?? 240,
    ),
    S3_SIDEKICK_FULLSTACK_DRIVER_READY_TIMEOUT_MS: String(
      options.driverReadyTimeoutMs ?? 240,
    ),
    S3_SIDEKICK_FULLSTACK_ACCEPTANCE_TIMEOUT_MS: String(
      options.acceptanceTimeoutMs ?? options.timeoutMs ?? 240,
    ),
    S3_SIDEKICK_FULLSTACK_HEALTH_TIMEOUT_MS: "360",
    S3_SIDEKICK_FULLSTACK_FETCH_TIMEOUT_MS: "70",
    S3_SIDEKICK_FULLSTACK_CLEANUP_TIMEOUT_MS: "700",
    S3_SIDEKICK_FULLSTACK_COMMAND_TIMEOUT_MS: "600",
    S3_SIDEKICK_FULLSTACK_POLL_MS: "10",
    S3_TEST_DOCKER_MODE: mode,
    S3_TEST_DOCKER_LOG: dockerLog,
    S3_TEST_DRIVER_MODE: mode,
    S3_TEST_DRIVER_LOG: driverLog,
    S3_TEST_DRIVER_PID_FILE: driverPidFile,
    S3_TEST_APP_PID_FILE: appPidFile,
    S3_TEST_DRIVER_PORT: String(driverPort),
  };
  const run = spawnRunner(env);

  if (options.cancelWhenDriverCommand) {
    const commandSeen = await waitFor(() =>
      fs.readFileSync(driverLog, "utf8").includes("/element"),
    );
    if (commandSeen) run.child.kill("SIGTERM");
  }

  let pendingCleanupReport = null;
  let pendingCleanupRequestSeen = false;
  if (options.observePendingCleanup) {
    pendingCleanupRequestSeen = await waitFor(() =>
      fs.readFileSync(driverLog, "utf8").includes('"method":"DELETE"'),
    );
    if (pendingCleanupRequestSeen) {
      try {
        pendingCleanupReport = JSON.parse(
          fs.readFileSync(path.join(caseOut, "report.json"), "utf8"),
        );
      } catch {
        pendingCleanupReport = null;
      }
    }
  }

  let processTreePids = null;
  if (options.verifyProcessTreeStopped) {
    const pidsWritten = await waitFor(
      () => fs.existsSync(driverPidFile) && fs.existsSync(appPidFile),
    );
    if (pidsWritten) {
      processTreePids = {
        driver: Number(fs.readFileSync(driverPidFile, "utf8")),
        app: Number(fs.readFileSync(appPidFile, "utf8")),
      };
    }
  }
  const emergencyKill = () => {
    for (const pid of Object.values(processTreePids ?? {})) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  };
  const closed = await run.close({
    timeoutMs: options.verifyProcessTreeStopped ? 2500 : 6000,
    onTimeout: emergencyKill,
  });
  const processTreeStopped = processTreePids
    ? Object.values(processTreePids).every((pid) => !isPidAlive(pid))
    : null;
  const driverRequests = fs
    .readFileSync(driverLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const statusRequestCount = driverRequests.filter(
    (request) => request.method === "GET" && request.url === "/status",
  ).length;
  const sessionRequests = driverRequests.filter(
    (request) => request.method === "POST" && request.url === "/session",
  );
  const statusBodyCloseEvents = driverRequests.filter(
    (request) =>
      request.method === "EVENT" && request.url === "/status-body-closed",
  );
  const firstSessionIndex = driverRequests.indexOf(sessionRequests[0]);
  const firstStatusBodyCloseIndex = driverRequests.indexOf(
    statusBodyCloseEvents[0],
  );
  const statusBodyClosedBeforeFirstSession =
    firstStatusBodyCloseIndex >= 0 &&
    firstSessionIndex >= 0 &&
    firstStatusBodyCloseIndex < firstSessionIndex;
  const statusRequestsBeforeFirstSession =
    sessionRequests.length === 0
      ? statusRequestCount
      : driverRequests
          .slice(0, driverRequests.indexOf(sessionRequests[0]))
          .filter(
            (request) => request.method === "GET" && request.url === "/status",
          ).length;
  closed.elapsedMs = Date.now() - startedAt;
  health.close();
  let report = null;
  try {
    report = JSON.parse(
      fs.readFileSync(path.join(caseOut, "report.json"), "utf8"),
    );
  } catch (error) {
    report = {
      passed: false,
      missing: "report.json",
      observed: error instanceof Error ? error.message : String(error),
    };
  }
  reports.push({
    name,
    exitCode: closed.code,
    signal: closed.signal,
    report,
    pendingCleanupReport,
    pendingCleanupRequestSeen,
    processTreePids,
    processTreeStopped,
    statusRequestCount,
    sessionRequestCount: sessionRequests.length,
    statusRequestsBeforeFirstSession,
    statusBodyCloseEventCount: statusBodyCloseEvents.length,
    statusBodyClosedBeforeFirstSession,
    watchdogFired: closed.watchdogFired,
  });
  fs.writeFileSync(
    path.join(caseOut, "runner.log"),
    `${closed.stdout}${closed.stderr}`,
  );
  fs.copyFileSync(dockerLog, path.join(caseOut, "docker-fixture.jsonl"));
  fs.copyFileSync(driverLog, path.join(caseOut, "driver-fixture.jsonl"));
  if (options.expect) {
    const valid = options.expect(report, closed, {
      pendingCleanupReport,
      pendingCleanupRequestSeen,
      processTreePids,
      processTreeStopped,
      statusRequestCount,
      sessionRequestCount: sessionRequests.length,
      statusRequestsBeforeFirstSession,
      statusBodyCloseEventCount: statusBodyCloseEvents.length,
      statusBodyClosedBeforeFirstSession,
    });
    record(name, valid, {
      exitCode: closed.code,
      signal: closed.signal,
      elapsedMs: closed.elapsedMs,
      phase: report.failure?.phase,
      checkCount: report.checkCount,
      missingChecks: report.missingChecks,
      cleanup: report.cleanup,
      pendingCleanupPassed: pendingCleanupReport?.passed,
      processTreeStopped,
      statusRequestCount,
      sessionRequestCount: sessionRequests.length,
      statusRequestsBeforeFirstSession,
      statusBodyCloseEventCount: statusBodyCloseEvents.length,
      statusBodyClosedBeforeFirstSession,
      watchdogFired: closed.watchdogFired,
    });
  }
  return report;
}

try {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await runCase("docker-failure", "docker-failure", {
    expect: (report, closed) =>
      closed.code === 1 &&
      report.passed === false &&
      report.failure?.phase === "docker-start" &&
      Array.isArray(report.checks),
  });

  await runCase("docker-command-stall", "docker-stall", {
    expect: (report, closed) =>
      closed.code === 1 &&
      report.failure?.phase === "docker-start" &&
      report.timedOut,
  });

  await runCase("health-fetch-stall", "health-stall", {
    expect: (report, closed) =>
      closed.code === 1 &&
      report.failure?.phase === "minio-ready" &&
      report.timedOut &&
      fs.existsSync(path.join(outDir, "health-fetch-stall", "report.json")),
  });

  await runCase("driver-spawn-failure", "happy", {
    missingDriver: true,
    expect: (report, closed) =>
      closed.code === 1 &&
      report.failure?.phase === "driver-ready" &&
      report.failure?.kind === "spawn" &&
      fs.existsSync(path.join(outDir, "driver-spawn-failure", "report.json")),
  });

  await runCase("status-not-ready", "status-not-ready", {
    timeoutMs: 2500,
    expect: (report, closed, observation) =>
      closed.code === 0 &&
      report.passed === true &&
      observation.statusRequestCount >= 4 &&
      observation.statusRequestsBeforeFirstSession >= 4 &&
      observation.sessionRequestCount === 1,
  });

  await runCase("status-body-stall", "status-body-stall", {
    timeoutMs: 1200,
    driverReadyTimeoutMs: 240,
    expect: (report, closed, observation) =>
      closed.code === 1 &&
      closed.elapsedMs < 1500 &&
      report.passed === false &&
      report.failure?.kind === "timeout" &&
      report.failure?.phase === "driver-ready" &&
      report.failureDiagnostics === null &&
      observation.statusRequestCount >= 2 &&
      observation.sessionRequestCount === 0,
  });

  await runCase("status-malformed-once-recovers", "status-malformed-once", {
    timeoutMs: 1200,
    driverReadyTimeoutMs: 500,
    expect: (report, closed, observation) =>
      closed.code === 0 &&
      report.passed === true &&
      observation.statusRequestCount === 2 &&
      observation.sessionRequestCount === 1,
  });

  await runCase("status-body-stall-once-recovers", "status-body-stall-once", {
    timeoutMs: 1200,
    driverReadyTimeoutMs: 500,
    expect: (report, closed, observation) =>
      closed.code === 0 &&
      report.passed === true &&
      observation.statusRequestCount >= 2 &&
      observation.sessionRequestCount === 1 &&
      observation.statusBodyCloseEventCount === 1 &&
      observation.statusBodyClosedBeforeFirstSession === true,
  });

  await runCase("session-create-timeout-diagnostics", "session-stall", {
    timeoutMs: 1200,
    sessionTimeoutMs: 240,
    expect: (report, closed, observation) => {
      const caseOut = path.join(outDir, "session-create-timeout-diagnostics");
      const driverArtifact = path.join(caseOut, "tauri-driver.log");
      const diagnosticsArtifact = path.join(caseOut, "session-diagnostics.txt");
      return (
        closed.code === 1 &&
        report.passed === false &&
        report.failure?.kind === "timeout" &&
        report.failure?.phase === "session-create" &&
        report.failureDiagnostics?.captured === true &&
        report.failureDiagnostics?.commandCount === 3 &&
        report.failureDiagnostics?.driverLogTruncated === true &&
        report.failureDiagnostics?.driverLogBytes === 512 * 1024 &&
        report.artifacts?.tauriDriverLog === "tauri-driver.log" &&
        report.artifacts?.sessionDiagnostics === "session-diagnostics.txt" &&
        observation.sessionRequestCount === 1 &&
        fs.existsSync(driverArtifact) &&
        fs.statSync(driverArtifact).size === 512 * 1024 &&
        fs
          .readFileSync(driverArtifact, "utf8")
          .includes("session-stall-driver-marker") &&
        fs.existsSync(diagnosticsArtifact) &&
        fs
          .readFileSync(diagnosticsArtifact, "utf8")
          .includes("tauri-driver-fixture.mjs") &&
        fs
          .readFileSync(path.join(caseOut, "runner.log"), "utf8")
          .includes("session-stall-driver-marker")
      );
    },
  });

  await runCase("driver-command-stall", "driver-stall", {
    expect: (report, closed) =>
      closed.code === 1 &&
      report.timedOut &&
      report.failure?.phase === "acceptance" &&
      Array.isArray(report.cleanup) &&
      closed.elapsedMs < 5500 &&
      fs.existsSync(path.join(outDir, "driver-command-stall", "report.json")),
  });

  await runCase("cleanup-stall", "cleanup-stall", {
    timeoutMs: 2500,
    observePendingCleanup: true,
    expect: (report, closed, observation) =>
      closed.code === 1 &&
      report.passed === false &&
      report.checkCount === 5 &&
      report.cleanup?.some((entry) => entry.timedOut) &&
      closed.elapsedMs < 4500 &&
      observation.pendingCleanupRequestSeen &&
      observation.pendingCleanupReport?.checkCount === 5 &&
      observation.pendingCleanupReport?.cleanup?.length === 1 &&
      observation.pendingCleanupReport?.passed === false,
  });

  await runCase("incomplete-checks", "incomplete", {
    timeoutMs: 1000,
    expect: (report, closed) =>
      closed.code === 1 &&
      report.checkCount === 1 &&
      report.missingChecks?.length === 4 &&
      report.failure?.phase === "acceptance",
  });

  await runCase("signal-cancellation", "driver-stall", {
    cancelWhenDriverCommand: true,
    expect: (report, closed) =>
      closed.code === 1 &&
      report.failure?.kind === "cancelled" &&
      report.cleanup?.length >= 1 &&
      fs.existsSync(path.join(outDir, "signal-cancellation", "report.json")),
  });

  await runCase("driver-ignores-sigterm", "ignore-term", {
    timeoutMs: 2500,
    verifyProcessTreeStopped: true,
    expect: (report, closed, observation) =>
      closed.code === 0 &&
      !closed.watchdogFired &&
      report.passed === true &&
      report.cleanup?.some(
        (entry) => entry.name === "tauri-driver process stop" && entry.passed,
      ) &&
      observation.processTreeStopped === true,
  });

  await runCase("mocked-success", "happy", {
    timeoutMs: 2500,
    expect: (report, closed) =>
      closed.code === 0 &&
      report.passed === true &&
      report.checkCount === 5 &&
      report.missingChecks?.length === 0,
  });

  const passed = checks.length === 15 && checks.every((check) => check.passed);
  const report = {
    suite: "fullstack-harness-failure-artifacts",
    passed,
    fixtureIsolation:
      "temporary directories, fake app, fake processes, local HTTP only",
    checkCount: checks.length,
    checks,
    scenarios: reports.map(
      ({
        name,
        exitCode,
        signal,
        elapsedMs,
        report: scenario,
        pendingCleanupReport,
        processTreeStopped,
        watchdogFired,
      }) => ({
        name,
        exitCode,
        signal,
        elapsedMs,
        passed: scenario.passed,
        phase: scenario.failure?.phase ?? null,
        checkCount: scenario.checkCount ?? 0,
        pendingCleanupPassed: pendingCleanupReport?.passed ?? null,
        processTreeStopped,
        watchdogFired,
      }),
    ),
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  const failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify({ suite: "fullstack-harness-failure-artifacts", passed: false, failure, checks, scenarios: reports }, null, 2)}\n`,
  );
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
