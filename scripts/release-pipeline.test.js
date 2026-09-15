import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseReleaseArgs } from "./run-release.js";
import {
  requiredDraftAssetNames,
  requiredDraftInstallerNames,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import {
  assertStableReleaseOverridesAllowed,
  isStableReleaseVersion,
} from "./release-policy.cjs";
import {
  assertExpectedRelease,
  isExpectedRelease,
} from "./release-draft-metadata.cjs";
import {
  bundleConfig,
  msiVersionForAppVersion,
  runWindowsBuild,
  windowsBuildCommand,
} from "./tauri-windows-build.js";

test("run-release accepts only canonical host commands", () => {
  assert.equal(
    parseReleaseArgs(["win"]).continueScript,
    "release:win:continue",
  );
  assert.equal(
    parseReleaseArgs(["linux", "--skip-check"]).continueScript,
    "release:linux:continue",
  );
  assert.throws(() => parseReleaseArgs(["linux:arm64"]), /Usage/);
  assert.throws(
    () => parseReleaseArgs(["win", "--unknown"]),
    /Unknown release flag/,
  );
});

test("S3 draft matrix is static and Linux x64-only", () => {
  const installers = requiredDraftInstallerNames();
  assert.ok(installers.includes("S3-Sidekick-Linux-x64.flatpak"));
  assert.equal(
    installers.some((name) => name.includes("Linux-arm64")),
    false,
  );
  assert.ok(requiredDraftManifestNames().includes("latest-linux-x86_64.json"));
  assert.ok(
    requiredDraftManifestNames("0.11.0").includes(
      "latest-linux-beta-x86_64.json",
    ),
  );
  assert.equal(
    requiredDraftManifestNames().some(
      (name) => name.includes("linux") && name.includes("aarch64"),
    ),
    false,
  );
  assert.ok(
    requiredDraftAssetNames().includes("SHA256SUMS-windows-x86_64.txt"),
  );
});

test("release metadata accepts beta and stable drafts only", () => {
  const beta = {
    draft: true,
    id: 1,
    name: "0.11.0-beta.5",
    tag_name: "v0.11.0-beta.5",
  };
  assert.equal(isExpectedRelease(beta, "v0.11.0-beta.5"), true);
  assert.equal(assertExpectedRelease(beta, "v0.11.0-beta.5"), beta);
  assert.equal(isStableReleaseVersion("0.11.0"), true);
  assert.equal(isStableReleaseVersion("0.11.0-beta.5"), false);
});

test("stable release rejects recovery overrides", () => {
  assert.doesNotThrow(() => assertStableReleaseOverridesAllowed({}, "0.11.0"));
  assert.throws(
    () =>
      assertStableReleaseOverridesAllowed(
        { SKIP_RELEASE_MIRROR: "1" },
        "0.11.0",
      ),
    /refuses SKIP_RELEASE_MIRROR/,
  );
});

test("macOS SSH wrapper invokes the release runner directly", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["release:mac:ssh"],
    "npm run mac:ssh:keychain && node scripts/run-release.js mac",
  );
  assert.equal("release:sync-beta-manifests" in packageJson.scripts, true);
});

test("macOS release uses Tauri signing and notarization like Zinnia", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts;
  assert.match(scripts["build:mac:universal:prepared"], /^dotenv -e \.env -- /);
  assert.doesNotMatch(scripts["build:mac:universal:prepared"], /--no-sign/);
  assert.doesNotMatch(scripts["release:mac:continue"], /build:mac:trust/);
  assert.equal("build:mac:trust" in scripts, false);
  assert.equal(
    Object.values(scripts).some((command) =>
      /release-env|macos-release/.test(command),
    ),
    false,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8"),
    /APPLE_NOTARY_PROFILE/,
  );
  assert.match(
    fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8"),
    /AZURE_ARTIFACT_SIGNING_PUBLISHER_DN/,
  );
});

test("Windows beta MSI version uses numeric WiX override", () => {
  assert.equal(msiVersionForAppVersion("0.11.0-beta.5"), "0.11.0.5");
  assert.equal(msiVersionForAppVersion("0.11.0"), null);
  assert.equal(
    bundleConfig("0.11.0-beta.5").bundle.windows.wix.version,
    "0.11.0.5",
  );
  assert.throws(
    () => msiVersionForAppVersion("0.11.0-beta.65536"),
    /WiX limits/,
  );
});

test("Windows build is one tauri build like Zinnia, not compile-then-bundle", () => {
  const command = windowsBuildCommand([
    "--target",
    "x86_64-pc-windows-msvc",
    "--bundles",
    "nsis,msi",
  ]);
  assert.equal(command[1], "build");
  assert.equal(command.includes("bundle"), false);
  assert.equal(command.includes("--no-bundle"), false);
  assert.equal(command.includes("--no-sign"), false);
  const config = JSON.parse(command[command.indexOf("--config") + 1]);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.wix.version, "0.11.0.5");
  assert.deepEqual(command.slice(-2), ["--", "--locked"]);
});

test("Windows signed build re-signs leftover runtime then verifies the release dir", () => {
  const calls = [];
  const target = "x86_64-pc-windows-msvc";
  const targetReleaseDir = path.join(
    process.cwd(),
    "src-tauri",
    "target",
    target,
    "release",
  );
  const runtimePath = path.join(targetReleaseDir, "s3-sidekick.exe");
  const installer = path.join(
    targetReleaseDir,
    "bundle",
    "nsis",
    "S3 Sidekick_0.11.0-beta.5_x64-setup.exe",
  );
  const signingEnv = {
    AZURE_CLIENT_ID: "id",
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_ARTIFACT_SIGNING_ENDPOINT: "https://example.invalid",
    AZURE_ARTIFACT_SIGNING_ACCOUNT: "account",
    AZURE_ARTIFACT_SIGNING_PROFILE: "profile",
    AZURE_ARTIFACT_SIGNING_PUBLISHER: "Rosie Software LLC",
    AZURE_ARTIFACT_SIGNING_PUBLISHER_DN: "CN=Rosie Software LLC",
  };
  runWindowsBuild({
    args: ["--target", target, "--bundles", "nsis,msi"],
    environment: signingEnv,
    platform: "win32",
    execute: (_command, args) => {
      calls.push(args);
    },
    fileExists: (filePath) => filePath === runtimePath,
    findInstallers: () => [installer],
    listRuntimes: () => [runtimePath],
    assertSource: () => "a".repeat(40),
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], "build");
  assert.equal(calls[0].includes("--no-bundle"), false);
  assert.equal(calls[1].includes("-FilePath"), true);
  assert.equal(calls[1].includes(runtimePath), true);
  assert.equal(calls[2].includes("-TargetReleaseDir"), true);
  assert.equal(calls[2].includes(targetReleaseDir), true);
  assert.equal(calls[2].includes("-ExpectedRuntimePath"), false);
  assert.equal(calls[2].includes("-InstallerPathsJson"), false);
  assert.equal(
    calls.some((args) => args.includes(installer)),
    false,
  );
});

test("Windows Authenticode verifier checks release-dir signatures only", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts", "verify-windows-authenticode.ps1"),
    "utf8",
  );
  assert.match(source, /TargetReleaseDir/);
  assert.match(source, /AZURE_ARTIFACT_SIGNING_PUBLISHER_DN/);
  assert.match(source, /TimeStamperCertificate/);
  assert.doesNotMatch(source, /InstallerPathsJson|ExpectedRuntimePath/);
  assert.doesNotMatch(source, /TAURI_BUNDLE_TYPE|msiexec|7z\.exe/);
});
