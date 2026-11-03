#!/usr/bin/env node
// Require the aggregate CI "Release gate" job to be green for the exact HEAD
// commit before any release:continue step. The gate job depends on the native
// test matrix, browser Playwright suite, MinIO command-layer suite, and the
// full-stack WebDriver suite; see .github/workflows/ci.yml.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const require = createRequire(import.meta.url);
const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GATE_JOB = "Release gate";

function currentCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit.toLowerCase();
}

export function selectReleaseGateRun(
  runs,
  { sha, jobName = DEFAULT_GATE_JOB } = {},
) {
  const expectedSha = String(sha || "").toLowerCase();
  const matching = (Array.isArray(runs) ? runs : []).filter(
    (run) =>
      run?.name === jobName &&
      String(run.head_sha || "").toLowerCase() === expectedSha,
  );
  if (matching.length === 0) {
    throw new Error(
      `CI gate job "${jobName}" has no run for ${expectedSha}. Push the commit and wait for CI.`,
    );
  }
  matching.sort((left, right) => {
    const leftTime = Date.parse(left.completed_at || left.started_at || 0);
    const rightTime = Date.parse(right.completed_at || right.started_at || 0);
    return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
  });
  const latest = matching[0];
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(
      `CI gate job "${jobName}" for ${expectedSha} is ${latest.status}/${latest.conclusion || "unknown"}; release requires success.`,
    );
  }
  return latest;
}

function listCheckRuns(commit, repository) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${repository}/commits/${commit}/check-runs?filter=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch?.check_runs) || batch.check_runs.length === 0) {
      break;
    }
    runs.push(...batch.check_runs);
    if (batch.check_runs.length < 100) break;
  }
  return runs;
}

function runReleaseCiStatus({
  commit = currentCommit(),
  environment = process.env,
} = {}) {
  assertGitHubCliAuthenticated();
  const owner = environment.GH_REPO_OWNER || "BurntToasters";
  const name = environment.GH_REPO_NAME || "S3-Sidekick";
  const jobName =
    String(environment.RELEASE_CI_GATE_JOB || "").trim() || DEFAULT_GATE_JOB;
  const run = selectReleaseGateRun(listCheckRuns(commit, `${owner}/${name}`), {
    sha: commit,
    jobName,
  });
  console.log(
    `release-ci-status: ok (${jobName} ${run.conclusion} for ${commit.slice(0, 12)})`,
  );
  return run;
}

if (isDirectExecution(import.meta.url)) {
  try {
    runReleaseCiStatus();
  } catch (error) {
    console.error(
      `release-ci-status: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { DEFAULT_GATE_JOB, currentCommit, runReleaseCiStatus };
