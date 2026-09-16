"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readChangelogReleaseBody } = require("./ensure-draft-release.cjs");

test("draft release notes contain the complete changelog", () => {
  const changelog = fs.readFileSync(
    path.join(__dirname, "..", "CHANGELOG.md"),
    "utf8",
  );

  assert.equal(readChangelogReleaseBody(), changelog);
  assert.match(changelog, /^> \[!NOTE\]/);
  assert.match(changelog, /^# ⬇️ Downloads$/m);
  assert.match(changelog, /^## ℹ️ Release Info$/m);
});
