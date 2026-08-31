#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SECRET_NAMES, childEnvironment, parseDotEnv } from "./release-env.js";

const require = createRequire(import.meta.url);
const {
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  assertCleanSource,
  readReleaseDescriptor,
  sha256File,
  validateDescriptorForCheckout,
  verifyDescriptorSignature,
} = require("./release-integrity.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const stagedSource = path.join(root, ".flatpak-source");
const descriptorPath = path.join(root, "release", DESCRIPTOR_NAME);
const descriptorSignaturePath = path.join(
  root,
  "release",
  DESCRIPTOR_SIGNATURE_NAME,
);
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
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    cwd,
    env: childEnvironment("build", process.env, {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status}${capture ? `: ${String(result.stderr || result.stdout || "").trim()}` : ""}`,
    );
  }
  return capture ? String(result.stdout || "").trim() : "";
}

function normalizeArch(raw) {
  const value = String(raw || "")
    .toLowerCase()
    .trim();
  if (["x86_64", "amd64", "x64", "x86-64"].includes(value)) return "x64";
  if (["aarch64", "arm64"].includes(value)) return "arm64";
  return value || "unknown";
}

function detectArch(execute = run) {
  const envArch = normalizeArch(process.env.FLATPAK_ARCH || "");
  if (envArch !== "unknown") return envArch;
  try {
    const flatpakArch = normalizeArch(
      execute("flatpak", ["--default-arch"], { capture: true }),
    );
    if (flatpakArch !== "unknown") return flatpakArch;
  } catch {
    // Fall back to Node's architecture below.
  }
  return normalizeArch(process.arch);
}

function isSecretEnvironmentFile(sourcePath) {
  const name = path.basename(sourcePath);
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
  if (sourcePath.endsWith(".log")) return false;
  return true;
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
      "Flatpak dependency reconstruction requires an absolute npm_execpath from the pinned release toolchain.",
    );
  }
  const cacheDirectory = makeCache();
  const nodeModules = path.join(directory, "node_modules");
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
    fs.rmSync(nodeModules, { recursive: true, force: true });
    execute(process.execPath, [...baseArguments, "--offline"], {
      cwd: directory,
    });
    if (!fs.existsSync(nodeModules)) {
      throw new Error(
        "Offline npm ci did not produce staged Flatpak dependencies.",
      );
    }
    return nodeModules;
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
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
    fs.rmSync(stagedSource, { recursive: true, force: true });
    fs.mkdirSync(stagedSource, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const sourcePath = path.join(root, entry.name);
      if (!shouldStage(sourcePath)) continue;
      fs.cpSync(sourcePath, path.join(stagedSource, entry.name), {
        recursive: true,
        dereference: false,
        filter: shouldStage,
        preserveTimestamps: true,
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

function configuredSecretValues(environment = process.env) {
  let fileValues = {};
  try {
    fileValues = parseDotEnv(fs.readFileSync(path.join(root, ".env"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Array.from(SECRET_NAMES)
    .map((name) => environment[name] ?? fileValues[name])
    .filter((value) => typeof value === "string" && value.length >= 8);
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
      if (
        secretValues.length === 0 ||
        fs.statSync(fullPath).size > 5 * 1024 * 1024
      )
        continue;
      const content = fs.readFileSync(fullPath);
      for (const value of secretValues) {
        if (content.includes(Buffer.from(value))) {
          throw new Error(
            `A configured release secret entered Flatpak source context: ${fullPath}`,
          );
        }
      }
    }
  }
  return true;
}

function loadPinnedFlatpakInputs(arch) {
  const descriptor = readReleaseDescriptor(descriptorPath);
  verifyDescriptorSignature(
    descriptorPath,
    descriptorSignaturePath,
    descriptor.release.signingKeyFingerprint,
  );
  validateDescriptorForCheckout(descriptor, {
    root,
    release: {
      draft: true,
      id: descriptor.release.id,
      prerelease: descriptor.release.prerelease,
      tag_name: descriptor.release.tag,
      target_commitish: descriptor.source.commit,
    },
  });
  const inputs = descriptor.toolchains?.flatpak?.inputsByArchitecture?.[arch];
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error(
      `Release descriptor has no exact Flatpak commits for ${arch}.`,
    );
  }
  return {
    descriptorSha256: sha256File(descriptorPath),
    inputs,
  };
}

function verifyFlatpakInputs(inputs, execute = run) {
  const observed = inputs.map((input) => {
    const commit = execute("flatpak", ["info", "--show-commit", input.ref], {
      capture: true,
    }).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(commit)) {
      throw new Error(
        `Flatpak ref ${input.ref} did not resolve to an exact commit.`,
      );
    }
    if (commit !== input.commit) {
      throw new Error(
        `Flatpak ref ${input.ref} is installed at ${commit}, not descriptor-pinned commit ${input.commit}.`,
      );
    }
    return { commit, ref: input.ref };
  });
  return observed;
}

function recordFlatpakInputs({ arch, descriptorSha256, inputs }) {
  const releaseDir = path.join(root, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  const outputPath = path.join(releaseDir, `flatpak-inputs-${arch}.json`);
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      { arch, descriptorSha256, inputs, schemaVersion: 2 },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return outputPath;
}

function runFlatpakBuild({
  platform = process.platform,
  arch = detectArch(),
  environment = process.env,
  execute = run,
  loadInputs = loadPinnedFlatpakInputs,
  verifyInputs = verifyFlatpakInputs,
  stageSource = stageFlatpakSource,
  sanitizeSource = assertSanitizedSource,
  recordInputs = recordFlatpakInputs,
  assertSource = assertCleanSource,
} = {}) {
  if (platform !== "linux")
    throw new Error("Flatpak bundling is only supported on Linux hosts.");
  const sourceCommit = assertSource(root, { environment });
  try {
    const pinned = loadInputs(arch);
    verifyInputs(pinned.inputs, execute);
    try {
      stageSource(execute, undefined, assertSource, environment);
      sanitizeSource(stagedSource);
      execute("flatpak-builder", [
        "--disable-download",
        "--repo=flatpak-repo",
        "--force-clean",
        "flatpak-build",
        "run.rosie.s3-sidekick.yml",
      ]);
      const observed = verifyInputs(pinned.inputs, execute);
      recordInputs({
        arch,
        descriptorSha256: pinned.descriptorSha256,
        inputs: observed,
      });
    } finally {
      fs.rmSync(stagedSource, { recursive: true, force: true });
    }

    const distDir = path.join(root, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const bundlePath = path.join(distDir, `S3-Sidekick-Linux-${arch}.flatpak`);
    execute("flatpak", [
      "build-bundle",
      "flatpak-repo",
      bundlePath,
      "run.rosie.s3-sidekick",
    ]);
    console.log(`Created offline Flatpak bundle: ${bundlePath}`);
    return bundlePath;
  } finally {
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
  loadPinnedFlatpakInputs,
  normalizeArch,
  recordFlatpakInputs,
  runFlatpakBuild,
  shouldStage,
  stageFlatpakSource,
  verifyFlatpakInputs,
};
