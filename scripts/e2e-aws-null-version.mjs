#!/usr/bin/env node
// Local protocol E2E for the AWS SDK's handling of a suspended-bucket null
// version. No Docker or cloud credentials are required.

import { spawn, spawnSync } from "node:child_process";
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

function run(command, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceFinish);
      resolve({ status, error, timedOut, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-16 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16 * 1024 * 1024);
    });
    let forceFinish;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          timeout: 5000,
          stdio: "ignore",
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The process group may already have exited. */
        }
      }
      child.kill("SIGKILL");
      forceFinish = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, new Error(`${command} timed out after ${timeoutMs} ms`));
      }, 1000);
    }, timeoutMs);
    child.once("error", (error) => finish(null, error));
    child.once("close", (status) =>
      finish(
        status,
        timedOut
          ? new Error(`${command} timed out after ${timeoutMs} ms`)
          : null,
      ),
    );
  });
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
  let timedOut = false;
  let phase = "setup";

  try {
    const timeoutMs = Number(
      process.env.S3_SIDEKICK_AWS_NULL_TIMEOUT_MS || 15 * 60 * 1000,
    );
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60 * 60 * 1000
    ) {
      throw new Error(
        "S3_SIDEKICK_AWS_NULL_TIMEOUT_MS must be an integer from 100 through 3600000.",
      );
    }
    if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
      phase = "frontend-build";
      const build = await run(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "build"],
        timeoutMs,
        { cwd: root, shell: process.platform === "win32" },
      );
      fs.writeFileSync(
        path.join(outDir, "frontend-build.log"),
        `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
      );
      timedOut = build.timedOut;
      if (build.error) throw build.error;
      if (build.status !== 0) {
        throw new Error(`frontend build failed with exit ${build.status}`);
      }
    }

    phase = "cargo-test";
    const cargo = await run(
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
      timeoutMs,
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
    timedOut = cargo.timedOut;
    if (cargo.error) throw cargo.error;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    fs.appendFileSync(path.join(outDir, "cargo-test.log"), `${failure}\n`);
  } finally {
    try {
      fs.rmSync(appData, { recursive: true, force: true });
    } catch (err) {
      failure = `App-data cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let checks = [];
  try {
    if (fs.existsSync(checksPath)) {
      checks = fs
        .readFileSync(checksPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  } catch (err) {
    failure = `Invalid check artifact: ${err instanceof Error ? err.message : String(err)}`;
  }
  const passed =
    !failure &&
    !timedOut &&
    cargoStatus === 0 &&
    checks.length > 0 &&
    checks.every((check) => check.passed);
  const report = {
    suite: "aws-null-version-local-http-e2e",
    protocol: "real AWS SDK over loopback HTTP into s3::rename_object",
    ...(failure ? { error: failure } : {}),
    passed,
    timedOut,
    phase,
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
