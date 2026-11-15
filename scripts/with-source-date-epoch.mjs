#!/usr/bin/env node
// Run a release command with SOURCE_DATE_EPOCH pinned to the commit time.
//
// Two builds of one commit must embed the same timestamps for a byte-for-byte
// rebuild comparison to mean anything (H16). An explicit environment value
// wins so CI or a host can pin a different epoch deliberately.
import { execFileSync, spawnSync } from "node:child_process";
import { isDirectExecution } from "./direct-execution.js";

export function sourceDateEpoch({
  environment = process.env,
  git = execFileSync,
} = {}) {
  const configured = String(environment.SOURCE_DATE_EPOCH ?? "").trim();
  if (/^\d+$/.test(configured)) return configured;
  const seconds = git("git", ["log", "-1", "--format=%ct"], {
    encoding: "utf8",
  }).trim();
  if (!/^\d+$/.test(seconds)) {
    throw new Error(
      "Could not resolve the release commit timestamp for SOURCE_DATE_EPOCH.",
    );
  }
  return seconds;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: with-source-date-epoch.mjs <command> [args...]");
    process.exit(1);
  }
  const epoch = sourceDateEpoch();
  console.log(
    `[reproducible] SOURCE_DATE_EPOCH=${epoch} ${command} ${args.join(" ")}`,
  );
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

if (isDirectExecution(import.meta.url)) {
  main();
}
