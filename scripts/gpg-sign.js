#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDirectExecution } from "./direct-execution.js";
import { verifyReleaseSession } from "./release-session.js";
import githubCli from "./github-cli.cjs";

const {
  assertGitHubCliAuthenticated,
  deleteReleaseAssetById,
  downloadReleaseAsset,
  githubApi,
  uploadReleaseAssetById,
} = githubCli;
const require = createRequire(import.meta.url);
const {
  assertReleaseToolVersions,
  signDetachedFile,
} = require("./release-integrity.cjs");
const {
  assertStableReleaseOverridesAllowed,
  isExplicitTruthy,
  isStableReleaseVersion,
} = require("./release-policy.cjs");
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");
const { assertReleaseTargetsHead } = require("./release-draft-target.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const VERSION = pkg.version;
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
const EXPECTED_TAG = (process.env.EXPECTED_TAG || "").trim();
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const REPOSITORY = `${REPO_OWNER}/${REPO_NAME}`;
const RELEASE_NOTES = process.env.RELEASE_NOTES || "";
const RELEASE_PUB_DATE =
  process.env.RELEASE_PUB_DATE || new Date().toISOString();
const UPDATER_PUBLIC_KEY = tauriConfig.plugins?.updater?.pubkey;
const TAG_DOWNLOAD_BASE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(TAG)}`;
const RELEASE_BASE_URL = (
  process.env.RELEASE_DOWNLOAD_BASE_URL || TAG_DOWNLOAD_BASE_URL
).replace(/\/+$/, "");
const ALLOW_ASSET_REPLACE = isExplicitTruthy(process.env.ALLOW_ASSET_REPLACE);
const ENFORCE_LINUX_X64_PACKAGE_SET =
  isStableReleaseVersion(VERSION) ||
  !/^(0|false|no|off)$/i.test(
    String(process.env.ENFORCE_LINUX_X64_PACKAGE_SET || "").trim(),
  );
const BETA_SYNC_LOCK_NAME = "s3-sidekick-beta-manifest-sync-lock";
const BETA_SYNC_LOCK_RETRIES = 30;
const ARTIFACT_RULES = [
  /\.(?:exe|msi|dmg|deb|rpm|flatpak)$/i,
  /\.(?:appimage|app\.tar\.gz|zip)$/i,
];
const SIGN_RULES = ARTIFACT_RULES;
const MANIFEST_PATTERN = /^latest-[a-z0-9_-]+\.json$/i;
const CHECKSUM_PATTERN = /^SHA256SUMS-[a-z0-9_-]+\.txt$/i;

function currentCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function assertReleaseTargetsCommit(
  release,
  commit,
  env = process.env,
  log = console,
) {
  return assertReleaseTargetsHead(release, commit, {
    action: "uploading assets",
    env,
    isPrerelease: IS_PRERELEASE,
    log,
    root,
    tag: TAG,
  });
}

function isArtifact(name) {
  return ARTIFACT_RULES.some((pattern) => pattern.test(name));
}

function isSignable(name) {
  return SIGN_RULES.some((pattern) => pattern.test(name));
}

function releaseArtifactSearchDirs(
  targetRoot = path.join(root, "src-tauri", "target"),
) {
  const dirs = [
    path.join(targetRoot, "release", "bundle"),
    path.join(root, "dist"),
  ];
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(path.join(targetRoot, entry.name, "release", "bundle"));
    }
  } catch {
    // Missing target/ is fine before the first host build.
  }
  return dirs;
}

function walk(directory, result = []) {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, result);
    else if (entry.isFile() && isArtifact(entry.name)) result.push(fullPath);
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rpmArtifactMatchesVersion(name, releaseVersion = VERSION) {
  if (!/\.rpm(?:\.sig)?$/i.test(name)) return false;

  const numericVersions = name.match(/\d+\.\d+\.\d+/g);
  if (!numericVersions || numericVersions.length === 0) return true;

  const betaMatch = releaseVersion.match(
    /^(\d+\.\d+\.\d+)-beta\.(0|[1-9]\d*)$/,
  );
  const stableMatch = releaseVersion.match(/^(\d+\.\d+\.\d+)$/);
  if (!betaMatch && !stableMatch) return false;

  const numericVersion = betaMatch?.[1] ?? stableMatch[1];
  const escapedNumericVersion = escapeRegExp(numericVersion);
  const versionPattern = betaMatch
    ? `${escapedNumericVersion}(?:-beta\\.${betaMatch[2]}|[._~]beta[._-]${betaMatch[2]})`
    : escapedNumericVersion;
  const rpmRelease = "[0-9][0-9A-Za-z_+~%^.-]*";
  const rpmArch =
    "(?:x86_64|amd64|aarch64|arm64|i[3-6]86|noarch|ppc64le|ppc64|s390x|riscv64|armv[67]hl)";
  return new RegExp(
    `(?:^|[^0-9A-Za-z])${versionPattern}(?:-${rpmRelease})?(?:\\.${rpmArch})?\\.rpm(?:\\.sig)?$`,
    "i",
  ).test(name);
}

function artifactMatchesVersion(name, releaseVersion = VERSION) {
  if (/\.rpm(?:\.sig)?$/i.test(name)) {
    return rpmArtifactMatchesVersion(name, releaseVersion);
  }
  const versions = name.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g,
  );
  return !versions || versions.some((value) => value === releaseVersion);
}

function inferArch(name) {
  if (/(?:^|[-_.])(aarch64|arm64)(?:[-_.]|$)/i.test(name)) return "aarch64";
  if (/(?:^|[-_.])(x86_64|amd64|x64)(?:[-_.]|$)/i.test(name)) return "x86_64";
  return null;
}

function resolveUpdaterTargets(name) {
  if (/\.app\.tar\.gz$/i.test(name)) {
    return ["x86_64", "aarch64"].map((arch) => ({
      arch,
      installer: "app",
      os: "darwin",
    }));
  }
  const arch = inferArch(name);
  if (!arch) return [];
  if (/\.exe$/i.test(name)) return [{ arch, installer: "nsis", os: "windows" }];
  if (/\.appimage$/i.test(name)) {
    return [{ arch, installer: "appimage", os: "linux" }];
  }
  return [];
}

function cleanArtifactName(name) {
  if (/\.app\.tar\.gz$/i.test(name)) return "S3-Sidekick-macOS.app.tar.gz";
  if (/\.dmg$/i.test(name)) return "S3-Sidekick-macOS.dmg";
  if (/^S3(?:[ ._-])Sidekick\.zip$/i.test(name)) {
    return "S3-Sidekick-macOS.zip";
  }
  if (/x64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-x64.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-arm64.exe";
  if (/_x64_en-US\.msi$/i.test(name)) return "S3-Sidekick-Windows-x64.msi";
  if (/_arm64_en-US\.msi$/i.test(name)) return "S3-Sidekick-Windows-arm64.msi";
  if (/amd64\.AppImage$/i.test(name)) return "S3-Sidekick-Linux-x64.AppImage";
  if (/aarch64\.AppImage$/i.test(name))
    return "S3-Sidekick-Linux-arm64.AppImage";
  if (/amd64\.deb$/i.test(name)) return "S3-Sidekick-Linux-x64.deb";
  if (/aarch64\.deb$/i.test(name)) return "S3-Sidekick-Linux-arm64.deb";
  if (/x86_64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-x64.rpm";
  if (/aarch64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-arm64.rpm";
  return name;
}

function assertLinuxX64PackageSet(
  byName,
  { enforce = ENFORCE_LINUX_X64_PACKAGE_SET } = {},
) {
  if (!enforce) return;
  const names = [...byName.keys()].filter((name) => !name.endsWith(".sig"));
  if (!names.some((name) => /^S3-Sidekick-Linux-x64\./i.test(name))) return;
  const required = [
    "S3-Sidekick-Linux-x64.AppImage",
    "S3-Sidekick-Linux-x64.deb",
    "S3-Sidekick-Linux-x64.rpm",
    "S3-Sidekick-Linux-x64.flatpak",
  ];
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Linux x86_64 bundle set: missing ${missing.join(", ")} artifact(s).`,
    );
  }
}

