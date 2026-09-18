"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readChangelogReleaseBody } = require("./ensure-draft-release.cjs");

test("draft release notes contain the complete changelog", () => {
  const packageJson = require("../package.json");
  const changelog = fs.readFileSync(
    path.join(__dirname, "..", "CHANGELOG.md"),
    "utf8",
  );
  const isBeta = /-beta\.\d+$/.test(packageJson.version);

  assert.equal(readChangelogReleaseBody(), changelog);
  assert.match(changelog, /^# ⬇️ Downloads$/m);
  assert.match(changelog, /^## ℹ️ Release Info$/m);
  if (isBeta) {
    assert.match(changelog, /^> \[!NOTE\]/);
    assert.match(changelog, /This is a beta build/);
  } else {
    // Stable keeps the beta banner commented out for the next beta cut.
    assert.match(changelog, /<!-- > \[!NOTE\]/);
    assert.doesNotMatch(changelog, /^> \[!NOTE\]/);
  }
});
