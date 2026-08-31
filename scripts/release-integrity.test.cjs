"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertCleanSource,
  assertExistingGitHubTagCommit,
  canonicalJson,
  classifyImmutableAsset,
  createReleaseDescriptor,
  installSmokeReportName,
  isInstallSmokeReportName,
  listAllReleaseAssets,
  normalizeFlatpakInputsByArchitecture,
  parseExactRustVersion,
  parseFlatpakInputs,
  resolveGitHubTagCommit,
  assertGitHubTagCommit,
  selectUniqueTaggedRelease,
  sha256File,
  assertValidSignatureStatus,
  validateDescriptorForCheckout,
  validateInstallSmokeReport,
  validateMutableRelease,
  withoutGpgSecrets,
  writeReleaseDescriptor,
} = require("./release-integrity.cjs");

const draft = {
  id: 42,
  draft: true,
  prerelease: true,
  tag_name: "v1.2.3-beta.1",
};
const options = {
  expectedId: 42,
  expectedPrerelease: true,
  expectedTag: "v1.2.3-beta.1",
};
const flatpakRefs = [
  "org.freedesktop.Sdk.Extension.node22//25.08",
  "org.freedesktop.Sdk.Extension.rust-stable//25.08",
  "org.gnome.Platform//49",
  "org.gnome.Sdk//49",
];

function flatpakPins() {
  return {
    arm64: flatpakRefs.map((ref, index) => ({
      commit: String(index + 5).repeat(64),
      ref,
    })),
    x64: flatpakRefs.map((ref, index) => ({
      commit: String(index + 1).repeat(64),
      ref,
    })),
  };
}

test("release selection accepts one exact draft and rejects published, duplicate, or mismatched records", () => {
  assert.equal(validateMutableRelease(draft, options), draft);
  assert.equal(selectUniqueTaggedRelease([], options), null);
  assert.equal(selectUniqueTaggedRelease([draft], options), draft);
  assert.throws(
    () => validateMutableRelease({ ...draft, draft: false }, options),
    /already published|immutable/i,
  );
  assert.throws(
    () => validateMutableRelease({ ...draft, id: 43 }, options),
    /does not match descriptor release id/i,
  );
  assert.throws(
    () => validateMutableRelease({ ...draft, prerelease: false }, options),
    /prerelease state/i,
  );
  assert.throws(
    () =>
      validateMutableRelease(
        { ...draft, target_commitish: "a".repeat(40) },
        { ...options, expectedTargetCommitish: "b".repeat(40) },
      ),
    /target_commitish.*source commit/i,
  );
  assert.throws(
    () => selectUniqueTaggedRelease([draft, { ...draft, id: 43 }], options),
    /ambiguous mutation/i,
  );
});

