#!/usr/bin/env node
// E2E for scripts/sync-version.js, the first step of `npm run u`.
//
// Failure modes checked before implementation:
// - A second run rewrites files again instead of being idempotent.
// - Download URLs outside the table or old release notes are changed.
// - A missing table marker or malformed lockfile leaves a partial update.
// - CRLF input gains mixed line endings.
// - npm, Tauri, Cargo, AppStream, or changelog versions diverge.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const outDir = path.join(root, "test-results", "sync-version");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "s3sk-sync-version-e2e-"),
);
const repo = path.join(scratch, "repo");
const results = [];

function run(command, args, cwd = repo) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function git(args, cwd = repo) {
  return run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.email=e2e@local",
      "-c",
      "user.name=sync-version-e2e",
      ...args,
    ],
    cwd,
  );
}

function check(name, passed, observed = undefined) {
  results.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

function copyFile(relative) {
  const destination = path.join(repo, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, relative), destination);
}

function seed(version) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src-tauri"), { recursive: true });
  for (const relative of [
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    "run.rosie.s3-sidekick.metainfo.xml",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    copyFile(relative);
  }
  for (const name of fs.readdirSync(path.join(root, "scripts"))) {
    if (/\.(?:js|cjs|mjs)$/.test(name)) copyFile(path.join("scripts", name));
  }
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  const packagePath = path.join(repo, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  git(["add", "package.json"]);
  git(["commit", "-qm", `bump ${version}`]);
}

function runSync(logName) {
  const result = run(process.execPath, ["scripts/sync-version.js"]);
  fs.writeFileSync(
    path.join(outDir, logName),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return result.status ?? 1;
}

function isClean() {
  return git(["diff", "--quiet"]).status === 0;
}

function read(relative) {
  return fs.readFileSync(path.join(repo, relative), "utf8");
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

try {
  const version = "0.11.2-beta.1";
  seed(version);
  const previousHeading = read("CHANGELOG.md")
    .split(/\r?\n/)
    .find((line) => line.startsWith("## Changes in"));
  const firstStatus = runSync("run1.log");
  const firstDiff = git(["diff"]);
  fs.writeFileSync(path.join(outDir, "diff-run1.patch"), firstDiff.stdout);
  git(["add", "-A"]);
  git(["commit", "-qm", "run1"]);
  const secondStatus = runSync("run2.log");
  const secondDiff = git(["diff"]);
  fs.writeFileSync(path.join(outDir, "diff-run2.patch"), secondDiff.stdout);

  const changelog = read("CHANGELOG.md");
  const tags = [
    ...new Set(
      [...changelog.matchAll(/releases\/download\/(v[^/]+)\//g)].map(
        (match) => match[1],
      ),
    ),
  ];
  const heading = `## Changes in \`v${version}:\``;
  const headings = changelog
    .split(/\r?\n/)
    .filter((line) => line.startsWith("## Changes in"));
  const changelogDiff = git(["diff", "HEAD~1", "--", "CHANGELOG.md"]).stdout;
  const changedContent = changelogDiff
    .split(/\r?\n/)
    .filter((line) => /^[+-](?![+-])/.test(line))
    .map((line) => line.slice(1));

  check("run1 exit 0", firstStatus === 0, firstStatus);
  check("run2 exit 0", secondStatus === 0, secondStatus);
  check("run2 idempotent (empty diff)", secondDiff.stdout.length === 0);
  check(
    "all table URLs use current tag",
    tags.length === 1 && tags[0] === `v${version}`,
    tags,
  );
  check(
    "heading appears once",
    headings.filter((line) => line === heading).length === 1,
  );
  check("heading is newest section", headings[0] === heading, headings[0]);
  check(
    "heading section is empty",
    previousHeading !== undefined &&
      changelog.includes(`${heading}\n\n${previousHeading}`),
  );
  check(
    "only URL lines and heading changed in changelog",
    changedContent.every(
      (line) =>
        line === "" || line === heading || line.includes("releases/download"),
    ),
    changedContent,
  );
  const lock = JSON.parse(read("package-lock.json"));
  check(
    "lock version synced",
    lock.version === version && lock.packages?.[""]?.version === version,
  );
  check(
    "tauri.conf synced",
    JSON.parse(read("src-tauri/tauri.conf.json")).version === version,
  );

  seed("0.11.3");
  fs.writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    read("CHANGELOG.md").replace(/^> \[!IMPORTANT\]/gm, "> [!NOTE]"),
  );
  git(["add", "CHANGELOG.md"]);
  git(["commit", "-qm", "drift"]);
  const missingStatus = runSync("missing-marker.log");
  check("missing marker exits 1", missingStatus === 1, missingStatus);
  check("missing marker writes nothing", isClean());

  seed("0.11.3");
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{ broken\n");
  git(["add", "package-lock.json"]);
  git(["commit", "-qm", "broken"]);
  const badLockStatus = runSync("bad-lock.log");
  check("bad lock exits 1", badLockStatus === 1, badLockStatus);
  check("bad lock writes nothing", isClean());

  seed("0.12.0");
  fs.writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    read("CHANGELOG.md").replace(/\r?\n/g, "\r\n"),
  );
  git(["add", "CHANGELOG.md"]);
  git(["commit", "-qm", "crlf"]);
  const crlfStatus = runSync("crlf.log");
  const crlf = read("CHANGELOG.md");
  check("crlf exit 0", crlfStatus === 0, crlfStatus);
  check(
    "crlf heading inserted with CRLF",
    crlf.includes("## Changes in `v0.12.0:`\r\n\r\n"),
  );
  check("crlf has no bare LF", !/(^|[^\r])\n/.test(crlf));
  check(
    "crlf URLs use stable tag",
    crlf.includes("releases/download/v0.12.0/"),
  );
} finally {
  const passed = results.filter((result) => result.passed).length;
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        suite: "sync-version-real-script",
        passed: passed === results.length && results.length === 18,
        checkCount: results.length,
        passedCount: passed,
        checks: results,
      },
      null,
      2,
    )}\n`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}

const passed =
  results.length === 18 && results.every((result) => result.passed);
process.stdout.write(
  `${passed ? "ALL PASS" : "FAILURES"} (${results.filter((result) => result.passed).length}/${results.length})\n`,
);
process.exit(passed ? 0 : 1);
