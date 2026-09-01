import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BETA_CHANNEL_ROLLOVER_NAME,
  BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  LEGACY_BETA_CHANNEL_MIGRATION_NAME,
  LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
  LEGACY_UNSIGNED_BETA_POINTER_NAMES,
  STABLE_ROLLOVER_RECEIPT_NAME,
  STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  createBetaChannelRollover,
  createBetaChannelTransaction,
  createStableRolloverReceipt,
  permanentBetaChannelAssetNames,
} from "./release-channel.js";
import {
  abortStableRolloverDraft,
  bootstrapLegacyLatestCarrier,
  clearStableRolloverReceiptOwnership,
  createLegacyStableCarrierDescriptor,
  deleteOwnedStableDraftChannelAssets,
  loadStableRolloverReceiptOwnership,
  persistStableRolloverReceiptOwnership,
  resolveRemotePublicationOwnerEvidence,
  runPublication,
  settlePublishedStableRolloverReceipt,
  uploadStableDraftChannelAsset,
  verifyLegacyStableCarrierAssetSet,
} from "./release-publication.js";

const successorDescriptorSha256 = "c".repeat(64);
const successorProductIndexSha256 = "d".repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function publicationOrchestrationFixture({
  draft = true,
  prerelease = false,
} = {}) {
  const id = prerelease ? 92 : 93;
  const sourceCommit = prerelease ? "1".repeat(40) : "2".repeat(40);
  const descriptor = {
    expectedTargets: ["linux-x86_64"],
    release: {
      id,
      prerelease,
      tag: prerelease ? "v2.0.0-beta.5" : "v2.0.0",
      version: prerelease ? "2.0.0-beta.5" : "2.0.0",
    },
    source: { commit: sourceCommit },
  };
  const publicationOwner = {
    schemaVersion: 1,
    descriptorSha256: "7".repeat(64),
    releaseId: id,
    sessionId: "723e4567-e89b-42d3-a456-426614174000",
    sourceCommit,
  };
  const release = {
    id,
    draft,
    prerelease,
    tag_name: descriptor.release.tag,
    target_commitish: sourceCommit,
  };
  const publishedRelease = { ...release, draft: false };
  const assets = [];
  const verification = { verified: true };
  const frozen = {
    assetIndex: { schemaVersion: 1 },
    digestByName: new Map(),
  };
  const verified = {
    directory: "/virtual/public",
    publicAssets: [],
    release: publishedRelease,
  };
  const events = [];
  const state = { patchBody: null, settledRelease: null };
  const context = (name, channelState = null) => ({
    channelState,
    disposeCount: 0,
    dispose() {
      this.disposeCount += 1;
      events.push(`${name}:dispose`);
    },
  });
  const preflightContext = context("preflight");
  const carriedContext = context("carried", { source: { id: 91 } });
  const freshContext = context("fresh", { source: { id: 91 } });
  const services = {
    assertExistingTag: async (actualDescriptor) => {
      assert.equal(actualDescriptor, descriptor);
      events.push("assert-existing-tag");
    },
    assertPublishedTag: async (actualDescriptor) => {
      assert.equal(actualDescriptor, descriptor);
      events.push("assert-published-tag");
    },
    carryChannel: async (
      actualRelease,
      actualDescriptor,
      actualFrozen,
      actualOwner,
    ) => {
      assert.equal(actualRelease, release);
      assert.equal(actualDescriptor, descriptor);
      assert.equal(actualFrozen, frozen);
      assert.equal(actualOwner, publicationOwner);
      events.push("carry");
      return carriedContext;
    },
    createPrivateDirectory: () => {
      events.push("create-private");
      return "/virtual/private";
    },
    downloadAssets: async (actualAssets, directory) => {
      assert.equal(actualAssets, assets);
      assert.equal(directory, "/virtual/private");
      events.push("download");
    },
    finalizeChannel: async (
      actualRelease,
      actualDescriptor,
      actualFrozen,
      actualContext,
    ) => {
      assert.equal(actualRelease, release);
      assert.equal(actualDescriptor, descriptor);
      assert.equal(actualFrozen, frozen);
      assert.equal(actualContext, carriedContext);
      events.push("finalize");
    },
    freezeAssets: async (options) => {
      assert.equal(options.descriptor, descriptor);
      assert.equal(options.directory, "/virtual/private");
      assert.equal(options.release, release);
      assert.equal(options.verification, verification);
      events.push("freeze");
      return frozen;
    },
    getRelease: async (releaseId) => {
      assert.equal(releaseId, id);
      events.push("get-release");
      return draft ? release : publishedRelease;
    },
    listAssets: async (releaseId) => {
      assert.equal(releaseId, id);
      events.push("list-assets");
      return assets;
    },
    log() {},
    patchRelease: async (releaseId, body) => {
      assert.equal(releaseId, id);
      state.patchBody = body;
      events.push("patch");
      return publishedRelease;
    },
    promoteChannel: async (actualDescriptor, actualVerified, options) => {
      assert.equal(actualDescriptor, descriptor);
      assert.equal(actualVerified, verified);
      assert.equal(options.publicationOwner, publicationOwner);
      events.push("promote");
    },
    recheckFrozen: async (options) => {
      assert.equal(options.descriptor, descriptor);
      assert.equal(options.frozen, frozen);
      assert.equal(options.release, release);
      events.push("recheck-frozen");
    },
    recheckRollover: async (
      actualRelease,
      actualDescriptor,
      actualFrozen,
      actualContext,
      actualOwner,
    ) => {
      assert.equal(actualRelease, release);
      assert.equal(actualDescriptor, descriptor);
      assert.equal(actualFrozen, frozen);
      assert.equal(actualContext, carriedContext);
      assert.equal(actualOwner, publicationOwner);
      events.push("recheck-rollover");
      return freshContext;
    },
    releaseRollover: async (actualRelease, actualDescriptor, actualContext) => {
      assert.equal(actualRelease, publishedRelease);
      assert.equal(actualDescriptor, descriptor);
      assert.equal(actualContext, freshContext);
      events.push("release-rollover");
    },
    removeDirectory: async (directory) => {
      events.push(`remove:${directory}`);
    },
    settlePublishedReceipt: async (actualRelease, actualDescriptor) => {
      assert.equal(actualRelease, publishedRelease);
      assert.equal(actualDescriptor, descriptor);
      events.push("settle-published-receipt");
    },
    settleRollover: async (actualRelease, actualDescriptor, actualContext) => {
      assert.equal(actualDescriptor, descriptor);
      assert.ok(
        actualContext === carriedContext || actualContext === freshContext,
      );
      state.settledRelease = actualRelease;
      events.push(
        `settle-rollover:${actualRelease.draft ? "draft" : "published"}`,
      );
    },
    verifyDownloaded: (options) => {
      assert.equal(options.descriptor, descriptor);
      assert.equal(options.directory, "/virtual/private");
      assert.equal(options.assets, assets);
      events.push("verify-downloaded");
      return verification;
    },
    verifyLatestCarrier: async () => {
      events.push("verify-latest-carrier");
      return preflightContext;
    },
    waitForPublic: async (actualDescriptor) => {
      assert.equal(actualDescriptor, descriptor);
      events.push("wait-public");
      return verified;
    },
  };
  return {
    carriedContext,
    descriptor,
    events,
    freshContext,
    frozen,
    preflightContext,
    publicationOwner,
    publishedRelease,
    release,
    services,
    state,
  };
}

