#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { run as updateMetainfo } from "./update-metainfo.js";
import {
  syncChangelogForVersion,
  syncNpmLockfileVersion,
} from "./sync-version-helpers.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
).version;

// Compute the CHANGELOG and lockfile rewrites before touching any file, so
// marker drift or a malformed lockfile aborts without a half-synced tree.
const changelogPath = path.join(root, "CHANGELOG.md");
const npmLockPath = path.join(root, "package-lock.json");
const changelog = fs.readFileSync(changelogPath, "utf8");
const npmLock = fs.readFileSync(npmLockPath, "utf8");
let syncedChangelog;
let syncedNpmLock;
try {
  syncedChangelog = syncChangelogForVersion(changelog, version);
  syncedNpmLock = syncNpmLockfileVersion(npmLock, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const tauriConf = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
if (conf.version !== version) {
  conf.version = version;
  fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + "\n");
  console.log(`tauri.conf.json → ${version}`);
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
let cargo = fs.readFileSync(cargoPath, "utf-8");
const packageSectionPattern = /(\[package\][\s\S]*?)(\r?\n\[[^\]]+\]|$)/;
const packageSectionMatch = cargo.match(packageSectionPattern);

let updated = cargo;
if (packageSectionMatch) {
  const packageSection = packageSectionMatch[1];
  const nextPackageSection = packageSection.replace(
    /^(\s*version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  if (nextPackageSection !== packageSection) {
    updated = cargo.replace(packageSection, nextPackageSection);
  }
}

if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  console.log(`Cargo.toml      → ${version}`);
}

// Keep the workspace package entry in Cargo.lock aligned so `cargo … --locked`
// (used by license generation / CI) does not fail after a version bump.
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
if (fs.existsSync(cargoLockPath)) {
  const cargoLock = fs.readFileSync(cargoLockPath, "utf-8");
  const packageNameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
  const packageName = packageNameMatch?.[1] ?? "s3-sidekick";
  const lockPackagePattern = new RegExp(
    `(name = "${packageName}"\\nversion = )"([^"]*)"`,
  );
  const lockMatch = cargoLock.match(lockPackagePattern);
  if (lockMatch && lockMatch[2] !== version) {
    const nextLock = cargoLock.replace(lockPackagePattern, `$1"${version}"`);
    fs.writeFileSync(cargoLockPath, nextLock);
    console.log(`Cargo.lock      → ${version}`);
  }
}

try {
  const metainfo = updateMetainfo();
  if (metainfo.updated) {
    console.log(
      `AppStream metadata → ${metainfo.version} (${metainfo.date})`,
    );
  }
} catch (error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  console.error(`Failed to update AppStream metadata: ${message}`);
  process.exit(1);
}

if (syncedChangelog !== changelog) {
  fs.writeFileSync(changelogPath, syncedChangelog);
  console.log(`CHANGELOG.md    → v${version} (download URLs + section)`);
}

if (syncedNpmLock !== npmLock) {
  fs.writeFileSync(npmLockPath, syncedNpmLock);
  const lockVerify = JSON.parse(fs.readFileSync(npmLockPath, "utf8"));
  if (
    lockVerify.version !== version ||
    lockVerify.packages?.[""]?.version !== version
  ) {
    console.error("package-lock.json write verification failed");
    process.exit(1);
  }
  console.log(`package-lock.json → ${version}`);
}
