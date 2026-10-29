#!/usr/bin/env node
// E2E for scripts/require-clean-tree.mjs, the guard in front of the
// `npm run b` / `npm run r` branch resets (git reset --hard && git clean -fd).
//
// Failure modes checked before implementation:
// - Modified tracked files pass the guard and are then wiped by the reset.
// - Staged-only changes pass because only the worktree was compared.
// - Untracked files pass and are then deleted by `git clean -fd`.
// - The guard itself changes or deletes anything.
// - A clean tree is refused, making the scripts unusable.
// - No deliberate override exists for discarding work on purpose.
// - `b` or `r` stop running the guard first.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const guard = path.join(root, "scripts", "require-clean-tree.mjs");
const outDir = path.join(root, "test-results", "require-clean-tree");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-clean-tree-"));
const results = [];
const EXPECTED_CHECKS = 11;

function check(name, passed, observed = undefined) {
  results.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

function git(repo, args) {
  return spawnSync(
    "git",
    ["-c", "user.email=e2e@local", "-c", "user.name=clean-tree-e2e", ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

function freshRepo(name) {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "kept.txt"), "original\n");
  git(repo, ["add", "kept.txt"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  return repo;
}

function runGuard(repo, env = {}) {
  return spawnSync(process.execPath, [guard], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ALLOW_DISCARD_LOCAL_CHANGES: "", ...env },
  });
}

try {
  fs.mkdirSync(outDir, { recursive: true });

  const clean = freshRepo("clean");
  check("clean tree passes", runGuard(clean).status === 0);

  const modified = freshRepo("modified");
  fs.writeFileSync(path.join(modified, "kept.txt"), "local work\n");
  const modifiedRun = runGuard(modified);
  check("modified tracked file is refused", modifiedRun.status === 1);
  check(
    "refusal names the file",
    modifiedRun.stderr.includes("kept.txt"),
    modifiedRun.stderr,
  );
  check(
    "guard leaves the modification in place",
    fs.readFileSync(path.join(modified, "kept.txt"), "utf8") === "local work\n",
  );

  const staged = freshRepo("staged");
  fs.writeFileSync(path.join(staged, "kept.txt"), "staged work\n");
  git(staged, ["add", "kept.txt"]);
  check("staged-only change is refused", runGuard(staged).status === 1);

  const untracked = freshRepo("untracked");
  fs.writeFileSync(path.join(untracked, "new-notes.md"), "draft\n");
  const untrackedRun = runGuard(untracked);
  check("untracked file is refused", untrackedRun.status === 1);
  check(
    "guard leaves the untracked file in place",
    fs.existsSync(path.join(untracked, "new-notes.md")),
  );

  const override = runGuard(modified, { ALLOW_DISCARD_LOCAL_CHANGES: "1" });
  check("explicit override passes", override.status === 0, override.stderr);
  check(
    "override warns that changes will be discarded",
    /discard/i.test(override.stderr),
    override.stderr,
  );

  const outside = runGuard(scratch);
  check("outside a git repository is refused", outside.status === 1);

  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).scripts;
  check(
    "b and r run the guard before any git command",
    ["b", "r"].every((name) =>
      scripts[name].startsWith("node scripts/require-clean-tree.mjs && "),
    ),
    { b: scripts.b, r: scripts.r },
  );
} finally {
  const passed = results.filter((result) => result.passed).length;
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        suite: "require-clean-tree-real-script",
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
