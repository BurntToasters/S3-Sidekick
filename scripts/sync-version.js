#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { formatReleaseTitle } = require("./release-title.cjs");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
).version;

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

// Keep the shipped-version release-title assertion aligned with package.json so
// `npm run u` / workspace:bootstrap does not leave a stale Beta N expectation.
const releaseTitleTestPath = path.join(
  root,
  "scripts",
  "release-title.test.cjs",
);
if (fs.existsSync(releaseTitleTestPath)) {
  const releaseTitle = formatReleaseTitle(version);
  const releaseTitleTest = fs.readFileSync(releaseTitleTestPath, "utf-8");
  const titleConstantPattern =
    /^(const EXPECTED_SHIPPED_RELEASE_TITLE = )'[^']*'(;)/m;
  if (!titleConstantPattern.test(releaseTitleTest)) {
    throw new Error(
      "scripts/release-title.test.cjs is missing EXPECTED_SHIPPED_RELEASE_TITLE",
    );
  }
  const nextReleaseTitleTest = releaseTitleTest.replace(
    titleConstantPattern,
    `$1'${releaseTitle}'$2`,
  );
  if (nextReleaseTitleTest !== releaseTitleTest) {
    fs.writeFileSync(releaseTitleTestPath, nextReleaseTitleTest);
    console.log(`release-title.test.cjs → ${releaseTitle}`);
  }
}
