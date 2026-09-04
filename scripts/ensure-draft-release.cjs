// One machine (Windows by convention) creates the canonical draft and descriptor.
// Other release hosts use --wait and consume that exact signed descriptor.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  assertGitHubCliAuthenticated,
  downloadReleaseAsset,
  githubApi,
  uploadReleaseAssetById,
} = require("./github-cli.cjs");
const {
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  assertCleanSource,
  assertExistingGitHubTagCommit,
  classifyImmutableAsset,
  createReleaseDescriptor,
  listAllReleaseAssets,
  readReleaseDescriptor,
  selectUniqueTaggedRelease,
  signDescriptor,
  sourceCommit,
  validateDescriptorForCheckout,
  validateMutableRelease,
  verifyDescriptorSignature,
  writeReleaseDescriptor,
} = require("./release-integrity.cjs");
const { formatReleaseTitle } = require("./release-title.cjs");
const packageJson = require("../package.json");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const RELEASE_DIR = path.join(REPOSITORY_ROOT, "release");
const CHANGELOG_PATH = path.join(REPOSITORY_ROOT, "CHANGELOG.md");
const DESCRIPTOR_PATH = path.join(RELEASE_DIR, DESCRIPTOR_NAME);
const DESCRIPTOR_SIGNATURE_PATH = path.join(
  RELEASE_DIR,
  DESCRIPTOR_SIGNATURE_NAME,
);
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const REPOSITORY = `${REPO_OWNER}/${REPO_NAME}`;
const VERSION = packageJson.version;
const TAG_NAME = `v${VERSION}`;
const IS_PRERELEASE = /-(?:alpha|beta|rc)\./i.test(VERSION);
const SOURCE_COMMIT = sourceCommit(REPOSITORY_ROOT);
const GH_REQUEST_RETRIES = Number.parseInt(
  process.env.GH_REQUEST_RETRIES || "3",
  10,
);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || "1500",
  10,
);
const WAIT_MODE = process.argv.slice(2).includes("--wait");
const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || "1800000",
  10,
);
const WAIT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || "15000",
  10,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readChangelogReleaseBody(changelogPath = CHANGELOG_PATH) {
  let body;
  try {
    body = fs.readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new Error(
      `CHANGELOG.md is required for GitHub release notes: ${error && error.message ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!body.trim())
    throw new Error(
      "CHANGELOG.md is empty; refusing to set blank release notes.",
    );
  return body;
}

function isRetryableGithubError(error) {
  if (!error) return false;
  const retryableStatusCodes = new Set([
    408, 409, 425, 429, 500, 502, 503, 504,
  ]);
  const retryableCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EPIPE",
  ]);
  if (
    typeof error.statusCode === "number" &&
    retryableStatusCodes.has(error.statusCode)
  )
    return true;
  if (typeof error.code === "string" && retryableCodes.has(error.code))
    return true;
  const message = String(error.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("socket hang up") ||
    message.includes("aborted")
  );
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      if (attempt >= attempts || !isRetryableGithubError(error)) throw error;
      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        `   Retry ${attempt}/${attempts - 1} in ${backoffMs}ms (${error.message})`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("GitHub retry loop exhausted unexpectedly.");
}

function releaseValidationOptions(expectedId) {
  return {
    expectedId,
    expectedPrerelease: IS_PRERELEASE,
    expectedTag: TAG_NAME,
    expectedTargetCommitish: SOURCE_COMMIT,
  };
}

async function assertExistingTagMatchesSource(
  request = githubRequestWithRetry,
) {
  return assertExistingGitHubTagCommit(request, {
    expectedCommit: SOURCE_COMMIT,
    owner: REPO_OWNER,
    repository: REPO_NAME,
    tag: TAG_NAME,
  });
}

async function findExistingRelease() {
  const releases = await listAllReleaseAssets((page, perPage) =>
    githubRequestWithRetry(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}&page=${page}`,
    ),
  );
  return selectUniqueTaggedRelease(releases, releaseValidationOptions());
}

async function loadReleaseById(releaseId) {
  const release = await githubRequestWithRetry(
    "GET",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}`,
  );
  return validateMutableRelease(release, releaseValidationOptions(releaseId));
}

async function syncReleaseNotesBody(release, body) {
  validateMutableRelease(release, releaseValidationOptions(release.id));
  await loadReleaseById(release.id);
  const updated = await githubRequestWithRetry(
    "PATCH",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}`,
    { name: formatReleaseTitle(VERSION), body },
  );
  validateMutableRelease(updated, releaseValidationOptions(release.id));
  console.log(
    `   Synced CHANGELOG.md into draft ${TAG_NAME} (${body.length} chars).`,
  );
  return updated;
}

async function listReleaseAssets(releaseId) {
  return listAllReleaseAssets((page, perPage) =>
    githubRequestWithRetry(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    ),
  );
}

async function uploadImmutableDraftAsset(release, filePath) {
  await loadReleaseById(release.id);
  const assets = await listReleaseAssets(release.id);
  const name = path.basename(filePath);
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length > 1)
    throw new Error(`Draft has duplicate assets named ${name}.`);
  const action = classifyImmutableAsset(matches[0], filePath);
  if (action === "skip") {
    console.log(`   Descriptor asset already matches: ${name}`);
    return;
  }
  await loadReleaseById(release.id);
  uploadReleaseAssetById(REPOSITORY, release.id, filePath);
  console.log(`   Uploaded immutable descriptor asset: ${name}`);
}

function descriptorAssets(assets) {
  const byName = new Map(assets.map((asset) => [asset?.name, asset]));
  return {
    descriptor: byName.get(DESCRIPTOR_NAME),
    signature: byName.get(DESCRIPTOR_SIGNATURE_NAME),
  };
}

