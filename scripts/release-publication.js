#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import githubCli from "./github-cli.cjs";
import {
  normalizeUpdaterSignature,
  targetKeysForArtifactName,
  verifyUpdaterSignature,
} from "./gpg-sign.js";

const require = createRequire(import.meta.url);
const {
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  RELEASE_ASSET_INDEX_NAME,
  RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  assertExistingGitHubTagCommit,
  assertGitHubTagCommit,
  canonicalJson,
  classifyImmutableAsset,
  githubAssetSha256,
  installSmokeReportName,
  isInstallSmokeReportName,
  listAllReleaseAssets,
  readReleaseDescriptor,
  sha256File,
  signDescriptor,
  validateInstallSmokeReport,
  validateMutableRelease,
  verifyDescriptorSignature,
} = require("./release-integrity.cjs");
const {
  assertGitHubCliAuthenticated,
  downloadReleaseAsset,
  githubApi,
  uploadReleaseAssetById,
} = githubCli;

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const descriptorPath = path.join(releaseDir, DESCRIPTOR_NAME);
const descriptorSignaturePath = path.join(
  releaseDir,
  DESCRIPTOR_SIGNATURE_NAME,
);
const owner = process.env.GH_REPO_OWNER || "BurntToasters";
const repositoryName = process.env.GH_REPO_NAME || "S3-Sidekick";
const repository = `${owner}/${repositoryName}`;

function verifyGpgSignature(filePath, signaturePath, expectedFingerprint) {
  return verifyDescriptorSignature(
    filePath,
    signaturePath,
    expectedFingerprint,
  );
}

function releaseOptions(descriptor, requireDraft) {
  return {
    expectedId: descriptor.release.id,
    expectedPrerelease: descriptor.release.prerelease,
    expectedTag: descriptor.release.tag,
    expectedTargetCommitish: descriptor.source.commit,
    requireDraft,
  };
}

function validatePublicationRelease(release, descriptor) {
  return validateMutableRelease(
    release,
    releaseOptions(descriptor, release?.draft === true),
  );
}

function assetMap(assets) {
  const map = new Map();
  for (const asset of assets) {
    if (!asset?.name || !Number.isSafeInteger(asset.id))
      throw new Error("Release contains malformed asset metadata.");
    if (map.has(asset.name))
      throw new Error(`Release contains duplicate asset ${asset.name}.`);
    map.set(asset.name, asset);
  }
  return map;
}

function listAuthenticatedAssets(releaseId) {
  return listAllReleaseAssets((page, perPage) =>
    Promise.resolve(
      githubApi(
        "GET",
        `/repos/${owner}/${repositoryName}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
      ),
    ),
  );
}

function listPublicAssets(releaseId) {
  return listAllReleaseAssets(async (page, perPage) => {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repositoryName}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "S3-Sidekick-release-verifier",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Public release asset page ${page} returned HTTP ${response.status}.`,
      );
    }
    return response.json();
  });
}

function evidenceKind(name) {
  const targetSuffix = "(?:darwin|linux|windows)-(?:aarch64|x86_64)";
  if (new RegExp(`^release-attestation-${targetSuffix}\\.json$`).test(name))
    return "attestation";
  if (isInstallSmokeReportName(name)) return "install-smoke";
  if (new RegExp(`^release-package-smoke-${targetSuffix}\\.json$`).test(name))
    return "package-smoke";
  if (new RegExp(`^release-provenance-${targetSuffix}\\.json$`).test(name))
    return "provenance";
  if (new RegExp(`^release-sbom-${targetSuffix}\\.spdx\\.json$`).test(name))
    return "sbom";
  return null;
}

function updaterArtifact(name) {
  return /(?:\.app\.tar\.gz|\.appimage|\.appimage\.tar\.gz|\.nsis\.zip|-setup\.exe)$/i.test(
    name,
  );
}

