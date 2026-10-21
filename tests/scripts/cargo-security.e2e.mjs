#!/usr/bin/env node
// Failure modes recorded before the dependency fix:
// - A vulnerable rustls copy remains in any target's resolved graph.
// - Windows-only zip survives even though the host's graph looks clean.
// - Disabling updater defaults also disables TLS or system proxy support.
// - The updater still enables legacy archive support, or bundling uses v1 formats.
// - Audit exits unsuccessfully, reports vulnerabilities, or hides them with ignores.
// This runs real Cargo resolution and RustSec auditing without compiling or
// executing dependency code. It does not prove native updater installation.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outDir = path.join(root, "test-results", "cargo-security");
fs.mkdirSync(outDir, { recursive: true });
const checks = [];

function check(name, passed, observed) {
  checks.push({ name, passed, observed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

function cargo(name, args) {
  const result = spawnSync("cargo", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(outDir, `${name}.json`), result.stdout || "");
  fs.writeFileSync(
    path.join(outDir, `${name}.stderr.log`),
    `${result.stderr || ""}${result.error?.message || ""}`,
  );
  return result;
}

try {
  // No target filter: include Windows and Linux dependencies on macOS too.
  const metadataResult = cargo("metadata", [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--format-version",
    "1",
  ]);
  check(
    "locked metadata resolves",
    metadataResult.status === 0,
    metadataResult.status,
  );
  if (metadataResult.status !== 0)
    throw new Error("Cargo metadata failed; see artifact");
  const metadata = JSON.parse(metadataResult.stdout);
  const tls = metadata.packages.filter((pkg) => pkg.name === "rustls");
  check(
    "all rustls copies include the 0.23.46 fixes",
    tls.length > 0 &&
      tls.every((pkg) => {
        const [major, minor, patch] = pkg.version.split(".").map(Number);
        return major > 0 || (minor === 23 && patch >= 46) || minor > 23;
      }),
    tls.map((pkg) => pkg.version),
  );
  check(
    "zip absent across all targets",
    !metadata.packages.some((pkg) => pkg.name === "zip"),
    metadata.packages
      .filter((pkg) => pkg.name === "zip")
      .map((pkg) => pkg.version),
  );
  const updater = metadata.packages.find(
    (pkg) => pkg.name === "tauri-plugin-updater",
  );
  const features =
    metadata.resolve.nodes.find((node) => node.id === updater?.id)?.features ||
    [];
  check(
    "updater retains TLS and proxy without legacy archives",
    features.includes("rustls-tls") &&
      features.includes("system-proxy") &&
      !features.includes("zip") &&
      !features.includes("default"),
    features,
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  check(
    "bundler produces v2 updater artifacts",
    config.bundle.createUpdaterArtifacts === true,
    config.bundle.createUpdaterArtifacts,
  );

  const auditResult = cargo("audit", [
    "audit",
    "--file",
    "src-tauri/Cargo.lock",
    "--json",
  ]);
  check("Cargo audit succeeds", auditResult.status === 0, auditResult.status);
  if (!auditResult.stdout)
    throw new Error("Cargo audit produced no report; see artifact");
  const audit = JSON.parse(auditResult.stdout);
  check(
    "RustSec reports zero vulnerabilities",
    audit.vulnerabilities?.count === 0,
    audit.vulnerabilities?.count,
  );
  check(
    "no advisories ignored",
    Array.isArray(audit.settings?.ignore) && audit.settings.ignore.length === 0,
    audit.settings?.ignore,
  );
} catch (error) {
  check("verification completes", false, error.message);
} finally {
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node tests/scripts/cargo-security.e2e.mjs",
    lockSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, "src-tauri/Cargo.lock")))
      .digest("hex"),
    passed: checks.every((entry) => entry.passed),
    checks,
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`Artifact: ${path.join(outDir, "report.json")}`);
  if (!report.passed) process.exitCode = 1;
}
