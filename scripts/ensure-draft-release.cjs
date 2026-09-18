// Windows creates one GitHub draft. Other hosts use --wait and never create it.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  assertGitHubCliAuthenticated,
  githubApi,
  githubStatusCode,
} = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");
const { assertReleaseToolVersions } = require("./release-integrity.cjs");
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");
const { assertReleaseTargetsHead } = require("./release-draft-target.cjs");

const ROOT = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG = `v${VERSION}`;
const NUMERIC_VERSION = "(?:0|[1-9]\\d*)";
const BETA_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}-beta\\.${NUMERIC_VERSION}$`,
);
const STABLE_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}$`,
);
if (!BETA_VERSION.test(VERSION) && !STABLE_VERSION.test(VERSION)) {
  throw new Error(
    `Unsupported release version '${VERSION}'; S3-Sidekick releases use beta or stable versions only.`,
  );
}
const IS_PRERELEASE = BETA_VERSION.test(VERSION);
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const WAIT_MODE = process.argv.includes("--wait");
const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || "1800000",
  10,
);
const WAIT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || "15000",
  10,
);

function currentCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function verifySession() {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts", "release-session.js")],
    { cwd: ROOT, stdio: "inherit" },
  );
}

function readChangelogReleaseBody() {
  const body = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const heading = `## Changes in \`v${VERSION}:`;
  const start = body.indexOf(heading);
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no ${heading} section.`);
  }
  const next = body.indexOf("\n## Changes in `", start + heading.length);
  const section = body.slice(start, next < 0 ? body.length : next).trim();
  if (!section.slice(heading.length).trim()) {
    throw new Error(`CHANGELOG.md section for ${heading} is empty.`);
  }
  return body;
}

function isRetryable(error) {
  return (
    [408, 409, 425, 429, 500, 502, 503, 504].includes(
      githubStatusCode(error?.message),
    ) ||
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
    ].includes(error?.code) ||
    /timeout|socket hang up|aborted/i.test(String(error?.message || ""))
  );
}

function request(method, endpoint, body) {
  return githubApi(method, endpoint, body);
}

async function requestWithRetry(method, endpoint, body) {
  const attempts = Math.max(
    1,
    Number.parseInt(process.env.GH_REQUEST_RETRIES || "3", 10),
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return request(method, endpoint, body);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          attempt *
            Math.max(
              100,
              Number.parseInt(
                process.env.GH_REQUEST_RETRY_DELAY_MS || "1500",
                10,
              ),
            ),
        ),
      );
    }
  }
}

async function listReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await requestWithRetry(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

function matchingReleases(releases) {
  assertNoMisnamedVersionDrafts(releases, TAG);
  return releases.filter((release) => isExpectedRelease(release, TAG, VERSION));
}

function assertCommit(release, commit, env = process.env, log = console) {
  return assertReleaseTargetsHead(release, commit, {
    action: "continuing",
    env,
    isPrerelease: IS_PRERELEASE,
    log,
    root: ROOT,
    tag: TAG,
  });
}

async function syncDraft(release, body, commit) {
  const updated = await requestWithRetry(
    "PATCH",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}`,
    {
      body,
      draft: true,
      name: VERSION,
      prerelease: IS_PRERELEASE,
      tag_name: TAG,
      target_commitish: commit,
    },
  );
  return assertCommit(
    assertExpectedRelease(updated, TAG, VERSION, "Updated draft release"),
    commit,
  );
}

async function ensureDraftRelease() {
  const commit = currentCommit();
  const body = readChangelogReleaseBody();
  const matches = matchingReleases(await listReleases());
  const drafts = matches.filter((release) => release.draft);
  if (drafts.length > 1) {
    throw new Error(`Multiple draft releases exist for ${TAG}.`);
  }
  if (drafts[0])
    return syncDraft(assertCommit(drafts[0], commit), body, commit);
  if (matches.some((release) => !release.draft)) {
    throw new Error(`Release ${TAG} is already published.`);
  }
  const created = await requestWithRetry(
    "POST",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
    {
      body,
      draft: true,
      name: VERSION,
      prerelease: IS_PRERELEASE,
      tag_name: TAG,
      target_commitish: commit,
    },
  ).catch(async (error) => {
    if (githubStatusCode(error?.message) !== 422 && error?.statusCode !== 422) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const afterRetry = matchingReleases(await listReleases()).find(
      (release) => release.draft,
    );
    if (!afterRetry) throw error;
    return afterRetry;
  });
  return assertCommit(
    assertExpectedRelease(created, TAG, VERSION, "Created draft release"),
    commit,
  );
}

async function waitForDraftRelease() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const commit = currentCommit();
  for (;;) {
    let matches;
    try {
      matches = matchingReleases(await listReleases());
    } catch (error) {
      if (!isRetryable(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, WAIT_POLL_INTERVAL_MS),
      );
      continue;
    }
    const drafts = matches.filter((release) => release.draft);
    if (drafts.length > 1) {
      throw new Error(`Multiple draft releases exist for ${TAG}.`);
    }
    if (drafts[0]) {
      return syncDraft(
        assertCommit(drafts[0], commit),
        readChangelogReleaseBody(),
        commit,
      );
    }
    if (matches.some((release) => !release.draft)) {
      throw new Error(`Release ${TAG} is already published.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for draft ${TAG}. Run npm run release:draft on Windows first.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertReleaseToolVersions(packageJson, {
    environment: process.env,
    root: ROOT,
  });
  assertGitHubCliAuthenticated();
  verifySession();
  if (WAIT_MODE) await waitForDraftRelease();
  else await ensureDraftRelease();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `release:draft failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

module.exports = {
  assertCommit,
  currentCommit,
  ensureDraftRelease,
  matchingReleases,
  readChangelogReleaseBody,
  waitForDraftRelease,
};
