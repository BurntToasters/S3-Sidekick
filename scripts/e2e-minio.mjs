#!/usr/bin/env node
// Backend E2E: runs the S3 command layer against a real MinIO server.
//
// Starts a throwaway MinIO container, runs only the ignored Rust tests in
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

// Every check name the Rust suite must emit. A partial run, a renamed check, or
// an empty report is a failure, not a pass with fewer assertions.
const EXPECTED_CHECKS = Object.freeze([
  "localhost:9000 is MinIO: create-only PUT, no CopyObject create-only, no multipart completion",
  "another loopback port is a generic provider with no create-only guarantees",
  "listing returns 'a b.txt' and 'a+b.txt' as two distinct keys",
  "folder prefixes 'x y/' and 'x+y/' are listed as written",
  "UploadPartCopy accepts a matching copy-source-if-match",
  "UploadPartCopy refuses a stale copy-source-if-match",
  "delete of 'a b.txt' removes it and leaves 'a+b.txt' untouched",
  "delete_prefix('x y/') removes that folder and keeps 'x+y/'",
  "copy_prefix_to writes 'report final.txt', not 'report+final.txt'",
  "MinIO creates a folder with a create-only PUT",
  "creating an existing folder create-only reports 'already exists'",
  "generic provider refuses a create-only folder with 'cannot enforce a create-only'",
  "the authorized (unconditional) retry creates the folder",
  "prefix move copy phase refuses before destination mutation without conditional DELETE",
  "generic rename_prefix refuses an unsupported conditional move and leaves the source intact",
  "explicit overwrite does not authorize an unsafe automatic source delete",
  "discarding scratch for a destination whose folder is gone succeeds (recovery is not blocked)",
  "a cancel arriving before registration rejects the transfer and commits no object",
  "no copy receipt exists that can authorize rollback of the external objects",
  "the pinned MinIO server ignores a stale If-Match DELETE after external replacement",
  "automatic object-move copy refuses before mutation when conditional DELETE is unverified",
  "rename_object refuses before destination mutation when conditional DELETE is unverified",
  "explicit overwrite copy replaces an existing destination without deleting its source",
  "receipt-backed source deletion is refused on MinIO and retains the source",
  "MinIO suspended write is copyable and rename refuses safely with its reported version identity",
  "ordinary copy can still read and copy the current null version",
  "ordinary copy receipt cannot authorize source deletion on the actual MinIO provider route",
  "real AWS SDK HEAD parses literal null and rename refuses before any mutation request",
  "a conflict already present on later source B prevents deletion of source A",
  "unversioned overwrite prefix refuses before any destination or backup mutation when conditional DELETE is unsupported",
  "a later source failure restores both originals and removes operation-owned backup versions",
  "a 3 MiB image is returned whole, byte-for-byte, with truncated false",
  "a 2 MiB text/plain object is cut to its first 1 MiB and flagged truncated",
  "MinIO refuses create-only CopyObject against an absent destination before mutation",
  "MinIO refuses create-only CopyObject against an different destination before mutation",
  "MinIO refuses create-only CopyObject against an identical destination before mutation",
  "ambiguous multipart recovery survives JSON receipt round trip and cannot delete the source",
  "JSON-null source version claim cannot retire a live suspended-bucket null version",
  "missing HEAD version header triggers a live bucket-versioning check and refuses suspended-bucket deletion",
  "denied bucket-versioning lookup names the needed permission and refuses source deletion",
  "normal unversioned copy receipt still permits a matching move and retains the copied destination",
]);

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    ...options,
  });
}

function docker(...args) {
  const options = typeof args.at(-1) === "object" ? args.pop() : {};
  const result = run("docker", args, options);
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
    docker("pull", image, { timeout: 10 * 60 * 1000 });
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
      { timeout: 2 * 60 * 1000 },
    );
    containerStarted = true;
    serverVersion = run("docker", ["exec", container, "minio", "--version"], {
      timeout: 60_000,
    })
      .stdout.split("\n")[0]
      .trim();
    imageDigest = docker(
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      image,
      { timeout: 60_000 },
    );
    await waitForHealth(`${endpointMinio}/minio/health/live`, 60_000);
    await waitForHealth(`${endpointGeneric}/minio/health/live`, 10_000);

    const cargo = run(
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
        "e2e_minio::",
        "--",
        "--ignored",
        "--test-threads=1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 45 * 60 * 1000,
        killSignal: "SIGKILL",
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
      run("docker", ["rm", "-f", container], { timeout: 60_000 });
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
  const expected = new Set(EXPECTED_CHECKS);
  const seen = new Map();
  for (const check of checks) {
    if (typeof check?.check === "string") {
      seen.set(check.check, (seen.get(check.check) ?? 0) + 1);
    }
  }
  const missingChecks = EXPECTED_CHECKS.filter((name) => !seen.has(name));
  const unexpectedChecks = [...seen.keys()].filter(
    (name) => !expected.has(name),
  );
  const duplicateChecks = [...seen.entries()]
    .filter(([, count]) => count !== 1)
    .map(([name]) => name);
  const passed =
    testStatus === 0 &&
    checks.length === EXPECTED_CHECKS.length &&
    missingChecks.length === 0 &&
    unexpectedChecks.length === 0 &&
    duplicateChecks.length === 0 &&
    checks.every((c) => c.passed === true);
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
    expectedCheckCount: EXPECTED_CHECKS.length,
    missingChecks,
    unexpectedChecks,
    duplicateChecks,
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
