#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDirectExecution } from "./direct-execution.js";
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
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const VERSION = packageJson.version;
const TAG = `v${VERSION}`;
const IS_PRERELEASE = /-beta\.\d+$/.test(VERSION);
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";

export function requiredDraftInstallerNames() {
  return [
    "S3-Sidekick-Windows-x64.exe",
    "S3-Sidekick-Windows-x64.msi",
    "S3-Sidekick-Windows-arm64.exe",
    "S3-Sidekick-Windows-arm64.msi",
    "S3-Sidekick-macOS.app.tar.gz",
    "S3-Sidekick-macOS.dmg",
    "S3-Sidekick-macOS.zip",
    "S3-Sidekick-Linux-x64.AppImage",
    "S3-Sidekick-Linux-x64.deb",
    "S3-Sidekick-Linux-x64.rpm",
    "S3-Sidekick-Linux-x64.flatpak",
  ];
}

export function requiredDraftManifestNames() {
  const keys = [
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
  ];
  if (IS_PRERELEASE) {
    keys.push(
      "windows-beta-x86_64",
      "windows-beta-aarch64",
      "darwin-beta-x86_64",
      "darwin-beta-aarch64",
      "linux-beta-x86_64",
    );
  }
  return keys.map((key) => `latest-${key}.json`);
}

function updaterArtifacts() {
  return [
    "S3-Sidekick-Windows-x64.exe",
    "S3-Sidekick-Windows-arm64.exe",
    "S3-Sidekick-macOS.app.tar.gz",
    "S3-Sidekick-Linux-x64.AppImage",
  ];
}

export function requiredDraftAssetNames() {
  const installers = requiredDraftInstallerNames();
  const sidecars = installers.flatMap((name) => [
    `${name}.asc`,
    ...(updaterArtifacts().includes(name) ? [`${name}.sig`] : []),
  ]);
  const checksums = [
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
    ...(IS_PRERELEASE
      ? [
          "windows-beta-x86_64",
          "windows-beta-aarch64",
          "darwin-beta-x86_64",
          "darwin-beta-aarch64",
          "linux-beta-x86_64",
        ]
      : []),
  ].flatMap((key) => [`SHA256SUMS-${key}.txt`, `SHA256SUMS-${key}.txt.asc`]);
  return [
    ...installers,
    ...sidecars,
    ...requiredDraftManifestNames().flatMap((name) => [name, `${name}.asc`]),
    ...checksums,
  ].sort();
}

export function assertDraftReleaseShape({
  release,
  assetNames,
  headCommit,
  version = VERSION,
}) {
  const tag = `v${version}`;
  const expectedPrerelease = /-beta\.\d+$/.test(version);
  if (!release?.draft) throw new Error(`Release ${tag} must still be a draft.`);
  if (Boolean(release.prerelease) !== expectedPrerelease) {
    throw new Error(`Release ${tag} has incorrect prerelease state.`);
  }
  if (headCommit && release.target_commitish !== headCommit) {
    throw new Error(`Release ${tag} does not target HEAD ${headCommit}.`);
  }
  const present = new Set(assetNames);
  const missing = requiredDraftAssetNames().filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Draft ${tag} is missing required assets: ${missing.join(", ")}.`,
    );
  }
  return true;
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

function loadDraft() {
  const releases = listReleases();
  assertNoMisnamedVersionDrafts(releases, TAG);
  const matches = releases.filter((release) =>
    isExpectedRelease(release, TAG, VERSION),
  );
  const drafts = matches.filter((release) => release.draft);
  if (drafts.length !== 1) {
    throw new Error(
      `Expected one draft release ${TAG}; found ${drafts.length}.`,
    );
  }
  return assertExpectedRelease(drafts[0], TAG, VERSION, "Draft verification");
}

function currentHead() {
  return execSync("git rev-parse HEAD", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertManifestReferences(manifest, name, assetNames) {
  if (manifest?.version !== VERSION) {
    throw new Error(
      `${name} reports version ${JSON.stringify(manifest?.version)}.`,
    );
  }
  const platforms = manifest?.platforms;
  if (!platforms || Object.keys(platforms).length === 0) {
    throw new Error(`${name} has no platform entries.`);
  }
  for (const [target, entry] of Object.entries(platforms)) {
    if (
      typeof entry?.url !== "string" ||
      typeof entry?.signature !== "string"
    ) {
      throw new Error(`${name} has invalid platform ${target}.`);
    }
    const url = new URL(entry.url);
    const fileName = decodeURIComponent(url.pathname.split("/").at(-1) || "");
    const expectedPrefix =
      `/` + `${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/`;
    if (
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(expectedPrefix) ||
      !assetNames.has(fileName)
    ) {
      throw new Error(`${name} points outside this draft: ${entry.url}`);
    }
    if (!assetNames.has(`${fileName}.sig`)) {
      throw new Error(`${name} references ${fileName} without its .sig asset.`);
    }
  }
}

async function verifyUpdaterArtifacts(release, assets) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-draft-"));
  try {
    const byName = new Map(assets.map((asset) => [asset.name, asset]));
    for (const name of updaterArtifacts()) {
      const artifact = byName.get(name);
      const signature = byName.get(`${name}.sig`);
      if (!artifact || !signature)
        throw new Error(`Missing updater asset ${name}.`);
      const artifactPath = path.join(temp, name);
      const signaturePath = `${artifactPath}.sig`;
      downloadReleaseAsset(
        `${REPO_OWNER}/${REPO_NAME}`,
        artifact.id,
        artifactPath,
      );
      downloadReleaseAsset(
        `${REPO_OWNER}/${REPO_NAME}`,
        signature.id,
        signaturePath,
      );
      if (!normalizeUpdaterSignature(signaturePath)) {
        throw new Error(`Empty updater signature ${name}.sig.`);
      }
      verifyUpdaterSignature(artifactPath, signaturePath);
    }
  } finally {
    fs.rmSync(temp, { force: true, recursive: true });
  }
  return release;
}

async function main() {
  assertGitHubCliAuthenticated();
  const release = loadDraft();
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  const assetNames = new Set(assets.map((asset) => asset.name));
  assertDraftReleaseShape({
    assetNames: [...assetNames],
    headCommit: currentHead(),
    release,
  });
  const manifestDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-manifest-"),
  );
  try {
    for (const asset of assets.filter((item) =>
      /^latest-[a-z0-9_-]+\.json$/i.test(item.name),
    )) {
      const manifestPath = path.join(manifestDirectory, asset.name);
      downloadReleaseAsset(
        `${REPO_OWNER}/${REPO_NAME}`,
        asset.id,
        manifestPath,
      );
      assertManifestReferences(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        asset.name,
        assetNames,
      );
    }
  } finally {
    fs.rmSync(manifestDirectory, { force: true, recursive: true });
  }
  if (process.argv.includes("--verify-artifacts")) {
    await verifyUpdaterArtifacts(release, assets);
  }
  console.log(`verify-draft: ok (${TAG}, ${assets.length} assets).`);
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `verify-draft: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