function gpgSignedArtifact(name) {
  return (
    /\.(?:appimage|deb|dmg|exe|flatpak|json|msi|rpm|zip)$/i.test(name) ||
    /\.tar\.gz$/i.test(name)
  );
}

function assertCompleteEvidence({
  descriptor,
  assetsByName,
  attestations,
  digestByName,
  installSmokeReports = new Map(),
  descriptorSha256 = sha256File(descriptorPath),
}) {
  if (attestations.length === 0)
    throw new Error("No signed host attestations were uploaded.");
  const expectedAssetNames = new Set([
    DESCRIPTOR_NAME,
    DESCRIPTOR_SIGNATURE_NAME,
  ]);
  const hasAssetIndex = assetsByName.has(RELEASE_ASSET_INDEX_NAME);
  const hasAssetIndexSignature = assetsByName.has(
    RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  );
  if (hasAssetIndex !== hasAssetIndexSignature) {
    throw new Error("Release asset index/signature pair is incomplete.");
  }
  if (hasAssetIndex) {
    expectedAssetNames.add(RELEASE_ASSET_INDEX_NAME);
    expectedAssetNames.add(RELEASE_ASSET_INDEX_SIGNATURE_NAME);
  }
  const targetOwners = new Map();
  for (const attestation of attestations) {
    if (attestation.schemaVersion !== 1)
      throw new Error("Unsupported host attestation schema.");
    if (attestation.descriptorSha256 !== descriptorSha256) {
      throw new Error(
        "Host attestation references a different release descriptor.",
      );
    }
    if (
      attestation.releaseId !== descriptor.release.id ||
      attestation.sourceCommit !== descriptor.source.commit
    ) {
      throw new Error(
        "Host attestation release/source identity does not match the descriptor.",
      );
    }
    if (
      (attestation.targets || []).some((target) =>
        target.startsWith("linux-"),
      ) &&
      descriptor.toolchains?.flatpak
    ) {
      const arch =
        attestation.host?.arch === "arm64"
          ? "arm64"
          : attestation.host?.arch === "x64"
            ? "x64"
            : attestation.host?.arch;
      const expectedInputs =
        descriptor.toolchains.flatpak.inputsByArchitecture?.[arch];
      const platformInputs = attestation.platformInputs;
      if (
        !Array.isArray(expectedInputs) ||
        platformInputs?.schemaVersion !== 2 ||
        platformInputs?.arch !== arch ||
        platformInputs?.descriptorSha256 !== descriptorSha256 ||
        canonicalJson(platformInputs?.inputs) !== canonicalJson(expectedInputs)
      ) {
        throw new Error(
          `Linux attestation Flatpak inputs do not exactly match the signed ${arch} descriptor pins.`,
        );
      }
    }
    for (const target of attestation.targets || []) {
      if (targetOwners.has(target))
        throw new Error(`Duplicate host attestations claim target ${target}.`);
      targetOwners.set(target, attestation);
    }
    for (const record of [
      ...(attestation.artifacts || []),
      ...(attestation.evidence || []),
    ]) {
      expectedAssetNames.add(record.name);
      if (!assetsByName.has(record.name))
        throw new Error(`Attested asset is missing: ${record.name}.`);
      if (digestByName.get(record.name) !== record.sha256) {
        throw new Error(`Attested digest mismatch for ${record.name}.`);
      }
      if (gpgSignedArtifact(record.name)) {
        expectedAssetNames.add(`${record.name}.asc`);
        if (!assetsByName.has(`${record.name}.asc`)) {
          throw new Error(`GPG signature is missing for ${record.name}.`);
        }
      }
      if (updaterArtifact(record.name)) {
        expectedAssetNames.add(`${record.name}.sig`);
        if (!assetsByName.has(`${record.name}.sig`)) {
          throw new Error(`Updater signature is missing for ${record.name}.`);
        }
      }
    }
  }

  const missingTargets = descriptor.expectedTargets.filter(
    (target) => !targetOwners.has(target),
  );
  const unexpectedTargets = Array.from(targetOwners.keys()).filter(
    (target) => !descriptor.expectedTargets.includes(target),
  );
  if (missingTargets.length > 0 || unexpectedTargets.length > 0) {
    throw new Error(
      `Target attestation set is incomplete (missing: ${missingTargets.join(", ") || "none"}; unexpected: ${unexpectedTargets.join(", ") || "none"}).`,
    );
  }

  for (const target of descriptor.expectedTargets) {
    const checksumName = `SHA256SUMS-${target}.txt`;
    expectedAssetNames.add(checksumName);
    expectedAssetNames.add(`${checksumName}.asc`);
    if (
      !assetsByName.has(checksumName) ||
      !assetsByName.has(`${checksumName}.asc`)
    ) {
      throw new Error(`Signed checksum manifest is missing for ${target}.`);
    }

    if (descriptor.requiredEvidence.includes("install-smoke")) {
      const installSmokeName = installSmokeReportName(target);
      expectedAssetNames.add(installSmokeName);
      expectedAssetNames.add(`${installSmokeName}.asc`);
      if (
        !assetsByName.has(installSmokeName) ||
        !assetsByName.has(`${installSmokeName}.asc`)
      ) {
        throw new Error(
          `Signed install/update smoke report is missing for ${target}.`,
        );
      }
      const installSmokeReport = installSmokeReports.get(target);
      if (!installSmokeReport) {
        throw new Error(
          `Install/update smoke report could not be parsed for ${target}.`,
        );
      }
      const owningAttestation = targetOwners.get(target);
      const allowedArtifactNames = new Set(
        (Array.isArray(owningAttestation?.artifacts)
          ? owningAttestation.artifacts
          : []
        )
          .filter(
            (record) =>
              typeof record?.name === "string" &&
              /(?:\.app\.tar\.gz|\.appimage|\.deb|\.exe|\.msi|\.rpm)$/i.test(
                record.name,
              ) &&
              targetKeysForArtifactName(record.name).includes(target),
          )
          .map((record) => record.name),
      );
      if (allowedArtifactNames.size === 0) {
        throw new Error(
          `Target attestation has no installable artifacts for ${target}.`,
        );
      }
      validateInstallSmokeReport(installSmokeReport, {
        allowedArtifactNames,
        descriptor,
        descriptorSha256,
        digestByName,
        target,
      });
    }
  }

  for (const attestation of attestations) {
    const suffix = `${attestation.host.platform === "win32" ? "windows" : attestation.host.platform}-${
      attestation.host.arch === "arm64"
        ? "aarch64"
        : attestation.host.arch === "x64"
          ? "x86_64"
          : attestation.host.arch
    }`;
    const attestationName = `release-attestation-${suffix}.json`;
    expectedAssetNames.add(attestationName);
    expectedAssetNames.add(`${attestationName}.asc`);
    if (
      !assetsByName.has(attestationName) ||
      !assetsByName.has(`${attestationName}.asc`)
    ) {
      throw new Error(`Signed host attestation is missing for ${suffix}.`);
    }
    const evidenceNamesByKind = {
      attestation: attestationName,
      "package-smoke": `release-package-smoke-${suffix}.json`,
      provenance: `release-provenance-${suffix}.json`,
      sbom: `release-sbom-${suffix}.spdx.json`,
    };
    for (const kind of descriptor.requiredEvidence) {
      if (kind === "install-smoke") continue;
      const matchingName = evidenceNamesByKind[kind];
      if (!matchingName || evidenceKind(matchingName) !== kind) {
        throw new Error(`Unsupported required evidence kind: ${kind}.`);
      }
      if (!assetsByName.has(matchingName))
        throw new Error(`Required ${kind} evidence is missing for ${suffix}.`);
    }
  }
  const actualNames = Array.from(assetsByName.keys()).sort();
  const expectedNames = Array.from(expectedAssetNames).sort();
  const missingNames = expectedNames.filter((name) => !assetsByName.has(name));
  const unexpectedNames = actualNames.filter(
    (name) => !expectedAssetNames.has(name),
  );
  if (missingNames.length > 0 || unexpectedNames.length > 0) {
    throw new Error(
      `Release asset set is not exactly attested (missing: ${missingNames.join(", ") || "none"}; unexpected: ${unexpectedNames.join(", ") || "none"}).`,
    );
  }
  return true;
}

