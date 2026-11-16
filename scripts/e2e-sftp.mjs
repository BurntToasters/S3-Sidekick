#!/usr/bin/env node
// Backend E2E: runs the SFTP connect flow against a real OpenSSH server.
//
// Builds the test-only OpenSSH container in tests/sftp, starts it with five sshd
// instances on loopback ports, runs only the ignored Rust tests in
// src-tauri/src/e2e_sftp, and writes test-results/sftp-e2e/report.json (every
// check with its observed value, plus the base image, the server build, and the
// fingerprint of the server key). The container is always removed.
// Rerun: npm run test:e2e:sftp
//
// Needs Docker and ssh-keygen. Ports 12222 to 12226 must be free on
// S3_SIDEKICK_E2E_HOST (default 127.0.0.1).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test-results", "sftp-e2e");
const contextDir = path.join(root, "tests", "sftp");
const expectedDir = path.join(contextDir, "expected-checks");
// Pinned by digest. The Dockerfile's FROM line must name the same digest, and
// the runner refuses to start when they differ.
const BASE_IMAGE =
  "debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc";
const IMAGE_TAG = "s3sk-e2e-sftp:local";
const container = `s3sk-e2e-sftp-${process.pid}`;
const bindHost = process.env.S3_SIDEKICK_E2E_HOST?.trim() || "127.0.0.1";
const ports = {
  main: 12222,
  rsa: 12223,
  alt: 12224,
  partial: 12225,
  nolink: 12226,
};
const user = "e2e-sftp";

// Every check name the Rust suite must emit: the union of the three manifests.
// A partial run, a renamed check, or an empty report is a failure.
function loadExpectedChecks() {
  const names = [];
  for (const suite of ["connect", "fs", "transfer"]) {
    const file = path.join(expectedDir, `${suite}.json`);
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Array.isArray(list) ||
      !list.every((name) => typeof name === "string" && name.length > 0)
    ) {
      throw new Error(`${suite}.json must be an array of check names`);
    }
    names.push(...list);
  }
  if (new Set(names).size !== names.length) {
    throw new Error("expected-checks manifests contain a duplicate check name");
  }
  if (names.length === 0) {
    throw new Error("expected-checks manifests are empty");
  }
  return names;
}

const EXPECTED_CHECKS = Object.freeze(loadExpectedChecks());

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

function requireBaseImageInDockerfile() {
  const dockerfile = fs.readFileSync(
    path.join(contextDir, "Dockerfile"),
    "utf8",
  );
  if (!dockerfile.includes(`FROM ${BASE_IMAGE}`)) {
    throw new Error(
      "tests/sftp/Dockerfile FROM line does not match BASE_IMAGE in scripts/e2e-sftp.mjs",
    );
  }
}

// Read the first line an endpoint sends. sshd greets with its version string
// before anything else, so this proves the daemon is listening and speaking SSH.
function readBanner(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = "";
    const finish = () => {
      socket.destroy();
      resolve(data.split("\n")[0] ?? "");
    };
    socket.setTimeout(2000, finish);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) finish();
    });
    socket.on("error", () => resolve(""));
    socket.on("close", finish);
  });
}

async function waitForSshd(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const banner = await readBanner(host, port);
    if (banner.startsWith("SSH-2.0-OpenSSH")) return banner.trim();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`sshd did not answer on ${host}:${port}`);
}

