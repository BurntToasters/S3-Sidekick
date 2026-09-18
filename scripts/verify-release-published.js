#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";
import {
  requiredDraftAssetNames,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import {
  normalizeUpdaterSignature,
  verifyUpdaterSignature,
} from "./gpg-sign.js";

const require = createRequire(import.meta.url);
const {
  assertGitHubCliAuthenticated,
  downloadReleaseAsset,
  githubApi,
} = require("./github-cli.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const tag = `v${version}`;
const owner = process.env.GH_REPO_OWNER || "BurntToasters";
const repository = process.env.GH_REPO_NAME || "S3-Sidekick";

function loadRelease() {
  const release = githubApi(
    "GET",
    `/repos/${owner}/${repository}/releases/tags/${tag}`,
  );
  if (release.draft) throw new Error(`${tag} is still a draft.`);
  if (Boolean(release.prerelease) !== /-beta\.\d+$/.test(version)) {
    throw new Error(`${tag} has incorrect prerelease state.`);
  }
  return release;
}

function listAssets(releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${owner}/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

async function verifyUpdaterAssets(assets) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-live-"));
  try {
    for (const asset of assets.filter((item) => item.name.endsWith(".sig"))) {
      const artifactName = asset.name.slice(0, -4);
      if (
        !/\.app\.tar\.gz$|\.exe$|\.AppImage$/i.test(artifactName) ||
        !requiredDraftAssetNames().includes(artifactName)
      ) {
        continue;
      }
      const artifact = assets.find((item) => item.name === artifactName);
      if (!artifact)
        throw new Error(`Missing live updater artifact ${artifactName}.`);
      const artifactPath = path.join(temp, artifactName);
      const signaturePath = path.join(temp, asset.name);
      downloadReleaseAsset(`${owner}/${repository}`, artifact.id, artifactPath);
      downloadReleaseAsset(`${owner}/${repository}`, asset.id, signaturePath);
      normalizeUpdaterSignature(signaturePath);
      verifyUpdaterSignature(artifactPath, signaturePath);
    }
  } finally {
    fs.rmSync(temp, { force: true, recursive: true });
  }
}

async function main() {
  assertGitHubCliAuthenticated();
  const release = loadRelease();
  const assets = listAssets(release.id);
  const names = new Set(assets.map((asset) => asset.name));
  for (const name of requiredDraftAssetNames()) {
    if (!names.has(name))
      throw new Error(`Published release is missing ${name}.`);
  }
  for (const name of requiredDraftManifestNames()) {
    if (!names.has(name))
      throw new Error(`Published release is missing ${name}.`);
  }
  await verifyUpdaterAssets(assets);
  const live = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "validate-updater-live.js"),
      "--expected-version=current",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (live.error) throw live.error;
  if (live.status !== 0) {
    throw new Error(
      "Live /releases/latest updater verification failed; beta clients cannot discover this feed.",
    );
  }
  console.log(`verify-published: ok (${tag}, ${assets.length} assets).`);
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `verify-published: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