function readBuildSession() {
  try {
    return verifyReleaseSession(root);
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. Run npm run release:prepare before building: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function wasBuiltInSession(filePath, session) {
  try {
    return fs.statSync(filePath).mtimeMs >= session.startedAt - 2000;
  } catch {
    return false;
  }
}

function clearStaging() {
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const name of fs.readdirSync(releaseDir)) {
    if (
      isArtifact(name) ||
      name.endsWith(".asc") ||
      name.endsWith(".sig") ||
      MANIFEST_PATTERN.test(name) ||
      CHECKSUM_PATTERN.test(name)
    ) {
      fs.rmSync(path.join(releaseDir, name), { force: true });
    }
  }
}

function updaterSignatureText(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

function normalizeUpdaterSignature(filePath) {
  const value = updaterSignatureText(filePath);
  if (!value) throw new Error(`Updater signature is empty: ${filePath}`);
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.includes("untrusted comment:")) return value;
  } catch {
    // Treat non-base64 input as raw Minisign text.
  }
  return value.includes("untrusted comment:")
    ? Buffer.from(value, "utf8").toString("base64")
    : value;
}

function decodeSignature(value, label) {
  const decoded = Buffer.from(String(value).replace(/\s/g, ""), "base64");
  if (!decoded.length) throw new Error(`Malformed ${label}.`);
  return decoded;
}