function createReleaseAssetIndex({
  descriptor,
  assetsByName,
  digestByName,
  descriptorSha256 = digestByName.get(DESCRIPTOR_NAME),
}) {
  const assets = Array.from(assetsByName.keys())
    .filter(
      (name) =>
        name !== RELEASE_ASSET_INDEX_NAME &&
        name !== RELEASE_ASSET_INDEX_SIGNATURE_NAME,
    )
    .sort()
    .map((name) => {
      const sha256 = digestByName.get(name);
      if (!/^[a-f0-9]{64}$/.test(sha256 || "")) {
        throw new Error(
          `Release asset ${name} has no verified SHA-256 digest.`,
        );
      }
      return { name, sha256 };
    });
  return {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    tag: descriptor.release.tag,
    assets,
  };
}

function assertReleaseAssetIndexEntries(index, assetsByName, digestByName) {
  const expected = new Map();
  for (const record of index.assets || []) {
    if (
      !record?.name ||
      !/^[a-f0-9]{64}$/.test(record.sha256 || "") ||
      expected.has(record.name) ||
      record.name === RELEASE_ASSET_INDEX_NAME ||
      record.name === RELEASE_ASSET_INDEX_SIGNATURE_NAME
    ) {
      throw new Error("Release asset index contains a malformed entry.");
    }
    expected.set(record.name, record.sha256);
  }
  for (const name of [
    RELEASE_ASSET_INDEX_NAME,
    RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  ]) {
    const currentAsset = assetsByName.get(name);
    if (!currentAsset) {
      throw new Error(
        `Current release is missing signed release asset index pair member ${name}.`,
      );
    }
    const verifiedDigest = digestByName.get(name);
    if (!/^[a-f0-9]{64}$/.test(verifiedDigest || "")) {
      throw new Error(
        `Verified release asset index pair digest is missing for ${name}.`,
      );
    }
    const currentGitHubSha256 = githubAssetSha256(currentAsset);
    if (!currentGitHubSha256) {
      throw new Error(`Release asset ${name} has no GitHub SHA-256 digest.`);
    }
    if (currentGitHubSha256 !== verifiedDigest) {
      throw new Error(
        `GitHub digest does not match the verified release asset index pair for ${name}.`,
      );
    }
  }
  const actualNames = Array.from(assetsByName.keys())
    .filter(
      (name) =>
        name !== RELEASE_ASSET_INDEX_NAME &&
        name !== RELEASE_ASSET_INDEX_SIGNATURE_NAME,
    )
    .sort();
  const expectedNames = Array.from(expected.keys()).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    throw new Error(
      "Public release asset names do not exactly match the signed index.",
    );
  }
  for (const [name, sha256] of expected) {
    if (digestByName.get(name) !== sha256) {
      throw new Error(`Release asset index digest mismatch for ${name}.`);
    }
    const currentGitHubSha256 = githubAssetSha256(assetsByName.get(name));
    if (!currentGitHubSha256) {
      throw new Error(`Release asset ${name} has no GitHub SHA-256 digest.`);
    }
    if (currentGitHubSha256 !== sha256) {
      throw new Error(
        `GitHub digest does not match the signed release asset index for ${name}.`,
      );
    }
  }
  return true;
}

