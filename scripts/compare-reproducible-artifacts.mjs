#!/usr/bin/env node
// Prove a rebuild is byte-identical to the published artifacts.
//
// Usage: node scripts/compare-reproducible-artifacts.mjs <published-dir> <rebuilt-dir>
// Compares every file's SHA-256 by relative path and exits non-zero on any
// difference, missing file, or extra file. Ignore local signing sidecars.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectExecution } from "./direct-execution.js";

export function hashArtifacts(root) {
  const hashes = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full);
        const digest = crypto
          .createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
        hashes.set(relative, digest);
      }
    }
  };
  walk(root);
  return hashes;
}

export function compareArtifacts(published, rebuilt) {
  const left = hashArtifacts(published);
  const right = hashArtifacts(rebuilt);
  const problems = [];
  for (const [relative, digest] of left) {
    if (!right.has(relative)) {
      problems.push(`missing from rebuild: ${relative}`);
    } else if (right.get(relative) !== digest) {
      problems.push(
        `bytes differ: ${relative} (published ${digest.slice(0, 16)}…, rebuilt ${right.get(relative).slice(0, 16)}…)`,
      );
    }
  }
  for (const relative of right.keys()) {
    if (!left.has(relative))
      problems.push(`unexpected in rebuild: ${relative}`);
  }
  return problems;
}

if (isDirectExecution(import.meta.url)) {
  const [published, rebuilt] = process.argv.slice(2);
  if (!published || !rebuilt) {
    console.error(
      "usage: compare-reproducible-artifacts.mjs <published-dir> <rebuilt-dir>",
    );
    process.exit(1);
  }
  const problems = compareArtifacts(published, rebuilt);
  if (problems.length > 0) {
    console.error("Reproducible rebuild check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `Reproducible rebuild check: ok (${hashArtifacts(published).size} artifacts byte-identical).`,
  );
}