function verifyUpdaterSignature(filePath, signaturePath) {
  const encodedSignature = normalizeUpdaterSignature(signaturePath);
  if (!UPDATER_PUBLIC_KEY) {
    throw new Error("Updater public key is missing from tauri.conf.json.");
  }
  const signatureText = decodeSignature(
    encodedSignature,
    `updater signature ${path.basename(signaturePath)}`,
  ).toString("utf8");
  const signatureLines = signatureText.trim().split(/\r?\n/);
  if (
    signatureLines.length < 4 ||
    !signatureLines[0].startsWith("untrusted comment: ") ||
    !signatureLines[2].startsWith("trusted comment: ")
  ) {
    throw new Error(
      `Malformed updater signature: ${path.basename(signaturePath)}`,
    );
  }
  const signed = decodeSignature(signatureLines[1], "updater signature");
  const global = decodeSignature(signatureLines[3], "updater global signature");
  if (
    signed.length !== 74 ||
    global.length !== 64 ||
    signed.subarray(0, 2).toString() !== "ED"
  ) {
    throw new Error(
      `Unsupported updater signature: ${path.basename(signaturePath)}`,
    );
  }
  const publicText = decodeSignature(
    UPDATER_PUBLIC_KEY,
    "updater public key",
  ).toString("utf8");
  const publicLines = publicText.trim().split(/\r?\n/);
  const publicBytes = decodeSignature(publicLines[1], "updater public key");
  if (
    publicBytes.length !== 42 ||
    publicBytes.subarray(0, 2).toString() !== "Ed"
  ) {
    throw new Error("Malformed updater public key.");
  }
  if (
    !crypto.timingSafeEqual(signed.subarray(2, 10), publicBytes.subarray(2, 10))
  ) {
    throw new Error(`Updater key mismatch: ${path.basename(filePath)}`);
  }
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicBytes.subarray(10, 42),
    ]),
    format: "der",
    type: "spki",
  });
  const digest = crypto
    .createHash("blake2b512")
    .update(fs.readFileSync(filePath))
    .digest();
  if (!crypto.verify(null, digest, publicKey, signed.subarray(10))) {
    throw new Error(
      `Updater signature verification failed: ${path.basename(filePath)}`,
    );
  }
  const trusted = Buffer.concat([
    signed.subarray(10),
    Buffer.from(signatureLines[2].slice("trusted comment: ".length)),
  ]);
  if (!crypto.verify(null, trusted, publicKey, global)) {
    throw new Error(
      `Updater trusted-comment verification failed: ${path.basename(filePath)}`,
    );
  }
  return true;
}

function releaseAssetUrl(name, baseUrl = RELEASE_BASE_URL) {
  return `${baseUrl}/${encodeURIComponent(name)}`;
}

