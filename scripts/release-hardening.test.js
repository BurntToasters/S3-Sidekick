import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSanitizedSource,
  installFlatpakDependencies,
  isSecretEnvironmentFile,
  runFlatpakBuild,
  shouldStage,
  verifyFlatpakInputs,
} from "./flatpak-bundle.js";
import { requiredMacEnvironment } from "./macos-release.js";
import {
  artifactRecords,
  buildSpdxSbom,
  runCheck,
  validateLicenseInventories,
  verifyPackageSmoke,
} from "./release-evidence.js";
import {
  childEnvironment,
  parseDotEnv,
  runReleaseCommand,
} from "./release-env.js";
import {
  assertChannelTransitionSupported,
  assertCompleteEvidence,
  assertReleaseAssetIndexEntries,
  betaManifestName,
  channelTransitionPolicy,
  createReleaseAssetIndex,
  recheckFrozenReleaseAssetSet,
  stableManifestName,
  validatePublicationRelease,
  verifyChecksumFiles,
} from "./release-publication.js";
import {
  runWindowsBuild,
  windowsBuildCommands,
} from "./tauri-windows-build.js";
import { isUpdaterArtifact } from "./updater-sign.js";
import integrity from "./release-integrity.cjs";

const { canonicalMacosArtifactName } = integrity;
const root = path.resolve(new URL("..", import.meta.url).pathname);

test("dependency-executing builds receive no aggregate release secrets", () => {
  const inherited = {
    PATH: "/bin",
    GPG_PASSPHRASE: "canary-gpg-secret",
    TAURI_SIGNING_PRIVATE_KEY: "canary-updater-secret",
    AZURE_CLIENT_SECRET: "canary-azure-secret",
    APPLE_PASSWORD: "canary-apple-secret",
    GH_TOKEN: "canary-token",
    AWS_SECRET_ACCESS_KEY: "unknown-aws-secret",
    NPM_TOKEN: "unknown-npm-secret",
    SENTRY_AUTH_TOKEN: "unknown-sentry-secret",
    UNRECOGNIZED_RELEASE_SECRET: "unknown-canary-secret",
  };
  assert.deepEqual(childEnvironment("build", inherited, {}), {
    PATH: "/bin",
    ...(process.platform === "darwin" ? { APPLE_SIGNING_IDENTITY: "-" } : {}),
  });
  assert.deepEqual(childEnvironment("gpg", inherited, {}), {
    PATH: "/bin",
    GPG_PASSPHRASE: "canary-gpg-secret",
  });
  assert.deepEqual(childEnvironment("updater", inherited, {}), {
    PATH: "/bin",
    TAURI_SIGNING_PRIVATE_KEY: "canary-updater-secret",
  });
  assert.deepEqual(
    childEnvironment(
      "build",
      { PATH: "/bin" },
      {
        UNRECOGNIZED_RELEASE_SECRET: "dotenv-canary",
      },
    ),
    {
      PATH: "/bin",
      ...(process.platform === "darwin" ? { APPLE_SIGNING_IDENTITY: "-" } : {}),
    },
  );
  assert.deepEqual(parseDotEnv("A=one\nB='two words'\n# ignored\n"), {
    A: "one",
    B: "two words",
  });
});

