"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { formatReleaseTitle } = require("./release-title.cjs");

test("titles are the version with no v prefix or spelled-out channel", () => {
  assert.equal(formatReleaseTitle("0.11.0-beta.3"), "0.11.0-beta.3");
  assert.equal(formatReleaseTitle("v0.11.0-beta.3"), "0.11.0-beta.3");
  assert.equal(formatReleaseTitle("0.11.0-beta.1"), "0.11.0-beta.1");
  assert.equal(formatReleaseTitle("2.1.0-alpha.2"), "2.1.0-alpha.2");
  assert.equal(formatReleaseTitle("0.11.0-beta.3-rc2"), "0.11.0-beta.3-rc2");
  assert.equal(formatReleaseTitle("0.10.2"), "0.10.2");
  assert.equal(formatReleaseTitle("v0.10.2"), "0.10.2");
  assert.equal(formatReleaseTitle("0.11.0-nightly"), "0.11.0-nightly");
  assert.equal(formatReleaseTitle(""), "");
  assert.equal(formatReleaseTitle(undefined), "");
});

// Kept in sync with package.json by `npm run sync-version`
// (via `npm run u` / workspace:bootstrap). Do not edit by hand.
const EXPECTED_SHIPPED_RELEASE_TITLE = "0.11.0-beta.5";

test("the shipped package version produces the expected release title", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.equal(formatReleaseTitle(pkg.version), EXPECTED_SHIPPED_RELEASE_TITLE);
});

test("only the draft coordinator can choose a release title", () => {
  const coordinator = fs.readFileSync(
    path.join(__dirname, "ensure-draft-release.cjs"),
    "utf8",
  );
  assert.match(coordinator, /release-title\.cjs/);
  assert.match(coordinator, /name: formatReleaseTitle\(/);

  const uploader = fs.readFileSync(path.join(__dirname, "gpg-sign.js"), "utf8");
  assert.doesNotMatch(uploader, /name: formatReleaseTitle\(/);
  assert.doesNotMatch(uploader, /ghRequest\("POST"[^)]*releases/);
});
