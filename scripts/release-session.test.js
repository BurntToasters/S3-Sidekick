import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
} from "./release-session.js";

test("isAcceptableReleaseWorkingTree allows bootstrap-only drift", () => {
  assert.equal(isAcceptableReleaseWorkingTree(""), true);
  assert.equal(
    isAcceptableReleaseWorkingTree(" M run.rosie.s3-sidekick.metainfo.xml"),
    true,
  );
  assert.equal(
    isAcceptableReleaseWorkingTree(" M src-tauri/Cargo.lock"),
    true,
  );
  assert.equal(
    isAcceptableReleaseWorkingTree(" M scripts/release-title.test.cjs"),
    true,
  );
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
