#!/usr/bin/env node
// Regenerates the AppStream screenshots from the Playwright visual tour.
// Rerun: npm run screenshots
// Writes test-results/screenshots/report.json and the tour's Playwright report.
//
// Failure modes checked first: the tour fails and stale PNGs from an earlier run
// are copied anyway; a tour capture is missing; a capture's size differs from the
// AppStream metadata, which scripts/screenshots.test.js would reject later; the
// README capture lines are missing and the version note silently goes stale; the
// tour overwrites test-results/playwright-report.json, the quality-gate evidence.
// Any of these stops the run before docs/screenshots/ or the README changes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOUR_DIR = "test-results/ux-visual-tour/chromium/current";
const OUT_DIR = "test-results/screenshots";
const README_PATH = "docs/screenshots/README.md";
const METAINFO_PATH = "run.rosie.s3-sidekick.metainfo.xml";

export const SCREENSHOTS = [
  {
    source: `${TOUR_DIR}/light/browse-1280x800.png`,
    target: "docs/screenshots/browse-light.png",
  },
  {
    source: `${TOUR_DIR}/dark/inspector-preview-text-docked.png`,
    target: "docs/screenshots/inspector-dark.png",
  },
  {
    source: `${TOUR_DIR}/dark/settings-transfers.png`,
    target: "docs/screenshots/settings-dark.png",
  },
];

export function updateCaptureLines(readme, version, date) {
  const versionLine = /^Capture version:.*$/m;
  const dateLine = /^Captured:.*$/m;
  if (!versionLine.test(readme)) {
    throw new Error(`${README_PATH} has no "Capture version:" line`);
  }
  if (!dateLine.test(readme)) {
    throw new Error(`${README_PATH} has no "Captured:" line`);
  }
  return readme
    .replace(versionLine, `Capture version: ${version}`)
    .replace(dateLine, `Captured: ${date}`);
}

export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("file is not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function metainfoSizes(xml) {
  const sizes = new Map();
  const pattern =
    /<image type="source" width="(\d+)" height="(\d+)">https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/([^<]+)<\/image>/g;
  for (const [, width, height, file] of xml.matchAll(pattern)) {
    sizes.set(file, { width: Number(width), height: Number(height) });
  }
  return sizes;
}

export function sizeProblems(captures, declared) {
  const problems = [];
  for (const { target, size } of captures) {
    const expected = declared.get(target);
    if (!size) {
      problems.push(`${target}: tour capture is missing`);
    } else if (!expected) {
      problems.push(`${target}: not declared in ${METAINFO_PATH}`);
    } else if (
      size.width !== expected.width ||
      size.height !== expected.height
    ) {
      problems.push(
        `${target}: captured ${size.width}x${size.height}, metadata declares ${expected.width}x${expected.height}`,
      );
    }
  }
  return problems;
}

function localDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readCapture(root, source) {
  const file = path.join(root, source);
  return fs.existsSync(file) ? pngSize(fs.readFileSync(file)) : null;
}

function writeReport(root, report) {
  fs.mkdirSync(path.join(root, OUT_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(root, OUT_DIR, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const report = { version, date: localDate(), status: "failed", problems: [] };

  fs.rmSync(path.join(root, TOUR_DIR), { recursive: true, force: true });
  const tour = spawnSync(
    "npx",
    [
      "playwright",
      "test",
      "tests/browser/ux-visual-tour.spec.ts",
      "--project=chromium",
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        TOUR_PHASE: "current",
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(
          OUT_DIR,
          "playwright-report.json",
        ),
      },
    },
  );
  if (tour.status !== 0) {
    report.problems.push(
      `visual tour exited with ${tour.status ?? tour.signal ?? tour.error?.message}`,
    );
    writeReport(root, report);
    throw new Error(report.problems[0]);
  }

  const captures = SCREENSHOTS.map((shot) => ({
    ...shot,
    size: readCapture(root, shot.source),
  }));
  const declared = metainfoSizes(
    fs.readFileSync(path.join(root, METAINFO_PATH), "utf8"),
  );
  report.problems = sizeProblems(captures, declared);
  if (report.problems.length > 0) {
    writeReport(root, report);
    throw new Error(
      `screenshots not copied:\n  ${report.problems.join("\n  ")}`,
    );
  }

  const readmeFile = path.join(root, README_PATH);
  const readme = updateCaptureLines(
    fs.readFileSync(readmeFile, "utf8"),
    version,
    report.date,
  );
  for (const { source, target } of captures) {
    fs.copyFileSync(path.join(root, source), path.join(root, target));
  }
  fs.writeFileSync(readmeFile, readme);

  report.status = "passed";
  report.screenshots = captures;
  writeReport(root, report);
  for (const { target, size } of captures) {
    console.log(`${target} (${size.width}x${size.height})`);
  }
  console.log(`${README_PATH} → Capture version ${version}, ${report.date}`);
  console.log("Run npm run test:release-assets, then review and commit.");
}

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`screenshots: ${error.message}`);
    process.exitCode = 1;
  }
}
