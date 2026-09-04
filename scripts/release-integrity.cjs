"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DESCRIPTOR_NAME = "release-descriptor.json";
const DESCRIPTOR_SIGNATURE_NAME = `${DESCRIPTOR_NAME}.asc`;
const RELEASE_ASSET_INDEX_NAME = "release-assets.json";
const RELEASE_ASSET_INDEX_SIGNATURE_NAME = `${RELEASE_ASSET_INDEX_NAME}.asc`;
const DEFAULT_GITHUB_REPOSITORY = Object.freeze({
  name: "S3-Sidekick",
  owner: "BurntToasters",
});
const DEFAULT_EXPECTED_TARGETS = Object.freeze([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
]);
const REQUIRED_EVIDENCE_KINDS = Object.freeze([
  "attestation",
  "install-smoke",
  "package-smoke",
  "provenance",
  "sbom",
]);
const REQUIRED_INSTALL_SMOKE_CHECKS = Object.freeze([
  "clean-install",
  "launch",
  "previous-version-update",
]);

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortedObject(nested)]),
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(sortedObject(value), null, 2)}\n`;
}

function canonicalMacosArtifactName(name) {
  const baseName = String(name || "");
  if (/\.app\.tar\.gz$/i.test(baseName)) {
    return "S3-Sidekick-macOS.app.tar.gz";
  }
  if (/\.dmg$/i.test(baseName)) return "S3-Sidekick-macOS.dmg";
  if (/^S3(?:[ ._-])Sidekick\.zip$/i.test(baseName)) {
    return "S3-Sidekick-macOS.zip";
  }
  return null;
}

// Final package ownership is deliberately stricter than updater eligibility.
// Only canonical staged package names are classified; updater payloads,
// signatures, evidence, and malformed package-looking names fail closed.
function finalPackageTargetKeysForArtifactName(name) {
  const baseName = String(name || "");
  if (
    !baseName ||
    baseName.trim() !== baseName ||
    path.basename(baseName) !== baseName ||
    /[\\/]/.test(baseName)
  ) {
    return [];
  }

  if (
    /^(?:S3-Sidekick-macOS\.app\.tar\.gz|S3-Sidekick-macOS\.(?:dmg|zip))$/.test(
      baseName,
    )
  ) {
    return ["darwin-aarch64", "darwin-x86_64"];
  }

  const linux = baseName.match(
    /^S3-Sidekick-Linux-(x64|arm64)\.(?:AppImage|deb|rpm|flatpak)$/,
  );
  if (linux) {
    return [`linux-${linux[1] === "arm64" ? "aarch64" : "x86_64"}`];
  }

  const windows = baseName.match(
    /^S3-Sidekick-Windows-(x64|arm64)\.(?:exe|msi)$/,
  );
  if (windows) {
    return [`windows-${windows[1] === "arm64" ? "aarch64" : "x86_64"}`];
  }

  return [];
}

function requiredFinalPackageNamesForTarget(target) {
  if (/^darwin-(?:aarch64|x86_64)$/.test(target)) {
    return [
      "S3-Sidekick-macOS.app.tar.gz",
      "S3-Sidekick-macOS.dmg",
      "S3-Sidekick-macOS.zip",
    ];
  }
  const linux = String(target || "").match(/^linux-(aarch64|x86_64)$/);
  if (linux) {
    const architecture = linux[1] === "aarch64" ? "arm64" : "x64";
    return ["AppImage", "deb", "flatpak", "rpm"].map(
      (extension) => `S3-Sidekick-Linux-${architecture}.${extension}`,
    );
  }
  const windows = String(target || "").match(/^windows-(aarch64|x86_64)$/);
  if (windows) {
    const architecture = windows[1] === "aarch64" ? "arm64" : "x64";
    return ["exe", "msi"].map(
      (extension) => `S3-Sidekick-Windows-${architecture}.${extension}`,
    );
  }
  return [];
}

function normalizeGitHubRepository(repository) {
  const owner = repository?.owner;
  const name = repository?.name;
  if (
    typeof owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    typeof name !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(name)
  ) {
    throw new Error("Release repository identity is missing or malformed.");
  }
  return { name, owner };
}

function repositoryFromEnvironment(environment = process.env) {
  return normalizeGitHubRepository({
    name: environment.GH_REPO_NAME || DEFAULT_GITHUB_REPOSITORY.name,
    owner: environment.GH_REPO_OWNER || DEFAULT_GITHUB_REPOSITORY.owner,
  });
}

function assertDescriptorRepository(descriptor, expectedRepository) {
  const actual = normalizeGitHubRepository(descriptor?.repository);
  const expected = normalizeGitHubRepository(expectedRepository);
  if (actual.owner !== expected.owner || actual.name !== expected.name) {
    throw new Error(
      `Signed descriptor repository ${actual.owner}/${actual.name} does not match active repository ${expected.owner}/${expected.name}.`,
    );
  }
  return actual;
}

function descriptorReleaseAssetUrl(descriptor, artifactName) {
  const repository = normalizeGitHubRepository(descriptor?.repository);
  const tag = descriptor?.release?.tag;
  if (
    typeof tag !== "string" ||
    tag.length === 0 ||
    tag.trim() !== tag ||
    /[\u0000-\u001f\u007f]/.test(tag)
  ) {
    throw new Error("Release descriptor tag is missing or malformed.");
  }
  if (
    typeof artifactName !== "string" ||
    artifactName.length === 0 ||
    artifactName.trim() !== artifactName ||
    artifactName === "." ||
    artifactName === ".." ||
    path.basename(artifactName) !== artifactName ||
    /[\\/\u0000-\u001f\u007f]/.test(artifactName)
  ) {
    throw new Error("Release artifact name is missing or malformed.");
  }
  return `https://github.com/${repository.owner}/${repository.name}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifactName)}`;
}

