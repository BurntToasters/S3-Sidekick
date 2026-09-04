#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const require = createRequire(import.meta.url);
const {
  assertCleanSource,
  assertReleaseToolVersions,
} = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const steps = Object.freeze([
  "workspace:prepare",
  "release:supply-chain",
  "dist:clean-release-artifacts",
  "release:session:start",
]);

function runReleasePreparation({
  environment = process.env,
  execute = execFileSync,
  assertSource = assertCleanSource,
  assertToolVersions = assertReleaseToolVersions,
  rootDirectory = root,
} = {}) {
  const sourceCommit = assertSource(rootDirectory, { environment });
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"),
  );
  assertToolVersions(packageJson, { environment, root: rootDirectory });
  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath || !path.isAbsolute(npmExecPath)) {
    throw new Error(
      "release:prepare must be launched by the pinned npm CLI so npm_execpath is available.",
    );
  }
  for (const step of steps) {
    try {
      execute(process.execPath, [npmExecPath, "run", step], {
        cwd: rootDirectory,
        env: environment,
        stdio: "inherit",
      });
    } finally {
      assertSource(rootDirectory, {
        environment,
        expectedCommit: sourceCommit,
      });
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    runReleasePreparation();
  } catch (error) {
    console.error(
      `release-prepare: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { runReleasePreparation, steps };
