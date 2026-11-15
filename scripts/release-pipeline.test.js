import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSkipCheckAllowed, parseReleaseArgs } from "./run-release.js";
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
import { getCleanTargets } from "./dist-tools.js";
import { shouldStage } from "./flatpak-bundle.js";
import { isMirrorableReleaseEntry } from "./post-release-assets.js";
import { assertNoSignatureSkips } from "./release-signature-gate.cjs";
import {
  assertLiveAssetsMatchReceipt,
  assertPublishedResponse,
  assertReceiptMatchesRelease,
} from "./publish-release.cjs";
import {
  verifyBetaManifestAssets,
  verifyBetaManifestChecksums,
} from "./gpg-sign.js";
import { readAppVersion, signerArgs } from "./updater-sign.js";
import { hasMinisignEnvelope } from "./validate-updater-manifest.js";
import {
  bundleConfig,
  msiVersionForAppVersion,
  runWindowsBuild,
  windowsBuildCommand,
} from "./tauri-windows-build.js";
import { stripLicensePaths } from "./generate-cargo-licenses.js";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const packageVersion = packageJson.version;

test("release entry points require local proof without querying CI status", () => {
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (name.startsWith("release:")) {
      assert.doesNotMatch(command, /release-ci-status|release:ci-status/, name);
    }
  }
  assert.equal(packageJson.scripts["release:ci-status"], undefined);
  assert.match(packageJson.scripts["release:prepare"], /npm run test:all/);
  for (const name of ["win", "mac", "linux:x64"]) {
    assert.match(
      packageJson.scripts[`release:${name}:continue`],
      /npm run release:session:verify/,
    );
  }
  for (const file of ["publish-release.cjs", "finalize-release-assets.js"]) {
    const source = fs.readFileSync(path.join("scripts", file), "utf8");
    assert.doesNotMatch(source, /release-ci-status|runReleaseCiStatus/);
    assert.match(source, /verifyReleaseSession\(/);
  }
});
const packageTag = `v${packageVersion}`;

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
  assert.throws(
    () => parseReleaseArgs(["win", "--skip-e2e"]),
    /Unknown release flag/,
  );
  assert.doesNotMatch(packageJson.scripts["release:prepare"], /--skip-e2e/);
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
  assert.doesNotThrow(() =>
    assertStableReleaseOverridesAllowed(
      { ENFORCE_LINUX_X64_PACKAGE_SET: "0" },
      "0.11.0",
    ),
  );
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
  // Release builds run through the SOURCE_DATE_EPOCH wrapper so two builds of
  // one commit embed identical timestamps; the underlying command still loads
  // the host .env and uses Tauri signing/notarization.
  assert.match(
    scripts["build:mac:universal:prepared"],
    /^(?:node scripts\/with-source-date-epoch\.mjs )?dotenv -e \.env -- tauri build/,
  );
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
  const msiVersion = msiVersionForAppVersion(packageVersion);
  if (msiVersion) {
    assert.equal(config.bundle.windows.wix.version, msiVersion);
  } else {
    assert.equal(config.bundle.windows, undefined);
  }
  assert.deepEqual(command.slice(-2), ["--", "--locked"]);
});

test("release metadata stays aligned with package.json", () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );
  const cargoToml = fs.readFileSync(
    path.join(process.cwd(), "src-tauri", "Cargo.toml"),
    "utf8",
  );
  const cargoLock = fs.readFileSync(
    path.join(process.cwd(), "src-tauri", "Cargo.lock"),
    "utf8",
  );
  const cargoVersion = cargoToml.match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  )?.[1];
  const lockVersion = cargoLock.match(
    /^\[\[package\]\]\r?\nname = "s3-sidekick"\r?\nversion = "([^"]+)"/m,
  )?.[1];

  assert.equal(tauriConfig.version, packageVersion);
  assert.equal(cargoVersion, packageVersion);
  assert.equal(lockVersion, packageVersion);
  assert.match(packageJson.scripts.u, /npm run sync-version/);
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

