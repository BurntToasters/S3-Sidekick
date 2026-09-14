import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseReleaseArgs } from "./run-release.js";
import {
  requiredDraftAssetNames,
  requiredDraftInstallerNames,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import {
  assertStableReleaseOverridesAllowed,
  isStableReleaseVersion,
} from "./release-policy.cjs";
import {
  assertExpectedRelease,
  isExpectedRelease,
} from "./release-draft-metadata.cjs";
import {
  bundleConfig,
  msiVersionForAppVersion,
} from "./tauri-windows-build.js";

test("run-release accepts only canonical host commands", () => {
  assert.equal(
    parseReleaseArgs(["win"]).continueScript,
    "release:win:continue",
  );
  assert.equal(
    parseReleaseArgs(["linux", "--skip-check"]).continueScript,
    "release:linux:continue",
  );
  assert.throws(() => parseReleaseArgs(["linux:arm64"]), /Usage/);
  assert.throws(
    () => parseReleaseArgs(["win", "--unknown"]),
    /Unknown release flag/,
  );
});

test("S3 draft matrix is static and Linux x64-only", () => {
  const installers = requiredDraftInstallerNames();
  assert.ok(installers.includes("S3-Sidekick-Linux-x64.flatpak"));
  assert.equal(
    installers.some((name) => name.includes("Linux-arm64")),
    false,
  );
  assert.ok(requiredDraftManifestNames().includes("latest-linux-x86_64.json"));
  assert.ok(
    requiredDraftManifestNames("0.11.0").includes(
      "latest-linux-beta-x86_64.json",
    ),
  );
  assert.equal(
    requiredDraftManifestNames().some(
      (name) => name.includes("linux") && name.includes("aarch64"),
    ),
    false,
  );
  assert.ok(
    requiredDraftAssetNames().includes("SHA256SUMS-windows-x86_64.txt"),
  );
});

test("release metadata accepts beta and stable drafts only", () => {
  const beta = {
    draft: true,
    id: 1,
    name: "0.11.0-beta.5",
    tag_name: "v0.11.0-beta.5",
  };
  assert.equal(isExpectedRelease(beta, "v0.11.0-beta.5"), true);
  assert.equal(assertExpectedRelease(beta, "v0.11.0-beta.5"), beta);
  assert.equal(isStableReleaseVersion("0.11.0"), true);
  assert.equal(isStableReleaseVersion("0.11.0-beta.5"), false);
});

test("stable release rejects recovery overrides", () => {
  assert.doesNotThrow(() => assertStableReleaseOverridesAllowed({}, "0.11.0"));
  assert.throws(
    () =>
      assertStableReleaseOverridesAllowed(
        { SKIP_RELEASE_MIRROR: "1" },
        "0.11.0",
      ),
    /refuses SKIP_RELEASE_MIRROR/,
  );
});

test("macOS SSH wrapper invokes the release runner directly", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["release:mac:ssh"],
    "npm run mac:ssh:keychain && node scripts/run-release.js mac",
  );
  assert.equal("release:sync-beta-manifests" in packageJson.scripts, true);
});

test("macOS release uses Tauri signing and notarization like Zinnia", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts;
  assert.match(scripts["build:mac:universal:prepared"], /^dotenv -e \.env -- /);
  assert.doesNotMatch(scripts["build:mac:universal:prepared"], /--no-sign/);
  assert.doesNotMatch(scripts["release:mac:continue"], /build:mac:trust/);
  assert.equal("build:mac:trust" in scripts, false);
  assert.equal(
    Object.values(scripts).some((command) =>
      /release-env|macos-release/.test(command),
    ),
    false,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8"),
    /APPLE_NOTARY_PROFILE/,
  );
  assert.match(
    fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8"),
    /AZURE_ARTIFACT_SIGNING_PUBLISHER_DN/,
  );
});

test("Windows beta MSI version uses numeric WiX override", () => {
  assert.equal(msiVersionForAppVersion("0.11.0-beta.5"), "0.11.0.5");
  assert.equal(msiVersionForAppVersion("0.11.0"), null);
  assert.equal(
    bundleConfig("0.11.0-beta.5").bundle.windows.wix.version,
    "0.11.0.5",
  );
  assert.throws(
    () => msiVersionForAppVersion("0.11.0-beta.65536"),
    /WiX limits/,
  );
});