function validateGeneratedManifests(generated) {
  const validation = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "validate-updater-manifest.js"), ...generated],
    { cwd: root, encoding: "utf8" },
  );
  if (validation.error) throw validation.error;
  if (validation.status !== 0) {
    throw new Error(
      `Generated updater manifest validation failed: ${validation.stderr || validation.stdout}`,
    );
  }
}

function generateUpdaterManifests(files, outputDirectory = releaseDir) {
  const byName = new Map(
    files.map((filePath) => [path.basename(filePath), filePath]),
  );
  const signatures = new Map(
    files
      .filter((filePath) => path.basename(filePath).endsWith(".sig"))
      .map((filePath) => [path.basename(filePath).slice(0, -4), filePath]),
  );
  const channels = [
    { baseUrl: RELEASE_BASE_URL, suffix: "" },
    { baseUrl: RELEASE_BASE_URL, suffix: "-beta" },
  ];
  const manifests = new Map();
  for (const [name, filePath] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    if (targets.length === 0) continue;
    const signaturePath = signatures.get(name);
    if (!signaturePath)
      throw new Error(`Missing updater signature: ${name}.sig`);
    verifyUpdaterSignature(filePath, signaturePath);
    for (const channel of channels) {
      for (const target of targets) {
        const targetName = `${target.os}${channel.suffix}`;
        const manifestName = `latest-${targetName}-${target.arch}.json`;
        const manifest = manifests.get(manifestName) || {
          notes: RELEASE_NOTES,
          platforms: {},
          pub_date: RELEASE_PUB_DATE,
          version: VERSION,
        };
        const installerKey = `${targetName}-${target.arch}-${target.installer}`;
        const fallbackKey = `${targetName}-${target.arch}`;
        const entry = {
          signature: normalizeUpdaterSignature(signaturePath),
          url: releaseAssetUrl(name, channel.baseUrl),
        };
        manifest.platforms[installerKey] = entry;
        if (!manifest.platforms[fallbackKey])
          manifest.platforms[fallbackKey] = entry;
        if (
          channel.suffix === "-beta" &&
          target.installer ===
            { darwin: "app", windows: "nsis", linux: "appimage" }[target.os]
        ) {
          manifest.platforms[targetName] = entry;
        }
        manifests.set(manifestName, manifest);
      }
    }
  }
  const output = [];
  for (const [name, manifest] of [...manifests.entries()].sort()) {
    const filePath = path.join(outputDirectory, name);
    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    output.push(filePath);
  }
  if (output.length > 0) validateGeneratedManifests(output);
  return output;
}

