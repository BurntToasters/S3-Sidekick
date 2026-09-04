#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import integrity from "./release-integrity.cjs";

const {
  canonicalJson,
  finalPackageTargetKeysForArtifactName,
  installSmokeReportName,
  requiredFinalPackageNamesForTarget,
  sha256File,
  validateInstallSmokeReport,
  withoutGpgSecrets,
} = integrity;
const root = fileURLToPath(new URL("..", import.meta.url));
const DISALLOWED_LICENSE = /\b(?:AGPL|GPL|SSPL|BUSL)-|Commons Clause/i;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packageCoordinates(key) {
  const normalized = key.startsWith("cargo:") ? key.slice(6) : key;
  const separator = normalized.lastIndexOf("@");
  return separator > 0
    ? {
        name: normalized.slice(0, separator),
        version: normalized.slice(separator + 1),
      }
    : { name: normalized, version: "NOASSERTION" };
}

function validateLicenseInventories({ npmLicenses, cargoLicenses }) {
  const errors = [];
  for (const [key, entry] of [
    ...Object.entries(npmLicenses || {}),
    ...Object.entries(cargoLicenses || {}),
  ]) {
    const license = String(entry?.licenses || "").trim();
    const allowedPrivateRoot =
      entry?.private === true && license === "UNLICENSED";
    if (!license || /^(?:UNKNOWN|UNLICENSED|SEE LICENSE)/i.test(license)) {
      if (!allowedPrivateRoot)
        errors.push(
          `${key}: missing or unknown license (${license || "empty"})`,
        );
    } else if (DISALLOWED_LICENSE.test(license)) {
      errors.push(
        `${key}: disallowed strong-copyleft/restricted license (${license})`,
      );
    }
    if (typeof entry?.source === "string" && /^git\+/i.test(entry.source)) {
      errors.push(`${key}: unapproved git dependency source (${entry.source})`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Release license/source policy failed:\n${errors.join("\n")}`,
    );
  }
  return true;
}

function artifactRecords(files) {
  return files
    .filter(
      (filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
    )
    .map((filePath) => ({
      name: path.basename(filePath),
      sha256: sha256File(filePath),
      size: fs.statSync(filePath).size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function spdxId(value) {
  return `SPDXRef-${String(value).replace(/[^A-Za-z0-9.-]+/g, "-")}`;
}

function buildSpdxSbom({
  descriptor,
  descriptorSha256,
  artifacts,
  npmLicenses,
  cargoLicenses,
}) {
  const packages = [
    ...Object.entries(npmLicenses).map(([key, entry]) => ({
      key,
      entry,
      manager: "npm",
    })),
    ...Object.entries(cargoLicenses).map(([key, entry]) => ({
      key,
      entry,
      manager: "cargo",
    })),
  ]
    .map(({ key, entry, manager }) => {
      const coordinates = packageCoordinates(key);
      return {
        SPDXID: spdxId(`${manager}-${coordinates.name}-${coordinates.version}`),
        downloadLocation: entry.repository || "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: entry.licenses,
        licenseDeclared: entry.licenses,
        name: coordinates.name,
        versionInfo: coordinates.version,
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceLocator: `pkg:${manager}/${encodeURIComponent(coordinates.name)}@${coordinates.version}`,
            referenceType: "purl",
          },
        ],
      };
    })
    .sort((left, right) => left.SPDXID.localeCompare(right.SPDXID));
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: descriptor.source.committedAt,
      creators: ["Tool: S3-Sidekick-release-evidence"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace: `https://github.com/BurntToasters/S3-Sidekick/releases/${descriptor.release.tag}/sbom/${descriptorSha256}`,
    files: artifacts.map((artifact) => ({
      SPDXID: spdxId(`artifact-${artifact.name}`),
      checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
      fileName: artifact.name,
    })),
    name: `S3 Sidekick ${descriptor.release.version} release SBOM`,
    packages,
    relationships: packages.map((pkg) => ({
      relatedSpdxElement: pkg.SPDXID,
      relationshipType: "DESCRIBES",
      spdxElementId: "SPDXRef-DOCUMENT",
    })),
    spdxVersion: "SPDX-2.3",
  };
}

function runCheck(
  command,
  args,
  { environment = process.env, execute = spawnSync } = {},
) {
  const result = execute(command, args, {
    cwd: root,
    encoding: "utf8",
    env: withoutGpgSecrets(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr || result.stdout || "").trim()}`,
    );
  }
}

function isFinalPackageArtifact(name, platform) {
  const platformName = platform === "win32" ? "windows" : platform;
  return finalPackageTargetKeysForArtifactName(name).some((target) =>
    target.startsWith(`${platformName}-`),
  );
}

function packageRecordMap(records, label) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${label} must contain final package records.`);
  }
  const byName = new Map();
  for (const record of records) {
    if (
      typeof record?.name !== "string" ||
      path.basename(record.name) !== record.name ||
      /[\\/]/.test(record.name) ||
      !/^[a-f0-9]{64}$/.test(record.sha256 || "") ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      byName.has(record.name)
    ) {
      throw new Error(`${label} contains a malformed or duplicate record.`);
    }
    byName.set(record.name, record);
  }
  return byName;
}

function buildPackagesByTarget(packageRecords, targets) {
  const packages = packageRecordMap(packageRecords, "Package closure");
  const sortedTargets = [...targets].sort();
  if (
    sortedTargets.length === 0 ||
    new Set(sortedTargets).size !== sortedTargets.length ||
    sortedTargets.some(
      (target) => !/^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/.test(target),
    )
  ) {
    throw new Error("Package closure targets are missing or malformed.");
  }

  const targetSet = new Set(sortedTargets);
  const byTarget = Object.fromEntries(
    sortedTargets.map((target) => [target, []]),
  );
  for (const record of packages.values()) {
    const owners = finalPackageTargetKeysForArtifactName(record.name);
    if (
      owners.length === 0 ||
      owners.some((target) => !targetSet.has(target))
    ) {
      throw new Error(
        `Final package ${record.name} has no exact owner in the host target closure.`,
      );
    }
    for (const target of owners) byTarget[target].push(record);
  }

  for (const target of sortedTargets) {
    byTarget[target].sort((left, right) => left.name.localeCompare(right.name));
    const packageNames = new Set(byTarget[target].map((record) => record.name));
    const missingRequiredPackages = requiredFinalPackageNamesForTarget(
      target,
    ).filter((name) => !packageNames.has(name));
    if (missingRequiredPackages.length > 0) {
      throw new Error(
        `Package closure is incomplete for ${target} (missing: ${missingRequiredPackages.join(", ")}).`,
      );
    }
    if (byTarget[target].length === 0) {
      throw new Error(`Package closure has no final packages for ${target}.`);
    }
  }
  return byTarget;
}

function validatePackageSmokeClosure(packageSmoke, packagesByTarget) {
  const packages = packageRecordMap(
    packageSmoke?.packages,
    "Package-smoke package closure",
  );
  const targets = Object.keys(packagesByTarget || {}).sort();
  if (
    packageSmoke?.schemaVersion !== 1 ||
    packageSmoke?.status !== "passed" ||
    canonicalJson(packageSmoke?.targets) !== canonicalJson(targets)
  ) {
    throw new Error(
      "Package-smoke identity does not match the host package closure.",
    );
  }

  const union = new Map();
  for (const target of targets) {
    const targetPackages = packageRecordMap(
      packagesByTarget[target],
      `Package closure for ${target}`,
    );
    const sortedTargetPackages = Array.from(targetPackages.values()).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (
      canonicalJson(packagesByTarget[target]) !==
      canonicalJson(sortedTargetPackages)
    ) {
      throw new Error(`Package closure for ${target} is not canonical.`);
    }
    for (const record of targetPackages.values()) {
      if (
        !finalPackageTargetKeysForArtifactName(record.name).includes(target) ||
        canonicalJson(packages.get(record.name)) !== canonicalJson(record)
      ) {
        throw new Error(
          `Package closure record ${record.name} does not belong to ${target}.`,
        );
      }
      const existing = union.get(record.name);
      if (existing && canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error(
          `Package closure contains conflicting records for ${record.name}.`,
        );
      }
      union.set(record.name, record);
    }
  }

  const sortedUnion = Array.from(union.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const sortedPackages = Array.from(packages.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (canonicalJson(sortedUnion) !== canonicalJson(sortedPackages)) {
    throw new Error(
      "Package-smoke packages do not exactly equal the host package closure union.",
    );
  }
  return true;
}

function loadInstallSmokeReports(installSmokeFiles) {
  if (!Array.isArray(installSmokeFiles)) {
    throw new Error("Install-smoke report files are missing.");
  }
  return installSmokeFiles.map((filePath) => {
    const report = readJson(filePath);
    let expectedName;
    try {
      expectedName = installSmokeReportName(report?.target);
    } catch {
      throw new Error(
        `Install-smoke report ${path.basename(filePath)} has an invalid body target.`,
      );
    }
    if (path.basename(filePath) !== expectedName) {
      throw new Error(
        `Install-smoke report filename ${path.basename(filePath)} does not match body target ${report.target}.`,
      );
    }
    return report;
  });
}

function validateInstallSmokePackageClosure({
  descriptor,
  descriptorSha256,
  installSmokeReports,
  packageSmoke,
  packagesByTarget,
}) {
  validatePackageSmokeClosure(packageSmoke, packagesByTarget);
  if (!Array.isArray(installSmokeReports)) {
    throw new Error("Install-smoke package closure reports are missing.");
  }

  const expectedTargets = Object.keys(packagesByTarget).sort();
  const reportsByTarget = new Map();
  for (const report of installSmokeReports) {
    if (
      typeof report?.target !== "string" ||
      !expectedTargets.includes(report.target) ||
      reportsByTarget.has(report.target)
    ) {
      throw new Error(
        "Install-smoke package closure contains an unexpected or duplicate target report.",
      );
    }
    reportsByTarget.set(report.target, report);
  }
  const missingTargets = expectedTargets.filter(
    (target) => !reportsByTarget.has(target),
  );
  if (
    missingTargets.length > 0 ||
    reportsByTarget.size !== expectedTargets.length
  ) {
    throw new Error(
      `Install-smoke package closure is incomplete (missing: ${missingTargets.join(", ") || "none"}).`,
    );
  }

  const packageDigests = new Map(
    packageSmoke.packages.map((record) => [record.name, record.sha256]),
  );
  const reportUnion = new Map();
  for (const target of expectedTargets) {
    const expectedArtifactNames = new Set(
      packagesByTarget[target].map((record) => record.name),
    );
    const report = reportsByTarget.get(target);
    validateInstallSmokeReport(report, {
      descriptor,
      descriptorSha256,
      digestByName: packageDigests,
      expectedArtifactNames,
      target,
    });
    for (const record of report.artifacts) {
      const existing = reportUnion.get(record.name);
      if (existing && existing.sha256 !== record.sha256) {
        throw new Error(
          `Install-smoke package closure has conflicting digests for ${record.name}.`,
        );
      }
      reportUnion.set(record.name, record);
    }
  }

  const expectedUnion = packageSmoke.packages
    .map(({ name, sha256 }) => ({ name, sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actualUnion = Array.from(reportUnion.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (canonicalJson(actualUnion) !== canonicalJson(expectedUnion)) {
    throw new Error(
      "Install-smoke report union does not exactly equal package-smoke packages.",
    );
  }
  return true;
}

function exactMacosArtifactMap(records, label) {
  if (!Array.isArray(records)) {
    throw new Error(`macOS trust report ${label} must be an array.`);
  }
  const byName = new Map();
  for (const record of records) {
    const name = record?.name;
    const sha256 = record?.sha256;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.trim() !== name ||
      name === "." ||
      name === ".." ||
      path.basename(name) !== name ||
      /[\\/]/.test(name) ||
      !/^[a-f0-9]{64}$/.test(sha256 || "")
    ) {
      throw new Error(
        `macOS trust report ${label} contains a malformed artifact record.`,
      );
    }
    if (byName.has(name)) {
      throw new Error(
        `macOS trust report ${label} contains duplicate artifact ${name}.`,
      );
    }
    byName.set(name, sha256);
  }
  return byName;
}

function assertExactMacosTrustArtifacts(trust, packageRecords) {
  if (trust?.schemaVersion !== 1) {
    throw new Error("macOS trust report has an unsupported schema.");
  }
  const expected = exactMacosArtifactMap(packageRecords, "package set");
  const actual = exactMacosArtifactMap(trust.artifacts, "artifacts");
  const missing = Array.from(expected.keys()).filter(
    (name) => !actual.has(name),
  );
  const extra = Array.from(actual.keys()).filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `macOS trust report does not exactly cover final packages (missing: ${missing.sort().join(", ") || "none"}; extra: ${extra.sort().join(", ") || "none"}).`,
    );
  }
  for (const [name, digest] of expected) {
    if (actual.get(name) !== digest) {
      throw new Error(
        `macOS trust report digest does not match final package ${name}.`,
      );
    }
  }
  if (!Array.isArray(trust.architectures) || trust.architectures.length === 0) {
    throw new Error("macOS trust report has no universal Mach-O inventory.");
  }
  const architecturePaths = new Set();
  for (const record of trust.architectures) {
    if (
      typeof record?.path !== "string" ||
      !record.path ||
      path.isAbsolute(record.path) ||
      record.path.split(/[\\/]+/).includes("..") ||
      architecturePaths.has(record.path) ||
      !Array.isArray(record.architectures) ||
      canonicalJson(record.architectures) !== canonicalJson(["arm64", "x86_64"])
    ) {
      throw new Error("macOS trust report universal Mach-O inventory is invalid.");
    }
    architecturePaths.add(record.path);
  }
  return true;
}

function verifyPackageSmoke({
  releaseDir,
  artifactFiles,
  environment = process.env,
  executeCheck = runCheck,
  platform = process.platform,
}) {
  if (environment.SKIP_WIN_CODESIGN) {
    throw new Error(
      "SKIP_WIN_CODESIGN is forbidden during release package verification.",
    );
  }
  const checks = [];
  const packages = artifactFiles.filter((filePath) =>
    isFinalPackageArtifact(path.basename(filePath), platform),
  );
  if (packages.length === 0)
    throw new Error("Package smoke gate found no final package artifacts.");
  const packageRecords = artifactRecords(packages);
  if (packageRecords.length !== packages.length) {
    throw new Error("Package smoke gate found a missing final package file.");
  }

  if (platform === "darwin") {
    const trustPath = path.join(releaseDir, "macos-trust.json");
    const trust = readJson(trustPath);
    const requiredChecks = [
      "universal-mach-o",
      "codesign-deep-strict",
      "notary-accepted",
      "stapler-validate",
      "gatekeeper",
      "quarantine-gatekeeper",
    ];
    for (const check of requiredChecks) {
      if (!trust.checks?.includes(check))
        throw new Error(`macOS trust report is missing ${check}.`);
    }
    assertExactMacosTrustArtifacts(trust, packageRecords);
    checks.push(...requiredChecks);
  } else if (platform === "win32") {
    const windowsInstallers = packages.filter((filePath) =>
      /\.(?:exe|msi)$/i.test(filePath),
    );
    if (windowsInstallers.length === 0) {
      throw new Error(
        "Windows package smoke gate found no exact installer artifacts.",
      );
    }
    executeCheck(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "verify-windows-authenticode.ps1"),
        "-InstallerPathsJson",
        JSON.stringify(windowsInstallers),
        "-SignatureOnly",
      ],
      { environment },
    );
    checks.push(
      "authenticode-valid",
      "timestamp-valid",
      "publisher-match",
      "installer-outer-signature",
      "installer-runtime-extracted-signature",
    );
  } else if (platform === "linux") {
    for (const filePath of packages) {
      if (/\.deb$/i.test(filePath)) {
        executeCheck("dpkg-deb", ["--info", filePath], { environment });
        checks.push(`deb-metadata:${path.basename(filePath)}`);
      } else if (/\.rpm$/i.test(filePath)) {
        executeCheck("rpm", ["-qip", filePath], { environment });
        checks.push(`rpm-metadata:${path.basename(filePath)}`);
      } else if (/\.appimage$/i.test(filePath)) {
        const header = fs.readFileSync(filePath).subarray(0, 4);
        if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          throw new Error(`AppImage is not an ELF executable: ${filePath}`);
        }
        checks.push(`appimage-elf:${path.basename(filePath)}`);
      } else if (/\.flatpak$/i.test(filePath)) {
        if (fs.statSync(filePath).size < 4096)
          throw new Error(`Flatpak bundle is implausibly small: ${filePath}`);
        checks.push(`flatpak-bundle:${path.basename(filePath)}`);
      }
    }
  } else {
    throw new Error(`Unsupported release package-smoke platform: ${platform}`);
  }

  return {
    checks: Array.from(new Set(checks)).sort(),
    packages: packageRecords,
    status: "passed",
  };
}

function hostKey(platform = process.platform, arch = process.arch) {
  const osName = platform === "win32" ? "windows" : platform;
  const archName =
    arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${osName}-${archName}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, canonicalJson(value), { mode: 0o600 });
  return filePath;
}