// Client keys are generated fresh for each run, in a temporary directory that
// is removed afterwards. The passphrase is random too.
function generateClientKeys(dir, passphrase) {
  const keygen = (args) => {
    const result = run("ssh-keygen", ["-q", ...args], { timeout: 60_000 });
    if (result.status !== 0) {
      throw new Error(`ssh-keygen ${args[0]} failed: ${result.stderr.trim()}`);
    }
  };
  const comment = "s3sk-e2e";
  keygen([
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    comment,
    "-f",
    path.join(dir, "id_ed25519"),
  ]);
  keygen([
    "-t",
    "ecdsa",
    "-b",
    "256",
    "-N",
    "",
    "-C",
    comment,
    "-f",
    path.join(dir, "id_ecdsa"),
  ]);
  keygen([
    "-t",
    "ed25519",
    "-N",
    passphrase,
    "-C",
    comment,
    "-f",
    path.join(dir, "id_ed25519_enc"),
  ]);
  keygen([
    "-t",
    "rsa",
    "-b",
    "2048",
    "-N",
    "",
    "-C",
    comment,
    "-f",
    path.join(dir, "id_rsa"),
  ]);
  // A PuTTY header is enough for the refusal check; the body is never parsed.
  fs.writeFileSync(
    path.join(dir, "fake.ppk"),
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: s3sk-e2e\nPublic-Lines: 2\n",
  );
  const authorized = ["id_ed25519", "id_ecdsa", "id_ed25519_enc"]
    .map((name) =>
      fs.readFileSync(path.join(dir, `${name}.pub`), "utf8").trim(),
    )
    .join("\n");
  fs.writeFileSync(path.join(dir, "authorized_keys"), `${authorized}\n`);
}

