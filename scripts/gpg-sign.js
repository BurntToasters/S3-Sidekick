#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { verifyReleaseSession } from "./release-session.js";
import { generateReleaseEvidence } from "./release-evidence.js";
import githubCli from "./github-cli.cjs";

const { assertGitHubCliAuthenticated, githubApi, uploadReleaseAssetById } =
  githubCli;
const {
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  RELEASE_ASSET_INDEX_NAME,
  canonicalMacosArtifactName,
  classifyImmutableAsset,
  installSmokeReportName,
  isInstallSmokeReportName,
  listAllReleaseAssets,
  readReleaseDescriptor,
  validateDescriptorForCheckout,
  validateMutableRelease,
  verifyDescriptorSignature,
} = createRequire(import.meta.url)("./release-integrity.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const descriptorPath = path.join(releaseDir, DESCRIPTOR_NAME);
const descriptorSignaturePath = path.join(
  releaseDir,
  DESCRIPTOR_SIGNATURE_NAME,
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
);
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf-8"),
);

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const IS_PRERELEASE = /-(?:beta|alpha)\./i.test(VERSION);

const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
let signatureEpoch = null;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const TAG_DOWNLOAD_BASE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(TAG)}`;
const RELEASE_DOWNLOAD_BASE_URL = (
  process.env.RELEASE_DOWNLOAD_BASE_URL || TAG_DOWNLOAD_BASE_URL
).replace(/\/+$/, "");
const RELEASE_NOTES = process.env.RELEASE_NOTES || "";
const RELEASE_PUB_DATE =
  process.env.RELEASE_PUB_DATE || new Date().toISOString();
const UPDATER_PUBLIC_KEY = tauriConfig.plugins?.updater?.pubkey;
const REQUIRED_LINUX_TARGETS = (
  process.env.REQUIRED_LINUX_TARGETS || ""
).trim();
const REQUIRE_LINUX_AARCH64 = /^(1|true|yes|on)$/i.test(
  String(process.env.REQUIRE_LINUX_AARCH64 || "").trim(),
);
const ENFORCE_LINUX_X64_PACKAGE_SET = !/^(0|false|no|off)$/i.test(
  String(process.env.ENFORCE_LINUX_X64_PACKAGE_SET || "true").trim(),
);

const ext = (e) => (n) => n.toLowerCase().endsWith(e);
const rx = (r) => (n) => r.test(n);
const isPerTargetManifest = rx(/^latest-[a-z0-9-]+-[a-z0-9_]+\.json$/i);
const isChecksumTextName = rx(/^SHA256SUMS(?:-[a-z0-9_-]+)?\.txt$/i);

const ARTIFACT_RULES = [
  rx(/-setup\.exe$/i),
  rx(/^S3-Sidekick-(?:Windows|Linux|macOS)-(?:x64|arm64)\.exe$/i),
  ext(".msi"),
  ext(".dmg"),
  ext(".deb"),
  ext(".rpm"),
  ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
  rx(/\.(?:exe|msi|dmg|deb|rpm|flatpak|appimage|zip)\.sig$/i),
  rx(/\.tar\.gz\.sig$/i),
  rx(/^release-(?:attestation|package-smoke|provenance|sbom)-.+\.json$/i),
  isPerTargetManifest,
];

const SIGN_RULES = [
  ext(".exe"),
  ext(".msi"),
  ext(".dmg"),
  ext(".deb"),
  ext(".rpm"),
  ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
  rx(/^release-(?:attestation|package-smoke|provenance|sbom)-.+\.json$/i),
  isInstallSmokeReportName,
  isPerTargetManifest,
];

const isArtifact = (name) => ARTIFACT_RULES.some((r) => r(name));
const isSignable = (name) => SIGN_RULES.some((r) => r(name));

const SEARCH_DIRS = [
  path.join(root, "src-tauri", "target"),
  path.join(root, "dist"),
];

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

function artifactMatchesVersion(name) {
  if (isPerTargetManifest(name)) return true;
  const versions = name.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g,
  );
  if (!versions || versions.length === 0) return true;
  return versions.some((v) => v === VERSION || v.startsWith(VERSION + "-"));
}

function clearReleaseStaging() {
  if (!fs.existsSync(releaseDir)) return;
  for (const name of fs.readdirSync(releaseDir)) {
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile || name === DESCRIPTOR_SIGNATURE_NAME) continue;
    if (isArtifact(name) || name.endsWith(".asc") || isChecksumTextName(name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function clearPreStagedUpdaterManifests() {
  if (!fs.existsSync(releaseDir)) return;
  const removed = [];
  for (const name of fs.readdirSync(releaseDir)) {
    if (!isPerTargetManifest(name)) continue;
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    fs.rmSync(fullPath, { force: true });
    removed.push(name);
  }
  if (removed.length > 0) {
    console.log(
      `  ~ Removed ${removed.length} stale updater manifest(s) from release/`,
    );
  }
}

function pickNewestByBasename(paths) {
  const latest = new Map();
  for (const filePath of paths) {
    const name = path.basename(filePath);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const current = latest.get(name);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      latest.set(name, { filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return Array.from(latest.values()).map((entry) => entry.filePath);
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && isArtifact(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function cleanArtifactBaseName(name) {
  const macosName = canonicalMacosArtifactName(name);
  if (macosName) return macosName;
  if (/\.nsis\.zip$/i.test(name)) return name;
  if (/\.tar\.gz$/i.test(name)) return name;

  if (/x64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-x64.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-arm64.exe";

  if (/amd64\.AppImage$/i.test(name)) return "S3-Sidekick-Linux-x64.AppImage";
  if (/aarch64\.AppImage$/i.test(name))
    return "S3-Sidekick-Linux-arm64.AppImage";

  if (/amd64\.deb$/i.test(name)) return "S3-Sidekick-Linux-x64.deb";
  if (/aarch64\.deb$/i.test(name)) return "S3-Sidekick-Linux-arm64.deb";

  if (/x86_64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-x64.rpm";
  if (/aarch64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-arm64.rpm";

  return name;
}

function cleanArtifactName(name) {
  if (name.endsWith(".sig")) {
    const base = name.slice(0, -4);
    return `${cleanArtifactBaseName(base)}.sig`;
  }
  return cleanArtifactBaseName(name);
}

function shouldUploadReleaseEntry(name) {
  return (
    isArtifact(name) ||
    isInstallSmokeReportName(name) ||
    name.endsWith(".asc") ||
    isChecksumTextName(name)
  );
}

const FALLBACK_INSTALLER_PRIORITY = {
  windows: { nsis: 3, msi: 2 },
  linux: { appimage: 3, deb: 2, rpm: 1 },
  darwin: { app: 3 },
};

// The beta channel checks updates with a custom, arch-less target (e.g. "darwin-beta").
// Tauri's updater looks that exact string up in `platforms` with no arch/installer suffix
// appended, so each beta manifest must expose a bare `{os}-beta` key pointing at the
// self-updatable installer for that platform.
const BETA_BARE_TARGET_INSTALLER = {
  darwin: "app",
  windows: "nsis",
  linux: "appimage",
};

function inferArchFromName(name) {
  if (/(?:^|[-_.])(aarch64|arm64)(?:[-_.]|$)/i.test(name)) return "aarch64";
  if (/(?:^|[-_.])(x86_64|amd64|x64)(?:[-_.]|$)/i.test(name)) return "x86_64";
  if (/(?:^|[-_.])(i686|x86)(?:[-_.]|$)/i.test(name)) return "i686";
  return null;
}

function normalizeArchToken(token) {
  const normalized = token.toLowerCase();
  if (normalized === "aarch64" || normalized === "arm64") return "aarch64";
  if (normalized === "x86_64" || normalized === "amd64" || normalized === "x64")
    return "x86_64";
  if (normalized === "i686" || normalized === "x86") return "i686";
  return null;
}

function requiredLinuxTargetKeys(channelVariants) {
  const tokens = REQUIRED_LINUX_TARGETS.split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (REQUIRE_LINUX_AARCH64) {
    tokens.push("aarch64");
  }

  const targetKeys = new Set();
  for (const token of tokens) {
    const explicitMatch = token
      .toLowerCase()
      .match(/^(linux(?:-beta)?)-([a-z0-9_]+)$/);
    if (explicitMatch) {
      const targetName = explicitMatch[1];
      const arch = normalizeArchToken(explicitMatch[2]);
      if (!arch) {
        throw new Error(
          `Invalid REQUIRED_LINUX_TARGETS entry "${token}". Use arch names like x64/aarch64 or full keys like linux-x86_64.`,
        );
      }
      if (targetName === "linux-beta" && !IS_PRERELEASE) {
        throw new Error(
          `Invalid REQUIRED_LINUX_TARGETS entry "${token}" for stable version ${VERSION}; linux-beta targets are only generated for prereleases.`,
        );
      }
      targetKeys.add(`${targetName}-${arch}`);
      continue;
    }

    const arch = normalizeArchToken(token);
    if (!arch) {
      throw new Error(
        `Invalid REQUIRED_LINUX_TARGETS entry "${token}". Use arch names like x64/aarch64 or full keys like linux-x86_64.`,
      );
    }
    for (const channel of channelVariants) {
      targetKeys.add(`linux${channel.targetSuffix}-${arch}`);
    }
  }
  return targetKeys;
}

function canPopulateFallbackTarget(target) {
  return target.os !== "linux";
}

function assertLinuxX64PackageSet(byName) {
  if (!ENFORCE_LINUX_X64_PACKAGE_SET) {
    return;
  }

  const installers = new Set();
  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    for (const target of targets) {
      if (target.os === "linux" && target.arch === "x86_64") {
        installers.add(target.installer);
      }
    }
  }

  if (installers.size === 0) {
    return;
  }

  const requiredInstallers = ["appimage", "deb", "rpm"];
  const missing = requiredInstallers.filter(
    (installer) => !installers.has(installer),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Linux x86_64 bundle set: missing ${missing.join(", ")} artifact(s). ` +
        "Expected AppImage, deb, and rpm artifacts before signing.",
    );
  }
}

