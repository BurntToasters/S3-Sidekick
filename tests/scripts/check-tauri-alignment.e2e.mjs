#!/usr/bin/env node
// E2E for scripts/check-tauri-alignment.mjs, the static lockfile gate that
// runs in `npm run u` and test:all without executing dependency code.
//
// Failure modes checked before implementation:
// - Cargo resolves tauri-runtime/-wry to a newer minor than the exact-pinned
//   tauri (the 0.11.1 lock that did not compile) and the gate passes.
// - npm @tauri-apps/api or @tauri-apps/cli drifts to another minor than the
//   Rust crate (`tauri build` then refuses) and the gate passes.
// - A plugin's JS package and Rust crate are on different minors.
// - Duplicate crate entries in Cargo.lock hide a mismatched second copy.
// - A lockfile without tauri, or a malformed lockfile, passes or crashes
//   with a stack trace instead of a clear error.
// - The real repository lockfiles fail an aligned tree.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const script = path.join(root, "scripts", "check-tauri-alignment.mjs");
const outDir = path.join(root, "test-results", "check-tauri-alignment");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-tauri-align-"));
const results = [];
const EXPECTED_CHECKS = 13;

function check(name, passed, observed = undefined) {
  results.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

function cargoLock(packages) {
  return `version = 4\n\n${packages
    .map(
      ([name, version]) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
    )
    .join("\n")}`;
}

function npmLock(packages) {
  return JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ["", { name: "fixture" }],
      ...packages.map(([name, version]) => [
        `node_modules/${name}`,
        { version },
      ]),
    ]),
  });
}

const ALIGNED_CARGO = [
  ["tauri", "2.12.0"],
  ["tauri-runtime", "2.12.0"],
  ["tauri-runtime-wry", "2.12.0"],
  ["tauri-plugin-dialog", "2.8.0"],
  ["tauri-plugin-updater", "2.13.0"],
];
const ALIGNED_NPM = [
  ["@tauri-apps/api", "2.12.0"],
  ["@tauri-apps/cli", "2.12.1"],
  ["@tauri-apps/plugin-dialog", "2.8.3"],
  ["@tauri-apps/plugin-updater", "2.13.0"],
];

function runCase(name, cargo, npm) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  const cargoPath = path.join(dir, "Cargo.lock");
  const npmPath = path.join(dir, "package-lock.json");
  fs.writeFileSync(cargoPath, cargo);
  fs.writeFileSync(npmPath, npm);
  return spawnSync(
    process.execPath,
    [script, "--cargo-lock", cargoPath, "--npm-lock", npmPath],
    { encoding: "utf8" },
  );
}

function replace(list, name, version) {
  return list.map(([n, v]) => [n, n === name ? version : v]);
}

try {
  fs.mkdirSync(outDir, { recursive: true });

  const aligned = runCase(
    "aligned",
    cargoLock(ALIGNED_CARGO),
    npmLock(ALIGNED_NPM),
  );
  check("aligned locks exit 0", aligned.status === 0, aligned.stderr);

  const runtime = runCase(
    "runtime-ahead",
    cargoLock([
      ...replace(ALIGNED_CARGO, "tauri", "2.11.5").filter(
        ([n]) => n !== "tauri-runtime-wry",
      ),
      ["tauri-runtime-wry", "2.12.0"],
    ]),
    npmLock(replace(ALIGNED_NPM, "@tauri-apps/api", "2.11.1")),
  );
  check("runtime ahead of tauri exits 1", runtime.status === 1);
  check(
    "runtime mismatch names both crates",
    /tauri-runtime.*2\.12\.0/.test(runtime.stderr) &&
      /tauri 2\.11\.5/.test(runtime.stderr),
    runtime.stderr,
  );

  const api = runCase(
    "npm-api-drift",
    cargoLock(ALIGNED_CARGO),
    npmLock(replace(ALIGNED_NPM, "@tauri-apps/api", "2.13.0")),
  );
  check("npm api minor drift exits 1", api.status === 1);
  check(
    "npm api drift is named",
    api.stderr.includes("@tauri-apps/api 2.13.0"),
    api.stderr,
  );

  const cli = runCase(
    "npm-cli-drift",
    cargoLock(ALIGNED_CARGO),
    npmLock(replace(ALIGNED_NPM, "@tauri-apps/cli", "2.11.4")),
  );
  check("npm cli minor drift exits 1", cli.status === 1, cli.stderr);

  const plugin = runCase(
    "plugin-drift",
    cargoLock(ALIGNED_CARGO),
    npmLock(replace(ALIGNED_NPM, "@tauri-apps/plugin-dialog", "2.7.3")),
  );
  check("plugin minor drift exits 1", plugin.status === 1);
  check(
    "plugin drift names the plugin",
    plugin.stderr.includes("dialog"),
    plugin.stderr,
  );

  const duplicate = runCase(
    "duplicate-runtime",
    cargoLock([...ALIGNED_CARGO, ["tauri-runtime", "2.11.3"]]),
    npmLock(ALIGNED_NPM),
  );
  check(
    "a mismatched duplicate crate entry exits 1",
    duplicate.status === 1,
    duplicate.stderr,
  );

  const missing = runCase(
    "missing-tauri",
    cargoLock(ALIGNED_CARGO.filter(([n]) => n !== "tauri")),
    npmLock(ALIGNED_NPM),
  );
  check("missing tauri exits 1", missing.status === 1);
  check(
    "missing tauri gives a clear error, not a stack trace",
    /tauri/.test(missing.stderr) && !/\n\s+at /.test(missing.stderr),
    missing.stderr,
  );

  const malformed = runCase(
    "malformed-npm",
    cargoLock(ALIGNED_CARGO),
    "{not json",
  );
  check(
    "malformed npm lock exits 1 without a stack trace",
    malformed.status === 1 && !/\n\s+at /.test(malformed.stderr),
    malformed.stderr,
  );

  const repo = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
  });
  check("repository lockfiles are aligned", repo.status === 0, repo.stderr);
} finally {
  const passed = results.filter((result) => result.passed).length;
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        suite: "check-tauri-alignment-real-script",
        passed: passed === results.length && results.length === EXPECTED_CHECKS,
        checkCount: results.length,
        passedCount: passed,
        checks: results,
      },
      null,
      2,
    )}\n`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}

const passed =
  results.length === EXPECTED_CHECKS && results.every((result) => result.passed);
process.stdout.write(
  `${passed ? "ALL PASS" : "FAILURES"} (${results.filter((result) => result.passed).length}/${results.length})\n`,
);
process.exit(passed ? 0 : 1);
