#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { canonicalJson, parseFlatpakInputs } = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(root, "run.rosie.s3-sidekick.yml");
const architectures = Object.freeze({ arm64: "aarch64", x64: "x86_64" });

function resolveFlatpakInputs({
  execute = spawnSync,
  manifest = fs.readFileSync(manifestPath, "utf8"),
} = {}) {
  const refs = parseFlatpakInputs(manifest).refs;
  const result = {};
  for (const [descriptorArch, flatpakArch] of Object.entries(architectures)) {
    result[descriptorArch] = refs
      .map((ref) => {
        const command = execute(
          "flatpak",
          [
            "remote-info",
            `--arch=${flatpakArch}`,
            "--show-commit",
            "flathub",
            ref,
          ],
          { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (command.error) throw command.error;
        const commit = String(command.stdout || "").trim().toLowerCase();
        if (command.status !== 0 || !/^[a-f0-9]{64}$/.test(commit)) {
          throw new Error(
            `Could not resolve exact Flathub commit for ${ref} (${flatpakArch}): ${String(command.stderr || command.stdout || "unknown error").trim()}`,
          );
        }
        return { commit, ref };
      })
      .sort((left, right) => left.ref.localeCompare(right.ref));
  }
  return result;
}

function main(args = process.argv.slice(2)) {
  const inputs = resolveFlatpakInputs();
  if (args.length > 1 || (args.length === 1 && args[0] !== "--env")) {
    throw new Error("Usage: node scripts/resolve-flatpak-inputs.js [--env]");
  }
  if (args[0] === "--env") {
    process.stdout.write(`RELEASE_FLATPAK_INPUTS=${JSON.stringify(inputs)}\n`);
  } else {
    process.stdout.write(canonicalJson(inputs));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `resolve-flatpak-inputs: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { resolveFlatpakInputs };