function targetKeysForArtifact(name) {
  const manifest = name.match(/^latest-([a-z0-9_-]+)\.json$/i);
  if (manifest) return [manifest[1].toLowerCase()];
  const baseName = name.endsWith(".sig") ? name.slice(0, -4) : name;
  const targets = resolveUpdaterTargets(baseName);
  if (targets.length > 0) {
    return targets.flatMap((target) => [
      `${target.os}-${target.arch}`,
      `${target.os}-beta-${target.arch}`,
    ]);
  }
  const arch = inferArch(baseName);
  if (
    /^S3-Sidekick-Linux-(?:x64|arm64)\.(?:deb|rpm|flatpak)$/i.test(baseName)
  ) {
    return [`linux-${arch}`, `linux-beta-${arch}`];
  }
  if (/^S3-Sidekick-Windows-(?:x64|arm64)\.msi$/i.test(baseName)) {
    return [`windows-${arch}`, `windows-beta-${arch}`];
  }
  if (/^S3-Sidekick-macOS\.(?:dmg|zip)$/i.test(baseName)) {
    return [
      "darwin-x86_64",
      "darwin-aarch64",
      "darwin-beta-x86_64",
      "darwin-beta-aarch64",
    ];
  }
  return ["generic"];
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function generateChecksums(files) {
  const buckets = new Map();
  for (const filePath of files) {
    const name = path.basename(filePath);
    if (name.endsWith(".asc") || CHECKSUM_PATTERN.test(name)) continue;
    for (const key of targetKeysForArtifact(name)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(filePath);
    }
  }
  return [...buckets.entries()].sort().map(([key, values]) => {
    const filePath = path.join(releaseDir, `SHA256SUMS-${key}.txt`);
    const lines = [...new Set(values)]
      .sort((left, right) =>
        path.basename(left).localeCompare(path.basename(right)),
      )
      .map((value) => `${sha256(value)}  ${path.basename(value)}`);
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
  });
}

function signFile(filePath) {
  const signaturePath = `${filePath}.asc`;
  signDetachedFile(filePath, signaturePath, { environment: process.env });
  return signaturePath;
}

function signFiles(files) {
  return files
    .filter((filePath) => {
      const name = path.basename(filePath);
      return (
        isSignable(name) ||
        MANIFEST_PATTERN.test(name) ||
        CHECKSUM_PATTERN.test(name)
      );
    })
    .map(signFile);
}

function listGithubPages(endpoint) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function listReleaseAssets(releaseId) {
  return listGithubPages(
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets`,
  );
}

function listReleases() {
  return listGithubPages(`/repos/${REPO_OWNER}/${REPO_NAME}/releases`);
}

function findDraft() {
  const commit = currentCommit();
  let tagged;
  try {
    tagged = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`,
    );
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }
  if (tagged) {
    return assertReleaseTargetsCommit(
      assertExpectedRelease(tagged, TAG, VERSION, "Signing release"),
      commit,
    );
  }
  const releases = listReleases();
  assertNoMisnamedVersionDrafts(releases, TAG, VERSION);
  const drafts = releases.filter(
    (release) => release?.draft && isExpectedRelease(release, TAG, VERSION),
  );
  if (drafts.length !== 1) {
    throw new Error(
      `Expected one draft release ${TAG}; found ${drafts.length}. No GitHub release exists for ${TAG}. Create the draft with npm run release:draft on Windows first; Mac/Linux wait for that draft.`,
    );
  }
  return assertReleaseTargetsCommit(
    assertExpectedRelease(drafts[0], TAG, VERSION, "Signing release"),
    commit,
  );
}

function isGitHubConflict(error) {
  if (error?.statusCode === 422) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\((?:HTTP )?422\)|"status"\s*:\s*"?422"?/.test(message);
}

function isRetryableUploadError(error) {
  if (isGitHubConflict(error)) return false;
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(
    Number(error?.statusCode),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadAssetOnce(release, filePath) {
  const uploaded = uploadReleaseAssetById(REPOSITORY, release.id, filePath);
  if (!uploaded || typeof uploaded.id !== "number") {
    throw new Error(
      `Upload ${path.basename(filePath)} succeeded but GitHub returned no asset id.`,
    );
  }
  return uploaded;
}

async function uploadAsset(release, filePath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await uploadAssetOnce(release, filePath);
    } catch (error) {
      lastError = error;
      if (
        isGitHubConflict(error) ||
        attempt === 3 ||
        !isRetryableUploadError(error)
      ) {
        throw error;
      }
      await sleep(attempt * 1000);
    }
  }
  throw lastError;
}

async function uploadAssetWithReplace(release, filePath) {
  try {
    await uploadAsset(release, filePath);
  } catch (error) {
    if (!isGitHubConflict(error)) throw error;
    const name = path.basename(filePath);
    const existing = listReleaseAssets(release.id).find(
      (asset) => asset?.name === name && typeof asset.id === "number",
    );
    if (!existing) throw error;
    const remoteDigest = String(existing.digest || "").replace(/^sha256:/, "");
    if (remoteDigest && remoteDigest === sha256(filePath)) return;
    if (!release.draft && !ALLOW_ASSET_REPLACE) {
      throw new Error(
        `Refusing to replace existing asset "${name}" on published release ${TAG}. Set ALLOW_ASSET_REPLACE=true to override.`,
      );
    }
    deleteReleaseAssetById(REPOSITORY, existing.id);
    await uploadAsset(release, filePath);
  }
}

