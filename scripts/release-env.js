#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commandRequiresShell } from "./npm-safe-update.mjs";
import { isDirectExecution } from "./direct-execution.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const MODES = Object.freeze([
  "build",
  "draft",
  "gpg",
  "macos",
  "mirror",
  "publish",
  "updater",
  "windows",
  "windows-verify",
]);

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    values[key] = value;
  }
  return values;
}

export function readDotEnv(filePath = path.join(root, ".env")) {
  try {
    return parseDotEnv(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function childEnvironment(
  _mode,
  inherited = process.env,
  dotEnv = readDotEnv(),
) {
  const environment = { ...dotEnv, ...inherited };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  return environment;
}

export function runReleaseCommand({
  args = process.argv.slice(2),
  environment = process.env,
  execute = spawnSync,
  workingDirectory = root,
} = {}) {
  const [mode, separator, ...command] = args;
  if (!mode || separator !== "--" || command.length === 0) {
    throw new Error(
      `Usage: node scripts/release-env.js <${MODES.join("|")}> -- <command> [args...]`,
    );
  }
  if (!MODES.includes(mode))
    throw new Error(`Unknown release environment mode: ${mode}`);
  const result = execute(command[0], command.slice(1), {
    cwd: workingDirectory,
    env: childEnvironment(mode, environment),
    shell: commandRequiresShell(command[0]),
    stdio: "inherit",
  });
  if (result?.error) throw result.error;
  return result?.status ?? 1;
}

if (isDirectExecution(import.meta.url)) {
  try {
    process.exitCode = runReleaseCommand();
  } catch (error) {
    console.error(
      `release-env: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
