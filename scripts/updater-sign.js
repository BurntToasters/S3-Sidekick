#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const targetRoot = path.join(root, "src-tauri", "target");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function isUpdaterArtifact(filePath) {
  const name = path.basename(filePath);
  if (name.endsWith(".sig")) return false;
  return (
    /\.app\.tar\.gz$/i.test(name) ||
    /\.appimage$/i.test(name) ||
    /\.appimage\.tar\.gz$/i.test(name) ||
    /\.nsis\.zip$/i.test(name) ||
    /-setup\.exe$/i.test(name)
  );
}

function assertSigningCredential(environment = process.env) {
  if (
    !environment.TAURI_SIGNING_PRIVATE_KEY?.trim() &&
    !environment.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
  ) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required for the isolated updater-signing phase.",
    );
  }
}

function signUpdaterArtifacts({
  targetRootPath = targetRoot,
  environment = process.env,
} = {}) {
  assertSigningCredential(environment);
  const artifacts = walk(targetRootPath).filter(isUpdaterArtifact);
  if (artifacts.length === 0) {
    throw new Error(`No updater artifacts found under ${targetRootPath}.`);
  }
  for (const artifact of artifacts) {
    const signaturePath = `${artifact}.sig`;
    fs.rmSync(signaturePath, { force: true });
    const result = spawnSync(
      process.execPath,
      [tauriCli, "signer", "sign", artifact],
      { cwd: root, env: environment, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(signaturePath)) {
      throw new Error(`Updater signing failed for ${artifact}.`);
    }
    console.log(`[updater-sign] Signed ${path.basename(artifact)}`);
  }
  return artifacts.map((artifact) => `${artifact}.sig`);
}

function main() {
  signUpdaterArtifacts();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `updater-sign: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  assertSigningCredential,
  isUpdaterArtifact,
  signUpdaterArtifacts,
  walk,
};
