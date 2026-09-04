#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockingReleaseWorkingTreePaths,
  recordSuccessfulQualityGate,
} from "./release-session.js";
import { isDirectExecution } from "./direct-execution.js";

export function finalizeQualityGate(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  if (recordSuccessfulQualityGate(root)) {
    return { ok: true };
  }

  return {
    ok: false,
    blockers: blockingReleaseWorkingTreePaths(root),
  };
}

function main() {
  const result = finalizeQualityGate();
  if (result.ok) {
    console.log("Release quality-gate proof recorded for this clean commit.");
    return;
  }

  console.error(
    "Release quality-gate proof was not recorded because the working tree is dirty.",
  );
  if (result.blockers.length > 0) {
    console.error("Blocking paths:");
    for (const p of result.blockers) {
      console.error(`  - ${p}`);
    }
  }
  console.error(
    "Commit or remove changes before running test:all; release bootstrap must be idempotent on this checkout.",
  );
  process.exit(1);
}

if (isDirectExecution(import.meta.url)) {
  main();
}
