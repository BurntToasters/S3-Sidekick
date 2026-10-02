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
const out = path.join(root, "test-results", "aws-null-runner-e2e");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-null-runner-"));
const checks = [];
let error = null;
try {
  fs.mkdirSync(out, { recursive: true });
  for (const scenario of [
    "pass",
    "cargo-timeout",
    "build-timeout",
    "malformed-checks",
    "no-checks",
  ]) {
    const checkout = path.join(scratch, scenario);
    const bin = path.join(checkout, "bin");
    const artifacts = path.join(out, scenario);
    const appDataLog = path.join(checkout, "appdata.txt");
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.mkdirSync(bin);
    fs.copyFileSync(
      path.join(root, "scripts", "e2e-aws-null-version.mjs"),
      path.join(checkout, "scripts", "e2e-aws-null-version.mjs"),
    );
    if (scenario !== "build-timeout") {
      fs.mkdirSync(path.join(checkout, "dist"));
      fs.writeFileSync(path.join(checkout, "dist", "index.html"), "fixture");
    }
    fs.writeFileSync(
      path.join(bin, "cargo"),
      `#!/usr/bin/env node
import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(appDataLog)},process.env.S3_SIDEKICK_TEST_APP_DATA);
if(${JSON.stringify(scenario)}==='cargo-timeout') { setTimeout(()=>process.exit(0),1000); }
else if(${JSON.stringify(scenario)}==='malformed-checks') fs.writeFileSync(process.env.S3_SIDEKICK_E2E_REPORT,'broken json\\n');
else if(${JSON.stringify(scenario)}!=='no-checks') fs.writeFileSync(process.env.S3_SIDEKICK_E2E_REPORT,JSON.stringify({passed:true,check:'fixture'})+'\\n');
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "npm"),
      "#!/usr/bin/env node\nsetTimeout(()=>process.exit(1),1000);\n",
      { mode: 0o755 },
    );
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [path.join(checkout, "scripts", "e2e-aws-null-version.mjs")],
      {
        cwd: checkout,
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          S3_SIDEKICK_E2E_ARTIFACT_DIR: artifacts,
          S3_SIDEKICK_AWS_NULL_TIMEOUT_MS: "150",
        },
      },
    );
    const reportPath = path.join(artifacts, "report.json");
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
      : null;
    const appData = fs.existsSync(appDataLog)
      ? fs.readFileSync(appDataLog, "utf8")
      : null;
    const timedOut = scenario.endsWith("timeout");
    const passed =
      !result.error &&
      !!report &&
      (scenario === "pass"
        ? result.status === 0 && report.passed
        : result.status !== 0 && !report.passed) &&
      (!timedOut || report.timedOut === true) &&
      (!appData || !fs.existsSync(appData));
    checks.push({
      name: scenario,
      passed,
      durationMs: Date.now() - started,
      exitCode: result.status,
      watchdogError: result.error?.message || null,
      appDataRemoved: !appData || !fs.existsSync(appData),
      report,
    });
    fs.writeFileSync(
      path.join(out, `${scenario}.log`),
      `${result.stdout || ""}${result.stderr || ""}`,
    );
    console.log(`${passed ? "PASS" : "FAIL"} ${scenario}`);
  }
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const passed =
    !error && checks.length === 5 && checks.every((check) => check.passed);
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        suite: "aws-null-runner-deadlines",
        passed,
        fixture:
          "copied production runner; fake build/Cargo subprocesses; disposable app data",
        error,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = passed ? 0 : 1;
}
