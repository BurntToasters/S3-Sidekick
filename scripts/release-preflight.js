#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

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

function runReleasePreflight({ rootDirectory = root } = {}) {
  const version = String(
    JSON.parse(
      fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"),
    ).version ?? "",
  );
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

export { expectedReleaseBranch, runReleasePreflight };