function verifyReleaseAssetIndex({
  descriptor,
  directory,
  assetsByName,
  digestByName,
  required = false,
}) {
  const hasIndex = assetsByName.has(RELEASE_ASSET_INDEX_NAME);
  const hasSignature = assetsByName.has(RELEASE_ASSET_INDEX_SIGNATURE_NAME);
  if (!hasIndex && !hasSignature && !required) return null;
  if (!hasIndex || !hasSignature) {
    throw new Error("Signed release asset index is incomplete.");
  }
  const indexPath = path.join(directory, RELEASE_ASSET_INDEX_NAME);
  const signaturePath = path.join(
    directory,
    RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  );
  verifyDescriptorSignature(
    indexPath,
    signaturePath,
    descriptor.release.signingKeyFingerprint,
  );
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (
    index.schemaVersion !== 1 ||
    index.descriptorSha256 !== digestByName.get(DESCRIPTOR_NAME) ||
    index.releaseId !== descriptor.release.id ||
    index.sourceCommit !== descriptor.source.commit ||
    index.tag !== descriptor.release.tag ||
    !Array.isArray(index.assets)
  ) {
    throw new Error(
      "Release asset index identity does not match the descriptor.",
    );
  }
  assertReleaseAssetIndexEntries(index, assetsByName, digestByName);
  return index;
}

