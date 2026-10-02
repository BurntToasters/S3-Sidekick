#!/usr/bin/env node
// Runs S3 move-safety regressions through the real AWS SDK and production
// receipt-copy/deletion paths against deterministic loopback HTTP fixtures.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test-results", "move-safety-e2e");
const checksPath = path.join(outDir, "checks.jsonl");
const testName = "e2e_minio::e2e_move_safety_receipts_http_fixture";
const requiredChecks = [
  "ambiguous multipart recovery survives JSON receipt round trip and cannot delete the source",
  "JSON-null source version claim cannot retire a live suspended-bucket null version",
  "missing HEAD version header triggers a live bucket-versioning check and refuses suspended-bucket deletion",
  "denied bucket-versioning lookup names the needed permission and refuses source deletion",
  "normal unversioned copy receipt still permits a matching move and retains the copied destination",
];

fs.mkdirSync(outDir, { recursive: true });
for (const name of ["checks.jsonl", "cargo-test.log", "report.json"]) {
  fs.rmSync(path.join(outDir, name), { force: true });
}
fs.writeFileSync(checksPath, "");

const cargo = spawnSync(
  "cargo",
  [
    "test",
    "--locked",
    "--manifest-path",
    path.join(root, "src-tauri", "Cargo.toml"),
    testName,
    "--",
    "--ignored",
    "--exact",
    "--test-threads=1",
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      S3_SIDEKICK_E2E_REPORT: checksPath,
    },
  },
);
const output = `${cargo.stdout ?? ""}${cargo.stderr ?? ""}`;
fs.writeFileSync(path.join(outDir, "cargo-test.log"), output);

let checks = [];
let reportError = null;
try {
  checks = fs
    .readFileSync(checksPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (error) {
  reportError = error instanceof Error ? error.message : String(error);
}

const passed =
  !cargo.error &&
  cargo.status === 0 &&
  checks.length === requiredChecks.length &&
  new Set(checks.map((check) => check.check)).size === requiredChecks.length &&
  requiredChecks.every((name) =>
    checks.some((check) => check.check === name && check.passed),
  );
const checkNames = checks.map((check) => check.check);
const missingChecks = requiredChecks.filter((name) => !checkNames.includes(name));
const duplicateChecks = checkNames.filter(
  (name, index) => checkNames.indexOf(name) !== index,
);
const report = {
  suite: "move-safety-receipt-loopback-e2e",
  passed,
  fixture: "real AWS SDK over loopback HTTP; no Docker or cloud credentials",
  testName,
  exitCode: cargo.status ?? null,
  timedOut: cargo.error?.code === "ETIMEDOUT",
  failure: cargo.error?.message ?? reportError,
  expectedChecks: requiredChecks,
  missingChecks,
  duplicateChecks,
  checkCount: checks.length,
  checks,
};
fs.writeFileSync(
  path.join(outDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(output);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
