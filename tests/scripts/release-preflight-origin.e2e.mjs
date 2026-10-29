#!/usr/bin/env node
// Failure inventory: release-safety-failure-modes.md, written before product changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const out = path.join(root, "test-results", "release-preflight-origin-e2e");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-origin-"));
const bin = path.join(scratch, "bin");
const checks = [];
let error = null;
try {
  fs.mkdirSync(bin);
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(root, "scripts"), path.join(scratch, "scripts"), {
    recursive: true,
  });
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify(pkg));
  const calls = path.join(scratch, "calls.jsonl");
  const ghCalls = path.join(scratch, "gh-calls.jsonl");
  const head = "a".repeat(40);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='remote') console.log(process.env.FIXTURE_ORIGIN);
else if(args[0]==='branch') console.log(process.env.FIXTURE_BRANCH);
else if(args.includes('--abbrev-ref')) console.log('origin/' + process.env.FIXTURE_BRANCH);
else if(args[0]==='rev-parse') console.log(${JSON.stringify(head)});
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ghCalls)}, JSON.stringify(args)+'\\n');
if(args[0] !== 'api') { console.error('unexpected gh command'); process.exit(1); }
const mode = process.env.FIXTURE_CI_MODE || 'green';
const run = (conclusion, status, sha) => ({ id: 1, name: 'CI', head_sha: sha, status, conclusion, html_url: 'https://example.invalid/run/1' });
const runs = mode === 'missing' ? [] : [run(
  mode === 'failed' ? 'failure' : mode === 'running' ? null : 'success',
  mode === 'running' ? 'in_progress' : 'completed',
  mode === 'wrong-sha' ? 'b'.repeat(40) : ${JSON.stringify(head)},
)];
process.stdout.write(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
`,
    { mode: 0o755 },
  );
  const cases = [
    { name: "https", origin: "https://github.com/BurntToasters/S3-Sidekick.git", pass: true },
    { name: "ssh", origin: "git@github.com:BurntToasters/S3-Sidekick.git", pass: true },
    { name: "ssh-url", origin: "ssh://git@github.com/BurntToasters/S3-Sidekick.git", pass: true },
    {
      name: "npm-version-change",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: true,
      overrides: { npm_config_user_agent: "npm/12.1.1 node/v24.19.0" },
    },
    {
      name: "no-toolchain-metadata",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: true,
      omitToolchain: true,
    },
    {
      name: "ci-green",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: true,
      ciMode: "green",
    },
    {
      name: "ci-missing",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: false,
      ciMode: "missing",
      rejectBeforeFetch: false,
    },
    {
      name: "ci-failed",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: false,
      ciMode: "failed",
      rejectBeforeFetch: false,
    },
    {
      name: "ci-running",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: false,
      ciMode: "running",
      rejectBeforeFetch: false,
    },
    {
      name: "ci-wrong-sha",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: false,
      ciMode: "wrong-sha",
      rejectBeforeFetch: false,
    },
    {
      name: "fork",
      origin: "https://github.com/another-owner/S3-Sidekick.git",
      pass: false,
      rejectBeforeFetch: true,
    },
    {
      name: "other-host",
      origin: "https://example.invalid/BurntToasters/S3-Sidekick.git",
      pass: false,
      rejectBeforeFetch: true,
    },
    {
      name: "stable-target-override",
      origin: "https://github.com/BurntToasters/S3-Sidekick.git",
      pass: false,
      version: "0.12.0",
      overrides: { GH_REPO_OWNER: "another-owner" },
      rejectBeforeFetch: true,
    },
  ];

  for (const testCase of cases) {
    const fixturePkg = { ...pkg };
    if (testCase.version) fixturePkg.version = testCase.version;
    if (testCase.omitToolchain) delete fixturePkg.releaseToolchain;
    fs.writeFileSync(
      path.join(scratch, "package.json"),
      JSON.stringify(fixturePkg),
    );
    fs.writeFileSync(calls, "");
    fs.writeFileSync(ghCalls, "");
    const result = spawnSync(
      process.execPath,
      [path.join(scratch, "scripts", "release-preflight.js")],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          npm_config_user_agent: `npm/${pkg.packageManager.split("@")[1]}`,
          FIXTURE_ORIGIN: testCase.origin,
          FIXTURE_BRANCH: String(fixturePkg.version).includes("-beta.")
            ? "beta"
            : "main",
          FIXTURE_CI_MODE: testCase.ciMode || "green",
          GH_REPO_OWNER: "BurntToasters",
          GH_REPO_NAME: "S3-Sidekick",
          ...testCase.overrides,
        },
      },
    );
    const log = `${result.stdout || ""}${result.stderr || ""}`;
    const gitCalls = fs
      .readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const ciCalls = fs
      .readFileSync(ghCalls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const fetched = gitCalls.some((args) => args[0] === "fetch");
    const rejectedBeforeFetch = !fetched;
    const passed =
      !result.error &&
      (testCase.pass
        ? result.status === 0
        : result.status !== 0 &&
          (testCase.rejectBeforeFetch ? rejectedBeforeFetch : fetched));
    checks.push({
      name: testCase.name,
      passed,
      exitCode: result.status,
      rejectedBeforeFetch,
      gitCalls,
      ciCalls,
      log,
    });
    console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}`);
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const passed =
    !error && checks.length >= 13 && checks.every((check) => check.passed);
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        suite: "release-origin-preflight",
        passed,
        fixture:
          "production preflight in disposable checkout with fake Git; no real fetch or remote changes",
        error,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = passed ? 0 : 1;
}
