"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertCleanSource,
  assertDescriptorRepository,
  assertExistingGitHubTagCommit,
  assertReleaseToolVersions,
  artifactNameFromDescriptorReleaseUrl,
  canonicalJson,
  classifyImmutableAsset,
  createReleaseDescriptor,
  descriptorReleaseAssetUrl,
  finalPackageTargetKeysForArtifactName,
  installSmokeReportName,
  isInstallSmokeReportName,
  listAllReleaseAssets,
  normalizeFlatpakInputsByArchitecture,
  normalizeLegacyLatestBootstrap,
  parseExactRustVersion,
  parseFlatpakInputs,
  readReleaseDescriptor,
  resolveGpgFingerprint,
  resolveGitHubTagCommit,
  assertGitHubTagCommit,
  selectUniqueTaggedRelease,
  sha256File,
  signDescriptor,
  signDetachedFile,
  assertValidSignatureStatus,
  validateDescriptorForCheckout,
  validateInstallSmokeReport,
  validateMutableRelease,
  verifyDescriptorSignature,
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
  "org.freedesktop.Sdk.Extension.node24//25.08",
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

test("updater artifact URLs are canonical and descriptor-bound", () => {
  const descriptor = {
    repository: { owner: "Burnt-Toasters", name: "S3.Sidekick" },
    release: { tag: "v1.2.3-beta.5/rc" },
  };
  const artifactName = "S3 Sidekick #1.AppImage";
  const canonical =
    "https://github.com/Burnt-Toasters/S3.Sidekick/releases/download/v1.2.3-beta.5%2Frc/S3%20Sidekick%20%231.AppImage";

  assert.equal(descriptorReleaseAssetUrl(descriptor, artifactName), canonical);
  assert.equal(
    artifactNameFromDescriptorReleaseUrl(descriptor, canonical),
    artifactName,
  );
  assert.deepEqual(
    assertDescriptorRepository(descriptor, {
      owner: "Burnt-Toasters",
      name: "S3.Sidekick",
    }),
    descriptor.repository,
  );
  assert.throws(
    () =>
      assertDescriptorRepository(descriptor, {
        owner: "Burnt-Toasters",
        name: "Other-Repository",
      }),
    /does not match active repository/i,
  );

  const simpleDescriptor = {
    repository: { owner: "Owner", name: "Repository" },
    release: { tag: "v1.2.3-beta.5" },
  };
  const simpleName = "Artifact.AppImage";
  const invalidUrls = [
    "https://github.com/Other/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com/Owner/Other/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.4/Artifact.AppImage",
    "https://github.com/Owner/Repository/releases/latest/download/Artifact.AppImage",
    "http://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com.evil.example/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://user:secret@github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com:444/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage?download=1",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage#fragment",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/extra/Artifact.AppImage",
    "https://github.com/Owner//Repository/releases/download/v1.2.3-beta.5/Artifact.AppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/%41rtifact.AppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact%ZZ.AppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact%2FAppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/Artifact%5CAppImage",
    "https://github.com/Owner/Repository/releases/download/v1.2.3-beta.5/",
  ];
  for (const invalidUrl of invalidUrls) {
    assert.throws(
      () => artifactNameFromDescriptorReleaseUrl(simpleDescriptor, invalidUrl),
      /updater release URL|release artifact name/i,
      invalidUrl,
    );
  }
  for (const invalidName of [
    "",
    ".",
    "..",
    "nested/artifact",
    "nested\\artifact",
  ]) {
    assert.throws(
      () => descriptorReleaseAssetUrl(simpleDescriptor, invalidName),
      /release artifact name/i,
    );
  }
  assert.equal(
    artifactNameFromDescriptorReleaseUrl(
      simpleDescriptor,
      descriptorReleaseAssetUrl(simpleDescriptor, simpleName),
    ),
    simpleName,
  );
});

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
    "runtime: org.gnome.Platform\nruntime-version: '49'\nsdk: org.gnome.Sdk\nsdk-extensions:\n  - org.freedesktop.Sdk.Extension.node24\n  - org.freedesktop.Sdk.Extension.rust-stable\n# release-ref: org.gnome.Platform//49\n# release-ref: org.gnome.Sdk//49\n# release-ref: org.freedesktop.Sdk.Extension.node24//25.08\n# release-ref: org.freedesktop.Sdk.Extension.rust-stable//25.08\n";
  assert.deepEqual(parseFlatpakInputs(manifest), {
    extensions: [
      "org.freedesktop.Sdk.Extension.node24",
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

test("legacy Latest bootstrap authorization is exact, stable-only predecessor metadata", () => {
  const authorization = {
    schemaVersion: 1,
    releaseId: 354185192,
    tag: "v0.10.2",
    sourceCommit: "A".repeat(40),
  };
  assert.deepEqual(normalizeLegacyLatestBootstrap(authorization), {
    ...authorization,
    sourceCommit: "a".repeat(40),
  });
  assert.deepEqual(
    normalizeLegacyLatestBootstrap(JSON.stringify(authorization)),
    {
      ...authorization,
      sourceCommit: "a".repeat(40),
    },
  );
  for (const invalid of [
    { ...authorization, extra: true },
    { ...authorization, releaseId: 0 },
    { ...authorization, releaseId: 1.5 },
    { ...authorization, tag: "0.10.2" },
    { ...authorization, tag: "v0.10.2-beta.1" },
    { ...authorization, sourceCommit: "a".repeat(39) },
  ]) {
    assert.throws(
      () => normalizeLegacyLatestBootstrap(invalid),
      /legacy_latest_bootstrap|Legacy GitHub Latest bootstrap|exact JSON/i,
    );
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-bootstrap-descriptor-"),
  );
  try {
    const filePath = path.join(directory, "release-descriptor.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        repository: { owner: "Test-Owner", name: "Test.Repository" },
        expectedTargets: ["linux-x86_64"],
        release: { prerelease: false },
        legacyLatestBootstrap: authorization,
      }),
    );
    assert.throws(
      () => readReleaseDescriptor(filePath),
      /allowed only on a prerelease descriptor/i,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
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

test("descriptor and asset-index signing keep passphrases out of argv and environment", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-gpg-signing-"),
  );
  const passphrase = "canary passphrase --output=attacker";
  const keyId = "release-key";
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
  const assertProtectedCall = (call, filePath, signaturePath, epoch) => {
    assert.equal(call.command, "gpg");
    assert.equal(call.args.includes("--passphrase"), false);
    assert.equal(
      call.args.some((argument) => String(argument).includes(passphrase)),
      false,
    );
    const passphraseFd = call.args.indexOf("--passphrase-fd");
    assert.ok(passphraseFd >= 0);
    assert.equal(call.args[passphraseFd + 1], "0");
    assert.equal(call.args.includes("--detach-sign"), true);
    assert.equal(call.args[call.args.indexOf("--local-user") + 1], keyId);
    assert.equal(
      call.args[call.args.indexOf("--faked-system-time") + 1],
      `${epoch}!`,
    );
    assert.equal(call.args[call.args.indexOf("--output") + 1], signaturePath);
    assert.equal(call.args.at(-1), filePath);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(
      call.options.input.equals(Buffer.from(`${passphrase}\n`, "utf8")),
      true,
    );
    assert.equal(call.options.env.PATH, "/bin");
    assert.equal(
      Object.keys(call.options.env).some(
        (name) => name.toUpperCase() === "GPG_PASSPHRASE",
      ),
      false,
    );
    assert.equal(
      Object.keys(call.options.env).some(
        (name) => name.toUpperCase() === "GPG_KEY_ID",
      ),
      false,
    );
  };

  try {
    const committedAt = "2026-08-29T12:34:56.000Z";
    const descriptorPath = path.join(directory, "release-descriptor.json");
    const descriptorSignature = `${descriptorPath}.asc`;
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify({ source: { committedAt } })}\n`,
    );
    const descriptorEpoch = Math.floor(Date.parse(committedAt) / 1000);
    assert.equal(
      signDescriptor(
        descriptorPath,
        descriptorSignature,
        {
          PATH: "/bin",
          GPG_KEY_ID: keyId,
          GPG_PASSPHRASE: passphrase,
          gpg_passphrase: "case-insensitive-environment-canary",
        },
        { execute },
      ),
      descriptorSignature,
    );
    assertProtectedCall(
      calls.at(-1),
      descriptorPath,
      descriptorSignature,
      descriptorEpoch,
    );

    const indexPath = path.join(directory, "release-assets.json");
    const indexSignature = `${indexPath}.asc`;
    fs.writeFileSync(indexPath, '{"schemaVersion":1}\n');
    assert.equal(
      signDescriptor(
        indexPath,
        indexSignature,
        {
          PATH: "/bin",
          GPG_KEY_ID: keyId,
          GPG_PASSPHRASE: passphrase,
          SOURCE_DATE_EPOCH: "1234567890",
        },
        { execute },
      ),
      indexSignature,
    );
    assertProtectedCall(calls.at(-1), indexPath, indexSignature, 1234567890);

    let invalidExecutions = 0;
    for (const invalidPassphrase of ["", "   ", "line one\nline two", "a\rb"]) {
      assert.throws(
        () =>
          signDetachedFile("artifact", "artifact.asc", {
            environment: {
              GPG_KEY_ID: keyId,
              GPG_PASSPHRASE: invalidPassphrase,
            },
            execute() {
              invalidExecutions += 1;
              return { status: 0 };
            },
          }),
        /GPG_PASSPHRASE|required|line breaks/i,
      );
    }
    assert.equal(invalidExecutions, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    "runtime: org.gnome.Platform\nruntime-version: '49'\nsdk: org.gnome.Sdk\nsdk-extensions:\n  - org.freedesktop.Sdk.Extension.node24\n  - org.freedesktop.Sdk.Extension.rust-stable\n# release-ref: org.gnome.Platform//49\n# release-ref: org.gnome.Sdk//49\n# release-ref: org.freedesktop.Sdk.Extension.node24//25.08\n# release-ref: org.freedesktop.Sdk.Extension.rust-stable//25.08\n",
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

test("GPG fingerprint and verification subprocesses strip signing secrets", () => {
  const fingerprint = "A".repeat(40);
  const environment = {
    PATH: "/bin",
    GPG_KEY_ID: "release-key",
    GPG_PASSPHRASE: "canary-secret",
    gpg_passphrase: "case-insensitive-canary",
  };
  const calls = [];
  assert.equal(
    resolveGpgFingerprint(environment, {
      execute(command, args, options) {
        calls.push({ command, args, options });
        return {
          status: 0,
          stdout: `fpr:::::::::${fingerprint}:\n`,
          stderr: "",
        };
      },
    }),
    fingerprint,
  );
  const verifyEnvironment = {
    ...environment,
    RELEASE_GPG_FINGERPRINT: fingerprint,
  };
  assert.equal(
    verifyDescriptorSignature(
      "descriptor.json",
      "descriptor.json.asc",
      fingerprint,
      verifyEnvironment,
      {
        execute(command, args, options) {
          calls.push({ command, args, options });
          return {
            status: 0,
            stdout: `[GNUPG:] VALIDSIG ${fingerprint} 2026-01-01 0 0 0 0 0 0 0 ${fingerprint}\n`,
            stderr: "",
          };
        },
      },
    ),
    true,
  );
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.env.PATH, "/bin");
    assert.equal(
      Object.keys(options.env).some((name) =>
        ["GPG_KEY_ID", "GPG_PASSPHRASE"].includes(name.toUpperCase()),
      ),
      false,
    );
  }
});

test("one canonical descriptor binds release id, source archive, locks, toolchains, targets, and install predecessor", () => {
  const root = descriptorFixture();
  const previousTargets = process.env.RELEASE_EXPECTED_TARGETS;
  const previousFingerprint = process.env.RELEASE_GPG_FINGERPRINT;
  const previousInstallVersion =
    process.env.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION;
  delete process.env.RELEASE_EXPECTED_TARGETS;
  process.env.RELEASE_GPG_FINGERPRINT = "A".repeat(40);
  process.env.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION = "1.2.2";
  try {
    const commit = run(root, "git", ["rev-parse", "HEAD"]);
    const release = { ...draft, target_commitish: commit };
    const repository = { owner: "Test-Owner", name: "Test.Repository" };
    const legacyLatestBootstrap = {
      schemaVersion: 1,
      releaseId: 354185192,
      tag: "v0.10.2",
      sourceCommit: "c".repeat(40),
    };
    const descriptor = createReleaseDescriptor({
      root,
      release,
      flatpakInputsByArchitecture: flatpakPins(),
      legacyLatestBootstrap,
      repository,
    });
    const descriptorPath = path.join(
      root,
      "release",
      "release-descriptor.json",
    );
    writeReleaseDescriptor(descriptorPath, descriptor);
    assert.equal(descriptor.schemaVersion, 2);
    assert.deepEqual(descriptor.repository, repository);
    assert.equal(descriptor.release.id, 42);
    assert.equal(descriptor.installSmokePreviousVersion, "1.2.2");
    assert.equal(descriptor.release.signingKeyFingerprint, "A".repeat(40));
    assert.deepEqual(descriptor.legacyLatestBootstrap, legacyLatestBootstrap);
    assert.equal(descriptor.source.archiveSha256.length, 64);
    assert.deepEqual(descriptor.requiredEvidence, [
      "attestation",
      "install-smoke",
      "package-smoke",
      "provenance",
      "sbom",
    ]);
    assert.doesNotThrow(() =>
      validateDescriptorForCheckout(descriptor, {
        root,
        release,
        repository,
      }),
    );
    assert.throws(
      () =>
        validateDescriptorForCheckout(descriptor, {
          root,
          release,
          repository: { ...repository, name: "Wrong.Repository" },
        }),
      /does not match active repository/i,
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
    if (previousInstallVersion === undefined)
      delete process.env.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION;
    else
      process.env.RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION =
        previousInstallVersion;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical final packages have explicit target ownership independent of updater eligibility", () => {
  for (const name of [
    "S3-Sidekick-macOS.app.tar.gz",
    "S3-Sidekick-macOS.dmg",
    "S3-Sidekick-macOS.zip",
  ]) {
    assert.deepEqual(finalPackageTargetKeysForArtifactName(name), [
      "darwin-aarch64",
      "darwin-x86_64",
    ]);
  }

  for (const extension of ["AppImage", "deb", "rpm", "flatpak"]) {
    assert.deepEqual(
      finalPackageTargetKeysForArtifactName(
        `S3-Sidekick-Linux-x64.${extension}`,
      ),
      ["linux-x86_64"],
    );
    assert.deepEqual(
      finalPackageTargetKeysForArtifactName(
        `S3-Sidekick-Linux-arm64.${extension}`,
      ),
      ["linux-aarch64"],
    );
  }

  for (const extension of ["exe", "msi"]) {
    assert.deepEqual(
      finalPackageTargetKeysForArtifactName(
        `S3-Sidekick-Windows-x64.${extension}`,
      ),
      ["windows-x86_64"],
    );
    assert.deepEqual(
      finalPackageTargetKeysForArtifactName(
        `S3-Sidekick-Windows-arm64.${extension}`,
      ),
      ["windows-aarch64"],
    );
  }

  for (const name of [
    "latest-linux-x86_64.json",
    "release-package-smoke-linux-x86_64.json",
    "S3-Sidekick-Linux-x64.AppImage.sig",
    "S3-Sidekick-Windows-x64.exe.asc",
    "S3-Sidekick-Windows-x86.exe",
    "S3-Sidekick-Linux-x64.zip",
    "S3-Sidekick-macOS-arm64.dmg",
    "S3-Sidekick_0.11.0_x64.nsis.zip",
    "nested/S3-Sidekick-Linux-x64.deb",
  ]) {
    assert.deepEqual(finalPackageTargetKeysForArtifactName(name), [], name);
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
    installSmokePreviousVersion: "1.2.2",
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
  const omittedArtifactName = "S3-Sidekick-Linux-x64.flatpak";
  assert.throws(
    () =>
      validateInstallSmokeReport(report, {
        ...options,
        digestByName: new Map([
          ...options.digestByName,
          [omittedArtifactName, "e".repeat(64)],
        ]),
        expectedArtifactNames: new Set([artifactName, omittedArtifactName]),
      }),
    /does not exactly cover.*package closure.*missing.*flatpak/i,
  );
  for (const previousVersion of [
    "1.2.1",
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
      /previousVersion must exactly match signed descriptor predecessor/i,
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
      installSmokePreviousVersion: "1.2.3-beta.1",
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
      /previousVersion must exactly match signed descriptor predecessor/i,
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

test("assertReleaseToolVersions allows Node.js 24.18.0 and above", () => {
  const pkg = {
    packageManager: "npm@12.0.2",
    releaseToolchain: { node: ">=24.18.0", npm: "12.0.2" },
  };
  const env = { npm_config_user_agent: "npm/12.0.2 node/v24.18.0 darwin arm64" };

  assert.deepEqual(
    assertReleaseToolVersions(pkg, {
      environment: env,
      nodeVersion: "24.18.0",
    }),
    { node: ">=24.18.0", npm: "12.0.2" },
  );

  assert.deepEqual(
    assertReleaseToolVersions(pkg, {
      environment: env,
      nodeVersion: "24.20.0",
    }),
    { node: ">=24.18.0", npm: "12.0.2" },
  );

  assert.throws(
    () =>
      assertReleaseToolVersions(pkg, {
        environment: env,
        nodeVersion: "24.17.0",
      }),
    /Release tools do not match package\.json pins/i,
  );

  assert.throws(
    () =>
      assertReleaseToolVersions(pkg, {
        environment: env,
        nodeVersion: "22.22.2",
      }),
    /Release tools do not match package\.json pins/i,
  );

  const pkgExact = {
    packageManager: "npm@12.0.2",
    releaseToolchain: { node: "24.18.0", npm: "12.0.2" },
  };
  assert.deepEqual(
    assertReleaseToolVersions(pkgExact, {
      environment: env,
      nodeVersion: "24.20.0",
    }),
    { node: "24.18.0", npm: "12.0.2" },
  );

  const envWrongNpm = {
    npm_config_user_agent: "npm/12.0.1 node/v24.18.0 darwin arm64",
  };
  assert.throws(
    () =>
      assertReleaseToolVersions(pkg, {
        environment: envWrongNpm,
        nodeVersion: "24.18.0",
      }),
    /Release tools do not match package\.json pins/i,
  );
});