test("Flatpak npm 12 install overrides sandbox offline mode", () => {
  const yaml = fs.readFileSync(
    path.join(process.cwd(), "run.rosie.s3-sidekick.yml"),
    "utf8",
  );
  assert.match(yaml, /npm_config_offline:\s*"true"/);
  assert.match(yaml, /npm install --global npm@12\.2\.1 --no-offline /);
  assert.match(yaml, /--share=network/);
  assert.match(yaml, /CARGO_NET_OFFLINE:\s*"true"/);
});

test("--skip-check is explicit and never allowed for stable releases", () => {
  assert.equal(assertSkipCheckAllowed(false), false);
  assert.throws(
    () =>
      assertSkipCheckAllowed(true, {
        environment: { ALLOW_RELEASE_SKIP_CHECK: "1" },
        version: "0.12.0",
      }),
    /stable release/,
  );
  assert.throws(
    () =>
      assertSkipCheckAllowed(true, {
        environment: {},
        version: "0.12.0-beta.1",
      }),
    /ALLOW_RELEASE_SKIP_CHECK=1/,
  );
  assert.equal(
    assertSkipCheckAllowed(true, {
      environment: { ALLOW_RELEASE_SKIP_CHECK: "1" },
      version: "0.12.0-beta.1",
    }),
    true,
  );
});

test("release cleanup is non-destructive and guarded", () => {
  const scripts = packageJson.scripts;
  assert.equal(
    scripts["release:cleanup:checkout"],
    "node scripts/release-cleanup-checkout.mjs",
  );
  const guard = fs.readFileSync(
    path.join(process.cwd(), "scripts", "release-cleanup-checkout.mjs"),
    "utf8",
  );
  assert.match(guard, /ALLOW_RELEASE_CLEANUP_STASH/);
  assert.match(guard, /merge", "--ff-only/);
  assert.doesNotMatch(guard, /reset", "--hard|clean", "-fd/);
  assert.match(scripts["release:finalize"], /npm run release:cleanup:checkout/);
  for (const name of [
    "release:win:continue",
    "release:mac:continue",
    "release:linux:x64:continue",
  ]) {
    assert.match(scripts[name], /npm run release:session:verify/);
    assert.match(scripts[name], /npm run release:finalize/);
    assert.doesNotMatch(scripts[name], /ALLOW_RELEASE_CLEANUP_STASH/);
  }
  assert.equal(
    scripts["release:linux:continue"],
    "npm run release:linux:x64:continue",
  );
  assert.match(scripts["release:prepare"], /npm run test:all/);
});

test("retired Linux package formats are never mirrored", () => {
  assert.equal(isMirrorableReleaseEntry("S3-Sidekick-Linux-x64.deb"), false);
  assert.equal(isMirrorableReleaseEntry("S3-Sidekick-Linux-x64.rpm"), false);
  assert.equal(
    isMirrorableReleaseEntry("S3-Sidekick-Linux-x64.AppImage"),
    true,
  );
  assert.equal(isMirrorableReleaseEntry("S3-Sidekick-Linux-x64.flatpak"), true);
  assert.equal(
    isMirrorableReleaseEntry("S3 Sidekick_0.12.0-beta.1_amd64.deb"),
    false,
  );
});

test("release verification fails closed when signing was skipped", () => {
  assert.doesNotThrow(() => assertNoSignatureSkips({}));
  assert.throws(
    () => assertNoSignatureSkips({ SKIP_WIN_CODESIGN: "1" }),
    /refuses SKIP_WIN_CODESIGN/,
  );
  assert.throws(
    () => assertNoSignatureSkips({ SKIP_MAC_NOTARIZATION: "true" }),
    /refuses SKIP_MAC_NOTARIZATION/,
  );
});

