#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("zip-macos can only run on macOS.");
  process.exit(0);
}

const root = process.cwd();
const targetIndex = process.argv.indexOf("--target");
const target =
  targetIndex >= 0 ? process.argv[targetIndex + 1] : "universal-apple-darwin";
if (!target || target.startsWith("--")) {
  throw new Error("Usage: node scripts/zip-macos.js [--target <rust-target>]");
}

const appPath = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
  "bundle",
  "macos",
  "S3 Sidekick.app",
);
if (!fs.existsSync(appPath)) {
  throw new Error(`Expected macOS bundle was not found: ${appPath}`);
}

const binaryPath = path.join(appPath, "Contents", "MacOS", "s3-sidekick");
const architectures = execFileSync("lipo", ["-archs", binaryPath], {
  encoding: "utf8",
}).trim();
for (const architecture of ["x86_64", "arm64"]) {
  if (!architectures.split(/\s+/).includes(architecture)) {
    throw new Error(
      `macOS release binary is missing ${architecture}: ${binaryPath}`,
    );
  }
}

execFileSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { stdio: "inherit" },
);
const signature = spawnSync("codesign", ["--display", "--verbose=4", appPath], {
  encoding: "utf8",
});
if (signature.error || signature.status !== 0) {
  throw signature.error ?? new Error(signature.stderr);
}
const signatureDetails = `${signature.stdout}${signature.stderr}`;
if (
  /Signature=adhoc/i.test(signatureDetails) ||
  !/Authority=Developer ID Application:/i.test(signatureDetails)
) {
  throw new Error(
    "macOS release app is not signed with a Developer ID Application certificate.",
  );
}

execFileSync("xcrun", ["stapler", "validate", appPath], {
  stdio: "inherit",
});
execFileSync(
  "spctl",
  ["--assess", "--type", "execute", "--verbose=2", appPath],
  { stdio: "inherit" },
);

const zipPath = path.join(path.dirname(appPath), "S3-Sidekick-macOS.zip");
fs.rmSync(zipPath, { force: true });
execFileSync(
  "ditto",
  ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
  { stdio: "inherit" },
);

console.log(`Created ${zipPath}`);
