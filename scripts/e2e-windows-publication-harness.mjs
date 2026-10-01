#!/usr/bin/env node
// Failure modes considered before building the wrapper harness:
// an exact native test name must pass; the former stale name and a near-match
// must stay missing; a FAILED line must fail even if cargo exits 0; missing
// tests and a nonzero cargo exit must fail the report; and a non-Windows
// production invocation must stop before running cargo. Fixture runs use an
// isolated copied runner and fake cargo process, so they cannot touch app data.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, "scripts", "e2e-windows-publication.mjs");
const outDir = path.join(
  root,
  "test-results",
  "fixes-0.11.1",
  "transfer-publication",
  "windows-publication-harness",
);
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "s3sk-windows-publication-harness-"),
);
const expected = [
  "publish_move_consumed_temp_keeps_the_successful_destination",
  "publish_hard_link_path_retains_source_until_cleanup",
  "publish_copy_fallback_preserves_create_only_bytes",
  "publish_existing_destination_is_preserved_and_temp_is_retained_for_checkpoint",
  "publish_copy_error_cleans_its_reservation",
  "publish_sync_error_removes_destination_and_retains_checkpoint",
];
const checks = [];
const scenarios = [];

function record(name, passed, observed = undefined) {
  checks.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

function makeCargoFixture(caseRoot, output, exitCode) {
  const outputPath = path.join(caseRoot, "cargo-output.log");
  const callsPath = path.join(caseRoot, "cargo-calls.jsonl");
  const fixturePath = path.join(caseRoot, "cargo-fixture.mjs");
  fs.writeFileSync(outputPath, output);
  fs.writeFileSync(
    fixturePath,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `process.stdout.write(fs.readFileSync(${JSON.stringify(outputPath)}, "utf8"));\n` +
      `process.exitCode = ${Number(exitCode)};\n`,
  );
  return { outputPath, callsPath, fixturePath };
}

function spawnCaptured(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    close(timeoutMs = 10_000) {
      let watchdogFired = false;
      const timer = setTimeout(() => {
        watchdogFired = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      return closed
        .finally(() => clearTimeout(timer))
        .then((result) => ({
          ...result,
          stdout,
          stderr,
          watchdogFired,
        }));
    },
  };
}

function passingOutput(overrides = {}) {
  const names = expected.map((name) => overrides[name] ?? [name, "ok"]);
  return [
    ...names.map(([name, status]) => `test tests::${name} ... ${status}`),
    "",
    "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 167 filtered out; finished in 0.02s",
    "",
  ].join("\n");
}

async function runCase(name, output, exitCode, expect) {
  const caseRoot = path.join(fixtureRoot, name);
  const caseOut = path.join(outDir, name);
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.mkdirSync(caseOut, { recursive: true });
  const cargo = makeCargoFixture(caseRoot, output, exitCode);
  const run = spawnCaptured(process.execPath, [runner], {
    cwd: root,
    env: {
      ...process.env,
      S3_SIDEKICK_WINDOWS_PUBLICATION_TEST_MODE: "1",
      S3_SIDEKICK_WINDOWS_PUBLICATION_OUT_DIR: caseOut,
      S3_SIDEKICK_WINDOWS_PUBLICATION_CARGO_FIXTURE: cargo.fixturePath,
    },
  });
  const closed = await run.close();
  let report = null;
  try {
    report = JSON.parse(
      fs.readFileSync(path.join(caseOut, "report.json"), "utf8"),
    );
  } catch (error) {
    report = { passed: false, missingReport: String(error) };
  }
  fs.writeFileSync(
    path.join(caseOut, "runner.log"),
    `${closed.stdout}${closed.stderr}`,
  );
  const calls = fs.existsSync(cargo.callsPath)
    ? fs
        .readFileSync(cargo.callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
    : [];
  const invocation = calls[0] ? JSON.parse(calls[0]) : null;
  const actual = expect(report, closed, invocation, calls.length);
  const observed = {
    exitCode: closed.code,
    watchdogFired: closed.watchdogFired,
    passed: report.passed,
    testCount: report.testCount,
    tests: report.tests,
    cargoInvocationCount: calls.length,
  };
  scenarios.push({ name, ...observed });
  record(name, actual, observed);
}

async function runNonWindowsGateCase() {
  const name = "production-platform-gate";
  const caseRoot = path.join(fixtureRoot, name);
  const copiedRepo = path.join(caseRoot, "repo");
  const copiedScripts = path.join(copiedRepo, "scripts");
  const caseOut = path.join(outDir, name);
  fs.mkdirSync(copiedScripts, { recursive: true });
  fs.mkdirSync(caseOut, { recursive: true });
  fs.copyFileSync(
    runner,
    path.join(copiedScripts, "e2e-windows-publication.mjs"),
  );
  const env = { ...process.env };
  delete env.S3_SIDEKICK_WINDOWS_PUBLICATION_TEST_MODE;
  delete env.S3_SIDEKICK_WINDOWS_PUBLICATION_OUT_DIR;
  delete env.S3_SIDEKICK_WINDOWS_PUBLICATION_CARGO_FIXTURE;
  const run = spawnCaptured(
    process.execPath,
    [path.join(copiedScripts, "e2e-windows-publication.mjs")],
    { cwd: copiedRepo, env },
  );
  const closed = await run.close();
  const gateReportPath = path.join(
    copiedRepo,
    "test-results",
    "fixes-0.11.1",
    "transfer-publication",
    "windows-publication",
    "report.json",
  );
  const report = JSON.parse(fs.readFileSync(gateReportPath, "utf8"));
  fs.copyFileSync(gateReportPath, path.join(caseOut, "report.json"));
  fs.writeFileSync(
    path.join(caseOut, "runner.log"),
    `${closed.stdout}${closed.stderr}`,
  );
  const passed =
    closed.code === 2 &&
    report.status === "not_run" &&
    report.platform === process.platform &&
    report.exercisedRealMoveFileW === false;
  const observed = {
    exitCode: closed.code,
    status: report.status,
    platform: report.platform,
    exercisedRealMoveFileW: report.exercisedRealMoveFileW,
  };
  scenarios.push({ name, ...observed });
  record(name, passed, observed);
}

try {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const allPassing = passingOutput();
  await runCase(
    "exact-native-test-names-pass",
    allPassing,
    0,
    (report, closed, invocation, calls) =>
      closed.code === 0 &&
      !closed.watchdogFired &&
      report.passed === true &&
      report.testMode === true &&
      report.exercisedRealMoveFileW === false &&
      report.testCount === 6 &&
      report.tests.every((test) => test.passed) &&
      calls === 1 &&
      invocation?.[0] === "test" &&
      invocation?.includes("--locked") === true &&
      invocation?.includes("publish_") === true,
  );

  const oldName =
    "publish_copy_error_cleans_reservation_and_retains_checkpoint";
  await runCase(
    "old-stale-name-stays-missing",
    passingOutput({
      publish_copy_error_cleans_its_reservation: [oldName, "ok"],
    }),
    0,
    (report, closed) =>
      closed.code === 1 &&
      report.passed === false &&
      report.tests.find(
        (test) => test.name === "publish_copy_error_cleans_its_reservation",
      )?.passed === false,
  );

  await runCase(
    "near-match-stays-missing",
    passingOutput({
      publish_copy_error_cleans_its_reservation: [
        "publish_copy_error_cleans_its_reservation_extra",
        "ok",
      ],
    }),
    0,
    (report, closed) =>
      closed.code === 1 &&
      report.passed === false &&
      report.tests.find(
        (test) => test.name === "publish_copy_error_cleans_its_reservation",
      )?.passed === false,
  );

  await runCase(
    "failed-native-test-fails-report",
    passingOutput({
      publish_copy_error_cleans_its_reservation: [
        "publish_copy_error_cleans_its_reservation",
        "FAILED",
      ],
    }),
    0,
    (report, closed) =>
      closed.code === 1 &&
      report.passed === false &&
      report.tests.some(
        (test) =>
          test.name === "publish_copy_error_cleans_its_reservation" &&
          test.passed === false,
      ),
  );

  const omittedOutput = passingOutput().replace(
    "test tests::publish_copy_error_cleans_its_reservation ... ok\n",
    "",
  );
  await runCase(
    "missing-native-test-fails-report",
    omittedOutput,
    0,
    (report, closed) =>
      closed.code === 1 &&
      report.passed === false &&
      report.tests.find(
        (test) => test.name === "publish_copy_error_cleans_its_reservation",
      )?.passed === false,
  );

  await runCase(
    "nonzero-cargo-exit-fails-report",
    allPassing,
    23,
    (report, closed) =>
      closed.code === 1 &&
      report.exitCode === 23 &&
      report.passed === false &&
      report.tests.every((test) => test.passed),
  );

  if (process.platform !== "win32") await runNonWindowsGateCase();

  const expectedChecks = process.platform === "win32" ? 6 : 7;
  const passed =
    checks.length === expectedChecks && checks.every((check) => check.passed);
  const report = {
    suite: "windows-publication-runner-failure-artifacts",
    passed,
    fixtureIsolation:
      "fake cargo process, copied runner for platform gate, temporary directories only",
    nativeWindowsProof:
      "not provided by this fixture harness; real MoveFileW coverage remains gated to the Windows publication E2E",
    checkCount: checks.length,
    checks,
    scenarios,
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
    `${JSON.stringify(
      {
        suite: "windows-publication-runner-failure-artifacts",
        passed: false,
        fixtureIsolation:
          "fake cargo process, copied runner for platform gate, temporary directories only",
        failure,
        checks,
        scenarios,
      },
      null,
      2,
    )}\n`,
  );
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
