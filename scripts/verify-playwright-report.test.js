import assert from "node:assert/strict";
import test from "node:test";
import {
  playwrightTitlesDigest,
  verifyPlaywrightReport,
} from "./verify-playwright-report.mjs";

function fixtureReport() {
  const spec = (file, title) => ({
    file,
    title,
    ok: true,
    tests: ["chromium", "webkit"].map((projectName) => ({
      projectName,
      status: "expected",
      results: [{ status: "passed", retry: 0 }],
    })),
  });
  return {
    errors: [],
    suites: [
      {
        specs: [
          spec("first-run.spec.ts", "first run"),
          spec("layout.spec.ts", "layout"),
        ],
      },
    ],
    stats: { expected: 4, skipped: 0, unexpected: 0, flaky: 0 },
  };
}

const manifest = {
  projects: ["chromium", "webkit"],
  testCount: 4,
  specs: { "first-run.spec.ts": 2, "layout.spec.ts": 2 },
};

test("Playwright gate accepts the complete required matrix", () => {
  assert.deepEqual(verifyPlaywrightReport(fixtureReport(), manifest), []);
});

test("Playwright gate rejects a report from a different commit", () => {
  const report = fixtureReport();
  report.config = { metadata: { commit: "other-commit" } };
  const problems = verifyPlaywrightReport(report, {
    ...manifest,
    commit: "expected-commit",
  });
  assert.ok(
    problems.some((problem) => /does not belong to this tree/.test(problem)),
  );
});

test("Playwright gate binds the exact suite titles", () => {
  const report = fixtureReport();
  const digest = playwrightTitlesDigest(report);
  assert.deepEqual(
    verifyPlaywrightReport(report, { ...manifest, titlesSha256: digest }),
    [],
  );

  const renamed = fixtureReport();
  renamed.suites[0].specs[0].title = "renamed test";
  const problems = verifyPlaywrightReport(renamed, {
    ...manifest,
    titlesSha256: digest,
  });
  assert.ok(problems.some((problem) => /titles digest/.test(problem)));
});

test("Playwright gate rejects a stale report", () => {
  const report = fixtureReport();
  report.stats.startTime = new Date(
    Date.now() - 8 * 24 * 3600 * 1000,
  ).toISOString();
  const problems = verifyPlaywrightReport(report, manifest);
  assert.ok(problems.some((problem) => /stale/.test(problem)));
});

test("Playwright gate rejects retries that hide flakes", () => {
  const report = fixtureReport();
  report.suites[0].specs[0].tests[0].results.push({
    status: "passed",
    retry: 1,
  });
  const problems = verifyPlaywrightReport(report, manifest);
  assert.ok(problems.some((problem) => /retried/.test(problem)));
  assert.ok(problems.some((problem) => /retry index 1/.test(problem)));
});

test("Playwright gate rejects skipped suites", () => {
  const report = fixtureReport();
  report.suites[0].specs[0].tests[0].status = "skipped";
  report.suites[0].specs[0].tests[0].results = [
    { status: "skipped", retry: 0 },
  ];
  const problems = verifyPlaywrightReport(report, manifest);
  assert.ok(problems.some((problem) => /status is skipped/.test(problem)));
  assert.ok(
    problems.some((problem) => /result status is skipped/.test(problem)),
  );
});

test("Playwright gate rejects a missing or unlisted spec", () => {
  const report = fixtureReport();
  report.suites[0].specs[1].file = "extra.spec.ts";
  const problems = verifyPlaywrightReport(report, manifest);
  assert.ok(
    problems.some((problem) =>
      /did not run required spec layout/.test(problem),
    ),
  );
  assert.ok(problems.some((problem) => /unlisted spec extra/.test(problem)));
});

test("Playwright gate rejects count drift", () => {
  const report = fixtureReport();
  report.stats.expected = 3;
  report.suites[0].specs[1].tests.pop();
  const problems = verifyPlaywrightReport(report, manifest);
  assert.ok(
    problems.some((problem) => /ran 1 test\(s\), expected 2/.test(problem)),
  );
  assert.ok(problems.some((problem) => /expected count is 3/.test(problem)));
});