async function downloadAndValidateDescriptor(
  release,
  descriptorAsset,
  signatureAsset,
) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  downloadReleaseAsset(REPOSITORY, descriptorAsset.id, DESCRIPTOR_PATH);
  downloadReleaseAsset(
    REPOSITORY,
    signatureAsset.id,
    DESCRIPTOR_SIGNATURE_PATH,
  );
  verifyDescriptorSignature(DESCRIPTOR_PATH, DESCRIPTOR_SIGNATURE_PATH);
  const descriptor = readReleaseDescriptor(DESCRIPTOR_PATH);
  validateDescriptorForCheckout(descriptor, {
    root: REPOSITORY_ROOT,
    release,
    repository: { name: REPO_NAME, owner: REPO_OWNER },
  });
  return descriptor;
}

async function ensureCanonicalDescriptor(release, { waitOnly = false } = {}) {
  await assertExistingTagMatchesSource();
  const assets = await listReleaseAssets(release.id);
  const { descriptor: descriptorAsset, signature: signatureAsset } =
    descriptorAssets(assets);
  if (descriptorAsset && signatureAsset) {
    await downloadAndValidateDescriptor(
      release,
      descriptorAsset,
      signatureAsset,
    );
    console.log(
      `   Consumed signed descriptor bound to release id ${release.id}.`,
    );
    return true;
  }
  if (waitOnly) return false;
  if (signatureAsset && !descriptorAsset) {
    throw new Error(
      "Draft contains a descriptor signature without its descriptor; refusing repair by replacement.",
    );
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  if (descriptorAsset) {
    downloadReleaseAsset(REPOSITORY, descriptorAsset.id, DESCRIPTOR_PATH);
    const descriptor = readReleaseDescriptor(DESCRIPTOR_PATH);
    validateDescriptorForCheckout(descriptor, {
      root: REPOSITORY_ROOT,
      release,
      repository: { name: REPO_NAME, owner: REPO_OWNER },
    });
  } else {
    const descriptor = createReleaseDescriptor({
      root: REPOSITORY_ROOT,
      release,
    });
    writeReleaseDescriptor(DESCRIPTOR_PATH, descriptor);
    await uploadImmutableDraftAsset(release, DESCRIPTOR_PATH);
  }
  signDescriptor(DESCRIPTOR_PATH, DESCRIPTOR_SIGNATURE_PATH);
  await uploadImmutableDraftAsset(release, DESCRIPTOR_SIGNATURE_PATH);
  verifyDescriptorSignature(DESCRIPTOR_PATH, DESCRIPTOR_SIGNATURE_PATH);
  console.log(
    `   Canonical signed descriptor is ready for release id ${release.id}.`,
  );
  return true;
}

async function ensureDraftRelease({ assertSource = assertCleanSource } = {}) {
  const checkedCommit = assertSource(REPOSITORY_ROOT, {
    expectedCommit: SOURCE_COMMIT,
  });
  try {
    console.log(`Ensuring immutable draft release exists for ${TAG_NAME}...`);
    const body = readChangelogReleaseBody();
    let release = await findExistingRelease();
    if (release) {
      release = await syncReleaseNotesBody(release, body);
    } else {
      console.log("   No release found. Creating draft...");
      try {
        release = await githubRequestWithRetry(
          "POST",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
          {
            tag_name: TAG_NAME,
            name: formatReleaseTitle(VERSION),
            body,
            draft: true,
            prerelease: IS_PRERELEASE,
            target_commitish: SOURCE_COMMIT,
          },
        );
        validateMutableRelease(release, releaseValidationOptions(release.id));
      } catch (error) {
        if (error.statusCode !== 422) throw error;
        await sleep(2000);
        release = await findExistingRelease();
        if (!release) throw error;
        release = await syncReleaseNotesBody(release, body);
      }
    }
    await ensureCanonicalDescriptor(release);
    return release;
  } finally {
    assertSource(REPOSITORY_ROOT, { expectedCommit: checkedCommit });
  }
}

async function waitForDraftRelease({ assertSource = assertCleanSource } = {}) {
  const checkedCommit = assertSource(REPOSITORY_ROOT, {
    expectedCommit: SOURCE_COMMIT,
  });
  try {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    console.log(
      `Waiting for canonical draft ${TAG_NAME}; this host will never create or patch it...`,
    );
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const release = await findExistingRelease();
      if (
        release &&
        (await ensureCanonicalDescriptor(release, { waitOnly: true }))
      ) {
        console.log(
          `   Found descriptor-bound draft id ${release.id}. Proceeding.`,
        );
        return release;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for signed descriptor on draft ${TAG_NAME}. Run release:draft on the coordinator first.`,
        );
      }
      console.log(
        `   Draft/descriptor not ready (attempt ${attempt}); retrying in ${Math.round(WAIT_POLL_INTERVAL_MS / 1000)}s...`,
      );
      await sleep(WAIT_POLL_INTERVAL_MS);
    }
  } finally {
    assertSource(REPOSITORY_ROOT, { expectedCommit: checkedCommit });
  }
}

async function main() {
  assertGitHubCliAuthenticated();
  if (WAIT_MODE) await waitForDraftRelease();
  else await ensureDraftRelease();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `✗ ERROR: Failed to prepare canonical draft: ${error && error.message ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

module.exports = {
  SOURCE_COMMIT,
  assertExistingTagMatchesSource,
  descriptorAssets,
  ensureCanonicalDescriptor,
  ensureDraftRelease,
  findExistingRelease,
  isRetryableGithubError,
  readChangelogReleaseBody,
  releaseValidationOptions,
  syncReleaseNotesBody,
  uploadImmutableDraftAsset,
  waitForDraftRelease,
};
