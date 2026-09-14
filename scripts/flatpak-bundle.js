#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDirectExecution } from "./direct-execution.js";

const { assertCleanSource } = createRequire(import.meta.url)(
  "./release-integrity.cjs",
);

const root = fileURLToPath(new URL("..", import.meta.url));
const stagedSource = path.join(root, ".flatpak-source");
const architectures = Object.freeze({ x64: "x86_64" });
const excludedRootNames = new Set([
  ".flatpak-source",
  ".git",
  ".github",
  "coverage",
  "dist",
  "flatpak-build",
  "flatpak-repo",
  "node_modules",
  "release",
  "release-artifacts",
  "semantic-review",
  "target",
]);

function run(command, args, { capture = false, cwd = root } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    env: process.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status}${capture ? `: ${String(result.stderr || result.stdout || "").trim()}` : ""}`,
    );
  }
  return capture ? String(result.stdout || "").trim() : "";
}

function normalizeArch(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .trim();
  if (["x86_64", "amd64", "x64", "x86-64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

function detectArch(execute = run) {
  const configured = normalizeArch(process.env.FLATPAK_ARCH);
  if (configured !== "unknown") return configured;
  try {
    return normalizeArch(
      execute("flatpak", ["--default-arch"], { capture: true }),
    );
  } catch {
    return normalizeArch(process.arch);
  }
}

function isSecretEnvironmentFile(sourcePath) {
  const name = path.basename(sourcePath);
  const pathSegments = path.normalize(sourcePath).split(path.sep);
  if (pathSegments.includes("node_modules")) return false;
  return (
    name !== ".env.example" && (name === ".env" || name.startsWith(".env."))
  );
}

function shouldStage(sourcePath) {
  if (path.resolve(sourcePath) === path.resolve(root)) return true;
  const relative = path.relative(root, sourcePath);
  if (!relative || relative.startsWith("..")) return false;
  const segments = relative.split(path.sep);
  if (excludedRootNames.has(segments[0])) return false;
  if (segments[0] === "src-tauri" && segments[1] === "target") return false;
  if (isSecretEnvironmentFile(sourcePath)) return false;
  return !sourcePath.endsWith(".log");
}

function installFlatpakDependencies(
  directory,
  {
    environment = process.env,
    execute = run,
    makeCache = () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-flatpak-npm-")),
  } = {},
) {
  const npmExecPath = String(environment.npm_execpath || "");
  if (!path.isAbsolute(npmExecPath)) {
    throw new Error(
      "Flatpak dependency reconstruction requires an absolute npm_execpath.",
    );
  }
  const cacheDirectory = makeCache();
  const baseArguments = [
    npmExecPath,
    "ci",
    "--ignore-scripts",
    "--include=dev",
    "--no-audit",
    "--no-fund",
    "--cache",
    cacheDirectory,
  ];
  try {
    execute(process.execPath, baseArguments, { cwd: directory });
    fs.rmSync(path.join(directory, "node_modules"), {
      force: true,
      recursive: true,
    });
    execute(process.execPath, [...baseArguments, "--offline"], {
      cwd: directory,
    });
    return path.join(directory, "node_modules");
  } finally {
    fs.rmSync(cacheDirectory, { force: true, recursive: true });
  }
}

function stageFlatpakSource(
  execute = run,
  installDependencies = installFlatpakDependencies,
  assertSource = assertCleanSource,
  environment = process.env,
) {
  const sourceCommit = assertSource(root, { environment });
  try {
    fs.rmSync(stagedSource, { force: true, recursive: true });
    fs.mkdirSync(stagedSource, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const sourcePath = path.join(root, entry.name);
      if (!shouldStage(sourcePath)) continue;
      fs.cpSync(sourcePath, path.join(stagedSource, entry.name), {
        dereference: false,
        filter: shouldStage,
        preserveTimestamps: true,
        recursive: true,
      });
    }
    installDependencies(stagedSource, { execute });
    const cargoConfigDir = path.join(stagedSource, ".cargo");
    fs.mkdirSync(cargoConfigDir, { recursive: true });
    execute("cargo", [
      "vendor",
      "--locked",
      "--manifest-path",
      path.join(stagedSource, "src-tauri", "Cargo.toml"),
      path.join(stagedSource, "vendor"),
    ]);
    fs.writeFileSync(
      path.join(cargoConfigDir, "config.toml"),
      '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n\n[net]\noffline = true\n',
    );
    return stagedSource;
  } finally {
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

const SECRET_ENV_NAMES = new Set([
  "APPLE_PASSWORD",
  "AZURE_CLIENT_SECRET",
  "GPG_KEY_ID",
  "GPG_PASSPHRASE",
  "SSH_USER_PWD",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

function isSecretEnvironmentName(name) {
  if (SECRET_ENV_NAMES.has(name)) return true;
  if (/^(GH|GITHUB)_TOKEN$/i.test(name)) return true;
  if (name.startsWith("npm_")) return false;
  return /PASSWORD|SECRET|PASSPHRASE|PRIVATE_KEY/i.test(name);
}

function configuredSecretValues(environment = process.env) {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === "string" &&
        value.length >= 8 &&
        isSecretEnvironmentName(name),
    )
    .map(([, value]) => value);
}

function assertSanitizedSource(
  directory,
  secretValues = configuredSecretValues(),
) {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretEnvironmentFile(fullPath)) {
        throw new Error(
          `Secret environment file entered Flatpak source context: ${fullPath}`,
        );
      }
      if (fs.statSync(fullPath).size > 5 * 1024 * 1024) continue;
      const content = fs.readFileSync(fullPath);
      for (const value of secretValues) {
        if (content.includes(Buffer.from(value))) {
          throw new Error(
            `Release secret entered Flatpak source context: ${fullPath}`,
          );
        }
      }
    }
  }
  return true;
}

function runFlatpakBuild({
  platform = process.platform,
  arch = detectArch(),
  environment = process.env,
  execute = run,
  stageSource = stageFlatpakSource,
  sanitizeSource = assertSanitizedSource,
  assertSource = assertCleanSource,
} = {}) {
  if (platform !== "linux") {
    throw new Error("Flatpak bundling is only supported on Linux hosts.");
  }
  if (!architectures[arch]) {
    throw new Error(`Linux Flatpak release supports x64 only; found ${arch}.`);
  }
  const sourceCommit = assertSource(root, { environment });
  try {
    stageSource(execute, undefined, assertSource, environment);
    sanitizeSource(stagedSource);
    execute("flatpak-builder", [
      `--arch=${architectures[arch]}`,
      "--repo=flatpak-repo",
      "--force-clean",
      "flatpak-build",
      "run.rosie.s3-sidekick.yml",
    ]);
    const distDir = path.join(root, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const bundlePath = path.join(distDir, "S3-Sidekick-Linux-x64.flatpak");
    execute("flatpak", [
      "build-bundle",
      "flatpak-repo",
      bundlePath,
      "run.rosie.s3-sidekick",
    ]);
    console.log(`Created offline Flatpak bundle: ${bundlePath}`);
    return bundlePath;
  } finally {
    fs.rmSync(stagedSource, { force: true, recursive: true });
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    runFlatpakBuild();
  } catch (error) {
    console.error(
      `Flatpak bundle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  assertSanitizedSource,
  configuredSecretValues,
  detectArch,
  installFlatpakDependencies,
  isSecretEnvironmentFile,
  isSecretEnvironmentName,
  runFlatpakBuild,
  shouldStage,
  stageFlatpakSource,
};
