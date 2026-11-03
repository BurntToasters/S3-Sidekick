#!/usr/bin/env node
// Windows-only E2E for the main-thread stack reserve. It launches the real
// release exe, keeps it alive past the frontend's first IPC calls, and
// writes test-results/windows-startup/report.json. The launch uses an isolated
// temporary profile and S3_SIDEKICK_TEST_APP_DATA so the real user profile is
// never touched; both are removed on every exit path.
//
// Failure modes, written before the build.rs fix:
// - /STACK never reaches the exe (wrong target check): PE header still 1 MiB.
// - Dispatcher frame outgrows the reserve: exit 0xC00000FD after first invoke.
// - Early exit 0 from single-instance hand-off or setup error must not pass.
// - Stale exe tested: S3_SIDEKICK_EXE is opt-in; otherwise this builds it.
// - A stalled build or app launch must time out instead of hanging CI.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test-results", "windows-startup");
const aliveMs = Number(process.env.S3_SIDEKICK_STARTUP_ALIVE_MS || 20000);
const buildTimeoutMs = Number(
  process.env.S3_SIDEKICK_STARTUP_BUILD_TIMEOUT_MS || 30 * 60 * 1000,
);
const minStackReserve = 8 * 1024 * 1024;
const STATUS_STACK_OVERFLOW = 0xc00000fd;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function writeReport(report) {
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

if (process.platform !== "win32") {
  writeReport({
    suite: "windows-startup",
    status: "not_run",
    passed: false,
    platform: process.platform,
    limitation:
      "Run on Windows; the 1 MiB main-thread default is Windows-only.",
  });
  console.error("This E2E needs Windows.");
  process.exit(2);
}

for (const [name, value] of Object.entries({
  S3_SIDEKICK_STARTUP_ALIVE_MS: aliveMs,
  S3_SIDEKICK_STARTUP_BUILD_TIMEOUT_MS: buildTimeoutMs,
})) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

const profileRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "s3sk-windows-startup-"),
);
const profile = {
  APPDATA: path.join(profileRoot, "roaming"),
  LOCALAPPDATA: path.join(profileRoot, "local"),
  USERPROFILE: profileRoot,
  HOME: profileRoot,
  TEMP: path.join(profileRoot, "temp"),
  TMP: path.join(profileRoot, "temp"),
  S3_SIDEKICK_TEST_APP_DATA: path.join(profileRoot, "app-data"),
};
for (const directory of Object.values(profile)) {
  fs.mkdirSync(directory, { recursive: true });
}

function run(commandLine, cwd) {
  const result = spawnSync(commandLine, {
    cwd,
    stdio: "inherit",
    shell: true,
    timeout: buildTimeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandLine} failed with status ${result.status}`);
  }
}

function stackReserve(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") {
    throw new Error(`${file} is not a PE image`);
  }
  const optional = pe + 24;
  if (buf.readUInt16LE(optional) !== 0x20b) {
    throw new Error(`${file} is not PE32+`);
  }
  return Number(buf.readBigUInt64LE(optional + 72));
}

let child = null;
let report = null;
try {
  let exe = process.env.S3_SIDEKICK_EXE;
  if (!exe) {
    run("npm run build", root);
    run(
      "cargo build --release --features tauri/custom-protocol",
      path.join(root, "src-tauri"),
    );
    exe = path.join(root, "src-tauri", "target", "release", "s3-sidekick.exe");
  }

  const reserve = stackReserve(exe);
  child = spawn(exe, [], {
    env: {
      ...process.env,
      ...profile,
      S3_SIDEKICK_E2E_STARTUP_TRACE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  const started = Date.now();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), aliveMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const elapsedMs = Date.now() - started;
  if (exit === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    child = null;
  }

  const exitCode = exit === null ? null : exit >>> 0;
  const checks = {
    stackReserveAtLeast8MiB: reserve >= minStackReserve,
    aliveForWholeWindow: exit === null,
    noStackOverflow: exitCode !== STATUS_STACK_OVERFLOW,
    setupFinished: log.includes("storage-recovery-finished success=true"),
  };
  const passed = Object.values(checks).every(Boolean);

  fs.writeFileSync(path.join(outDir, "app.log"), log);
  report = {
    suite: "windows-startup",
    status: passed ? "passed" : "failed",
    passed,
    exe,
    profileIsolation:
      "temporary APPDATA/LOCALAPPDATA/TEMP plus S3_SIDEKICK_TEST_APP_DATA",
    exeModified: fs.statSync(exe).mtime.toISOString(),
    stackReserveBytes: reserve,
    aliveWindowMs: aliveMs,
    elapsedMs,
    exitCode: exitCode === null ? null : `0x${exitCode.toString(16)}`,
    checks,
  };
} catch (error) {
  report = {
    suite: "windows-startup",
    status: "failed",
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (child && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
  }
  fs.rmSync(profileRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

writeReport(report);
console.log(
  JSON.stringify({ passed: report.passed, checks: report.checks }, null, 2),
);
process.exit(report.passed ? 0 : 1);