function resolveUpdaterTargets(name) {
  const targets = [];
  if (/\.app\.tar\.gz$/i.test(name)) {
    const arch = inferArchFromName(name);
    const arches = arch ? [arch] : ["x86_64", "aarch64"];
    for (const a of arches) {
      targets.push({ os: "darwin", arch: a, installer: "app" });
    }
    return targets;
  }

  if (/\.exe$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "nsis" });
    return targets;
  }

  if (/\.msi$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "msi" });
    return targets;
  }

  if (/\.appimage$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "appimage" });
    return targets;
  }

  if (/\.deb$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "deb" });
    return targets;
  }

  if (/\.rpm$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "rpm" });
    return targets;
  }

  return targets;
}

function releaseAssetUrl(fileName, baseUrl = RELEASE_DOWNLOAD_BASE_URL) {
  return `${baseUrl}/${encodeURIComponent(fileName)}`;
}

function decodeBase64(value, label) {
  const compact = String(value).replace(/\s/g, "");
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new Error(`Invalid base64 in ${label}.`);
  }
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (canonical !== compact.replace(/=+$/, "")) {
    throw new Error(`Invalid base64 in ${label}.`);
  }
  return decoded;
}

function readMinisignText(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    throw new Error(`Minisign signature is empty: ${filePath}`);
  }
  if (raw.includes("untrusted comment:")) {
    return { text: raw, encoded: false };
  }

  const decoded = decodeBase64(raw, `Minisign signature ${filePath}`).toString(
    "utf8",
  );
  if (!decoded.includes("untrusted comment:")) {
    throw new Error(`Minisign signature is malformed: ${filePath}`);
  }
  return { text: decoded.trim(), encoded: true };
}

