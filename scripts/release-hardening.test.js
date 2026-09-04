import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSanitizedSource,
  installFlatpakDependencies,
  isSecretEnvironmentFile,
  runFlatpakBuild,
  shouldStage,
  verifyFlatpakInputs,
} from "./flatpak-bundle.js";
import {
  assertUniversalMachO,
  requiredMacEnvironment,
} from "./macos-release.js";
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
  acquirePublicationSession,
  acquirePublicationSessionWithTakeover,
  assertBetaPromotionOrder,
  assertChannelTransitionSupported,
  assertCompleteEvidence,
  assertReleaseAssetIndexEntries,
  assertStableRolloverOrder,
  betaManifestName,
  channelTransitionPolicy,
  createReleaseAssetIndex,
  processStartToken,
  publicationTakeoverRequested,
  recheckFrozenReleaseAssetSet,
  stableManifestName,
  validatePublicationRelease,
  verifyChecksumFiles,
  verifyUpdaterManifests,
} from "./release-publication.js";
import {
  runWindowsBuild,
  windowsBuildCommands,
} from "./tauri-windows-build.js";
import { isUpdaterArtifact } from "./updater-sign.js";
import integrity from "./release-integrity.cjs";

const { canonicalMacosArtifactName, compareSemanticVersions } = integrity;
const root = fileURLToPath(new URL("..", import.meta.url));