test("immutable collision handling skips equal bytes and fails closed for all other collisions", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-asset-"),
  );
  try {
    const artifact = path.join(directory, "artifact.zip");
    fs.writeFileSync(artifact, "release bytes");
    const digest = sha256File(artifact);
    assert.equal(classifyImmutableAsset(null, artifact), "upload");
    assert.equal(
      classifyImmutableAsset(
        { name: "artifact.zip", digest: `sha256:${digest}` },
        artifact,
      ),
      "skip",
    );
    assert.throws(
      () =>
        classifyImmutableAsset(
          { name: "artifact.zip", digest: `sha256:${"0".repeat(64)}` },
          artifact,
        ),
      /immutable asset collision/i,
    );
    assert.throws(
      () => classifyImmutableAsset({ name: "artifact.zip" }, artifact),
      /no GitHub SHA-256 digest/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("toolchain and Flatpak descriptor parsing rejects floating inputs", () => {
  assert.equal(
    parseExactRustVersion('[toolchain]\nchannel = "1.98.0"\n'),
    "1.98.0",
  );
  assert.throws(
    () => parseExactRustVersion('[toolchain]\nchannel = "stable"\n'),
    /exact Rust version/i,
  );
  const manifest =
    "runtime: org.gnome.Platform\nruntime-version: '49'\nsdk: org.gnome.Sdk\nsdk-extensions:\n  - org.freedesktop.Sdk.Extension.node22\n  - org.freedesktop.Sdk.Extension.rust-stable\n# release-ref: org.gnome.Platform//49\n# release-ref: org.gnome.Sdk//49\n# release-ref: org.freedesktop.Sdk.Extension.node22//25.08\n# release-ref: org.freedesktop.Sdk.Extension.rust-stable//25.08\n";
  assert.deepEqual(parseFlatpakInputs(manifest), {
    extensions: [
      "org.freedesktop.Sdk.Extension.node22",
      "org.freedesktop.Sdk.Extension.rust-stable",
    ],
    refs: flatpakRefs,
    runtime: "org.gnome.Platform",
    runtimeVersion: "49",
    sdk: "org.gnome.Sdk",
  });
  assert.deepEqual(
    normalizeFlatpakInputsByArchitecture(flatpakPins(), flatpakRefs),
    flatpakPins(),
  );
  const changed = flatpakPins();
  changed.x64[0].commit = "not-a-commit";
  assert.throws(
    () => normalizeFlatpakInputsByArchitecture(changed, flatpakRefs),
    /exactly pin/i,
  );
});

test("asset pagination reads beyond GitHub's first 100 results", async () => {
  const values = Array.from({ length: 109 }, (_, id) => ({ id }));
  const pages = [];
  const result = await listAllReleaseAssets((page, perPage) => {
    pages.push(page);
    const start = (page - 1) * perPage;
    return Promise.resolve(values.slice(start, start + perPage));
  });
  assert.equal(result.length, 109);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result[108].id, 108);
});

test("GitHub tag resolution peels annotated tags, safely distinguishes an absent ref, and rejects wrong commits", async () => {
  const commit = "a".repeat(40);
  const annotatedTag = "b".repeat(40);
  const options = { owner: "owner", repository: "repo", tag: "v1.0.0" };
  const direct = await resolveGitHubTagCommit(
    async () => ({ object: { type: "commit", sha: commit } }),
    options,
  );
  assert.equal(direct, commit);

  const endpoints = [];
  const request = async (_method, endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.includes("/git/ref/tags/")) {
      return { object: { type: "tag", sha: annotatedTag } };
    }
    return { object: { type: "commit", sha: commit } };
  };
  assert.equal(await resolveGitHubTagCommit(request, options), commit);
  assert.equal(endpoints.length, 2);
  await assert.rejects(
    () =>
      assertGitHubTagCommit(request, {
        ...options,
        expectedCommit: "c".repeat(40),
      }),
    /not descriptor source commit/i,
  );
  assert.equal(
    await assertExistingGitHubTagCommit(request, {
      ...options,
      expectedCommit: commit,
    }),
    commit,
  );

  const missingRef = new Error("tag ref missing");
  missingRef.statusCode = 404;
  assert.equal(
    await assertExistingGitHubTagCommit(
      async () => {
        throw missingRef;
      },
      { ...options, expectedCommit: commit },
    ),
    null,
  );
  await assert.rejects(
    () =>
      assertGitHubTagCommit(
        async () => {
          throw missingRef;
        },
        { ...options, expectedCommit: commit },
      ),
    /tag ref missing/i,
  );

  const forbidden = new Error("tag lookup forbidden");
  forbidden.statusCode = 403;
  await assert.rejects(
    () =>
      assertExistingGitHubTagCommit(
        async () => {
          throw forbidden;
        },
        { ...options, expectedCommit: commit },
      ),
    /tag lookup forbidden/i,
  );

  let annotatedCalls = 0;
  await assert.rejects(
    () =>
      assertExistingGitHubTagCommit(
        async () => {
          annotatedCalls += 1;
          if (annotatedCalls === 1) {
            return { object: { type: "tag", sha: annotatedTag } };
          }
          const missingObject = new Error("annotated tag object missing");
          missingObject.statusCode = 404;
          throw missingObject;
        },
        { ...options, expectedCommit: commit },
      ),
    /annotated tag object missing/i,
  );
  assert.equal(annotatedCalls, 2);
});

test("GPG status must identify exactly the pinned release fingerprint", () => {
  const fingerprint = "A".repeat(40);
  assert.equal(
    assertValidSignatureStatus(
      `[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG ${fingerprint} 2026-01-01 0 4 0 1 10 00 ${fingerprint}`,
      fingerprint,
    ),
    true,
  );
  assert.throws(
    () =>
      assertValidSignatureStatus(
        `[GNUPG:] VALIDSIG ${"B".repeat(40)} 2026-01-01`,
        fingerprint,
      ),
    /fingerprint mismatch/i,
  );
});

function run(root, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(result.stderr || result.stdout);
  }
  return String(result.stdout || "").trim();
}

function descriptorFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-descriptor-"),
  );
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      version: "1.2.3-beta.1",
      packageManager: "npm@12.0.2",
      releaseToolchain: { node: process.versions.node, npm: "12.0.2" },
      engines: { node: "^24.15.0" },
    })}\n`,
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src-tauri", "Cargo.lock"), "version = 4\n");
  fs.writeFileSync(
    path.join(root, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.98.0"\n',
  );
  fs.writeFileSync(
    path.join(root, "run.rosie.s3-sidekick.yml"),
    "runtime: org.gnome.Platform\nruntime-version: '49'\nsdk: org.gnome.Sdk\nsdk-extensions:\n  - org.freedesktop.Sdk.Extension.node22\n  - org.freedesktop.Sdk.Extension.rust-stable\n# release-ref: org.gnome.Platform//49\n# release-ref: org.gnome.Sdk//49\n# release-ref: org.freedesktop.Sdk.Extension.node22//25.08\n# release-ref: org.freedesktop.Sdk.Extension.rust-stable//25.08\n",
  );
  fs.writeFileSync(path.join(root, "source.txt"), "canonical source\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "release/\n");
  run(root, "git", ["init", "--quiet"]);
  run(root, "git", ["add", "."]);
  run(root, "git", [
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

test("clean release source rejects every Git-visible worktree state and permits ignored outputs", () => {
  const root = descriptorFixture();
  const sourcePath = path.join(root, "source.txt");
  const untrackedPath = path.join(root, "untracked.txt");
  const commit = run(root, "git", ["rev-parse", "HEAD"]);
  try {
    assert.equal(assertCleanSource(root), commit);

    const ignoredOutput = path.join(root, "release", "output.bin");
    fs.mkdirSync(path.dirname(ignoredOutput), { recursive: true });
    fs.writeFileSync(ignoredOutput, "ignored release output\n");
    assert.equal(assertCleanSource(root, { expectedCommit: commit }), commit);

    fs.writeFileSync(sourcePath, "unstaged change\n");
    assert.throws(() => assertCleanSource(root), /working tree is not clean/i);
    fs.writeFileSync(sourcePath, "canonical source\n");
    assert.equal(assertCleanSource(root), commit);

    fs.writeFileSync(sourcePath, "staged change\n");
    run(root, "git", ["add", "source.txt"]);
    assert.throws(() => assertCleanSource(root), /working tree is not clean/i);
    fs.writeFileSync(sourcePath, "canonical source\n");
    run(root, "git", ["add", "source.txt"]);
    assert.equal(assertCleanSource(root), commit);

    fs.rmSync(sourcePath);
    assert.throws(() => assertCleanSource(root), /working tree is not clean/i);
    fs.writeFileSync(sourcePath, "canonical source\n");
    assert.equal(assertCleanSource(root), commit);

    fs.writeFileSync(untrackedPath, "untracked input\n");
    assert.throws(() => assertCleanSource(root), /working tree is not clean/i);
    fs.rmSync(untrackedPath);
    assert.equal(assertCleanSource(root), commit);

    assert.throws(
      () => assertCleanSource(root, { expectedCommit: "f".repeat(40) }),
      /not expected commit/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one canonical descriptor binds release id, source archive, locks, toolchains, and targets", () => {
  const root = descriptorFixture();
  const previousTargets = process.env.RELEASE_EXPECTED_TARGETS;
  const previousFingerprint = process.env.RELEASE_GPG_FINGERPRINT;
  delete process.env.RELEASE_EXPECTED_TARGETS;
  process.env.RELEASE_GPG_FINGERPRINT = "A".repeat(40);
  try {
    const commit = run(root, "git", ["rev-parse", "HEAD"]);
    const release = { ...draft, target_commitish: commit };
    const descriptor = createReleaseDescriptor({
      root,
      release,
      flatpakInputsByArchitecture: flatpakPins(),
    });
    const descriptorPath = path.join(
      root,
      "release",
      "release-descriptor.json",
    );
    writeReleaseDescriptor(descriptorPath, descriptor);
    assert.equal(descriptor.release.id, 42);
    assert.equal(descriptor.release.signingKeyFingerprint, "A".repeat(40));
    assert.equal(descriptor.source.archiveSha256.length, 64);
    assert.deepEqual(descriptor.requiredEvidence, [
      "attestation",
      "install-smoke",
      "package-smoke",
      "provenance",
      "sbom",
    ]);
    assert.doesNotThrow(() =>
      validateDescriptorForCheckout(descriptor, { root, release }),
    );
    assert.equal(
      canonicalJson(descriptor),
      fs.readFileSync(descriptorPath, "utf8"),
    );

    fs.writeFileSync(
      path.join(root, "src-tauri", "Cargo.lock"),
      "version = 3\n",
    );
    assert.throws(
      () => validateDescriptorForCheckout(descriptor, { root, release }),
      /working tree is not clean/i,
    );
  } finally {
    if (previousTargets === undefined)
      delete process.env.RELEASE_EXPECTED_TARGETS;
    else process.env.RELEASE_EXPECTED_TARGETS = previousTargets;
    if (previousFingerprint === undefined)
      delete process.env.RELEASE_GPG_FINGERPRINT;
    else process.env.RELEASE_GPG_FINGERPRINT = previousFingerprint;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install-smoke reports use canonical target names and bind semantic results to target-owned artifact bytes", () => {
  const target = "linux-x86_64";
  const artifactName = "S3-Sidekick-Linux-x64.AppImage";
  const artifactSha256 = "a".repeat(64);
  const crossTargetArtifactName = "S3-Sidekick-Windows-x64.exe";
  const crossTargetArtifactSha256 = "b".repeat(64);
  const descriptorSha256 = "d".repeat(64);
  const descriptor = {
    release: { id: 42, version: "1.2.3" },
    source: { commit: "c".repeat(40) },
  };
  const report = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: 42,
    sourceCommit: descriptor.source.commit,
    target,
    status: "passed",
    checks: ["clean-install", "launch", "previous-version-update"],
    previousVersion: "1.2.2",
    runner: { image: "windows-2025", runId: "1234" },
    artifacts: [{ name: artifactName, sha256: artifactSha256 }],
  };
  const options = {
    allowedArtifactNames: new Set([artifactName]),
    descriptor,
    descriptorSha256,
    digestByName: new Map([
      [artifactName, artifactSha256],
      [crossTargetArtifactName, crossTargetArtifactSha256],
    ]),
    target,
  };

  assert.equal(
    installSmokeReportName(target),
    "release-install-smoke-linux-x86_64.json",
  );
  assert.equal(isInstallSmokeReportName(installSmokeReportName(target)), true);
  assert.equal(
    isInstallSmokeReportName("release-install-smoke-linux-x86_64-extra.json"),
    false,
  );
  assert.throws(() => installSmokeReportName("linux-amd64"), /invalid/i);
  assert.equal(validateInstallSmokeReport(report, options), true);
  for (const previousVersion of [
    "not-a-version",
    "v1.2.2",
    "1.2",
    "01.2.2",
    "1.2.2-01",
    "1.2.2-",
    "1.2.2+",
    "1.2.3",
    "1.2.3+old-build",
    "1.2.4",
  ]) {
    assert.throws(
      () => validateInstallSmokeReport({ ...report, previousVersion }, options),
      /previousVersion must be valid semantic version strictly lower/i,
      previousVersion,
    );
  }
  assert.throws(
    () =>
      validateInstallSmokeReport(
        {
          ...report,
          artifacts: [
            {
              name: crossTargetArtifactName,
              sha256: crossTargetArtifactSha256,
            },
          ],
        },
        options,
      ),
    /artifact mismatch/i,
  );
  const prereleaseOptions = {
    ...options,
    descriptor: {
      ...descriptor,
      release: { ...descriptor.release, version: "1.2.3-beta.2" },
    },
  };
  assert.equal(
    validateInstallSmokeReport(
      { ...report, previousVersion: "1.2.3-beta.1" },
      prereleaseOptions,
    ),
    true,
  );
  for (const previousVersion of ["1.2.3-beta.10", "1.2.3"]) {
    assert.throws(
      () =>
        validateInstallSmokeReport(
          { ...report, previousVersion },
          prereleaseOptions,
        ),
      /previousVersion must be valid semantic version strictly lower/i,
      previousVersion,
    );
  }
  assert.throws(
    () =>
      validateInstallSmokeReport(
        { ...report, checks: [...report.checks, "launch"] },
        options,
      ),
    /checks are invalid/i,
  );
  assert.throws(
    () =>
      validateInstallSmokeReport(
        { ...report, artifacts: [...report.artifacts, report.artifacts[0]] },
        options,
      ),
    /artifact mismatch/i,
  );
  assert.throws(
    () =>
      validateInstallSmokeReport(report, {
        ...options,
        digestByName: new Map([[artifactName, "c".repeat(64)]]),
      }),
    /artifact mismatch/i,
  );
  assert.throws(
    () =>
      validateInstallSmokeReport(report, {
        ...options,
        allowedArtifactNames: new Set(),
      }),
    /no installable artifacts/i,
  );
});

test("non-GPG child environments scrub signing credentials case-insensitively", () => {
  assert.deepEqual(
    withoutGpgSecrets({
      PATH: "/bin",
      GPG_KEY_ID: "key",
      gpg_passphrase: "secret",
      RELEASE_GPG_FINGERPRINT: "A".repeat(40),
    }),
    {
      PATH: "/bin",
      RELEASE_GPG_FINGERPRINT: "A".repeat(40),
    },
  );
});
