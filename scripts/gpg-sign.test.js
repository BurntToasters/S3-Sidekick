import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLinuxX64PackageSet,
  cleanArtifactBaseName,
  generateUpdaterManifests,
  normalizeUpdaterSignature,
  orderHostUploadFiles,
  runGpg,
  signFile,
  targetKeysForArtifactName,
  uploadImmutableDraftAsset,
  verifyUpdaterSignature,
} from "./gpg-sign.js";
import {
  buildPackagesByTarget,
  loadInstallSmokeReports,
  validateInstallSmokePackageClosure,
} from "./release-evidence.js";
import { resolveInstallSmokeArtifacts } from "./record-install-smoke.js";

test("raw Tauri Windows outputs keep MSI out of updater manifests", () => {
  const rawNames = [
    "S3-Sidekick_0.11.0-beta.5_x64-setup.exe",
    "S3-Sidekick_0.11.0-beta.5_arm64-setup.exe",
    "S3-Sidekick_0.11.0-beta.5_x64_en-US.msi",
    "S3-Sidekick_0.11.0-beta.5_arm64_en-US.msi",
  ];
  const canonicalNames = rawNames.map(cleanArtifactBaseName);
  assert.deepEqual(canonicalNames, [
    "S3-Sidekick-Windows-x64.exe",
    "S3-Sidekick-Windows-arm64.exe",
    "S3-Sidekick-Windows-x64.msi",
    "S3-Sidekick-Windows-arm64.msi",
  ]);
  assert.equal(
    cleanArtifactBaseName("S3 Sidekick_0.11.0-beta.5_x64_en-US.msi"),
    "S3-Sidekick-Windows-x64.msi",
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-windows-manifests-"),
  );
  try {
    const artifacts = canonicalNames.map((name) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `artifact:${name}\n`);
      return filePath;
    });
    const signatures = artifacts
      .filter((filePath) => filePath.endsWith(".exe"))
      .map((filePath) => {
        const signaturePath = `${filePath}.sig`;
        fs.writeFileSync(
          signaturePath,
          `signature:${path.basename(filePath)}\n`,
        );
        return signaturePath;
      });
    const verified = [];
    const generated = generateUpdaterManifests(
      [...artifacts, ...signatures],
      {
        repository: { owner: "BurntToasters", name: "S3-Sidekick" },
        release: { tag: "v0.11.0-beta.5" },
      },
      {
        normalizeSignature: (signaturePath) =>
          `encoded:${path.basename(signaturePath)}`,
        outputDirectory: directory,
        verifySignature: (artifactPath, signaturePath) => {
          verified.push([
            path.basename(artifactPath),
            path.basename(signaturePath),
          ]);
          return true;
        },
      },
    );

    assert.deepEqual(verified, [
      ["S3-Sidekick-Windows-x64.exe", "S3-Sidekick-Windows-x64.exe.sig"],
      ["S3-Sidekick-Windows-arm64.exe", "S3-Sidekick-Windows-arm64.exe.sig"],
    ]);
    assert.deepEqual(
      generated.map((filePath) => path.basename(filePath)).sort(),
      [
        "latest-windows-aarch64.json",
        "latest-windows-beta-aarch64.json",
        "latest-windows-beta-x86_64.json",
        "latest-windows-x86_64.json",
      ],
    );
    for (const manifestPath of generated) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const entries = Object.entries(manifest.platforms);
      assert.ok(entries.some(([key]) => key.endsWith("-nsis")));
      assert.equal(
        entries.some(([key]) => key.endsWith("-msi")),
        false,
      );
      for (const [, entry] of entries) {
        assert.match(entry.url, /S3-Sidekick-Windows-(?:x64|arm64)\.exe$/);
        assert.doesNotMatch(entry.url, /\.msi$/i);
      }
    }

    const packageRecords = artifacts.map((filePath) => ({
      name: path.basename(filePath),
      sha256: createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex"),
      size: fs.statSync(filePath).size,
    }));
    const packagesByTarget = buildPackagesByTarget(packageRecords, [
      "windows-x86_64",
      "windows-aarch64",
    ]);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(packagesByTarget).map(([target, records]) => [
          target,
          records.map((record) => record.name),
        ]),
      ),
      {
        "windows-aarch64": [
          "S3-Sidekick-Windows-arm64.exe",
          "S3-Sidekick-Windows-arm64.msi",
        ],
        "windows-x86_64": [
          "S3-Sidekick-Windows-x64.exe",
          "S3-Sidekick-Windows-x64.msi",
        ],
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeMinisignFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicBytes = publicDer.subarray(publicDer.length - 32);
  const keyId = Buffer.from("12345678");
  const publicText =
    "untrusted comment: minisign public key: test\n" +
    `${Buffer.concat([Buffer.from("Ed"), keyId, publicBytes]).toString("base64")}\n`;

  const content = Buffer.from("release artifact");
  const digest = createHash("blake2b512").update(content).digest();
  const artifactSignature = sign(null, digest, privateKey);
  const trustedComment = "timestamp:1\tfile:artifact";
  const globalSignature = sign(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signatureText =
    "untrusted comment: signature from minisign secret key\n" +
    `${Buffer.concat([Buffer.from("ED"), keyId, artifactSignature]).toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSignature.toString("base64")}\n`;

  return {
    content,
    publicKey: Buffer.from(publicText).toString("base64"),
    signatureText,
  };
}

function makeStagedPackageFixture(names) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-package-closure-"),
  );
  const releaseDirectory = path.join(root, "release");
  fs.mkdirSync(releaseDirectory);
  for (const name of names) {
    fs.writeFileSync(path.join(releaseDirectory, name), `package:${name}\n`);
  }
  return { releaseDirectory, root };
}

