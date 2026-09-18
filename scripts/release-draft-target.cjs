"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const RELEASE_BRANCH = Object.freeze({
  beta: "beta",
  stable: "main",
});

function expectedReleaseBranch(isPrerelease) {
  return isPrerelease ? RELEASE_BRANCH.beta : RELEASE_BRANCH.stable;
}

function resolveGitRef(ref, root = path.join(__dirname, "..")) {
  try {
    const commit = execFileSync("git", ["rev-parse", ref], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
    return commit.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeCommitish(value) {
  const trimmed = String(value || "").trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function releaseTargetMatchesCommit(
  targetCommitish,
  headCommit,
  { isPrerelease, root = path.join(__dirname, "..") } = {},
) {
  const head = normalizeCommitish(headCommit);
  const target = normalizeCommitish(targetCommitish);
  if (!head || !target) return false;
  if (target === head) return true;

  const branch = expectedReleaseBranch(Boolean(isPrerelease));
  if (target !== branch) return false;

  const localTip = resolveGitRef(branch, root);
  if (localTip === head) return true;
  const remoteTip = resolveGitRef(`origin/${branch}`, root);
  return remoteTip === head;
}

function assertReleaseTargetsHead(
  release,
  headCommit,
  {
    action = "continuing",
    env = process.env,
    isPrerelease = false,
    log = console,
    root = path.join(__dirname, ".."),
    tag = "release",
  } = {},
) {
  if (
    releaseTargetMatchesCommit(release?.target_commitish, headCommit, {
      isPrerelease,
      root,
    })
  ) {
    return release;
  }
  if (/^(1|true|yes|on)$/i.test(String(env.FORCE_UPLOAD || "").trim())) {
    log.warn(
      `WARNING: Draft ${tag} targets ${release?.target_commitish || "unknown"}, not HEAD ${headCommit}. FORCE_UPLOAD=1 bypassing commit check.`,
    );
    return release;
  }
  throw new Error(
    `Draft ${tag} targets ${release?.target_commitish || "unknown"}, not HEAD ${headCommit}. Delete or retarget stale draft before ${action}. Or set FORCE_UPLOAD=1 to bypass.`,
  );
}

module.exports = {
  RELEASE_BRANCH,
  assertReleaseTargetsHead,
  expectedReleaseBranch,
  releaseTargetMatchesCommit,
  resolveGitRef,
};
