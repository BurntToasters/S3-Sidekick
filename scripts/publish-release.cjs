"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");
const {
  assertExpectedRelease,
  assertReleaseTagName,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");
const { releaseTargetMatchesCommit } = require("./release-draft-target.cjs");
const {
  assertNoSignatureSkips,
  assertProductionSignatureEnvironment,
} = require("./release-signature-gate.cjs");

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

// Publishing is a release gate, not a convenience upload. It must prove the
// exact tree and commit that passed test:all and CI, even when run standalone.
async function assertReleaseAuthority(commit) {
  const { verifyReleaseSession } = await import("./release-session.js");
  const session = verifyReleaseSession(ROOT);
  if (String(session.commit || "").toLowerCase() !== commit.toLowerCase()) {
    throw new Error(
      `Release build session is for ${session.commit}, not HEAD ${commit}.`,
    );
  }
  const { runReleaseCiStatus } = await import("./release-ci-status.js");
  runReleaseCiStatus({ commit });
  return session;
}

function verifyDraft(receiptPath) {
  const args = [
    path.join(__dirname, "verify-release-draft.js"),
    "--verify-artifacts",
  ];
  if (receiptPath) args.push(`--receipt=${receiptPath}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 60 * 60 * 1000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix draft before publishing.",
    );
  }
}

function listReleases() {
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
  return releases;
}

function findDraft() {
  const drafts = listReleases().filter(
    (release) => release?.draft && isExpectedRelease(release, TAG, VERSION),
  );
  if (drafts.length !== 1) {
    throw new Error(
      `Expected one draft release ${TAG}; found ${drafts.length}.`,
    );
  }
  return assertExpectedRelease(drafts[0], TAG, VERSION, "Publishing draft");
}

function listReleaseAssets(releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

function readVerificationReceipt(receiptPath) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (
    receipt?.suite !== "release-draft-verification" ||
    receipt.tag !== TAG ||
    receipt.version !== VERSION ||
    !Number.isFinite(receipt.release?.id) ||
    !Array.isArray(receipt.assets)
  ) {
    throw new Error("Draft verification receipt is missing or malformed.");
  }
  return receipt;
}

function assertReceiptMatchesRelease(release, receipt) {
  if (
    release.id !== receipt.release.id ||
    release.tag_name !== receipt.release.tag_name ||
    String(release.target_commitish || "") !==
      String(receipt.release.target_commitish || "") ||
    Boolean(release.draft) !== true
  ) {
    throw new Error(
      "Draft changed after verification; refuse to publish a different release.",
    );
  }
}

function assertLiveAssetsMatchReceipt(assets, receipt) {
  const live = new Map(assets.map((asset) => [asset.name, asset]));
  const verified = new Map(receipt.assets.map((asset) => [asset.name, asset]));
  const missing = [...verified.keys()].filter((name) => !live.has(name));
  const unexpected = [...live.keys()].filter((name) => !verified.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Draft assets changed after verification (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
  for (const [name, expected] of verified) {
    const actual = live.get(name);
    if (
      actual.id !== expected.id ||
      actual.size !== expected.size ||
      String(actual.digest ?? "") !== String(expected.digest ?? "")
    ) {
      throw new Error(
        `Draft asset ${name} changed after verification; refuse to publish.`,
      );
    }
  }
}

function assertPublishedResponse(published, { commit } = {}) {
  if (published?.draft !== false) {
    throw new Error(
      "GitHub did not publish the release; response still reports draft=true.",
    );
  }
  if (Boolean(published.prerelease) !== IS_PRERELEASE) {
    throw new Error(
      `Published release ${TAG} has prerelease=${Boolean(published.prerelease)}, expected ${IS_PRERELEASE}.`,
    );
  }
  if (
    commit &&
    !releaseTargetMatchesCommit(published.target_commitish, commit, {
      isPrerelease: IS_PRERELEASE,
      root: ROOT,
    })
  ) {
    throw new Error(
      `Published release ${TAG} targets ${published.target_commitish}, not HEAD ${commit}.`,
    );
  }
  return assertReleaseTagName(published, TAG, "Published release");
}

async function main() {
  assertProductionSignatureEnvironment(process.env);
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertNoSignatureSkips(process.env);
  assertGitHubCliAuthenticated();
  const commit = currentCommit();
  await assertReleaseAuthority(commit);
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
  const receiptPath = path.join(
    os.tmpdir(),
    `s3-sidekick-publish-receipt-${process.pid}.json`,
  );
  try {
    // Downloads and verifies every required byte and signature immediately
    // before the state transition, then proves the draft listing is unchanged.
    verifyDraft(receiptPath);
    const receipt = readVerificationReceipt(receiptPath);
    assertReceiptMatchesRelease(draft, receipt);
    assertLiveAssetsMatchReceipt(listReleaseAssets(draft.id), receipt);
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
    assertPublishedResponse(published, { commit });
    assertLiveAssetsMatchReceipt(listReleaseAssets(draft.id), receipt);
    console.log(`Published ${TAG}: ${published.html_url || TAG}`);
  } finally {
    fs.rmSync(receiptPath, { force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `release:publish failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

module.exports = {
  assertLiveAssetsMatchReceipt,
  assertPublishedResponse,
  assertReceiptMatchesRelease,
  assertReleaseAuthority,
  currentCommit,
  findDraft,
  listReleaseAssets,
  main,
  readVerificationReceipt,
  verifyDraft,
};