function parseMinisignSignature(text, filePath) {
  const lines = text.split(/\r?\n/);
  if (
    lines.length < 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error(`Minisign signature is malformed: ${filePath}`);
  }
  const signed = decodeBase64(lines[1], `Minisign signature ${filePath}`);
  const global = decodeBase64(
    lines[3],
    `Minisign global signature ${filePath}`,
  );
  if (signed.length !== 74 || global.length !== 64) {
    throw new Error(`Minisign signature has invalid length: ${filePath}`);
  }
  if (!signed.subarray(0, 2).equals(Buffer.from("ED"))) {
    throw new Error(
      `Minisign signature must use the Tauri prehashed ED algorithm: ${filePath}`,
    );
  }
  return {
    keyId: signed.subarray(2, 10),
    signature: signed.subarray(10, 74),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature: global,
  };
}

function parseMinisignPublicKey(publicKeyValue) {
  const text = String(publicKeyValue ?? "").includes("untrusted comment:")
    ? String(publicKeyValue).trim()
    : decodeBase64(publicKeyValue, "Tauri updater public key")
        .toString("utf8")
        .trim();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("Tauri updater public key is malformed.");
  }
  const decoded = decodeBase64(lines[1], "Tauri updater public key");
  if (
    decoded.length !== 42 ||
    !decoded.subarray(0, 2).equals(Buffer.from("Ed"))
  ) {
    throw new Error("Tauri updater public key has an unsupported format.");
  }
  return {
    keyId: decoded.subarray(2, 10),
    publicKey: decoded.subarray(10, 42),
  };
}