test("published response must actually leave draft state", () => {
  const isPrerelease = /-beta\.\d+$/.test(packageVersion);
  const published = {
    draft: false,
    prerelease: isPrerelease,
    tag_name: packageTag,
  };
  assert.equal(assertPublishedResponse(published), published);
  assert.throws(
    () => assertPublishedResponse({ ...published, draft: true }),
    /still reports draft=true/,
  );
  assert.throws(
    () => assertPublishedResponse({ ...published, prerelease: !isPrerelease }),
    /prerelease/,
  );
  assert.throws(
    () => assertPublishedResponse({ ...published, tag_name: "untagged-abc" }),
    /tag_name/,
  );
  assert.throws(
    () =>
      assertPublishedResponse(
        { ...published, target_commitish: "b".repeat(40) },
        { commit: "a".repeat(40) },
      ),
    /targets/,
  );
});

test("publish receipt rejects changed release assets", () => {
  const receipt = {
    suite: "release-draft-verification",
    version: packageVersion,
    tag: packageTag,
    release: {
      id: 7,
      tag_name: packageTag,
      draft: true,
    },
    assets: [
      { id: 1, name: "a.exe", size: 10, digest: "sha256:aa" },
      { id: 2, name: "a.exe.asc", size: 5, digest: "sha256:bb" },
    ],
  };
  const release = {
    id: 7,
    tag_name: packageTag,
    draft: true,
  };
  assert.doesNotThrow(() => assertReceiptMatchesRelease(release, receipt));
  assert.throws(
    () => assertReceiptMatchesRelease({ ...release, id: 8 }, receipt),
    /changed after verification/,
  );
  assert.doesNotThrow(() =>
    assertLiveAssetsMatchReceipt(receipt.assets, receipt),
  );
  assert.throws(
    () =>
      assertLiveAssetsMatchReceipt(
        [...receipt.assets, { id: 3, name: "extra.exe", size: 1 }],
        receipt,
      ),
    /unexpected: extra\.exe/,
  );
  assert.throws(
    () =>
      assertLiveAssetsMatchReceipt(
        [{ ...receipt.assets[0], digest: "sha256:cc" }, receipt.assets[1]],
        receipt,
      ),
    /changed after verification/,
  );
});

