#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { collectArtifacts } from "./gpg-sign.js";

const require = createRequire(import.meta.url);
const {
  DESCRIPTOR_NAME,
  DESCRIPTOR_SIGNATURE_NAME,
  assertDescriptorRepository,
  readReleaseDescriptor,
  validateDescriptorForCheckout,
  verifyDescriptorSignature,
} = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");

function stageReleaseArtifacts() {
  const descriptorPath = path.join(releaseDir, DESCRIPTOR_NAME);
  const signaturePath = path.join(releaseDir, DESCRIPTOR_SIGNATURE_NAME);
  const descriptor = readReleaseDescriptor(descriptorPath);
  assertDescriptorRepository(descriptor, {
    owner: process.env.GH_REPO_OWNER || "BurntToasters",
    name: process.env.GH_REPO_NAME || "S3-Sidekick",
  });
  verifyDescriptorSignature(
    descriptorPath,
    signaturePath,
    descriptor.release.signingKeyFingerprint,
  );
  validateDescriptorForCheckout(descriptor, {
    root,
    release: {
      id: descriptor.release.id,
      draft: true,
      prerelease: descriptor.release.prerelease,
      tag_name: descriptor.release.tag,
      target_commitish: descriptor.source.commit,
    },
  });
  return collectArtifacts(descriptor);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const files = stageReleaseArtifacts();
    console.log(
      `[stage-release-artifacts] Staged ${files.length} final artifact(s). Complete install/update smoke checks and record the target report before release:sign:gpg.`,
    );
  } catch (error) {
    console.error(
      `stage-release-artifacts: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { stageReleaseArtifacts };
