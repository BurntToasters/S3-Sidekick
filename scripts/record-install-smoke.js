#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const require = createRequire(import.meta.url);
const {
  DESCRIPTOR_NAME,
  REQUIRED_INSTALL_SMOKE_CHECKS,
  canonicalJson,
  finalPackageTargetKeysForArtifactName,
  installSmokeReportName,
  readReleaseDescriptor,
  requiredFinalPackageNamesForTarget,
  sha256File,
  validateInstallSmokeReport,
} = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");

function parseArguments(args) {
  const values = { artifacts: [] };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--confirmed") {
      values.confirmed = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}.`);
    }
    index += 1;
    if (name === "--artifact") values.artifacts.push(value);
    else if (name === "--previous-version") values.previousVersion = value;
    else if (name === "--run-id") values.runId = value;
    else if (name === "--runner-image") values.runnerImage = value;
    else if (name === "--target") values.target = value;
    else throw new Error(`Unknown argument: ${name}.`);
  }
  if (
    !values.confirmed ||
    !values.target ||
    !values.previousVersion ||
    !values.runnerImage ||
    !values.runId ||
    values.artifacts.length === 0
  ) {
    throw new Error(
      "Usage: node scripts/record-install-smoke.js --confirmed --target <target> --previous-version <version> --runner-image <image> --run-id <id> --artifact <release artifact> [--artifact ...]. --confirmed attests that clean-install, launch, and previous-version-update checks passed.",
    );
  }
  return values;
}

function resolveInstallSmokeArtifacts({
  artifactInputs,
  target,
  releaseDirectory = releaseDir,
  rootDirectory = root,
}) {
  const exactReleaseDirectory = path.resolve(releaseDirectory);
  const expectedByName = new Map(
    fs
      .readdirSync(exactReleaseDirectory)
      .filter((name) =>
        finalPackageTargetKeysForArtifactName(name).includes(target),
      )
      .map((name) => {
        const filePath = path.join(exactReleaseDirectory, name);
        if (!fs.statSync(filePath).isFile()) return null;
        return [name, { name, sha256: sha256File(filePath) }];
      })
      .filter(Boolean),
  );
  const missingStagedPackages = requiredFinalPackageNamesForTarget(
    target,
  ).filter((name) => !expectedByName.has(name));
  if (missingStagedPackages.length > 0) {
    throw new Error(
      `Staged final package closure is incomplete for ${target} (missing: ${missingStagedPackages.join(", ")}).`,
    );
  }
  if (expectedByName.size === 0) {
    throw new Error(`No staged final packages belong to ${target}.`);
  }

  const artifacts = artifactInputs
    .map((inputPath) => {
      const filePath = path.resolve(rootDirectory, inputPath);
      if (path.dirname(filePath) !== exactReleaseDirectory) {
        throw new Error("Install-smoke artifacts must be files in release/.");
      }
      const name = path.basename(filePath);
      if (!fs.statSync(filePath).isFile()) {
        throw new Error(`Install-smoke artifact is not a file: ${inputPath}.`);
      }
      const packageTargets = finalPackageTargetKeysForArtifactName(name);
      if (packageTargets.length === 0) {
        throw new Error(
          `Install-smoke artifact ${name} is not a canonical final package.`,
        );
      }
      if (!packageTargets.includes(target)) {
        throw new Error(
          `Install-smoke artifact ${name} does not belong to ${target}.`,
        );
      }
      return { name, sha256: sha256File(filePath) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  if (
    new Set(artifacts.map((record) => record.name)).size !== artifacts.length
  ) {
    throw new Error("Install-smoke artifact arguments contain duplicates.");
  }
  const actualNames = new Set(artifacts.map((record) => record.name));
  const missing = Array.from(expectedByName.keys())
    .filter((name) => !actualNames.has(name))
    .sort();
  const unexpected = Array.from(actualNames)
    .filter((name) => !expectedByName.has(name))
    .sort();
  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    actualNames.size !== expectedByName.size
  ) {
    throw new Error(
      `Install-smoke artifact arguments must exactly equal the staged final package closure for ${target} (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
  return artifacts;
}

function recordInstallSmoke(args = process.argv.slice(2)) {
  const values = parseArguments(args);
  const descriptorPath = path.join(releaseDir, DESCRIPTOR_NAME);
  const descriptor = readReleaseDescriptor(descriptorPath);
  if (!descriptor.expectedTargets.includes(values.target)) {
    throw new Error(
      `Target ${values.target} is not expected by the descriptor.`,
    );
  }
  const artifacts = resolveInstallSmokeArtifacts({
    artifactInputs: values.artifacts,
    target: values.target,
  });
  const descriptorSha256 = sha256File(descriptorPath);
  const report = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    target: values.target,
    status: "passed",
    checks: [...REQUIRED_INSTALL_SMOKE_CHECKS],
    previousVersion: values.previousVersion,
    runner: { image: values.runnerImage, runId: values.runId },
    artifacts,
  };
  validateInstallSmokeReport(report, {
    descriptor,
    descriptorSha256,
    digestByName: new Map(
      artifacts.map((record) => [record.name, record.sha256]),
    ),
    expectedArtifactNames: new Set(artifacts.map((record) => record.name)),
    target: values.target,
  });
  const outputPath = path.join(
    releaseDir,
    installSmokeReportName(values.target),
  );
  fs.writeFileSync(outputPath, canonicalJson(report), {
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}

if (isDirectExecution(import.meta.url)) {
  try {
    console.log(recordInstallSmoke());
  } catch (error) {
    console.error(
      `record-install-smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { parseArguments, recordInstallSmoke, resolveInstallSmokeArtifacts };
