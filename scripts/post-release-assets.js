import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathsEqual, isDirectExecution } from "./direct-execution.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RELEASE_DIR = path.join(REPOSITORY_ROOT, "release");
const BUILD_ONLY_DIRECTORIES = [
  "app",
  "appimage",
  "deb",
  "dmg",
  "macos",
  "msi",
  "nsis",
  "rpm",
];
const BUILD_ONLY_FILES = [
  "builder-debug.yml",
  "builder-effective-config.yaml",
  ".build-session.json",
];
const CLI_FLAG = "--finalize-release-assets";

function removePath(targetPath) {
  fs.rmSync(targetPath, {
    force: true,
    maxRetries: 8,
    recursive: true,
    retryDelay: 100,
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const directory of BUILD_ONLY_DIRECTORIES) {
    removePath(path.join(releaseDir, directory));
  }
  for (const file of BUILD_ONLY_FILES) {
    removePath(path.join(releaseDir, file));
  }
}

function getAfterPackLocation(environment = process.env) {
  return typeof environment.AFTER_PACK_LOC === "string"
    ? environment.AFTER_PACK_LOC.trim()
    : "";
}

function isBetaReleaseVersion(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  return new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`,
  ).test(String(version ?? ""));
}

function readPackageVersion(repositoryRoot = REPOSITORY_ROOT) {
  return String(
    JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ).version || "",
  );
}

function shouldSkipBetaMirror(environment = process.env, version) {
  return (
    isBetaReleaseVersion(version) &&
    String(environment.OVERRIDE_BETA_MIRROR_SKIP ?? "").trim() !== "1"
  );
}

function shouldSkipConfiguredMirror(environment = process.env) {
  return /^(1|true|yes|on)$/i.test(
    String(environment.SKIP_RELEASE_MIRROR ?? "").trim(),
  );
}

function isMirrorableReleaseEntry(name) {
  return Boolean(name) && !name.startsWith(".");
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }
  const entries = fs.readdirSync(releaseDir).filter(isMirrorableReleaseEntry);
  if (entries.length === 0) {
    throw new Error(`release directory is empty: ${releaseDir}`);
  }
  return entries;
}

function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  const destination = fs.statSync(destinationPath);
  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile()) {
    if (source.size !== destination.size) {
      throw new Error(`mirrored file size differs: ${destinationPath}`);
    }
    if (sha256File(sourcePath) !== sha256File(destinationPath)) {
      throw new Error(`mirrored file hash differs: ${destinationPath}`);
    }
  }
  if (source.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      verifyCopiedPath(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
  }
}

function pathIsSameOrInside(candidate, parent) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  const candidateValue =
    process.platform === "win32"
      ? normalizedCandidate.toLowerCase()
      : normalizedCandidate;
  const parentValue =
    process.platform === "win32"
      ? normalizedParent.toLowerCase()
      : normalizedParent;
  return (
    candidateValue === parentValue ||
    candidateValue.startsWith(`${parentValue}${path.sep}`)
  );
}

function resolveMirrorPaths(releaseDir = RELEASE_DIR, destination) {
  if (!destination || !path.isAbsolute(destination)) {
    throw new Error("AFTER_PACK_LOC must be an absolute path.");
  }
  const requestedRelease = path.resolve(releaseDir);
  if (!fs.existsSync(requestedRelease)) {
    throw new Error(`release directory does not exist: ${requestedRelease}`);
  }
  const resolvedRelease = fs.realpathSync.native(requestedRelease);
  const requestedDestination = path.resolve(destination);
  if (
    fs.existsSync(requestedDestination) &&
    fs.lstatSync(requestedDestination).isSymbolicLink()
  ) {
    throw new Error("AFTER_PACK_LOC must not be a symbolic link.");
  }
  const missing = [];
  let ancestor = requestedDestination;
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const resolvedDestination = path.join(
    fs.realpathSync.native(ancestor),
    ...missing,
  );
  if (pathsEqual(resolvedDestination, resolvedRelease)) {
    throw new Error("AFTER_PACK_LOC cannot be the release directory.");
  }
  if (pathIsSameOrInside(resolvedDestination, REPOSITORY_ROOT)) {
    throw new Error("AFTER_PACK_LOC must be outside the repository.");
  }
  if (pathIsSameOrInside(resolvedDestination, resolvedRelease)) {
    throw new Error("AFTER_PACK_LOC cannot be inside the release directory.");
  }
  return { resolvedDestination, resolvedRelease };
}

function copyFileForMirror(sourcePath, destinationPath) {
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
  }
}

function copyPathRecursive(sourcePath, destinationPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyPathRecursive(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileForMirror(sourcePath, destinationPath);
}

function copyReleaseEntryToMirror(sourcePath, destinationPath) {
  const token = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const stagingPath = `${destinationPath}.s3-sidekick-new-${token}`;
  const rollbackPath = `${destinationPath}.s3-sidekick-old-${token}`;
  removePath(stagingPath);
  copyPathRecursive(sourcePath, stagingPath);
  try {
    verifyCopiedPath(sourcePath, stagingPath);
  } catch (error) {
    removePath(stagingPath);
    throw error;
  }
  const hadPrevious = fs.existsSync(destinationPath);
  if (hadPrevious) fs.renameSync(destinationPath, rollbackPath);
  try {
    fs.renameSync(stagingPath, destinationPath);
    verifyCopiedPath(sourcePath, destinationPath);
    if (hadPrevious) removePath(rollbackPath);
  } catch (error) {
    removePath(stagingPath);
    if (hadPrevious && fs.existsSync(rollbackPath)) {
      fs.renameSync(rollbackPath, destinationPath);
    }
    throw error;
  }
}

function copyReleaseAssets(
  releaseDir = RELEASE_DIR,
  destination,
  { logger = console } = {},
) {
  const { resolvedDestination, resolvedRelease } = resolveMirrorPaths(
    releaseDir,
    destination,
  );
  fs.mkdirSync(resolvedDestination, { recursive: true });
  const entries = getReleaseEntries(resolvedRelease);
  for (const entry of entries) {
    if (logger?.error) logger.error(`[release:mirror] copy ${entry}`);
    copyReleaseEntryToMirror(
      path.join(resolvedRelease, entry),
      path.join(resolvedDestination, entry),
    );
  }
  return entries.length;
}

function run({
  releaseDir = RELEASE_DIR,
  environment = process.env,
  logger = console,
  version = readPackageVersion(),
} = {}) {
  let destination = getAfterPackLocation(environment);
  const skippedBetaMirror = shouldSkipBetaMirror(environment, version);
  const skippedConfiguredMirror = shouldSkipConfiguredMirror(environment);
  if (skippedBetaMirror || skippedConfiguredMirror) destination = "";
  if (destination) resolveMirrorPaths(releaseDir, destination);
  cleanReleaseArtifacts(releaseDir);
  if (!destination) {
    return {
      copiedEntries: 0,
      destination: null,
      mirrored: false,
      skippedBetaMirror,
    };
  }
  return {
    copiedEntries: copyReleaseAssets(releaseDir, destination, { logger }),
    destination: path.resolve(destination),
    mirrored: true,
    skippedBetaMirror: false,
  };
}

function finalizeReleaseAssets(options = {}) {
  const result = run(options);
  if (result.mirrored) {
    console.log(
      `Mirrored and verified ${result.copiedEntries} release entries.`,
    );
  }
  return result;
}

if (isDirectExecution(import.meta.url)) {
  try {
    finalizeReleaseAssets();
  } catch (error) {
    console.error(
      `release mirror failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  CLI_FLAG,
  RELEASE_DIR,
  cleanReleaseArtifacts,
  copyReleaseAssets,
  finalizeReleaseAssets,
  getAfterPackLocation,
  getReleaseEntries,
  isBetaReleaseVersion,
  isDirectExecution,
  isMirrorableReleaseEntry,
  pathIsSameOrInside,
  pathsEqual,
  readPackageVersion,
  resolveMirrorPaths,
  run,
  shouldSkipBetaMirror,
  shouldSkipConfiguredMirror,
  verifyCopiedPath,
};