function verifyChecksumFiles(directory, assetsByName, digestByName) {
  const checksumNames = Array.from(assetsByName.keys()).filter((name) =>
    /^SHA256SUMS(?:-[a-z0-9_-]+)?\.txt$/i.test(name),
  );
  if (checksumNames.length === 0)
    throw new Error("Release contains no checksum manifests.");
  for (const checksumName of checksumNames) {
    if (!assetsByName.has(`${checksumName}.asc`)) {
      throw new Error(`Checksum signature is missing: ${checksumName}.asc.`);
    }
    const lines = fs
      .readFileSync(path.join(directory, checksumName), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (lines.length === 0)
      throw new Error(`Checksum manifest is empty: ${checksumName}.`);
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
      if (!match)
        throw new Error(`Malformed checksum line in ${checksumName}.`);
      if (digestByName.get(match[2]) !== match[1].toLowerCase()) {
        throw new Error(
          `Checksum mismatch for ${match[2]} in ${checksumName}.`,
        );
      }
    }
  }
}

function verifyUpdaterManifests(directory, assetsByName) {
  const expectedBase = `https://github.com/${owner}/${repositoryName}/releases/download/`;
  for (const name of assetsByName.keys()) {
    if (!/^latest-[a-z0-9-]+-[a-z0-9_]+\.json$/i.test(name)) continue;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    const platforms = Object.values(manifest.platforms || {});
    if (platforms.length === 0)
      throw new Error(`Updater manifest has no platforms: ${name}.`);
    for (const entry of platforms) {
      if (
        typeof entry?.url !== "string" ||
        !entry.url.startsWith(expectedBase)
      ) {
        throw new Error(
          `Updater manifest has a non-immutable release URL: ${name}.`,
        );
      }
      const artifactName = decodeURIComponent(
        new URL(entry.url).pathname.split("/").pop(),
      );
      if (
        !assetsByName.has(artifactName) ||
        !assetsByName.has(`${artifactName}.sig`)
      ) {
        throw new Error(
          `Updater manifest references a missing artifact/signature: ${artifactName}.`,
        );
      }
      const expectedSignature = normalizeUpdaterSignature(
        path.join(directory, `${artifactName}.sig`),
      );
      if (entry.signature !== expectedSignature) {
        throw new Error(
          `Updater manifest embeds the wrong signature for ${artifactName}.`,
        );
      }
    }
  }
}

