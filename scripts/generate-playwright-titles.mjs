#!/usr/bin/env node
// Update the title digest in tests/browser/required-specs.json from a
// completed Playwright JSON report. Run deliberately after adding, renaming,
// or removing a browser test: the release gate rejects a report whose titles
// no longer match the committed digest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwrightTitlesDigest } from "./verify-playwright-report.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "tests", "browser", "required-specs.json");
const reportPath =
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ||
  path.join(root, "test-results", "playwright-report.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
manifest.titlesSha256 = playwrightTitlesDigest(report);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[playwright:titles] Wrote ${manifest.titlesSha256} (${Object.values(manifest.specs).reduce((total, count) => total + Number(count || 0), 0)} tests).`,
);
