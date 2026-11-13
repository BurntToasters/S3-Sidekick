#!/usr/bin/env node
// Runtime release-cleanup safety: real Git repos, real stash, real
// fast-forward. Failure inventory: release-safety-failure-modes.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanupCheckout,
  runGit,
} from "../../scripts/release-cleanup-checkout.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const out = path.join(root, "test-results", "release-cleanup-safety");
const checks = [];
let error = null;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return String(result.stdout || "").trim();
}

function record(name, passed, observed) {
  checks.push({ name, passed, observed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

function createCheckout() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-cleanup-e2e-"));
  const checkout = path.join(scratch, "checkout");
  const origin = path.join(scratch, "origin.git");
  const author = path.join(scratch, "author");
  fs.mkdirSync(checkout);
  git(checkout, ["-c", "init.templateDir=", "init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "test@example.com"]);
  git(checkout, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(checkout, "app.txt"), "one\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-qm", "init"]);
  git(scratch, ["-c", "init.templateDir=", "init", "-q", "--bare", origin]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-qu", "origin", "main"]);

  fs.mkdirSync(author);
  git(scratch, ["clone", "-q", "-b", "main", origin, author]);
  git(author, ["config", "user.email", "test@example.com"]);
  git(author, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(author, "app.txt"), "two\n");
  git(author, ["add", "."]);
  git(author, ["commit", "-qm", "advance"]);
  git(author, ["push", "-q", "origin", "main"]);
  return { scratch, checkout, origin };
}

function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

function originHead(origin) {
  return git(origin, ["rev-parse", "refs/heads/main"]);
}

try {
  const { scratch, checkout, origin } = createCheckout();
  try {
    fs.appendFileSync(path.join(checkout, "app.txt"), "local\n");
    const before = head(checkout);
    const refusalCalls = [];
    let refused = false;
    try {
      cleanupCheckout({
        root: checkout,
        environment: {},
        git: (args, options) => {
          refusalCalls.push(args);
          return runGit(checkout, args, options);
        },
      });
    } catch (err) {
      refused = /refuses a dirty checkout/.test(
        err instanceof Error ? err.message : String(err),
      );
    }
    record(
      "dirty refusal preserves local bytes and HEAD",
      refused &&
        head(checkout) === before &&
        fs
          .readFileSync(path.join(checkout, "app.txt"), "utf8")
          .includes("local") &&
        !refusalCalls.some(
          (args) => args[0] === "stash" || args[0] === "merge",
        ),
      {
        refused,
        headUnchanged: head(checkout) === before,
        calls: refusalCalls,
      },
    );

    const calls = [];
    cleanupCheckout({
      root: checkout,
      environment: { ALLOW_RELEASE_CLEANUP_STASH: "1" },
      git: (args, options) => {
        calls.push(args);
        return runGit(checkout, args, options);
      },
    });
    const destructive = calls.filter(
      (args) =>
        args[0] === "reset" ||
        args[0] === "checkout" ||
        args[0] === "clean" ||
        args.includes("--hard"),
    );
    const safety = {
      merged: calls.some(
        (args) => args[0] === "merge" && args.includes("--ff-only"),
      ),
      stashed: calls.some((args) => args[0] === "stash"),
      headAtUpstream: head(checkout) === originHead(origin),
      destructive,
    };
    record(
      "stash then fast-forward reaches upstream without destructive Git",
      safety.merged &&
        safety.stashed &&
        safety.headAtUpstream &&
        safety.destructive.length === 0,
      safety,
    );
    const status = git(checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const stashes = git(checkout, ["stash", "list"]);
    const residue = { status, stashes };
    record(
      "cleanup leaves no tracked or untracked residue",
      status === "" && /release-cleanup-backup-/.test(stashes),
      residue,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
  record("runtime cleanup fixture completes", false, error);
} finally {
  fs.mkdirSync(out, { recursive: true });
  const expected = [
    "dirty refusal preserves local bytes and HEAD",
    "stash then fast-forward reaches upstream without destructive Git",
    "cleanup leaves no tracked or untracked residue",
  ];
  const passed =
    !error &&
    checks.length === expected.length &&
    checks.every(
      (check, index) => check.name === expected[index] && check.passed,
    );
  fs.writeFileSync(
    path.join(out, "report.json"),
    `${JSON.stringify(
      {
        suite: "release-cleanup-safety",
        passed,
        fixture: "real disposable Git repositories and a bare origin",
        expectedCheckCount: expected.length,
        checkCount: checks.length,
        error,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = passed ? 0 : 1;
}