function verifyUpdaterSignature(
  filePath,
  sigPath,
  publicKeyValue = UPDATER_PUBLIC_KEY,
) {
  const signatureText = readMinisignText(sigPath);
  const signature = parseMinisignSignature(signatureText.text, sigPath);
  const publicKey = parseMinisignPublicKey(publicKeyValue);
  if (!crypto.timingSafeEqual(publicKey.keyId, signature.keyId)) {
    throw new Error(
      `Updater signature key ID does not match configured public key: ${path.basename(filePath)}`,
    );
  }

  const publicKeyObject = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKey.publicKey,
    ]),
    format: "der",
    type: "spki",
  });
  const digest = crypto
    .createHash("blake2b512")
    .update(fs.readFileSync(filePath))
    .digest();
  if (!crypto.verify(null, digest, publicKeyObject, signature.signature)) {
    throw new Error(
      `Updater signature verification failed: ${path.basename(filePath)}`,
    );
  }
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  if (
    !crypto.verify(
      null,
      globalMessage,
      publicKeyObject,
      signature.globalSignature,
    )
  ) {
    throw new Error(
      `Updater trusted-comment signature verification failed: ${path.basename(filePath)}`,
    );
  }
  return true;
}

function normalizeUpdaterSignature(sigPath) {
  const { text, encoded } = readMinisignText(sigPath);
  parseMinisignSignature(text, sigPath);
  return encoded
    ? fs.readFileSync(sigPath, "utf8").trim()
    : Buffer.from(text).toString("base64");
}

function generateUpdaterManifests(files) {
  const byName = new Map();
  for (const filePath of files) {
    byName.set(path.basename(filePath), filePath);
  }

  assertLinuxX64PackageSet(byName);

  const signatureByBaseName = new Map();
  for (const [name, filePath] of byName) {
    if (name.endsWith(".sig")) {
      signatureByBaseName.set(name.slice(0, -4), filePath);
    }
  }

  const manifests = new Map();
  const requiredTargetKeys = new Set();
  const channelVariants = [
    { targetSuffix: "", baseUrl: RELEASE_DOWNLOAD_BASE_URL },
  ];
  if (IS_PRERELEASE) {
    channelVariants.push({
      targetSuffix: "-beta",
      baseUrl: TAG_DOWNLOAD_BASE_URL,
    });
  }
  const expectedLinuxTargetKeys = requiredLinuxTargetKeys(channelVariants);
  const generatedLinuxAppImageTargets = new Set();
  const missingSignatures = [];
  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    if (targets.length === 0) continue;
    for (const target of targets) {
      for (const channel of channelVariants) {
        requiredTargetKeys.add(
          `${target.os}${channel.targetSuffix}-${target.arch}`,
        );
      }
    }

    const sigPath = signatureByBaseName.get(name);
    if (!sigPath) {
      missingSignatures.push(`${name}.sig`);
      continue;
    }

    verifyUpdaterSignature(filePath, sigPath);
    const signature = normalizeUpdaterSignature(sigPath);
    for (const target of targets) {
      for (const channel of channelVariants) {
        const targetName = `${target.os}${channel.targetSuffix}`;
        const manifestName = `latest-${targetName}-${target.arch}.json`;
        if (!manifests.has(manifestName)) {
          manifests.set(manifestName, {
            version: VERSION,
            notes: RELEASE_NOTES,
            pub_date: RELEASE_PUB_DATE,
            platforms: {},
            fallbackPriority: -1,
          });
        }

        const manifest = manifests.get(manifestName);
        const url = releaseAssetUrl(name, channel.baseUrl);
        const installerKey = `${targetName}-${target.arch}-${target.installer}`;
        const fallbackKey = `${targetName}-${target.arch}`;
        manifest.platforms[installerKey] = { url, signature };
        if (target.os === "linux" && target.installer === "appimage") {
          generatedLinuxAppImageTargets.add(fallbackKey);
        }

        if (
          channel.targetSuffix === "-beta" &&
          BETA_BARE_TARGET_INSTALLER[target.os] === target.installer
        ) {
          manifest.platforms[targetName] = { url, signature };
        }

        const priority =
          FALLBACK_INSTALLER_PRIORITY[target.os]?.[target.installer] ?? 0;
        if (
          priority > 0 &&
          canPopulateFallbackTarget(target) &&
          (!manifest.platforms[fallbackKey] ||
            priority > manifest.fallbackPriority)
        ) {
          manifest.platforms[fallbackKey] = { url, signature };
          manifest.fallbackPriority = priority;
        }
      }
    }
  }

  if (missingSignatures.length > 0) {
    const sorted = Array.from(new Set(missingSignatures)).sort((a, b) =>
      a.localeCompare(b),
    );
    throw new Error(
      `Missing updater signature file(s): ${sorted.join(", ")}. ` +
        "Every updater-target artifact must include a matching .sig file.",
    );
  }

  const generated = [];
  const generatedTargetKeys = new Set();
  for (const manifestName of Array.from(manifests.keys()).sort()) {
    const manifest = manifests.get(manifestName);
    const output = {
      version: manifest.version,
      pub_date: manifest.pub_date,
      platforms: manifest.platforms,
    };
    if (manifest.notes) {
      output.notes = manifest.notes;
    }
    const dest = path.join(releaseDir, manifestName);
    fs.writeFileSync(dest, JSON.stringify(output, null, 2) + "\n");
    console.log(
      `  + ${manifestName} (${Object.keys(output.platforms).length} platform entries)`,
    );
    generated.push(dest);
    const targetKey = parseManifestTargetKey(manifestName);
    if (targetKey) {
      generatedTargetKeys.add(targetKey);
    }
  }

  const missingTargets = Array.from(requiredTargetKeys)
    .filter((targetKey) => !generatedTargetKeys.has(targetKey))
    .sort((a, b) => a.localeCompare(b));
  if (missingTargets.length > 0) {
    throw new Error(
      `Updater manifest generation is incomplete for target(s): ${missingTargets.join(", ")}.`,
    );
  }

  const missingLinuxTargets = Array.from(expectedLinuxTargetKeys)
    .filter((targetKey) => !generatedLinuxAppImageTargets.has(targetKey))
    .sort((a, b) => a.localeCompare(b));
  if (missingLinuxTargets.length > 0) {
    throw new Error(
      `Missing required Linux AppImage updater target(s): ${missingLinuxTargets.join(", ")}. ` +
        "Provide matching AppImage + .sig artifacts or adjust REQUIRED_LINUX_TARGETS/REQUIRE_LINUX_AARCH64.",
    );
  }

  return generated;
}