function platformInputs(releaseDir, platform, descriptor, arch) {
  if (platform !== "linux") return null;
  const normalizedArch =
    arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  const expected =
    descriptor.toolchains?.flatpak?.inputsByArchitecture?.[normalizedArch];
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error(
      `Descriptor has no exact Flatpak inputs for ${normalizedArch}.`,
    );
  }
  const expectedName = `flatpak-inputs-${normalizedArch}.json`;
  const matches = fs
    .readdirSync(releaseDir)
    .filter((name) => /^flatpak-inputs-(?:x64|arm64)\.json$/.test(name));
  if (matches.length !== 1 || matches[0] !== expectedName) {
    throw new Error(
      `Expected only ${expectedName}; found ${matches.join(", ") || "none"}.`,
    );
  }
  const record = readJson(path.join(releaseDir, expectedName));
  if (
    record.schemaVersion !== 2 ||
    record.arch !== normalizedArch ||
    record.descriptorSha256 !==
      sha256File(path.join(releaseDir, "release-descriptor.json")) ||
    canonicalJson(record.inputs) !== canonicalJson(expected)
  ) {
    throw new Error(
      "Resolved Flatpak input record does not exactly match the signed descriptor.",
    );
  }
  return record;
}

function generateReleaseEvidence({
  descriptor,
  descriptorPath,
  releaseDir,
  artifactFiles,
  installSmokeFiles = [],
  targets,
  platform = process.platform,
  arch = process.arch,
}) {
  const descriptorSha256 = sha256File(descriptorPath);
  const npmLicenses = readJson(path.join(root, "public", "licenses.json"));
  const cargoLicenses = readJson(
    path.join(root, "public", "licenses-cargo.json"),
  );
  validateLicenseInventories({ npmLicenses, cargoLicenses });
  const artifacts = artifactRecords(artifactFiles);
  const key = hostKey(platform, arch);
  const resolvedPlatformInputs = platformInputs(
    releaseDir,
    platform,
    descriptor,
    arch,
  );
  const sbomPath = path.join(releaseDir, `release-sbom-${key}.spdx.json`);
  const smokePath = path.join(releaseDir, `release-package-smoke-${key}.json`);
  const provenancePath = path.join(
    releaseDir,
    `release-provenance-${key}.json`,
  );
  const attestationPath = path.join(
    releaseDir,
    `release-attestation-${key}.json`,
  );

  writeJson(
    sbomPath,
    buildSpdxSbom({
      descriptor,
      descriptorSha256,
      artifacts,
      npmLicenses,
      cargoLicenses,
    }),
  );
  const packageSmoke = {
    schemaVersion: 1,
    descriptorSha256,
    targets: [...targets].sort(),
    ...verifyPackageSmoke({ releaseDir, artifactFiles, platform }),
  };
  const packagesByTarget = buildPackagesByTarget(
    packageSmoke.packages,
    packageSmoke.targets,
  );
  validatePackageSmokeClosure(packageSmoke, packagesByTarget);
  if (
    descriptor.requiredEvidence?.includes("install-smoke") ||
    installSmokeFiles.length > 0
  ) {
    validateInstallSmokePackageClosure({
      descriptor,
      descriptorSha256,
      installSmokeReports: loadInstallSmokeReports(installSmokeFiles),
      packageSmoke,
      packagesByTarget,
    });
  }
  writeJson(smokePath, packageSmoke);
  writeJson(provenancePath, {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: artifacts.map((artifact) => ({
      name: artifact.name,
      digest: { sha256: artifact.sha256 },
    })),
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/BurntToasters/S3-Sidekick/release-build/v1",
        externalParameters: {
          descriptorSha256,
          platformInputs: resolvedPlatformInputs,
          releaseId: descriptor.release.id,
          targets: [...targets].sort(),
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/BurntToasters/S3-Sidekick@${descriptor.source.commit}`,
            digest: { sha256: descriptor.source.archiveSha256 },
          },
          {
            uri: "package-lock.json",
            digest: { sha256: descriptor.source.packageLockSha256 },
          },
          {
            uri: "src-tauri/Cargo.lock",
            digest: { sha256: descriptor.source.cargoLockSha256 },
          },
        ],
      },
      runDetails: {
        builder: { id: `local-release-host:${key}` },
        metadata: {
          invocationId: crypto
            .createHash("sha256")
            .update(
              canonicalJson({
                artifacts,
                descriptorSha256,
                host: key,
                targets: [...targets].sort(),
              }),
            )
            .digest("hex"),
        },
      },
    },
  });

  const evidence = artifactRecords([sbomPath, smokePath, provenancePath]);
  writeJson(attestationPath, {
    // packagesByTarget is an additive schema-v1 field so the existing signed
    // attestation consumer remains compatible until publication integration.
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    targets: [...targets].sort(),
    packagesByTarget,
    host: { arch, node: process.version, platform },
    platformInputs: resolvedPlatformInputs,
    artifacts,
    evidence,
  });
  return [sbomPath, smokePath, provenancePath, attestationPath];
}

function checkLicenses() {
  const npmLicenses = readJson(path.join(root, "public", "licenses.json"));
  const cargoLicenses = readJson(
    path.join(root, "public", "licenses-cargo.json"),
  );
  validateLicenseInventories({ npmLicenses, cargoLicenses });
  console.log("[release-evidence] License and source policy passed.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.includes("--check-licenses")) checkLicenses();
    else
      throw new Error(
        "Use --check-licenses; evidence generation is called by gpg-sign.js.",
      );
  } catch (error) {
    console.error(
      `release-evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  artifactRecords,
  assertExactMacosTrustArtifacts,
  buildPackagesByTarget,
  buildSpdxSbom,
  generateReleaseEvidence,
  hostKey,
  loadInstallSmokeReports,
  packageCoordinates,
  platformInputs,
  runCheck,
  validateInstallSmokePackageClosure,
  validateLicenseInventories,
  validatePackageSmokeClosure,
  verifyPackageSmoke,
};
