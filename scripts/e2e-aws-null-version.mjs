#!/usr/bin/env node
// Local protocol E2E for the AWS SDK's handling of a suspended-bucket null
// version. No Docker or cloud credentials are required.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.env.S3_SIDEKICK_E2E_ARTIFACT_DIR
  ? path.resolve(root, process.env.S3_SIDEKICK_E2E_ARTIFACT_DIR)
  : path.join(root, "test-results", "aws-null-version-e2e");
const manifest = path.join(root, "src-tauri", "Cargo.toml");
const testFilter =
  "e2e_minio::e2e_aws_null_version_http_fixture_refuses_rename";
const appData = fs.mkdtempSync(
  path.join(os.tmpdir(), "s3sk-null-version-appdata-"),
);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of [
    "checks.jsonl",
    "cargo-test.log",
    "frontend-build.log",
    "report.json",
  ]) {
    fs.rmSync(path.join(outDir, name), { force: true });
  }
  const checksPath = path.join(outDir, "checks.jsonl");
  let cargoStatus = 1;
  let failure = null;

  try {
    if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
      const build = run("npm", ["run", "build"], { cwd: root });
      fs.writeFileSync(
        path.join(outDir, "frontend-build.log"),
        `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
      );
      if (build.status !== 0) {
        throw new Error(`frontend build failed with exit ${build.status}`);
      }
    }

    const cargo = run(
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        manifest,
        testFilter,
        "--",
        "--ignored",
        "--exact",
        "--test-threads=1",
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          S3_SIDEKICK_E2E_REPORT: checksPath,
          S3_SIDEKICK_TEST_APP_DATA: appData,
          RUST_MIN_STACK: "33554432",
        },
      },
    );
    fs.writeFileSync(
      path.join(outDir, "cargo-test.log"),
      `${cargo.stdout ?? ""}\n${cargo.stderr ?? ""}`,
    );
    process.stdout.write(cargo.stdout ?? "");
    process.stderr.write(cargo.stderr ?? "");
    cargoStatus = cargo.status ?? 1;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(path.join(outDir, "cargo-test.log"), `${failure}\n`);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }

  const checks = fs.existsSync(checksPath)
    ? fs
        .readFileSync(checksPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const passed =
    cargoStatus === 0 &&
    checks.length > 0 &&
    checks.every((check) => check.passed);
  const report = {
    suite: "aws-null-version-local-http-e2e",
    protocol: "real AWS SDK over loopback HTTP into s3::rename_object",
    ...(failure ? { error: failure } : {}),
    passed,
    cargoStatus,
    checkCount: checks.length,
    checks,
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `\nAWS null-version E2E: ${passed ? "PASS" : "FAIL"} (${checks.filter((check) => check.passed).length}/${checks.length} checks passed) -> ${path.relative(root, path.join(outDir, "report.json"))}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
