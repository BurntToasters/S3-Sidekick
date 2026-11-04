#!/usr/bin/env node
// Release gate for the Playwright suite. A green run is not enough: every spec
// in tests/browser/required-specs.json must run on every required project with
// its expected test count, and no test may be skipped or retried.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = path.join(
  root,
  "tests",
  "browser",
  "required-specs.json",
);
const defaultReport =
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ||
  path.join(root, "test-results", "playwright-report.json");

function walkSuites(suites, visit) {
  for (const suite of Array.isArray(suites) ? suites : []) {
    visit(suite);
    walkSuites(suite.suites, visit);
  }
}

export function verifyPlaywrightReport(report, manifest) {
  const problems = [];
  if (!report || typeof report !== "object") {
    return ["Playwright JSON report is missing or invalid."];
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    problems.push(
      `Playwright reported ${report.errors.length} suite error(s).`,
    );
  }
  const specs = manifest?.specs;
  const projects = manifest?.projects;
  if (!specs || typeof specs !== "object" || Object.keys(specs).length === 0) {
    return ["Playwright required-spec manifest has no specs."];
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    return ["Playwright required-spec manifest has no projects."];
  }
  const expectedTotal = Object.values(specs).reduce(
    (total, count) => total + Number(count || 0),
    0,
  );
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal <= 0) {
    return ["Playwright required-spec manifest has an invalid test count."];
  }
  if (Number(manifest.testCount) !== expectedTotal) {
    problems.push(
      `Playwright manifest testCount is ${manifest.testCount}, but per-spec counts total ${expectedTotal}.`,
    );
  }

  const counts = new Map();
  const seenProjects = new Set();
  const seenFiles = new Set();
  walkSuites(report.suites, (suite) => {
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const file = String(spec.file || suite.file || "");
      if (!file) {
        problems.push("Playwright report contains a spec without a file.");
        continue;
      }
      seenFiles.add(file);
      counts.set(file, (counts.get(file) || 0) + (spec.tests?.length || 0));
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (test.projectName) seenProjects.add(test.projectName);
        const results = Array.isArray(test.results) ? test.results : [];
        const label = `${file} :: ${spec.title || test.title || "untitled"}`;
        if (results.length !== 1) {
          problems.push(
            `Playwright test was retried ${Math.max(0, results.length - 1)} time(s); flakes cannot pass the release gate: ${label}.`,
          );
        }
        if (test.status !== "expected") {
          problems.push(
            `Playwright test status is ${test.status || "unknown"} (skipped or unexpected): ${label}.`,
          );
        }
        for (const result of results) {
          if (result.status !== "passed") {
            problems.push(
              `Playwright result status is ${result.status || "unknown"}: ${label}.`,
            );
          }
          if (Number(result.retry || 0) > 0) {
            problems.push(`Playwright retry index ${result.retry}: ${label}.`);
          }
        }
      }
    }
  });

  for (const [file, expected] of Object.entries(specs)) {
    if (!seenFiles.has(file)) {
      problems.push(`Playwright did not run required spec ${file}.`);
      continue;
    }
    if (counts.get(file) !== expected) {
      problems.push(
        `Playwright spec ${file} ran ${counts.get(file) ?? 0} test(s), expected ${expected}.`,
      );
    }
  }
  for (const file of seenFiles) {
    if (!(file in specs)) {
      problems.push(
        `Playwright ran unlisted spec ${file}; add it to tests/browser/required-specs.json.`,
      );
    }
  }
  for (const project of projects) {
    if (!seenProjects.has(project)) {
      problems.push(`Playwright did not run required project ${project}.`);
    }
  }
  for (const project of seenProjects) {
    if (!projects.includes(project)) {
      problems.push(`Playwright ran unlisted project ${project}.`);
    }
  }

  const stats = report.stats || {};
  if (stats.expected !== expectedTotal) {
    problems.push(
      `Playwright expected count is ${stats.expected}, expected ${expectedTotal}.`,
    );
  }
  if (Number(stats.skipped || 0) !== 0) {
    problems.push(`Playwright skipped ${stats.skipped} test(s).`);
  }
  if (Number(stats.unexpected || 0) !== 0) {
    problems.push(`Playwright had ${stats.unexpected} unexpected test(s).`);
  }
  if (Number(stats.flaky || 0) !== 0) {
    problems.push(`Playwright had ${stats.flaky} flaky test(s).`);
  }
  return problems;
}

function argsValue(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

if (isDirectExecution(import.meta.url)) {
  const manifestPath = argsValue("manifest", defaultManifest);
  const reportPath = argsValue("report", defaultReport);
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const problems = verifyPlaywrightReport(report, manifest);
    if (problems.length > 0) {
      console.error("Playwright release-gate verification failed:");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(
      `Playwright release-gate verification: ok (${manifest.testCount} tests, ${Object.keys(manifest.specs).length} specs, ${manifest.projects.join("+")}).`,
    );
  } catch (error) {
    console.error(
      `Playwright release-gate verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { defaultManifest, defaultReport };