function semanticEvidenceFixture(descriptor, attestation, descriptorSha256) {
  descriptor.repository ??= {
    owner: "BurntToasters",
    name: "S3-Sidekick",
  };
  descriptor.release.version ??= String(descriptor.release.tag || "").replace(
    /^v/,
    "",
  );
  descriptor.installSmokePreviousVersion ??= "1.2.2";
  descriptor.source.committedAt ??= "2026-01-01T00:00:00.000Z";
  descriptor.source.archiveSha256 ??= "1".repeat(64);
  descriptor.source.packageLockSha256 ??= "2".repeat(64);
  descriptor.source.cargoLockSha256 ??= "3".repeat(64);
  for (const record of [
    ...(attestation.artifacts || []),
    ...(attestation.evidence || []),
  ]) {
    record.size ??= 1;
  }
  const platform = attestation.host.platform;
  const osName = platform === "win32" ? "windows" : platform;
  const archName =
    attestation.host.arch === "arm64"
      ? "aarch64"
      : attestation.host.arch === "x64"
        ? "x86_64"
        : attestation.host.arch;
  const suffix = `${osName}-${archName}`;
  const artifacts = [...attestation.artifacts].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const packages = artifacts.filter((record) =>
    platform === "darwin"
      ? /\.app\.tar\.gz$/i.test(record.name) ||
        /\.(?:dmg|zip)$/i.test(record.name)
      : /\.(?:appimage|deb|dmg|exe|flatpak|msi|rpm|zip)$/i.test(record.name),
  );
  const checks =
    platform === "linux"
      ? packages
          .flatMap((record) => {
            if (/\.appimage$/i.test(record.name))
              return [`appimage-elf:${record.name}`];
            if (/\.deb$/i.test(record.name))
              return [`deb-metadata:${record.name}`];
            if (/\.rpm$/i.test(record.name))
              return [`rpm-metadata:${record.name}`];
            if (/\.flatpak$/i.test(record.name))
              return [`flatpak-bundle:${record.name}`];
            return [];
          })
          .sort()
      : platform === "darwin"
        ? [
            "universal-mach-o",
            "codesign-deep-strict",
            "gatekeeper",
            "notary-accepted",
            "quarantine-gatekeeper",
            "stapler-validate",
          ]
        : [
            "authenticode-valid",
            "installer-outer-signature",
            "installer-runtime-extracted-signature",
            "publisher-match",
            "timestamp-valid",
          ];
  const targets = [...attestation.targets].sort();
  const invocationId = createHash("sha256")
    .update(
      integrity.canonicalJson({
        artifacts,
        descriptorSha256,
        host: suffix,
        targets,
      }),
    )
    .digest("hex");
  const packageId = "SPDXRef-test-package";
  return new Map([
    [
      `release-package-smoke-${suffix}.json`,
      {
        schemaVersion: 1,
        descriptorSha256,
        targets,
        checks,
        packages,
        status: "passed",
      },
    ],
    [
      `release-provenance-${suffix}.json`,
      {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: artifacts.map((record) => ({
          name: record.name,
          digest: { sha256: record.sha256 },
        })),
        predicate: {
          buildDefinition: {
            buildType:
              "https://github.com/BurntToasters/S3-Sidekick/release-build/v1",
            externalParameters: {
              descriptorSha256,
              platformInputs: attestation.platformInputs ?? null,
              releaseId: descriptor.release.id,
              targets,
            },
            resolvedDependencies: [
              {
                uri: `git+https://github.com/${descriptor.repository.owner}/${descriptor.repository.name}@${descriptor.source.commit}`,
                digest: { sha256: descriptor.source.archiveSha256 },
              },
              {
                uri: "package-lock.json",
                digest: { sha256: descriptor.source.packageLockSha256 },
              },
              {
                uri: "src-tauri/Cargo.lock",
                digest: { sha256: descriptor.source.cargoLockSha256 },
              },
            ],
          },
          runDetails: {
            builder: { id: `local-release-host:${suffix}` },
            metadata: { invocationId },
          },
        },
      },
    ],
    [
      `release-sbom-${suffix}.spdx.json`,
      {
        SPDXID: "SPDXRef-DOCUMENT",
        creationInfo: {
          created: descriptor.source.committedAt,
          creators: ["Tool: S3-Sidekick-release-evidence"],
        },
        dataLicense: "CC0-1.0",
        documentNamespace: `https://github.com/BurntToasters/S3-Sidekick/releases/${descriptor.release.tag}/sbom/${descriptorSha256}`,
        files: artifacts.map((record) => ({
          fileName: record.name,
          checksums: [{ algorithm: "SHA256", checksumValue: record.sha256 }],
        })),
        name: `S3 Sidekick ${descriptor.release.version} release SBOM`,
        packages: [{ SPDXID: packageId }],
        relationships: [
          {
            spdxElementId: "SPDXRef-DOCUMENT",
            relationshipType: "DESCRIBES",
            relatedSpdxElement: packageId,
          },
        ],
        spdxVersion: "SPDX-2.3",
      },
    ],
  ]);
}

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
    RELEASE_DOWNLOAD_BASE_URL:
      "https://attacker.invalid/releases/download/mutable",
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
    /release-ref: org\.freedesktop\.Sdk\.Extension\.node24\/\/25\.08/,
  );
  assert.match(manifest, /test "\$\(node --version\)" = "v24\.20\.0"/);
  assert.match(manifest, /test "\$\(npm --version\)" = "12\.0\.2"/);
  assert.match(
    packageJson.scripts["build:win:x64:prepared"],
    /--bundles nsis,msi/,
  );
  assert.match(
    packageJson.scripts["build:win:arm64:prepared"],
    /--bundles nsis,msi/,
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
  const minReleaseNode = packageJson.releaseToolchain.node.replace(
    /^(?:>=|\^)\s*/,
    "",
  );
  const workflowNodeMatch = workflow.match(/NODE_VERSION: "(\d+\.\d+\.\d+)"/);
  assert.ok(workflowNodeMatch, "workflow must define NODE_VERSION");
  assert.ok(
    compareSemanticVersions(workflowNodeMatch[1], minReleaseNode) >= 0,
    `workflow NODE_VERSION (${workflowNodeMatch[1]}) must be >= releaseToolchain minimum (${minReleaseNode})`,
  );
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

test("macOS release rejects every shipped Mach-O missing either universal slice", () => {
  const appPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-universal.app-"),
  );
  const executable = path.join(appPath, "Contents", "MacOS", "S3 Sidekick");
  const library = path.join(appPath, "Contents", "Frameworks", "helper.dylib");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(library), { recursive: true });
  fs.writeFileSync(executable, "main");
  fs.writeFileSync(library, "helper");
  try {
    const execute = (command, args) => ({
      status: 0,
      stdout:
        command === "file"
          ? "Mach-O universal binary"
          : args[1] === library
            ? "x86_64 arm64\n"
            : "arm64 x86_64\n",
      stderr: "",
    });
    assert.deepEqual(assertUniversalMachO(appPath, { execute }), [
      {
        architectures: ["arm64", "x86_64"],
        path: path.join("Contents", "Frameworks", "helper.dylib"),
      },
      {
        architectures: ["arm64", "x86_64"],
        path: path.join("Contents", "MacOS", "S3 Sidekick"),
      },
    ]);
    assert.throws(
      () =>
        assertUniversalMachO(appPath, {
          execute(command, args) {
            if (command === "file") {
              return { status: 0, stdout: "Mach-O 64-bit", stderr: "" };
            }
            return {
              status: 0,
              stdout: args[1] === library ? "arm64\n" : "arm64 x86_64\n",
              stderr: "",
            };
          },
        }),
      /not exact arm64\+x86_64 universal/i,
    );
  } finally {
    fs.rmSync(appPath, { recursive: true, force: true });
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
    "universal-mach-o",
    "codesign-deep-strict",
    "notary-accepted",
    "stapler-validate",
    "gatekeeper",
    "quarantine-gatekeeper",
  ];
  const architectures = [
    {
      path: path.join("Contents", "MacOS", "S3 Sidekick"),
      architectures: ["arm64", "x86_64"],
    },
  ];
  const trustPath = path.join(directory, "macos-trust.json");
  const writeTrust = (
    artifacts,
    includeArtifacts = true,
    architectureInventory = architectures,
  ) => {
    const trust = {
      schemaVersion: 1,
      checks: requiredChecks,
      architectures: architectureInventory,
    };
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
    writeTrust(trustedArtifacts, true, []);
    assert.throws(verify, /no universal Mach-O inventory/i);
    writeTrust(trustedArtifacts, true, [
      { path: "Contents/MacOS/S3 Sidekick", architectures: ["arm64"] },
    ]);
    assert.throws(verify, /universal Mach-O inventory is invalid/i);
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
  assert.deepEqual(
    childEnvironment(
      "publish",
      { PATH: "/bin", RELEASE_PUBLICATION_TAKEOVER: "1" },
      {},
    ),
    { PATH: "/bin", RELEASE_PUBLICATION_TAKEOVER: "1" },
  );
  assert.equal(
    isUpdaterArtifact("S3-Sidekick_0.11.0-beta.5_x64-setup.exe"),
    true,
  );
  assert.equal(
    isUpdaterArtifact("S3-Sidekick_0.11.0-beta.5_arm64-setup.exe"),
    true,
  );
  assert.equal(
    isUpdaterArtifact("S3-Sidekick_0.11.0-beta.5_x64_en-US.msi"),
    false,
  );
  assert.equal(
    isUpdaterArtifact("S3-Sidekick_0.11.0-beta.5_arm64_en-US.msi"),
    false,
  );
  assert.equal(isUpdaterArtifact("S3-Sidekick-Linux-x64.AppImage"), true);
  assert.equal(isUpdaterArtifact("S3-Sidekick-Linux-x64.deb"), false);
  assert.equal(isUpdaterArtifact("S3-Sidekick-Linux-x64.rpm"), false);
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
        command.indexOf("release:stage"),
    );
    assert.equal(command.includes("release:sign:gpg"), false);
  }
  for (const name of [
    "release:win:finalize",
    "release:mac:finalize",
    "release:linux:x64:finalize",
    "release:linux:arm64:finalize",
  ]) {
    assert.match(packageJson.scripts[name], /release:sign:gpg/);
  }
});

test("release supply-chain preparation generates license inventories before checking them", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const command = packageJson.scripts["release:supply-chain"];
  assert.ok(
    command.indexOf("npm run licenses") < command.indexOf("--check-licenses"),
  );
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
  assert.equal(
    sbom.documentNamespace,
    `https://github.com/BurntToasters/S3-Sidekick/releases/v1.0.0/sbom/${"d".repeat(64)}`,
  );
  assert.equal("descriptorSha256" in sbom, false);
  assert.equal(sbom.files[0].checksums[0].algorithm, "SHA256");
});

