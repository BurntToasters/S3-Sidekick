#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const require = createRequire(import.meta.url);
const { assertCleanSource } = require("./release-integrity.cjs");
const REQUIRED_SIGNING_ENV = Object.freeze([
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN",
]);

const root = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const signScript = fileURLToPath(
  new URL("./windows-artifact-sign.ps1", import.meta.url),
);
const verifyScript = fileURLToPath(
  new URL("./verify-windows-authenticode.ps1", import.meta.url),
);

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
}

function msiVersionForAppVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/);
  if (!match) return null;

  const [major, minor, patch, beta] = match.slice(1).map(Number);
  if (major > 255 || minor > 255 || patch > 65535 || beta > 65535) {
    throw new Error(
      `MSI version components must fit WiX limits (major/minor <= 255; patch/beta <= 65535): ${version}`,
    );
  }
  return `${major}.${minor}.${patch}.${beta}`;
}

function bundleConfig(version = packageVersion) {
  const config = {
    bundle: {
      createUpdaterArtifacts: false,
    },
  };
  const msiVersion = msiVersionForAppVersion(version);
  if (msiVersion) {
    config.bundle.windows = {
      wix: {
        version: msiVersion,
      },
    };
  }
  return config;
}

function windowsBuildCommand(args) {
  const cargoSeparator = args.indexOf("--");
  const tauriArguments =
    cargoSeparator >= 0 ? args.slice(0, cargoSeparator) : args;
  // Same shape as Zinnia: one `tauri build` so compile, bundle-type patching,
  // signCommand (NSIS !uninstfinalize), and installer signing happen together.
  // createUpdaterArtifacts stays off here; updater signing is a later phase
  // (scripts/updater-sign.js) and must not require the updater key at bundle time.
  return [
    tauriCli,
    "build",
    ...tauriArguments,
    "--config",
    JSON.stringify(bundleConfig()),
    "--",
    "--locked",
  ];
}

function collectWindowsInstallers(bundleDirectory) {
  if (!fs.existsSync(bundleDirectory)) return [];
  const results = [];
  const stack = [bundleDirectory];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && /\.(?:exe|msi)$/i.test(entry.name)) {
        results.push(filePath);
      }
    }
  }
  return results.sort();
}

function listReleaseExecutables(releaseDir) {
  if (!fs.existsSync(releaseDir)) return [];
  return fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(releaseDir, entry.name));
}

function powershellArguments(script, extraArgs) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...extraArgs,
  ];
}

function runWindowsBuild({
  args = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  execute = execFileSync,
  fileExists = fs.existsSync,
  findInstallers = collectWindowsInstallers,
  listRuntimes = listReleaseExecutables,
  assertSource = assertCleanSource,
} = {}) {
  const skipWindowsCodeSigning = environment.SKIP_WIN_CODESIGN?.trim() === "1";
  if (platform !== "win32") {
    throw new Error("Signed Windows builds must run on Windows.");
  }
  const target = valueAfter(args, "--target");
  if (!target.includes("windows")) {
    throw new Error("A Windows --target is required.");
  }
  const missing = skipWindowsCodeSigning
    ? []
    : REQUIRED_SIGNING_ENV.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing Artifact Signing environment variables: ${missing.join(", ")}`,
    );
  }
  if (skipWindowsCodeSigning) {
    console.warn(
      "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
    );
  }

  const sourceCommit = assertSource(root, { environment });
  try {
    const targetReleaseDir = path.join(
      root,
      "src-tauri",
      "target",
      target,
      "release",
    );
    const runtimePath = path.join(targetReleaseDir, "s3-sidekick.exe");
    execute(process.execPath, windowsBuildCommand(args), {
      stdio: "inherit",
      env: environment,
    });
    if (!fileExists(runtimePath)) {
      throw new Error(`Final Windows runtime was not produced: ${runtimePath}`);
    }
    const installers = findInstallers(path.join(targetReleaseDir, "bundle"));
    if (installers.length === 0) {
      throw new Error(
        `No final Windows installer was produced under ${targetReleaseDir}`,
      );
    }

    if (!skipWindowsCodeSigning) {
      const runtimeExecutables = listRuntimes(targetReleaseDir);
      if (runtimeExecutables.length === 0) {
        throw new Error(
          `No final Windows runtime executables found under ${targetReleaseDir}`,
        );
      }
      for (const executable of runtimeExecutables) {
        console.log(
          `[tauri-windows-build] Finalizing Authenticode signature: ${executable}`,
        );
        execute(
          "powershell.exe",
          powershellArguments(signScript, ["-FilePath", executable]),
          { stdio: "inherit", env: environment },
        );
      }
      execute(
        "powershell.exe",
        powershellArguments(verifyScript, [
          "-TargetReleaseDir",
          targetReleaseDir,
        ]),
        { stdio: "inherit", env: environment },
      );
    }
    return { installers, runtimePath, targetReleaseDir };
  } finally {
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    runWindowsBuild();
  } catch (error) {
    console.error(
      `tauri-windows-build: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  REQUIRED_SIGNING_ENV,
  bundleConfig,
  collectWindowsInstallers,
  listReleaseExecutables,
  msiVersionForAppVersion,
  runWindowsBuild,
  windowsBuildCommand,
};