function verifyDownloadedAssetSet({
  descriptor,
  directory,
  assets,
  requireAssetIndex = false,
}) {
  const assetsByName = assetMap(assets);
  const digestByName = new Map();
  for (const [name, asset] of assetsByName) {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath))
      throw new Error(`Downloaded asset is missing: ${name}.`);
    const digest = sha256File(filePath);
    const apiDigest = githubAssetSha256(asset);
    if (apiDigest && apiDigest !== digest)
      throw new Error(`GitHub digest mismatch for ${name}.`);
    digestByName.set(name, digest);
  }

  const downloadedDescriptor = path.join(directory, DESCRIPTOR_NAME);
  const downloadedSignature = path.join(directory, DESCRIPTOR_SIGNATURE_NAME);
  verifyDescriptorSignature(
    downloadedDescriptor,
    downloadedSignature,
    descriptor.release.signingKeyFingerprint,
  );
  if (sha256File(downloadedDescriptor) !== sha256File(descriptorPath)) {
    throw new Error(
      "Published descriptor bytes differ from the coordinator descriptor.",
    );
  }

  for (const name of assetsByName.keys()) {
    if (name.endsWith(".asc")) {
      const baseName = name.slice(0, -4);
      if (assetsByName.has(baseName)) {
        verifyGpgSignature(
          path.join(directory, baseName),
          path.join(directory, name),
          descriptor.release.signingKeyFingerprint,
        );
      }
    }
    if (name.endsWith(".sig")) {
      const baseName = name.slice(0, -4);
      if (assetsByName.has(baseName)) {
        verifyUpdaterSignature(
          path.join(directory, baseName),
          path.join(directory, name),
        );
      }
    }
  }

  verifyChecksumFiles(directory, assetsByName, digestByName);
  verifyUpdaterManifests(directory, assetsByName);

  const installSmokeReports = new Map();
  for (const target of descriptor.expectedTargets) {
    const name = installSmokeReportName(target);
    if (!assetsByName.has(name)) continue;
    installSmokeReports.set(
      target,
      JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
    );
  }
  const attestations = Array.from(assetsByName.keys())
    .filter((name) => evidenceKind(name) === "attestation")
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
    );
  assertCompleteEvidence({
    descriptor,
    assetsByName,
    attestations,
    digestByName,
    installSmokeReports,
  });
  const assetIndex = verifyReleaseAssetIndex({
    assetsByName,
    descriptor,
    digestByName,
    directory,
    required: requireAssetIndex,
  });
  return { assetIndex, assetsByName, attestations, digestByName };
}

function downloadDraftAssets(assets, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const asset of assets) {
    downloadReleaseAsset(
      repository,
      asset.id,
      path.join(directory, asset.name),
    );
  }
}

async function uploadImmutableAssetIndexFile(release, descriptor, filePath) {
  const latest = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  validateMutableRelease(latest, releaseOptions(descriptor, true));
  const name = path.basename(filePath);
  const existing = assetMap(await listAuthenticatedAssets(release.id));
  const action = classifyImmutableAsset(existing.get(name), filePath);
  if (action === "skip") return;
  uploadReleaseAssetById(repository, release.id, filePath);
}

async function freezeReleaseAssetSet({
  descriptor,
  directory,
  release,
  verification,
  environment = process.env,
}) {
  if (verification.assetIndex) {
    const confirmedAssets = await listAuthenticatedAssets(release.id);
    assertReleaseAssetIndexEntries(
      verification.assetIndex,
      assetMap(confirmedAssets),
      verification.digestByName,
    );
    return {
      assetIndex: verification.assetIndex,
      assets: confirmedAssets,
      digestByName: verification.digestByName,
    };
  }
  const indexPath = path.join(directory, RELEASE_ASSET_INDEX_NAME);
  const signaturePath = path.join(
    directory,
    RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  );
  fs.writeFileSync(
    indexPath,
    canonicalJson(
      createReleaseAssetIndex({
        assetsByName: verification.assetsByName,
        descriptor,
        digestByName: verification.digestByName,
      }),
    ),
    { mode: 0o600 },
  );
  signDescriptor(indexPath, signaturePath, {
    ...environment,
    SOURCE_DATE_EPOCH: String(
      Math.floor(Date.parse(descriptor.source.committedAt) / 1000),
    ),
  });
  await uploadImmutableAssetIndexFile(release, descriptor, indexPath);
  await uploadImmutableAssetIndexFile(release, descriptor, signaturePath);
  const frozenAssets = await listAuthenticatedAssets(release.id);
  const frozenVerification = verifyDownloadedAssetSet({
    assets: frozenAssets,
    descriptor,
    directory,
    requireAssetIndex: true,
  });
  const confirmedAssets = await listAuthenticatedAssets(release.id);
  assertReleaseAssetIndexEntries(
    frozenVerification.assetIndex,
    assetMap(confirmedAssets),
    frozenVerification.digestByName,
  );
  return {
    assetIndex: frozenVerification.assetIndex,
    assets: confirmedAssets,
    digestByName: frozenVerification.digestByName,
  };
}

