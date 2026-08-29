import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  sha256WorkingTree,
  validateQualityGate,
} from "./release-session.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("isAcceptableReleaseWorkingTree allows bootstrap-only drift", () => {
  assert.equal(isAcceptableReleaseWorkingTree(""), true);
  assert.equal(
    isAcceptableReleaseWorkingTree(" M run.rosie.s3-sidekick.metainfo.xml"),
    true,
  );
  assert.equal(isAcceptableReleaseWorkingTree(" M src-tauri/Cargo.lock"), true);
  assert.equal(
    isAcceptableReleaseWorkingTree(
      " M src-tauri/gen/schemas/linux-schema.json",
    ),
    true,
  );
  assert.equal(
    isAcceptableReleaseWorkingTree(" M scripts/release-title.test.cjs"),
    true,
  );
  assert.equal(isAcceptableReleaseWorkingTree(" M package-lock.json"), true);
  assert.equal(isAcceptableReleaseWorkingTree(" M package.json"), false);
});

test("parsePorcelainPaths preserves leading XY status spaces", () => {
  // Git prints ` M path` (space + M). Trimming that blob to `M path` used to
  // make the parser return no paths and block quality-gate recording during
  // release:prepare after workspace:bootstrap touched only metainfo.
  assert.deepEqual(
    parsePorcelainPaths(" M run.rosie.s3-sidekick.metainfo.xml"),
    ["run.rosie.s3-sidekick.metainfo.xml"],
  );
  assert.deepEqual(
    parsePorcelainPaths(
      " M run.rosie.s3-sidekick.metainfo.xml\n M src-tauri/Cargo.toml",
    ),
    ["run.rosie.s3-sidekick.metainfo.xml", "src-tauri/Cargo.toml"],
  );
  assert.equal(
    isAcceptableReleaseWorkingTree(" M run.rosie.s3-sidekick.metainfo.xml"),
    true,
  );
  // The pre-fix failure mode: trim() ate the leading XY space.
  assert.equal(
    parsePorcelainPaths(" M run.rosie.s3-sidekick.metainfo.xml".trim()).length,
    0,
  );
});

test("createReleaseSession rejects when quality gate proof is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-release-"));
  try {
    assert.throws(() => createReleaseSession(root), /quality-gate proof/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateQualityGate rejects a tampered source-tree hash", () => {
  const expected = {
    version: "0.11.0-beta.5",
    commit: "abc123",
    platform: "darwin",
    arch: "arm64",
    node: "v22.0.0",
    rustc: "rustc 1.97.1",
    packageLockSha256: "aa",
    cargoLockSha256: "bb",
    sourceTreeSha256: "cc",
  };
  const proof = {
    ...expected,
    completedAt: Date.now(),
    sourceTreeSha256: "tampered",
  };
  assert.throws(() => validateQualityGate(proof, expected), /sourceTreeSha256/);
});

test("sha256WorkingTree returns a stable digest for this checkout", () => {
  const first = sha256WorkingTree(repoRoot);
  const second = sha256WorkingTree(repoRoot);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});
