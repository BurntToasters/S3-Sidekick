#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { assertCleanSource } = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const SECRET_NAMES = new Set([
  "AFTER_PACK_LOC",
  "APPLE_ID",
  "APPLE_NOTARY_PROFILE",
  "APPLE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_DLIB_PATH",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  "AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_TENANT_ID",
  "BETA_CHANNEL_DIRECTORY",
  "BETA_CHANNEL_EXPECTED_SHA256",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GPG_KEY_ID",
  "GPG_PASSPHRASE",
  "SKIP_RELEASE_MIRROR",
  "SKIP_WIN_CODESIGN",
  "SSH_USER_PWD",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
]);

const BASE_OPERATIONAL_ALLOWLIST = Object.freeze([
  "APPDATA",
  "AR",
  "CARGO_HOME",
  "CC",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "CXX",
  "FORCE_COLOR",
  "HOME",
  "INCLUDE",
  "LANG",
  "LC_ALL",
  "LIB",
  "LIBPATH",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "NPM_CONFIG_CACHE",
  "OS",
  "PATH",
  "PATHEXT",
  "Path",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "RUSTUP_HOME",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "UniversalCRTSdkDir",
  "USERPROFILE",
  "UCRTVersion",
  "VCINSTALLDIR",
  "VCToolsInstallDir",
  "VSINSTALLDIR",
  "WINDIR",
  "WindowsSdkDir",
  "WindowsSDKVersion",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "npm_config_cache",
  "npm_config_user_agent",
  "npm_execpath",
  "npm_node_execpath",
]);

const MODE_ALLOWLISTS = Object.freeze({
  build: [],
  draft: [
    "GH_REPO_NAME",
    "GH_REPO_OWNER",
    "GPG_KEY_ID",
    "GPG_PASSPHRASE",
    "RELEASE_DRAFT_WAIT_POLL_MS",
    "RELEASE_DRAFT_WAIT_TIMEOUT_MS",
    "RELEASE_EXPECTED_TARGETS",
    "RELEASE_FLATPAK_INPUTS",
    "RELEASE_GPG_FINGERPRINT",
  ],
  gpg: [
    "AZURE_ARTIFACT_SIGNING_PUBLISHER",
    "ENFORCE_LINUX_X64_PACKAGE_SET",
    "GH_REPO_NAME",
    "GH_REPO_OWNER",
    "GPG_KEY_ID",
    "GPG_PASSPHRASE",
    "RELEASE_EXPECTED_TARGETS",
    "RELEASE_GPG_FINGERPRINT",
    "RELEASE_NOTES",
    "RELEASE_PUB_DATE",
    "REQUIRED_LINUX_TARGETS",
    "REQUIRE_LINUX_AARCH64",
  ],
  macos: ["APPLE_NOTARY_PROFILE", "APPLE_SIGNING_IDENTITY", "APPLE_TEAM_ID"],
  mirror: [
    "AFTER_PACK_LOC",
    "OVERRIDE_BETA_MIRROR_SKIP",
    "SKIP_RELEASE_MIRROR",
  ],
  publish: [
    "GH_REPO_NAME",
    "GH_REPO_OWNER",
    "GPG_KEY_ID",
    "GPG_PASSPHRASE",
    "RELEASE_GPG_FINGERPRINT",
  ],
  updater: [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
  ],
  windows: [
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_DLIB_PATH",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_PROFILE",
    "AZURE_ARTIFACT_SIGNING_PUBLISHER",
    "AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_TENANT_ID",
    "SKIP_WIN_CODESIGN",
  ],
  "windows-verify": ["AZURE_ARTIFACT_SIGNING_PUBLISHER", "SKIP_WIN_CODESIGN"],
});

const SOURCE_SENSITIVE_MODES = new Set(["build", "draft", "macos", "windows"]);

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
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

function readDotEnv(filePath = path.join(root, ".env")) {
  try {
    return parseDotEnv(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function environmentValue(environment, name) {
  if (Object.prototype.hasOwnProperty.call(environment, name)) {
    return { key: name, value: environment[name] };
  }
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? { key, value: environment[key] } : null;
}

function childEnvironment(
  mode,
  inherited = process.env,
  dotEnv = readDotEnv(),
) {
  const allowed = MODE_ALLOWLISTS[mode];
  if (!allowed) throw new Error(`Unknown release environment mode: ${mode}`);
  const child = {};
  const copiedKeys = new Set();
  for (const name of BASE_OPERATIONAL_ALLOWLIST) {
    const entry = environmentValue(inherited, name);
    if (
      entry &&
      entry.value !== undefined &&
      entry.value !== "" &&
      !copiedKeys.has(entry.key.toLowerCase())
    ) {
      child[entry.key] = entry.value;
      copiedKeys.add(entry.key.toLowerCase());
    }
  }
  for (const name of allowed) {
    const inheritedEntry = environmentValue(inherited, name);
    const value = inheritedEntry?.value ?? dotEnv[name];
    if (value !== undefined && value !== "") child[name] = value;
  }
  if (mode === "build" && process.platform === "darwin") {
    child.APPLE_SIGNING_IDENTITY = "-";
  }
  return child;
}

function runReleaseCommand({
  args = process.argv.slice(2),
  environment = process.env,
  execute = spawnSync,
  assertSource = assertCleanSource,
  workingDirectory = root,
} = {}) {
  const [mode, separator, ...command] = args;
  if (!mode || separator !== "--" || command.length === 0) {
    throw new Error(
      `Usage: node scripts/release-env.js <${Object.keys(MODE_ALLOWLISTS).join("|")}> -- <command> [args...]`,
    );
  }
  if (!MODE_ALLOWLISTS[mode]) {
    throw new Error(`Unknown release environment mode: ${mode}`);
  }

  const sourceCommit = SOURCE_SENSITIVE_MODES.has(mode)
    ? assertSource(workingDirectory, { environment })
    : null;
  let result;
  try {
    result = execute(command[0], command.slice(1), {
      cwd: workingDirectory,
      env: childEnvironment(mode, environment),
      stdio: "inherit",
      shell: false,
    });
  } finally {
    if (sourceCommit !== null) {
      assertSource(workingDirectory, {
        environment,
        expectedCommit: sourceCommit,
      });
    }
  }
  if (result?.error) throw result.error;
  return result?.status ?? 1;
}

function main() {
  return runReleaseCommand();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `release-env: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export {
  BASE_OPERATIONAL_ALLOWLIST,
  MODE_ALLOWLISTS,
  SECRET_NAMES,
  SOURCE_SENSITIVE_MODES,
  childEnvironment,
  parseDotEnv,
  runReleaseCommand,
};