test("publication requires complete non-overlapping target evidence", () => {
  const descriptor = {
    release: { id: 42, prerelease: true, tag: "v1.2.3-beta.1" },
    source: { commit: "commit" },
    expectedTargets: ["linux-x86_64"],
    requiredEvidence: ["attestation", "package-smoke", "provenance", "sbom"],
  };
  const packageRecords = [
    ["S3-Sidekick-Linux-x64.AppImage", "a"],
    ["S3-Sidekick-Linux-x64.deb", "4"],
    ["S3-Sidekick-Linux-x64.flatpak", "5"],
    ["S3-Sidekick-Linux-x64.rpm", "6"],
  ].map(([name, digit], index) => ({
    name,
    sha256: digit.repeat(64),
    size: 10 + index,
  }));
  const attestation = {
    schemaVersion: 1,
    descriptorSha256: "d".repeat(64),
    releaseId: 42,
    sourceCommit: "commit",
    targets: ["linux-x86_64"],
    packagesByTarget: { "linux-x86_64": packageRecords },
    host: { platform: "linux", arch: "x64" },
    artifacts: packageRecords,
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
    ...packageRecords.flatMap((record) => [record.name, `${record.name}.asc`]),
    "S3-Sidekick-Linux-x64.AppImage.sig",
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
    ...packageRecords.map((record) => [record.name, record.sha256]),
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
  replacedAssets.set("S3-Sidekick-Linux-x64.AppImage", {
    ...replacedAssets.get("S3-Sidekick-Linux-x64.AppImage"),
    digest: `sha256:${"f".repeat(64)}`,
  });
  assert.throws(
    () => assertReleaseAssetIndexEntries(index, replacedAssets, frozenDigests),
    /GitHub digest does not match the signed release asset index for S3-Sidekick-Linux-x64\.AppImage/i,
  );
  const missingRemoteDigest = new Map(indexedAssetsByName);
  missingRemoteDigest.set("S3-Sidekick-Linux-x64.AppImage", {
    id: missingRemoteDigest.get("S3-Sidekick-Linux-x64.AppImage").id,
    name: "S3-Sidekick-Linux-x64.AppImage",
  });
  assert.throws(
    () =>
      assertReleaseAssetIndexEntries(index, missingRemoteDigest, frozenDigests),
    /S3-Sidekick-Linux-x64\.AppImage has no GitHub SHA-256 digest/i,
  );
  const malformedRemoteDigest = new Map(indexedAssetsByName);
  malformedRemoteDigest.set("S3-Sidekick-Linux-x64.AppImage", {
    ...malformedRemoteDigest.get("S3-Sidekick-Linux-x64.AppImage"),
    digest: "sha256:not-a-digest",
  });
  assert.throws(
    () =>
      assertReleaseAssetIndexEntries(
        index,
        malformedRemoteDigest,
        frozenDigests,
      ),
    /S3-Sidekick-Linux-x64\.AppImage has no GitHub SHA-256 digest/i,
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

test("semantic package-smoke, provenance, and SBOM bodies are descriptor-bound", () => {
  const descriptorSha256 = "d".repeat(64);
  const descriptor = {
    repository: { owner: "BurntToasters", name: "S3-Sidekick" },
    release: {
      id: 42,
      prerelease: true,
      tag: "v1.2.3-beta.1",
      version: "1.2.3-beta.1",
    },
    source: {
      commit: "c".repeat(40),
      committedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "1".repeat(64),
      packageLockSha256: "2".repeat(64),
      cargoLockSha256: "3".repeat(64),
    },
    expectedTargets: ["linux-x86_64"],
    requiredEvidence: ["attestation", "package-smoke", "provenance", "sbom"],
  };
  const packageRecords = [
    ["S3-Sidekick-Linux-x64.AppImage", "a"],
    ["S3-Sidekick-Linux-x64.deb", "4"],
    ["S3-Sidekick-Linux-x64.flatpak", "5"],
    ["S3-Sidekick-Linux-x64.rpm", "6"],
  ].map(([name, digit], index) => ({
    name,
    sha256: digit.repeat(64),
    size: 10 + index,
  }));
  const evidenceNames = [
    "release-package-smoke-linux-x86_64.json",
    "release-provenance-linux-x86_64.json",
    "release-sbom-linux-x86_64.spdx.json",
  ];
  const attestation = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    targets: ["linux-x86_64"],
    packagesByTarget: { "linux-x86_64": packageRecords },
    host: { platform: "linux", arch: "x64" },
    platformInputs: null,
    artifacts: packageRecords,
    evidence: evidenceNames.map((name, index) => ({
      name,
      sha256: String(index + 4).repeat(64),
      size: 20 + index,
    })),
  };
  const names = [
    "release-descriptor.json",
    "release-descriptor.json.asc",
    ...packageRecords.flatMap((record) => [record.name, `${record.name}.asc`]),
    "S3-Sidekick-Linux-x64.AppImage.sig",
    "SHA256SUMS-linux-x86_64.txt",
    "SHA256SUMS-linux-x86_64.txt.asc",
    "release-attestation-linux-x86_64.json",
    "release-attestation-linux-x86_64.json.asc",
    ...evidenceNames.flatMap((name) => [name, `${name}.asc`]),
  ];
  const assetsByName = new Map(names.map((name, id) => [name, { id, name }]));
  const digestByName = new Map([
    ...packageRecords.map((record) => [record.name, record.sha256]),
    ...attestation.evidence.map((record) => [record.name, record.sha256]),
  ]);
  const evidenceByName = semanticEvidenceFixture(
    descriptor,
    attestation,
    descriptorSha256,
  );
  const options = {
    assetsByName,
    attestations: [attestation],
    descriptor,
    descriptorSha256,
    digestByName,
  };
  assert.equal(assertCompleteEvidence({ ...options, evidenceByName }), true);

  const packageTamper = structuredClone(
    evidenceByName.get("release-package-smoke-linux-x86_64.json"),
  );
  packageTamper.status = "failed";
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        evidenceByName: new Map(evidenceByName).set(
          "release-package-smoke-linux-x86_64.json",
          packageTamper,
        ),
      }),
    /package-smoke evidence/i,
  );

  const provenanceTamper = structuredClone(
    evidenceByName.get("release-provenance-linux-x86_64.json"),
  );
  provenanceTamper.subject[0].digest.sha256 = "0".repeat(64);
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        evidenceByName: new Map(evidenceByName).set(
          "release-provenance-linux-x86_64.json",
          provenanceTamper,
        ),
      }),
    /provenance evidence/i,
  );

  const sbomTamper = structuredClone(
    evidenceByName.get("release-sbom-linux-x86_64.spdx.json"),
  );
  sbomTamper.files[0].checksums[0].checksumValue = "0".repeat(64);
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        evidenceByName: new Map(evidenceByName).set(
          "release-sbom-linux-x86_64.spdx.json",
          sbomTamper,
        ),
      }),
    /SPDX SBOM evidence/i,
  );

  const omitted = new Map(evidenceByName);
  omitted.delete("release-package-smoke-linux-x86_64.json");
  assert.throws(
    () => assertCompleteEvidence({ ...options, evidenceByName: omitted }),
    /semantic evidence is missing/i,
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
      [artifactName, { name: artifactName }],
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

test("checksum manifests have duplicate-free exact per-target attestation closure", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-checksum-closure-"),
  );
  const targets = ["linux-x86_64", "windows-x86_64"];
  const descriptor = {
    expectedTargets: targets,
    requiredEvidence: ["attestation", "package-smoke", "provenance", "sbom"],
  };
  const makeAttestation = (platform, hostPlatform, artifactName, digit) => ({
    targets: [`${platform}-x86_64`],
    host: { platform: hostPlatform, arch: "x64" },
    artifacts: [{ name: artifactName, sha256: digit.repeat(64) }],
    evidence: [
      `release-package-smoke-${platform}-x86_64.json`,
      `release-provenance-${platform}-x86_64.json`,
      `release-sbom-${platform}-x86_64.spdx.json`,
    ].map((name, index) => ({
      name,
      sha256: String(Number(digit) + index + 1).repeat(64),
    })),
  });
  const attestations = [
    makeAttestation("linux", "linux", "app.AppImage", "1"),
    makeAttestation("windows", "win32", "app-setup.exe", "5"),
  ];
  const digestByName = new Map();
  const assetsByName = new Map();
  const expectedByTarget = new Map();
  for (const attestation of attestations) {
    const target = attestation.targets[0];
    const platform = target.split("-")[0];
    const attestationName = `release-attestation-${platform}-x86_64.json`;
    const records = [
      ...attestation.artifacts,
      ...attestation.evidence,
      { name: attestationName, sha256: "9".repeat(64) },
    ];
    expectedByTarget.set(target, records);
    for (const record of records) {
      assetsByName.set(record.name, { name: record.name });
      digestByName.set(record.name, record.sha256);
    }
    const checksumName = `SHA256SUMS-${target}.txt`;
    assetsByName.set(checksumName, { name: checksumName });
    assetsByName.set(`${checksumName}.asc`, { name: `${checksumName}.asc` });
    fs.writeFileSync(
      path.join(directory, checksumName),
      `${records.map((record) => `${record.sha256}  ${record.name}`).join("\n")}\n`,
    );
  }
  try {
    assert.doesNotThrow(() =>
      verifyChecksumFiles(directory, assetsByName, digestByName, {
        attestations,
        descriptor,
      }),
    );

    const linuxName = "SHA256SUMS-linux-x86_64.txt";
    const linuxRecords = expectedByTarget.get("linux-x86_64");
    fs.writeFileSync(
      path.join(directory, linuxName),
      `${linuxRecords
        .slice(1)
        .map((record) => `${record.sha256}  ${record.name}`)
        .join("\n")}\n`,
    );
    assert.throws(
      () =>
        verifyChecksumFiles(directory, assetsByName, digestByName, {
          attestations,
          descriptor,
        }),
      /does not exactly cover/i,
    );

    fs.writeFileSync(
      path.join(directory, linuxName),
      `${linuxRecords
        .map((record) => `${record.sha256}  ${record.name}`)
        .join("\n")}\n${linuxRecords[0].sha256}  ${linuxRecords[0].name}\n`,
    );
    assert.throws(
      () =>
        verifyChecksumFiles(directory, assetsByName, digestByName, {
          attestations,
          descriptor,
        }),
      /duplicate checksum entry/i,
    );

    const windowsArtifact = attestations[1].artifacts[0];
    fs.writeFileSync(
      path.join(directory, linuxName),
      `${linuxRecords
        .map((record) => `${record.sha256}  ${record.name}`)
        .join("\n")}\n${windowsArtifact.sha256}  ${windowsArtifact.name}\n`,
    );
    assert.throws(
      () =>
        verifyChecksumFiles(directory, assetsByName, digestByName, {
          attestations,
          descriptor,
        }),
      /does not exactly cover/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("updater manifests require descriptor-tagged artifacts and exact signatures", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-updater-manifest-"),
  );
  try {
    const descriptor = {
      repository: { owner: "BurntToasters", name: "S3-Sidekick" },
      release: { tag: "v0.11.0-beta.5" },
    };
    const manifestName = "latest-linux-beta-x86_64.json";
    const artifactName = "S3-Sidekick-Linux-x64.AppImage";
    const signatureName = `${artifactName}.sig`;
    const signatureText = [
      "untrusted comment: updater signature fixture",
      Buffer.concat([Buffer.from("ED"), Buffer.alloc(72)]).toString("base64"),
      "trusted comment: timestamp:1\tfile:artifact",
      Buffer.alloc(64).toString("base64"),
    ].join("\n");
    const embeddedSignature = Buffer.from(signatureText).toString("base64");
    const canonicalUrl = integrity.descriptorReleaseAssetUrl(
      descriptor,
      artifactName,
    );
    const assetsByName = new Map(
      [manifestName, artifactName, signatureName].map((name) => [
        name,
        { name },
      ]),
    );
    fs.writeFileSync(path.join(directory, artifactName), "artifact");
    fs.writeFileSync(path.join(directory, signatureName), signatureText);

    const writeManifest = (url, signature = embeddedSignature) => {
      const manifest = {
        platforms: { "linux-beta-x86_64": { url, signature } },
      };
      fs.writeFileSync(
        path.join(directory, manifestName),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    };

    writeManifest(canonicalUrl);
    assert.doesNotThrow(() =>
      verifyUpdaterManifests(directory, assetsByName, descriptor),
    );

    for (const invalidUrl of [
      canonicalUrl.replace("v0.11.0-beta.5", "v0.11.0-beta.4"),
      canonicalUrl.replace(
        "releases/download/v0.11.0-beta.5",
        "releases/latest/download",
      ),
    ]) {
      writeManifest(invalidUrl);
      assert.throws(
        () => verifyUpdaterManifests(directory, assetsByName, descriptor),
        /does not match the signed descriptor/i,
      );
    }

    writeManifest(canonicalUrl);
    assert.throws(
      () =>
        verifyUpdaterManifests(
          directory,
          new Map([...assetsByName].filter(([name]) => name !== artifactName)),
          descriptor,
        ),
      /missing artifact\/signature/i,
    );
    assert.throws(
      () =>
        verifyUpdaterManifests(
          directory,
          new Map([...assetsByName].filter(([name]) => name !== signatureName)),
          descriptor,
        ),
      /missing artifact\/signature/i,
    );
    writeManifest(canonicalUrl, "wrong-signature");
    assert.throws(
      () => verifyUpdaterManifests(directory, assetsByName, descriptor),
      /embeds the wrong signature/i,
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
    promoteBeta: true,
    supported: true,
  });
  const stableDescriptor = {
    release: { id: 43, prerelease: false, tag: "v1.2.3" },
    source: { commit },
  };
  assert.deepEqual(channelTransitionPolicy(stableDescriptor), {
    carryBeta: true,
    makeLatest: "true",
    supported: true,
  });
  assert.deepEqual(assertChannelTransitionSupported(descriptor), {
    makeLatest: "false",
    promoteBeta: true,
    supported: true,
  });
  assert.deepEqual(assertChannelTransitionSupported(stableDescriptor), {
    carryBeta: true,
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
  assert.match(
    publicationSource,
    /\/releases\/latest["`]|releases\/latest\/download/,
  );
  assert.doesNotMatch(publicationSource, /BETA_CHANNEL_DIRECTORY/);
  assert.doesNotMatch(publicationSource, /--clobber/);
  assert.doesNotMatch(
    signingSource,
    /syncBetaManifestsToLatestStable|releases\/latest/,
  );
  assert.match(signingSource, /descriptorReleaseAssetUrl\(descriptor, name\)/);
  assert.doesNotMatch(
    signingSource,
    /RELEASE_DOWNLOAD_BASE_URL|TAG_DOWNLOAD_BASE_URL|function releaseAssetUrl/,
  );
  assert.match(
    publicationSource,
    /artifactNameFromDescriptorReleaseUrl\(\s*descriptor,\s*entry\?\.url/s,
  );
});

test("publication requires one semantically valid install-smoke report per target", () => {
  const target = "linux-x86_64";
  const descriptorSha256 = "d".repeat(64);
  const descriptor = {
    release: { id: 42, prerelease: false, tag: "v1.2.3", version: "1.2.3" },
    installSmokePreviousVersion: "1.2.2",
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
  const packageRecords = [
    ["S3-Sidekick-Linux-x64.AppImage", "a"],
    ["S3-Sidekick-Linux-x64.deb", "4"],
    ["S3-Sidekick-Linux-x64.flatpak", "5"],
    ["S3-Sidekick-Linux-x64.rpm", "6"],
  ].map(([name, digit], index) => ({
    name,
    sha256: digit.repeat(64),
    size: 10 + index,
  }));
  const crossTargetArtifactName = "S3-Sidekick-Windows-x64.exe";
  const attestation = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: 42,
    sourceCommit: descriptor.source.commit,
    targets: [target],
    packagesByTarget: { [target]: packageRecords },
    host: { platform: "linux", arch: "x64" },
    artifacts: packageRecords,
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
    ...packageRecords.flatMap((record) => [record.name, `${record.name}.asc`]),
    "S3-Sidekick-Linux-x64.AppImage.sig",
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
    ...packageRecords.map((record) => [record.name, record.sha256]),
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
    artifacts: packageRecords.map(({ name, sha256 }) => ({ name, sha256 })),
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
  const attestationWithCrossTargetPackage = {
    ...attestation,
    artifacts: [
      ...packageRecords,
      {
        name: crossTargetArtifactName,
        sha256: "9".repeat(64),
        size: 99,
      },
    ],
  };
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        attestations: [attestationWithCrossTargetPackage],
        installSmokeReports: new Map([[target, report]]),
      }),
    /cross-target ownership/i,
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
              artifacts: report.artifacts.filter(
                ({ name }) => !name.endsWith(".flatpak"),
              ),
            },
          ],
        ]),
      }),
    /does not exactly cover the expected package closure/i,
  );
  const duplicateClosure = structuredClone(attestation);
  duplicateClosure.packagesByTarget[target].push(
    duplicateClosure.packagesByTarget[target][0],
  );
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        attestations: [duplicateClosure],
        installSmokeReports: new Map([[target, report]]),
      }),
    /malformed or duplicate record/i,
  );
  const wrongDigestClosure = structuredClone(attestation);
  wrongDigestClosure.packagesByTarget[target] =
    wrongDigestClosure.packagesByTarget[target].map((record, index) => ({
      ...record,
      ...(index === 0 ? { sha256: "0".repeat(64) } : {}),
    }));
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        attestations: [wrongDigestClosure],
        installSmokeReports: new Map([[target, report]]),
      }),
    /wrong digest, metadata, or target ownership/i,
  );
  const incompleteClosure = structuredClone(attestation);
  incompleteClosure.packagesByTarget[target] =
    incompleteClosure.packagesByTarget[target].filter(
      ({ name }) => !name.endsWith(".rpm"),
    );
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        attestations: [incompleteClosure],
        installSmokeReports: new Map([[target, report]]),
      }),
    /package closure is incomplete.*\.rpm/i,
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