function parseManifestTargetKey(name) {
  const m = name.match(/^latest-([a-z0-9-]+)-([a-z0-9_]+)\.json$/i);
  if (!m) return null;
  return `${m[1].toLowerCase()}-${m[2].toLowerCase()}`;
}

function buildTargetKeyForManifestName(name) {
  const manifestKey = parseManifestTargetKey(name);
  return manifestKey
    ? manifestKey.replace(/-beta-([a-z0-9_]+)$/i, "-$1")
    : null;
}

function targetKeysForArtifactName(name) {
  if (isInstallSmokeReportName(name)) {
    return [name.slice("release-install-smoke-".length, -".json".length)];
  }
  const manifestKey = buildTargetKeyForManifestName(name);
  if (manifestKey) return [manifestKey];

  const baseName = name.endsWith(".sig") ? name.slice(0, -4) : name;
  return Array.from(
    new Set(resolveUpdaterTargets(baseName).map((t) => `${t.os}-${t.arch}`)),
  );
}

function normalizePreStagedArtifacts(staged) {
  const selected = new Map();

  for (const filePath of staged) {
    const originalName = path.basename(filePath);
    const cleanName = cleanArtifactName(originalName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    const current = selected.get(cleanName);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      selected.set(cleanName, {
        filePath,
        mtimeMs: stat.mtimeMs,
        originalName,
      });
    }
  }

  const canonicalPaths = new Set();
  for (const [cleanName, entry] of selected) {
    const dest = path.join(releaseDir, cleanName);
    canonicalPaths.add(path.resolve(dest));
    if (path.resolve(entry.filePath) !== path.resolve(dest)) {
      fs.copyFileSync(entry.filePath, dest);
      console.log(`  + ${entry.originalName} → ${cleanName}`);
    }
  }

  for (const filePath of staged) {
    if (!canonicalPaths.has(path.resolve(filePath))) {
      fs.rmSync(filePath, { force: true });
    }
  }

  return Array.from(selected.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(releaseDir, name));
}