function collectArtifacts() {
  const session = readBuildSession();
  const discovered = releaseArtifactSearchDirs()
    .flatMap((directory) => walk(directory))
    .filter(
      (filePath) =>
        artifactMatchesVersion(path.basename(filePath)) &&
        wasBuiltInSession(filePath, session),
    );
  if (discovered.length === 0) {
    throw new Error("No current release artifacts found.");
  }
  clearStaging();
  const selected = new Map();
  for (const source of discovered) {
    const name = cleanArtifactName(path.basename(source));
    const existing = selected.get(name);
    if (
      !existing ||
      fs.statSync(source).mtimeMs > fs.statSync(existing).mtimeMs
    ) {
      selected.set(name, source);
    }
  }
  assertLinuxX64PackageSet(selected);
  const artifacts = [];
  const updaterSignatures = [];
  for (const [name, source] of selected) {
    const destination = path.join(releaseDir, name);
    fs.copyFileSync(source, destination);
    artifacts.push(destination);
    const sourceSignature = `${source}.sig`;
    if (fs.existsSync(sourceSignature)) {
      const destinationSignature = `${destination}.sig`;
      fs.copyFileSync(sourceSignature, destinationSignature);
      updaterSignatures.push(destinationSignature);
    }
  }
  const manifests = generateUpdaterManifests([
    ...artifacts,
    ...updaterSignatures,
  ]);
  return [...artifacts, ...updaterSignatures, ...manifests];
}