test("source-sensitive release wrappers gate the exact commit before and after execution", () => {
  const commit = "c".repeat(40);
  const events = [];
  const status = runReleaseCommand({
    args: ["build", "--", "builder", "--locked"],
    environment: { PATH: "/bin" },
    execute(command, args, options) {
      events.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
    assertSource(_directory, { expectedCommit } = {}) {
      events.push(expectedCommit ?? "pre-source-check");
      return expectedCommit ?? commit;
    },
    workingDirectory: root,
  });
  assert.equal(status, 0);
  assert.equal(events[0], "pre-source-check");
  assert.equal(events[1].command, "builder");
  assert.deepEqual(events[1].args, ["--locked"]);
  assert.equal(events[1].cwd, root);
  assert.equal(events[2], commit);

  const failureChecks = [];
  assert.throws(
    () =>
      runReleaseCommand({
        args: ["windows", "--", "builder"],
        environment: { PATH: "/bin" },
        execute: () => {
          throw new Error("build failed");
        },
        assertSource(_directory, { expectedCommit } = {}) {
          failureChecks.push(expectedCommit ?? null);
          return expectedCommit ?? commit;
        },
        workingDirectory: root,
      }),
    /build failed/i,
  );
  assert.deepEqual(failureChecks, [null, commit]);

  let nonSourceChecks = 0;
  assert.equal(
    runReleaseCommand({
      args: ["gpg", "--", "gpg", "--version"],
      environment: { PATH: "/bin" },
      execute: () => ({ status: 0 }),
      assertSource: () => {
        nonSourceChecks += 1;
      },
      workingDirectory: root,
    }),
    0,
  );
  assert.equal(nonSourceChecks, 0);
});

test("Flatpak source policy excludes env files and detects canary secret bytes", () => {
  assert.equal(isSecretEnvironmentFile("/tmp/.env"), true);
  assert.equal(isSecretEnvironmentFile("/tmp/.env.production"), true);
  assert.equal(isSecretEnvironmentFile("/tmp/.env.example"), false);

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-flatpak-source-"),
  );
  try {
    fs.writeFileSync(path.join(directory, "safe.txt"), "safe source");
    assert.equal(
      assertSanitizedSource(directory, ["canary-release-secret"]),
      true,
    );
    fs.writeFileSync(
      path.join(directory, "bundle.txt"),
      "canary-release-secret",
    );
    assert.throws(
      () => assertSanitizedSource(directory, ["canary-release-secret"]),
      /secret entered Flatpak source context/i,
    );
    fs.rmSync(path.join(directory, "bundle.txt"));
    fs.writeFileSync(
      path.join(directory, ".env.local"),
      "TOKEN=canary-release-secret",
    );
    assert.throws(
      () => assertSanitizedSource(directory, []),
      /environment file entered/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Flatpak build aborts before staging when installed commits differ", () => {
  const inputs = [
    {
      commit: "a".repeat(64),
      ref: "org.gnome.Platform//49",
    },
  ];
  const events = [];
  const sourceChecks = [];
  assert.throws(
    () =>
      runFlatpakBuild({
        arch: "x64",
        assertSource(_directory, { expectedCommit } = {}) {
          sourceChecks.push(expectedCommit ?? null);
          return expectedCommit ?? "c".repeat(40);
        },
        execute(command, args) {
          events.push(`${command} ${args.join(" ")}`);
          if (command === "flatpak" && args[0] === "info") {
            return "b".repeat(64);
          }
          return "";
        },
        loadInputs: () => ({
          descriptorSha256: "d".repeat(64),
          inputs,
        }),
        platform: "linux",
        recordInputs: () => events.push("record"),
        sanitizeSource: () => events.push("sanitize"),
        stageSource: () => events.push("stage"),
        verifyInputs: verifyFlatpakInputs,
      }),
    /not descriptor-pinned commit/i,
  );
  assert.deepEqual(events, [
    "flatpak info --show-commit org.gnome.Platform//49",
  ]);
  assert.deepEqual(sourceChecks, [null, "c".repeat(40)]);
});

test("release input policy pins bootstrap tools and runs Flatpak without build network", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const manifest = fs.readFileSync(
    path.join(root, "run.rosie.s3-sidekick.yml"),
    "utf8",
  );
  const toolchain = fs.readFileSync(
    path.join(root, "rust-toolchain.toml"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const flatpakBundle = fs.readFileSync(
    path.join(root, "scripts", "flatpak-bundle.js"),
    "utf8",
  );
  const dependencyBuilds = Object.entries(packageJson.scripts).filter(
    ([name]) =>
      /^(?:build:.*:prepared|release:draft|release:wait-draft|release:sign:gpg)$/.test(
        name,
      ),
  );
  for (const [name, command] of dependencyBuilds) {
    assert.doesNotMatch(
      command,
      /dotenv\s+-e\s+\.env/,
      `${name} must not inherit aggregate dotenv`,
    );
  }
  assert.match(toolchain, /channel = "\d+\.\d+\.\d+"/);
  assert.doesNotMatch(toolchain, /channel = "stable"/);
  assert.doesNotMatch(
    manifest,
    /curl[^\n]*rustup|npm install --global npm@12|build-args:/,
  );
  assert.match(manifest, /path: \.flatpak-source/);
  assert.match(manifest, /release-ref: org\.gnome\.Platform\/\/49/);
  assert.match(
    manifest,
    /release-ref: org\.freedesktop\.Sdk\.Extension\.node22\/\/25\.08/,
  );
  assert.match(manifest, /- \.env\.\*/);
  assert.match(
    flatpakBundle,
    /path\.join\(stagedSource, "src-tauri", "Cargo\.toml"\)/,
  );
  assert.doesNotMatch(
    flatpakBundle,
    /path\.join\(root, "src-tauri", "Cargo\.toml"\)/,
  );
  assert.match(workflow, /RUST_VERSION: "\d+\.\d+\.\d+"/);
  assert.match(
    workflow,
    /cargo install cargo-audit --version 0\.22\.2 --locked/,
  );
  assert.match(workflow, /npm audit --audit-level=high --ignore-scripts/);
});

test("macOS release mode requires Developer ID/notary inputs and forbids ad-hoc identity", () => {
  assert.throws(() => requiredMacEnvironment({}), /missing mandatory/i);
  assert.throws(
    () =>
      requiredMacEnvironment({
        APPLE_SIGNING_IDENTITY: "-",
        APPLE_TEAM_ID: "TEAM",
        APPLE_NOTARY_PROFILE: "profile",
      }),
    /ad-hoc signing is forbidden/i,
  );
  assert.deepEqual(
    requiredMacEnvironment({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
      APPLE_TEAM_ID: "TEAM",
      APPLE_NOTARY_PROFILE: "profile",
    }),
    {
      identity: "Developer ID Application: Example",
      notaryProfile: "profile",
      teamId: "TEAM",
    },
  );
  assert.equal(
    canonicalMacosArtifactName("S3 Sidekick.app.tar.gz"),
    "S3-Sidekick-macOS.app.tar.gz",
  );
  assert.equal(
    canonicalMacosArtifactName("S3 Sidekick.dmg"),
    "S3-Sidekick-macOS.dmg",
  );
  assert.equal(
    canonicalMacosArtifactName("S3 Sidekick.zip"),
    "S3-Sidekick-macOS.zip",
  );
  assert.equal(canonicalMacosArtifactName("unrelated.exe"), null);
  const source = fs.readFileSync(
    path.join(root, "scripts", "macos-release.js"),
    "utf8",
  );
  for (const requiredCommand of [
    "codesign",
    "notarytool",
    "stapler",
    "spctl",
    "com.apple.quarantine",
  ]) {
    assert.match(source, new RegExp(requiredCommand));
  }
});

test("macOS package evidence requires exact unique trust-report package names and digests", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-macos-trust-"),
  );
  const packageNames = [
    "S3-Sidekick-macOS.app.tar.gz",
    "S3-Sidekick-macOS.dmg",
    "S3-Sidekick-macOS.zip",
  ];
  const packagePaths = packageNames.map((name, index) => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, `trusted-package-${index}\n`);
    return filePath;
  });
  const noiseNames = [
    "S3-Sidekick-macOS.app.tar.gz.sig",
    "S3-Sidekick-macOS.dmg.asc",
    "latest-darwin-aarch64.json",
    "SHA256SUMS-darwin-aarch64.txt",
  ];
  const noisePaths = noiseNames.map((name, index) => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, `non-package-${index}\n`);
    return filePath;
  });
  const trustedArtifacts = artifactRecords(packagePaths).map(
    ({ name, sha256 }) => ({ name, sha256 }),
  );
  const requiredChecks = [
    "codesign-deep-strict",
    "notary-accepted",
    "stapler-validate",
    "gatekeeper",
    "quarantine-gatekeeper",
  ];
  const trustPath = path.join(directory, "macos-trust.json");
  const writeTrust = (artifacts, includeArtifacts = true) => {
    const trust = { schemaVersion: 1, checks: requiredChecks };
    if (includeArtifacts) trust.artifacts = artifacts;
    fs.writeFileSync(trustPath, `${JSON.stringify(trust)}\n`);
  };
  const verify = () =>
    verifyPackageSmoke({
      artifactFiles: [...packagePaths, ...noisePaths],
      platform: "darwin",
      releaseDir: directory,
    });
  const reject = (artifacts, pattern = /macOS trust report/i) => {
    writeTrust(artifacts);
    assert.throws(verify, pattern);
  };

  try {
    writeTrust(trustedArtifacts);
    const result = verify();
    assert.equal(result.status, "passed");
    assert.deepEqual(
      result.packages.map(({ name }) => name),
      packageNames,
    );

    writeTrust(undefined, false);
    assert.throws(verify, /artifacts must be an array/i);
    reject([]);
    reject(trustedArtifacts.slice(0, -1), /does not exactly cover/i);
    reject([...trustedArtifacts, trustedArtifacts[0]], /duplicate artifact/i);
    reject(
      [
        ...trustedArtifacts,
        {
          name: path.basename(noisePaths[0]),
          sha256: artifactRecords([noisePaths[0]])[0].sha256,
        },
      ],
      /does not exactly cover/i,
    );
    reject(
      trustedArtifacts.map((record, index) =>
        index === 0 ? { ...record, name: `../${record.name}` } : record,
      ),
      /malformed artifact record/i,
    );
    reject(
      trustedArtifacts.map((record, index) =>
        index === 0 ? { ...record, sha256: "A".repeat(64) } : record,
      ),
      /malformed artifact record/i,
    );
    reject(
      trustedArtifacts.map((record, index) =>
        index === 0 ? { ...record, sha256: "f".repeat(64) } : record,
      ),
      /digest does not match/i,
    );
    reject(
      trustedArtifacts.map((record, index) => {
        if (index === 0)
          return { ...record, sha256: trustedArtifacts[1].sha256 };
        if (index === 1)
          return { ...record, sha256: trustedArtifacts[0].sha256 };
        return record;
      }),
      /digest does not match/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("updater signing is isolated after dependency builds", () => {
  assert.equal(isUpdaterArtifact("S3-Sidekick-Linux-x64.AppImage"), true);
  assert.equal(isUpdaterArtifact("S3-Sidekick.app.tar.gz"), true);
  assert.equal(isUpdaterArtifact("artifact.sig"), false);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const buildName of [
    "build:win:x64:prepared",
    "build:win:arm64:prepared",
    "build:mac:universal:prepared",
    "build:linux:x64:prepared",
    "build:linux:arm64:prepared",
  ]) {
    if (buildName.startsWith("build:win:")) continue;
    assert.match(packageJson.scripts[buildName], /--no-sign/);
  }
  const windowsBuildSource = fs.readFileSync(
    path.join(root, "scripts", "tauri-windows-build.js"),
    "utf8",
  );
  assert.match(windowsBuildSource, /"--no-sign"/);
  for (const name of [
    "release:win:continue",
    "release:mac:continue",
    "release:linux:x64:continue",
    "release:linux:arm64:continue",
  ]) {
    const command = packageJson.scripts[name];
    assert.ok(
      command.indexOf("build:") < command.indexOf("release:sign:updater"),
    );
    assert.ok(
      command.indexOf("release:sign:updater") <
        command.indexOf("release:sign:gpg"),
    );
  }
});

test("Windows release signs runtime before bundle and verifies the exact signed installer set", () => {
  const args = ["--target", "x86_64-pc-windows-msvc", "--bundles", "nsis"];
  const commands = windowsBuildCommands(args);
  assert.ok(commands.compile.includes("--no-bundle"));
  assert.ok(commands.compile.includes("--no-sign"));
  assert.equal(commands.bundle[1], "bundle");
  assert.ok(commands.bundle.includes("--no-sign"));

  const environment = {
    OS: "Windows_NT",
    PATH: "C:\\Windows\\System32",
    AZURE_CLIENT_ID: "client",
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_ARTIFACT_SIGNING_ENDPOINT: "https://example.invalid",
    AZURE_ARTIFACT_SIGNING_ACCOUNT: "account",
    AZURE_ARTIFACT_SIGNING_PROFILE: "profile",
    AZURE_ARTIFACT_SIGNING_PUBLISHER: "publisher",
  };
  const installers = [
    "C:\\release\\bundle\\app setup.exe",
    "C:\\release\\bundle\\app.msi",
  ];
  const calls = [];
  const sourceChecks = [];
  const sourceCommit = "c".repeat(40);
  const result = runWindowsBuild({
    args,
    environment,
    assertSource(_directory, { expectedCommit } = {}) {
      sourceChecks.push(expectedCommit ?? null);
      return expectedCommit ?? sourceCommit;
    },
    execute(command, commandArgs, options) {
      calls.push({ command, commandArgs, env: options.env });
    },
    fileExists: () => true,
    findInstallers: () => installers,
    platform: "win32",
  });
  assert.deepEqual(sourceChecks, [null, sourceCommit]);
  assert.equal(calls.length, 6);
  assert.equal(calls[0].command, process.execPath);
  assert.ok(calls[0].commandArgs.includes("--no-bundle"));
  assert.equal(calls[0].env.AZURE_CLIENT_SECRET, undefined);
  assert.equal(calls[1].command, "powershell.exe");
  assert.match(calls[1].commandArgs.at(-1), /s3-sidekick\.exe$/i);
  assert.equal(calls[1].env.AZURE_CLIENT_SECRET, "secret");
  assert.equal(calls[2].command, process.execPath);
  assert.equal(calls[2].commandArgs[1], "bundle");
  assert.equal(calls[3].commandArgs.at(-1), result.installers[0]);
  assert.equal(calls[4].commandArgs.at(-1), result.installers[1]);
  const verificationArgs = calls[5].commandArgs;
  assert.ok(verificationArgs.includes("-ExpectedRuntimePath"));
  assert.equal(
    verificationArgs[verificationArgs.indexOf("-ExpectedRuntimePath") + 1],
    result.runtimePath,
  );
  assert.equal(verificationArgs.includes("-TargetReleaseDir"), false);
  assert.deepEqual(
    JSON.parse(
      verificationArgs[verificationArgs.indexOf("-InstallerPathsJson") + 1],
    ),
    installers,
  );
  assert.equal(calls[5].env.AZURE_CLIENT_SECRET, undefined);
  assert.equal(calls[5].env.AZURE_ARTIFACT_SIGNING_PUBLISHER, "publisher");

  const verifierSource = fs.readFileSync(
    path.join(root, "scripts", "verify-windows-authenticode.ps1"),
    "utf8",
  );
  assert.match(verifierSource, /InstallerPathsJson/);
  assert.doesNotMatch(verifierSource, /TargetReleaseDir/);
  assert.match(verifierSource, /SignatureOnly/);
  assert.doesNotMatch(verifierSource, /SKIP_WIN_CODESIGN/);
});

test("Windows package smoke rejects truthy signing skips before verification", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-windows-smoke-"),
  );
  const installer = path.join(directory, "unsigned.exe");
  fs.writeFileSync(installer, "unsigned fixture");
  const executeCalls = [];
  try {
    for (const skipValue of ["1", "true", "0", "false", " "]) {
      let report;
      assert.throws(() => {
        report = verifyPackageSmoke({
          releaseDir: directory,
          artifactFiles: [installer],
          environment: { SKIP_WIN_CODESIGN: skipValue },
          executeCheck(...args) {
            executeCalls.push(args);
          },
          platform: "win32",
        });
      }, /SKIP_WIN_CODESIGN.*forbidden/i);
      assert.equal(report, undefined);
    }
    assert.deepEqual(executeCalls, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("license/source policy and SPDX generation fail closed", () => {
  assert.equal(
    validateLicenseInventories({
      npmLicenses: {
        "private@1.0.0": { licenses: "UNLICENSED", private: true },
        "safe@1.0.0": { licenses: "MIT" },
      },
      cargoLicenses: {
        "cargo:safe@1.0.0": {
          licenses: "Apache-2.0 OR MIT",
          source: "registry+https://github.com/rust-lang/crates.io-index",
        },
      },
    }),
    true,
  );
  assert.throws(
    () =>
      validateLicenseInventories({
        npmLicenses: { "bad@1": { licenses: "UNKNOWN" } },
        cargoLicenses: {},
      }),
    /license\/source policy failed/i,
  );
  assert.throws(
    () =>
      validateLicenseInventories({
        npmLicenses: {},
        cargoLicenses: {
          "cargo:bad@1": {
            licenses: "MIT",
            source: "git+https://example.invalid/repo",
          },
        },
      }),
    /unapproved git dependency/i,
  );
  const sbom = buildSpdxSbom({
    descriptor: {
      release: { tag: "v1.0.0", version: "1.0.0" },
      source: { committedAt: "2026-01-01T00:00:00Z" },
    },
    descriptorSha256: "d".repeat(64),
    artifacts: [{ name: "app.zip", sha256: "a".repeat(64) }],
    npmLicenses: { "safe@1.0.0": { licenses: "MIT" } },
    cargoLicenses: {},
  });
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.files[0].checksums[0].algorithm, "SHA256");
});

test("publication requires complete non-overlapping target evidence", () => {
  const descriptor = {
    release: { id: 42, prerelease: true, tag: "v1.2.3-beta.1" },
    source: { commit: "commit" },
    expectedTargets: ["linux-x86_64"],
    requiredEvidence: ["attestation", "package-smoke", "provenance", "sbom"],
  };
  const attestation = {
    schemaVersion: 1,
    descriptorSha256: "d".repeat(64),
    releaseId: 42,
    sourceCommit: "commit",
    targets: ["linux-x86_64"],
    host: { platform: "linux", arch: "x64" },
    artifacts: [{ name: "app.AppImage", sha256: "a".repeat(64) }],
    evidence: [
      {
        name: "release-package-smoke-linux-x86_64.json",
        sha256: "b".repeat(64),
      },
      { name: "release-provenance-linux-x86_64.json", sha256: "c".repeat(64) },
      { name: "release-sbom-linux-x86_64.spdx.json", sha256: "e".repeat(64) },
    ],
  };
  const names = [
    "release-descriptor.json",
    "release-descriptor.json.asc",
    "app.AppImage",
    "app.AppImage.asc",
    "app.AppImage.sig",
    "SHA256SUMS-linux-x86_64.txt",
    "SHA256SUMS-linux-x86_64.txt.asc",
    "release-attestation-linux-x86_64.json",
    "release-attestation-linux-x86_64.json.asc",
    "release-package-smoke-linux-x86_64.json",
    "release-package-smoke-linux-x86_64.json.asc",
    "release-provenance-linux-x86_64.json",
    "release-provenance-linux-x86_64.json.asc",
    "release-sbom-linux-x86_64.spdx.json",
    "release-sbom-linux-x86_64.spdx.json.asc",
  ];
  const assetsByName = new Map(names.map((name, id) => [name, { id, name }]));
  const digestByName = new Map([
    ["app.AppImage", "a".repeat(64)],
    ["release-package-smoke-linux-x86_64.json", "b".repeat(64)],
    ["release-provenance-linux-x86_64.json", "c".repeat(64)],
    ["release-sbom-linux-x86_64.spdx.json", "e".repeat(64)],
  ]);
  assert.equal(
    assertCompleteEvidence({
      assetsByName,
      attestations: [attestation],
      descriptor,
      descriptorSha256: "d".repeat(64),
      digestByName,
    }),
    true,
  );
  const pinnedInputs = [
    {
      commit: "f".repeat(64),
      ref: "org.gnome.Platform//49",
    },
  ];
  descriptor.toolchains = {
    flatpak: { inputsByArchitecture: { x64: pinnedInputs } },
  };
  attestation.platformInputs = {
    arch: "x64",
    descriptorSha256: "d".repeat(64),
    inputs: pinnedInputs,
    schemaVersion: 2,
  };
  assert.doesNotThrow(() =>
    assertCompleteEvidence({
      assetsByName,
      attestations: [attestation],
      descriptor,
      descriptorSha256: "d".repeat(64),
      digestByName,
    }),
  );
  const changedFlatpakAttestation = structuredClone(attestation);
  changedFlatpakAttestation.platformInputs.inputs[0].commit = "0".repeat(64);
  assert.throws(
    () =>
      assertCompleteEvidence({
        assetsByName,
        attestations: [changedFlatpakAttestation],
        descriptor,
        descriptorSha256: "d".repeat(64),
        digestByName,
      }),
    /do not exactly match the signed x64 descriptor pins/i,
  );
  const missingAttestationSignature = new Map(assetsByName);
  missingAttestationSignature.delete(
    "release-attestation-linux-x86_64.json.asc",
  );
  assert.throws(
    () =>
      assertCompleteEvidence({
        assetsByName: missingAttestationSignature,
        attestations: [attestation],
        descriptor,
        descriptorSha256: "d".repeat(64),
        digestByName,
      }),
    /signed host attestation is missing/i,
  );
  assert.throws(
    () =>
      assertCompleteEvidence({
        assetsByName,
        attestations: [attestation, structuredClone(attestation)],
        descriptor,
        descriptorSha256: "d".repeat(64),
        digestByName,
      }),
    /duplicate host attestations/i,
  );
  const staleAssets = new Map(assetsByName);
  staleAssets.set("stale-unattested.zip", {
    id: 999,
    name: "stale-unattested.zip",
  });
  assert.throws(
    () =>
      assertCompleteEvidence({
        assetsByName: staleAssets,
        attestations: [attestation],
        descriptor,
        descriptorSha256: "d".repeat(64),
        digestByName,
      }),
    /unexpected: stale-unattested\.zip/i,
  );

  const completeDigests = new Map(
    names.map((name, index) => [
      name,
      digestByName.get(name) || (index % 10).toString().repeat(64),
    ]),
  );
  const index = createReleaseAssetIndex({
    assetsByName,
    descriptor,
    descriptorSha256: "d".repeat(64),
    digestByName: completeDigests,
  });
  const indexPairDigests = new Map([
    ["release-assets.json", "6".repeat(64)],
    ["release-assets.json.asc", "7".repeat(64)],
  ]);
  const frozenDigests = new Map([...completeDigests, ...indexPairDigests]);
  const indexedAssetsByName = new Map(
    Array.from(assetsByName, ([name, asset]) => [
      name,
      { ...asset, digest: `sha256:${completeDigests.get(name)}` },
    ]),
  );
  let pairId = 1000;
  for (const [name, sha256] of indexPairDigests) {
    indexedAssetsByName.set(name, {
      id: pairId,
      name,
      digest: `sha256:${sha256}`,
    });
    pairId += 1;
  }
  assert.deepEqual(
    index.assets.filter((record) => indexPairDigests.has(record.name)),
    [],
  );
  assert.equal(
    assertReleaseAssetIndexEntries(index, indexedAssetsByName, frozenDigests),
    true,
  );
  const replacedAssets = new Map(indexedAssetsByName);
  replacedAssets.set("app.AppImage", {
    ...replacedAssets.get("app.AppImage"),
    digest: `sha256:${"f".repeat(64)}`,
  });
  assert.throws(
    () => assertReleaseAssetIndexEntries(index, replacedAssets, frozenDigests),
    /GitHub digest does not match the signed release asset index for app\.AppImage/i,
  );
  const missingRemoteDigest = new Map(indexedAssetsByName);
  missingRemoteDigest.set("app.AppImage", {
    id: missingRemoteDigest.get("app.AppImage").id,
    name: "app.AppImage",
  });
  assert.throws(
    () =>
      assertReleaseAssetIndexEntries(index, missingRemoteDigest, frozenDigests),
    /app\.AppImage has no GitHub SHA-256 digest/i,
  );
  const malformedRemoteDigest = new Map(indexedAssetsByName);
  malformedRemoteDigest.set("app.AppImage", {
    ...malformedRemoteDigest.get("app.AppImage"),
    digest: "sha256:not-a-digest",
  });
  assert.throws(
    () =>
      assertReleaseAssetIndexEntries(
        index,
        malformedRemoteDigest,
        frozenDigests,
      ),
    /app\.AppImage has no GitHub SHA-256 digest/i,
  );
  for (const pairName of indexPairDigests.keys()) {
    const missingPairMember = new Map(indexedAssetsByName);
    missingPairMember.delete(pairName);
    assert.throws(
      () =>
        assertReleaseAssetIndexEntries(index, missingPairMember, frozenDigests),
      new RegExp(`missing signed release asset index pair member ${pairName}`),
    );
    const missingPairMetadata = new Map(indexedAssetsByName);
    const pairAsset = missingPairMetadata.get(pairName);
    missingPairMetadata.set(pairName, { id: pairAsset.id, name: pairName });
    assert.throws(
      () =>
        assertReleaseAssetIndexEntries(
          index,
          missingPairMetadata,
          frozenDigests,
        ),
      new RegExp(`${pairName.replaceAll(".", "\\.")} has no GitHub SHA-256`),
    );
    const replacedPair = new Map(indexedAssetsByName);
    replacedPair.set(pairName, {
      ...replacedPair.get(pairName),
      digest: `sha256:${"f".repeat(64)}`,
    });
    assert.throws(
      () => assertReleaseAssetIndexEntries(index, replacedPair, frozenDigests),
      new RegExp(
        `GitHub digest does not match the verified release asset index pair for ${pairName.replaceAll(".", "\\.")}`,
      ),
    );
    const missingVerifiedPairDigest = new Map(frozenDigests);
    missingVerifiedPairDigest.delete(pairName);
    assert.throws(
      () =>
        assertReleaseAssetIndexEntries(
          index,
          indexedAssetsByName,
          missingVerifiedPairDigest,
        ),
      new RegExp(
        `Verified release asset index pair digest is missing for ${pairName.replaceAll(".", "\\.")}`,
      ),
    );
  }
  const latePublicAssets = new Map(indexedAssetsByName);
  latePublicAssets.set("late-public-extra.bin", {
    id: 1002,
    name: "late-public-extra.bin",
  });
  assert.throws(
    () =>
      assertReleaseAssetIndexEntries(index, latePublicAssets, frozenDigests),
    /do not exactly match the signed index/i,
  );
});

test("public checksum verification rejects missing or changed bytes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-checksums-"),
  );
  try {
    const artifactName = "app.zip";
    const checksumName = "SHA256SUMS-linux-x86_64.txt";
    const digest = "a".repeat(64);
    fs.writeFileSync(
      path.join(directory, checksumName),
      `${digest}  ${artifactName}\n`,
    );
    const assetsByName = new Map([
      [checksumName, { name: checksumName }],
      [`${checksumName}.asc`, { name: `${checksumName}.asc` }],
    ]);
    assert.doesNotThrow(() =>
      verifyChecksumFiles(
        directory,
        assetsByName,
        new Map([[artifactName, digest]]),
      ),
    );
    assert.throws(
      () =>
        verifyChecksumFiles(
          directory,
          assetsByName,
          new Map([[artifactName, "b".repeat(64)]]),
        ),
      /checksum mismatch/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("beta-to-stable transition reserves GitHub Latest for product stable releases", async () => {
  const commit = "a".repeat(40);
  const descriptor = {
    release: { id: 42, prerelease: true, tag: "v1.2.3-beta.1" },
    source: { commit },
  };
  assert.doesNotThrow(() =>
    validatePublicationRelease(
      {
        id: 42,
        draft: false,
        prerelease: true,
        tag_name: "v1.2.3-beta.1",
        target_commitish: commit,
      },
      descriptor,
    ),
  );
  assert.equal(betaManifestName("latest-darwin-beta-aarch64.json"), true);
  assert.equal(stableManifestName("latest-darwin-aarch64.json"), true);
  assert.equal(stableManifestName("latest-darwin-beta-aarch64.json"), false);
  assert.deepEqual(channelTransitionPolicy(descriptor), {
    makeLatest: "false",
    supported: false,
    reason:
      "The shipped /releases/latest updater endpoint cannot select immutable prerelease tags without an application/config endpoint migration.",
  });
  const stableDescriptor = {
    release: { id: 43, prerelease: false, tag: "v1.2.3" },
    source: { commit },
  };
  assert.deepEqual(channelTransitionPolicy(stableDescriptor), {
    makeLatest: "true",
    supported: true,
  });
  assert.throws(
    () => assertChannelTransitionSupported(descriptor),
    /disabled before any release mutation.*Latest remains reserved for stable/i,
  );
  assert.deepEqual(assertChannelTransitionSupported(stableDescriptor), {
    makeLatest: "true",
    supported: true,
  });

  const signingSource = fs.readFileSync(
    path.join(root, "scripts", "gpg-sign.js"),
    "utf8",
  );
  const publicationSource = fs.readFileSync(
    path.join(root, "scripts", "release-publication.js"),
    "utf8",
  );
  const tauriConfig = fs.readFileSync(
    path.join(root, "src-tauri", "tauri.conf.json"),
    "utf8",
  );
  assert.match(
    tauriConfig,
    /releases\/latest\/download\/latest-\{\{target\}\}-\{\{arch\}\}\.json/,
  );
  assert.match(
    publicationSource,
    /make_latest:\s*transitionPolicy\.makeLatest/,
  );
  assert.doesNotMatch(publicationSource, /updater-channel-/);
  assert.doesNotMatch(publicationSource, /githubApi\([^\n]*releases\/latest/);
  assert.doesNotMatch(publicationSource, /BETA_CHANNEL_DIRECTORY/);
  assert.doesNotMatch(
    signingSource,
    /syncBetaManifestsToLatestStable|releases\/latest/,
  );
  const preflightIndex = publicationSource.indexOf(
    "const transitionPolicy = assertChannelTransitionSupported(descriptor)",
  );
  assert.ok(preflightIndex >= 0);
  const freezeIndex = publicationSource.indexOf(
    "freezeReleaseAssetSet({",
    preflightIndex,
  );
  const finalRecheckIndex = publicationSource.indexOf(
    "await recheckFrozenReleaseAssetSet",
    freezeIndex,
  );
  const prePublicationTagIndex = publicationSource.indexOf(
    "await assertExistingGitHubTagCommit",
    finalRecheckIndex,
  );
  const publicationPatchIndex = publicationSource.indexOf(
    'githubApi(\n        "PATCH"',
    prePublicationTagIndex,
  );
  const strictPostPublicationTagIndex = publicationSource.indexOf(
    "await assertGitHubTagCommit",
    publicationPatchIndex,
  );
  assert.ok(preflightIndex < freezeIndex);
  assert.ok(freezeIndex < finalRecheckIndex);
  assert.ok(finalRecheckIndex < prePublicationTagIndex);
  assert.ok(prePublicationTagIndex < publicationPatchIndex);
  assert.ok(publicationPatchIndex < strictPostPublicationTagIndex);
  assert.doesNotMatch(publicationSource, /promoteBetaChannel/);
});

test("publication requires one semantically valid install-smoke report per target", () => {
  const target = "linux-x86_64";
  const descriptorSha256 = "d".repeat(64);
  const descriptor = {
    release: { id: 42, prerelease: false, tag: "v1.2.3", version: "1.2.3" },
    source: { commit: "c".repeat(40) },
    expectedTargets: [target],
    requiredEvidence: [
      "attestation",
      "install-smoke",
      "package-smoke",
      "provenance",
      "sbom",
    ],
  };
  const artifactName = "S3-Sidekick-Linux-x64.AppImage";
  const crossTargetArtifactName = "S3-Sidekick-Windows-x64-setup.exe";
  const attestation = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: 42,
    sourceCommit: descriptor.source.commit,
    targets: [target],
    host: { platform: "linux", arch: "x64" },
    artifacts: [
      { name: artifactName, sha256: "a".repeat(64) },
      { name: crossTargetArtifactName, sha256: "9".repeat(64) },
    ],
    evidence: [
      {
        name: "release-package-smoke-linux-x86_64.json",
        sha256: "b".repeat(64),
      },
      {
        name: "release-provenance-linux-x86_64.json",
        sha256: "c".repeat(64),
      },
      {
        name: "release-sbom-linux-x86_64.spdx.json",
        sha256: "e".repeat(64),
      },
    ],
  };
  const installSmokeName = "release-install-smoke-linux-x86_64.json";
  const names = [
    "release-descriptor.json",
    "release-descriptor.json.asc",
    artifactName,
    `${artifactName}.asc`,
    `${artifactName}.sig`,
    crossTargetArtifactName,
    `${crossTargetArtifactName}.asc`,
    `${crossTargetArtifactName}.sig`,
    "SHA256SUMS-linux-x86_64.txt",
    "SHA256SUMS-linux-x86_64.txt.asc",
    "release-attestation-linux-x86_64.json",
    "release-attestation-linux-x86_64.json.asc",
    "release-package-smoke-linux-x86_64.json",
    "release-package-smoke-linux-x86_64.json.asc",
    "release-provenance-linux-x86_64.json",
    "release-provenance-linux-x86_64.json.asc",
    "release-sbom-linux-x86_64.spdx.json",
    "release-sbom-linux-x86_64.spdx.json.asc",
    installSmokeName,
    `${installSmokeName}.asc`,
  ];
  const assetsByName = new Map(names.map((name, id) => [name, { id, name }]));
  const digestByName = new Map([
    [artifactName, "a".repeat(64)],
    [crossTargetArtifactName, "9".repeat(64)],
    ["release-package-smoke-linux-x86_64.json", "b".repeat(64)],
    ["release-provenance-linux-x86_64.json", "c".repeat(64)],
    ["release-sbom-linux-x86_64.spdx.json", "e".repeat(64)],
    [installSmokeName, "f".repeat(64)],
  ]);
  const report = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: 42,
    sourceCommit: descriptor.source.commit,
    target,
    status: "passed",
    checks: ["clean-install", "launch", "previous-version-update"],
    previousVersion: "1.2.2",
    runner: { image: "ubuntu-24.04", runId: "1234" },
    artifacts: [{ name: artifactName, sha256: "a".repeat(64) }],
  };
  const options = {
    assetsByName,
    attestations: [attestation],
    descriptor,
    descriptorSha256,
    digestByName,
  };

  assert.equal(
    assertCompleteEvidence({
      ...options,
      installSmokeReports: new Map([[target, report]]),
    }),
    true,
  );
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        installSmokeReports: new Map([
          [
            target,
            {
              ...report,
              artifacts: [
                {
                  name: crossTargetArtifactName,
                  sha256: "9".repeat(64),
                },
              ],
            },
          ],
        ]),
      }),
    /artifact mismatch/i,
  );
  const attestationWithoutTargetArtifact = {
    ...attestation,
    artifacts: [{ name: crossTargetArtifactName, sha256: "9".repeat(64) }],
  };
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        attestations: [attestationWithoutTargetArtifact],
        installSmokeReports: new Map([[target, report]]),
      }),
    /no installable artifacts for linux-x86_64/i,
  );
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        installSmokeReports: new Map([
          [target, { ...report, status: "failed" }],
        ]),
      }),
    /identity failed/i,
  );
  const missingReportAssets = new Map(assetsByName);
  missingReportAssets.delete(installSmokeName);
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        assetsByName: missingReportAssets,
        installSmokeReports: new Map([[target, report]]),
      }),
    /install\/update smoke report is missing/i,
  );
});

