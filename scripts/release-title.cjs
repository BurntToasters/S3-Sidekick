'use strict';

// GitHub release titles follow the BurntToasters Changelog Standard (BCLS v1.0.0,
// §1 "Tagging & Versioning" and §7 "Beta / RC Conventions"):
//
//   - the title drops the leading `v` of the tag        → `0.11.0`
//   - pre-releases are spelled out in words             → `0.11.0 Beta 3`
//   - release candidates keep the beta number and mark  → `0.11.0 Beta 3 (RC2)`
//     the RC in parentheses
//
// The tag itself is unaffected and stays machine-readable (`v0.11.0-beta.3`);
// only the human-facing title is rewritten. This lives in CommonJS so both the
// ESM signing script and the CommonJS draft-release script can share one
// implementation instead of drifting apart.

const PRERELEASE_LABELS = {
  beta: 'Beta',
  alpha: 'Alpha',
};

// `0.11.0-beta.3`, plus optional RC markers: `-rc`, `-rc2`, `.rc2`, `+rc2`.
const PRERELEASE_PATTERN =
  /^(\d+\.\d+\.\d+)-(beta|alpha)\.(\d+)(?:[-.+]rc(\d*))?$/i;

/**
 * Convert a package version into its BCLS-conformant GitHub release title.
 *
 * Unrecognised or stable versions fall back to the version with any leading `v`
 * stripped, so an unexpected version string still produces a sane title rather
 * than throwing in the middle of a release.
 *
 * @param {string} version e.g. `0.11.0-beta.3`
 * @returns {string} e.g. `0.11.0 Beta 3`
 */
function formatReleaseTitle(version) {
  const raw = String(version == null ? '' : version).trim();
  const withoutPrefix = raw.replace(/^v/i, '');

  const match = withoutPrefix.match(PRERELEASE_PATTERN);
  if (!match) return withoutPrefix;

  const [, core, channel, number, rc] = match;
  const label = PRERELEASE_LABELS[channel.toLowerCase()];
  if (!label) return withoutPrefix;

  const title = `${core} ${label} ${number}`;
  if (rc === undefined) return title;
  // A bare `-rc` is the first candidate and is written without a number.
  return `${title} (RC${rc || ''})`;
}

module.exports = { formatReleaseTitle };