function collectArtifacts() {
  fs.mkdirSync(releaseDir, { recursive: true });
  const buildSession = readBuildSession();

  const discovered = SEARCH_DIRS.flatMap((d) => walk(d));
  const found = discovered.filter(
    (filePath) =>
      artifactMatchesVersion(path.basename(filePath)) &&
      wasBuiltInSession(filePath, buildSession),
  );
  if (found.length > 0) {
    clearReleaseStaging();
    if (found.length < discovered.length) {
      console.log(
        `  ~ Skipped ${discovered.length - found.length} artifact(s) not matching ${VERSION}`,
      );
    }

    const selected = pickNewestByBasename(found);
    const collected = [];
    for (const src of selected) {
      const originalName = path.basename(src);
      const cleanName = cleanArtifactName(originalName);
      const dest = path.join(releaseDir, cleanName);
      fs.copyFileSync(src, dest);
      if (cleanName !== originalName) {
        console.log(`  + ${originalName} → ${cleanName}`);
      } else {
        console.log(`  + ${originalName}`);
      }
      collected.push(dest);
    }
    const manifests = generateUpdaterManifests(collected);
    return [...collected, ...manifests];
  }

  clearPreStagedUpdaterManifests();
  const staged = fs
    .readdirSync(releaseDir)
    .filter(
      (n) =>
        isArtifact(n) &&
        !isPerTargetManifest(n) &&
        artifactMatchesVersion(n) &&
        !n.endsWith(".asc") &&
        !isChecksumTextName(n),
    )
    .map((n) => path.join(releaseDir, n));

  const currentStaged = staged.filter((filePath) =>
    wasBuiltInSession(filePath, buildSession),
  );

  if (currentStaged.length === 0) {
    console.error(
      "No build artifacts found in:",
      [...SEARCH_DIRS, releaseDir].join(", "),
    );
    process.exit(1);
  }

  console.log(
    `  Found ${currentStaged.length} pre-staged artifact(s) in release/`,
  );
  const normalizedStaged = normalizePreStagedArtifacts(currentStaged);
  const manifests = generateUpdaterManifests(normalizedStaged);
  return Array.from(new Set([...normalizedStaged, ...manifests]));
}

function collectInstallSmokeReports(session = readBuildSession()) {
  if (!fs.existsSync(releaseDir)) return [];
  const candidates = fs
    .readdirSync(releaseDir)
    .filter(
      (name) =>
        name.startsWith("release-install-smoke-") && name.endsWith(".json"),
    );
  const malformed = candidates.filter(
    (name) => !isInstallSmokeReportName(name),
  );
  if (malformed.length > 0) {
    throw new Error(
      `Malformed install-smoke report name(s): ${malformed.sort().join(", ")}.`,
    );
  }
  const reports = candidates
    .map((name) => path.join(releaseDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile());
  const stale = reports.filter(
    (filePath) => !wasBuiltInSession(filePath, session),
  );
  if (stale.length > 0) {
    throw new Error(
      `Install-smoke report(s) predate this release session: ${stale.map((filePath) => path.basename(filePath)).join(", ")}.`,
    );
  }
  return reports.sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right)),
  );
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function generateChecksums(files) {
  const candidates = files.filter((f) => {
    const name = path.basename(f);
    return !name.endsWith(".asc") && !isChecksumTextName(name);
  });

  const manifestTargetKeys = Array.from(
    new Set(
      candidates
        .map((f) => buildTargetKeyForManifestName(path.basename(f)))
        .filter(Boolean),
    ),
  );

  const buckets = new Map();
  const addToBucket = (targetKey, filePath) => {
    if (!buckets.has(targetKey)) {
      buckets.set(targetKey, []);
    }
    buckets.get(targetKey).push(filePath);
  };

  for (const filePath of candidates) {
    const name = path.basename(filePath);
    let targetKeys = targetKeysForArtifactName(name);
    if (targetKeys.length === 0 && manifestTargetKeys.length > 0) {
      targetKeys = manifestTargetKeys;
    }
    if (targetKeys.length === 0) {
      targetKeys = ["generic"];
    }
    for (const targetKey of targetKeys) {
      addToBucket(targetKey, filePath);
    }
  }

  const outputs = [];
  for (const targetKey of Array.from(buckets.keys()).sort()) {
    const uniqueFiles = Array.from(new Set(buckets.get(targetKey)));
    const entries = uniqueFiles
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
      .map((f) => `${sha256(f)}  ${path.basename(f)}`);
    const fileName = `SHA256SUMS-${targetKey}.txt`;
    const out = path.join(releaseDir, fileName);
    fs.writeFileSync(out, entries.join("\n") + "\n");
    console.log(`  + ${fileName} (${entries.length} entries)`);
    outputs.push(out);
  }
  return outputs;
}

