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

function removeBundleArguments(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bundles" || argument === "-b") {
      index += 1;
      while (index + 1 < args.length && !args[index + 1].startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--bundles=") || argument.startsWith("-b=")) {
      continue;
    }
    result.push(argument);
  }
  return result;
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

function windowsBuildCommands(args, { signBundle = false } = {}) {
  const withoutSigningFlag = args.filter(
    (argument) => argument !== "--no-sign",
  );
  const cargoSeparator = withoutSigningFlag.indexOf("--");
  const tauriArguments =
    cargoSeparator >= 0
      ? withoutSigningFlag.slice(0, cargoSeparator)
      : withoutSigningFlag;
  // The bundle step must run with signing enabled (no --no-sign) so the
  // merged signCommand signs the NSIS uninstaller via !uninstfinalize.
  // Compile stays --no-sign: the runtime is signed manually pre-bundle. The
  // bundler patches each staged runtime with its package-type marker and
  // re-signs it before embedding, then restores the pre-bundle binary on
  // disk; verify-windows-authenticode.ps1 normalizes those expected regions
  // so the embedded payload can still be compared to the pre-bundle runtime.
  const bundleCommand = [tauriCli, "bundle", ...tauriArguments];
  if (!signBundle) bundleCommand.push("--no-sign");
  // Tauri signs updater artifacts during bundling whenever
  // createUpdaterArtifacts is enabled, which requires the updater private key
  // — intentionally absent from the bundle environment. Updater signing is a
  // separate release phase (scripts/updater-sign.js), so suppress artifact
  // generation here while keeping bundle code signing (signCommand) enabled
  // for the embedded NSIS uninstaller.
  bundleCommand.push("--config", JSON.stringify(bundleConfig()));
  return {
    bundle: bundleCommand,
    compile: [
      tauriCli,
      "build",
      ...removeBundleArguments(tauriArguments),
      "--no-bundle",
      "--no-sign",
      "--",
      "--locked",
    ],
  };
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

function powershellArguments(script, filePath) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-FilePath",
    filePath,
  ];
}

function runWindowsBuild({
  args = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  execute = execFileSync,
  fileExists = fs.existsSync,
  findInstallers = collectWindowsInstallers,
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
    const commands = windowsBuildCommands(args, {
      signBundle: !skipWindowsCodeSigning,
    });
    const buildEnvironment = environment;
    execute(process.execPath, commands.compile, {
      stdio: "inherit",
      env: buildEnvironment,
    });
    if (!fileExists(runtimePath)) {
      throw new Error(`Final Windows runtime was not produced: ${runtimePath}`);
    }

    const signingEnvironment = environment;
    if (!skipWindowsCodeSigning) {
      console.log(
        `[tauri-windows-build] Signing runtime before bundling: ${runtimePath}`,
      );
      execute("powershell.exe", powershellArguments(signScript, runtimePath), {
        stdio: "inherit",
        env: signingEnvironment,
      });
    }

    execute(process.execPath, commands.bundle, {
      stdio: "inherit",
      env: buildEnvironment,
    });
    const installers = findInstallers(path.join(targetReleaseDir, "bundle"));
    if (installers.length === 0) {
      throw new Error(
        `No final Windows installer was produced under ${targetReleaseDir}`,
      );
    }

    if (!skipWindowsCodeSigning) {
      for (const installer of installers) {
        console.log(
          `[tauri-windows-build] Signing final installer: ${installer}`,
        );
        execute("powershell.exe", powershellArguments(signScript, installer), {
          stdio: "inherit",
          env: signingEnvironment,
        });
      }
      execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          verifyScript,
          "-ExpectedRuntimePath",
          runtimePath,
          "-InstallerPathsJson",
          JSON.stringify(installers),
        ],
        {
          stdio: "inherit",
          env: environment,
        },
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
  msiVersionForAppVersion,
  removeBundleArguments,
  runWindowsBuild,
  windowsBuildCommands,
};
