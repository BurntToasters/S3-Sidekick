#!/usr/bin/env node
// Runs an ignored native E2E against a local HTTP fixture. The fixture drops a
// committed multipart response, then returns 412 to the completion retry.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(
  root,
  "test-results",
  "fixes-0.11.1",
  "transfer-publication",
  "multipart-recovery",
);
const reportPath = path.join(outDir, "checks.jsonl");
const testName =
  "e2e_multipart_lost_response_uses_ownership_marker_independent_of_checksum_mode";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(reportPath, "");

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    path.join(root, "src-tauri", "Cargo.toml"),
    "--bin",
    "s3-sidekick",
    testName,
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      S3_SIDEKICK_MULTIPART_E2E_REPORT: reportPath,
    },
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
fs.writeFileSync(path.join(outDir, "cargo-test.log"), output);
let checks = [];
try {
  checks = fs
    .readFileSync(reportPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (error) {
  checks = [
    {
      name: "E2E report was readable",
      passed: false,
      observed: error instanceof Error ? error.message : String(error),
    },
  ];
}
const passed =
  !result.error &&
  result.status === 0 &&
  checks.length === 3 &&
  checks.every((check) => check.passed);
const report = {
  suite: "multipart-lost-response-recovery",
  passed,
  fixture: "local HTTP S3 protocol fixture; no Docker or cloud credentials",
  testName,
  exitCode: result.status ?? null,
  timedOut: result.error?.code === "ETIMEDOUT",
  failure: result.error?.message ?? null,
  checkCount: checks.length,
  checks,
};
fs.writeFileSync(
  path.join(outDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