function runGpg(args, { environment = process.env, execute = spawnSync } = {}) {
  const result = execute("gpg", args, {
    encoding: "utf8",
    env: { ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG command failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result;
}

function signFile(filePath) {
  const asc = `${filePath}.asc`;
  const args = ["--batch", "--yes", "--armor", "--detach-sign"];
  if (GPG_KEY_ID) {
    args.push("--local-user", GPG_KEY_ID);
  }
  if (GPG_PASSPHRASE) {
    args.push("--pinentry-mode", "loopback", "--passphrase", GPG_PASSPHRASE);
  }
  if (Number.isSafeInteger(signatureEpoch)) {
    args.push("--faked-system-time", `${signatureEpoch}!`);
  }
  args.push("--output", asc, filePath);

  runGpg(args);
  return asc;
}

function signArtifacts(files) {
  const ascFiles = [];
  for (const f of files) {
    if (isSignable(path.basename(f))) {
      ascFiles.push(signFile(f));
      console.log(`  + ${path.basename(f)}.asc`);
    }
  }
  return ascFiles;
}

function ghRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function getBoundDraftRelease(descriptor) {
  const release = await ghRequest(
    "GET",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${descriptor.release.id}`,
  );
  validateMutableRelease(release, {
    expectedId: descriptor.release.id,
    expectedPrerelease: descriptor.release.prerelease,
    expectedTag: descriptor.release.tag,
    expectedTargetCommitish: descriptor.source.commit,
  });
  validateDescriptorForCheckout(descriptor, { root, release });
  return release;
}

async function listReleaseAssets(releaseId) {
  return listAllReleaseAssets((page, perPage) =>
    ghRequest(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    ),
  );
}

function classifyDraftAssetUpload(assets, fileName, filePath) {
  if (assets.some((asset) => asset?.name === RELEASE_ASSET_INDEX_NAME)) {
    throw new Error(
      `Draft asset set is frozen by ${RELEASE_ASSET_INDEX_NAME}; no further host uploads are permitted.`,
    );
  }
  const matches = assets.filter((asset) => asset?.name === fileName);
  if (matches.length > 1) {
    throw new Error(
      `Draft has duplicate assets named ${fileName}; refusing an ambiguous upload.`,
    );
  }
  return classifyImmutableAsset(matches[0], filePath);
}

async function uploadImmutableDraftAsset(
  release,
  filePath,
  {
    listAssets = listReleaseAssets,
    request = ghRequest,
    uploadAsset = (releaseId, uploadPath) =>
      uploadReleaseAssetById(
        `${REPO_OWNER}/${REPO_NAME}`,
        releaseId,
        uploadPath,
      ),
  } = {},
) {
  const validateDraft = async () => {
    const latest = await request(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}`,
    );
    validateMutableRelease(latest, {
      expectedId: release.id,
      expectedPrerelease: IS_PRERELEASE,
      expectedTag: TAG,
      expectedTargetCommitish: release.target_commitish,
    });
  };

  await validateDraft();
  const fileName = path.basename(filePath);
  const initialAction = classifyDraftAssetUpload(
    await listAssets(release.id),
    fileName,
    filePath,
  );
  if (initialAction === "skip") {
    console.log(`  = ${fileName} (identical remote digest)`);
    return "skip";
  }

  await validateDraft();
  const preUploadAction = classifyDraftAssetUpload(
    await listAssets(release.id),
    fileName,
    filePath,
  );
  if (preUploadAction === "skip") {
    console.log(`  = ${fileName} (identical remote digest)`);
    return "skip";
  }

  await Promise.resolve(uploadAsset(release.id, filePath));
  await validateDraft();
  const postUploadAction = classifyDraftAssetUpload(
    await listAssets(release.id),
    fileName,
    filePath,
  );
  if (postUploadAction !== "skip") {
    throw new Error(
      `Uploaded draft asset ${fileName} was not visible with the expected immutable digest.`,
    );
  }
  return "upload";
}

function orderHostUploadFiles(files, attestationPath) {
  const attestation = path.resolve(attestationPath);
  const signature = `${attestation}.asc`;
  const normalized = new Map(
    files.map((filePath) => [path.resolve(filePath), filePath]),
  );
  if (!normalized.has(attestation) || !normalized.has(signature)) {
    throw new Error(
      "Host upload handoff requires the attestation and its detached signature.",
    );
  }
  return [
    ...Array.from(normalized.entries())
      .filter(
        ([identity]) => identity !== attestation && identity !== signature,
      )
      .map(([, filePath]) => filePath)
      .sort((left, right) =>
        path.basename(left).localeCompare(path.basename(right)),
      ),
    normalized.get(attestation),
    normalized.get(signature),
  ];
}

async function main() {
  console.log(`\nS3 Sidekick ${VERSION} — immutable draft upload\n`);
  assertGitHubCliAuthenticated();

  console.log("[1/6] Verifying GPG and canonical descriptor...");
  if (!GPG_KEY_ID || !GPG_PASSPHRASE) {
    throw new Error(
      "GPG_KEY_ID and GPG_PASSPHRASE are required for release evidence signing.",
    );
  }
  runGpg(["--version"]);
  verifyDescriptorSignature(descriptorPath, descriptorSignaturePath);
  const descriptor = readReleaseDescriptor(descriptorPath);
  signatureEpoch = Math.floor(Date.parse(descriptor.source.committedAt) / 1000);
  if (!Number.isSafeInteger(signatureEpoch)) {
    throw new Error(
      "Release descriptor has no valid committedAt timestamp for deterministic signatures.",
    );
  }
  const release = await getBoundDraftRelease(descriptor);
  console.log(
    `  Descriptor-bound draft: ${release.html_url || TAG} (id ${release.id})`,
  );

  console.log("[2/6] Collecting artifacts and install-smoke reports...");
  const artifacts = collectArtifacts();
  const installSmokeFiles = collectInstallSmokeReports();
  const targets = Array.from(
    new Set(
      artifacts.flatMap((filePath) =>
        targetKeysForArtifactName(path.basename(filePath)),
      ),
    ),
  ).sort();
  if (targets.length === 0) {
    throw new Error(
      "No updater target could be derived from this host's artifacts.",
    );
  }

  console.log(
    "[3/6] Generating SBOM, provenance, package-smoke, and host attestation...",
  );
  const evidenceFiles = generateReleaseEvidence({
    artifactFiles: artifacts,
    descriptor,
    descriptorPath,
    releaseDir,
    targets,
  });
  const attestedFiles = [...artifacts, ...evidenceFiles];
  const signedFiles = [...attestedFiles, ...installSmokeFiles];

  console.log("[4/6] Generating checksums...");
  const checksumFiles = generateChecksums(signedFiles);

  console.log("[5/6] Signing artifacts and evidence...");
  const ascFiles = signArtifacts(signedFiles);
  for (const checksumFile of checksumFiles) {
    ascFiles.push(signFile(checksumFile));
    console.log(`  + ${path.basename(checksumFile)}.asc`);
  }

  console.log(
    "[6/6] Uploading immutable assets to the descriptor release id...",
  );
  const attestationPath = evidenceFiles.find((filePath) =>
    /^release-attestation-.+\.json$/.test(path.basename(filePath)),
  );
  if (!attestationPath) {
    throw new Error(
      "Host evidence did not produce a final attestation marker.",
    );
  }
  const everything = orderHostUploadFiles(
    fs
      .readdirSync(releaseDir)
      .filter((name) => shouldUploadReleaseEntry(name))
      .map((name) => path.join(releaseDir, name)),
    attestationPath,
  );
  for (const filePath of everything) {
    const action = await uploadImmutableDraftAsset(release, filePath);
    if (action === "upload") console.log(`  ^ ${path.basename(filePath)}`);
  }

  console.log(
    `\nDone — ${TAG} remains an unpublished descriptor-bound draft. Run release:publish only after every expected target has uploaded evidence.\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export {
  assertLinuxX64PackageSet,
  buildTargetKeyForManifestName,
  collectInstallSmokeReports,
  generateUpdaterManifests,
  getBoundDraftRelease,
  normalizeUpdaterSignature,
  orderHostUploadFiles,
  parseMinisignSignature,
  runGpg,
  targetKeysForArtifactName,
  uploadImmutableDraftAsset,
  verifyUpdaterSignature,
};