function resolveFixtureArtifacts(fixture, target, names) {
  return resolveInstallSmokeArtifacts({
    artifactInputs: names.map((name) => `release/${name}`),
    releaseDirectory: fixture.releaseDirectory,
    rootDirectory: fixture.root,
    target,
  });
}

function installSmokeReport(target, artifacts) {
  return {
    schemaVersion: 1,
    descriptorSha256: "d".repeat(64),
    releaseId: 42,
    sourceCommit: "c".repeat(40),
    target,
    status: "passed",
    checks: ["clean-install", "launch", "previous-version-update"],
    previousVersion: "1.2.2",
    runner: { image: "clean-test-image", runId: `run-${target}` },
    artifacts,
  };
}

test("package target ownership includes package-only formats without changing updater artifacts", () => {
  assert.deepEqual(targetKeysForArtifactName("S3-Sidekick-macOS.dmg"), [
    "darwin-aarch64",
    "darwin-x86_64",
  ]);
  assert.deepEqual(targetKeysForArtifactName("S3-Sidekick-macOS.zip"), [
    "darwin-aarch64",
    "darwin-x86_64",
  ]);
  assert.deepEqual(targetKeysForArtifactName("S3-Sidekick-Linux-x64.flatpak"), [
    "linux-x86_64",
  ]);
  assert.deepEqual(targetKeysForArtifactName("latest-linux-beta-x86_64.json"), [
    "linux-x86_64",
  ]);
  assert.deepEqual(
    targetKeysForArtifactName("S3-Sidekick_0.11.0_x64.nsis.zip"),
    [],
  );
});

