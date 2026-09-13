#!/usr/bin/env node

// Fail-fast release preflight, mirroring the Zinnia/Postal Snap shape:
// branch-free source checks plus everything the draft coordinator needs,
// before test:all and builds burn an hour on a host that cannot draft.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";
import { parseDotEnv } from "./release-env.js";

const require = createRequire(import.meta.url);
const {
  assertCleanSource,
  assertReleaseToolVersions,
  exactInstallSmokePreviousVersion,
  normalizeFlatpakInputsByArchitecture,
  parseFlatpakInputs,
  resolveGpgFingerprint,
} = require("./release-integrity.cjs");
const { assertGitHubCliAuthenticated } = require("./github-cli.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const FLATPAK_MANIFEST = "run.rosie.s3-sidekick.yml";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;

// Coordinator env uses the same precedence as release-env.js childEnvironment:
// inherited process values win, .env fills the gaps, empty strings ignored.
function mergedCoordinatorEnv(environment, dotEnv) {
  const merged = {};
  for (const name of [
    "RELEASE_FLATPAK_INPUTS",
    "RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION",
    "RELEASE_GPG_FINGERPRINT",
    "GPG_KEY_ID",
  ]) {
    const inherited = environment[name];
    const value =
      inherited !== undefined && inherited !== ""
        ? inherited
        : dotEnv[name];
    if (value !== undefined && value !== "") merged[name] = value;
  }
  return merged;
}

function validateDraftCoordinatorEnv({
  version,
  manifestRefs,
  merged,
  execute = spawnSync,
}) {
  try {
    normalizeFlatpakInputsByArchitecture(
      merged.RELEASE_FLATPAK_INPUTS,
      manifestRefs,
    );
  } catch (error) {
    throw new Error(
      `Invalid RELEASE_FLATPAK_INPUTS: ${error instanceof Error ? error.message : String(error)}\n` +
        "Resolve both Flatpak architectures on a Linux host " +
        "(`npm run release:flatpak-inputs`) and paste the emitted " +
        "RELEASE_FLATPAK_INPUTS=… line into .env before starting the release.",
    );
  }
  try {
    exactInstallSmokePreviousVersion(
      version,
      merged.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION,
    );
  } catch (error) {
    throw new Error(
      `Invalid RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION: ${error instanceof Error ? error.message : String(error)}\n` +
        "Set it to the one immediate public predecessor in .env (see docs/RELEASE.md).",
    );
  }
  try {
    resolveGpgFingerprint(merged, { execute });
  } catch (error) {
    throw new Error(
      `Invalid release signing identity: ${error instanceof Error ? error.message : String(error)}\n` +
        "Configure GPG_KEY_ID (or RELEASE_GPG_FINGERPRINT) so the draft can pin the signing key.",
    );
  }
}

function gitOutput(args, { rootDirectory, execute }) {
  const result = execute("git", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`,
    );
  }
  return String(result.stdout || "").trimEnd();
}

function runReleasePreflight({
  environment = process.env,
  rootDirectory = root,
  execute = spawnSync,
  assertSource = assertCleanSource,
  assertTools = assertReleaseToolVersions,
  checkGitHubAuth = assertGitHubCliAuthenticated,
} = {}) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"),
  );
  const version = String(packageJson.version ?? "");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Unsupported release version '${version}'; expected x.y.z or x.y.z-beta.N.`,
    );
  }
  assertSource(rootDirectory, { environment });
  gitOutput(["fetch", "--quiet", "origin"], { rootDirectory, execute });
  const head = gitOutput(["rev-parse", "HEAD"], { rootDirectory, execute });
  let upstream;
  try {
    upstream = gitOutput(["rev-parse", "@{u}"], { rootDirectory, execute });
  } catch {
    throw new Error(
      "No upstream is configured. Push the release branch and set its upstream before starting the release.",
    );
  }
  if (head !== upstream) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${upstream.slice(0, 12)}. Push before starting the release.`,
    );
  }
  assertTools(packageJson, { environment, root: rootDirectory });
  let dotEnv = {};
  try {
    dotEnv = parseDotEnv(
      fs.readFileSync(path.join(rootDirectory, ".env"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const manifestRefs = parseFlatpakInputs(
    fs.readFileSync(path.join(rootDirectory, FLATPAK_MANIFEST), "utf8"),
  ).refs;
  validateDraftCoordinatorEnv({
    version,
    manifestRefs,
    merged: mergedCoordinatorEnv(environment, dotEnv),
    execute,
  });
  checkGitHubAuth();
  console.log(`release-preflight: ok (${version}, ${head.slice(0, 12)}).`);
}

if (isDirectExecution(import.meta.url)) {
  try {
    runReleasePreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { mergedCoordinatorEnv, runReleasePreflight, validateDraftCoordinatorEnv };
