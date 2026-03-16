#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
const pkgPath = path.join(repoRoot, "package.json");
const xmlPath = path.join(repoRoot, "run.rosie.s3-sidekick.metainfo.xml");

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function run({ now = new Date() } = {}) {
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }

  if (!fs.existsSync(xmlPath)) {
    throw new Error(`AppStream metadata not found at ${xmlPath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse package.json: ${
        error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
      }`
    );
  }

  const version = pkg.version;
  if (!version) {
    throw new Error("package.json has no version field");
  }

  const dateStr = formatDate(now);
  const xml = fs.readFileSync(xmlPath, "utf8");

  const releasesLineMatch = xml.match(/^(\s*)<releases>\s*$/m);
  if (!releasesLineMatch) {
    throw new Error("Could not find <releases> block in AppStream metadata");
  }

  const baseIndent = releasesLineMatch[1] || "";
  const releaseIndent = `${baseIndent}  `;
  const newReleaseTag = `${releaseIndent}<release version="${version}" date="${dateStr}"/>`;

  const releasesSectionRegex = /<releases>[\s\S]*?<\/releases>/;
  const releasesSectionMatch = xml.match(releasesSectionRegex);
  if (!releasesSectionMatch) {
    throw new Error("Could not locate releases section");
  }

  const releaseSelfClosingRegex = /<release\b[^>]*\/>/;
  const releasePairedRegex = /<release\b[^>]*>[\s\S]*?<\/release>/;

  const currentReleaseMatch =
    releasesSectionMatch[0].match(releaseSelfClosingRegex) ||
    releasesSectionMatch[0].match(/<release\b[^>]*>/);

  if (currentReleaseMatch) {
    const currentReleaseTag = currentReleaseMatch[0];
    const currentVersionMatch = currentReleaseTag.match(/version="([^"]+)"/);
    const currentDateMatch = currentReleaseTag.match(/date="([^"]+)"/);
    const currentVersion = currentVersionMatch ? currentVersionMatch[1] : null;
    const currentDate = currentDateMatch ? currentDateMatch[1] : null;

    if (currentVersion === version && currentDate === dateStr) {
      return { updated: false, version, date: dateStr };
    }
  }

  let updatedSection = releasesSectionMatch[0];
  if (releaseSelfClosingRegex.test(updatedSection)) {
    updatedSection = updatedSection.replace(releaseSelfClosingRegex, newReleaseTag);
  } else if (releasePairedRegex.test(updatedSection)) {
    updatedSection = updatedSection.replace(releasePairedRegex, newReleaseTag);
  } else {
    updatedSection = updatedSection.replace(/<releases>\s*/, `<releases>\n${newReleaseTag}\n${baseIndent}`);
  }

  if (updatedSection === releasesSectionMatch[0]) {
    return { updated: false, version, date: dateStr };
  }

  const updatedXml = xml.replace(releasesSectionRegex, updatedSection);
  fs.writeFileSync(xmlPath, updatedXml, "utf8");
  return { updated: true, version, date: dateStr };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const result = run();
    if (result.updated) {
      console.log(`Updated AppStream release to ${result.version} (${result.date})`);
    } else {
      console.log("AppStream metadata already up to date");
    }
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    console.error(`Failed to update AppStream metadata: ${message}`);
    process.exit(1);
  }
}

export { formatDate, run };
