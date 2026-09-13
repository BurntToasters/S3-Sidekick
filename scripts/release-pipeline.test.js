import assert from "node:assert/strict";
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
