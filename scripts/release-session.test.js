import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_QUALITY_CHECK_NAMES,
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  recordSuccessfulQualityGate,
  sha256WorkingTree,
  validateQualityGate,
  verifyQualityGate,
} from "./release-session.js";
import { finalizeQualityGate } from "./finalize-quality-gate.js";

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
  assert.equal(
    isAcceptableReleaseWorkingTree(
      " M src-tauri/gen/schemas/linux-schema.json",
    ),
    true,
  );
  for (const filePath of [
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ]) {
    assert.equal(
      isAcceptableReleaseWorkingTree(` M ${filePath}`),
      false,
      `${filePath} must not be bootstrap drift`,
    );
  }
  assert.equal(isAcceptableReleaseWorkingTree(" M package.json"), false);
});

test("blockingReleaseWorkingTreePaths ignores bootstrap-only drift", () => {
  assert.deepEqual(
    parsePorcelainPaths(" M run.rosie.s3-sidekick.metainfo.xml").filter(
      (filePath) => filePath === "run.rosie.s3-sidekick.metainfo.xml",
    ),
    ["run.rosie.s3-sidekick.metainfo.xml"],
  );
  assert.equal(
    isAcceptableReleaseWorkingTree(" M run.rosie.s3-sidekick.metainfo.xml"),
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

test("parsePorcelainPaths only strips a rename arrow for R/C statuses", () => {
  assert.deepEqual(parsePorcelainPaths(" M plain -> file.txt"), [
    "plain -> file.txt",
  ]);
  assert.deepEqual(parsePorcelainPaths("?? dir/name -> kept.txt"), [
    "dir/name -> kept.txt",
  ]);
  assert.deepEqual(parsePorcelainPaths("R  old.txt -> new.txt"), ["new.txt"]);
  assert.deepEqual(
    parsePorcelainPaths('R  "old -> name.txt" -> "new -> name.txt"'),
    ["new -> name.txt"],
  );
  assert.deepEqual(parsePorcelainPaths("C  source.txt -> copy.txt"), [
    "copy.txt",
  ]);
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

function initTempGitRepo(root) {
  execFileSync("git", ["-c", "init.templateDir=", "init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: root },
  );
}

function seedQualityEvidence(
  root,
  { now = Date.now(), treeStart, treeEnd, commitOverride } = {},
) {
  const coverage = path.join(root, "coverage");
  const reportDir = path.join(root, "test-results", "release-assets-e2e");
  fs.mkdirSync(coverage, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const workingTreeSha256 = sha256WorkingTree(root);
  fs.writeFileSync(
    path.join(coverage, ".release-tests.json"),
    `${JSON.stringify({
      suite: "release-quality-evidence",
      commit: commitOverride ?? commit,
      startedAt: now - 60_000,
      completedAt: now - 30_000,
      passed: true,
      workingTreeSha256Start: treeStart ?? workingTreeSha256,
      workingTreeSha256End: treeEnd ?? workingTreeSha256,
      checks: Object.fromEntries(
        REQUIRED_QUALITY_CHECK_NAMES.map((name) => [
          name,
          { status: "passed" },
        ]),
      ),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(coverage, "coverage-summary.json"),
    `${JSON.stringify({ total: { lines: { pct: 80 } } })}\n`,
  );
  fs.writeFileSync(
    path.join(reportDir, "report.json"),
    `${JSON.stringify({
      suite: "release-assets-integrity",
      passed: true,
      exitStatus: "passed",
      checkCount: 41,
      expectedCheckCount: 41,
      completedAt: now - 20_000,
      checks: [],
    })}\n`,
  );
  return {
    commit,
    coveragePath: path.join(coverage, "coverage-summary.json"),
    reportPath: path.join(reportDir, "report.json"),
  };
}

test("recordSuccessfulQualityGate accepts bootstrap-only metainfo drift", () => {
  const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-quality-gate-"));
  const coverageDir = path.join(root, "coverage");
  const proofPath = path.join(coverageDir, ".release-quality.json");
  try {
    fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ version: "0.11.0-beta.7" })}\n`,
    );
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "{}\n");
    fs.writeFileSync(
      path.join(root, "run.rosie.s3-sidekick.metainfo.xml"),
      "<component/>",
    );
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      "coverage/\ntest-results/\nrelease/\n",
    );
    initTempGitRepo(root);
    fs.appendFileSync(
      path.join(root, "run.rosie.s3-sidekick.metainfo.xml"),
      "\n",
    );
    seedQualityEvidence(root);

    assert.equal(recordSuccessfulQualityGate(root), true);
    assert.equal(fs.existsSync(proofPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recordSuccessfulQualityGate rejects non-bootstrap drift", () => {
  const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-quality-gate-"));
  try {
    fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ version: "0.11.0-beta.7" })}\n`,
    );
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "{}\n");
    fs.writeFileSync(
      path.join(root, "run.rosie.s3-sidekick.metainfo.xml"),
      "<component/>",
    );
    initTempGitRepo(root);
    seedQualityEvidence(root);
    fs.appendFileSync(path.join(root, "package.json"), "\n");

    assert.equal(recordSuccessfulQualityGate(root), false);
    assert.equal(
      fs.existsSync(path.join(root, "coverage", ".release-quality.json")),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createEvidenceRepo() {
  const root = fs.mkdtempSync(path.join(repoRoot, ".tmp-quality-gate-"));
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ version: "0.11.0-beta.7" })}\n`,
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "{}\n");
  fs.writeFileSync(
    path.join(root, "run.rosie.s3-sidekick.metainfo.xml"),
    "<component/>",
  );
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    "coverage/\ntest-results/\nrelease/\n",
  );
  initTempGitRepo(root);
  return root;
}

test("quality-gate proof refuses missing test evidence", () => {
  const root = createEvidenceRepo();
  try {
    assert.equal(recordSuccessfulQualityGate(root), false);
    assert.equal(
      fs.existsSync(path.join(root, "coverage", ".release-quality.json")),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate proof refuses stale test evidence", () => {
  const root = createEvidenceRepo();
  try {
    seedQualityEvidence(root, { now: Date.now() - 48 * 60 * 60 * 1000 });
    assert.equal(recordSuccessfulQualityGate(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate proof refuses evidence changed after recording", () => {
  const root = createEvidenceRepo();
  try {
    const { coveragePath } = seedQualityEvidence(root);
    assert.equal(recordSuccessfulQualityGate(root), true);
    fs.appendFileSync(coveragePath, "\n");
    assert.throws(() => verifyQualityGate(root), /evidence|changed/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate proof refuses a tree that changed during test:all", () => {
  const root = createEvidenceRepo();
  try {
    seedQualityEvidence(root, {
      treeStart: "a".repeat(64),
      treeEnd: "b".repeat(64),
    });
    assert.equal(recordSuccessfulQualityGate(root), false);
    assert.equal(finalizeQualityGate(root).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality-gate proof refuses evidence for another commit", () => {
  const root = createEvidenceRepo();
  try {
    seedQualityEvidence(root, { commitOverride: "b".repeat(40) });
    assert.equal(recordSuccessfulQualityGate(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone finalize refuses a tree changed after test:all", () => {
  const root = createEvidenceRepo();
  try {
    seedQualityEvidence(root);
    fs.appendFileSync(path.join(root, "package.json"), "\n");
    const result = finalizeQualityGate(root);
    assert.equal(result.ok, false);
    assert.match(result.evidenceProblems.join(" "), /different working tree/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
