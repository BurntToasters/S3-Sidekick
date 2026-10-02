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
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='remote') console.log(process.env.FIXTURE_ORIGIN);
else if(args[0]==='branch') console.log('main');
else if(args.includes('--abbrev-ref')) console.log('origin/main');
else if(args[0]==='rev-parse') console.log('a'.repeat(40));
`,
    { mode: 0o755 },
  );
  for (const [name, origin, pass, overrides] of [
    ["https", "https://github.com/BurntToasters/S3-Sidekick.git", true, {}],
    ["ssh", "git@github.com:BurntToasters/S3-Sidekick.git", true, {}],
    ["ssh-url", "ssh://git@github.com/BurntToasters/S3-Sidekick.git", true, {}],
    ["fork", "https://github.com/another-owner/S3-Sidekick.git", false, {}],
    [
      "other-host",
      "https://example.invalid/BurntToasters/S3-Sidekick.git",
      false,
      {},
    ],
    [
      "stable-target-override",
      "https://github.com/BurntToasters/S3-Sidekick.git",
      false,
      { GH_REPO_OWNER: "another-owner" },
    ],
  ]) {
    fs.writeFileSync(calls, "");
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
          npm_config_user_agent: `npm/${pkg.releaseToolchain.npm}`,
          FIXTURE_ORIGIN: origin,
          GH_REPO_OWNER: "BurntToasters",
          GH_REPO_NAME: "S3-Sidekick",
          ...overrides,
        },
      },
    );
    const log = `${result.stdout || ""}${result.stderr || ""}`;
    const gitCalls = fs
      .readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const rejectedBeforeFetch = !gitCalls.some((args) => args[0] === "fetch");
    const passed =
      !result.error &&
      (pass ? result.status === 0 : result.status !== 0 && rejectedBeforeFetch);
    checks.push({
      name,
      passed,
      exitCode: result.status,
      rejectedBeforeFetch,
      gitCalls,
      log,
    });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const passed =
    !error && checks.length === 6 && checks.every((check) => check.passed);
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