function legacyBootstrapFixture() {
  const predecessorCommit = "cabdce4f9466c3a7dd1123b8a4403e97e27f16c4";
  const descriptorSha256 = "7".repeat(64);
  const descriptor = {
    schemaVersion: 2,
    repository: { owner: "BurntToasters", name: "S3-Sidekick" },
    expectedTargets: [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ],
    release: {
      id: 400,
      prerelease: true,
      signingKeyFingerprint: "A".repeat(40),
      tag: "v0.11.0-beta.5",
      version: "0.11.0-beta.5",
    },
    source: {
      commit: "9a4420b26c3279ae5c7d11ce56164032b423fe32",
      committedAt: "2026-08-29T12:00:00.000Z",
    },
    legacyLatestBootstrap: {
      schemaVersion: 1,
      releaseId: 354185192,
      tag: "v0.10.2",
      sourceCommit: predecessorCommit,
    },
  };
  const publicationOwner = {
    schemaVersion: 1,
    descriptorSha256,
    releaseId: descriptor.release.id,
    sessionId: "723e4567-e89b-42d3-a456-426614174000",
    sourceCommit: descriptor.source.commit,
  };
  const latest = {
    id: descriptor.legacyLatestBootstrap.releaseId,
    draft: false,
    prerelease: false,
    tag_name: descriptor.legacyLatestBootstrap.tag,
    target_commitish: "main",
  };
  const assets = new Map();
  const addAsset = (name, bytes, id = 100 + assets.size) => {
    const value = Buffer.from(bytes);
    const asset = {
      id,
      name,
      digest: `sha256:${sha256(value)}`,
      bytes: value,
    };
    assets.set(name, asset);
    return asset;
  };
  addAsset("S3-Sidekick_0.10.2_x64_en-US.msi", "legacy msi", 101);
  addAsset("S3-Sidekick_0.10.2_x64-setup.exe", "legacy exe", 102);
  LEGACY_UNSIGNED_BETA_POINTER_NAMES.forEach((name, index) =>
    addAsset(name, `unsigned legacy pointer:${name}`, 110 + index),
  );
  const state = {
    deletions: [],
    latestCalls: 0,
    tagCalls: 0,
    uploads: [],
    verifyCalls: 0,
  };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-bootstrap-test-"),
  );
  const services = {
    createPrivateDirectory: () => directory,
    deleteAsset: async (assetId) => {
      const current = Array.from(assets.values()).find(
        (asset) => asset.id === assetId,
      );
      assert.ok(current, `missing bootstrap delete id ${assetId}`);
      state.deletions.push(current.name);
      assets.delete(current.name);
    },
    downloadAssets: async (downloadedAssets, destination) => {
      for (const asset of downloadedAssets) {
        const current = assets.get(asset.name);
        assert.ok(current);
        fs.writeFileSync(path.join(destination, asset.name), current.bytes);
      }
    },
    listAssets: async (releaseId) => {
      assert.equal(releaseId, latest.id);
      return Array.from(
        assets.values(),
        ({ bytes: _bytes, ...asset }) => asset,
      );
    },
    removeDirectory: () => {},
    request: async (_method, endpoint) => {
      if (endpoint.endsWith("/releases/latest")) {
        state.latestCalls += 1;
        return latest;
      }
      if (endpoint.endsWith(`/releases/${latest.id}`)) {
        return latest;
      }
      if (endpoint.includes("/git/ref/tags/")) {
        state.tagCalls += 1;
        return { object: { type: "commit", sha: predecessorCommit } };
      }
      throw new Error(`Unexpected bootstrap endpoint ${endpoint}.`);
    },
    signFile: (filePath, signaturePath) => {
      fs.writeFileSync(
        signaturePath,
        `signed:${path.basename(filePath)}:${sha256(fs.readFileSync(filePath))}\n`,
      );
    },
    uploadAsset: async (releaseId, filePath) => {
      assert.equal(releaseId, latest.id);
      const name = path.basename(filePath);
      state.uploads.push(name);
      addAsset(name, fs.readFileSync(filePath), 200 + assets.size);
    },
    verifyCarrier: async () => {
      state.verifyCalls += 1;
      const carrierDescriptor = JSON.parse(
        assets.get("release-descriptor.json").bytes.toString("utf8"),
      );
      const permanentStateComplete = permanentBetaChannelAssetNames(
        carrierDescriptor.expectedTargets,
      ).every((name) => assets.has(name));
      if (!permanentStateComplete) {
        assert.equal(
          LEGACY_UNSIGNED_BETA_POINTER_NAMES.some((name) => assets.has(name)),
          false,
        );
      }
      assert.equal(assets.has(LEGACY_BETA_CHANNEL_MIGRATION_NAME), true);
      assert.equal(
        assets.has(LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME),
        true,
      );
      return {
        carrier: latest,
        carrierDescriptor,
        dispose() {},
      };
    },
    verifySignature: () => true,
  };
  return {
    assets,
    descriptor,
    descriptorSha256,
    directory,
    latest,
    predecessorCommit,
    publicationOwner,
    services,
    state,
  };
}

function disposeLegacyBootstrapFixture(fixture) {
  fs.rmSync(fixture.directory, { force: true, recursive: true });
}