function artifactNameFromDescriptorReleaseUrl(descriptor, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Updater release URL is missing or malformed.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Updater release URL is missing or malformed.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Updater release URL is not a canonical GitHub URL.");
  }
  const encodedName = parsed.pathname.split("/").at(-1);
  let artifactName;
  try {
    artifactName = decodeURIComponent(encodedName || "");
  } catch {
    throw new Error("Updater release URL has malformed path encoding.");
  }
  const expected = descriptorReleaseAssetUrl(descriptor, artifactName);
  if (value !== expected) {
    throw new Error(
      "Updater release URL does not match the signed descriptor repository, tag, and artifact name.",
    );
  }
  return artifactName;
}

function withoutGpgSecrets(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !["GPG_KEY_ID", "GPG_PASSPHRASE"].includes(name.toUpperCase()),
    ),
  );
}

function command(
  root,
  commandName,
  args,
  { binary = false, environment = process.env } = {},
) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: binary ? undefined : "utf8",
    env: withoutGpgSecrets(environment),
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = binary
      ? String(result.stderr || "")
      : result.stderr || result.stdout || "";
    throw new Error(
      `${commandName} ${args.join(" ")} failed: ${String(stderr).trim()}`,
    );
  }
  return binary ? result.stdout : String(result.stdout || "").trim();
}

function assertReleaseToolVersions(
  packageJson,
  {
    environment = process.env,
    root = process.cwd(),
    nodeVersion = process.versions.node,
  } = {},
) {
  const expectedNode = String(packageJson.releaseToolchain?.node || "");
  const expectedNpm = String(packageJson.releaseToolchain?.npm || "");
  const minNodeMatch = expectedNode.match(/^(?:>=\s*|\^)?(\d+\.\d+\.\d+)$/);
  if (
    !minNodeMatch ||
    !/^\d+\.\d+\.\d+$/.test(expectedNpm)
  ) {
    throw new Error(
      "releaseToolchain must pin node (exact or >=) and npm versions in package.json.",
    );
  }
  if (packageJson.packageManager !== `npm@${expectedNpm}`) {
    throw new Error(
      "packageManager and releaseToolchain.npm must pin the same exact npm version.",
    );
  }
  const minNode = minNodeMatch[1];
  const normalizedNode = String(nodeVersion || "").replace(/^v/, "");
  const nodeMeetsRequirement =
    compareSemanticVersions(normalizedNode, minNode) >= 0;
  const userAgentNpm = String(environment.npm_config_user_agent || "").match(
    /(?:^|\s)npm\/(\d+\.\d+\.\d+)(?:\s|$)/,
  )?.[1];
  let actualNpm = userAgentNpm;
  if (!actualNpm && path.isAbsolute(String(environment.npm_execpath || ""))) {
    actualNpm = command(
      root,
      process.execPath,
      [environment.npm_execpath, "--version"],
      { environment },
    );
  }
  if (!actualNpm)
    actualNpm = command(root, "npm", ["--version"], { environment });
  if (!nodeMeetsRequirement || actualNpm !== expectedNpm) {
    throw new Error(
      `Release tools do not match package.json pins (node ${nodeVersion}/${expectedNode}, npm ${actualNpm}/${expectedNpm}).`,
    );
  }
  return { node: expectedNode, npm: expectedNpm };
}

function installSmokeReportName(target) {
  const normalizedTarget = String(target || "").toLowerCase();
  if (!/^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/.test(normalizedTarget)) {
    throw new Error(`Invalid install-smoke target: ${target || "missing"}.`);
  }
  return `release-install-smoke-${normalizedTarget}.json`;
}

function isInstallSmokeReportName(name) {
  return /^release-install-smoke-(?:darwin|linux|windows)-(?:aarch64|x86_64)\.json$/.test(
    String(name || ""),
  );
}

function compareNumericSemVerIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseStrictSemVer(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match) return null;
  const core = match.slice(1, 4);
  if (core.some((part) => part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  if (
    prerelease.some(
      (part) =>
        /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
  ) {
    return null;
  }
  return { core, prerelease };
}

function compareStrictSemVer(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericSemVerIdentifiers(
      left.core[index],
      right.core[index],
    );
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const sharedLength = Math.min(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftIsNumeric = /^[0-9]+$/.test(leftPart);
    const rightIsNumeric = /^[0-9]+$/.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericSemVerIdentifiers(leftPart, rightPart);
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

function compareSemanticVersions(left, right) {
  const parsedLeft = parseStrictSemVer(left);
  const parsedRight = parseStrictSemVer(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error(
      `Cannot compare non-strict semantic versions ${JSON.stringify(left)} and ${JSON.stringify(right)}.`,
    );
  }
  return compareStrictSemVer(parsedLeft, parsedRight);
}

function exactInstallSmokePreviousVersion(
  releaseVersion,
  value,
  label = "RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION",
) {
  const current = parseStrictSemVer(releaseVersion);
  const previousValue = String(value || "").trim();
  const previous = parseStrictSemVer(previousValue);
  if (
    !current ||
    !previous ||
    compareStrictSemVer(previous, current) >= 0
  ) {
    throw new Error(
      `${label} must be one exact strict semantic version lower than ${releaseVersion}.`,
    );
  }
  return previousValue;
}

function validateInstallSmokeReport(
  report,
  {
    allowedArtifactNames,
    descriptor,
    descriptorSha256,
    digestByName,
    expectedArtifactNames = allowedArtifactNames,
    target,
  },
) {
  const expectedName = installSmokeReportName(target);
  if (
    report?.schemaVersion !== 1 ||
    report?.descriptorSha256 !== descriptorSha256 ||
    report?.releaseId !== descriptor.release.id ||
    report?.sourceCommit !== descriptor.source.commit ||
    report?.target !== target ||
    report?.status !== "passed"
  ) {
    throw new Error(
      `Install/update smoke report identity failed for ${target} (${expectedName}).`,
    );
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const uniqueChecks = new Set(checks);
  const missingChecks = REQUIRED_INSTALL_SMOKE_CHECKS.filter(
    (check) => !uniqueChecks.has(check),
  );
  const unexpectedChecks = checks.filter(
    (check) => !REQUIRED_INSTALL_SMOKE_CHECKS.includes(check),
  );
  if (
    missingChecks.length > 0 ||
    unexpectedChecks.length > 0 ||
    uniqueChecks.size !== checks.length
  ) {
    throw new Error(
      `Install/update smoke report checks are invalid for ${target} (missing: ${missingChecks.join(", ") || "none"}; unexpected: ${unexpectedChecks.join(", ") || "none"}).`,
    );
  }
  if (
    typeof report.runner?.image !== "string" ||
    !report.runner.image ||
    typeof report.runner?.runId !== "string" ||
    !report.runner.runId ||
    !Array.isArray(report.artifacts) ||
    report.artifacts.length === 0
  ) {
    throw new Error(
      `Install/update smoke report metadata is incomplete for ${target}.`,
    );
  }
  const expectedPreviousVersion = exactInstallSmokePreviousVersion(
    descriptor.release.version,
    descriptor.installSmokePreviousVersion,
    "Signed descriptor installSmokePreviousVersion",
  );
  if (report.previousVersion !== expectedPreviousVersion) {
    throw new Error(
      `Install/update smoke report previousVersion must exactly match signed descriptor predecessor ${expectedPreviousVersion} for ${target}.`,
    );
  }
  if (
    !(expectedArtifactNames instanceof Set) ||
    expectedArtifactNames.size === 0
  ) {
    throw new Error(
      `Target attestation has no installable artifacts for ${target}.`,
    );
  }
  const artifactNames = new Set();
  for (const artifact of report.artifacts) {
    if (
      typeof artifact?.name !== "string" ||
      artifactNames.has(artifact.name) ||
      !expectedArtifactNames.has(artifact.name) ||
      !/^[a-f0-9]{64}$/.test(artifact?.sha256 || "") ||
      digestByName.get(artifact.name) !== artifact.sha256
    ) {
      throw new Error(
        `Install/update smoke report artifact mismatch for ${target}.`,
      );
    }
    artifactNames.add(artifact.name);
  }
  const missingArtifactNames = Array.from(expectedArtifactNames)
    .filter((name) => !artifactNames.has(name))
    .sort();
  if (
    artifactNames.size !== expectedArtifactNames.size ||
    missingArtifactNames.length > 0
  ) {
    throw new Error(
      `Install/update smoke report does not exactly cover the expected package closure for ${target} (missing: ${missingArtifactNames.join(", ") || "none"}).`,
    );
  }
  return true;
}

function resolveGpgFingerprint(
  environment = process.env,
  { execute = spawnSync } = {},
) {
  const configured = String(environment.RELEASE_GPG_FINGERPRINT || "")
    .replace(/\s/g, "")
    .toUpperCase();
  if (/^[A-F0-9]{40,64}$/.test(configured)) return configured;
  const keyId = String(environment.GPG_KEY_ID || "").trim();
  if (!keyId) {
    throw new Error(
      "GPG_KEY_ID or RELEASE_GPG_FINGERPRINT is required to pin release signatures.",
    );
  }
  const result = execute(
    "gpg",
    ["--batch", "--with-colons", "--fingerprint", keyId],
    {
      encoding: "utf8",
      env: withoutGpgSecrets(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not resolve release GPG fingerprint: ${String(result.stderr || "").trim()}`,
    );
  }
  const fingerprints = String(result.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]?.toUpperCase())
    .filter((value) => /^[A-F0-9]{40,64}$/.test(value || ""));
  if (fingerprints.length === 0) {
    throw new Error(`No full GPG fingerprint found for ${keyId}.`);
  }
  return fingerprints[0];
}

function assertValidSignatureStatus(statusOutput, expectedFingerprint) {
  const expected = String(expectedFingerprint || "").toUpperCase();
  const validSignatures = String(statusOutput || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      return {
        primaryFingerprint: fields.at(-1)?.toUpperCase(),
        signingFingerprint: fields[2]?.toUpperCase(),
      };
    });
  if (
    validSignatures.length !== 1 ||
    ![
      validSignatures[0].signingFingerprint,
      validSignatures[0].primaryFingerprint,
    ].includes(expected)
  ) {
    const actual = validSignatures
      .flatMap((value) => [value.signingFingerprint, value.primaryFingerprint])
      .filter(
        (value, index, values) => value && values.indexOf(value) === index,
      )
      .join(", ");
    throw new Error(
      `GPG signature fingerprint mismatch; expected ${expected}, got ${actual || "none"}.`,
    );
  }
  return true;
}

function parseExactRustVersion(toolchainText) {
  const match = String(toolchainText).match(
    /^\s*channel\s*=\s*["']([^"']+)["']/m,
  );
  const value = match ? match[1].trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(
      `rust-toolchain.toml must pin an exact Rust version; found ${JSON.stringify(value || "missing")}.`,
    );
  }
  return value;
}

function parseFlatpakInputs(manifestText) {
  const value = String(manifestText);
  const runtime = value
    .match(/^runtime:\s*([^\n#]+)/m)?.[1]
    ?.trim()
    .replace(/^[\'"]|[\'"]$/g, "");
  const runtimeVersion = value
    .match(/^runtime-version:\s*([^\n#]+)/m)?.[1]
    ?.trim()
    .replace(/^[\'"]|[\'"]$/g, "");
  const sdk = value
    .match(/^sdk:\s*([^\n#]+)/m)?.[1]
    ?.trim()
    .replace(/^[\'"]|[\'"]$/g, "");
  const extensions = Array.from(
    value.matchAll(/^\s+-\s+(org\.freedesktop\.Sdk\.Extension\.[^\s#]+)/gm),
    (match) => match[1],
  ).sort();
  const refs = Array.from(
    value.matchAll(/^\s*#\s*release-ref:\s*([^\s#]+\/\/[^\s#]+)\s*$/gm),
    (match) => match[1],
  ).sort();
  const expectedPrefixes = [runtime, sdk, ...extensions]
    .filter(Boolean)
    .map((name) => `${name}//`)
    .sort();
  if (
    !runtime ||
    !runtimeVersion ||
    !sdk ||
    extensions.length === 0 ||
    refs.length !== expectedPrefixes.length ||
    new Set(refs).size !== refs.length ||
    expectedPrefixes.some(
      (prefix) => refs.filter((ref) => ref.startsWith(prefix)).length !== 1,
    ) ||
    !refs.includes(`${runtime}//${runtimeVersion}`) ||
    !refs.includes(`${sdk}//${runtimeVersion}`)
  ) {
    throw new Error(
      "Flatpak manifest must pin one release-ref branch for its runtime, SDK, and every SDK extension.",
    );
  }
  return { extensions, refs, runtime, runtimeVersion, sdk };
}

function normalizeFlatpakInputsByArchitecture(value, expectedRefs) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(
        `RELEASE_FLATPAK_INPUTS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "RELEASE_FLATPAK_INPUTS must provide x64 and arm64 commit arrays.",
    );
  }
  const sortedExpectedRefs = [...expectedRefs].sort();
  const normalized = {};
  for (const arch of ["x64", "arm64"]) {
    const inputs = parsed[arch];
    if (!Array.isArray(inputs)) {
      throw new Error(
        `Flatpak ${arch} inputs are missing from the descriptor.`,
      );
    }
    const records = inputs
      .map((input) => ({
        commit: String(input?.commit || "").toLowerCase(),
        ref: String(input?.ref || ""),
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const refs = records.map((input) => input.ref);
    if (
      records.some((input) => !/^[a-f0-9]{64}$/.test(input.commit)) ||
      new Set(refs).size !== refs.length ||
      refs.length !== sortedExpectedRefs.length ||
      refs.some((ref, index) => ref !== sortedExpectedRefs[index])
    ) {
      throw new Error(
        `Flatpak ${arch} inputs must exactly pin every manifest release-ref to a 64-character commit.`,
      );
    }
    normalized[arch] = records;
  }
  const unexpectedArchitectures = Object.keys(parsed).filter(
    (arch) => !["x64", "arm64"].includes(arch),
  );
  if (unexpectedArchitectures.length > 0) {
    throw new Error(
      `Unexpected Flatpak input architectures: ${unexpectedArchitectures.join(", ")}.`,
    );
  }
  return normalized;
}

function normalizeLegacyLatestBootstrap(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(
        `RELEASE_LEGACY_LATEST_BOOTSTRAP is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Number.isSafeInteger(parsed.releaseId) ||
    parsed.releaseId <= 0 ||
    typeof parsed.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(parsed.tag) ||
    typeof parsed.sourceCommit !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(parsed.sourceCommit) ||
    Object.keys(parsed).length !== 4 ||
    Object.keys(parsed).some(
      (key) =>
        !["schemaVersion", "releaseId", "tag", "sourceCommit"].includes(key),
    )
  ) {
    throw new Error(
      "RELEASE_LEGACY_LATEST_BOOTSTRAP must be exact JSON with schemaVersion 1, a positive releaseId, a v-prefixed stable tag, and a full sourceCommit.",
    );
  }
  return {
    schemaVersion: 1,
    releaseId: parsed.releaseId,
    tag: parsed.tag,
    sourceCommit: parsed.sourceCommit.toLowerCase(),
  };
}

function expectedTargets(environment = process.env) {
  const configured = String(environment.RELEASE_EXPECTED_TARGETS || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const targets = configured.length > 0 ? configured : DEFAULT_EXPECTED_TARGETS;
  const unique = Array.from(new Set(targets)).sort();
  if (
    unique.some(
      (target) => !/^(darwin|linux|windows)-(?:aarch64|x86_64)$/.test(target),
    )
  ) {
    throw new Error(
      `Invalid RELEASE_EXPECTED_TARGETS value: ${unique.join(", ")}`,
    );
  }
  return unique;
}

function validateMutableRelease(
  release,
  {
    expectedId,
    expectedTag,
    expectedPrerelease,
    expectedTargetCommitish,
    requireDraft = true,
  } = {},
) {
  if (
    !release ||
    typeof release !== "object" ||
    !Number.isSafeInteger(release.id)
  ) {
    throw new Error("GitHub release metadata has no valid numeric id.");
  }
  if (expectedId !== undefined && release.id !== expectedId) {
    throw new Error(
      `GitHub release id ${release.id} does not match descriptor release id ${expectedId}.`,
    );
  }
  if (release.tag_name !== expectedTag) {
    throw new Error(
      `GitHub release tag ${JSON.stringify(release.tag_name)} does not match ${expectedTag}.`,
    );
  }
  if (
    expectedTargetCommitish !== undefined &&
    String(release.target_commitish || "").toLowerCase() !==
      String(expectedTargetCommitish).toLowerCase()
  ) {
    throw new Error(
      `GitHub release target_commitish ${JSON.stringify(release.target_commitish)} does not match source commit ${expectedTargetCommitish}.`,
    );
  }
  if (Boolean(release.prerelease) !== Boolean(expectedPrerelease)) {
    throw new Error(
      `GitHub release prerelease state does not match ${expectedTag}.`,
    );
  }
  if (requireDraft && release.draft !== true) {
    throw new Error(
      `Release ${expectedTag} is already published; published releases are immutable. Choose a new version.`,
    );
  }
  return release;
}

function selectUniqueTaggedRelease(releases, options) {
  if (!Array.isArray(releases))
    throw new Error("Unexpected releases payload type.");
  const matches = releases.filter(
    (release) => release?.tag_name === options.expectedTag,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `Found ${matches.length} releases for ${options.expectedTag}; refusing an ambiguous mutation.`,
    );
  }
  return validateMutableRelease(matches[0], options);
}

function sourceCommit(root, environment = process.env) {
  const commit = command(root, "git", ["rev-parse", "HEAD"], {
    environment,
  });
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new Error(`Git HEAD did not resolve to a full commit id: ${commit}.`);
  }
  return commit.toLowerCase();
}

function assertCleanSource(
  root,
  { environment = process.env, expectedCommit } = {},
) {
  const before = sourceCommit(root, environment);
  const expected =
    expectedCommit === undefined ? null : String(expectedCommit).toLowerCase();
  if (expected !== null && !/^[a-f0-9]{40,64}$/.test(expected)) {
    throw new Error(
      `Expected source commit is not a full commit id: ${expectedCommit}.`,
    );
  }
  if (expected !== null && before !== expected) {
    throw new Error(
      `Source checkout is at ${before}, not expected commit ${expected}.`,
    );
  }

  const status = command(
    root,
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { binary: true, environment },
  );
  if (!Buffer.isBuffer(status)) {
    throw new Error("Git status did not return a binary porcelain result.");
  }
  if (status.length !== 0) {
    throw new Error(
      "Release source working tree is not clean; commit or remove all staged, unstaged, deleted, and non-ignored untracked files before continuing.",
    );
  }

  const after = sourceCommit(root, environment);
  if (after !== before) {
    throw new Error(
      `Source commit changed while checking the working tree (${before} -> ${after}).`,
    );
  }
  if (expected !== null && after !== expected) {
    throw new Error(
      `Source checkout is at ${after}, not expected commit ${expected}.`,
    );
  }
  return after;
}

function githubTagReferenceEndpoint({ owner, repository, tag }) {
  return `/repos/${owner}/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
}

async function resolveGitHubTagCommitFromReference(
  request,
  { owner, repository, tag, maxDepth = 16 },
  reference,
) {
  let object = reference?.object;
  const visited = new Set();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const type = object?.type;
    const sha = String(object?.sha || "").toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) {
      throw new Error(`GitHub tag ${tag} returned a malformed object id.`);
    }
    if (type === "commit") return sha;
    if (type !== "tag") {
      throw new Error(
        `GitHub tag ${tag} resolves to unsupported type ${type}.`,
      );
    }
    if (visited.has(sha)) {
      throw new Error(`GitHub tag ${tag} contains an annotated-tag cycle.`);
    }
    visited.add(sha);
    if (depth === maxDepth) {
      throw new Error(
        `GitHub tag ${tag} exceeded the annotated-tag depth limit.`,
      );
    }
    const annotated = await request(
      "GET",
      `/repos/${owner}/${repository}/git/tags/${sha}`,
    );
    object = annotated?.object;
  }
  throw new Error(`GitHub tag ${tag} could not be resolved to a commit.`);
}

async function resolveGitHubTagCommit(request, options) {
  if (typeof request !== "function")
    throw new Error("GitHub tag resolution requires a request function.");
  const reference = await request("GET", githubTagReferenceEndpoint(options));
  return resolveGitHubTagCommitFromReference(request, options, reference);
}

function assertResolvedGitHubTagCommit(actual, options) {
  const expected = String(options.expectedCommit || "").toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `GitHub tag ${options.tag} resolves to ${actual}, not descriptor source commit ${expected}.`,
    );
  }
  return actual;
}

async function assertGitHubTagCommit(request, options) {
  const actual = await resolveGitHubTagCommit(request, options);
  return assertResolvedGitHubTagCommit(actual, options);
}

async function assertExistingGitHubTagCommit(request, options) {
  if (typeof request !== "function")
    throw new Error("GitHub tag resolution requires a request function.");
  let reference;
  try {
    reference = await request("GET", githubTagReferenceEndpoint(options));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
  const actual = await resolveGitHubTagCommitFromReference(
    request,
    options,
    reference,
  );
  return assertResolvedGitHubTagCommit(actual, options);
}

function sourceArchiveSha256(
  root,
  environment = process.env,
  commit = sourceCommit(root, environment),
) {
  const exactCommit = String(commit).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(exactCommit)) {
    throw new Error(
      `Source archive commit is not a full commit id: ${commit}.`,
    );
  }
  return sha256Buffer(
    command(root, "git", ["archive", "--format=tar", exactCommit], {
      binary: true,
      environment,
    }),
  );
}

function createReleaseDescriptor({
  root,
  release,
  packageJson,
  environment = process.env,
  flatpakInputsByArchitecture,
  legacyLatestBootstrap,
  repository,
}) {
  const commit = assertCleanSource(root, { environment });
  const repositoryIdentity = normalizeGitHubRepository(
    repository ?? repositoryFromEnvironment(environment),
  );
  const resolvedPackageJson =
    packageJson ??
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = String(resolvedPackageJson.version || "");
  const tag = `v${version}`;
  const prerelease = /-(?:alpha|beta|rc)\./i.test(version);
  const resolvedLegacyLatestBootstrap = normalizeLegacyLatestBootstrap(
    legacyLatestBootstrap ?? environment.RELEASE_LEGACY_LATEST_BOOTSTRAP,
  );
  if (resolvedLegacyLatestBootstrap && !prerelease) {
    throw new Error(
      "Legacy GitHub Latest bootstrap authorization is allowed only on a prerelease descriptor.",
    );
  }
  validateMutableRelease(release, {
    expectedId: release.id,
    expectedPrerelease: prerelease,
    expectedTag: tag,
  });

  const releaseTools = assertReleaseToolVersions(resolvedPackageJson, {
    environment,
    root,
  });
  const rustVersion = parseExactRustVersion(
    fs.readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"),
  );
  const flatpakManifest = parseFlatpakInputs(
    fs.readFileSync(path.join(root, "run.rosie.s3-sidekick.yml"), "utf8"),
  );
  const inputsByArchitecture = normalizeFlatpakInputsByArchitecture(
    flatpakInputsByArchitecture ?? environment.RELEASE_FLATPAK_INPUTS,
    flatpakManifest.refs,
  );
  const flatpak = { ...flatpakManifest, inputsByArchitecture };
  const descriptor = {
    schemaVersion: 2,
    repository: repositoryIdentity,
    release: {
      channel: prerelease ? "prerelease" : "stable",
      id: release.id,
      prerelease,
      signingKeyFingerprint: resolveGpgFingerprint(environment),
      tag,
      version,
    },
    installSmokePreviousVersion: exactInstallSmokePreviousVersion(
      version,
      environment.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION,
    ),
    source: {
      archiveSha256: sourceArchiveSha256(root, environment, commit),
      cargoLockSha256: sha256File(path.join(root, "src-tauri", "Cargo.lock")),
      commit,
      committedAt: command(
        root,
        "git",
        ["show", "-s", "--format=%cI", commit],
        { environment },
      ),
      packageLockSha256: sha256File(path.join(root, "package-lock.json")),
    },
    toolchains: {
      flatpak,
      node: releaseTools.node,
      npm: releaseTools.npm,
      rust: rustVersion,
    },
    expectedTargets: expectedTargets(environment),
    requiredEvidence: [...REQUIRED_EVIDENCE_KINDS],
    ...(resolvedLegacyLatestBootstrap
      ? { legacyLatestBootstrap: resolvedLegacyLatestBootstrap }
      : {}),
  };
  assertCleanSource(root, { environment, expectedCommit: commit });
  return descriptor;
}

function writeReleaseDescriptor(filePath, descriptor) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(descriptor), { mode: 0o600 });
  return sha256File(filePath);
}

function readReleaseDescriptor(filePath) {
  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Release descriptor is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (descriptor?.schemaVersion !== 2)
    throw new Error("Unsupported release descriptor schema.");
  normalizeGitHubRepository(descriptor.repository);
  if (
    !Array.isArray(descriptor.expectedTargets) ||
    descriptor.expectedTargets.length === 0
  ) {
    throw new Error("Release descriptor has no expected targets.");
  }
  const legacyLatestBootstrap = normalizeLegacyLatestBootstrap(
    descriptor.legacyLatestBootstrap,
  );
  if (legacyLatestBootstrap && descriptor.release?.prerelease !== true) {
    throw new Error(
      "Legacy GitHub Latest bootstrap authorization is allowed only on a prerelease descriptor.",
    );
  }
  exactInstallSmokePreviousVersion(
    descriptor.release?.version,
    descriptor.installSmokePreviousVersion,
    "Release descriptor installSmokePreviousVersion",
  );
  return descriptor;
}

function validateDescriptorForCheckout(
  descriptor,
  { root, release, repository },
) {
  if (repository !== undefined) {
    assertDescriptorRepository(descriptor, repository);
  }
  assertCleanSource(root, { expectedCommit: descriptor.source?.commit });
  validateMutableRelease(release, {
    expectedId: descriptor.release?.id,
    expectedPrerelease: descriptor.release?.prerelease,
    expectedTag: descriptor.release?.tag,
    expectedTargetCommitish: descriptor.source?.commit,
  });
  const expected = createReleaseDescriptor({
    root,
    release,
    flatpakInputsByArchitecture:
      descriptor.toolchains?.flatpak?.inputsByArchitecture,
    legacyLatestBootstrap: descriptor.legacyLatestBootstrap,
    repository: descriptor.repository,
  });
  if (canonicalJson(descriptor) !== canonicalJson(expected)) {
    throw new Error(
      "Release descriptor does not match this source checkout, lockfiles, toolchain, targets, or release record.",
    );
  }
  assertCleanSource(root, { expectedCommit: descriptor.source.commit });
  return descriptor;
}

function signDetachedFile(
  filePath,
  signaturePath,
  { environment = process.env, epoch = Number.NaN, execute = spawnSync } = {},
) {
  const keyId = environment.GPG_KEY_ID;
  const passphrase = environment.GPG_PASSPHRASE;
  if (typeof keyId !== "string" || !keyId.trim()) {
    throw new Error("GPG_KEY_ID is required for detached signing.");
  }
  if (typeof passphrase !== "string" || !passphrase.trim()) {
    throw new Error("GPG_PASSPHRASE is required for detached signing.");
  }
  if (/[\r\n]/.test(passphrase)) {
    throw new Error(
      "GPG_PASSPHRASE must not contain line breaks when supplied through a protected file descriptor.",
    );
  }

  const args = [
    "--batch",
    "--yes",
    "--armor",
    "--pinentry-mode",
    "loopback",
    "--passphrase-fd",
    "0",
    "--detach-sign",
    "--local-user",
    keyId,
  ];
  if (Number.isSafeInteger(epoch)) {
    args.push("--faked-system-time", `${epoch}!`);
  }
  args.push("--output", signaturePath, filePath);

  const result = execute("gpg", args, {
    encoding: "utf8",
    env: withoutGpgSecrets(environment),
    input: Buffer.from(`${passphrase}\n`, "utf8"),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG detached signing failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return signaturePath;
}

function signDescriptor(
  filePath,
  signaturePath,
  environment = process.env,
  { execute = spawnSync } = {},
) {
  let epoch = Number.parseInt(environment.SOURCE_DATE_EPOCH || "", 10);
  if (!Number.isSafeInteger(epoch)) {
    try {
      const signedObject = JSON.parse(fs.readFileSync(filePath, "utf8"));
      epoch = Math.floor(Date.parse(signedObject?.source?.committedAt) / 1000);
    } catch {
      epoch = Number.NaN;
    }
  }
  return signDetachedFile(filePath, signaturePath, {
    environment,
    epoch,
    execute,
  });
}

function verifyDescriptorSignature(
  filePath,
  signaturePath,
  expectedFingerprint,
  environment = process.env,
  { execute = spawnSync } = {},
) {
  const configuredFingerprint = resolveGpgFingerprint(environment, { execute });
  const requiredFingerprint = expectedFingerprint || configuredFingerprint;
  if (String(requiredFingerprint).toUpperCase() !== configuredFingerprint) {
    throw new Error(
      "Descriptor signing fingerprint does not match the configured release key.",
    );
  }
  const result = execute(
    "gpg",
    ["--batch", "--status-fd", "1", "--verify", signaturePath, filePath],
    {
      encoding: "utf8",
      env: withoutGpgSecrets(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Release signature verification failed: ${String(result.stderr || "").trim()}`,
    );
  }
  assertValidSignatureStatus(result.stdout, configuredFingerprint);
  return true;
}

async function listAllReleaseAssets(fetchPage, perPage = 100) {
  if (typeof fetchPage !== "function") {
    throw new Error("Release asset pagination requires a page fetcher.");
  }
  const assets = [];
  for (let page = 1; ; page += 1) {
    const values = await fetchPage(page, perPage);
    if (!Array.isArray(values)) {
      throw new Error(`Unexpected release assets payload on page ${page}.`);
    }
    assets.push(...values);
    if (values.length < perPage) return assets;
  }
}

function githubAssetSha256(asset) {
  const match =
    typeof asset?.digest === "string"
      ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i)
      : null;
  return match ? match[1].toLowerCase() : null;
}

function classifyImmutableAsset(existingAsset, filePath) {
  if (!existingAsset) return "upload";
  const remoteDigest = githubAssetSha256(existingAsset);
  if (!remoteDigest) {
    throw new Error(
      `Existing asset ${existingAsset.name || path.basename(filePath)} has no GitHub SHA-256 digest; refusing to replace or assume equality.`,
    );
  }
  const localDigest = sha256File(filePath);
  if (remoteDigest !== localDigest) {
    throw new Error(
      `Immutable asset collision for ${existingAsset.name || path.basename(filePath)}: remote ${remoteDigest}, local ${localDigest}. Publish a new version or use an explicit recovery procedure.`,
    );
  }
  return "skip";
}

module.exports = {
  DEFAULT_EXPECTED_TARGETS,
  DEFAULT_GITHUB_REPOSITORY,
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  RELEASE_ASSET_INDEX_NAME,
  RELEASE_ASSET_INDEX_SIGNATURE_NAME,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_INSTALL_SMOKE_CHECKS,
  artifactNameFromDescriptorReleaseUrl,
  assertCleanSource,
  assertDescriptorRepository,
  assertExistingGitHubTagCommit,
  assertGitHubTagCommit,
  assertReleaseToolVersions,
  assertValidSignatureStatus,
  canonicalJson,
  canonicalMacosArtifactName,
  classifyImmutableAsset,
  compareSemanticVersions,
  createReleaseDescriptor,
  descriptorReleaseAssetUrl,
  expectedTargets,
  finalPackageTargetKeysForArtifactName,
  githubAssetSha256,
  installSmokeReportName,
  isInstallSmokeReportName,
  listAllReleaseAssets,
  normalizeFlatpakInputsByArchitecture,
  normalizeGitHubRepository,
  normalizeLegacyLatestBootstrap,
  parseExactRustVersion,
  parseFlatpakInputs,
  readReleaseDescriptor,
  requiredFinalPackageNamesForTarget,
  resolveGpgFingerprint,
  resolveGitHubTagCommit,
  selectUniqueTaggedRelease,
  sha256Buffer,
  sha256File,
  signDescriptor,
  signDetachedFile,
  sourceArchiveSha256,
  sourceCommit,
  validateDescriptorForCheckout,
  validateInstallSmokeReport,
  validateMutableRelease,
  verifyDescriptorSignature,
  withoutGpgSecrets,
  writeReleaseDescriptor,
};
