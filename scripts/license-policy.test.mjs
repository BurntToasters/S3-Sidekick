import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_LICENSES,
  licenseProblems,
  ownPackagePrefix,
} from "./license-policy.mjs";

const entries = (licenses) => ({
  "cargo:dep@1.0.0": { licenses },
});

test("license policy accepts every allowlisted expression form", () => {
  for (const license of ALLOWED_LICENSES) {
    assert.deepEqual(licenseProblems(entries(license)), [], license);
  }
  assert.deepEqual(licenseProblems(entries("Apache-2.0 OR MIT")), []);
  assert.deepEqual(
    licenseProblems(entries("(MIT OR Apache-2.0) AND Unicode-3.0")),
    [],
  );
});

test("license policy rejects unknown, unlicensed, and disallowed entries", () => {
  for (const license of ["UNKNOWN", "UNLICENSED", "GPL-3.0-only", ""]) {
    assert.equal(
      licenseProblems(entries(license)).length,
      1,
      `${license || "empty"} must fail`,
    );
  }
  assert.equal(
    licenseProblems(entries("MIT OR GPL-3.0-only")).length,
    1,
    "a disallowed alternative must fail",
  );
});

test("license policy exempts only the workspace package's own entry", () => {
  const prefix = ownPackagePrefix({ name: "s3-sidekick" });
  assert.equal(prefix, "s3-sidekick@");
  assert.deepEqual(
    licenseProblems(
      { "s3-sidekick@0.12.0": { licenses: "UNLICENSED" } },
      { ownPackagePrefix: prefix },
    ),
    [],
  );
  assert.equal(
    licenseProblems(
      { "s3-sidekick-helper@1.0.0": { licenses: "UNLICENSED" } },
      { ownPackagePrefix: prefix },
    ).length,
    1,
  );
});
