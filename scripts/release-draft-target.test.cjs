"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  assertReleaseTargetsHead,
  expectedReleaseBranch,
  releaseTargetMatchesCommit,
  resolveGitRef,
} = require("./release-draft-target.cjs");

const ROOT = path.join(__dirname, "..");

function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("expected release branch maps stable to main and beta to beta", () => {
  assert.equal(expectedReleaseBranch(false), "main");
  assert.equal(expectedReleaseBranch(true), "beta");
});

test("release target accepts exact commit and canonical branch names", () => {
  const head = currentHead();
  assert.equal(
    releaseTargetMatchesCommit(head, head, { isPrerelease: false }),
    true,
  );
  assert.equal(
    releaseTargetMatchesCommit("main", head, { isPrerelease: false }),
    true,
  );
  const betaTip = resolveGitRef("origin/beta", ROOT);
  if (betaTip === head.toLowerCase()) {
    assert.equal(
      releaseTargetMatchesCommit("beta", head, { isPrerelease: true }),
      true,
    );
  }
});

test("release target rejects wrong branch for release channel", () => {
  const head = currentHead();
  assert.equal(
    releaseTargetMatchesCommit("beta", head, { isPrerelease: false }),
    false,
  );
  assert.equal(
    releaseTargetMatchesCommit("main", head, { isPrerelease: true }),
    false,
  );
  assert.equal(
    releaseTargetMatchesCommit("develop", head, { isPrerelease: false }),
    false,
  );
});

test("assertReleaseTargetsHead accepts branch target and FORCE_UPLOAD bypass", () => {
  const head = currentHead();
  assert.equal(
    assertReleaseTargetsHead({ target_commitish: "main" }, head, {
      isPrerelease: false,
      tag: "v0.11.0",
    }).target_commitish,
    "main",
  );
  const warnings = [];
  assert.equal(
    assertReleaseTargetsHead({ target_commitish: "stale-branch" }, head, {
      env: { FORCE_UPLOAD: "1" },
      isPrerelease: false,
      log: { warn: (message) => warnings.push(message) },
      tag: "v0.11.0",
    }).target_commitish,
    "stale-branch",
  );
  assert.match(warnings[0], /FORCE_UPLOAD=1 bypassing commit check/);
});
