#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDirectExecution } from "./direct-execution.js";
import { verifyReleaseSession } from "./release-session.js";
import githubCli from "./github-cli.cjs";

const { assertGitHubCliAuthenticated, githubApi, uploadReleaseAssetById } =
  githubCli;
const { signDetachedFile } = createRequire(import.meta.url)(
  "./release-integrity.cjs",
);

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
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const REPOSITORY = `${REPO_OWNER}/${REPO_NAME}`;
const RELEASE_NOTES = process.env.RELEASE_NOTES || "";
const RELEASE_PUB_DATE =
  process.env.RELEASE_PUB_DATE || new Date().toISOString();
const UPDATER_PUBLIC_KEY = tauriConfig.plugins?.updater?.pubkey;
const RELEASE_BASE_URL = (
  process.env.RELEASE_DOWNLOAD_BASE_URL ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(TAG)}`
).replace(/\/+$/, "");
const SEARCH_DIRS = [
  path.join(root, "src-tauri", "target"),
  path.join(root, "dist"),
];
const ARTIFACT_RULES = [
  /\.(?:exe|msi|dmg|deb|rpm|flatpak)$/i,
  /\.(?:appimage|app\.tar\.gz|zip)$/i,
];
const SIGN_RULES = ARTIFACT_RULES;
const MANIFEST_PATTERN = /^latest-[a-z0-9_-]+\.json$/i;
const CHECKSUM_PATTERN = /^SHA256SUMS-[a-z0-9_-]+\.txt$/i;

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isArtifact(name) {
  return ARTIFACT_RULES.some((pattern) => pattern.test(name));
}

function isSignable(name) {
  return SIGN_RULES.some((pattern) => pattern.test(name));
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

function artifactMatchesVersion(name) {
  const versions = name.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g,
  );
  return !versions || versions.some((value) => value === VERSION);
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

function readBuildSession() {
  return verifyReleaseSession(root);
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
    (release) => release?.draft && release.tag_name === TAG,
  );
  if (drafts.length !== 1) {
    throw new Error(
      `Expected one draft release ${TAG}; found ${drafts.length}.`,
    );
  }
  const commit = currentCommit();
  if (drafts[0].target_commitish !== commit) {
    throw new Error(
      `Draft ${TAG} targets ${drafts[0].target_commitish}, not HEAD ${commit}.`,
    );
  }
  return drafts[0];
}

function uploadFile(release, filePath) {
  const name = path.basename(filePath);
  const existing = listReleaseAssets(release.id).find(
    (asset) => asset.name === name,
  );
  if (existing) {
    const remoteDigest = String(existing.digest || "").replace(/^sha256:/, "");
    if (remoteDigest && remoteDigest === sha256(filePath)) return;
    throw new Error(`Draft already contains different asset ${name}.`);
  }
  uploadReleaseAssetById(REPOSITORY, release.id, filePath);
}

function collectArtifacts() {
  const session = readBuildSession();
  const discovered = SEARCH_DIRS.flatMap((directory) => walk(directory)).filter(
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

async function main() {
  assertGitHubCliAuthenticated();
  verifyReleaseSession(root);
  if (!process.env.GPG_PASSPHRASE || !process.env.GPG_KEY_ID) {
    throw new Error("GPG_KEY_ID and GPG_PASSPHRASE are required.");
  }
  const artifacts = collectArtifacts();
  const checksums = generateChecksums(artifacts);
  const signatures = signFiles([...artifacts, ...checksums]);
  const release = findDraft();
  for (const filePath of [...artifacts, ...checksums, ...signatures]) {
    uploadFile(release, filePath);
    console.log(`uploaded ${path.basename(filePath)}`);
  }
  console.log(`Uploaded ${TAG} assets to draft.`);
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `gpg-sign: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export {
  artifactMatchesVersion,
  cleanArtifactName,
  collectArtifacts,
  generateChecksums,
  generateUpdaterManifests,
  inferArch,
  normalizeUpdaterSignature,
  resolveUpdaterTargets,
  targetKeysForArtifact,
  verifyUpdaterSignature,
};
