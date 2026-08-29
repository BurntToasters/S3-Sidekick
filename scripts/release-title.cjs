'use strict';

// GitHub release titles are the package version with any leading `v` stripped:
// `0.11.0`, `0.11.0-beta.3`. No app name, no spelled-out Beta/RC subtitle.
// Tag stays machine-readable (`v0.11.0-beta.3`). Shared by signing and draft
// scripts so the title cannot drift.

/**
 * Convert a package version into the GitHub release title.
 *
 * @param {string} version e.g. `0.11.0-beta.3` or `v0.11.0`
 * @returns {string} e.g. `0.11.0-beta.3` or `0.11.0`
 */
function formatReleaseTitle(version) {
  return String(version == null ? '' : version).trim().replace(/^v/i, '');
}

module.exports = { formatReleaseTitle };
