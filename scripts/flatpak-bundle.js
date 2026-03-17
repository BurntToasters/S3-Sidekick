#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    cwd: root,
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return String(result.stdout || "").trim();
}

function normalizeArch(raw) {
  const value = String(raw || "")
    .toLowerCase()
    .trim();
  if (
    value === "x86_64" ||
    value === "amd64" ||
    value === "x64" ||
    value === "x86-64"
  ) {
    return "x64";
  }
  if (value === "aarch64" || value === "arm64") {
    return "arm64";
  }
  return value || "unknown";
}

function detectArch() {
  const envArch = normalizeArch(process.env.FLATPAK_ARCH || "");
  if (envArch !== "unknown") {
    return envArch;
  }

  const flatpakArch = normalizeArch(runCapture("flatpak", ["--default-arch"]));
  if (flatpakArch !== "unknown") {
    return flatpakArch;
  }

  return normalizeArch(process.arch);
}

function main() {
  run("flatpak-builder", [
    "--repo=flatpak-repo",
    "--force-clean",
    "flatpak-build",
    "run.rosie.s3-sidekick.yml",
  ]);

  const arch = detectArch();
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const bundlePath = path.join(distDir, `S3-Sidekick-Linux-${arch}.flatpak`);

  run("flatpak", [
    "build-bundle",
    "flatpak-repo",
    bundlePath,
    "run.rosie.s3-sidekick",
  ]);

  console.log(`Created Flatpak bundle: ${bundlePath}`);
}

try {
  main();
} catch (error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  console.error(`Flatpak bundle failed: ${message}`);
  process.exit(1);
}
