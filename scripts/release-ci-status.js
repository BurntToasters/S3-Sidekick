#!/usr/bin/env node
// Require the aggregate CI "Release gate" job to be green for the exact HEAD
// commit before any release:continue step. The gate job depends on the native
// test matrix, browser Playwright suite, MinIO command-layer suite, and the
// full-stack WebDriver suite; see .github/workflows/ci.yml.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const require = createRequire(import.meta.url);
const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { expectedReleaseBranch } = require("./release-draft-target.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GATE_JOB = "Release gate";
const DEFAULT_WORKFLOW_PATH = ".github/workflows/ci.yml";
const DEFAULT_WORKFLOW_EVENT = "push";

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

function requiredReleaseBranch() {
  const version = String(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .version || "",
  );
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) {
    throw new Error(`Unsupported release version '${version}'.`);
  }
  return expectedReleaseBranch(/-beta\.\d+$/.test(version));
}

function workflowRunId(checkRun) {
  const match = String(checkRun?.details_url || "").match(
    /\/actions\/runs\/(\d+)(?:\/|$)/,
  );
  if (!match) {
    throw new Error(
      `CI gate run "${checkRun?.name || "unknown"}" has no Actions workflow run identity.`,
    );
  }
  return match[1];
}

function assertWorkflowIdentity(
  checkRun,
  workflowRun,
  {
    sha,
    branch,
    repository,
    workflowPath = DEFAULT_WORKFLOW_PATH,
    event = DEFAULT_WORKFLOW_EVENT,
  },
) {
  const expectedSha = String(sha || "").toLowerCase();
  if (checkRun?.app?.slug !== "github-actions") {
    throw new Error(
      `CI gate run "${checkRun?.name}" is not owned by the GitHub Actions app.`,
    );
  }
  if (!workflowRun || typeof workflowRun !== "object") {
    throw new Error("CI gate workflow identity is missing.");
  }
  if (workflowRun.path !== workflowPath) {
    throw new Error(
      `CI gate workflow is ${workflowRun.path}, not ${workflowPath}.`,
    );
  }
  if (workflowRun.event !== event) {
    throw new Error(
      `CI gate workflow event is ${workflowRun.event}, not ${event}.`,
    );
  }
  if (String(workflowRun.head_branch || "") !== branch) {
    throw new Error(
      `CI gate workflow branch is ${workflowRun.head_branch}, not ${branch}.`,
    );
  }
  if (String(workflowRun.head_sha || "").toLowerCase() !== expectedSha) {
    throw new Error(
      `CI gate workflow ran on ${workflowRun.head_sha}, not ${expectedSha}.`,
    );
  }
  if (
    String(workflowRun.repository?.full_name || "").toLowerCase() !==
    String(repository || "").toLowerCase()
  ) {
    throw new Error(
      `CI gate workflow repository is ${workflowRun.repository?.full_name}, not ${repository}.`,
    );
  }
  if (
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success"
  ) {
    throw new Error(
      `CI gate workflow for ${expectedSha} is ${workflowRun.status}/${workflowRun.conclusion || "unknown"}; release requires success.`,
    );
  }
  return workflowRun;
}

export function selectReleaseGateRun(
  runs,
  {
    sha,
    jobName = DEFAULT_GATE_JOB,
    branch,
    repository,
    workflowPath = DEFAULT_WORKFLOW_PATH,
    event = DEFAULT_WORKFLOW_EVENT,
    workflowRunFor,
  } = {},
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
  if (typeof workflowRunFor !== "function") {
    throw new Error(
      "CI gate verification requires the Actions workflow identity, not only the check-run name.",
    );
  }
  assertWorkflowIdentity(latest, workflowRunFor(latest), {
    sha: expectedSha,
    branch,
    repository,
    workflowPath,
    event,
  });
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
  const repository = `${owner}/${name}`;
  const jobName =
    String(environment.RELEASE_CI_GATE_JOB || "").trim() || DEFAULT_GATE_JOB;
  const branch = requiredReleaseBranch();
  const run = selectReleaseGateRun(listCheckRuns(commit, repository), {
    sha: commit,
    jobName,
    branch,
    repository,
    workflowRunFor: (checkRun) =>
      githubApi(
        "GET",
        `/repos/${repository}/actions/runs/${workflowRunId(checkRun)}`,
      ),
  });
  console.log(
    `release-ci-status: ok (${jobName} ${run.conclusion} for ${commit.slice(0, 12)} on ${branch})`,
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

export {
  DEFAULT_GATE_JOB,
  DEFAULT_WORKFLOW_PATH,
  assertWorkflowIdentity,
  currentCommit,
  requiredReleaseBranch,
  runReleaseCiStatus,
  workflowRunId,
};