async function removeAssetBestEffort(asset, label) {
  if (!asset || typeof asset.id !== "number") return;
  try {
    deleteReleaseAssetById(REPOSITORY, asset.id);
  } catch (error) {
    console.warn(
      `  ! could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isTransactionalStagingAssetName(name) {
  return /^(?:default\.)?s3-sidekick-(?:pending|previous|rollback)-/i.test(
    name,
  );
}

async function findBetaManifestSyncLock(releaseId) {
  return (
    listReleaseAssets(releaseId).find(
      (asset) => asset?.name === BETA_SYNC_LOCK_NAME,
    ) ?? null
  );
}

async function assertOwnsBetaManifestSyncLock(release, acquired) {
  if (!acquired || typeof acquired.id !== "number") {
    throw new Error("Beta-manifest synchronization lock was not acquired.");
  }
  const current = await findBetaManifestSyncLock(release.id);
  if (!current || current.id !== acquired.id) {
    throw new Error(
      "Lost the beta-manifest synchronization lock before mutating live feeds.",
    );
  }
}

async function replaceReleaseAssetsTransactionally(
  release,
  files,
  { assertStillHeld = null } = {},
) {
  if (files.length === 0) return;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-release-replace-"),
  );
  const token = crypto.randomBytes(8).toString("hex");
  const staged = [];
  const swapped = [];
  try {
    const assets = listReleaseAssets(release.id);
    for (const filePath of files) {
      const name = path.basename(filePath);
      const existing = assets.find((asset) => asset?.name === name);
      const stagedName = `s3-sidekick-pending-${token}-${name}`;
      const stagedPath = path.join(temporaryDirectory, stagedName);
      fs.copyFileSync(filePath, stagedPath);
      const uploaded = await uploadAsset(release, stagedPath);
      staged.push({
        name,
        existing: existing && typeof existing.id === "number" ? existing : null,
        uploaded,
        backupName: `s3-sidekick-previous-${token}-${name}`,
        previousRenamed: false,
      });
    }
    if (typeof assertStillHeld === "function") {
      await assertStillHeld();
    }
    for (const item of staged) {
      if (item.existing) {
        githubApi(
          "PATCH",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
          { name: item.backupName },
        );
        item.previousRenamed = true;
      }
      try {
        githubApi(
          "PATCH",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
          { name: item.name },
        );
      } catch (error) {
        if (item.existing) {
          githubApi(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
            { name: item.name },
          );
          item.previousRenamed = false;
        }
        throw error;
      }
      swapped.push(item);
    }
    for (const item of staged) {
      if (!item.existing) continue;
      try {
        githubApi(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
        );
      } catch (error) {
        console.warn(
          `  ! could not remove previous feed asset ${item.backupName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of swapped.reverse()) {
      try {
        if (item.existing) {
          githubApi(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
            { name: `s3-sidekick-rollback-${token}-${item.name}` },
          );
          try {
            githubApi(
              "PATCH",
              `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
              { name: item.name },
            );
          } catch (restoreError) {
            githubApi(
              "PATCH",
              `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
              { name: item.name },
            );
            throw restoreError;
          }
          item.previousRenamed = false;
        }
        githubApi(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
        );
      } catch (rollbackError) {
        rollbackErrors.push(
          `${item.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const swappedIds = new Set(swapped.map((item) => item.uploaded.id));
    for (const item of staged) {
      if (swappedIds.has(item.uploaded.id)) continue;
      try {
        if (item.existing && item.previousRenamed) {
          githubApi(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
            { name: item.name },
          );
          item.previousRenamed = false;
        }
        githubApi(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
        );
      } catch (cleanupError) {
        rollbackErrors.push(
          `${item.name} staged cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        rollbackErrors.length
          ? `; live-feed rollback failed: ${rollbackErrors.join("; ")}`
          : ""
      }`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function withBetaManifestSyncLock(release, operation) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-beta-sync-lock-"),
  );
  const lockToken = crypto.randomBytes(16).toString("hex");
  const lockPath = path.join(temporaryDirectory, BETA_SYNC_LOCK_NAME);
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      tag: TAG,
      pid: process.pid,
      token: lockToken,
      createdAt: new Date(),
    })}\n`,
  );

  let acquired = null;
  try {
    for (let attempt = 1; attempt <= BETA_SYNC_LOCK_RETRIES; attempt += 1) {
      try {
        acquired = await uploadAsset(release, lockPath);
        break;
      } catch (error) {
        if (!isGitHubConflict(error)) throw error;
        if (attempt === BETA_SYNC_LOCK_RETRIES) {
          const lock = await findBetaManifestSyncLock(release.id);
          const createdAt = lock?.created_at
            ? ` (created ${lock.created_at})`
            : "";
          throw new Error(
            `Timed out waiting for another release VM to finish beta-manifest synchronization${createdAt}. If no release signer is still running, manually delete the GitHub release asset named "${BETA_SYNC_LOCK_NAME}" from the latest stable release, then retry. Never remove the lock while another signer is active.`,
          );
        }
        await sleep(2000);
      }
    }
    if (!acquired) {
      throw new Error(
        "Could not acquire the beta-manifest synchronization lock.",
      );
    }
    await assertOwnsBetaManifestSyncLock(release, acquired);
    return await operation({
      assertStillHeld: () => assertOwnsBetaManifestSyncLock(release, acquired),
    });
  } finally {
    if (acquired && typeof acquired.id === "number") {
      const current = await findBetaManifestSyncLock(release.id);
      if (current?.id === acquired.id) {
        await removeAssetBestEffort(acquired, "beta-manifest sync lock");
      }
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function cleanupTransactionalStagingAssets(release) {
  for (const asset of listReleaseAssets(release.id).filter((item) =>
    isTransactionalStagingAssetName(item?.name ?? ""),
  )) {
    await removeAssetBestEffort(asset, `orphan feed asset ${asset.name}`);
  }
}

async function syncBetaManifestsToLatestStable(
  uploadedFiles,
  currentReleaseId,
) {
  const betaManifests = uploadedFiles.filter((filePath) =>
    /^latest-[a-z0-9]+-beta-[a-z0-9_-]+\.json$/i.test(path.basename(filePath)),
  );
  if (betaManifests.length === 0) return;

  let latestStable;
  try {
    latestStable = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    );
  } catch (error) {
    throw new Error(
      `Could not load latest stable release for beta manifest sync: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!latestStable?.id) return;
  if (latestStable.id === currentReleaseId) {
    console.warn(
      "  ! syncBetaManifests: latest stable is the current release; sync skipped. Publish a stable release before running beta builds.",
    );
    return;
  }

  await withBetaManifestSyncLock(latestStable, async ({ assertStillHeld }) => {
    await assertStillHeld();
    await replaceReleaseAssetsTransactionally(latestStable, betaManifests, {
      assertStillHeld,
    });
    await assertStillHeld();
    await cleanupTransactionalStagingAssets(latestStable);
  });
  for (const filePath of betaManifests) {
    console.log(
      `  ~ synced ${path.basename(filePath)} to latest stable release`,
    );
  }
}

async function syncBetaManifestsAfterPublish() {
  if (!IS_PRERELEASE) {
    throw new Error(
      "release:sync-beta-manifests is only for beta versions (syncs latest-*-beta-*.json onto /releases/latest).",
    );
  }
  assertGitHubCliAuthenticated();
  let currentRelease;
  try {
    currentRelease = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`,
    );
  } catch (error) {
    if (error?.statusCode === 404) {
      throw new Error(
        `Published release ${TAG} not found. Publish the draft on GitHub, then re-run release:sync-beta-manifests.`,
      );
    }
    throw error;
  }
  if (currentRelease.draft) {
    throw new Error(
      `Release ${TAG} is still a draft. Publish it on GitHub before syncing beta manifests to /latest.`,
    );
  }
  const assets = listReleaseAssets(currentRelease.id).filter((asset) =>
    /^latest-[a-z0-9]+-beta-[a-z0-9_-]+\.json$/i.test(asset?.name ?? ""),
  );
  if (assets.length === 0) {
    throw new Error(`Published release ${TAG} has no beta updater manifests.`);
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-beta-manifests-"),
  );
  try {
    const files = assets.map((asset) => {
      const dest = path.join(temporaryDirectory, asset.name);
      downloadReleaseAsset(REPOSITORY, asset.id, dest);
      return dest;
    });
    console.log(
      `Syncing ${files.length} beta updater manifest(s) from ${TAG} onto /releases/latest…`,
    );
    await syncBetaManifestsToLatestStable(files, currentRelease.id);
    console.log("Done: beta manifests synced to latest stable release.\n");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertReleaseToolVersions(pkg, { environment: process.env, root });
  assertGitHubCliAuthenticated();
  verifyReleaseSession(root);
  if (EXPECTED_TAG && EXPECTED_TAG !== TAG) {
    throw new Error(
      `Version/tag mismatch: package.json is ${TAG} but EXPECTED_TAG is ${EXPECTED_TAG}.`,
    );
  }
  if (!process.env.GPG_PASSPHRASE || !process.env.GPG_KEY_ID) {
    throw new Error("GPG_KEY_ID and GPG_PASSPHRASE are required.");
  }
  const artifacts = collectArtifacts();
  const checksums = generateChecksums(artifacts);
  const signatures = signFiles([...artifacts, ...checksums]);
  const release = findDraft();
  if (!release?.draft && !ALLOW_ASSET_REPLACE) {
    throw new Error(
      `Release ${TAG} already exists as published. Refusing to mutate it without ALLOW_ASSET_REPLACE=true.`,
    );
  }
  const everything = [...artifacts, ...checksums, ...signatures];
  for (const filePath of everything) {
    await uploadAssetWithReplace(release, filePath);
    console.log(`uploaded ${path.basename(filePath)}`);
  }
  if (IS_PRERELEASE) {
    await syncBetaManifestsToLatestStable(
      everything.filter((filePath) =>
        /^latest-[a-z0-9]+-beta-[a-z0-9_-]+\.json$/i.test(
          path.basename(filePath),
        ),
      ),
      release.id,
    );
  }
  console.log(`Uploaded ${TAG} assets to draft.`);
}

if (isDirectExecution(import.meta.url)) {
  const run = process.argv.includes("--sync-beta-manifests")
    ? syncBetaManifestsAfterPublish
    : main;
  run().catch((error) => {
    console.error(
      `gpg-sign: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export {
  artifactMatchesVersion,
  assertLinuxX64PackageSet,
  assertReleaseTargetsCommit,
  cleanArtifactName,
  collectArtifacts,
  generateChecksums,
  generateUpdaterManifests,
  inferArch,
  isGitHubConflict,
  isTransactionalStagingAssetName,
  normalizeUpdaterSignature,
  releaseArtifactSearchDirs,
  resolveUpdaterTargets,
  rpmArtifactMatchesVersion,
  targetKeysForArtifact,
  verifyUpdaterSignature,
};
