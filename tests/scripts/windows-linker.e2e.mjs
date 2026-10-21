#!/usr/bin/env node
// Failure modes recorded before the fix:
// - MSVC release links on x64 or ARM64 still generate an oversized PDB.
// - Development builds lose PDBs needed for debugging.
// - GNU Windows or non-Windows targets receive MSVC-only options.
// - The existing Windows stack reservation disappears.
// This isolated build-script probe stubs Tauri's unrelated resource generation;
// it does not execute link.exe or certify Windows installers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-linker-"));
const reportDir = path.join(root, "test-results", "windows-linker");
const results = [];
try {
  const source = path.join(scratch, "probe.rs");
  const executable = path.join(scratch, process.platform === "win32" ? "probe.exe" : "probe");
  fs.writeFileSync(source, `
mod tauri_build {
    pub struct Attributes;
    pub struct AppManifest;
    impl Attributes {
        pub fn new() -> Self { Self }
        pub fn app_manifest(self, _: AppManifest) -> Self { self }
    }
    impl AppManifest {
        pub fn new() -> Self { Self }
        pub fn commands(self, _: &[&str]) -> Self { self }
    }
    pub fn try_build(_: Attributes) -> Result<(), &'static str> { Ok(()) }
}
include!(${JSON.stringify(path.join(root, "src-tauri", "build.rs"))});
`);
  const compile = spawnSync("rustc", ["--edition=2021", source, "-o", executable], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  for (const [targetOs, targetEnv, arch, profile] of [
    ["windows", "msvc", "x86_64", "release"],
    ["windows", "msvc", "aarch64", "release"],
    ["windows", "msvc", "aarch64", "debug"],
    ["windows", "gnu", "x86_64", "release"],
    ["macos", "", "aarch64", "release"],
    ["linux", "gnu", "x86_64", "release"],
  ]) {
    const run = spawnSync(executable, [], {
      encoding: "utf8",
      env: { ...process.env, CARGO_CFG_TARGET_OS: targetOs,
        CARGO_CFG_TARGET_ENV: targetEnv, CARGO_CFG_TARGET_ARCH: arch, PROFILE: profile },
    });
    const lines = run.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const expected = [];
    if (targetOs === "windows" && targetEnv === "msvc") {
      expected.push("cargo:rustc-link-arg-bins=/STACK:8388608");
      if (profile === "release") expected.push("cargo:rustc-link-arg-bins=/DEBUG:NONE");
    } else if (targetOs === "windows" && targetEnv === "gnu") {
      expected.push("cargo:rustc-link-arg-bins=-Wl,--stack,8388608");
    }
    const passed = run.status === 0 && JSON.stringify(lines) === JSON.stringify(expected);
    results.push({ targetOs, targetEnv, arch, profile, passed, observed: lines, expected });
    console.log(`${passed ? "PASS" : "FAIL"} ${targetOs}/${targetEnv}/${arch}/${profile}`);
  }
  assert.ok(results.every((result) => result.passed), "Build-script linker policy failed");
} finally {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({
    command: "node tests/scripts/windows-linker.e2e.mjs",
    scope: "Isolated real build.rs execution with Tauri resource generation stubbed; no native Windows link",
    results,
  }, null, 2) + "\n");
  fs.rmSync(scratch, { recursive: true, force: true });
}