async function recheckFrozenReleaseAssetSet({
  descriptor,
  release,
  frozen,
  listAssets = listAuthenticatedAssets,
  request = (method, endpoint) => Promise.resolve(githubApi(method, endpoint)),
}) {
  if (!frozen?.assetIndex || !frozen?.digestByName) {
    throw new Error("Frozen release verification state is incomplete.");
  }
  const latest = await request(
    "GET",
    `/repos/${owner}/${repositoryName}/releases/${release.id}`,
  );
  validateMutableRelease(latest, releaseOptions(descriptor, true));
  const confirmedAssets = await listAssets(release.id);
  assertReleaseAssetIndexEntries(
    frozen.assetIndex,
    assetMap(confirmedAssets),
    frozen.digestByName,
  );
  return confirmedAssets;
}

async function downloadPublicAssets(assets, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const asset of assets) {
    if (!asset.browser_download_url)
      throw new Error(`Asset ${asset.name} has no public download URL.`);
    const response = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "S3-Sidekick-release-verifier" },
      redirect: "follow",
    });
    if (!response.ok)
      throw new Error(
        `Anonymous download failed for ${asset.name}: HTTP ${response.status}`,
      );
    fs.writeFileSync(
      path.join(directory, asset.name),
      Buffer.from(await response.arrayBuffer()),
      {
        mode: 0o600,
      },
    );
  }
}

async function publicGitHubRequest(method, endpoint) {
  if (method !== "GET")
    throw new Error("Public GitHub verification is read-only.");
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "S3-Sidekick-release-verifier",
    },
  });
  if (!response.ok) {
    const error = new Error(
      `Public GitHub request ${endpoint} returned HTTP ${response.status}.`,
    );
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
}