async function main() {
  requireBaseImageInDockerfile();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const reportLines = path.join(outDir, "checks.jsonl");
  const appData = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3sk-e2e-sftp-appdata-"),
  );
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-e2e-sftp-keys-"));
  const password = crypto.randomBytes(18).toString("base64url");
  const passphrase = crypto.randomBytes(18).toString("base64url");
  let testStatus = 1;
  let containerStarted = false;
  let failure = null;
  let imageId = "";
  let opensshVersion = "";
  let opensshPackage = "";
  let hostKeyFingerprint = "";
  try {
    generateClientKeys(keyDir, passphrase);
    docker("build", "--tag", IMAGE_TAG, contextDir, {
      timeout: 15 * 60 * 1000,
    });
    imageId = docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG, {
      timeout: 60_000,
    });
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      `${bindHost}:${ports.main}:${ports.main}`,
      "-p",
      `${bindHost}:${ports.rsa}:${ports.rsa}`,
      "-p",
      `${bindHost}:${ports.alt}:${ports.alt}`,
      "-p",
      `${bindHost}:${ports.partial}:${ports.partial}`,
      "-p",
      `${bindHost}:${ports.nolink}:${ports.nolink}`,
      "-e",
      `E2E_SFTP_USER=${user}`,
      "-e",
      `E2E_SFTP_PASSWORD=${password}`,
      IMAGE_TAG,
      { timeout: 2 * 60 * 1000 },
    );
    containerStarted = true;
    for (const port of Object.values(ports)) {
      await waitForSshd(bindHost, port, 90_000);
    }
    opensshVersion = (
      run("docker", ["exec", container, "ssh", "-V"], { timeout: 60_000 })
        .stderr ?? ""
    )
      .split("\n")[0]
      .trim();
    // The base image is pinned by digest, but the package comes from the Debian
    // archive at build time, so the report records the exact build that ran.
    opensshPackage = (
      run(
        "docker",
        [
          "exec",
          container,
          "dpkg-query",
          "-W",
          "-f=${Package} ${Version}",
          "openssh-server",
        ],
        { timeout: 60_000 },
      ).stdout ?? ""
    ).trim();

    // The authorized keys are installed after sshd is up, because the entrypoint
    // creates the test user and its .ssh directory before it starts the daemons.
    docker(
      "cp",
      path.join(keyDir, "authorized_keys"),
      `${container}:/tmp/e2e-authorized_keys`,
    );
    docker(
      "exec",
      container,
      "install",
      "-m",
      "600",
      "-o",
      user,
      "-g",
      user,
      "/tmp/e2e-authorized_keys",
      `/home/${user}/.ssh/authorized_keys`,
      { timeout: 60_000 },
    );

    // The expected fingerprint comes from ssh-keygen on the server's public key
    // file, not from the code under test.
    const mainPubPath = path.join(keyDir, "main_ed25519.pub");
    const mainPub = docker(
      "exec",
      container,
      "cat",
      "/etc/ssh/e2e/main_ed25519.pub",
      {
        timeout: 60_000,
      },
    );
    fs.writeFileSync(mainPubPath, `${mainPub}\n`);
    const fingerprintLine = run("ssh-keygen", ["-lf", mainPubPath], {
      timeout: 60_000,
    });
    hostKeyFingerprint =
      (fingerprintLine.stdout ?? "").trim().split(/\s+/)[1] ?? "";
    if (!hostKeyFingerprint.startsWith("SHA256:")) {
      throw new Error(
        "ssh-keygen did not report a SHA256 fingerprint for the server key",
      );
    }

    const cargo = run(
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        path.join(root, "src-tauri", "Cargo.toml"),
        "e2e_sftp::",
        "--",
        "--ignored",
        "--test-threads=1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        timeout: 45 * 60 * 1000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          S3_SIDEKICK_E2E_SFTP_HOST: bindHost,
          S3_SIDEKICK_E2E_SFTP_PORT_MAIN: String(ports.main),
          S3_SIDEKICK_E2E_SFTP_PORT_RSA: String(ports.rsa),
          S3_SIDEKICK_E2E_SFTP_PORT_ALT: String(ports.alt),
          S3_SIDEKICK_E2E_SFTP_PORT_PARTIAL: String(ports.partial),
          S3_SIDEKICK_E2E_SFTP_PORT_NOLINK: String(ports.nolink),
          S3_SIDEKICK_E2E_SFTP_USER: user,
          S3_SIDEKICK_E2E_SFTP_PASSWORD: password,
          S3_SIDEKICK_E2E_SFTP_PASSPHRASE: passphrase,
          S3_SIDEKICK_E2E_SFTP_KEY_DIR: keyDir,
          S3_SIDEKICK_E2E_SFTP_MAIN_HOST_KEY: mainPub,
          S3_SIDEKICK_E2E_SFTP_MAIN_FINGERPRINT: hostKeyFingerprint,
          S3_SIDEKICK_E2E_SFTP_CONTAINER: container,
          S3_SIDEKICK_E2E_REPORT: reportLines,
          S3_SIDEKICK_TEST_APP_DATA: appData,
          // Debug builds keep large connect futures on the test thread's stack.
          RUST_MIN_STACK: "33554432",
        },
      },
    );
    fs.writeFileSync(
      path.join(outDir, "cargo-test.log"),
      `${cargo.stdout ?? ""}\n${cargo.stderr ?? ""}`,
    );
    process.stdout.write(cargo.stdout ?? "");
    testStatus = cargo.status ?? 1;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(path.join(outDir, "cargo-test.log"), `${failure}\n`);
  } finally {
    if (containerStarted) {
      run("docker", ["rm", "-f", container], { timeout: 60_000 });
    }
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(keyDir, { recursive: true, force: true });
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
    failure === null &&
    testStatus === 0 &&
    checks.length === EXPECTED_CHECKS.length &&
    missingChecks.length === 0 &&
    unexpectedChecks.length === 0 &&
    duplicateChecks.length === 0 &&
    checks.every((check) => check.passed === true);
  const report = {
    suite: "sftp-connect-openssh",
    server: {
      baseImage: BASE_IMAGE,
      image: IMAGE_TAG,
      imageId,
      openssh: opensshVersion,
      opensshPackage,
      hostKeyFingerprint,
      bindHost,
      ports,
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
  const relativeReport = path.relative(root, path.join(outDir, "report.json"));
  console.log(
    `\nSFTP E2E: ${passed ? "PASS" : "FAIL"} (cargo exit ${testStatus}, ${checks.filter((c) => c.passed).length}/${checks.length} checks passed) -> ${relativeReport}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
