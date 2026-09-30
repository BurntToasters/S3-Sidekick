const DOWNLOADS_START_MARKER = "# ⬇️ Downloads";
const DOWNLOADS_END_MARKER = "\n> [!IMPORTANT]";
const SUPPORT_LINE_PATTERN = /^### ℹ️ Enjoying S3 Sidekick\?.*$/m;
const SECTION_HEADING_PATTERN = /^## Changes in `/m;

/**
 * Align CHANGELOG download URLs and the release section heading with the
 * package.json version. Only the download table is rewritten; URLs quoted in
 * older release notes stay pinned to the version they describe.
 */
export function syncChangelogForVersion(changelog, version) {
  const tag = `v${version}`;
  const eol = changelog.includes("\r\n") ? "\r\n" : "\n";
  const sectionHeading = `## Changes in \`${tag}:\``;

  const tableStart = changelog.indexOf(DOWNLOADS_START_MARKER);
  const tableEnd = changelog.indexOf(
    DOWNLOADS_END_MARKER.replace("\n", eol),
    tableStart,
  );
  if (tableStart === -1 || tableEnd === -1) {
    throw new Error("CHANGELOG.md download table markers not found");
  }

  const before = changelog.slice(0, tableStart);
  const table = changelog.slice(tableStart, tableEnd);
  const after = changelog.slice(tableEnd);
  const syncedTable = table.replace(
    /\/releases\/download\/v[^/]+\//g,
    `/releases/download/${tag}/`,
  );
  let updated = before + syncedTable + after;

  const hasHeading = updated
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === sectionHeading);
  if (!hasHeading) {
    // New releases go above the previous notes, newest first, as an empty
    // section for the release notes to be written into.
    const insertion = `${sectionHeading}${eol}${eol}`;
    const headingMatch = SECTION_HEADING_PATTERN.exec(updated);
    if (headingMatch) {
      updated =
        updated.slice(0, headingMatch.index) +
        insertion +
        updated.slice(headingMatch.index);
    } else {
      const supportMatch = SUPPORT_LINE_PATTERN.exec(updated);
      if (!supportMatch) {
        throw new Error("CHANGELOG.md release section anchor not found");
      }
      const anchorEnd = supportMatch.index + supportMatch[0].length;
      updated =
        updated.slice(0, anchorEnd) +
        `${eol}${eol}${sectionHeading}${eol}` +
        updated.slice(anchorEnd);
    }
  }

  return updated;
}

export function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package-lock.json root must be an object");
  }
  if (!parsed.packages || typeof parsed.packages !== "object") {
    throw new Error("package-lock.json is missing packages");
  }
  if (!parsed.packages[""] || typeof parsed.packages[""] !== "object") {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[""].version === version) {
    return lockText;
  }
  parsed.version = version;
  parsed.packages[""].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