test("publication requires the universal macOS package trio for both Darwin targets", () => {
  const targets = ["darwin-aarch64", "darwin-x86_64"];
  const descriptorSha256 = "7".repeat(64);
  const descriptor = {
    release: { id: 43, prerelease: false, tag: "v1.2.3", version: "1.2.3" },
    installSmokePreviousVersion: "1.2.2",
    source: { commit: "8".repeat(40) },
    expectedTargets: targets,
    requiredEvidence: ["install-smoke"],
  };
  const packageRecords = [
    ["S3-Sidekick-macOS.app.tar.gz", "1"],
    ["S3-Sidekick-macOS.dmg", "2"],
    ["S3-Sidekick-macOS.zip", "3"],
  ].map(([name, digit], index) => ({
    name,
    sha256: digit.repeat(64),
    size: 20 + index,
  }));
  const attestation = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    targets,
    packagesByTarget: Object.fromEntries(
      targets.map((target) => [target, packageRecords]),
    ),
    host: { platform: "darwin", arch: "x64" },
    artifacts: packageRecords,
    evidence: [],
  };
  const reportFor = (target) => ({
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
    target,
    status: "passed",
    checks: ["clean-install", "launch", "previous-version-update"],
    previousVersion: "1.2.2",
    runner: { image: "macos-15", runId: `run-${target}` },
    artifacts: packageRecords.map(({ name, sha256 }) => ({ name, sha256 })),
  });
  const reportNames = targets.map(
    (target) => `release-install-smoke-${target}.json`,
  );
  const names = [
    "release-descriptor.json",
    "release-descriptor.json.asc",
    ...packageRecords.flatMap((record) => [record.name, `${record.name}.asc`]),
    "S3-Sidekick-macOS.app.tar.gz.sig",
    ...targets.flatMap((target) => [
      `SHA256SUMS-${target}.txt`,
      `SHA256SUMS-${target}.txt.asc`,
    ]),
    "release-attestation-darwin-x86_64.json",
    "release-attestation-darwin-x86_64.json.asc",
    ...reportNames.flatMap((name) => [name, `${name}.asc`]),
  ];
  const assetsByName = new Map(names.map((name, id) => [name, { id, name }]));
  const digestByName = new Map(
    packageRecords.map((record) => [record.name, record.sha256]),
  );
  const reports = new Map(targets.map((target) => [target, reportFor(target)]));
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
      installSmokeReports: reports,
    }),
    true,
  );
  const incomplete = new Map(reports);
  incomplete.set("darwin-aarch64", {
    ...reportFor("darwin-aarch64"),
    artifacts: reportFor("darwin-aarch64").artifacts.slice(0, -1),
  });
  assert.throws(
    () =>
      assertCompleteEvidence({
        ...options,
        installSmokeReports: incomplete,
      }),
    /does not exactly cover the expected package closure/i,
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
    expectedTargets: ["linux-x86_64"],
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
test("release channel progression uses strict SemVer precedence and preserves exact retries", () => {
  assert.equal(compareSemanticVersions("1.2.3-beta.10", "1.2.3-beta.2"), 1);
  assert.equal(compareSemanticVersions("1.2.3+build.2", "1.2.3+build.1"), 0);
  assert.equal(compareSemanticVersions("1.2.3", "1.2.3-rc.1"), 1);
  assert.throws(
    () => compareSemanticVersions("1.2.03", "1.2.3"),
    /non-strict semantic versions/i,
  );

  const sourceDescriptor = {
    release: {
      id: 84,
      prerelease: true,
      tag: "v1.2.4-beta.10",
      version: "1.2.4-beta.10",
    },
    source: { commit: "c".repeat(40) },
  };
  const sourceDescriptorSha256 = "a".repeat(64);
  const carrierContext = {
    carrierDescriptor: { release: { version: "1.2.3" } },
    channelState: {
      source: {
        descriptorSha256: "b".repeat(64),
        id: 83,
        sourceCommit: "b".repeat(40),
        tag: "v1.2.4-beta.2",
        version: "1.2.4-beta.2",
      },
    },
  };
  assert.equal(
    assertBetaPromotionOrder(
      sourceDescriptor,
      sourceDescriptorSha256,
      carrierContext,
    ),
    "advance",
  );
  assert.throws(
    () =>
      assertBetaPromotionOrder(
        {
          ...sourceDescriptor,
          release: {
            ...sourceDescriptor.release,
            tag: "v1.2.4-beta.1",
            version: "1.2.4-beta.1",
          },
        },
        "d".repeat(64),
        carrierContext,
      ),
    /does not advance installed beta/i,
  );
  assert.throws(
    () =>
      assertBetaPromotionOrder(
        {
          ...sourceDescriptor,
          release: {
            ...sourceDescriptor.release,
            tag: "v1.2.3+candidate",
            version: "1.2.3+candidate",
          },
        },
        "d".repeat(64),
        carrierContext,
      ),
    /does not advance stable carrier/i,
  );

  const exactRetryContext = {
    carrierDescriptor: { release: { version: "1.2.4" } },
    channelState: {
      source: {
        descriptorSha256: sourceDescriptorSha256,
        id: sourceDescriptor.release.id,
        sourceCommit: sourceDescriptor.source.commit,
        tag: sourceDescriptor.release.tag,
        version: sourceDescriptor.release.version,
      },
    },
  };
  assert.equal(
    assertBetaPromotionOrder(
      sourceDescriptor,
      sourceDescriptorSha256,
      exactRetryContext,
    ),
    "unchanged",
  );
  assert.throws(
    () =>
      assertBetaPromotionOrder(
        {
          ...sourceDescriptor,
          release: { ...sourceDescriptor.release, id: 999 },
        },
        sourceDescriptorSha256,
        exactRetryContext,
      ),
    /source identity is inconsistent/i,
  );

  assert.equal(
    assertStableRolloverOrder(
      { release: { version: "1.2.4" } },
      { release: { version: "1.2.3" } },
    ),
    true,
  );
  for (const version of ["1.2.3", "1.2.3+rebuilt", "1.2.2", "1.2.3-rc.1"]) {
    assert.throws(
      () =>
        assertStableRolloverOrder(
          { release: { version } },
          { release: { version: "1.2.3" } },
        ),
      /does not advance GitHub Latest/i,
    );
  }
});
test("publication process identity uses native subsecond or boot-relative start tokens", () => {
  const first = processStartToken(process.pid);
  const second = processStartToken(process.pid);
  assert.match(first || "", /^(?:darwin|linux|windows):/);
  assert.equal(second, first);

  const resolveDarwinToken = (microseconds) =>
    processStartToken(4242, {
      platform: "darwin",
      spawn: (command, arguments_, options) => {
        assert.equal(command, "/usr/bin/xcrun");
        assert.equal(arguments_[0], "swift");
        assert.match(arguments_[2], /proc_pidinfo\(4242,/);
        assert.equal(options.shell, false);
        return { status: 0, stdout: `1788220648:${microseconds}\n` };
      },
    });
  assert.notEqual(resolveDarwinToken(100), resolveDarwinToken(200));
});

test("publication sessions serialize locally and retain descriptor-scoped owners across cleanup and interleaving", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-publication-session-"),
  );
  const stateDirectory = path.join(workspace, ".release-state");
  const descriptor = {
    release: { id: 84 },
    source: { commit: "c".repeat(40) },
  };
  const descriptorSha256 = "d".repeat(64);
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  try {
    const first = acquirePublicationSession(descriptor, descriptorSha256, {
      sessionIdFactory: () => sessionId,
      stateDirectory,
    });
    assert.equal(first.owner.sessionId, sessionId);
    assert.throws(
      () =>
        acquirePublicationSession(descriptor, descriptorSha256, {
          stateDirectory,
        }),
      /another release publication process owns/i,
    );
    first.release();
    first.release();

    const releaseDirectory = path.join(workspace, "release");
    fs.mkdirSync(releaseDirectory);
    fs.writeFileSync(path.join(releaseDirectory, "artifact"), "temporary");
    fs.rmSync(releaseDirectory, { recursive: true });

    const otherDescriptor = {
      release: { id: 85 },
      source: { commit: "e".repeat(40) },
    };
    const otherDescriptorSha256 = "f".repeat(64);
    const other = acquirePublicationSession(
      otherDescriptor,
      otherDescriptorSha256,
      {
        sessionIdFactory: () => "223e4567-e89b-42d3-a456-426614174000",
        stateDirectory,
      },
    );
    assert.notEqual(other.owner.sessionId, first.owner.sessionId);
    other.release();

    const retry = acquirePublicationSession(descriptor, descriptorSha256, {
      sessionIdFactory: () => "323e4567-e89b-42d3-a456-426614174000",
      stateDirectory,
    });
    assert.deepEqual(retry.owner, first.owner);
    retry.release();
    assert.equal(fs.readdirSync(path.join(stateDirectory, "owners")).length, 2);

    const lockDirectory = path.join(
      stateDirectory,
      "release-publication-locks",
    );
    const staleLockPath = path.join(
      lockDirectory,
      "423e4567-e89b-42d3-a456-426614174000.json",
    );
    fs.writeFileSync(
      staleLockPath,
      JSON.stringify({
        schemaVersion: 1,
        descriptorSha256,
        lockId: "423e4567-e89b-42d3-a456-426614174000",
        pid: process.pid,
        processStartToken: "stale-process-instance",
      }),
      { mode: 0o600 },
    );
    const recovered = acquirePublicationSession(descriptor, descriptorSha256, {
      lockIdFactory: () => "523e4567-e89b-42d3-a456-426614174000",
      processIdentity: () => "current-process-instance",
      stateDirectory,
    });
    assert.deepEqual(recovered.owner, first.owner);
    recovered.release();
    assert.equal(fs.existsSync(staleLockPath), true);

    const malformedLockPath = path.join(lockDirectory, "crash-residue.json");
    fs.writeFileSync(malformedLockPath, "incomplete crash residue", {
      mode: 0o600,
    });
    const ownerlessRecovery = acquirePublicationSession(
      descriptor,
      descriptorSha256,
      {
        lockIdFactory: () => "623e4567-e89b-42d3-a456-426614174000",
        processIdentity: () => "current-process-instance",
        stateDirectory,
      },
    );
    assert.deepEqual(ownerlessRecovery.owner, first.owner);
    ownerlessRecovery.release();
    assert.equal(fs.existsSync(malformedLockPath), true);

    let interleavedAttempted = false;
    const interleaved = acquirePublicationSession(
      descriptor,
      descriptorSha256,
      {
        afterLockInstalled: () => {
          interleavedAttempted = true;
          assert.throws(
            () =>
              acquirePublicationSession(descriptor, descriptorSha256, {
                lockIdFactory: () => "823e4567-e89b-42d3-a456-426614174000",
                processIdentity: () => "current-process-instance",
                stateDirectory,
              }),
            /another release publication process owns/i,
          );
        },
        lockIdFactory: () => "723e4567-e89b-42d3-a456-426614174000",
        processIdentity: () => "current-process-instance",
        stateDirectory,
      },
    );
    assert.equal(interleavedAttempted, true);
    interleaved.release();
    assert.deepEqual(fs.readdirSync(lockDirectory).sort(), [
      "423e4567-e89b-42d3-a456-426614174000.json",
      "crash-residue.json",
    ]);
    assert.equal(
      fs.statSync(
        path.join(stateDirectory, "owners", `${descriptorSha256}.json`),
      ).mode & 0o777,
      0o600,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("explicit cross-host takeover adopts only stable remote owner evidence under lock and CAS", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-owner-takeover-"),
  );
  const descriptor = {
    release: { id: 84 },
    source: { commit: "c".repeat(40) },
  };
  const descriptorSha256 = "d".repeat(64);
  const remoteOwner = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    sourceCommit: descriptor.source.commit,
  };
  const evidence = {
    descriptorSha256,
    evidence: [
      {
        assets: [
          {
            id: 700,
            name: "beta-channel-transaction.json",
            sha256: "a".repeat(64),
          },
          {
            id: 701,
            name: "beta-channel-transaction.json.asc",
            sha256: "b".repeat(64),
          },
        ],
        kind: "beta-transaction",
        operationId: "e".repeat(64),
      },
    ],
    owner: remoteOwner,
    releaseId: descriptor.release.id,
    sourceCommit: descriptor.source.commit,
  };
  try {
    assert.equal(publicationTakeoverRequested([], {}), false);
    assert.equal(
      publicationTakeoverRequested(["--takeover-publication-owner"], {}),
      true,
    );
    assert.equal(
      publicationTakeoverRequested([], { RELEASE_PUBLICATION_TAKEOVER: "1" }),
      true,
    );
    assert.throws(
      () =>
        publicationTakeoverRequested([], {
          RELEASE_PUBLICATION_TAKEOVER: "true",
        }),
      /exactly 0 or 1/i,
    );

    const takeoverState = path.join(workspace, "takeover-state");
    let resolutions = 0;
    let lockObserved = false;
    const takeover = await acquirePublicationSessionWithTakeover(
      descriptor,
      descriptorSha256,
      {
        resolveTakeoverEvidence: async () => {
          resolutions += 1;
          if (!lockObserved) {
            lockObserved = true;
            assert.throws(
              () =>
                acquirePublicationSession(descriptor, descriptorSha256, {
                  stateDirectory: takeoverState,
                }),
              /another release publication process owns/i,
            );
          }
          return structuredClone(evidence);
        },
        stateDirectory: takeoverState,
        takeover: true,
      },
    );
    assert.equal(resolutions, 2);
    assert.equal(lockObserved, true);
    assert.deepEqual(takeover.owner, remoteOwner);
    assert.deepEqual(takeover.takeoverEvidence, evidence);
    takeover.release();
    const installedOwnerPath = path.join(
      takeoverState,
      "owners",
      `${descriptorSha256}.json`,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(installedOwnerPath, "utf8")),
      remoteOwner,
    );
    assert.equal(fs.statSync(installedOwnerPath).mode & 0o777, 0o600);

    const changingState = path.join(workspace, "changing-state");
    let changingCalls = 0;
    await assert.rejects(
      () =>
        acquirePublicationSessionWithTakeover(descriptor, descriptorSha256, {
          resolveTakeoverEvidence: async () => {
            changingCalls += 1;
            const value = structuredClone(evidence);
            if (changingCalls === 2) {
              value.evidence[0].operationId = "f".repeat(64);
            }
            return value;
          },
          stateDirectory: changingState,
          takeover: true,
        }),
      /evidence changed during takeover/i,
    );
    assert.equal(
      fs.existsSync(
        path.join(changingState, "owners", `${descriptorSha256}.json`),
      ),
      false,
    );

    const casState = path.join(workspace, "cas-state");
    let casCalls = 0;
    await assert.rejects(
      () =>
        acquirePublicationSessionWithTakeover(descriptor, descriptorSha256, {
          resolveTakeoverEvidence: async () => {
            casCalls += 1;
            if (casCalls === 2) {
              const ownerDirectory = path.join(casState, "owners");
              fs.mkdirSync(ownerDirectory, { recursive: true });
              fs.writeFileSync(
                path.join(ownerDirectory, `${descriptorSha256}.json`),
                JSON.stringify({
                  ...remoteOwner,
                  sessionId: "223e4567-e89b-42d3-a456-426614174000",
                }),
                { mode: 0o600 },
              );
            }
            return structuredClone(evidence);
          },
          stateDirectory: casState,
          takeover: true,
        }),
      /compare-and-swap lost to a conflicting owner/i,
    );

    await assert.rejects(
      () =>
        acquirePublicationSessionWithTakeover(descriptor, descriptorSha256, {
          resolveTakeoverEvidence: async () => {
            throw new Error("no complete signed remote owner evidence");
          },
          stateDirectory: path.join(workspace, "singleton-state"),
          takeover: true,
        }),
      /no complete signed remote owner evidence/i,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("stable product closure excludes only exact signed channel controls and receipts", () => {
  const descriptor = {
    expectedTargets: ["linux-x86_64"],
    release: { prerelease: false },
  };
  const productDigest = "a".repeat(64);
  const indexDigest = "b".repeat(64);
  const signatureDigest = "c".repeat(64);
  const index = {
    assets: [{ name: "stable-product.zip", sha256: productDigest }],
  };
  const assets = new Map([
    [
      "stable-product.zip",
      {
        id: 1,
        name: "stable-product.zip",
        digest: `sha256:${productDigest}`,
      },
    ],
    [
      "release-assets.json",
      {
        id: 2,
        name: "release-assets.json",
        digest: `sha256:${indexDigest}`,
      },
    ],
    [
      "release-assets.json.asc",
      {
        id: 3,
        name: "release-assets.json.asc",
        digest: `sha256:${signatureDigest}`,
      },
    ],
    [
      "beta-channel-rollover.json",
      {
        id: 4,
        name: "beta-channel-rollover.json",
        digest: `sha256:${"d".repeat(64)}`,
      },
    ],
    [
      "beta-channel-rollover.json.asc",
      {
        id: 5,
        name: "beta-channel-rollover.json.asc",
        digest: `sha256:${"e".repeat(64)}`,
      },
    ],
    [
      "stable-rollover-receipt.json",
      {
        id: 6,
        name: "stable-rollover-receipt.json",
        digest: `sha256:${"f".repeat(64)}`,
      },
    ],
    [
      "stable-rollover-receipt.json.asc",
      {
        id: 7,
        name: "stable-rollover-receipt.json.asc",
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
  ]);
  const digests = new Map([
    ["stable-product.zip", productDigest],
    ["release-assets.json", indexDigest],
    ["release-assets.json.asc", signatureDigest],
  ]);
  assert.equal(
    assertReleaseAssetIndexEntries(index, assets, digests, descriptor),
    true,
  );

  const nearMatch = new Map(assets);
  nearMatch.set("stable-rollover-receipt.json.backup", {
    id: 8,
    name: "stable-rollover-receipt.json.backup",
    digest: `sha256:${"2".repeat(64)}`,
  });
  assert.throws(
    () => assertReleaseAssetIndexEntries(index, nearMatch, digests, descriptor),
    /do not exactly match the signed index/i,
  );
});