test("Linux install-smoke arguments require all four staged packages and reject duplicates or cross-target packages", () => {
  const x64Packages = [
    "S3-Sidekick-Linux-x64.AppImage",
    "S3-Sidekick-Linux-x64.deb",
    "S3-Sidekick-Linux-x64.rpm",
    "S3-Sidekick-Linux-x64.flatpak",
  ];
  const arm64Package = "S3-Sidekick-Linux-arm64.AppImage";
  const fixture = makeStagedPackageFixture([...x64Packages, arm64Package]);
  try {
    assert.deepEqual(
      resolveFixtureArtifacts(fixture, "linux-x86_64", x64Packages).map(
        (record) => record.name,
      ),
      [...x64Packages].sort(),
    );
    assert.throws(
      () =>
        resolveFixtureArtifacts(
          fixture,
          "linux-x86_64",
          x64Packages.slice(0, -1),
        ),
      /exactly equal.*missing.*flatpak/i,
    );
    assert.throws(
      () =>
        resolveFixtureArtifacts(fixture, "linux-x86_64", [
          ...x64Packages,
          x64Packages[0],
        ]),
      /duplicates/i,
    );
    assert.throws(
      () =>
        resolveFixtureArtifacts(fixture, "linux-x86_64", [
          ...x64Packages.slice(1),
          arm64Package,
        ]),
      /does not belong to linux-x86_64/i,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("required Linux and macOS package formats cannot disappear from the staged closure", () => {
  for (const fixtureCase of [
    {
      names: [
        "S3-Sidekick-Linux-x64.AppImage",
        "S3-Sidekick-Linux-x64.deb",
        "S3-Sidekick-Linux-x64.rpm",
      ],
      missing: /missing: .*flatpak/i,
      target: "linux-x86_64",
    },
    {
      names: ["S3-Sidekick-macOS.app.tar.gz", "S3-Sidekick-macOS.dmg"],
      missing: /missing: .*macOS\.zip/i,
      target: "darwin-aarch64",
    },
  ]) {
    const fixture = makeStagedPackageFixture(fixtureCase.names);
    try {
      assert.throws(
        () =>
          resolveFixtureArtifacts(
            fixture,
            fixtureCase.target,
            fixtureCase.names,
          ),
        fixtureCase.missing,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("universal macOS install-smoke and signed ownership closures require all three packages for both targets", () => {
  const packageNames = [
    "S3-Sidekick-macOS.app.tar.gz",
    "S3-Sidekick-macOS.dmg",
    "S3-Sidekick-macOS.zip",
  ];
  const targets = ["darwin-aarch64", "darwin-x86_64"];
  const fixture = makeStagedPackageFixture(packageNames);
  try {
    const artifactsByTarget = new Map(
      targets.map((target) => [
        target,
        resolveFixtureArtifacts(fixture, target, packageNames),
      ]),
    );
    for (const artifacts of artifactsByTarget.values()) {
      assert.deepEqual(
        artifacts.map((record) => record.name),
        [...packageNames].sort(),
      );
    }
    assert.throws(
      () =>
        resolveFixtureArtifacts(
          fixture,
          "darwin-aarch64",
          packageNames.slice(0, -1),
        ),
      /exactly equal.*missing.*macOS\.zip/i,
    );

    const packageRecords = artifactsByTarget
      .get("darwin-aarch64")
      .map((record) => ({ ...record, size: 1 }));
    const packagesByTarget = buildPackagesByTarget(packageRecords, targets);
    assert.throws(
      () => buildPackagesByTarget(packageRecords.slice(0, -1), targets),
      /package closure is incomplete.*macOS\.zip/i,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(packagesByTarget).map(([target, records]) => [
          target,
          records.map((record) => record.name),
        ]),
      ),
      {
        "darwin-aarch64": [...packageNames].sort(),
        "darwin-x86_64": [...packageNames].sort(),
      },
    );
    const packageSmoke = {
      schemaVersion: 1,
      descriptorSha256: "d".repeat(64),
      targets,
      status: "passed",
      checks: [],
      packages: packageRecords,
    };
    const closureOptions = {
      descriptor: {
        release: { id: 42, version: "1.2.3" },
        installSmokePreviousVersion: "1.2.2",
        source: { commit: "c".repeat(40) },
      },
      descriptorSha256: "d".repeat(64),
      installSmokeReports: targets.map((target) =>
        installSmokeReport(target, artifactsByTarget.get(target)),
      ),
      packageSmoke,
      packagesByTarget,
    };
    assert.equal(validateInstallSmokePackageClosure(closureOptions), true);
    assert.throws(
      () =>
        validateInstallSmokePackageClosure({
          ...closureOptions,
          installSmokeReports: [
            installSmokeReport(
              "darwin-aarch64",
              artifactsByTarget.get("darwin-aarch64").slice(0, -1),
            ),
            installSmokeReport(
              "darwin-x86_64",
              artifactsByTarget.get("darwin-x86_64"),
            ),
          ],
        }),
      /does not exactly cover.*package closure/i,
    );

    const aarch64ReportPath = path.join(
      fixture.releaseDirectory,
      "release-install-smoke-darwin-aarch64.json",
    );
    const x64ReportPath = path.join(
      fixture.releaseDirectory,
      "release-install-smoke-darwin-x86_64.json",
    );
    fs.writeFileSync(
      aarch64ReportPath,
      JSON.stringify(
        installSmokeReport(
          "darwin-x86_64",
          artifactsByTarget.get("darwin-x86_64"),
        ),
      ),
    );
    fs.writeFileSync(
      x64ReportPath,
      JSON.stringify(
        installSmokeReport(
          "darwin-aarch64",
          artifactsByTarget.get("darwin-aarch64"),
        ),
      ),
    );
    assert.throws(
      () => loadInstallSmokeReports([aarch64ReportPath, x64ReportPath]),
      /filename .* does not match body target/i,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verifies Minisign updater signatures and rejects tampering", () => {
  const { content, publicKey, signatureText } = makeMinisignFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-sign-"));
  try {
    const artifact = path.join(root, "artifact.AppImage");
    const signature = path.join(root, "artifact.AppImage.sig");
    fs.writeFileSync(artifact, content);
    fs.writeFileSync(signature, signatureText);

    assert.equal(verifyUpdaterSignature(artifact, signature, publicKey), true);
    assert.equal(
      normalizeUpdaterSignature(signature),
      Buffer.from(signatureText.trim()).toString("base64"),
    );

    fs.writeFileSync(artifact, Buffer.from("tampered artifact"));
    assert.throws(
      () => verifyUpdaterSignature(artifact, signature, publicKey),
      /verification failed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects empty and malformed updater signatures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-sign-"));
  try {
    const signature = path.join(root, "artifact.sig");
    fs.writeFileSync(signature, "");
    assert.throws(() => normalizeUpdaterSignature(signature), /empty/i);
    fs.writeFileSync(signature, "not a minisign signature");
    assert.throws(
      () => normalizeUpdaterSignature(signature),
      /base64|malformed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires complete Linux x86_64 package set", () => {
  assert.throws(
    () =>
      assertLinuxX64PackageSet(
        new Map([["S3-Sidekick-Linux-x64.AppImage", "artifact"]]),
      ),
    /missing deb, rpm/i,
  );
  assert.doesNotThrow(() =>
    assertLinuxX64PackageSet(
      new Map([
        ["S3-Sidekick-Linux-x64.AppImage", "appimage"],
        ["S3-Sidekick-Linux-x64.deb", "deb"],
        ["S3-Sidekick-Linux-x64.rpm", "rpm"],
        ["S3-Sidekick-Linux-arm64.AppImage", "appimage-arm64"],
        ["S3-Sidekick-Linux-arm64.deb", "deb-arm64"],
        ["S3-Sidekick-Linux-arm64.rpm", "rpm-arm64"],
      ]),
    ),
  );
  assert.throws(
    () =>
      assertLinuxX64PackageSet(
        new Map([
          ["S3-Sidekick-Linux-arm64.AppImage", "appimage"],
          ["S3-Sidekick-Linux-arm64.deb", "deb"],
        ]),
      ),
    /Linux aarch64 bundle set.*missing rpm/i,
  );
});

test("Linux AppImage+DEB+RPM generation emits AppImage-only updater entries without package .sig files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-linux-manifests-"),
  );
  try {
    const appImage = path.join(directory, "S3-Sidekick-Linux-x64.AppImage");
    const appImageSignature = `${appImage}.sig`;
    const deb = path.join(directory, "S3-Sidekick-Linux-x64.deb");
    const rpm = path.join(directory, "S3-Sidekick-Linux-x64.rpm");
    for (const filePath of [appImage, deb, rpm]) {
      fs.writeFileSync(filePath, path.basename(filePath));
    }
    fs.writeFileSync(appImageSignature, "updater signature");
    const verified = [];
    const generated = generateUpdaterManifests(
      [appImage, appImageSignature, deb, rpm],
      {
        repository: { owner: "BurntToasters", name: "S3-Sidekick" },
        release: { tag: "v0.11.0-beta.5" },
      },
      {
        normalizeSignature: () => "encoded-appimage-signature",
        outputDirectory: directory,
        verifySignature: (artifactPath, signaturePath) => {
          verified.push([artifactPath, signaturePath]);
          return true;
        },
      },
    );
    assert.deepEqual(verified, [[appImage, appImageSignature]]);
    assert.equal(fs.existsSync(`${deb}.sig`), false);
    assert.equal(fs.existsSync(`${rpm}.sig`), false);
    assert.ok(generated.length >= 1);
    for (const manifestPath of generated) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const entries = Object.values(manifest.platforms);
      assert.ok(entries.length >= 1);
      for (const entry of entries) {
        assert.match(entry.url, /S3-Sidekick-Linux-x64\.AppImage$/);
        assert.doesNotMatch(entry.url, /\.(?:deb|rpm)$/i);
        assert.equal(entry.signature, "encoded-appimage-signature");
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("generic GPG execution scrubs signing credentials and never uses a shell", () => {
  const calls = [];
  const result = runGpg(["--version"], {
    environment: {
      PATH: "/bin",
      GPG_KEY_ID: "release-key",
      GPG_PASSPHRASE: "release-secret",
    },
    execute(command, args, options) {
      calls.push({ args, command, options });
      return { status: 0, stdout: "gpg fixture", stderr: "" };
    },
  });
  assert.equal(result.stdout, "gpg fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gpg");
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PATH, "/bin");
  assert.equal("GPG_KEY_ID" in calls[0].options.env, false);
  assert.equal("GPG_PASSPHRASE" in calls[0].options.env, false);
});

test("artifact, checksum, and evidence signing use protected passphrase stdin", () => {
  const passphrase = "artifact canary --status-fd=attacker";
  const environment = {
    PATH: "/bin",
    GPG_KEY_ID: "release-key",
    GPG_PASSPHRASE: passphrase,
  };
  const files = [
    "S3-Sidekick-Linux-x64.AppImage",
    "SHA256SUMS-linux-x86_64.txt",
    "release-attestation-linux-x86_64.json",
    "release-package-smoke-linux-x86_64.json",
    "release-provenance-linux-x86_64.json",
    "release-sbom-linux-x86_64.spdx.json",
    "release-install-smoke-linux-x86_64.json",
  ];
  const calls = [];
  for (const filePath of files) {
    assert.equal(
      signFile(filePath, {
        environment,
        epoch: 1234567890,
        execute(command, args, options) {
          calls.push({ args, command, options });
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
      `${filePath}.asc`,
    );
  }

  assert.equal(calls.length, files.length);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, "gpg");
    assert.equal(call.args.includes("--passphrase"), false);
    assert.equal(
      call.args.some((argument) => String(argument).includes(passphrase)),
      false,
    );
    const passphraseFd = call.args.indexOf("--passphrase-fd");
    assert.ok(passphraseFd >= 0);
    assert.equal(call.args[passphraseFd + 1], "0");
    assert.equal(
      call.args[call.args.indexOf("--local-user") + 1],
      "release-key",
    );
    assert.equal(
      call.args[call.args.indexOf("--faked-system-time") + 1],
      "1234567890!",
    );
    assert.equal(
      call.args[call.args.indexOf("--output") + 1],
      `${files[index]}.asc`,
    );
    assert.equal(call.args.at(-1), files[index]);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(
      call.options.input.equals(Buffer.from(`${passphrase}\n`, "utf8")),
      true,
    );
    assert.equal("GPG_KEY_ID" in call.options.env, false);
    assert.equal("GPG_PASSPHRASE" in call.options.env, false);
  }
});

test("host upload handoff puts the attestation signature last", () => {
  const root = path.join(os.tmpdir(), "release-order");
  const attestation = path.join(root, "release-attestation-linux-x86_64.json");
  const signature = `${attestation}.asc`;
  const artifact = path.join(root, "app.AppImage");
  const checksum = path.join(root, "SHA256SUMS-linux-x86_64.txt");
  assert.deepEqual(
    orderHostUploadFiles(
      [signature, checksum, attestation, artifact],
      attestation,
    ),
    [artifact, checksum, attestation, signature],
  );
  assert.throws(
    () => orderHostUploadFiles([artifact, attestation], attestation),
    /attestation and its detached signature/i,
  );
});

test("draft uploader rechecks the freeze marker immediately before and after upload", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-upload-freeze-"),
  );
  try {
    const filePath = path.join(directory, "artifact.zip");
    fs.writeFileSync(filePath, "immutable bytes");
    const digest = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const release = {
      id: 42,
      draft: true,
      prerelease: true,
      tag_name: `v${packageJson.version}`,
      target_commitish: "c".repeat(40),
    };
    const request = async () => release;
    let uploadCount = 0;
    let listCount = 0;
    await assert.rejects(
      () =>
        uploadImmutableDraftAsset(release, filePath, {
          request,
          listAssets: async () => {
            listCount += 1;
            return listCount === 1
              ? []
              : [{ id: 99, name: "release-assets.json" }];
          },
          uploadAsset: async () => {
            uploadCount += 1;
          },
        }),
      /asset set is frozen/i,
    );
    assert.equal(uploadCount, 0);

    listCount = 0;
    await assert.rejects(
      () =>
        uploadImmutableDraftAsset(release, filePath, {
          request,
          listAssets: async () => {
            listCount += 1;
            if (listCount < 3) return [];
            return [
              { id: 1, name: "artifact.zip", digest: `sha256:${digest}` },
              { id: 2, name: "release-assets.json" },
            ];
          },
          uploadAsset: async () => {
            uploadCount += 1;
          },
        }),
      /asset set is frozen/i,
    );
    assert.equal(uploadCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