test("Flatpak dependencies are reconstructed from the lock with a final offline npm ci", () => {
  assert.equal(
    shouldStage(
      path.join(root, "node_modules", "tampered-package", "index.js"),
    ),
    false,
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-flatpak-deps-"),
  );
  const cacheDirectory = path.join(directory, "disposable-cache");
  const npmExecPath = path.join(directory, "npm-cli.js");
  fs.writeFileSync(npmExecPath, "// pinned npm cli fixture\n");
  const calls = [];
  try {
    const result = installFlatpakDependencies(directory, {
      environment: { npm_execpath: npmExecPath },
      execute(command, args, options) {
        calls.push({ args: [...args], command, cwd: options.cwd });
        const nodeModules = path.join(directory, "node_modules");
        if (args.includes("--offline")) {
          assert.equal(fs.existsSync(nodeModules), false);
          fs.mkdirSync(nodeModules, { recursive: true });
          fs.writeFileSync(path.join(nodeModules, "locked.txt"), "locked");
        } else {
          fs.mkdirSync(nodeModules, { recursive: true });
          fs.writeFileSync(path.join(nodeModules, "mutable.txt"), "discarded");
        }
      },
      makeCache() {
        fs.mkdirSync(cacheDirectory, { recursive: true });
        return cacheDirectory;
      },
    });
    assert.equal(result, path.join(directory, "node_modules"));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, process.execPath);
    assert.equal(calls[0].cwd, directory);
    assert.deepEqual(calls[0].args.slice(0, 2), [npmExecPath, "ci"]);
    for (const required of [
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      "--cache",
    ]) {
      assert.ok(calls[0].args.includes(required));
    }
    assert.equal(calls[0].args.includes("--offline"), false);
    assert.equal(calls[1].args.includes("--offline"), true);
    assert.equal(fs.existsSync(cacheDirectory), false);
    assert.equal(
      fs.existsSync(path.join(directory, "node_modules", "mutable.txt")),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(directory, "node_modules", "locked.txt"),
        "utf8",
      ),
      "locked",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("package inspection subprocesses cannot inherit GPG credentials", () => {
  const calls = [];
  runCheck("package-inspector", ["--info", "artifact"], {
    environment: {
      PATH: "/bin",
      GPG_KEY_ID: "release-key",
      gpg_passphrase: "release-secret",
      AZURE_ARTIFACT_SIGNING_PUBLISHER: "publisher",
    },
    execute(command, args, options) {
      calls.push({ args, command, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GPG_KEY_ID, undefined);
  assert.equal(calls[0].options.env.gpg_passphrase, undefined);
  assert.equal(
    calls[0].options.env.AZURE_ARTIFACT_SIGNING_PUBLISHER,
    "publisher",
  );
  assert.equal(calls[0].options.env.PATH, "/bin");
});

test("coordinator rejects late or replaced assets while the frozen release is still a draft", async () => {
  const sha256 = "a".repeat(64);
  const indexSha256 = "d".repeat(64);
  const indexSignatureSha256 = "e".repeat(64);
  const descriptor = {
    release: { id: 42, prerelease: false, tag: "v1.2.3" },
    source: { commit: "c".repeat(40) },
  };
  const release = {
    id: 42,
    draft: true,
    prerelease: false,
    tag_name: "v1.2.3",
    target_commitish: descriptor.source.commit,
  };
  const frozen = {
    assetIndex: {
      assets: [{ name: "artifact.zip", sha256 }],
    },
    digestByName: new Map([
      ["artifact.zip", sha256],
      ["release-assets.json", indexSha256],
      ["release-assets.json.asc", indexSignatureSha256],
    ]),
  };
  const baseAssets = [
    { id: 1, name: "artifact.zip", digest: `sha256:${sha256}` },
    {
      id: 2,
      name: "release-assets.json",
      digest: `sha256:${indexSha256}`,
    },
    {
      id: 3,
      name: "release-assets.json.asc",
      digest: `sha256:${indexSignatureSha256}`,
    },
  ];
  assert.deepEqual(
    await recheckFrozenReleaseAssetSet({
      descriptor,
      frozen,
      listAssets: async () => baseAssets,
      release,
      request: async () => release,
    }),
    baseAssets,
  );
  await assert.rejects(
    () =>
      recheckFrozenReleaseAssetSet({
        descriptor,
        frozen,
        listAssets: async () =>
          baseAssets.map((asset) =>
            asset.name === "artifact.zip"
              ? { ...asset, digest: `sha256:${"b".repeat(64)}` }
              : asset,
          ),
        release,
        request: async () => release,
      }),
    /GitHub digest does not match the signed release asset index for artifact\.zip/i,
  );
  for (const pairName of ["release-assets.json", "release-assets.json.asc"]) {
    await assert.rejects(
      () =>
        recheckFrozenReleaseAssetSet({
          descriptor,
          frozen,
          listAssets: async () =>
            baseAssets.filter((asset) => asset.name !== pairName),
          release,
          request: async () => release,
        }),
      /missing signed release asset index pair member/i,
    );
    await assert.rejects(
      () =>
        recheckFrozenReleaseAssetSet({
          descriptor,
          frozen,
          listAssets: async () =>
            baseAssets.map((asset) =>
              asset.name === pairName
                ? { ...asset, digest: `sha256:${"f".repeat(64)}` }
                : asset,
            ),
          release,
          request: async () => release,
        }),
      /GitHub digest does not match the verified release asset index pair/i,
    );
  }
  await assert.rejects(
    () =>
      recheckFrozenReleaseAssetSet({
        descriptor,
        frozen,
        listAssets: async () => [
          ...baseAssets,
          { id: 4, name: "late-extra.zip" },
        ],
        release,
        request: async () => release,
      }),
    /do not exactly match the signed index/i,
  );
});