test("legacy Latest bootstrap creates an exact signed delete-to-empty carrier", async () => {
  const fixture = legacyBootstrapFixture();
  try {
    const verified = await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    assert.equal(verified.carrier, fixture.latest);
    assert.deepEqual(fixture.state.uploads, [
      "release-descriptor.json",
      "release-descriptor.json.asc",
      "release-assets.json",
      "release-assets.json.asc",
      LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
      LEGACY_BETA_CHANNEL_MIGRATION_NAME,
    ]);
    assert.deepEqual(
      fixture.state.deletions,
      LEGACY_UNSIGNED_BETA_POINTER_NAMES,
    );
    assert.equal(fixture.state.verifyCalls, 1);
    const carrierDescriptor = JSON.parse(
      fixture.assets.get("release-descriptor.json").bytes,
    );
    assert.deepEqual(carrierDescriptor, {
      schemaVersion: 1,
      descriptorType: "legacy-stable-carrier-bootstrap",
      repository: fixture.descriptor.repository,
      release: {
        channel: "stable",
        id: fixture.latest.id,
        prerelease: false,
        signingKeyFingerprint: fixture.descriptor.release.signingKeyFingerprint,
        tag: "v0.10.2",
        version: "0.10.2",
      },
      source: { commit: fixture.predecessorCommit },
      expectedTargets: fixture.descriptor.expectedTargets,
      authorization: {
        prereleaseDescriptorSha256: fixture.descriptorSha256,
      },
    });
    const index = JSON.parse(fixture.assets.get("release-assets.json").bytes);
    const migration = JSON.parse(
      fixture.assets.get(LEGACY_BETA_CHANNEL_MIGRATION_NAME).bytes,
    );
    assert.equal(migration.desiredState, "empty");
    assert.deepEqual(
      migration.legacyPointers.map(({ id, name }) => ({ id, name })),
      LEGACY_UNSIGNED_BETA_POINTER_NAMES.map((name, index) => ({
        id: 110 + index,
        name,
      })),
    );
    assert.deepEqual(
      migration.baseAssets.map((record) => record.name),
      ["S3-Sidekick_0.10.2_x64_en-US.msi", "S3-Sidekick_0.10.2_x64-setup.exe"],
    );
    assert.deepEqual(
      index.assets.map((record) => record.name),
      [
        "S3-Sidekick_0.10.2_x64_en-US.msi",
        "S3-Sidekick_0.10.2_x64-setup.exe",
        "release-descriptor.json",
        "release-descriptor.json.asc",
      ].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(
      index.assets.some((record) => record.name === "release-assets.json"),
      false,
    );
    for (const asset of fixture.assets.values()) {
      fs.writeFileSync(path.join(fixture.directory, asset.name), asset.bytes);
    }
    const strictVerification = verifyLegacyStableCarrierAssetSet({
      assets: Array.from(
        fixture.assets.values(),
        ({ bytes: _bytes, ...asset }) => asset,
      ),
      descriptor: carrierDescriptor,
      directory: fixture.directory,
      verifySignature: () => true,
    });
    assert.deepEqual(
      Array.from(strictVerification.assetsByName.keys()).sort(),
      Array.from(fixture.assets.keys())
        .filter(
          (name) =>
            name !== LEGACY_BETA_CHANNEL_MIGRATION_NAME &&
            name !== LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
        )
        .sort(),
    );
    assert.equal(strictVerification.legacyMigration.desiredState, "empty");
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("legacy carrier remains retryable after permanent beta channel installation", async () => {
  const fixture = legacyBootstrapFixture();
  try {
    await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    const carrierDescriptor = JSON.parse(
      fixture.assets.get("release-descriptor.json").bytes,
    );
    let nextId = 10_000;
    for (const name of permanentBetaChannelAssetNames(
      carrierDescriptor.expectedTargets,
    )) {
      const bytes = Buffer.from(`permanent:${name}\n`);
      fixture.assets.set(name, {
        id: nextId,
        name,
        digest: `sha256:${sha256(bytes)}`,
        bytes,
      });
      nextId += 1;
    }

    const retryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-bootstrap-channel-retry-"),
    );
    fs.rmSync(fixture.directory, { force: true, recursive: true });
    fixture.directory = retryDirectory;
    fixture.services.createPrivateDirectory = () => retryDirectory;
    fixture.state.uploads.length = 0;
    fixture.state.deletions.length = 0;
    await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    assert.deepEqual(fixture.state.uploads, []);
    assert.deepEqual(fixture.state.deletions, []);

    for (const asset of fixture.assets.values()) {
      fs.writeFileSync(path.join(retryDirectory, asset.name), asset.bytes);
    }
    const verified = verifyLegacyStableCarrierAssetSet({
      assets: Array.from(
        fixture.assets.values(),
        ({ bytes: _bytes, ...asset }) => asset,
      ),
      descriptor: carrierDescriptor,
      directory: retryDirectory,
      verifySignature: () => true,
    });
    assert.deepEqual(
      Array.from(verified.channelAssetsByName.keys()).sort(),
      [
        LEGACY_BETA_CHANNEL_MIGRATION_NAME,
        LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
        ...permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets),
      ].sort(),
    );
    assert.equal(
      permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets).some(
        (name) => verified.assetsByName.has(name),
      ),
      false,
    );
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("strict legacy verification rejects a changed partial legacy pointer overlay", async () => {
  const fixture = legacyBootstrapFixture();
  try {
    await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    const carrierDescriptor = JSON.parse(
      fixture.assets.get("release-descriptor.json").bytes,
    );
    const name = LEGACY_UNSIGNED_BETA_POINTER_NAMES[0];
    const bytes = Buffer.from("changed partial legacy pointer\n");
    fixture.assets.set(name, {
      id: 10_000,
      name,
      digest: `sha256:${sha256(bytes)}`,
      bytes,
    });
    for (const asset of fixture.assets.values()) {
      fs.writeFileSync(path.join(fixture.directory, asset.name), asset.bytes);
    }

    assert.throws(
      () =>
        verifyLegacyStableCarrierAssetSet({
          assets: Array.from(
            fixture.assets.values(),
            ({ bytes: _bytes, ...asset }) => asset,
          ),
          descriptor: carrierDescriptor,
          directory: fixture.directory,
          verifySignature: () => true,
        }),
      /legacy beta pointer changed/i,
    );
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("legacy Latest bootstrap resumes immutable carrier controls before signing migration authority", async () => {
  const fixture = legacyBootstrapFixture();
  const upload = fixture.services.uploadAsset;
  let injected = false;
  fixture.services.uploadAsset = async (releaseId, filePath) => {
    await upload(releaseId, filePath);
    if (!injected && path.basename(filePath) === "release-assets.json") {
      injected = true;
      throw new Error("injected partial carrier upload");
    }
  };
  try {
    await assert.rejects(
      () =>
        bootstrapLegacyLatestCarrier(
          fixture.descriptor,
          fixture.publicationOwner,
          fixture.services,
        ),
      /injected partial carrier upload/i,
    );
    assert.deepEqual(fixture.state.uploads, [
      "release-descriptor.json",
      "release-descriptor.json.asc",
      "release-assets.json",
    ]);
    assert.equal(fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_NAME), false);
    assert.deepEqual(fixture.state.deletions, []);

    const freshDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-bootstrap-controls-retry-"),
    );
    fs.rmSync(fixture.directory, { force: true, recursive: true });
    fixture.directory = freshDirectory;
    fixture.services.createPrivateDirectory = () => freshDirectory;
    fixture.services.uploadAsset = upload;
    fixture.state.uploads.length = 0;
    await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    assert.deepEqual(fixture.state.uploads, [
      "release-assets.json.asc",
      LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
      LEGACY_BETA_CHANNEL_MIGRATION_NAME,
    ]);
    assert.equal(fixture.state.verifyCalls, 1);
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("legacy beta migration resumes a matching signature singleton only before deletion", async () => {
  const fixture = legacyBootstrapFixture();
  const upload = fixture.services.uploadAsset;
  let injected = false;
  fixture.services.uploadAsset = async (releaseId, filePath) => {
    await upload(releaseId, filePath);
    if (
      !injected &&
      path.basename(filePath) === LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME
    ) {
      injected = true;
      throw new Error("injected migration signature upload");
    }
  };
  try {
    await assert.rejects(
      () =>
        bootstrapLegacyLatestCarrier(
          fixture.descriptor,
          fixture.publicationOwner,
          fixture.services,
        ),
      /injected migration signature upload/i,
    );
    assert.equal(
      fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME),
      true,
    );
    assert.equal(fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_NAME), false);
    assert.deepEqual(fixture.state.deletions, []);

    const freshDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "s3-sidekick-bootstrap-journal-retry-"),
    );
    fs.rmSync(fixture.directory, { force: true, recursive: true });
    fixture.directory = freshDirectory;
    fixture.services.createPrivateDirectory = () => freshDirectory;
    fixture.services.uploadAsset = upload;
    fixture.state.uploads.length = 0;
    await bootstrapLegacyLatestCarrier(
      fixture.descriptor,
      fixture.publicationOwner,
      fixture.services,
    );
    assert.deepEqual(fixture.state.uploads, [
      LEGACY_BETA_CHANNEL_MIGRATION_NAME,
    ]);
    assert.deepEqual(
      fixture.state.deletions,
      LEGACY_UNSIGNED_BETA_POINTER_NAMES,
    );
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("legacy Latest bootstrap rejects control collisions without mutation", async () => {
  const fixture = legacyBootstrapFixture();
  try {
    fixture.assets.set("release-descriptor.json", {
      id: 150,
      name: "release-descriptor.json",
      digest: `sha256:${"0".repeat(64)}`,
      bytes: Buffer.from("foreign descriptor"),
    });
    await assert.rejects(
      () =>
        bootstrapLegacyLatestCarrier(
          fixture.descriptor,
          fixture.publicationOwner,
          fixture.services,
        ),
      /control collision/i,
    );
    assert.deepEqual(fixture.state.uploads, []);
    assert.equal(fixture.state.verifyCalls, 0);
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("legacy Latest bootstrap stops when Latest, tag, or the base asset snapshot changes", async (t) => {
  await t.test("Latest changes", async () => {
    const fixture = legacyBootstrapFixture();
    const request = fixture.services.request;
    fixture.services.request = async (method, endpoint) => {
      const value = await request(method, endpoint);
      if (
        endpoint.endsWith("/releases/latest") &&
        fixture.state.uploads.length > 0
      ) {
        return { ...value, id: value.id + 1 };
      }
      return value;
    };
    try {
      await assert.rejects(
        () =>
          bootstrapLegacyLatestCarrier(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        /release id|descriptor release id/i,
      );
      assert.deepEqual(fixture.state.uploads, ["release-descriptor.json"]);
    } finally {
      disposeLegacyBootstrapFixture(fixture);
    }
  });

  await t.test("release by id changes", async () => {
    const fixture = legacyBootstrapFixture();
    const request = fixture.services.request;
    fixture.services.request = async (method, endpoint) => {
      const value = await request(method, endpoint);
      if (
        endpoint.endsWith(`/releases/${fixture.latest.id}`) &&
        fixture.state.uploads.length > 0
      ) {
        return { ...value, id: value.id + 1 };
      }
      return value;
    };
    try {
      await assert.rejects(
        () =>
          bootstrapLegacyLatestCarrier(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        /release id|descriptor release id/i,
      );
      assert.deepEqual(fixture.state.uploads, ["release-descriptor.json"]);
      assert.deepEqual(fixture.state.deletions, []);
    } finally {
      disposeLegacyBootstrapFixture(fixture);
    }
  });

  await t.test("tag changes", async () => {
    const fixture = legacyBootstrapFixture();
    const request = fixture.services.request;
    fixture.services.request = async (method, endpoint) => {
      const value = await request(method, endpoint);
      if (endpoint.includes("/git/ref/tags/") && fixture.state.tagCalls > 1) {
        return { object: { type: "commit", sha: "0".repeat(40) } };
      }
      return value;
    };
    try {
      await assert.rejects(
        () =>
          bootstrapLegacyLatestCarrier(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        /not descriptor source commit/i,
      );
      assert.deepEqual(fixture.state.uploads, []);
    } finally {
      disposeLegacyBootstrapFixture(fixture);
    }
  });

  await t.test("base asset changes", async () => {
    const fixture = legacyBootstrapFixture();
    const uploadAsset = fixture.services.uploadAsset;
    fixture.services.uploadAsset = async (releaseId, filePath) => {
      await uploadAsset(releaseId, filePath);
      const base = fixture.assets.get("S3-Sidekick_0.10.2_x64_en-US.msi");
      fixture.assets.set(base.name, {
        ...base,
        digest: `sha256:${"f".repeat(64)}`,
      });
    };
    try {
      await assert.rejects(
        () =>
          bootstrapLegacyLatestCarrier(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        /base asset changed/i,
      );
      assert.deepEqual(fixture.state.uploads, ["release-descriptor.json"]);
    } finally {
      disposeLegacyBootstrapFixture(fixture);
    }
  });
});

test("legacy beta migration resumes monotonically after every pointer deletion from a fresh directory", async (t) => {
  for (
    let failureIndex = 0;
    failureIndex < LEGACY_UNSIGNED_BETA_POINTER_NAMES.length;
    failureIndex += 1
  ) {
    await t.test(`after deletion ${failureIndex + 1}`, async () => {
      const fixture = legacyBootstrapFixture();
      const originalDelete = fixture.services.deleteAsset;
      let injected = false;
      fixture.services.deleteAsset = async (assetId) => {
        await originalDelete(assetId);
        if (!injected && fixture.state.deletions.length === failureIndex + 1) {
          injected = true;
          throw new Error(`injected deletion ${failureIndex + 1}`);
        }
      };
      try {
        await assert.rejects(
          () =>
            bootstrapLegacyLatestCarrier(
              fixture.descriptor,
              fixture.publicationOwner,
              fixture.services,
            ),
          new RegExp(`injected deletion ${failureIndex + 1}`),
        );
        assert.equal(
          fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_NAME),
          true,
        );
        assert.equal(
          fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME),
          true,
        );
        for (let index = 0; index <= failureIndex; index += 1) {
          assert.equal(
            fixture.assets.has(LEGACY_UNSIGNED_BETA_POINTER_NAMES[index]),
            false,
          );
        }

        const freshDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), "s3-sidekick-bootstrap-retry-test-"),
        );
        fs.rmSync(fixture.directory, { force: true, recursive: true });
        fixture.directory = freshDirectory;
        fixture.services.createPrivateDirectory = () => freshDirectory;
        fixture.services.deleteAsset = originalDelete;
        await bootstrapLegacyLatestCarrier(
          fixture.descriptor,
          fixture.publicationOwner,
          fixture.services,
        );
        assert.equal(
          LEGACY_UNSIGNED_BETA_POINTER_NAMES.some((name) =>
            fixture.assets.has(name),
          ),
          false,
        );
        assert.equal(
          fixture.assets.has(LEGACY_BETA_CHANNEL_MIGRATION_NAME),
          true,
        );
      } finally {
        disposeLegacyBootstrapFixture(fixture);
      }
    });
  }
});

test("legacy beta migration fails closed on pointer races and unauthorized overlays", async (t) => {
  for (const changedField of ["id", "digest"]) {
    await t.test(`pointer ${changedField} race`, async () => {
      const fixture = legacyBootstrapFixture();
      const upload = fixture.services.uploadAsset;
      fixture.services.uploadAsset = async (releaseId, filePath) => {
        await upload(releaseId, filePath);
        if (path.basename(filePath) === LEGACY_BETA_CHANNEL_MIGRATION_NAME) {
          const name = LEGACY_UNSIGNED_BETA_POINTER_NAMES[0];
          const pointer = fixture.assets.get(name);
          fixture.assets.set(name, {
            ...pointer,
            ...(changedField === "id"
              ? { id: pointer.id + 1000 }
              : { digest: `sha256:${"0".repeat(64)}` }),
          });
        }
      };
      try {
        await assert.rejects(
          () =>
            bootstrapLegacyLatestCarrier(
              fixture.descriptor,
              fixture.publicationOwner,
              fixture.services,
            ),
          /legacy beta pointer changed/i,
        );
        assert.deepEqual(fixture.state.deletions, []);
      } finally {
        disposeLegacyBootstrapFixture(fixture);
      }
    });
  }

  await t.test("missing pre-journal pointer", async () => {
    const fixture = legacyBootstrapFixture();
    fixture.assets.delete(LEGACY_UNSIGNED_BETA_POINTER_NAMES[0]);
    try {
      await assert.rejects(
        () =>
          bootstrapLegacyLatestCarrier(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        /exact authorized five-pointer snapshot/i,
      );
      assert.deepEqual(fixture.state.uploads, []);
      assert.deepEqual(fixture.state.deletions, []);
    } finally {
      disposeLegacyBootstrapFixture(fixture);
    }
  });

  for (const unexpectedName of [
    "latest-linux-beta-aarch64.json",
    "latest-linux-beta-x86.json",
  ]) {
    await t.test(`unexpected ${unexpectedName}`, async () => {
      const fixture = legacyBootstrapFixture();
      fixture.assets.set(unexpectedName, {
        id: 999,
        name: unexpectedName,
        digest: `sha256:${"9".repeat(64)}`,
        bytes: Buffer.from("unexpected pointer"),
      });
      try {
        await assert.rejects(
          () =>
            bootstrapLegacyLatestCarrier(
              fixture.descriptor,
              fixture.publicationOwner,
              fixture.services,
            ),
          /unexpected channel assets/i,
        );
        assert.deepEqual(fixture.state.uploads, []);
        assert.deepEqual(fixture.state.deletions, []);
      } finally {
        disposeLegacyBootstrapFixture(fixture);
      }
    });
  }
});

test("legacy carrier descriptor creation is prerelease-only and requires explicit authorization", () => {
  const fixture = legacyBootstrapFixture();
  try {
    assert.throws(
      () =>
        createLegacyStableCarrierDescriptor(
          {
            ...fixture.descriptor,
            release: { ...fixture.descriptor.release, prerelease: false },
          },
          fixture.descriptorSha256,
        ),
      /only a prerelease descriptor/i,
    );
    assert.throws(
      () =>
        createLegacyStableCarrierDescriptor(
          { ...fixture.descriptor, legacyLatestBootstrap: undefined },
          fixture.descriptorSha256,
        ),
      /no legacy Latest bootstrap authorization/i,
    );
  } finally {
    disposeLegacyBootstrapFixture(fixture);
  }
});

test("prerelease publication behavior preflights stable Latest, publishes non-Latest, verifies, then promotes", async () => {
  const fixture = publicationOrchestrationFixture({ prerelease: true });
  const result = await runPublication(
    fixture.descriptor,
    fixture.publicationOwner,
    fixture.services,
  );
  assert.equal(result.release, fixture.publishedRelease);
  assert.deepEqual(result.transitionPolicy, {
    makeLatest: "false",
    promoteBeta: true,
    supported: true,
  });
  assert.deepEqual(fixture.state.patchBody, {
    draft: false,
    make_latest: "false",
    prerelease: true,
  });
  assert.deepEqual(fixture.events, [
    "get-release",
    "verify-latest-carrier",
    "preflight:dispose",
    "list-assets",
    "create-private",
    "download",
    "verify-downloaded",
    "freeze",
    "remove:/virtual/private",
    "recheck-frozen",
    "assert-existing-tag",
    "patch",
    "assert-published-tag",
    "wait-public",
    "promote",
    "remove:/virtual/public",
  ]);
});

test("signed prerelease bootstrap authorization replaces the normal Latest preflight", async () => {
  const fixture = publicationOrchestrationFixture({ prerelease: true });
  fixture.descriptor.legacyLatestBootstrap = {
    schemaVersion: 1,
    releaseId: 354185192,
    tag: "v0.10.2",
    sourceCommit: "c".repeat(40),
  };
  fixture.services.bootstrapLegacyCarrier = async (
    descriptor,
    publicationOwner,
  ) => {
    assert.equal(descriptor, fixture.descriptor);
    assert.equal(publicationOwner, fixture.publicationOwner);
    fixture.events.push("bootstrap-legacy-carrier");
    return fixture.preflightContext;
  };
  fixture.services.verifyLatestCarrier = async () => {
    throw new Error("normal preflight must not run");
  };
  await runPublication(
    fixture.descriptor,
    fixture.publicationOwner,
    fixture.services,
  );
  assert.deepEqual(fixture.events, [
    "get-release",
    "list-assets",
    "create-private",
    "download",
    "verify-downloaded",
    "freeze",
    "remove:/virtual/private",
    "recheck-frozen",
    "assert-existing-tag",
    "bootstrap-legacy-carrier",
    "preflight:dispose",
    "recheck-frozen",
    "patch",
    "assert-published-tag",
    "wait-public",
    "promote",
    "remove:/virtual/public",
  ]);
});

test("legacy bootstrap never mutates the carrier before candidate readiness", async (t) => {
  for (const stage of ["verifyDownloaded", "freezeAssets"]) {
    await t.test(`${stage} failure`, async () => {
      const fixture = publicationOrchestrationFixture({ prerelease: true });
      fixture.descriptor.legacyLatestBootstrap = {
        schemaVersion: 1,
        releaseId: 354185192,
        tag: "v0.10.2",
        sourceCommit: "c".repeat(40),
      };
      let bootstrapCalls = 0;
      fixture.services.bootstrapLegacyCarrier = async () => {
        bootstrapCalls += 1;
        fixture.events.push("bootstrap-legacy-carrier");
        return fixture.preflightContext;
      };
      fixture.services.verifyLatestCarrier = async () => {
        throw new Error("normal preflight must not run");
      };
      const original = fixture.services[stage];
      fixture.services[stage] = async (...args) => {
        await original(...args);
        throw new Error(`injected ${stage} failure`);
      };

      await assert.rejects(
        () =>
          runPublication(
            fixture.descriptor,
            fixture.publicationOwner,
            fixture.services,
          ),
        new RegExp(`injected ${stage} failure`),
      );
      assert.equal(bootstrapCalls, 0);
      assert.equal(fixture.events.includes("bootstrap-legacy-carrier"), false);
      assert.equal(fixture.events.at(-1), "remove:/virtual/private");
      for (const forbidden of [
        "patch",
        "assert-published-tag",
        "wait-public",
        "promote",
      ]) {
        assert.equal(fixture.events.includes(forbidden), false);
      }
    });
  }
});

test("published authorized prerelease retries never bootstrap the legacy carrier", async () => {
  const fixture = publicationOrchestrationFixture({
    draft: false,
    prerelease: true,
  });
  fixture.descriptor.legacyLatestBootstrap = {
    schemaVersion: 1,
    releaseId: 354185192,
    tag: "v0.10.2",
    sourceCommit: "c".repeat(40),
  };
  fixture.services.bootstrapLegacyCarrier = async () => {
    throw new Error("published retry must not bootstrap");
  };
  fixture.services.verifyLatestCarrier = async () => {
    throw new Error("published retry must not preflight Latest");
  };

  await runPublication(
    fixture.descriptor,
    fixture.publicationOwner,
    fixture.services,
  );
  assert.deepEqual(fixture.events, [
    "get-release",
    "assert-published-tag",
    "wait-public",
    "promote",
    "remove:/virtual/public",
  ]);
});

test("stable publication behavior carries and finalizes the beta channel before making the release Latest", async () => {
  const fixture = publicationOrchestrationFixture();
  const result = await runPublication(
    fixture.descriptor,
    fixture.publicationOwner,
    fixture.services,
  );
  assert.equal(result.release, fixture.publishedRelease);
  assert.deepEqual(fixture.state.patchBody, {
    draft: false,
    make_latest: "true",
    prerelease: false,
  });
  assert.equal(fixture.carriedContext.disposeCount, 1);
  assert.equal(fixture.freshContext.disposeCount, 1);
  assert.deepEqual(fixture.events, [
    "get-release",
    "list-assets",
    "create-private",
    "download",
    "verify-downloaded",
    "freeze",
    "carry",
    "finalize",
    "remove:/virtual/private",
    "recheck-frozen",
    "assert-existing-tag",
    "recheck-rollover",
    "carried:dispose",
    "patch",
    "release-rollover",
    "fresh:dispose",
    "assert-published-tag",
    "wait-public",
    "remove:/virtual/public",
  ]);
});

test("final stable pre-PATCH recheck failure settles the draft without publishing", async () => {
  const fixture = publicationOrchestrationFixture();
  fixture.services.recheckRollover = async () => {
    fixture.events.push("recheck-rollover");
    throw new Error("injected final rollover recheck failure");
  };
  await assert.rejects(
    () =>
      runPublication(
        fixture.descriptor,
        fixture.publicationOwner,
        fixture.services,
      ),
    /injected final rollover recheck failure/,
  );
  assert.equal(fixture.events.includes("patch"), false);
  assert.equal(fixture.state.settledRelease, fixture.release);
  assert.equal(fixture.carriedContext.disposeCount, 1);
  assert.deepEqual(fixture.events.slice(-3), [
    "recheck-rollover",
    "settle-rollover:draft",
    "carried:dispose",
  ]);
});

test("post-PATCH stable lease cleanup failure settles against the published release", async () => {
  const fixture = publicationOrchestrationFixture();
  fixture.services.releaseRollover = async (release) => {
    assert.equal(release, fixture.publishedRelease);
    fixture.events.push("release-rollover");
    throw new Error("injected post-PATCH cleanup failure");
  };
  await assert.rejects(
    () =>
      runPublication(
        fixture.descriptor,
        fixture.publicationOwner,
        fixture.services,
      ),
    /injected post-PATCH cleanup failure/,
  );
  assert.equal(fixture.state.settledRelease, fixture.publishedRelease);
  assert.equal(fixture.freshContext.disposeCount, 1);
  assert.deepEqual(fixture.events.slice(-4), [
    "patch",
    "release-rollover",
    "settle-rollover:published",
    "fresh:dispose",
  ]);
  assert.equal(fixture.events.includes("assert-published-tag"), false);
});

test("already-published stable retry settles its signed receipt before public verification", async () => {
  const fixture = publicationOrchestrationFixture({ draft: false });
  const result = await runPublication(
    fixture.descriptor,
    fixture.publicationOwner,
    fixture.services,
  );
  assert.equal(result.release, fixture.publishedRelease);
  assert.equal(fixture.state.patchBody, null);
  assert.deepEqual(fixture.events, [
    "get-release",
    "settle-published-receipt",
    "assert-published-tag",
    "wait-public",
    "remove:/virtual/public",
  ]);
});

test("malformed PATCH success responses recover with the original stable release identity", async () => {
  const fixture = publicationOrchestrationFixture();
  fixture.services.patchRelease = async () => {
    fixture.events.push("patch");
    return null;
  };
  await assert.rejects(
    () =>
      runPublication(
        fixture.descriptor,
        fixture.publicationOwner,
        fixture.services,
      ),
    /release/i,
  );
  assert.equal(fixture.state.settledRelease, fixture.release);
  assert.equal(fixture.carriedContext.disposeCount, 1);
  assert.deepEqual(fixture.events.slice(-3), [
    "patch",
    "settle-rollover:draft",
    "fresh:dispose",
  ]);
});

function rolloverFixture() {
  const carrierDescriptor = {
    expectedTargets: ["linux-x86_64"],
    release: {
      id: 42,
      prerelease: false,
      tag: "v1.2.3",
      version: "1.2.3",
    },
    source: { commit: "b".repeat(40) },
  };
  const successorDescriptor = {
    expectedTargets: ["linux-x86_64"],
    release: {
      id: 43,
      prerelease: false,
      tag: "v1.2.4",
      version: "1.2.4",
    },
    source: { commit: "d".repeat(40) },
  };
  const carrier = {
    id: carrierDescriptor.release.id,
    tag_name: carrierDescriptor.release.tag,
  };
  const successor = {
    id: successorDescriptor.release.id,
    tag_name: successorDescriptor.release.tag,
  };
  const owner = {
    schemaVersion: 1,
    descriptorSha256: successorDescriptorSha256,
    releaseId: successor.id,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    sourceCommit: successorDescriptor.source.commit,
  };
  const channelRecords = new Map(
    permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets).map(
      (name, index) => [name, String(index + 1).repeat(64)],
    ),
  );
  const rollover = createBetaChannelRollover({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    carrierVersion: carrierDescriptor.release.version,
    channelRecords,
    owner,
    productIndexSha256: "b".repeat(64),
    successor,
    successorDescriptor,
    successorDescriptorSha256,
    successorProductIndexSha256,
  });
  const leaseAssets = new Map([
    [
      BETA_CHANNEL_ROLLOVER_NAME,
      {
        id: 700,
        name: BETA_CHANNEL_ROLLOVER_NAME,
        digest: `sha256:${"e".repeat(64)}`,
      },
    ],
    [
      BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
      {
        id: 701,
        name: BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
        digest: `sha256:${"f".repeat(64)}`,
      },
    ],
  ]);
  const receipt = createStableRolloverReceipt({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    carrierProductIndexSha256: "b".repeat(64),
    leaseAssets,
    owner,
    rollover,
    successor,
    successorDescriptor,
    successorDescriptorSha256,
    successorProductIndexSha256,
  });
  const latest = {
    ...successor,
    draft: false,
    prerelease: false,
    target_commitish: successorDescriptor.source.commit,
  };
  const receiptAssets = new Map([
    [
      STABLE_ROLLOVER_RECEIPT_NAME,
      {
        id: 800,
        name: STABLE_ROLLOVER_RECEIPT_NAME,
        digest: `sha256:${"8".repeat(64)}`,
      },
    ],
    [
      STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
      {
        id: 801,
        name: STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
        digest: `sha256:${"9".repeat(64)}`,
      },
    ],
  ]);
  const successorAssets = [
    {
      id: 600,
      name: "release-assets.json",
      digest: `sha256:${successorProductIndexSha256}`,
    },
    ...receiptAssets.values(),
  ];
  return {
    carrier,
    carrierDescriptor,
    latest,
    leaseAssets,
    receipt,
    receiptAssets,
    rollover,
    successorAssets,
    successorDescriptor,
  };
}

function predecessorContext(fixture, state) {
  let rolloverAssets;
  let incompleteControl = null;
  let rollover = fixture.rollover;
  if (state === "full") {
    rolloverAssets = new Map(fixture.leaseAssets);
  } else if (state === "partial") {
    const [entry] = fixture.leaseAssets;
    rolloverAssets = new Map([entry]);
    incompleteControl = {
      expectedAsset: entry[1],
      kind: "rollover",
    };
    rollover = null;
  } else if (state === "absent") {
    rolloverAssets = new Map();
    rollover = null;
  } else {
    throw new Error(`Unknown predecessor state ${state}.`);
  }
  return {
    carrier: fixture.carrier,
    carrierDescriptorSha256: "a".repeat(64),
    dispose() {},
    incompleteControl,
    productIndexSha256: "b".repeat(64),
    rollover,
    rolloverAssets,
  };
}

function settlementServices(fixture, context, events) {
  return {
    deletePredecessorLease: async (actualContext, expectedAssets, options) => {
      assert.equal(actualContext, context);
      assert.deepEqual(expectedAssets, fixture.leaseAssets);
      assert.deepEqual(options, { requireLatest: false });
      events.push("predecessor");
    },
    deleteSuccessorReceipt: async (
      release,
      descriptor,
      expectedAssets,
      options,
    ) => {
      assert.equal(release, fixture.latest);
      assert.equal(descriptor, fixture.successorDescriptor);
      assert.deepEqual(expectedAssets, fixture.receiptAssets);
      assert.deepEqual(options, { requireDraft: false });
      events.push("receipt");
    },
    clearReceiptOwnership: async (descriptorSha256) => {
      assert.equal(descriptorSha256, successorDescriptorSha256);
    },
    getLatestRelease: async () => fixture.latest,
    listReleaseAssets: async () => fixture.successorAssets,
    loadReceipt: async (release, descriptor, expectedOwner, options) => {
      assert.equal(release, fixture.latest);
      assert.equal(descriptor, fixture.successorDescriptor);
      assert.equal(expectedOwner, null);
      assert.equal(options.requireDraft, false);
      return {
        assets: fixture.receiptAssets,
        receipt: fixture.receipt,
      };
    },
    loadReceiptOwnership: async (descriptor, descriptorSha256) => {
      assert.equal(descriptor, fixture.successorDescriptor);
      assert.equal(descriptorSha256, successorDescriptorSha256);
      return { assets: fixture.receiptAssets, owner: fixture.receipt.owner };
    },
    persistReceiptOwnership: async (
      descriptor,
      descriptorSha256,
      publicationOwner,
      receiptAssets,
    ) => {
      assert.equal(descriptor, fixture.successorDescriptor);
      assert.equal(descriptorSha256, successorDescriptorSha256);
      assert.equal(publicationOwner, fixture.receipt.owner);
      assert.deepEqual(receiptAssets, fixture.receiptAssets);
    },
    successorDescriptorSha256,
    verifyPredecessor: async (options) => {
      assert.deepEqual(options, {
        allowIncompleteControl: true,
        allowRollover: true,
        releaseId: fixture.carrier.id,
        requireLatest: false,
      });
      return context;
    },
  };
}

test("remote takeover evidence accepts only complete signed controls bound to the descriptor", async (t) => {
  await t.test("beta transaction owner", async () => {
    const descriptorSha256 = "c".repeat(64);
    const descriptor = {
      expectedTargets: ["linux-x86_64"],
      release: {
        id: 84,
        prerelease: true,
        tag: "v1.2.4-beta.1",
        version: "1.2.4-beta.1",
      },
      source: { commit: "d".repeat(40) },
    };
    const owner = {
      schemaVersion: 1,
      descriptorSha256,
      releaseId: descriptor.release.id,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      sourceCommit: descriptor.source.commit,
    };
    const carrier = { id: 42, tag_name: "v1.2.3" };
    const names = permanentBetaChannelAssetNames(descriptor.expectedTargets);
    const desired = new Map(
      names.map((name, index) => [name, String(index + 1).repeat(64)]),
    );
    const transaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      owner,
      previousRecords: new Map(),
      productIndexSha256: "b".repeat(64),
      sourceCommit: descriptor.source.commit,
      sourceDescriptorSha256: descriptorSha256,
      sourceReleaseId: descriptor.release.id,
      sourceTag: descriptor.release.tag,
      sourceVersion: descriptor.release.version,
    });
    const transactionAssets = new Map([
      [
        "beta-channel-transaction.json",
        {
          id: 700,
          name: "beta-channel-transaction.json",
          digest: `sha256:${"7".repeat(64)}`,
        },
      ],
      [
        "beta-channel-transaction.json.asc",
        {
          id: 701,
          name: "beta-channel-transaction.json.asc",
          digest: `sha256:${"8".repeat(64)}`,
        },
      ],
    ]);
    let disposed = 0;
    const context = {
      carrier,
      carrierDescriptor: {
        expectedTargets: descriptor.expectedTargets,
      },
      carrierDescriptorSha256: "a".repeat(64),
      productIndexSha256: "b".repeat(64),
      transaction,
      transactionAssets,
      dispose() {
        disposed += 1;
      },
    };
    const release = {
      id: descriptor.release.id,
      draft: false,
      prerelease: true,
      tag_name: descriptor.release.tag,
      target_commitish: descriptor.source.commit,
    };
    const resolved = await resolveRemotePublicationOwnerEvidence(
      descriptor,
      descriptorSha256,
      {
        getRelease: async () => release,
        listReleaseAssets: async () => [],
        verifyCarrier: async () => context,
      },
    );
    assert.deepEqual(resolved.owner, owner);
    assert.equal(resolved.evidence[0].kind, "beta-transaction");
    assert.equal(disposed, 1);

    await assert.rejects(
      () =>
        resolveRemotePublicationOwnerEvidence(descriptor, descriptorSha256, {
          getRelease: async () => release,
          listReleaseAssets: async () => [],
          verifyCarrier: async () => ({
            ...context,
            incompleteControl: {
              expectedAsset: transactionAssets.values().next().value,
              kind: "transaction",
            },
            transaction: null,
            transactionAssets: new Map([
              transactionAssets.entries().next().value,
            ]),
          }),
        }),
      /no complete signed remote owner evidence/i,
    );
  });

  await t.test(
    "matching stable lease and permanent receipt owner",
    async () => {
      const fixture = rolloverFixture();
      const context = predecessorContext(fixture, "full");
      context.carrierDescriptor = fixture.carrierDescriptor;
      const resolved = await resolveRemotePublicationOwnerEvidence(
        fixture.successorDescriptor,
        successorDescriptorSha256,
        {
          getRelease: async () => fixture.latest,
          listReleaseAssets: async () => fixture.successorAssets,
          loadReceipt: async () => ({
            assets: fixture.receiptAssets,
            receipt: fixture.receipt,
          }),
          verifyCarrier: async () => context,
        },
      );
      assert.deepEqual(resolved.owner, fixture.receipt.owner);
      assert.deepEqual(
        resolved.evidence.map(({ kind }) => kind),
        ["stable-receipt", "stable-rollover"],
      );

      const conflictingReceipt = structuredClone(fixture.receipt);
      conflictingReceipt.owner.sessionId =
        "223e4567-e89b-42d3-a456-426614174000";
      await assert.rejects(
        () =>
          resolveRemotePublicationOwnerEvidence(
            fixture.successorDescriptor,
            successorDescriptorSha256,
            {
              getRelease: async () => fixture.latest,
              listReleaseAssets: async () => fixture.successorAssets,
              loadReceipt: async () => ({
                assets: fixture.receiptAssets,
                receipt: conflictingReceipt,
              }),
              verifyCarrier: async () => {
                const conflictingContext = predecessorContext(fixture, "full");
                conflictingContext.carrierDescriptor =
                  fixture.carrierDescriptor;
                return conflictingContext;
              },
            },
          ),
        /conflicting owners/i,
      );
    },
  );
});

test("published stable retries settle full, partial, and already-removed predecessor leases while retaining the receipt", async (t) => {
  for (const state of ["full", "partial", "absent"]) {
    await t.test(state, async () => {
      const fixture = rolloverFixture();
      const context = predecessorContext(fixture, state);
      const events = [];
      assert.equal(
        await settlePublishedStableRolloverReceipt(
          fixture.latest,
          fixture.successorDescriptor,
          settlementServices(fixture, context, events),
        ),
        "settled",
      );
      assert.deepEqual(events, ["predecessor"]);
    });
  }
});

test("published stable retry refuses changed predecessor lease identity", async () => {
  for (const change of ["id", "digest"]) {
    const fixture = rolloverFixture();
    const context = predecessorContext(fixture, "full");
    const current = context.rolloverAssets.get(BETA_CHANNEL_ROLLOVER_NAME);
    context.rolloverAssets.set(BETA_CHANNEL_ROLLOVER_NAME, {
      ...current,
      ...(change === "id"
        ? { id: current.id + 1 }
        : { digest: `sha256:${"0".repeat(64)}` }),
    });
    const events = [];
    await assert.rejects(
      () =>
        settlePublishedStableRolloverReceipt(
          fixture.latest,
          fixture.successorDescriptor,
          settlementServices(fixture, context, events),
        ),
      /predecessor lease changed/i,
    );
    assert.deepEqual(events, []);
  }
});

test("published stable retry rejects every receipt singleton and never deletes permanent history", async () => {
  const fixture = rolloverFixture();
  const indexAsset = fixture.successorAssets[0];
  for (const singleton of fixture.receiptAssets.values()) {
    await assert.rejects(
      () =>
        settlePublishedStableRolloverReceipt(
          fixture.latest,
          fixture.successorDescriptor,
          {
            clearReceiptOwnership: async () =>
              assert.fail("singleton cleared local ownership"),
            deleteSuccessorReceipt: async () =>
              assert.fail("permanent receipt singleton was deleted"),
            getLatestRelease: async () => fixture.latest,
            listReleaseAssets: async () => [indexAsset, singleton],
            successorDescriptorSha256,
          },
        ),
      /signature pair is incomplete.*cannot be repaired/i,
    );
  }

  let cleared = false;
  assert.equal(
    await settlePublishedStableRolloverReceipt(
      fixture.latest,
      fixture.successorDescriptor,
      {
        clearReceiptOwnership: async () => {
          cleared = true;
        },
        getLatestRelease: async () => fixture.latest,
        listReleaseAssets: async () => [indexAsset],
        successorDescriptorSha256,
      },
    ),
    "none",
  );
  assert.equal(cleared, true);
});
test("stable draft abort removes exact carried assets before receipt and lease release", async () => {
  const fixture = rolloverFixture();
  const descriptorSha256 = successorDescriptorSha256;
  const context = predecessorContext(fixture, "full");
  context.receiptAssets = new Map(fixture.receiptAssets);
  context.successorChannelAssets = new Map([
    [
      "latest-linux-beta-x86_64.json",
      {
        id: 900,
        name: "latest-linux-beta-x86_64.json",
        digest: `sha256:${"3".repeat(64)}`,
      },
    ],
  ]);
  const successorAssets = new Map([
    ...context.successorChannelAssets,
    ...context.receiptAssets,
  ]);
  const events = [];
  assert.equal(
    await abortStableRolloverDraft(
      fixture.latest,
      fixture.successorDescriptor,
      context,
      {
        clearReceiptOwnership: async (actualDescriptorSha256) => {
          assert.equal(actualDescriptorSha256, descriptorSha256);
          events.push("clear-owner");
        },
        deleteChannelAssets: async (
          release,
          descriptor,
          actualContext,
          assets,
        ) => {
          assert.equal(release, fixture.latest);
          assert.equal(descriptor, fixture.successorDescriptor);
          assert.equal(actualContext, context);
          assert.equal(assets, context.successorChannelAssets);
          for (const name of assets.keys()) successorAssets.delete(name);
          events.push("channel");
        },
        deleteReceiptAssets: async (release, descriptor, assets, options) => {
          assert.equal(release, fixture.latest);
          assert.equal(descriptor, fixture.successorDescriptor);
          assert.equal(assets, context.receiptAssets);
          assert.deepEqual(options, {
            carrierContext: context,
            requireDraft: true,
          });
          for (const name of assets.keys()) successorAssets.delete(name);
          events.push("receipt");
        },
        deleteRolloverAssets: async (actualContext, assets, options) => {
          assert.equal(actualContext, context);
          assert.equal(assets, context.rolloverAssets);
          assert.deepEqual(options, { requireLatest: true });
          events.push("lease");
        },
        descriptorSha256,
      },
    ),
    "aborted",
  );
  assert.deepEqual(events, ["channel", "receipt", "lease", "clear-owner"]);
  assert.equal(successorAssets.size, 0);
});

test("stable draft abort retains later controls when an earlier cleanup boundary fails", async () => {
  const fixture = rolloverFixture();
  for (const failedStep of ["channel", "receipt", "lease"]) {
    const context = predecessorContext(fixture, "full");
    context.receiptAssets = fixture.receiptAssets;
    context.successorChannelAssets = new Map([
      ["latest-linux-beta-x86_64.json", { id: 900 }],
    ]);
    const events = [];
    const step = (name) => async () => {
      events.push(name);
      if (name === failedStep) throw new Error(`injected ${name} failure`);
    };
    await assert.rejects(
      () =>
        abortStableRolloverDraft(
          fixture.latest,
          fixture.successorDescriptor,
          context,
          {
            clearReceiptOwnership: step("clear-owner"),
            deleteChannelAssets: step("channel"),
            deleteReceiptAssets: step("receipt"),
            deleteRolloverAssets: step("lease"),
            descriptorSha256: successorDescriptorSha256,
          },
        ),
      new RegExp(`injected ${failedStep} failure`),
    );
    const failureIndex = events.indexOf(failedStep);
    assert.deepEqual(
      events,
      ["channel", "receipt", "lease", "clear-owner"].slice(0, failureIndex + 1),
    );
  }
});
test("stable draft asset mutations are bracketed by the exact remote rollover lease", async () => {
  const fixture = rolloverFixture();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-stable-draft-assets-"),
  );
  try {
    const draft = { ...fixture.latest, draft: true };
    const carrierAssets = new Map([
      ["stable-product.zip", { id: 1, name: "stable-product.zip" }],
      ...fixture.leaseAssets,
    ]);
    const successorAssets = new Map();
    let nextId = 1000;
    let carrierChecks = 0;
    const carrierContext = {
      assertCarrier: async () => {
        carrierChecks += 1;
      },
      carrier: fixture.carrier,
      carrierDescriptor: fixture.carrierDescriptor,
      listAssets: async () => Array.from(carrierAssets.values()),
      rolloverAssets: fixture.leaseAssets,
    };
    const services = {
      deleteAsset: async (assetId) => {
        const current = Array.from(successorAssets.values()).find(
          ({ id }) => id === assetId,
        );
        assert.ok(current);
        successorAssets.delete(current.name);
      },
      getRelease: async () => draft,
      listAssets: async () => Array.from(successorAssets.values()),
      uploadAsset: async (_releaseId, filePath) => {
        const name = path.basename(filePath);
        successorAssets.set(name, {
          id: nextId,
          name,
          digest: `sha256:${sha256(fs.readFileSync(filePath))}`,
        });
        nextId += 1;
      },
    };
    const manifestName = "latest-linux-beta-x86_64.json";
    const manifestPath = path.join(directory, manifestName);
    fs.writeFileSync(manifestPath, "carried beta manifest");
    const manifestAsset = await uploadStableDraftChannelAsset(
      draft,
      fixture.successorDescriptor,
      manifestPath,
      carrierContext,
      services,
    );
    assert.equal(successorAssets.get(manifestName), manifestAsset);
    assert.ok(carrierChecks >= 2);

    const ownedAssets = new Map([[manifestName, manifestAsset]]);
    await deleteOwnedStableDraftChannelAssets(
      draft,
      fixture.successorDescriptor,
      carrierContext,
      ownedAssets,
      services,
    );
    assert.equal(successorAssets.has(manifestName), false);
    assert.equal(ownedAssets.size, 0);

    const signatureName = `${manifestName}.asc`;
    const signaturePath = path.join(directory, signatureName);
    fs.writeFileSync(signaturePath, "carried beta signature");
    const originalLeaseSignature = carrierAssets.get(
      BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
    );
    const racingServices = {
      ...services,
      uploadAsset: async (releaseId, filePath) => {
        await services.uploadAsset(releaseId, filePath);
        carrierAssets.set(BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME, {
          ...originalLeaseSignature,
          digest: `sha256:${"0".repeat(64)}`,
        });
      },
    };
    await assert.rejects(
      () =>
        uploadStableDraftChannelAsset(
          draft,
          fixture.successorDescriptor,
          signaturePath,
          carrierContext,
          racingServices,
        ),
      /lease ownership asset changed/i,
    );
    const racedAsset = successorAssets.get(signatureName);
    assert.ok(racedAsset);
    const racedOwnedAssets = new Map([[signatureName, racedAsset]]);
    await assert.rejects(
      () =>
        deleteOwnedStableDraftChannelAssets(
          draft,
          fixture.successorDescriptor,
          carrierContext,
          racedOwnedAssets,
          services,
        ),
      /lease ownership asset changed/i,
    );
    assert.equal(successorAssets.has(signatureName), true);

    carrierAssets.set(
      BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
      originalLeaseSignature,
    );
    await deleteOwnedStableDraftChannelAssets(
      draft,
      fixture.successorDescriptor,
      carrierContext,
      racedOwnedAssets,
      services,
    );
    assert.equal(successorAssets.has(signatureName), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("receipt ownership state persists exact asset identity per descriptor and rejects replacement", () => {
  const fixture = rolloverFixture();
  const stateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-receipt-owner-"),
  );
  try {
    const persisted = persistStableRolloverReceiptOwnership(
      fixture.successorDescriptor,
      successorDescriptorSha256,
      fixture.receipt.owner,
      fixture.receiptAssets,
      stateDirectory,
    );
    assert.deepEqual(persisted.assets, fixture.receiptAssets);
    assert.deepEqual(
      loadStableRolloverReceiptOwnership(
        fixture.successorDescriptor,
        successorDescriptorSha256,
        stateDirectory,
      ).assets,
      fixture.receiptAssets,
    );
    assert.deepEqual(
      persistStableRolloverReceiptOwnership(
        fixture.successorDescriptor,
        successorDescriptorSha256,
        fixture.receipt.owner,
        fixture.receiptAssets,
        stateDirectory,
      ).assets,
      fixture.receiptAssets,
    );

    const changedAssets = new Map(fixture.receiptAssets);
    changedAssets.set(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME, {
      ...changedAssets.get(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME),
      id: changedAssets.get(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME).id + 1,
    });
    assert.throws(
      () =>
        persistStableRolloverReceiptOwnership(
          fixture.successorDescriptor,
          successorDescriptorSha256,
          fixture.receipt.owner,
          changedAssets,
          stateDirectory,
        ),
      /ownership changed/i,
    );
    clearStableRolloverReceiptOwnership(
      successorDescriptorSha256,
      stateDirectory,
    );
    assert.equal(
      loadStableRolloverReceiptOwnership(
        fixture.successorDescriptor,
        successorDescriptorSha256,
        stateDirectory,
      ),
      null,
    );
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

function canonicalFixtureJson(value) {
  const sort = (current) => {
    if (Array.isArray(current)) return current.map(sort);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((key) => [key, sort(current[key])]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

test("anonymous stable-channel verification authenticates retained receipt history while rejecting live controls", async () => {
  const { verifyPublishedStableChannel } =
    await import("./release-publication.js");
  const fixture = rolloverFixture();
  const descriptor = structuredClone(fixture.successorDescriptor);
  descriptor.release.signingKeyFingerprint = "A".repeat(40);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-public-stable-channel-"),
  );
  try {
    const receiptPath = path.join(directory, STABLE_ROLLOVER_RECEIPT_NAME);
    const signaturePath = path.join(
      directory,
      STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
    );
    fs.writeFileSync(receiptPath, canonicalFixtureJson(fixture.receipt));
    fs.writeFileSync(signaturePath, "signed receipt");
    let signatureChecks = 0;
    const verified = verifyPublishedStableChannel({
      carrier: fixture.latest,
      carrierDescriptor: descriptor,
      carrierDescriptorSha256: successorDescriptorSha256,
      channelAssetsByName: new Map(fixture.receiptAssets),
      digestByName: new Map(),
      directory,
      productIndexSha256: successorProductIndexSha256,
      verifySignature: (actualReceipt, actualSignature, fingerprint) => {
        assert.equal(actualReceipt, receiptPath);
        assert.equal(actualSignature, signaturePath);
        assert.equal(fingerprint, descriptor.release.signingKeyFingerprint);
        signatureChecks += 1;
      },
    });
    assert.equal(signatureChecks, 1);
    assert.equal(verified.channelState, null);
    assert.deepEqual(verified.stableReceipt, fixture.receipt);

    const singleton = new Map(fixture.receiptAssets);
    singleton.delete(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME);
    assert.throws(
      () =>
        verifyPublishedStableChannel({
          carrier: fixture.latest,
          carrierDescriptor: descriptor,
          carrierDescriptorSha256: successorDescriptorSha256,
          channelAssetsByName: singleton,
          digestByName: new Map(),
          directory,
          productIndexSha256: successorProductIndexSha256,
          verifySignature: () => true,
        }),
      /receipt signature pair is incomplete/i,
    );

    const operational = new Map(fixture.receiptAssets);
    operational.set("beta-channel-transaction.json", {
      id: 999,
      name: "beta-channel-transaction.json",
      digest: `sha256:${"0".repeat(64)}`,
    });
    assert.throws(
      () =>
        verifyPublishedStableChannel({
          carrier: fixture.latest,
          carrierDescriptor: descriptor,
          carrierDescriptorSha256: successorDescriptorSha256,
          channelAssetsByName: operational,
          digestByName: new Map(),
          directory,
          productIndexSha256: successorProductIndexSha256,
          verifySignature: () => true,
        }),
      /unfinished channel control assets/i,
    );

    const foreignMigration = new Map([
      [
        LEGACY_BETA_CHANNEL_MIGRATION_NAME,
        {
          id: 1000,
          name: LEGACY_BETA_CHANNEL_MIGRATION_NAME,
          digest: `sha256:${"1".repeat(64)}`,
        },
      ],
      [
        LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
        {
          id: 1001,
          name: LEGACY_BETA_CHANNEL_MIGRATION_SIGNATURE_NAME,
          digest: `sha256:${"2".repeat(64)}`,
        },
      ],
    ]);
    assert.throws(
      () =>
        verifyPublishedStableChannel({
          carrier: fixture.latest,
          carrierDescriptor: descriptor,
          carrierDescriptorSha256: successorDescriptorSha256,
          channelAssetsByName: foreignMigration,
          digestByName: new Map(),
          directory,
          productIndexSha256: successorProductIndexSha256,
          verifySignature: () => true,
        }),
      /valid only on their signed legacy stable carrier/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retained receipt history does not block the next stable rollover acquisition", async () => {
  const { assertRolloverAcquisitionState } =
    await import("./release-publication.js");
  const fixture = rolloverFixture();
  const retainedAssets = new Map(fixture.receiptAssets);
  let carrierChecks = 0;
  const channelAssets = await assertRolloverAcquisitionState(
    {
      assertCarrier: async (assets) => {
        assert.deepEqual(assets, Array.from(retainedAssets.values()));
        carrierChecks += 1;
      },
      carrierDescriptor: fixture.successorDescriptor,
      verification: { channelAssetsByName: retainedAssets },
    },
    Array.from(retainedAssets.values()),
    new Map(),
  );
  assert.equal(carrierChecks, 1);
  assert.deepEqual(channelAssets, retainedAssets);
});