test("beta manifest recovery refuses missing integrity metadata", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3sk-beta-manifest-"),
  );
  const manifest = "latest-windows-beta-x86_64.json";
  try {
    assert.throws(
      () =>
        verifyBetaManifestAssets(
          [{ name: manifest, id: 1 }],
          [manifest],
          directory,
        ),
      /no signed checksum manifests/,
    );
    assert.throws(
      () =>
        verifyBetaManifestAssets(
          [
            { name: manifest, id: 1 },
            { name: manifest, id: 2 },
          ],
          [manifest],
          directory,
        ),
      /Duplicate release asset/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("beta manifest recovery verifies signed checksum bytes before copying", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3sk-beta-checksum-"),
  );
  const manifest = "latest-windows-beta-x86_64.json";
  const checksum = "SHA256SUMS-windows-beta-x86_64.txt";
  const manifestPath = path.join(directory, manifest);
  try {
    fs.writeFileSync(manifestPath, '{"version":"0.12.0-beta.1"}\n');
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(manifestPath))
      .digest("hex");
    fs.writeFileSync(
      path.join(directory, checksum),
      `${digest}  ${manifest}\n`,
    );
    assert.doesNotThrow(() =>
      verifyBetaManifestChecksums([manifest], [checksum], directory),
    );
    fs.appendFileSync(manifestPath, "\n");
    assert.throws(
      () => verifyBetaManifestChecksums([manifest], [checksum], directory),
      /does not match its signed checksum/,
    );
    assert.throws(
      () =>
        verifyBetaManifestChecksums(
          ["latest-linux-beta-x86_64.json"],
          [checksum],
          directory,
        ),
      /not covered by a checksum/,
    );
    fs.writeFileSync(path.join(directory, checksum), "not a checksum\n");
    assert.throws(
      () => verifyBetaManifestChecksums([manifest], [checksum], directory),
      /Malformed checksum entry/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("updater signing binds signatures to the package version", () => {
  const version = readAppVersion();
  assert.equal(version, packageVersion);
  assert.deepEqual(signerArgs("/tmp/app.tar.gz", version), [
    "signer",
    "sign",
    "--app-version",
    version,
    "/tmp/app.tar.gz",
  ]);
  assert.throws(() => signerArgs("/tmp/app.tar.gz", ""), /app version/);

  const directory = fs.mkdtempSync(
    path.join(process.cwd(), ".tmp-updater-version-"),
  );
  try {
    const packageJsonFile = path.join(directory, "package.json");
    fs.writeFileSync(packageJsonFile, "{}\n");
    assert.throws(
      () => readAppVersion({ packageJsonFile }),
      /no version|version is required/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const config = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );
  assert.equal(config.plugins.updater.requireSignedVersion, true);
});

test("minisign envelope rejects malformed and truncated signatures", () => {
  assert.equal(hasMinisignEnvelope("not-base64"), false);
  assert.equal(
    hasMinisignEnvelope(
      Buffer.from(
        "untrusted comment: test\nAAAA\ntrusted comment: test\nAAAA\n",
      ).toString("base64"),
    ),
    false,
  );
  assert.equal(
    hasMinisignEnvelope(Buffer.from("short").toString("base64")),
    false,
  );
});

test("stable release rejects every signing/upload bypass", () => {
  for (const name of [
    "SKIP_WIN_CODESIGN",
    "FORCE_UPLOAD",
    "SKIP_RELEASE_MIRROR",
    "ALLOW_ASSET_REPLACE",
  ]) {
    assert.throws(
      () => assertStableReleaseOverridesAllowed({ [name]: "1" }, "0.12.0"),
      new RegExp(`refuses ${name}`),
    );
  }
});

test("Flatpak staging and clean omit nested builder caches", () => {
  const root = process.cwd();
  assert.equal(shouldStage(path.join(root, "package.json")), true);
  assert.equal(shouldStage(path.join(root, ".flatpak-builder")), false);
  assert.equal(
    shouldStage(path.join(root, ".flatpak-builder", "build", "s3-sidekick-11")),
    false,
  );
  const yaml = fs.readFileSync(
    path.join(root, "run.rosie.s3-sidekick.yml"),
    "utf8",
  );
  assert.match(yaml, /^\s+- \.flatpak-builder$/m);
  const cleaned = getCleanTargets("clean-flatpak", root);
  assert.equal(cleaned.includes(".flatpak-builder"), true);
  assert.equal(cleaned.includes(".flatpak-source"), true);
});

test("license feeds omit build-host path and licenseFile", () => {
  assert.deepEqual(
    stripLicensePaths({
      "left-pad@1.0.0": {
        licenses: "MIT",
        repository: "https://example.test/left-pad",
        path: "/Users/builder/S3-Sidekick/node_modules/left-pad",
        licenseFile: "/Users/builder/S3-Sidekick/node_modules/left-pad/LICENSE",
      },
      "cargo:serde@1.0.0": {
        licenses: "MIT OR Apache-2.0",
        packageManager: "cargo",
      },
    }),
    {
      "left-pad@1.0.0": {
        licenses: "MIT",
        repository: "https://example.test/left-pad",
      },
      "cargo:serde@1.0.0": {
        licenses: "MIT OR Apache-2.0",
        packageManager: "cargo",
      },
    },
  );
});

test("development config cannot use the production updater feed", () => {
  const root = process.cwd();
  const base = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const dev = JSON.parse(
    fs.readFileSync(
      path.join(root, "src-tauri", "tauri.dev.conf.json"),
      "utf8",
    ),
  );
  assert.ok(base.plugins.updater.endpoints.length > 0);
  assert.deepEqual(dev.plugins.updater.endpoints, []);
  assert.equal(dev.bundle.createUpdaterArtifacts, false);
  assert.equal(dev.identifier, "run.rosie.dev.s3-sidekick");
});
