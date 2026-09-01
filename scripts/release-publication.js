#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  BETA_CHANNEL_ROLLOVER_NAME,
  BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  BETA_CHANNEL_STATE_NAME,
  BETA_CHANNEL_STATE_SIGNATURE_NAME,
  BETA_CHANNEL_TRANSACTION_NAME,
  BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
  STABLE_ROLLOVER_RECEIPT_NAME,
  STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  createBetaChannelRollover,
  createBetaChannelState,
  createBetaChannelTransaction,
  createStableRolloverReceipt,
  expectedBetaChannelAssetNames,
  extractBetaChannelSource,
  operationalBetaChannelAssetNames,
  permanentBetaChannelAssetNames,
  promoteBetaChannelAssets,
  recoverBetaChannelTransaction,
  recoverIncompleteChannelControlPair,
  splitStableReleaseAssets,
  validateBetaChannelRollover,
  validateBetaChannelTransaction,
  validatePublicationOwner,
  validateStableRolloverReceipt,
  verifyBetaChannelOverlay,
} from "./release-channel.js";
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
  artifactNameFromDescriptorReleaseUrl,
  assertDescriptorRepository,
  assertExistingGitHubTagCommit,
  assertGitHubTagCommit,
  canonicalJson,
  classifyImmutableAsset,
  compareSemanticVersions,
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
  deleteReleaseAssetById,
  downloadReleaseAsset,
  githubApi,
  uploadReleaseAssetById,
} = githubCli;

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const publicationStateDir = path.join(root, ".release-state");
const descriptorPath = path.join(releaseDir, DESCRIPTOR_NAME);
const descriptorSignaturePath = path.join(
  releaseDir,
  DESCRIPTOR_SIGNATURE_NAME,
);
const owner = process.env.GH_REPO_OWNER || "BurntToasters";
const repositoryName = process.env.GH_REPO_NAME || "S3-Sidekick";
const repository = `${owner}/${repositoryName}`;

function processStartToken(
  pid,
  {
    platform = process.platform,
    readText = (filePath) => fs.readFileSync(filePath, "utf8"),
    spawn = spawnSync,
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const environment = {
    LC_ALL: "C",
    PATH: process.env.PATH || "",
    ...(platform === "darwin" && process.env.DEVELOPER_DIR
      ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR }
      : {}),
    ...(platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  if (platform === "linux") {
    try {
      const bootId = readText("/proc/sys/kernel/random/boot_id").trim();
      const stat = readText(`/proc/${pid}/stat`).trim();
      const commandEnd = stat.lastIndexOf(")");
      const fieldsAfterCommand =
        commandEnd >= 0
          ? stat
              .slice(commandEnd + 1)
              .trim()
              .split(/\s+/)
          : [];
      const startTicks = fieldsAfterCommand[19];
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          bootId,
        ) ||
        !/^\d+$/.test(startTicks || "")
      ) {
        return null;
      }
      return `linux:${bootId.toLowerCase()}:${startTicks}`;
    } catch {
      return null;
    }
  }
  const result =
    platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { encoding: "utf8", env: environment, shell: false },
        )
      : platform === "darwin"
        ? spawn(
            "/usr/bin/xcrun",
            [
              "swift",
              "-e",
              [
                "import Darwin",
                "var info = proc_bsdinfo()",
                "let size = Int32(MemoryLayout<proc_bsdinfo>.size)",
                `let result = proc_pidinfo(${pid}, PROC_PIDTBSDINFO, 0, &info, size)`,
                "if result != size { exit(1) }",
                'print("\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)")',
              ].join("; "),
            ],
            { encoding: "utf8", env: environment, shell: false },
          )
        : null;
  if (!result || result.status !== 0) return null;
  const token = result.stdout.trim();
  if (platform === "win32" && /^\d+$/.test(token)) {
    return `windows:${token}`;
  }
  if (platform === "darwin" && /^\d+:\d+$/.test(token)) {
    return `darwin:${token}`;
  }
  return null;
}

function publicationStatePaths(stateDirectory, descriptorSha256) {
  if (!/^[a-f0-9]{64}$/.test(descriptorSha256 || "")) {
    throw new Error("Publication state descriptor digest is malformed.");
  }
  return {
    lockDirectory: path.join(stateDirectory, "release-publication-locks"),
    ownerPath: path.join(stateDirectory, "owners", `${descriptorSha256}.json`),
    receiptPath: path.join(
      stateDirectory,
      "receipts",
      `${descriptorSha256}.json`,
    ),
  };
}

function atomicWritePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { mode: 0o700, recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, canonicalJson(value));
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function installPublicationLock(lockPath, value) {
  const candidatePath = `${lockPath}.candidate-${randomUUID()}`;
  atomicWritePrivateJson(candidatePath, value);
  try {
    fs.linkSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(candidatePath, { force: true });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validatePublicationLock(value) {
  if (
    value?.schemaVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.lockId || "",
    ) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartToken !== "string" ||
    !value.processStartToken ||
    !/^[a-f0-9]{64}$/.test(value.descriptorSha256 || "")
  ) {
    throw new Error("Local publication lock record is malformed.");
  }
  return value;
}

function acquirePublicationSession(
  descriptor,
  descriptorSha256,
  {
    afterLockInstalled = () => {},
    lockIdFactory = randomUUID,
    processIdentity = processStartToken,
    processLiveness = processIsAlive,
    sessionIdFactory = randomUUID,
    stateDirectory = publicationStateDir,
  } = {},
) {
  fs.mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
  const { lockDirectory, ownerPath } = publicationStatePaths(
    stateDirectory,
    descriptorSha256,
  );
  fs.mkdirSync(lockDirectory, { mode: 0o700, recursive: true });
  const currentProcessStartToken = processIdentity(process.pid);
  if (!currentProcessStartToken) {
    throw new Error("Could not determine the publication process identity.");
  }
  const lockRecord = validatePublicationLock({
    schemaVersion: 1,
    descriptorSha256,
    lockId: lockIdFactory(),
    pid: process.pid,
    processStartToken: currentProcessStartToken,
  });
  const lockPath = path.join(lockDirectory, `${lockRecord.lockId}.json`);
  if (!installPublicationLock(lockPath, lockRecord)) {
    throw new Error(
      "Publication lock identifier collision; retry publication.",
    );
  }

  const releaseLock = () => {
    let current;
    try {
      current = validatePublicationLock(
        JSON.parse(fs.readFileSync(lockPath, "utf8")),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (
      current.lockId === lockRecord.lockId &&
      current.pid === lockRecord.pid &&
      current.processStartToken === lockRecord.processStartToken &&
      current.descriptorSha256 === lockRecord.descriptorSha256
    ) {
      fs.rmSync(lockPath);
    }
  };

  let publicationOwner;
  try {
    afterLockInstalled(lockRecord, lockPath);
    const contenderNames = fs
      .readdirSync(lockDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    for (const contenderName of contenderNames) {
      const contenderPath = path.join(lockDirectory, contenderName);
      if (contenderPath === lockPath) continue;
      let contender;
      try {
        contender = validatePublicationLock(
          JSON.parse(fs.readFileSync(contenderPath, "utf8")),
        );
      } catch {
        continue;
      }
      const observedStartToken = processIdentity(contender.pid);
      if (observedStartToken === contender.processStartToken) {
        throw new Error(
          "Another release publication process owns the local publication lock.",
        );
      }
      if (observedStartToken === null && processLiveness(contender.pid)) {
        throw new Error(
          "Could not verify whether another publication lock owner is still active.",
        );
      }
    }

    try {
      const existing = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      validatePublicationOwner(existing);
      if (
        existing.releaseId !== descriptor.release.id ||
        existing.sourceCommit !== descriptor.source.commit ||
        existing.descriptorSha256 !== descriptorSha256
      ) {
        throw new Error(
          "Persistent publication owner does not match its descriptor identity.",
        );
      }
      publicationOwner = existing;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!publicationOwner) {
      publicationOwner = {
        schemaVersion: 1,
        descriptorSha256,
        releaseId: descriptor.release.id,
        sessionId: sessionIdFactory(),
        sourceCommit: descriptor.source.commit,
      };
      validatePublicationOwner(publicationOwner);
      atomicWritePrivateJson(ownerPath, publicationOwner);
    }
  } catch (error) {
    releaseLock();
    throw error;
  }

  let released = false;
  return {
    owner: publicationOwner,
    release() {
      if (released) return;
      releaseLock();
      released = true;
    },
  };
}

function stableRolloverReceiptOwnershipRecord(
  descriptor,
  descriptorSha256,
  publicationOwner,
  receiptAssets,
) {
  validatePublicationOwner(publicationOwner);
  if (
    publicationOwner.releaseId !== descriptor.release.id ||
    publicationOwner.sourceCommit !== descriptor.source.commit ||
    publicationOwner.descriptorSha256 !== descriptorSha256
  ) {
    throw new Error(
      "Stable rollover receipt ownership does not match its descriptor.",
    );
  }
  const expectedNames = [
    STABLE_ROLLOVER_RECEIPT_NAME,
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  ];
  const assets = expectedNames
    .map((name) => {
      const asset = receiptAssets.get(name);
      const sha256 = githubAssetSha256(asset);
      if (!Number.isSafeInteger(asset?.id) || !sha256) {
        throw new Error(
          "Stable rollover receipt ownership asset set is incomplete.",
        );
      }
      return { id: asset.id, name, sha256 };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    assets,
    descriptorSha256,
    owner: publicationOwner,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
  };
}

function validateStableRolloverReceiptOwnership(
  value,
  descriptor,
  descriptorSha256,
) {
  if (
    value?.schemaVersion !== 1 ||
    value.descriptorSha256 !== descriptorSha256 ||
    value.releaseId !== descriptor.release.id ||
    value.sourceCommit !== descriptor.source.commit
  ) {
    throw new Error("Stable rollover receipt ownership state is stale.");
  }
  validatePublicationOwner(value.owner);
  if (
    value.owner.releaseId !== value.releaseId ||
    value.owner.sourceCommit !== value.sourceCommit ||
    value.owner.descriptorSha256 !== value.descriptorSha256
  ) {
    throw new Error("Stable rollover receipt ownership owner is stale.");
  }
  const expectedNames = new Set([
    STABLE_ROLLOVER_RECEIPT_NAME,
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  ]);
  const assets = new Map();
  for (const record of value.assets || []) {
    if (
      !expectedNames.has(record?.name) ||
      !Number.isSafeInteger(record?.id) ||
      !/^[a-f0-9]{64}$/.test(record?.sha256 || "") ||
      assets.has(record.name)
    ) {
      throw new Error("Stable rollover receipt ownership asset is malformed.");
    }
    assets.set(record.name, {
      digest: `sha256:${record.sha256}`,
      id: record.id,
      name: record.name,
    });
  }
  if (assets.size !== expectedNames.size) {
    throw new Error(
      "Stable rollover receipt ownership asset set is incomplete.",
    );
  }
  return { assets, owner: value.owner, value };
}

function loadStableRolloverReceiptOwnership(
  descriptor,
  descriptorSha256,
  stateDirectory = publicationStateDir,
) {
  const { receiptPath } = publicationStatePaths(
    stateDirectory,
    descriptorSha256,
  );
  try {
    return validateStableRolloverReceiptOwnership(
      JSON.parse(fs.readFileSync(receiptPath, "utf8")),
      descriptor,
      descriptorSha256,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function persistStableRolloverReceiptOwnership(
  descriptor,
  descriptorSha256,
  publicationOwner,
  receiptAssets,
  stateDirectory = publicationStateDir,
) {
  const value = stableRolloverReceiptOwnershipRecord(
    descriptor,
    descriptorSha256,
    publicationOwner,
    receiptAssets,
  );
  const { receiptPath } = publicationStatePaths(
    stateDirectory,
    descriptorSha256,
  );
  const existing = loadStableRolloverReceiptOwnership(
    descriptor,
    descriptorSha256,
    stateDirectory,
  );
  if (existing) {
    if (canonicalJson(existing.value) !== canonicalJson(value)) {
      throw new Error(
        "Stable rollover receipt ownership changed for this descriptor.",
      );
    }
    return existing;
  }
  atomicWritePrivateJson(receiptPath, value);
  return validateStableRolloverReceiptOwnership(
    value,
    descriptor,
    descriptorSha256,
  );
}

function clearStableRolloverReceiptOwnership(
  descriptorSha256,
  stateDirectory = publicationStateDir,
) {
  const { receiptPath } = publicationStatePaths(
    stateDirectory,
    descriptorSha256,
  );
  fs.rmSync(receiptPath, { force: true });
}

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

function assertReleaseAssetIndexEntries(
  index,
  assetsByName,
  digestByName,
  descriptor,
) {
  const closureAssetsByName =
    descriptor?.release?.prerelease === false
      ? splitStableReleaseAssets(descriptor, assetsByName).productAssetsByName
      : assetsByName;
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
    const currentAsset = closureAssetsByName.get(name);
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
  const actualNames = Array.from(closureAssetsByName.keys())
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
    const currentGitHubSha256 = githubAssetSha256(
      closureAssetsByName.get(name),
    );
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
  assertReleaseAssetIndexEntries(index, assetsByName, digestByName, descriptor);
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

function verifyUpdaterManifests(directory, assetsByName, descriptor) {
  for (const name of assetsByName.keys()) {
    if (!/^latest-[a-z0-9-]+-[a-z0-9_]+\.json$/i.test(name)) continue;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    const platforms = Object.values(manifest.platforms || {});
    if (platforms.length === 0)
      throw new Error(`Updater manifest has no platforms: ${name}.`);
    for (const entry of platforms) {
      const artifactName = artifactNameFromDescriptorReleaseUrl(
        descriptor,
        entry?.url,
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
  expectedDescriptorSha256 = sha256File(descriptorPath),
}) {
  const allAssetsByName = assetMap(assets);
  const digestByName = new Map();
  for (const [name, asset] of allAssetsByName) {
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
  if (sha256File(downloadedDescriptor) !== expectedDescriptorSha256) {
    throw new Error(
      "Published descriptor bytes differ from the expected descriptor.",
    );
  }

  const { channelAssetsByName, productAssetsByName } =
    descriptor.release.prerelease === false
      ? splitStableReleaseAssets(descriptor, allAssetsByName)
      : {
          channelAssetsByName: new Map(),
          productAssetsByName: allAssetsByName,
        };
  const assetsByName = productAssetsByName;

  for (const name of allAssetsByName.keys()) {
    if (name.endsWith(".asc")) {
      const baseName = name.slice(0, -4);
      if (allAssetsByName.has(baseName)) {
        verifyGpgSignature(
          path.join(directory, baseName),
          path.join(directory, name),
          descriptor.release.signingKeyFingerprint,
        );
      }
    }
    if (name.endsWith(".sig")) {
      const baseName = name.slice(0, -4);
      if (allAssetsByName.has(baseName)) {
        verifyUpdaterSignature(
          path.join(directory, baseName),
          path.join(directory, name),
        );
      }
    }
  }

  verifyChecksumFiles(directory, assetsByName, digestByName);
  verifyUpdaterManifests(directory, assetsByName, descriptor);

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
  return {
    allAssetsByName,
    assetIndex,
    assetsByName,
    attestations,
    channelAssetsByName,
    digestByName,
  };
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
      descriptor,
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
    descriptor,
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
    descriptor,
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
        descriptor,
      );
      const channelState =
        descriptor.release.prerelease === false
          ? verifyBetaChannelOverlay({
              carrier: release,
              carrierDescriptor: descriptor,
              carrierDescriptorSha256:
                verification.digestByName.get(DESCRIPTOR_NAME),
              channelAssetsByName: verification.channelAssetsByName,
              digestByName: verification.digestByName,
              directory,
              productIndexSha256: verification.digestByName.get(
                RELEASE_ASSET_INDEX_NAME,
              ),
            })
          : null;
      return {
        channelState,
        release,
        publicAssets: confirmedPublicAssets,
        directory,
        verification,
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

function assertRemoteAssetSnapshot(expected, actual, label) {
  if (expected.size !== actual.size) {
    throw new Error(`${label} asset set changed during verification.`);
  }
  for (const [name, expectedAsset] of expected) {
    const actualAsset = actual.get(name);
    const expectedSha256 = githubAssetSha256(expectedAsset);
    if (
      !expectedSha256 ||
      actualAsset?.id !== expectedAsset.id ||
      githubAssetSha256(actualAsset) !== expectedSha256
    ) {
      throw new Error(`${label} asset changed during verification: ${name}.`);
    }
  }
}

function permanentChannelAssetMap(descriptor, channelAssetsByName) {
  const permanent = new Map();
  for (const name of permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  )) {
    if (channelAssetsByName.has(name)) {
      permanent.set(name, channelAssetsByName.get(name));
    }
  }
  return permanent;
}

async function verifyLatestStableCarrier({
  allowIncompleteControl = false,
  allowRollover = false,
  allowTransaction = false,
  downloadAssets = downloadDraftAssets,
  listAssets = listAuthenticatedAssets,
  releaseId = null,
  requireLatest = releaseId === null,
  request = (method, endpoint, body) =>
    Promise.resolve(githubApi(method, endpoint, body)),
} = {}) {
  const carrier = await request(
    "GET",
    releaseId === null
      ? `/repos/${owner}/${repositoryName}/releases/latest`
      : `/repos/${owner}/${repositoryName}/releases/${releaseId}`,
  );
  if (
    !Number.isSafeInteger(carrier?.id) ||
    (releaseId !== null && carrier.id !== releaseId) ||
    carrier.draft !== false ||
    carrier.prerelease !== false ||
    typeof carrier.tag_name !== "string" ||
    carrier.tag_name.length === 0
  ) {
    throw new Error("GitHub Latest is not a published stable carrier.");
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-stable-carrier-"),
  );
  try {
    const assets = await listAssets(carrier.id);
    await Promise.resolve(downloadAssets(assets, directory));
    const carrierDescriptorPath = path.join(directory, DESCRIPTOR_NAME);
    const carrierSignaturePath = path.join(
      directory,
      DESCRIPTOR_SIGNATURE_NAME,
    );
    const carrierDescriptor = readReleaseDescriptor(carrierDescriptorPath);
    assertDescriptorRepository(carrierDescriptor, {
      name: repositoryName,
      owner,
    });
    verifyDescriptorSignature(carrierDescriptorPath, carrierSignaturePath);
    verifyDescriptorSignature(
      carrierDescriptorPath,
      carrierSignaturePath,
      carrierDescriptor.release.signingKeyFingerprint,
    );
    validateMutableRelease(carrier, {
      expectedId: carrierDescriptor.release.id,
      expectedPrerelease: false,
      expectedTag: carrierDescriptor.release.tag,
      expectedTargetCommitish: carrierDescriptor.source.commit,
      requireDraft: false,
    });
    await assertGitHubTagCommit(request, {
      expectedCommit: carrierDescriptor.source.commit,
      owner,
      repository: repositoryName,
      tag: carrierDescriptor.release.tag,
    });

    const carrierDescriptorSha256 = sha256File(carrierDescriptorPath);
    const verification = verifyDownloadedAssetSet({
      assets,
      descriptor: carrierDescriptor,
      directory,
      expectedDescriptorSha256: carrierDescriptorSha256,
      requireAssetIndex: true,
    });
    const confirmedAssets = await listAssets(carrier.id);
    const confirmedByName = assetMap(confirmedAssets);
    assertReleaseAssetIndexEntries(
      verification.assetIndex,
      confirmedByName,
      verification.digestByName,
      carrierDescriptor,
    );
    const confirmedSplit = splitStableReleaseAssets(
      carrierDescriptor,
      confirmedByName,
    );
    assertRemoteAssetSnapshot(
      verification.channelAssetsByName,
      confirmedSplit.channelAssetsByName,
      "Stable carrier channel",
    );
    const productIndexSha256 = verification.digestByName.get(
      RELEASE_ASSET_INDEX_NAME,
    );
    const productSnapshot = new Map(
      Array.from(verification.assetsByName, ([name, asset]) => {
        const sha256 = githubAssetSha256(asset);
        if (!sha256) {
          throw new Error(
            `Stable carrier product asset ${name} has no GitHub SHA-256 digest.`,
          );
        }
        return [name, { id: asset.id, sha256 }];
      }),
    );

    const channelAssets = verification.channelAssetsByName;
    const transactionAssets = new Map(
      [BETA_CHANNEL_TRANSACTION_NAME, BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME]
        .filter((name) => channelAssets.has(name))
        .map((name) => [name, channelAssets.get(name)]),
    );
    const rolloverAssets = new Map(
      [BETA_CHANNEL_ROLLOVER_NAME, BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME]
        .filter((name) => channelAssets.has(name))
        .map((name) => [name, channelAssets.get(name)]),
    );
    const stageOrBackupNames = operationalBetaChannelAssetNames(
      carrierDescriptor.expectedTargets,
    ).filter(
      (name) =>
        channelAssets.has(name) &&
        !transactionAssets.has(name) &&
        !rolloverAssets.has(name),
    );
    if (transactionAssets.size > 0 && rolloverAssets.size > 0) {
      throw new Error(
        "Stable carrier has conflicting beta promotion and rollover controls.",
      );
    }

    let incompleteControl = null;
    for (const [kind, controlAssets] of [
      ["transaction", transactionAssets],
      ["rollover", rolloverAssets],
    ]) {
      if (controlAssets.size === 1) {
        if (!allowIncompleteControl || stageOrBackupNames.length > 0) {
          throw new Error(`Beta channel ${kind} signature pair is incomplete.`);
        }
        const expectedAsset = Array.from(controlAssets.values())[0];
        if (!githubAssetSha256(expectedAsset)) {
          throw new Error(
            `Incomplete beta channel ${kind} asset has no GitHub SHA-256 digest.`,
          );
        }
        incompleteControl = { expectedAsset, kind };
      }
    }
    if (stageOrBackupNames.length > 0 && transactionAssets.size !== 2) {
      throw new Error(
        `Stable carrier has unjournaled beta channel mutations: ${stageOrBackupNames.sort().join(", ")}.`,
      );
    }

    let transaction = null;
    if (transactionAssets.size === 2) {
      const transactionPath = path.join(
        directory,
        BETA_CHANNEL_TRANSACTION_NAME,
      );
      verifyDescriptorSignature(
        transactionPath,
        path.join(directory, BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
        carrierDescriptor.release.signingKeyFingerprint,
      );
      transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
      if (
        fs.readFileSync(transactionPath, "utf8") !== canonicalJson(transaction)
      ) {
        throw new Error("Beta channel transaction is not canonical JSON.");
      }
      validateBetaChannelTransaction(transaction, {
        carrier,
        carrierDescriptorSha256,
        expectedNames: permanentBetaChannelAssetNames(
          carrierDescriptor.expectedTargets,
        ),
        productIndexSha256,
      });
      if (!allowTransaction) {
        throw new Error(
          "Stable carrier has an unfinished beta channel transaction.",
        );
      }
    }

    const permanentAssets = permanentChannelAssetMap(
      carrierDescriptor,
      channelAssets,
    );
    const channelState = transaction
      ? null
      : verifyBetaChannelOverlay({
          carrier,
          carrierDescriptor,
          carrierDescriptorSha256,
          channelAssetsByName: permanentAssets,
          digestByName: verification.digestByName,
          directory,
          productIndexSha256,
        });
    const channelRecords = channelState
      ? new Map(
          permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets).map(
            (name) => [name, verification.digestByName.get(name)],
          ),
        )
      : new Map();

    let rollover = null;
    if (rolloverAssets.size === 2) {
      const rolloverPath = path.join(directory, BETA_CHANNEL_ROLLOVER_NAME);
      verifyDescriptorSignature(
        rolloverPath,
        path.join(directory, BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME),
        carrierDescriptor.release.signingKeyFingerprint,
      );
      rollover = JSON.parse(fs.readFileSync(rolloverPath, "utf8"));
      if (fs.readFileSync(rolloverPath, "utf8") !== canonicalJson(rollover)) {
        throw new Error("Stable rollover lease is not canonical JSON.");
      }
      const leasedRecords = validateBetaChannelRollover(rollover, {
        carrier,
        carrierDescriptorSha256,
        carrierVersion: carrierDescriptor.release.version,
        expectedTargets: carrierDescriptor.expectedTargets,
        productIndexSha256,
      });
      const sortedRecordEntries = (records) =>
        Array.from(records).sort(([left], [right]) =>
          left.localeCompare(right),
        );
      if (
        canonicalJson(sortedRecordEntries(leasedRecords)) !==
        canonicalJson(sortedRecordEntries(channelRecords))
      ) {
        throw new Error("Stable rollover lease channel snapshot is stale.");
      }
      if (stageOrBackupNames.length > 0) {
        throw new Error(
          "Stable rollover lease overlaps a beta channel mutation.",
        );
      }
      if (!allowRollover) {
        throw new Error("Stable carrier has an active rollover lease.");
      }
    }

    const assertProductSnapshot = (listed) => {
      const productAssets = splitStableReleaseAssets(
        carrierDescriptor,
        assetMap(listed),
      ).productAssetsByName;
      if (productAssets.size !== productSnapshot.size) {
        throw new Error(
          "Stable carrier product asset set changed during channel mutation.",
        );
      }
      for (const [name, expected] of productSnapshot) {
        const current = productAssets.get(name);
        if (
          current?.id !== expected.id ||
          githubAssetSha256(current) !== expected.sha256
        ) {
          throw new Error(
            `Stable carrier product asset changed during channel mutation: ${name}.`,
          );
        }
      }
      return true;
    };
    const assertCarrierById = async (currentAssets = null) => {
      const byId = await request(
        "GET",
        `/repos/${owner}/${repositoryName}/releases/${carrier.id}`,
      );
      validateMutableRelease(byId, {
        expectedId: carrier.id,
        expectedPrerelease: false,
        expectedTag: carrier.tag_name,
        expectedTargetCommitish: carrierDescriptor.source.commit,
        requireDraft: false,
      });
      const listed = currentAssets ?? (await listAssets(carrier.id));
      return assertProductSnapshot(listed);
    };
    const assertCarrier = async (currentAssets = null) => {
      if (!requireLatest) return assertCarrierById(currentAssets);
      const latest = await request(
        "GET",
        `/repos/${owner}/${repositoryName}/releases/latest`,
      );
      validateMutableRelease(latest, {
        expectedId: carrier.id,
        expectedPrerelease: false,
        expectedTag: carrier.tag_name,
        expectedTargetCommitish: carrierDescriptor.source.commit,
        requireDraft: false,
      });
      return assertCarrierById(currentAssets);
    };

    await assertCarrier(confirmedAssets);
    return {
      assertCarrier,
      assertCarrierById,
      carrier,
      carrierDescriptor,
      carrierDescriptorSha256,
      channelRecords,
      channelState,
      directory,
      incompleteControl,
      listAssets,
      productIndexSha256,
      productSnapshot,
      rollover,
      rolloverAssets,
      transaction,
      transactionAssets,
      verification,
      dispose() {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function defaultFetchLatestChannelAsset(name) {
  const response = await fetch(
    `https://github.com/${owner}/${repositoryName}/releases/latest/download/${encodeURIComponent(name)}`,
    { redirect: "follow" },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub Latest beta channel asset ${name} returned HTTP ${response.status}.`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function verifyLatestChannelRecords(
  carrierContext,
  records,
  { fetchLatestAsset = defaultFetchLatestChannelAsset } = {},
) {
  const expectedNames = permanentBetaChannelAssetNames(
    carrierContext.carrierDescriptor.expectedTargets,
  );
  const expected = new Map(records);
  if (expected.size !== 0 && expected.size !== expectedNames.length) {
    throw new Error("Beta channel verification record set is incomplete.");
  }
  const assets = await carrierContext.listAssets(carrierContext.carrier.id);
  await carrierContext.assertCarrier(assets);
  const channelAssetsByName = splitStableReleaseAssets(
    carrierContext.carrierDescriptor,
    assetMap(assets),
  ).channelAssetsByName;
  if (expected.size === 0) {
    if (expectedNames.some((name) => channelAssetsByName.has(name))) {
      throw new Error("Beta channel was expected to be empty.");
    }
    return null;
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-latest-channel-"),
  );
  try {
    const permanentAssets = new Map();
    const digestByName = new Map();
    for (const name of expectedNames) {
      const expectedSha256 = expected.get(name);
      const asset = channelAssetsByName.get(name);
      if (!expectedSha256 || githubAssetSha256(asset) !== expectedSha256) {
        throw new Error(
          `GitHub Latest beta channel digest mismatch for ${name}.`,
        );
      }
      const bytes = await fetchLatestAsset(name);
      if (sha256FileBuffer(bytes) !== expectedSha256) {
        throw new Error(
          `GitHub Latest download bytes differ for beta channel asset ${name}.`,
        );
      }
      fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
      permanentAssets.set(name, asset);
      digestByName.set(name, expectedSha256);
    }
    return verifyBetaChannelOverlay({
      carrier: carrierContext.carrier,
      carrierDescriptor: carrierContext.carrierDescriptor,
      carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
      channelAssetsByName: permanentAssets,
      digestByName,
      directory,
      productIndexSha256: carrierContext.productIndexSha256,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function sha256FileBuffer(value) {
  return require("node:crypto")
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function permanentChannelRecords(carrierContext) {
  return new Map(carrierContext.channelRecords || []);
}

function assertStableRolloverOrder(descriptor, carrierDescriptor) {
  if (
    compareSemanticVersions(
      descriptor.release.version,
      carrierDescriptor.release.version,
    ) <= 0
  ) {
    throw new Error(
      `Stable release ${descriptor.release.version} does not advance GitHub Latest ${carrierDescriptor.release.version}.`,
    );
  }
  return true;
}

function assertBetaPromotionOrder(
  sourceDescriptor,
  sourceDescriptorSha256,
  carrierContext,
) {
  const current = carrierContext.channelState;
  if (current?.source?.descriptorSha256 === sourceDescriptorSha256) {
    if (
      current.source.id !== sourceDescriptor.release.id ||
      current.source.tag !== sourceDescriptor.release.tag ||
      current.source.version !== sourceDescriptor.release.version ||
      current.source.sourceCommit !== sourceDescriptor.source.commit
    ) {
      throw new Error(
        "Installed beta channel source identity is inconsistent.",
      );
    }
    return "unchanged";
  }
  if (
    compareSemanticVersions(
      sourceDescriptor.release.version,
      carrierContext.carrierDescriptor.release.version,
    ) <= 0
  ) {
    throw new Error(
      `Beta release ${sourceDescriptor.release.version} does not advance stable carrier ${carrierContext.carrierDescriptor.release.version}.`,
    );
  }
  if (!current) return "advance";
  if (
    compareSemanticVersions(
      sourceDescriptor.release.version,
      current.source.version,
    ) <= 0
  ) {
    throw new Error(
      `Beta release ${sourceDescriptor.release.version} does not advance installed beta ${current.source.version}.`,
    );
  }
  return "advance";
}

function writeSignedChannelMetadata(
  directory,
  name,
  value,
  environment,
  sourceCommittedAt,
) {
  const filePath = path.join(directory, name);
  const signaturePath = `${filePath}.asc`;
  fs.writeFileSync(filePath, canonicalJson(value), { mode: 0o600 });
  signDescriptor(filePath, signaturePath, {
    ...environment,
    SOURCE_DATE_EPOCH: String(Math.floor(Date.parse(sourceCommittedAt) / 1000)),
  });
  return [filePath, signaturePath];
}

async function repairIncompleteChannelControl(
  carrierContext,
  { fetchLatestAsset = defaultFetchLatestChannelAsset } = {},
) {
  if (!carrierContext.incompleteControl) return false;
  const records = permanentChannelRecords(carrierContext);
  await recoverIncompleteChannelControlPair({
    assertCarrier: carrierContext.assertCarrier,
    deleteAsset: (assetId) =>
      Promise.resolve(deleteReleaseAssetById(repository, assetId)),
    descriptor: carrierContext.carrierDescriptor,
    expectedAsset: carrierContext.incompleteControl.expectedAsset,
    kind: carrierContext.incompleteControl.kind,
    listAssets: carrierContext.listAssets,
    releaseId: carrierContext.carrier.id,
    verifyPermanent: () =>
      verifyLatestChannelRecords(carrierContext, records, {
        fetchLatestAsset,
      }),
  });
  return true;
}

async function promoteBetaChannel(
  sourceDescriptor,
  verifiedSource,
  {
    environment = process.env,
    fetchLatestAsset = defaultFetchLatestChannelAsset,
    publicationOwner,
  } = {},
) {
  validatePublicationOwner(publicationOwner);
  const sourceDescriptorSha256 = sha256File(
    path.join(verifiedSource.directory, DESCRIPTOR_NAME),
  );
  const source = extractBetaChannelSource({
    assetsByName: assetMap(verifiedSource.publicAssets),
    descriptor: sourceDescriptor,
    directory: verifiedSource.directory,
  });
  let carrierContext = await verifyLatestStableCarrier({
    allowIncompleteControl: true,
    allowTransaction: true,
  });
  try {
    if (carrierContext.transaction) {
      const transactionRecords = validateBetaChannelTransaction(
        carrierContext.transaction,
        {
          carrier: carrierContext.carrier,
          carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
          expectedNames: permanentBetaChannelAssetNames(
            carrierContext.carrierDescriptor.expectedTargets,
          ),
          expectedOwner: publicationOwner,
          productIndexSha256: carrierContext.productIndexSha256,
        },
      );
      if (
        carrierContext.transaction.source.descriptorSha256 !==
          sourceDescriptorSha256 ||
        carrierContext.transaction.source.id !== sourceDescriptor.release.id ||
        carrierContext.transaction.source.tag !== sourceDescriptor.release.tag
      ) {
        throw new Error(
          "Active beta channel transaction belongs to a different prerelease.",
        );
      }
      await recoverBetaChannelTransaction({
        assertCarrier: carrierContext.assertCarrier,
        deleteAsset: (assetId) =>
          Promise.resolve(deleteReleaseAssetById(repository, assetId)),
        descriptor: carrierContext.carrierDescriptor,
        expectedOwner: publicationOwner,
        listAssets: listAuthenticatedAssets,
        releaseId: carrierContext.carrier.id,
        renameAsset: (assetId, name) =>
          Promise.resolve(
            githubApi(
              "PATCH",
              `/repos/${owner}/${repositoryName}/releases/assets/${assetId}`,
              { name },
            ),
          ),
        transaction: carrierContext.transaction,
        transactionAssets: carrierContext.transactionAssets,
        verifyDesired: () =>
          verifyLatestChannelRecords(
            carrierContext,
            transactionRecords.desired,
            { fetchLatestAsset },
          ),
        verifyPrevious: () =>
          verifyLatestChannelRecords(
            carrierContext,
            transactionRecords.previous,
            { fetchLatestAsset },
          ),
      });
      carrierContext.dispose();
      carrierContext = await verifyLatestStableCarrier();
    }

    if (
      assertBetaPromotionOrder(
        sourceDescriptor,
        sourceDescriptorSha256,
        carrierContext,
      ) === "unchanged"
    ) {
      return "already-promoted";
    }

    const metadataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-beta-metadata-"),
    );
    try {
      const state = createBetaChannelState({
        assetRecords: source.records,
        carrier: carrierContext.carrier,
        carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
        productIndexSha256: carrierContext.productIndexSha256,
        sourceDescriptor,
        sourceDescriptorSha256,
      });
      const [statePath, stateSignaturePath] = writeSignedChannelMetadata(
        metadataDirectory,
        BETA_CHANNEL_STATE_NAME,
        state,
        environment,
        sourceDescriptor.source.committedAt,
      );
      const desiredFilesByName = new Map(source.filesByName);
      desiredFilesByName.set(BETA_CHANNEL_STATE_NAME, statePath);
      desiredFilesByName.set(
        BETA_CHANNEL_STATE_SIGNATURE_NAME,
        stateSignaturePath,
      );
      const desiredRecords = new Map(
        Array.from(desiredFilesByName, ([name, filePath]) => [
          name,
          sha256File(filePath),
        ]),
      );
      const previousRecords = permanentChannelRecords(carrierContext);
      const transaction = createBetaChannelTransaction({
        carrier: carrierContext.carrier,
        carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
        desiredRecords,
        owner: publicationOwner,
        previousRecords,
        productIndexSha256: carrierContext.productIndexSha256,
        sourceDescriptorSha256,
        sourceCommit: sourceDescriptor.source.commit,
        sourceReleaseId: sourceDescriptor.release.id,
        sourceTag: sourceDescriptor.release.tag,
        sourceVersion: sourceDescriptor.release.version,
      });
      const transactionFiles = writeSignedChannelMetadata(
        metadataDirectory,
        BETA_CHANNEL_TRANSACTION_NAME,
        transaction,
        environment,
        sourceDescriptor.source.committedAt,
      );
      if (carrierContext.incompleteControl) {
        const expectedFile = transactionFiles.find(
          (filePath) =>
            path.basename(filePath) ===
            carrierContext.incompleteControl.expectedAsset.name,
        );
        if (
          carrierContext.incompleteControl.kind !== "transaction" ||
          !expectedFile ||
          sha256File(expectedFile) !==
            githubAssetSha256(carrierContext.incompleteControl.expectedAsset)
        ) {
          throw new Error(
            "Incomplete channel control asset is not owned by this publication session.",
          );
        }
        await repairIncompleteChannelControl(carrierContext, {
          fetchLatestAsset,
        });
        carrierContext.incompleteControl = null;
      }

      await promoteBetaChannelAssets({
        assertCarrier: carrierContext.assertCarrier,
        deleteAsset: (assetId) =>
          Promise.resolve(deleteReleaseAssetById(repository, assetId)),
        descriptor: carrierContext.carrierDescriptor,
        desiredFilesByName,
        listAssets: listAuthenticatedAssets,
        publicationOwner,
        releaseId: carrierContext.carrier.id,
        renameAsset: (assetId, name) =>
          Promise.resolve(
            githubApi(
              "PATCH",
              `/repos/${owner}/${repositoryName}/releases/assets/${assetId}`,
              { name },
            ),
          ),
        transaction,
        transactionFiles,
        uploadAsset: (releaseId, filePath) =>
          Promise.resolve(
            uploadReleaseAssetById(repository, releaseId, filePath),
          ),
        verifyDesired: () =>
          verifyLatestChannelRecords(carrierContext, desiredRecords, {
            fetchLatestAsset,
          }),
        verifyPrevious: () =>
          verifyLatestChannelRecords(carrierContext, previousRecords, {
            fetchLatestAsset,
          }),
      });
    } finally {
      fs.rmSync(metadataDirectory, { recursive: true, force: true });
    }
  } finally {
    carrierContext.dispose();
  }

  const confirmed = await verifyLatestStableCarrier();
  try {
    const expectedDescriptorSha256 = sha256File(
      path.join(verifiedSource.directory, DESCRIPTOR_NAME),
    );
    if (
      confirmed.channelState?.source?.descriptorSha256 !==
      expectedDescriptorSha256
    ) {
      throw new Error(
        "GitHub Latest beta channel does not reference the verified prerelease descriptor.",
      );
    }
    await verifyLatestChannelRecords(
      confirmed,
      permanentChannelRecords(confirmed),
      { fetchLatestAsset },
    );
  } finally {
    confirmed.dispose();
  }
  return "promoted";
}

async function assertStableRolloverLeaseOwned(carrierContext) {
  const assets = await carrierContext.listAssets(carrierContext.carrier.id);
  await carrierContext.assertCarrier(assets);
  const channelAssets = splitStableReleaseAssets(
    carrierContext.carrierDescriptor,
    assetMap(assets),
  ).channelAssetsByName;
  const currentLease = new Map(
    [BETA_CHANNEL_ROLLOVER_NAME, BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME]
      .filter((name) => channelAssets.has(name))
      .map((name) => [name, channelAssets.get(name)]),
  );
  assertRemoteAssetSnapshot(
    carrierContext.rolloverAssets,
    currentLease,
    "Stable rollover lease ownership",
  );
  return true;
}

async function uploadStableDraftChannelAsset(
  release,
  descriptor,
  filePath,
  carrierContext,
  {
    getRelease = (releaseId) =>
      Promise.resolve(
        githubApi(
          "GET",
          `/repos/${owner}/${repositoryName}/releases/${releaseId}`,
        ),
      ),
    listAssets = listAuthenticatedAssets,
    uploadAsset = (releaseId, currentFilePath) =>
      Promise.resolve(
        uploadReleaseAssetById(repository, releaseId, currentFilePath),
      ),
  } = {},
) {
  const allowed = new Set(
    permanentBetaChannelAssetNames(descriptor.expectedTargets),
  );
  const name = path.basename(filePath);
  if (!allowed.has(name)) {
    throw new Error(`Stable rollover rejected non-channel asset ${name}.`);
  }
  const currentRelease = await getRelease(release.id);
  validateMutableRelease(currentRelease, releaseOptions(descriptor, true));
  const existing = assetMap(await listAssets(release.id));
  const action = classifyImmutableAsset(existing.get(name), filePath);
  await assertStableRolloverLeaseOwned(carrierContext);
  if (action === "upload") {
    await uploadAsset(release.id, filePath);
  }
  await assertStableRolloverLeaseOwned(carrierContext);
  const confirmed = assetMap(await listAssets(release.id)).get(name);
  if (githubAssetSha256(confirmed) !== sha256File(filePath)) {
    throw new Error(`Stable rollover upload verification failed for ${name}.`);
  }
  return confirmed;
}

async function deleteOwnedStableDraftChannelAssets(
  release,
  descriptor,
  carrierContext,
  ownedAssets,
  {
    deleteAsset = (assetId) =>
      Promise.resolve(deleteReleaseAssetById(repository, assetId)),
    getRelease = (releaseId) =>
      Promise.resolve(
        githubApi(
          "GET",
          `/repos/${owner}/${repositoryName}/releases/${releaseId}`,
        ),
      ),
    listAssets = listAuthenticatedAssets,
  } = {},
) {
  const allowedNames = permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  for (const name of allowedNames) {
    const expected = ownedAssets.get(name);
    if (!expected) continue;
    const currentRelease = await getRelease(release.id);
    validateMutableRelease(currentRelease, releaseOptions(descriptor, true));
    const current = assetMap(await listAssets(release.id)).get(name);
    if (!current) continue;
    if (
      current.id !== expected.id ||
      githubAssetSha256(current) !== githubAssetSha256(expected)
    ) {
      throw new Error(
        `Refusing to delete changed stable channel asset ${name}.`,
      );
    }
    await assertStableRolloverLeaseOwned(carrierContext);
    await deleteAsset(current.id);
    await assertStableRolloverLeaseOwned(carrierContext);
  }
  const confirmed = assetMap(await listAssets(release.id));
  const remaining = allowedNames.filter(
    (name) => ownedAssets.has(name) && confirmed.has(name),
  );
  if (remaining.length > 0) {
    throw new Error(
      `Stable draft channel cleanup did not converge: ${remaining.join(", ")}.`,
    );
  }
  ownedAssets.clear();
}

async function uploadOwnedStableDraftChannelAsset(
  release,
  descriptor,
  filePath,
  carrierContext,
) {
  const name = path.basename(filePath);
  try {
    const confirmed = await uploadStableDraftChannelAsset(
      release,
      descriptor,
      filePath,
      carrierContext,
    );
    carrierContext.successorChannelAssets.set(name, confirmed);
    return confirmed;
  } catch (error) {
    const current = assetMap(await listAuthenticatedAssets(release.id)).get(
      name,
    );
    if (githubAssetSha256(current) === sha256File(filePath)) {
      carrierContext.successorChannelAssets.set(name, current);
    }
    throw error;
  }
}

async function uploadStableDraftReceiptAsset(
  release,
  descriptor,
  filePath,
  carrierContext,
) {
  const name = path.basename(filePath);
  if (
    name !== STABLE_ROLLOVER_RECEIPT_NAME &&
    name !== STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME
  ) {
    throw new Error(`Stable rollover rejected receipt asset ${name}.`);
  }
  const currentRelease = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  validateMutableRelease(currentRelease, releaseOptions(descriptor, true));
  const existing = assetMap(await listAuthenticatedAssets(release.id));
  const action = classifyImmutableAsset(existing.get(name), filePath);
  await assertStableRolloverLeaseOwned(carrierContext);
  if (action === "upload") {
    await Promise.resolve(
      uploadReleaseAssetById(repository, release.id, filePath),
    );
  }
  await assertStableRolloverLeaseOwned(carrierContext);
  const confirmed = assetMap(await listAuthenticatedAssets(release.id)).get(
    name,
  );
  if (githubAssetSha256(confirmed) !== sha256File(filePath)) {
    throw new Error(`Stable rollover receipt upload failed for ${name}.`);
  }
  return confirmed;
}

async function deleteOwnedSuccessorReceiptAssets(
  release,
  descriptor,
  ownedAssets,
  { carrierContext = null, requireDraft },
) {
  const currentRelease = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  validateMutableRelease(
    currentRelease,
    releaseOptions(descriptor, requireDraft),
  );
  if (!requireDraft && currentRelease.draft !== false) {
    throw new Error("Stable rollover receipt successor is not published.");
  }
  for (const name of [
    STABLE_ROLLOVER_RECEIPT_NAME,
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  ]) {
    const expected = ownedAssets.get(name);
    if (!expected) continue;
    const current = assetMap(await listAuthenticatedAssets(release.id)).get(
      name,
    );
    if (!current) continue;
    if (
      current.id !== expected.id ||
      githubAssetSha256(current) !== githubAssetSha256(expected)
    ) {
      throw new Error(`Refusing to delete changed rollover receipt ${name}.`);
    }
    if (carrierContext) {
      await assertStableRolloverLeaseOwned(carrierContext);
    }
    await Promise.resolve(deleteReleaseAssetById(repository, current.id));
    if (carrierContext) {
      await assertStableRolloverLeaseOwned(carrierContext);
    }
  }
  const confirmed = assetMap(await listAuthenticatedAssets(release.id));
  if (
    confirmed.has(STABLE_ROLLOVER_RECEIPT_NAME) ||
    confirmed.has(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME)
  ) {
    throw new Error("Stable rollover receipt cleanup did not converge.");
  }
}

function assertSameChannelRecords(actual, expected, label) {
  const sorted = (records) =>
    Array.from(records).sort(([left], [right]) => left.localeCompare(right));
  if (canonicalJson(sorted(actual)) !== canonicalJson(sorted(expected))) {
    throw new Error(
      `${label} does not match the leased beta channel snapshot.`,
    );
  }
}

async function assertRolloverAcquisitionState(
  carrierContext,
  assets,
  ownedRolloverAssets,
  pendingName = null,
) {
  await carrierContext.assertCarrier(assets);
  const channelAssets = splitStableReleaseAssets(
    carrierContext.carrierDescriptor,
    assetMap(assets),
  ).channelAssetsByName;
  assertRemoteAssetSnapshot(
    permanentChannelAssetMap(
      carrierContext.carrierDescriptor,
      carrierContext.verification.channelAssetsByName,
    ),
    permanentChannelAssetMap(carrierContext.carrierDescriptor, channelAssets),
    "Stable rollover beta channel",
  );
  const permanentNames = new Set(
    permanentBetaChannelAssetNames(
      carrierContext.carrierDescriptor.expectedTargets,
    ),
  );
  const unexpected = Array.from(channelAssets.keys()).filter(
    (name) =>
      !permanentNames.has(name) &&
      !ownedRolloverAssets.has(name) &&
      name !== pendingName,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Stable rollover lease acquisition found conflicting controls: ${unexpected.sort().join(", ")}.`,
    );
  }
  for (const [name, expected] of ownedRolloverAssets) {
    const current = channelAssets.get(name);
    if (
      current?.id !== expected.id ||
      githubAssetSha256(current) !== githubAssetSha256(expected)
    ) {
      throw new Error(`Stable rollover lease ownership changed for ${name}.`);
    }
  }
  return channelAssets;
}

async function uploadRolloverControlAsset(
  carrierContext,
  filePath,
  ownedRolloverAssets,
) {
  const name = path.basename(filePath);
  if (
    name !== BETA_CHANNEL_ROLLOVER_NAME &&
    name !== BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME
  ) {
    throw new Error(`Stable rollover rejected control asset ${name}.`);
  }
  let assets = await carrierContext.listAssets(carrierContext.carrier.id);
  let channelAssets = await assertRolloverAcquisitionState(
    carrierContext,
    assets,
    ownedRolloverAssets,
  );
  let current = channelAssets.get(name);
  const expectedSha256 = sha256File(filePath);
  if (current && githubAssetSha256(current) !== expectedSha256) {
    throw new Error(`Stable rollover control collision for ${name}.`);
  }
  if (!current) {
    await Promise.resolve(
      uploadReleaseAssetById(repository, carrierContext.carrier.id, filePath),
    );
  }
  assets = await carrierContext.listAssets(carrierContext.carrier.id);
  channelAssets = await assertRolloverAcquisitionState(
    carrierContext,
    assets,
    ownedRolloverAssets,
    name,
  );
  current = channelAssets.get(name);
  if (githubAssetSha256(current) !== expectedSha256) {
    throw new Error(`Stable rollover control upload failed for ${name}.`);
  }
  return current;
}

async function deleteOwnedRolloverAssets(
  carrierContext,
  ownedAssets,
  { requireLatest },
) {
  for (const name of [
    BETA_CHANNEL_ROLLOVER_NAME,
    BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  ]) {
    const expected = ownedAssets.get(name);
    if (!expected) continue;
    const assets = await carrierContext.listAssets(carrierContext.carrier.id);
    const current = assetMap(assets).get(name);
    if (!current) continue;
    if (
      current.id !== expected.id ||
      githubAssetSha256(current) !== githubAssetSha256(expected)
    ) {
      throw new Error(
        `Refusing to delete changed rollover lease asset ${name}.`,
      );
    }
    if (requireLatest) await carrierContext.assertCarrier(assets);
    else await carrierContext.assertCarrierById(assets);
    await Promise.resolve(deleteReleaseAssetById(repository, current.id));
  }
  const confirmed = await carrierContext.listAssets(carrierContext.carrier.id);
  const confirmedByName = assetMap(confirmed);
  if (
    confirmedByName.has(BETA_CHANNEL_ROLLOVER_NAME) ||
    confirmedByName.has(BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME)
  ) {
    throw new Error("Stable rollover lease cleanup did not converge.");
  }
  if (requireLatest) await carrierContext.assertCarrier(confirmed);
  else await carrierContext.assertCarrierById(confirmed);
}

function assertRolloverMatchesSuccessor(
  carrierContext,
  release,
  descriptor,
  frozen,
  publicationOwner,
) {
  if (!carrierContext.rollover) {
    throw new Error("Stable rollover lease is missing.");
  }
  const records = validateBetaChannelRollover(carrierContext.rollover, {
    carrier: carrierContext.carrier,
    carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
    carrierVersion: carrierContext.carrierDescriptor.release.version,
    expectedTargets: carrierContext.carrierDescriptor.expectedTargets,
    expectedOwner: publicationOwner,
    productIndexSha256: carrierContext.productIndexSha256,
    successor: release,
    successorDescriptor: descriptor,
    successorDescriptorSha256: sha256File(descriptorPath),
    successorProductIndexSha256: frozen.digestByName.get(
      RELEASE_ASSET_INDEX_NAME,
    ),
  });
  assertSameChannelRecords(
    records,
    permanentChannelRecords(carrierContext),
    "Stable rollover lease",
  );
  return records;
}

async function acquireStableRolloverLease(
  release,
  descriptor,
  frozen,
  publicationOwner,
  environment = process.env,
) {
  validatePublicationOwner(publicationOwner);
  let carrierContext = await verifyLatestStableCarrier({
    allowIncompleteControl: true,
    allowRollover: true,
  });
  try {
    const successorNames = expectedBetaChannelAssetNames(
      descriptor.expectedTargets,
    );
    const carrierNames = expectedBetaChannelAssetNames(
      carrierContext.carrierDescriptor.expectedTargets,
    );
    if (canonicalJson(successorNames) !== canonicalJson(carrierNames)) {
      throw new Error(
        "Stable rollover target set differs from the current beta channel carrier.",
      );
    }
    assertStableRolloverOrder(descriptor, carrierContext.carrierDescriptor);
    if (carrierContext.rollover) {
      assertRolloverMatchesSuccessor(
        carrierContext,
        release,
        descriptor,
        frozen,
        publicationOwner,
      );
      return carrierContext;
    }
    const rollover = createBetaChannelRollover({
      carrier: carrierContext.carrier,
      carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
      carrierVersion: carrierContext.carrierDescriptor.release.version,
      channelRecords: permanentChannelRecords(carrierContext),
      owner: publicationOwner,
      productIndexSha256: carrierContext.productIndexSha256,
      successor: release,
      successorDescriptor: descriptor,
      successorDescriptorSha256: sha256File(descriptorPath),
      successorProductIndexSha256: frozen.digestByName.get(
        RELEASE_ASSET_INDEX_NAME,
      ),
    });
    const [rolloverPath, rolloverSignaturePath] = writeSignedChannelMetadata(
      carrierContext.directory,
      BETA_CHANNEL_ROLLOVER_NAME,
      rollover,
      environment,
      descriptor.source.committedAt,
    );
    if (carrierContext.incompleteControl) {
      const expectedFile = [rolloverPath, rolloverSignaturePath].find(
        (filePath) =>
          path.basename(filePath) ===
          carrierContext.incompleteControl.expectedAsset.name,
      );
      if (
        carrierContext.incompleteControl.kind !== "rollover" ||
        !expectedFile ||
        sha256File(expectedFile) !==
          githubAssetSha256(carrierContext.incompleteControl.expectedAsset)
      ) {
        throw new Error(
          "Incomplete rollover control asset is not owned by this publication session.",
        );
      }
      await repairIncompleteChannelControl(carrierContext);
      carrierContext.incompleteControl = null;
    }
    const ownedAssets = new Map();
    try {
      for (const filePath of [rolloverSignaturePath, rolloverPath]) {
        const name = path.basename(filePath);
        try {
          const asset = await uploadRolloverControlAsset(
            carrierContext,
            filePath,
            ownedAssets,
          );
          ownedAssets.set(name, asset);
        } catch (error) {
          const current = assetMap(
            await carrierContext.listAssets(carrierContext.carrier.id),
          ).get(name);
          if (githubAssetSha256(current) === sha256File(filePath)) {
            ownedAssets.set(name, current);
          }
          throw error;
        }
      }
    } catch (error) {
      try {
        await deleteOwnedRolloverAssets(carrierContext, ownedAssets, {
          requireLatest: true,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Stable rollover lease acquisition failed and cleanup remains incomplete.",
        );
      }
      throw error;
    }
    carrierContext.dispose();
    carrierContext = await verifyLatestStableCarrier({ allowRollover: true });
    assertRolloverMatchesSuccessor(
      carrierContext,
      release,
      descriptor,
      frozen,
      publicationOwner,
    );
    return carrierContext;
  } catch (error) {
    carrierContext.dispose();
    throw error;
  }
}

async function carryBetaChannelToStableDraft(
  release,
  descriptor,
  frozen,
  publicationOwner,
  environment = process.env,
) {
  const carrierContext = await acquireStableRolloverLease(
    release,
    descriptor,
    frozen,
    publicationOwner,
    environment,
  );
  const descriptorSha256 = sha256File(descriptorPath);
  carrierContext.successorChannelAssets = new Map();
  const expectedSourceNames = expectedBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  const receipt = createStableRolloverReceipt({
    carrier: carrierContext.carrier,
    carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
    carrierProductIndexSha256: carrierContext.productIndexSha256,
    leaseAssets: carrierContext.rolloverAssets,
    owner: publicationOwner,
    rollover: carrierContext.rollover,
    successor: release,
    successorDescriptor: descriptor,
    successorDescriptorSha256: descriptorSha256,
    successorProductIndexSha256: frozen.digestByName.get(
      RELEASE_ASSET_INDEX_NAME,
    ),
  });
  const [receiptPath, receiptSignaturePath] = writeSignedChannelMetadata(
    carrierContext.directory,
    STABLE_ROLLOVER_RECEIPT_NAME,
    receipt,
    environment,
    descriptor.source.committedAt,
  );
  const receiptAssets = new Map();
  carrierContext.receiptAssets = receiptAssets;
  try {
    for (const filePath of [receiptSignaturePath, receiptPath]) {
      const name = path.basename(filePath);
      try {
        receiptAssets.set(
          name,
          await uploadStableDraftReceiptAsset(
            release,
            descriptor,
            filePath,
            carrierContext,
          ),
        );
      } catch (error) {
        const current = assetMap(await listAuthenticatedAssets(release.id)).get(
          name,
        );
        if (githubAssetSha256(current) === sha256File(filePath)) {
          receiptAssets.set(name, current);
        }
        throw error;
      }
    }
    persistStableRolloverReceiptOwnership(
      descriptor,
      descriptorSha256,
      publicationOwner,
      receiptAssets,
    );
    carrierContext.receipt = receipt;
    carrierContext.receiptAssets = receiptAssets;
    if (!carrierContext.channelState) return carrierContext;
    for (const name of expectedSourceNames) {
      await uploadOwnedStableDraftChannelAsset(
        release,
        descriptor,
        path.join(carrierContext.directory, name),
        carrierContext,
      );
    }
    return carrierContext;
  } catch (error) {
    try {
      await abortStableRolloverDraft(release, descriptor, carrierContext, {
        descriptorSha256,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Stable beta-channel carry failed and lease cleanup remains incomplete.",
      );
    } finally {
      carrierContext.dispose();
    }
    throw error;
  }
}

async function finalizeStableRolloverChannel(
  release,
  descriptor,
  frozen,
  carrierContext,
  environment = process.env,
) {
  if (!carrierContext?.channelState) return null;
  const source = carrierContext.channelState.source;
  const sourceDescriptor = {
    expectedTargets: source.expectedTargets,
    repository: source.repository,
    release: {
      id: source.id,
      prerelease: true,
      tag: source.tag,
      version: source.version,
    },
    source: { commit: source.sourceCommit },
  };
  const state = createBetaChannelState({
    assetRecords: carrierContext.channelState.assets,
    carrier: release,
    carrierDescriptorSha256: sha256File(descriptorPath),
    productIndexSha256: frozen.digestByName.get(RELEASE_ASSET_INDEX_NAME),
    sourceDescriptor,
    sourceDescriptorSha256: source.descriptorSha256,
  });
  const [statePath, stateSignaturePath] = writeSignedChannelMetadata(
    carrierContext.directory,
    BETA_CHANNEL_STATE_NAME,
    state,
    environment,
    descriptor.source.committedAt,
  );
  await uploadOwnedStableDraftChannelAsset(
    release,
    descriptor,
    stateSignaturePath,
    carrierContext,
  );
  await uploadOwnedStableDraftChannelAsset(
    release,
    descriptor,
    statePath,
    carrierContext,
  );
  return state;
}

async function loadStableRolloverReceipt(
  release,
  descriptor,
  publicationOwner,
  { assets = null, requireDraft },
) {
  const currentRelease = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  validateMutableRelease(
    currentRelease,
    releaseOptions(descriptor, requireDraft),
  );
  if (!requireDraft && currentRelease.draft !== false) {
    throw new Error("Stable rollover receipt successor is not published.");
  }
  const listed = assets ?? (await listAuthenticatedAssets(release.id));
  const byName = assetMap(listed);
  const receiptAsset = byName.get(STABLE_ROLLOVER_RECEIPT_NAME);
  const signatureAsset = byName.get(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME);
  if (Boolean(receiptAsset) !== Boolean(signatureAsset)) {
    throw new Error("Stable rollover receipt signature pair is incomplete.");
  }
  if (!receiptAsset) return null;
  const productIndexSha256 = githubAssetSha256(
    byName.get(RELEASE_ASSET_INDEX_NAME),
  );
  if (!productIndexSha256) {
    throw new Error(
      "Stable rollover receipt successor index digest is missing.",
    );
  }
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-rollover-receipt-"),
  );
  try {
    downloadDraftAssets([receiptAsset, signatureAsset], directory);
    const receiptPath = path.join(directory, STABLE_ROLLOVER_RECEIPT_NAME);
    verifyDescriptorSignature(
      receiptPath,
      path.join(directory, STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME),
      descriptor.release.signingKeyFingerprint,
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (fs.readFileSync(receiptPath, "utf8") !== canonicalJson(receipt)) {
      throw new Error("Stable rollover receipt is not canonical JSON.");
    }
    const leaseAssets = validateStableRolloverReceipt(receipt, {
      expectedOwner: publicationOwner,
      successor: currentRelease,
      successorDescriptor: descriptor,
      successorDescriptorSha256: sha256File(descriptorPath),
      successorProductIndexSha256: productIndexSha256,
    });
    return {
      assets: new Map([
        [STABLE_ROLLOVER_RECEIPT_NAME, receiptAsset],
        [STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME, signatureAsset],
      ]),
      leaseAssets,
      receipt,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyStableDraftChannel(
  release,
  descriptor,
  frozen,
  carrierContext,
  publicationOwner,
) {
  const currentRelease = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  validateMutableRelease(currentRelease, releaseOptions(descriptor, true));
  const assets = await listAuthenticatedAssets(release.id);
  const receiptContext = await loadStableRolloverReceipt(
    release,
    descriptor,
    publicationOwner,
    { assets, requireDraft: true },
  );
  if (!receiptContext) {
    throw new Error("Stable draft rollover receipt is missing.");
  }
  validateStableRolloverReceipt(receiptContext.receipt, {
    carrier: carrierContext.carrier,
    carrierDescriptorSha256: carrierContext.carrierDescriptorSha256,
    carrierProductIndexSha256: carrierContext.productIndexSha256,
    expectedOwner: publicationOwner,
    rollover: carrierContext.rollover,
    successor: currentRelease,
    successorDescriptor: descriptor,
    successorDescriptorSha256: sha256File(descriptorPath),
    successorProductIndexSha256: frozen.digestByName.get(
      RELEASE_ASSET_INDEX_NAME,
    ),
  });
  carrierContext.receipt = receiptContext.receipt;
  carrierContext.receiptAssets = receiptContext.assets;
  const { channelAssetsByName } = splitStableReleaseAssets(
    descriptor,
    assetMap(assets),
  );
  const permanentNames = permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  const receiptNames = new Set([
    STABLE_ROLLOVER_RECEIPT_NAME,
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  ]);
  const unexpected = Array.from(channelAssetsByName.keys()).filter(
    (name) => !permanentNames.includes(name) && !receiptNames.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Stable draft contains unexpected operational channel assets: ${unexpected.sort().join(", ")}.`,
    );
  }
  const permanentAssets = new Map(
    permanentNames
      .filter((name) => channelAssetsByName.has(name))
      .map((name) => [name, channelAssetsByName.get(name)]),
  );
  carrierContext.successorChannelAssets = permanentAssets;
  if (!carrierContext.channelState) {
    if (permanentAssets.size !== 0) {
      throw new Error("Stable draft should carry an empty beta channel.");
    }
    return new Map();
  }
  if (
    permanentAssets.size !== permanentNames.length ||
    permanentNames.some((name) => !permanentAssets.has(name))
  ) {
    throw new Error("Stable draft beta channel set is incomplete.");
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-stable-rollover-check-"),
  );
  try {
    const channelAssets = Array.from(permanentAssets.values());
    downloadDraftAssets(channelAssets, directory);
    const digestByName = new Map();
    for (const [name, asset] of permanentAssets) {
      const sha256 = sha256File(path.join(directory, name));
      if (githubAssetSha256(asset) !== sha256) {
        throw new Error(
          `Stable draft beta channel digest mismatch for ${name}.`,
        );
      }
      digestByName.set(name, sha256);
    }
    const state = verifyBetaChannelOverlay({
      carrier: release,
      carrierDescriptor: descriptor,
      carrierDescriptorSha256: sha256File(descriptorPath),
      channelAssetsByName: permanentAssets,
      digestByName,
      directory,
      productIndexSha256: frozen.digestByName.get(RELEASE_ASSET_INDEX_NAME),
    });
    if (
      state?.source?.descriptorSha256 !==
      carrierContext.channelState.source.descriptorSha256
    ) {
      throw new Error(
        "Stable draft beta channel source changed during rollover.",
      );
    }
    return new Map(
      permanentNames.map((name) => [name, digestByName.get(name)]),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function recheckStableRolloverBeforePublish(
  release,
  descriptor,
  frozen,
  carrierContext,
  publicationOwner,
) {
  await recheckFrozenReleaseAssetSet({ descriptor, frozen, release });
  const freshCarrier = await verifyLatestStableCarrier({
    allowRollover: true,
  });
  try {
    if (
      freshCarrier.rollover?.rolloverId !== carrierContext.rollover?.rolloverId
    ) {
      throw new Error(
        "Stable rollover lease ownership changed before publish.",
      );
    }
    assertRemoteAssetSnapshot(
      carrierContext.rolloverAssets,
      freshCarrier.rolloverAssets,
      "Stable rollover lease",
    );
    assertStableRolloverOrder(descriptor, freshCarrier.carrierDescriptor);
    assertRolloverMatchesSuccessor(
      freshCarrier,
      release,
      descriptor,
      frozen,
      publicationOwner,
    );
    await verifyStableDraftChannel(
      release,
      descriptor,
      frozen,
      freshCarrier,
      publicationOwner,
    );
    assertRemoteAssetSnapshot(
      carrierContext.receiptAssets,
      freshCarrier.receiptAssets,
      "Stable rollover receipt",
    );
    await freshCarrier.assertCarrier();
    return freshCarrier;
  } catch (error) {
    freshCarrier.dispose();
    throw error;
  }
}

async function releaseStableRolloverLease(release, descriptor, carrierContext) {
  const latest = await Promise.resolve(
    githubApi("GET", `/repos/${owner}/${repositoryName}/releases/latest`),
  );
  validateMutableRelease(latest, releaseOptions(descriptor, false));
  await carrierContext.assertCarrierById();
  await deleteOwnedRolloverAssets(
    carrierContext,
    carrierContext.rolloverAssets,
    { requireLatest: false },
  );
  await deleteOwnedSuccessorReceiptAssets(
    release,
    descriptor,
    carrierContext.receiptAssets,
    { requireDraft: false },
  );
  clearStableRolloverReceiptOwnership(sha256File(descriptorPath));
  const confirmedLatest = await Promise.resolve(
    githubApi("GET", `/repos/${owner}/${repositoryName}/releases/latest`),
  );
  validateMutableRelease(confirmedLatest, releaseOptions(descriptor, false));
}

async function abortStableRolloverDraft(
  release,
  descriptor,
  carrierContext,
  {
    clearReceiptOwnership = clearStableRolloverReceiptOwnership,
    deleteChannelAssets = deleteOwnedStableDraftChannelAssets,
    deleteReceiptAssets = deleteOwnedSuccessorReceiptAssets,
    deleteRolloverAssets = deleteOwnedRolloverAssets,
    descriptorSha256 = sha256File(descriptorPath),
  } = {},
) {
  await deleteChannelAssets(
    release,
    descriptor,
    carrierContext,
    carrierContext.successorChannelAssets || new Map(),
  );
  await deleteReceiptAssets(
    release,
    descriptor,
    carrierContext.receiptAssets || new Map(),
    { carrierContext, requireDraft: true },
  );
  await deleteRolloverAssets(carrierContext, carrierContext.rolloverAssets, {
    requireLatest: true,
  });
  await clearReceiptOwnership(descriptorSha256);
  return "aborted";
}

async function settleStableRolloverLease(release, descriptor, carrierContext) {
  const current = await Promise.resolve(
    githubApi(
      "GET",
      `/repos/${owner}/${repositoryName}/releases/${release.id}`,
    ),
  );
  if (current.draft === true) {
    validateMutableRelease(current, releaseOptions(descriptor, true));
    return abortStableRolloverDraft(current, descriptor, carrierContext);
  }
  validateMutableRelease(current, releaseOptions(descriptor, false));
  await releaseStableRolloverLease(current, descriptor, carrierContext);
  return "published";
}

async function settlePublishedStableRolloverReceipt(
  release,
  descriptor,
  {
    clearReceiptOwnership = (descriptorSha256) =>
      clearStableRolloverReceiptOwnership(descriptorSha256),
    deletePredecessorLease = deleteOwnedRolloverAssets,
    deleteSuccessorReceipt = deleteOwnedSuccessorReceiptAssets,
    getLatestRelease = () =>
      Promise.resolve(
        githubApi("GET", `/repos/${owner}/${repositoryName}/releases/latest`),
      ),
    listReleaseAssets = listAuthenticatedAssets,
    loadReceipt = loadStableRolloverReceipt,
    loadReceiptOwnership = (currentDescriptor, descriptorSha256) =>
      loadStableRolloverReceiptOwnership(currentDescriptor, descriptorSha256),
    persistReceiptOwnership = (
      currentDescriptor,
      descriptorSha256,
      publicationOwner,
      receiptAssets,
    ) =>
      persistStableRolloverReceiptOwnership(
        currentDescriptor,
        descriptorSha256,
        publicationOwner,
        receiptAssets,
      ),
    successorDescriptorSha256 = null,
    verifyPredecessor = (options) => verifyLatestStableCarrier(options),
  } = {},
) {
  const descriptorSha256 =
    successorDescriptorSha256 || sha256File(descriptorPath);
  const latest = await getLatestRelease();
  validateMutableRelease(latest, releaseOptions(descriptor, false));
  if (latest.draft !== false) {
    throw new Error(
      "Published rollover cleanup requires the successor as Latest.",
    );
  }
  const successorAssets = await listReleaseAssets(release.id);
  const successorByName = assetMap(successorAssets);
  const receiptAsset = successorByName.get(STABLE_ROLLOVER_RECEIPT_NAME);
  const receiptSignatureAsset = successorByName.get(
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  );
  const receiptOwnership = await loadReceiptOwnership(
    descriptor,
    descriptorSha256,
  );
  if (!receiptAsset && receiptSignatureAsset) {
    const expectedSignature = receiptOwnership?.assets.get(
      STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
    );
    if (
      !expectedSignature ||
      receiptSignatureAsset.id !== expectedSignature.id ||
      githubAssetSha256(receiptSignatureAsset) !==
        githubAssetSha256(expectedSignature)
    ) {
      throw new Error(
        "Published rollover receipt signature singleton is not owned by this descriptor.",
      );
    }
    await deleteSuccessorReceipt(
      latest,
      descriptor,
      new Map([[STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME, expectedSignature]]),
      { requireDraft: false },
    );
    await clearReceiptOwnership(descriptorSha256);
    return "cleaned-receipt";
  }
  if (receiptAsset && !receiptSignatureAsset) {
    throw new Error(
      "Published stable rollover receipt is missing its signature; predecessor cleanup cannot be proven.",
    );
  }
  if (!receiptAsset) {
    if (receiptOwnership) await clearReceiptOwnership(descriptorSha256);
    return "none";
  }

  const receiptContext = await loadReceipt(latest, descriptor, null, {
    assets: successorAssets,
    requireDraft: false,
  });
  const predecessorContext = await verifyPredecessor({
    allowIncompleteControl: true,
    allowRollover: true,
    releaseId: receiptContext.receipt.predecessor.id,
    requireLatest: false,
  });
  try {
    if (
      predecessorContext.incompleteControl &&
      predecessorContext.incompleteControl.kind !== "rollover"
    ) {
      throw new Error(
        "Stable rollover predecessor has an unrelated incomplete control pair.",
      );
    }
    const leaseRecords = validateStableRolloverReceipt(receiptContext.receipt, {
      carrier: predecessorContext.carrier,
      carrierDescriptorSha256: predecessorContext.carrierDescriptorSha256,
      carrierProductIndexSha256: predecessorContext.productIndexSha256,
      expectedOwner: null,
      rollover: predecessorContext.rollover,
      successor: latest,
      successorDescriptor: descriptor,
      successorDescriptorSha256: descriptorSha256,
      successorProductIndexSha256: githubAssetSha256(
        successorByName.get(RELEASE_ASSET_INDEX_NAME),
      ),
    });
    const expectedLeaseAssets = new Map(
      Array.from(leaseRecords, ([name, record]) => [
        name,
        { id: record.id, name, digest: `sha256:${record.sha256}` },
      ]),
    );
    for (const [name, current] of predecessorContext.rolloverAssets) {
      const expected = expectedLeaseAssets.get(name);
      if (
        current.id !== expected?.id ||
        githubAssetSha256(current) !== githubAssetSha256(expected)
      ) {
        throw new Error(`Stable rollover predecessor lease changed: ${name}.`);
      }
    }
    if (predecessorContext.incompleteControl) {
      const current = predecessorContext.incompleteControl.expectedAsset;
      const expected = expectedLeaseAssets.get(current.name);
      if (
        current.id !== expected?.id ||
        githubAssetSha256(current) !== githubAssetSha256(expected)
      ) {
        throw new Error("Incomplete predecessor rollover lease changed.");
      }
    }
    await persistReceiptOwnership(
      descriptor,
      descriptorSha256,
      receiptContext.receipt.owner,
      receiptContext.assets,
    );
    await deletePredecessorLease(predecessorContext, expectedLeaseAssets, {
      requireLatest: false,
    });
    await deleteSuccessorReceipt(latest, descriptor, receiptContext.assets, {
      requireDraft: false,
    });
    await clearReceiptOwnership(descriptorSha256);
    return "cleaned";
  } finally {
    predecessorContext.dispose();
  }
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
      promoteBeta: true,
      supported: true,
    };
  }
  return { carryBeta: true, makeLatest: "true", supported: true };
}

function assertChannelTransitionSupported(descriptor) {
  return channelTransitionPolicy(descriptor);
}

async function runWithCleanup(action, cleanup, message) {
  let result;
  let primaryError;
  try {
    result = await action();
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError([primaryError, cleanupError], message);
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result;
}

async function disposePublicationContext(context) {
  if (typeof context?.dispose === "function") {
    await Promise.resolve(context.dispose());
  }
}

function defaultPublicationServices() {
  return {
    assertExistingTag: (descriptor) =>
      assertExistingGitHubTagCommit(
        (method, endpoint) => Promise.resolve(githubApi(method, endpoint)),
        {
          expectedCommit: descriptor.source.commit,
          owner,
          repository: repositoryName,
          tag: descriptor.release.tag,
        },
      ),
    assertPublishedTag: (descriptor) =>
      assertGitHubTagCommit(
        (method, endpoint) => Promise.resolve(githubApi(method, endpoint)),
        {
          expectedCommit: descriptor.source.commit,
          owner,
          repository: repositoryName,
          tag: descriptor.release.tag,
        },
      ),
    carryChannel: carryBetaChannelToStableDraft,
    createPrivateDirectory: () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-draft-release-")),
    downloadAssets: downloadDraftAssets,
    finalizeChannel: finalizeStableRolloverChannel,
    freezeAssets: freezeReleaseAssetSet,
    getRelease: (releaseId) =>
      Promise.resolve(
        githubApi(
          "GET",
          `/repos/${owner}/${repositoryName}/releases/${releaseId}`,
        ),
      ),
    listAssets: listAuthenticatedAssets,
    log: (message) => console.log(message),
    patchRelease: (releaseId, body) =>
      Promise.resolve(
        githubApi(
          "PATCH",
          `/repos/${owner}/${repositoryName}/releases/${releaseId}`,
          body,
        ),
      ),
    promoteChannel: promoteBetaChannel,
    recheckFrozen: recheckFrozenReleaseAssetSet,
    recheckRollover: recheckStableRolloverBeforePublish,
    releaseRollover: releaseStableRolloverLease,
    removeDirectory: (directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    settlePublishedReceipt: settlePublishedStableRolloverReceipt,
    settleRollover: settleStableRolloverLease,
    verifyDownloaded: verifyDownloadedAssetSet,
    verifyLatestCarrier: verifyLatestStableCarrier,
    waitForPublic: waitForPublicVerification,
  };
}

async function runPublication(descriptor, publicationOwner, services = {}) {
  validatePublicationOwner(publicationOwner);
  if (
    publicationOwner.releaseId !== descriptor.release.id ||
    publicationOwner.sourceCommit !== descriptor.source.commit
  ) {
    throw new Error("Publication owner does not match the release descriptor.");
  }
  const operations = { ...defaultPublicationServices(), ...services };
  const transitionPolicy = assertChannelTransitionSupported(descriptor);
  let release = await operations.getRelease(descriptor.release.id);
  validatePublicationRelease(release, descriptor);

  if (release.draft) {
    let carriedChannel = null;
    let draftError;
    if (descriptor.release.prerelease) {
      const stablePreflight = await operations.verifyLatestCarrier();
      await disposePublicationContext(stablePreflight);
    }
    try {
      const assets = await operations.listAssets(release.id);
      const privateDirectory = operations.createPrivateDirectory();
      let frozen;
      await runWithCleanup(
        async () => {
          await Promise.resolve(
            operations.downloadAssets(assets, privateDirectory),
          );
          const verification = await Promise.resolve(
            operations.verifyDownloaded({
              descriptor,
              directory: privateDirectory,
              assets,
            }),
          );
          frozen = await operations.freezeAssets({
            descriptor,
            directory: privateDirectory,
            release,
            verification,
          });
          if (!descriptor.release.prerelease && transitionPolicy.carryBeta) {
            carriedChannel = await operations.carryChannel(
              release,
              descriptor,
              frozen,
              publicationOwner,
            );
            if (carriedChannel.channelState) {
              await operations.finalizeChannel(
                release,
                descriptor,
                frozen,
                carriedChannel,
              );
            }
          }
        },
        () => operations.removeDirectory(privateDirectory),
        "Draft verification failed and private-directory cleanup also failed.",
      );
      await operations.recheckFrozen({ descriptor, frozen, release });
      await operations.assertExistingTag(descriptor);
      if (carriedChannel) {
        const previousCarrier = carriedChannel;
        const freshCarrier = await operations.recheckRollover(
          release,
          descriptor,
          frozen,
          previousCarrier,
          publicationOwner,
        );
        try {
          await disposePublicationContext(previousCarrier);
        } catch (error) {
          await runWithCleanup(
            async () => {
              throw error;
            },
            () => disposePublicationContext(freshCarrier),
            "Both stable rollover carrier contexts failed to dispose.",
          );
        }
        carriedChannel = freshCarrier;
      }
      const publishedRelease = await operations.patchRelease(release.id, {
        draft: false,
        make_latest: transitionPolicy.makeLatest,
        prerelease: descriptor.release.prerelease,
      });
      validateMutableRelease(
        publishedRelease,
        releaseOptions(descriptor, false),
      );
      if (publishedRelease.draft) {
        throw new Error("GitHub did not publish the release.");
      }
      release = publishedRelease;
      if (carriedChannel) {
        await operations.releaseRollover(release, descriptor, carriedChannel);
        const completedCarrier = carriedChannel;
        carriedChannel = null;
        await disposePublicationContext(completedCarrier);
      }
      operations.log(
        `[release-publication] Published ${descriptor.release.tag}; starting anonymous verification.`,
      );
    } catch (error) {
      draftError = error;
    }
    if (carriedChannel) {
      const unsettledCarrier = carriedChannel;
      carriedChannel = null;
      try {
        await runWithCleanup(
          () =>
            operations.settleRollover(release, descriptor, unsettledCarrier),
          () => disposePublicationContext(unsettledCarrier),
          "Stable rollover settlement and carrier cleanup both failed.",
        );
      } catch (settlementError) {
        if (draftError) {
          throw new AggregateError(
            [draftError, settlementError],
            "Stable publication failed and rollover settlement remains incomplete.",
          );
        }
        throw settlementError;
      }
    }
    if (draftError) throw draftError;
  } else {
    if (!descriptor.release.prerelease) {
      await operations.settlePublishedReceipt(release, descriptor);
    }
    operations.log(
      `[release-publication] ${descriptor.release.tag} is already published; re-running public verification without mutation.`,
    );
  }

  await operations.assertPublishedTag(descriptor);
  const verified = await operations.waitForPublic(descriptor);
  await runWithCleanup(
    async () => {
      operations.log(
        `[release-publication] Anonymous public assets and signatures verified for ${descriptor.release.tag}.`,
      );
      if (transitionPolicy.promoteBeta) {
        await operations.promoteChannel(descriptor, verified, {
          publicationOwner,
        });
        operations.log(
          `[release-publication] Promoted verified beta manifests for ${descriptor.release.tag} through the stable GitHub Latest carrier.`,
        );
      }
    },
    () => operations.removeDirectory(verified.directory),
    "Public verification completed but publication cleanup also failed.",
  );
  return { release, transitionPolicy };
}

async function main() {
  assertGitHubCliAuthenticated();
  verifyDescriptorSignature(descriptorPath, descriptorSignaturePath);
  const descriptor = readReleaseDescriptor(descriptorPath);
  assertDescriptorRepository(descriptor, { name: repositoryName, owner });
  verifyDescriptorSignature(
    descriptorPath,
    descriptorSignaturePath,
    descriptor.release.signingKeyFingerprint,
  );
  const publicationSession = acquirePublicationSession(
    descriptor,
    sha256File(descriptorPath),
  );
  try {
    await runPublication(descriptor, publicationSession.owner);
  } finally {
    publicationSession.release();
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
  abortStableRolloverDraft,
  acquirePublicationSession,
  assertBetaPromotionOrder,
  assertChannelTransitionSupported,
  assertCompleteEvidence,
  assertReleaseAssetIndexEntries,
  assertStableRolloverOrder,
  assetMap,
  betaManifestName,
  carryBetaChannelToStableDraft,
  channelTransitionPolicy,
  clearStableRolloverReceiptOwnership,
  createReleaseAssetIndex,
  deleteOwnedStableDraftChannelAssets,
  evidenceKind,
  finalizeStableRolloverChannel,
  freezeReleaseAssetSet,
  loadStableRolloverReceiptOwnership,
  persistStableRolloverReceiptOwnership,
  processStartToken,
  promoteBetaChannel,
  recheckFrozenReleaseAssetSet,
  runPublication,
  settlePublishedStableRolloverReceipt,
  stableManifestName,
  uploadStableDraftChannelAsset,
  validatePublicationRelease,
  verifyChecksumFiles,
  verifyDownloadedAssetSet,
  verifyLatestChannelRecords,
  verifyLatestStableCarrier,
  verifyReleaseAssetIndex,
  verifyUpdaterManifests,
  waitForPublicVerification,
};
