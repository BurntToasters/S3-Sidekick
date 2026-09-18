"use strict";

const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");
const {
  assertExpectedRelease,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");
const { releaseTargetMatchesCommit } = require("./release-draft-target.cjs");

const ROOT = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG = `v${VERSION}`;
const IS_PRERELEASE = /-beta\.\d+$/.test(VERSION);
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyDraft() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "verify-release-draft.js"), "--verify-artifacts"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix draft before publishing.",
    );
  }
}

function findDraft() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const drafts = releases.filter(
    (release) => release?.draft && isExpectedRelease(release, TAG, VERSION),
  );
  if (drafts.length !== 1) {
    throw new Error(
      `Expected one draft release ${TAG}; found ${drafts.length}.`,
    );
  }
  return assertExpectedRelease(drafts[0], TAG, VERSION, "Publishing draft");
}

function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentCommit();
  verifyDraft();
  const draft = findDraft();
  if (
    !releaseTargetMatchesCommit(draft.target_commitish, commit, {
      isPrerelease: IS_PRERELEASE,
      root: ROOT,
    })
  ) {
    throw new Error(
      `Draft ${TAG} targets ${draft.target_commitish}, not HEAD ${commit}.`,
    );
  }
  const published = githubApi(
    "PATCH",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${draft.id}`,
    {
      draft: false,
      prerelease: IS_PRERELEASE,
      tag_name: TAG,
      target_commitish: commit,
    },
  );
  assertExpectedRelease(
    { ...published, draft: false },
    TAG,
    VERSION,
    "Published release",
  );
  console.log(`Published ${TAG}: ${published.html_url || TAG}`);
}

try {
  main();
} catch (error) {
  console.error(
    `release:publish failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
