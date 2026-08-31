#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { childEnvironment } from "./release-env.js";

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
]);

const root = fileURLToPath(new URL("..", import.meta.url));
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

function windowsBuildCommands(args) {
  const withoutSigningFlag = args.filter(
    (argument) => argument !== "--no-sign",
  );
  const cargoSeparator = withoutSigningFlag.indexOf("--");
  const tauriArguments =
    cargoSeparator >= 0
      ? withoutSigningFlag.slice(0, cargoSeparator)
      : withoutSigningFlag;
  return {
    bundle: [tauriCli, "bundle", ...tauriArguments, "--no-sign"],
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
    const commands = windowsBuildCommands(args);
    const buildEnvironment = childEnvironment("build", environment, {});
    execute(process.execPath, commands.compile, {
      stdio: "inherit",
      env: buildEnvironment,
    });
    if (!fileExists(runtimePath)) {
      throw new Error(`Final Windows runtime was not produced: ${runtimePath}`);
    }

    const signingEnvironment = childEnvironment("windows", environment, {});
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
          env: childEnvironment("windows-verify", environment, {}),
        },
      );
    }
    return { installers, runtimePath, targetReleaseDir };
  } finally {
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
  collectWindowsInstallers,
  removeBundleArguments,
  runWindowsBuild,
  windowsBuildCommands,
};
