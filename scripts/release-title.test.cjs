'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { formatReleaseTitle } = require('./release-title.cjs');

test('beta versions become BCLS spelled-out titles', () => {
  assert.equal(formatReleaseTitle('0.11.0-beta.3'), '0.11.0 Beta 3');
  assert.equal(formatReleaseTitle('v0.11.0-beta.3'), '0.11.0 Beta 3');
  assert.equal(formatReleaseTitle('0.11.0-beta.1'), '0.11.0 Beta 1');
  assert.equal(formatReleaseTitle('2.1.0-alpha.2'), '2.1.0 Alpha 2');
});

test('release candidates keep the beta number and mark the RC', () => {
  assert.equal(formatReleaseTitle('0.11.0-beta.3-rc'), '0.11.0 Beta 3 (RC)');
  assert.equal(formatReleaseTitle('0.11.0-beta.3-rc2'), '0.11.0 Beta 3 (RC2)');
  assert.equal(formatReleaseTitle('0.11.0-beta.3+rc2'), '0.11.0 Beta 3 (RC2)');
});

test('stable and unrecognised versions only lose the v prefix', () => {
  assert.equal(formatReleaseTitle('0.10.2'), '0.10.2');
  assert.equal(formatReleaseTitle('v0.10.2'), '0.10.2');
  assert.equal(formatReleaseTitle('0.11.0-nightly'), '0.11.0-nightly');
  assert.equal(formatReleaseTitle(''), '');
  assert.equal(formatReleaseTitle(undefined), '');
});

// Kept in sync with package.json by `npm run sync-version`
// (via `npm run u` / workspace:bootstrap). Do not edit by hand.
const EXPECTED_SHIPPED_RELEASE_TITLE = '0.11.0 Beta 4';

test('the shipped package version produces the expected release title', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  assert.equal(formatReleaseTitle(pkg.version), EXPECTED_SHIPPED_RELEASE_TITLE);
});

test('both release scripts derive their title from this helper', () => {
  const read = (name) =>
    fs.readFileSync(path.join(__dirname, name), 'utf8');

  for (const name of ['gpg-sign.js', 'ensure-draft-release.cjs']) {
    const source = read(name);
    assert.match(
      source,
      /release-title\.cjs/,
      `${name} must import the shared release-title helper`
    );
    assert.match(
      source,
      /name: formatReleaseTitle\(/,
      `${name} must set the GitHub release name from formatReleaseTitle`
    );
  }
});
