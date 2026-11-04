#!/usr/bin/env node
// Fast-forward the release checkout without silently destroying local work.
// A dirty tree is refused unless ALLOW_RELEASE_CLEANUP_STASH=1 is set, and even
// then the changes are stashed (not reset --hard / clean -fd) so they can be
// restored. The checkout is only ever fast-forwarded to its configured upstream.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const defaultRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result;
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function cleanupCheckout({
  root = defaultRoot,
  environment = process.env,
  git = (args, options) => runGit(root, args, options),
} = {}) {
  git(["rev-parse", "--is-inside-work-tree"]);
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"])
    .stdout.split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    if (!isTruthy(environment.ALLOW_RELEASE_CLEANUP_STASH)) {
      throw new Error(
        `Release cleanup refuses a dirty checkout:\n${dirty
          .slice(0, 20)
          .map((line) => `  ${line}`)
          .join(
            "\n",
          )}${dirty.length > 20 ? `\n  ...and ${dirty.length - 20} more` : ""}\nCommit the release source, or set ALLOW_RELEASE_CLEANUP_STASH=1 to stash local work first.`,
      );
    }
    const label = `release-cleanup-backup-${new Date().toISOString()}`;
    git(["stash", "push", "--include-untracked", "-m", label]);
    console.warn(
      `release-cleanup: stashed ${dirty.length} local change(s) as "${label}"; restore with git stash pop.`,
    );
  }
  git(["fetch", "--quiet", "origin"]);
  const upstream = git([
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]).stdout.trim();
  if (!upstream) {
    throw new Error("Release checkout has no configured upstream branch.");
  }
  git(["merge", "--ff-only", "@{u}"]);
  console.log(`release-cleanup: fast-forwarded to ${upstream}`);
}

if (isDirectExecution(import.meta.url)) {
  try {
    cleanupCheckout();
  } catch (error) {
    console.error(
      `release-cleanup: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { defaultRoot as root, runGit };
