import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  artifactMatchesVersion,
  assertLinuxX64PackageSet,
  assertReleaseTargetsCommit,
  releaseArtifactSearchDirs,
  rpmArtifactMatchesVersion,
} from "./gpg-sign.js";
import {
  configuredSecretValues,
  isSecretEnvironmentFile,
} from "./flatpak-bundle.js";
import {
  assertManifestReferences,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import { hasMinisignEnvelope } from "./validate-updater-manifest.js";

const packageVersion = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;
const packageTag = `v${packageVersion}`;

test("RPM version matching accepts packaging suffixes", () => {
  for (const name of [
    "s3-sidekick-0.11.0.rpm",
    "s3-sidekick-0.11.0-1.x86_64.rpm",
    "s3-sidekick-0.11.0-1.fc40.x86_64.rpm",
    "s3-sidekick_0.11.0-2_noarch.rpm.sig",
  ]) {
    assert.equal(rpmArtifactMatchesVersion(name, "0.11.0"), true);
    assert.equal(artifactMatchesVersion(name, "0.11.0"), true);
  }
});

test("RPM version matching accepts beta encodings", () => {
  for (const name of [
    "s3-sidekick-0.11.0-beta.5-1.x86_64.rpm",
    "s3-sidekick-0.11.0_beta.5-1.x86_64.rpm",
    "s3-sidekick-0.11.0~beta.5-1.fc40.x86_64.rpm",
  ]) {
    assert.equal(rpmArtifactMatchesVersion(name, "0.11.0-beta.5"), true);
    assert.equal(artifactMatchesVersion(name, "0.11.0-beta.5"), true);
  }
});

test("RPM version matching rejects wrong channel or stale versions", () => {
  assert.equal(
    rpmArtifactMatchesVersion(
      "s3-sidekick-0.11.0-beta.5-1.x86_64.rpm",
      "0.11.0",
    ),
    false,
  );
  assert.equal(
    rpmArtifactMatchesVersion(
      "s3-sidekick-0.11.0-1.x86_64.rpm",
      "0.11.0-beta.5",
    ),
    false,
  );
  assert.equal(
    artifactMatchesVersion("s3-sidekick_0.11.0-beta.5_amd64.deb", "0.11.0"),
    false,
  );
});

test("Linux x64 package set requires AppImage, DEB, RPM, and Flatpak", () => {
  assert.throws(
    () =>
      assertLinuxX64PackageSet(
        new Map([["S3-Sidekick-Linux-x64.AppImage", "/tmp/a"]]),
      ),
    /Incomplete Linux x86_64 bundle set/,
  );
  assert.doesNotThrow(() =>
    assertLinuxX64PackageSet(
      new Map([
        ["S3-Sidekick-Linux-x64.AppImage", "/tmp/a"],
        ["S3-Sidekick-Linux-x64.deb", "/tmp/b"],
        ["S3-Sidekick-Linux-x64.rpm", "/tmp/c"],
        ["S3-Sidekick-Linux-x64.flatpak", "/tmp/d"],
      ]),
    ),
  );
  assert.doesNotThrow(() =>
    assertLinuxX64PackageSet(
      new Map([["S3-Sidekick-Linux-x64.AppImage", "/tmp/a"]]),
      { enforce: false },
    ),
  );
});

test("FORCE_UPLOAD bypasses draft commit mismatch", () => {
  const release = { target_commitish: "aaa" };
  assert.throws(
    () => assertReleaseTargetsCommit(release, "bbb", {}),
    /not HEAD bbb/,
  );
  const warnings = [];
  assert.equal(
    assertReleaseTargetsCommit(
      release,
      "bbb",
      { FORCE_UPLOAD: "1" },
      { warn: (message) => warnings.push(message) },
    ),
    release,
  );
  assert.match(warnings[0], /FORCE_UPLOAD=1/);
});

test("artifact discovery stays in canonical bundle roots", () => {
  const dirs = releaseArtifactSearchDirs("/tmp/s3-sidekick-target");
  assert.ok(dirs.some((dir) => dir.endsWith(path.join("release", "bundle"))));
  assert.equal(
    dirs.some((dir) => dir === "/tmp/s3-sidekick-target"),
    false,
  );
});

test("Flatpak secret scanner ignores npm package metadata", () => {
  const values = configuredSecretValues({
    npm_package_name: "s3-sidekick",
    PATH: "/usr/bin",
    GPG_PASSPHRASE: "super-secret-passphrase",
  });
  assert.equal(values.includes("s3-sidekick"), false);
  assert.equal(values.includes("/usr/bin"), false);
  assert.equal(values.includes("super-secret-passphrase"), true);
  assert.equal(
    isSecretEnvironmentFile(
      "/tmp/s3-sidekick/.flatpak-source/node_modules/dotenv-cli/.env",
    ),
    false,
  );
  assert.equal(isSecretEnvironmentFile("/tmp/s3-sidekick/.env"), true);
});

test("stable and beta drafts both require beta-transition manifests", () => {
  assert.ok(
    requiredDraftManifestNames("0.11.0").includes(
      "latest-windows-beta-x86_64.json",
    ),
  );
  assert.ok(
    requiredDraftManifestNames("0.11.0-beta.5").includes(
      "latest-linux-beta-x86_64.json",
    ),
  );
});

test("manifest URL validation rejects credentials, fragments, and traversal", () => {
  const valid = {
    version: packageVersion,
    platforms: {
      "linux-x86_64": {
        signature: "sig",
        url: `https://github.com/BurntToasters/S3-Sidekick/releases/download/${packageTag}/S3-Sidekick-Linux-x64.AppImage`,
      },
    },
  };
  const assets = new Set([
    "S3-Sidekick-Linux-x64.AppImage",
    "S3-Sidekick-Linux-x64.AppImage.sig",
  ]);
  assert.doesNotThrow(() =>
    assertManifestReferences(valid, "latest-linux-x86_64.json", assets),
  );
  assert.throws(
    () =>
      assertManifestReferences(
        {
          ...valid,
          platforms: {
            "linux-x86_64": {
              signature: "sig",
              url: `http://github.com/BurntToasters/S3-Sidekick/releases/download/${packageTag}/S3-Sidekick-Linux-x64.AppImage`,
            },
          },
        },
        "latest-linux-x86_64.json",
        assets,
      ),
    /not https/,
  );
  assert.throws(
    () =>
      assertManifestReferences(
        {
          ...valid,
          platforms: {
            "linux-x86_64": {
              signature: "sig",
              url: `https://user:pass@github.com/BurntToasters/S3-Sidekick/releases/download/${packageTag}/S3-Sidekick-Linux-x64.AppImage`,
            },
          },
        },
        "latest-linux-x86_64.json",
        assets,
      ),
    /outside this draft/,
  );
  assert.throws(
    () =>
      assertManifestReferences(
        {
          ...valid,
          platforms: {
            "linux-x86_64": {
              signature: "sig",
              url: `https://github.com/BurntToasters/S3-Sidekick/releases/download/${packageTag}/%2e%2e%2fsecret`,
            },
          },
        },
        "latest-linux-x86_64.json",
        assets,
      ),
    /unsafe artifact filename/,
  );
});

test("minisign envelope helper rejects raw strings", () => {
  assert.equal(hasMinisignEnvelope("not-a-signature"), false);
});
