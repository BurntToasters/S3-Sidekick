import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === "1";
const envNames = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
];
const missing = skipWindowsCodeSigning
  ? []
  : envNames.filter((name) => !process.env[name]?.trim());
if (process.platform !== "win32")
  throw new Error("Signed Windows builds must run on Windows.");
if (missing.length)
  throw new Error(
    `Missing Artifact Signing environment variables: ${missing.join(", ")}`,
  );
if (skipWindowsCodeSigning)
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
};
const target = valueAfter("--target");
if (!target.includes("windows"))
  throw new Error("A Windows --target is required.");

const root = fileURLToPath(new URL("..", import.meta.url));
const targetReleaseDir = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
);
execFileSync("npx.cmd", ["tauri", "build", ...args], {
  stdio: "inherit",
  env: process.env,
});
if (!skipWindowsCodeSigning) {
  const signScript = fileURLToPath(
    new URL("./windows-artifact-sign.ps1", import.meta.url),
  );
  const runtimeExecutables = readdirSync(targetReleaseDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(targetReleaseDir, entry.name));
  if (!runtimeExecutables.length)
    throw new Error(
      `No final Windows runtime executables found under ${targetReleaseDir}`,
    );
  for (const executable of runtimeExecutables) {
    console.log(
      `[tauri-windows-build] Finalizing Authenticode signature: ${executable}`,
    );
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        signScript,
        "-FilePath",
        executable,
      ],
      { stdio: "inherit", env: process.env },
    );
  }
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(
        new URL("./verify-windows-authenticode.ps1", import.meta.url),
      ),
      "-TargetReleaseDir",
      targetReleaseDir,
    ],
    { stdio: "inherit", env: process.env },
  );
}