async function waitForPublicVerification(descriptor, attempts = 12) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-public-release-"),
    );
    try {
      const release = await publicGitHubRequest(
        "GET",
        `/repos/${owner}/${repositoryName}/releases/tags/${encodeURIComponent(descriptor.release.tag)}`,
      );
      validateMutableRelease(release, releaseOptions(descriptor, false));
      if (release.draft)
        throw new Error("Release is still a draft in the anonymous API.");
      await assertGitHubTagCommit(publicGitHubRequest, {
        expectedCommit: descriptor.source.commit,
        owner,
        repository: repositoryName,
        tag: descriptor.release.tag,
      });
      const publicAssets = await listPublicAssets(release.id);
      await downloadPublicAssets(publicAssets, directory);
      const verification = verifyDownloadedAssetSet({
        descriptor,
        directory,
        assets: publicAssets,
        requireAssetIndex: true,
      });
      const confirmedPublicAssets = await listPublicAssets(release.id);
      assertReleaseAssetIndexEntries(
        verification.assetIndex,
        assetMap(confirmedPublicAssets),
        verification.digestByName,
      );
      return {
        release,
        publicAssets: confirmedPublicAssets,
        directory,
      };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      lastError = error;
      if (attempt < attempts)
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw new Error(
    `Published release did not pass anonymous verification: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function betaManifestName(name) {
  return /^latest-[a-z0-9-]+-beta-[a-z0-9_]+\.json$/i.test(name);
}

function stableManifestName(name) {
  return (
    /^latest-[a-z0-9-]+-[a-z0-9_]+\.json$/i.test(name) &&
    !betaManifestName(name)
  );
}

function channelTransitionPolicy(descriptor) {
  if (descriptor.release.prerelease) {
    return {
      makeLatest: "false",
      supported: false,
      reason:
        "The shipped /releases/latest updater endpoint cannot select immutable prerelease tags without an application/config endpoint migration.",
    };
  }
  return { makeLatest: "true", supported: true };
}

function assertChannelTransitionSupported(descriptor) {
  const policy = channelTransitionPolicy(descriptor);
  if (!policy.supported) {
    throw new Error(
      `Beta publication is disabled before any release mutation: ${policy.reason} GitHub Latest remains reserved for stable product releases.`,
    );
  }
  return policy;
}

async function main() {
  assertGitHubCliAuthenticated();
  verifyDescriptorSignature(descriptorPath, descriptorSignaturePath);
  const descriptor = readReleaseDescriptor(descriptorPath);
  verifyDescriptorSignature(
    descriptorPath,
    descriptorSignaturePath,
    descriptor.release.signingKeyFingerprint,
  );
  let release = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${descriptor.release.id}`,
    ),
  );
  validatePublicationRelease(release, descriptor);

  if (release.draft) {
    const transitionPolicy = assertChannelTransitionSupported(descriptor);
    const assets = await listAuthenticatedAssets(release.id);
    const privateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-draft-release-"),
    );
    let frozen;
    try {
      downloadDraftAssets(assets, privateDirectory);
      const verification = verifyDownloadedAssetSet({
        descriptor,
        directory: privateDirectory,
        assets,
      });
      frozen = await freezeReleaseAssetSet({
        descriptor,
        directory: privateDirectory,
        release,
        verification,
      });
    } finally {
      fs.rmSync(privateDirectory, { recursive: true, force: true });
    }
    await recheckFrozenReleaseAssetSet({ descriptor, frozen, release });
    await assertExistingGitHubTagCommit(
      (method, endpoint) => Promise.resolve(githubApi(method, endpoint)),
      {
        expectedCommit: descriptor.source.commit,
        owner,
        repository: repositoryName,
        tag: descriptor.release.tag,
      },
    );
    release = await Promise.resolve(
      githubApi(
        "PATCH",
        `/repos/${owner}/${repositoryName}/releases/${release.id}`,
        {
          draft: false,
          make_latest: transitionPolicy.makeLatest,
          prerelease: descriptor.release.prerelease,
        },
      ),
    );
    validateMutableRelease(release, releaseOptions(descriptor, false));
    if (release.draft) throw new Error("GitHub did not publish the release.");
    console.log(
      `[release-publication] Published ${descriptor.release.tag}; starting anonymous verification.`,
    );
  } else {
    console.log(
      `[release-publication] ${descriptor.release.tag} is already published; re-running public verification without mutation.`,
    );
  }

  await assertGitHubTagCommit(
    (method, endpoint) => Promise.resolve(githubApi(method, endpoint)),
    {
      expectedCommit: descriptor.source.commit,
      owner,
      repository: repositoryName,
      tag: descriptor.release.tag,
    },
  );
  const verified = await waitForPublicVerification(descriptor);
  try {
    console.log(
      `[release-publication] Anonymous public assets and signatures verified for ${descriptor.release.tag}.`,
    );
  } finally {
    fs.rmSync(verified.directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `release-publication: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export {
  assertChannelTransitionSupported,
  assertCompleteEvidence,
  assertReleaseAssetIndexEntries,
  assetMap,
  betaManifestName,
  channelTransitionPolicy,
  createReleaseAssetIndex,
  evidenceKind,
  freezeReleaseAssetSet,
  recheckFrozenReleaseAssetSet,
  stableManifestName,
  validatePublicationRelease,
  verifyChecksumFiles,
  verifyDownloadedAssetSet,
  verifyReleaseAssetIndex,
  verifyUpdaterManifests,
  waitForPublicVerification,
};
