#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const { assertStableReleaseOverridesAllowed } = createRequire(import.meta.url)(
  "./release-policy.cjs",
);
const { githubApi } = createRequire(import.meta.url)("./github-cli.cjs");

const root = fileURLToPath(new URL("..", import.meta.url));

function expectedReleaseBranch(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  if (
    new RegExp(`^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`).test(
      version,
    )
  ) {
    return "beta";
  }
  if (new RegExp(`^${numeric}\\.${numeric}\\.${numeric}$`).test(version)) {
    return "main";
  }
  throw new Error(
    `Unsupported release version '${version}'; S3-Sidekick releases use beta or stable versions only.`,
  );
}

function git(args, rootDirectory = root) {
  return execFileSync("git", args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function releaseRepository(environment = process.env) {
  return {
    owner: environment.GH_REPO_OWNER || "BurntToasters",
    repository: environment.GH_REPO_NAME || "S3-Sidekick",
  };
}

/**
 * Require the full CI workflow to have passed for the exact release commit.
 *
 * The local quality gate cannot reproduce the Ubuntu MinIO, full-stack, and
 * Playwright jobs. A release must therefore prove that the same SHA already
 * passed the complete workflow before any signing host builds artifacts.
 */
function assertCiGreen(
  { owner, repository, head },
  api = githubApi,
) {
  const endpoint =
    `/repos/${owner}/${repository}/actions/runs` +
    `?head_sha=${encodeURIComponent(head)}&per_page=100`;
  const response = api("GET", endpoint);
  const runs = Array.isArray(response?.workflow_runs)
    ? response.workflow_runs
    : [];
  const matching = runs
    .filter((run) => run?.name === "CI" && run?.head_sha === head)
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
  if (matching.length === 0) {
    throw new Error(
      `No CI workflow run found for ${head.slice(0, 12)}. Push the release commit and wait for the full CI workflow to pass.`,
    );
  }

  const run = matching[0];
  const url = run.html_url ? ` (${run.html_url})` : "";
  if (run.status !== "completed") {
    throw new Error(
      `CI workflow for ${head.slice(0, 12)} is ${run.status || "not completed"}${url}. Wait for the full CI workflow to pass.`,
    );
  }
  if (run.conclusion !== "success") {
    throw new Error(
      `CI workflow for ${head.slice(0, 12)} concluded ${run.conclusion || "unknown"}${url}. Fix CI before releasing.`,
    );
  }
  console.log(
    `release-preflight: CI green for ${head.slice(0, 12)} (${owner}/${repository})`,
  );
}

function assertReleaseOrigin(rootDirectory) {
  const owner = process.env.GH_REPO_OWNER || "BurntToasters";
  const repository = process.env.GH_REPO_NAME || "S3-Sidekick";
  const expected = `${owner}/${repository}`.toLowerCase();
  const origins = git(
    ["remote", "get-url", "--all", "origin"],
    rootDirectory,
  ).split(/\r?\n/);
  for (const origin of origins) {
    const match = origin.match(
      /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\s?#]+)$/i,
    );
    if (
      !match ||
      match[1]
        .replace(/\.git$/i, "")
        .replace(/\/$/, "")
        .toLowerCase() !== expected
    ) {
      throw new Error(
        `Release origin must be github.com/${owner}/${repository}; current origin is ${origin}.`,
      );
    }
  }
}

function runReleasePreflight({ rootDirectory = root } = {}) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"),
  );
  const version = String(packageJson.version ?? "");
  assertStableReleaseOverridesAllowed(process.env, version);
  const expectedBranch = expectedReleaseBranch(version);
  const branch = git(["branch", "--show-current"], rootDirectory);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
    );
  }

  const dirty = git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    rootDirectory,
  );
  if (dirty) {
    throw new Error(
      `Working tree is not clean. Commit and push the exact release source first:\n${dirty}`,
    );
  }

  assertReleaseOrigin(rootDirectory);
  git(["fetch", "--quiet", "origin"], rootDirectory);
  const upstream = git(
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    rootDirectory,
  );
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
    );
  }

  const head = git(["rev-parse", "HEAD"], rootDirectory);
  const upstreamHead = git(["rev-parse", "@{upstream}"], rootDirectory);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
    );
  }
  assertCiGreen({ ...releaseRepository(), head });
  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`,
  );
}

if (isDirectExecution(import.meta.url)) {
  try {
    runReleasePreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { assertCiGreen, expectedReleaseBranch, runReleasePreflight };
