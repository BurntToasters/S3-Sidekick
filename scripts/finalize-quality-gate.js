#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockingReleaseWorkingTreePaths,
  qualityGateEvidenceProblems,
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
    evidenceProblems: qualityGateEvidenceProblems(root).problems,
  };
}

function main() {
  const result = finalizeQualityGate();
  if (result.ok) {
    console.log("Release quality-gate proof recorded for this checkout.");
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
  if (result.evidenceProblems.length > 0) {
    console.error("Missing or stale quality-gate evidence:");
    for (const problem of result.evidenceProblems) {
      console.error(`  - ${problem}`);
    }
  }
  console.error(
    "Commit or remove changes, then run test:all so proof binds this exact commit and the report hashes.",
  );
  process.exit(1);
}

if (isDirectExecution(import.meta.url)) {
  main();
}
