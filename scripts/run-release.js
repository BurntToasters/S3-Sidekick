#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { commandRequiresShell } from "./npm-safe-update.mjs";

const require = createRequire(import.meta.url);
const {
  isStableReleaseVersion,
  readPackageVersion,
} = require("./release-policy.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTINUE_SCRIPTS = Object.freeze({
  win: "release:win:continue",
  mac: "release:mac:continue",
  linux: "release:linux:continue",
  "linux:x64": "release:linux:x64:continue",
});

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const knownFlags = new Set(["--skip-check"]);
  const unknown = flags.filter((flag) => !knownFlags.has(flag));
  if (unknown.length > 0) {
    throw new Error(`Unknown release flag: ${unknown.join(", ")}`);
  }
  const platforms = argv.filter((arg) => !arg.startsWith("-"));
  if (platforms.length !== 1 || !CONTINUE_SCRIPTS[platforms[0]]) {
    throw new Error(
      `Usage: node scripts/run-release.js <${Object.keys(CONTINUE_SCRIPTS).join("|")}> [--skip-check]`,
    );
  }
  return {
    continueScript: CONTINUE_SCRIPTS[platforms[0]],
    platform: platforms[0],
    skipCheck: flags.includes("--skip-check"),
  };
}

function runNpm(script, extraArgs = [], environment = {}) {
  const npm = npmCommand();
  const result = spawnSync(npm, ["run", script, ...extraArgs], {
    cwd: root,
    env: { ...process.env, ...environment },
    shell: commandRequiresShell(npm),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function assertSkipCheckAllowed(
  skipCheck,
  { environment = process.env, version = readPackageVersion() } = {},
) {
  if (!skipCheck) return false;
  if (isStableReleaseVersion(version)) {
    throw new Error(
      `--skip-check is not allowed for stable release ${version}; stable releases must use release:prepare and the CI release gate.`,
    );
  }
  if (
    !/^(1|true|yes|on)$/i.test(
      String(environment.ALLOW_RELEASE_SKIP_CHECK || "").trim(),
    )
  ) {
    throw new Error(
      "--skip-check is an explicit beta recovery override; set ALLOW_RELEASE_SKIP_CHECK=1 to confirm it.",
    );
  }
  console.warn(
    `WARNING: ALLOW_RELEASE_SKIP_CHECK=1 set for beta ${version}; this run sets FORCE_UPLOAD=1 and bypasses the draft target check.`,
  );
  return true;
}

export function main(argv = process.argv.slice(2), runner = runNpm) {
  const { continueScript, skipCheck } = parseReleaseArgs(argv);
  assertSkipCheckAllowed(skipCheck);
  runner("prerelease:prepare");
  runner("release:prepare");
  runner(continueScript, [], skipCheck ? { FORCE_UPLOAD: "1" } : {});
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) main();
