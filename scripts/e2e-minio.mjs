#!/usr/bin/env node
// Backend E2E: runs the S3 command layer against a real MinIO server.
//
// Starts a throwaway MinIO container, runs the ignored `e2e_` Rust tests in
// src-tauri/src/e2e_minio.rs, and writes test-results/minio-e2e/report.json
// (every check with its observed value, plus the server image and version).
// The container is always removed. Rerun: npm run test:e2e:minio
//
// Needs Docker. Ports 9000 and 19000 must be free on S3_SIDEKICK_E2E_HOST
// (default 127.0.0.1). Port 9000 is detected as MinIO; port 19000 reaches the
// same server through the generic-provider path.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test-results", "minio-e2e");
// Pinned by digest so every run exercises the same server build. Override
// with S3_SIDEKICK_E2E_MINIO_IMAGE to try another release.
const image =
  process.env.S3_SIDEKICK_E2E_MINIO_IMAGE ??
  "bitnamilegacy/minio:2025.5.24-debian-12-r5@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c";
const container = `s3sk-e2e-minio-${process.pid}`;
const bindHost = process.env.S3_SIDEKICK_E2E_HOST?.trim() || "127.0.0.1";
const endpointMinio = `http://${bindHost}:9000`;
const endpointGeneric = `http://${bindHost}:19000`;
const accessKey = "e2eadmin";
const secretKey = "e2eadmin-secret";

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function docker(...args) {
  const result = run("docker", args);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`MinIO did not become healthy at ${url}`);
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const reportLines = path.join(outDir, "checks.jsonl");
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-e2e-appdata-"));
  let testStatus = 1;
  let serverVersion = "";
  let imageDigest = "";
  let containerStarted = false;
  let failure = null;
  try {
    docker("pull", image);
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      `${bindHost}:9000:9000`,
      "-p",
      `${bindHost}:19000:9000`,
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      image,
    );
    containerStarted = true;
    serverVersion = run("docker", ["exec", container, "minio", "--version"])
      .stdout.split("\n")[0]
      .trim();
    imageDigest = docker(
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      image,
    );
    await waitForHealth(`${endpointMinio}/minio/health/live`, 60_000);
    await waitForHealth(`${endpointGeneric}/minio/health/live`, 10_000);

    const cargo = run(
      "cargo",
      [
        "test",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
        "e2e_",
        "--",
        "--ignored",
        "--test-threads=1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          S3_SIDEKICK_E2E_ENDPOINT: endpointMinio,
          S3_SIDEKICK_E2E_GENERIC_ENDPOINT: endpointGeneric,
          S3_SIDEKICK_E2E_ACCESS_KEY: accessKey,
          S3_SIDEKICK_E2E_SECRET_KEY: secretKey,
          S3_SIDEKICK_E2E_REPORT: reportLines,
          S3_SIDEKICK_TEST_APP_DATA: appData,
          // Debug builds keep large command futures on the test thread's
          // stack; the default 2 MiB overflows on prefix operations.
          RUST_MIN_STACK: "33554432",
        },
      },
    );
    fs.writeFileSync(
      path.join(outDir, "cargo-test.log"),
      `${cargo.stdout}\n${cargo.stderr}`,
    );
    process.stdout.write(cargo.stdout);
    testStatus = cargo.status ?? 1;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(path.join(outDir, "cargo-test.log"), `${failure}\n`);
  } finally {
    if (containerStarted) {
      run("docker", ["rm", "-f", container]);
    }
    fs.rmSync(appData, { recursive: true, force: true });
  }

  const checks = fs.existsSync(reportLines)
    ? fs
        .readFileSync(reportLines, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const passed =
    testStatus === 0 && checks.length > 0 && checks.every((c) => c.passed);
  const report = {
    suite: "s3-command-layer-minio",
    server: { image, imageDigest, version: serverVersion },
    endpoints: {
      minio: endpointMinio,
      generic: endpointGeneric,
    },
    ...(failure ? { error: failure } : {}),
    passed,
    checkCount: checks.length,
    checks,
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `\nMinIO E2E: ${passed ? "PASS" : "FAIL"} (cargo exit ${testStatus}, ${checks.filter((c) => c.passed).length}/${checks.length} checks passed) -> ${path.relative(root, path.join(outDir, "report.json"))}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
