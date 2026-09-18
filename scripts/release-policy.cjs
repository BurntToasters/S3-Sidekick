"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STABLE_FORBIDDEN_ENV = [
  "SKIP_WIN_CODESIGN",
  "FORCE_UPLOAD",
  "SKIP_RELEASE_MIRROR",
  "ALLOW_ASSET_REPLACE",
];
const STABLE_FORBIDDEN_FALSY_ENV = ["ENFORCE_LINUX_X64_PACKAGE_SET"];
const STABLE_CANONICAL_ENV = Object.freeze({
  GH_REPO_NAME: "S3-Sidekick",
  GH_REPO_OWNER: "BurntToasters",
});

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function isExplicitFalsy(value) {
  return /^(0|false|no|off)$/i.test(String(value || "").trim());
}

function isStableReleaseVersion(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
    String(version || ""),
  );
}

function readPackageVersion(root = path.join(__dirname, "..")) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return String(packageJson.version || "").trim();
}

function assertStableReleaseOverridesAllowed(
  environment = process.env,
  version = readPackageVersion(),
) {
  if (!isStableReleaseVersion(version)) return;
  const blocked = STABLE_FORBIDDEN_ENV.filter((name) =>
    isExplicitTruthy(environment[name]),
  );
  for (const name of STABLE_FORBIDDEN_FALSY_ENV) {
    if (environment[name] !== undefined && isExplicitFalsy(environment[name])) {
      blocked.push(name);
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `Stable release ${version} refuses ${blocked.join(", ")}. Those overrides are beta recovery paths only.`,
    );
  }
  const mismatches = [];
  for (const [name, canonical] of Object.entries(STABLE_CANONICAL_ENV)) {
    const value = String(environment[name] || "").trim();
    if (value && value !== canonical) mismatches.push(`${name}="${value}"`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Stable release ${version} refuses non-canonical GitHub targets: ${mismatches.join(", ")}.`,
    );
  }
}

module.exports = {
  STABLE_FORBIDDEN_ENV,
  STABLE_FORBIDDEN_FALSY_ENV,
  STABLE_CANONICAL_ENV,
  assertStableReleaseOverridesAllowed,
  isExplicitFalsy,
  isExplicitTruthy,
  isStableReleaseVersion,
  readPackageVersion,
};
