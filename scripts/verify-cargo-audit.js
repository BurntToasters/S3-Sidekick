#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_CARGO_AUDIT_VERSION = "0.22.2";

function verifyCargoAudit({ execute = spawnSync } = {}) {
  const result = execute("cargo", ["audit", "--version"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const output = String(result.stdout || "").trim();
  if (
    result.status !== 0 ||
    !new RegExp(
      `^cargo-audit(?:-audit)? ${EXPECTED_CARGO_AUDIT_VERSION.replaceAll(".", "\\.")}$`,
    ).test(output)
  ) {
    throw new Error(
      `cargo-audit ${EXPECTED_CARGO_AUDIT_VERSION} is required (found ${output || "none"}). Run npm run setup:cargo-audit.`,
    );
  }
  return true;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    verifyCargoAudit();
  } catch (error) {
    console.error(
      `verify-cargo-audit: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { EXPECTED_CARGO_AUDIT_VERSION, verifyCargoAudit };
