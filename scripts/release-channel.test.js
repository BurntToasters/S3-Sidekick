import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BETA_CHANNEL_ROLLOVER_NAME,
  BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  BETA_CHANNEL_STATE_NAME,
  BETA_CHANNEL_STATE_SIGNATURE_NAME,
  BETA_CHANNEL_TRANSACTION_NAME,
  BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
  STABLE_ROLLOVER_RECEIPT_NAME,
  STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  backupName,
  createBetaChannelRollover as createSignedBetaChannelRollover,
  createBetaChannelState,
  createBetaChannelTransaction as createSignedBetaChannelTransaction,
  createStableRolloverReceipt,
  expectedBetaChannelAssetNames,
  expectedBetaManifestNames,
  permanentBetaChannelAssetNames,
  promoteBetaChannelAssets,
  recoverBetaChannelTransaction,
  recoverIncompleteChannelControlPair,
  splitStableReleaseAssets,
  stableChannelAssetNames,
  stageName,
  validateBetaChannelRollover as validateSignedBetaChannelRollover,
  validateBetaChannelState,
  validateBetaChannelTransaction,
  validatePublicationOwner,
  validateStableRolloverReceipt,
} from "./release-channel.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixtureDescriptor(prerelease = false) {
  return {
    expectedTargets: ["linux-x86_64"],
    release: {
      id: prerelease ? 84 : 42,
      prerelease,
      tag: prerelease ? "v1.2.4-beta.1" : "v1.2.3",
      version: prerelease ? "1.2.4-beta.1" : "1.2.3",
    },
    repository: { owner: "Owner", name: "Repository" },
    source: { commit: "c".repeat(40) },
  };
}

function publicationOwner({ descriptorSha256, releaseId, sourceCommit }) {
  return {
    schemaVersion: 1,
    descriptorSha256,
    releaseId,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    sourceCommit,
  };
}

function createBetaChannelTransaction(options) {
  const sourceCommit = options.sourceCommit || "c".repeat(40);
  const sourceVersion = options.sourceVersion || "1.2.4-beta.1";
  return createSignedBetaChannelTransaction({
    ...options,
    owner:
      options.owner ||
      publicationOwner({
        descriptorSha256: options.sourceDescriptorSha256,
        releaseId: options.sourceReleaseId,
        sourceCommit,
      }),
    sourceCommit,
    sourceVersion,
  });
}

function createBetaChannelRollover(options) {
  return createSignedBetaChannelRollover({
    ...options,
    carrierVersion: options.carrierVersion || "1.2.3",
    owner:
      options.owner ||
      publicationOwner({
        descriptorSha256: options.successorDescriptorSha256,
        releaseId: options.successor.id,
        sourceCommit: options.successorDescriptor.source.commit,
      }),
  });
}

function validateBetaChannelRollover(rollover, options) {
  return validateSignedBetaChannelRollover(rollover, {
    carrierVersion: "1.2.3",
    ...options,
  });
}

function makeRemote(initialRecords) {
  let nextId = 100;
  const assets = new Map([
    [
      "stable-product.zip",
      {
        id: 1,
        name: "stable-product.zip",
        digest: `sha256:${"f".repeat(64)}`,
      },
    ],
  ]);
  for (const [name, digest] of initialRecords) {
    assets.set(name, { id: nextId, name, digest: `sha256:${digest}` });
    nextId += 1;
  }
  const mutations = [];
  let failRenameTo = null;
  let failUploadName = null;
  let failUploadAfterWrite = false;
  let failed = false;
  const listAssets = async () =>
    Array.from(assets.values(), (asset) => ({ ...asset }));
  const uploadAsset = async (_releaseId, filePath) => {
    const name = path.basename(filePath);
    if (assets.has(name)) throw new Error(`duplicate upload ${name}`);
    if (failUploadName === name && !failUploadAfterWrite) {
      throw new Error(`injected upload failure for ${name}`);
    }
    const digest = sha256(fs.readFileSync(filePath));
    assets.set(name, { id: nextId, name, digest: `sha256:${digest}` });
    nextId += 1;
    mutations.push({ type: "upload", name });
    if (failUploadName === name && failUploadAfterWrite) {
      throw new Error(`injected post-write upload failure for ${name}`);
    }
  };
  const deleteAsset = async (assetId) => {
    const asset = Array.from(assets.values()).find(({ id }) => id === assetId);
    if (!asset) throw new Error(`missing delete id ${assetId}`);
    if (asset.name === "stable-product.zip") {
      throw new Error("attempted stable product deletion");
    }
    assets.delete(asset.name);
    mutations.push({ type: "delete", name: asset.name });
  };
  const renameAsset = async (assetId, name) => {
    const asset = Array.from(assets.values()).find(({ id }) => id === assetId);
    if (!asset) throw new Error(`missing rename id ${assetId}`);
    if (asset.name === "stable-product.zip") {
      throw new Error("attempted stable product rename");
    }
    if (failRenameTo === name && !failed) {
      failed = true;
      throw new Error(`injected rename failure for ${name}`);
    }
    if (assets.has(name)) throw new Error(`duplicate rename ${name}`);
    assets.delete(asset.name);
    assets.set(name, { ...asset, name });
    mutations.push({ from: asset.name, type: "rename", name });
  };
  return {
    assets,
    deleteAsset,
    listAssets,
    mutations,
    renameAsset,
    setFailure(name) {
      failRenameTo = name;
    },
    setUploadFailure(name, { afterWrite = false } = {}) {
      failUploadName = name;
      failUploadAfterWrite = afterWrite;
    },
    uploadAsset,
  };
}

function recordsFromFiles(filesByName) {
  return new Map(
    Array.from(filesByName, ([name, filePath]) => [
      name,
      sha256(fs.readFileSync(filePath)),
    ]),
  );
}

function assertRemoteRecords(remote, records) {
  for (const [name, digest] of records) {
    assert.equal(remote.assets.get(name)?.digest, `sha256:${digest}`, name);
  }
}

test("beta channel names are exact, descriptor-derived, and separate from stable product closure", () => {
  assert.deepEqual(expectedBetaManifestNames(["linux-x86_64"]), [
    "latest-linux-beta-x86_64.json",
  ]);
  assert.deepEqual(expectedBetaChannelAssetNames(["linux-x86_64"]), [
    "latest-linux-beta-x86_64.json",
    "latest-linux-beta-x86_64.json.asc",
  ]);
  assert.throws(
    () => expectedBetaChannelAssetNames(["linux-x64"]),
    /unsupported target/i,
  );
  assert.throws(
    () => expectedBetaChannelAssetNames(["linux-x86_64", "linux-x86_64"]),
    /duplicates/i,
  );

  const descriptor = fixtureDescriptor(false);
  const exactChannelName = "latest-linux-beta-x86_64.json";
  const nearMiss = "latest-linux-beta-x64.json";
  const assets = new Map([
    ["stable-product.zip", { id: 1, name: "stable-product.zip" }],
    [exactChannelName, { id: 2, name: exactChannelName }],
    [nearMiss, { id: 3, name: nearMiss }],
  ]);
  const split = splitStableReleaseAssets(descriptor, assets);
  assert.equal(split.channelAssetsByName.has(exactChannelName), true);
  assert.equal(split.productAssetsByName.has("stable-product.zip"), true);
  assert.equal(split.productAssetsByName.has(nearMiss), true);
  assert.equal(
    splitStableReleaseAssets(fixtureDescriptor(true), assets)
      .channelAssetsByName.size,
    0,
  );
  const allowed = stableChannelAssetNames(descriptor);
  for (const name of permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  )) {
    assert.equal(allowed.has(name), true);
    assert.equal(allowed.has(stageName(name)), true);
    assert.equal(allowed.has(backupName(name)), true);
  }
});

test("signed beta channel state and transaction records bind carrier, source, targets, and exact digests", () => {
  const carrierDescriptor = fixtureDescriptor(false);
  const sourceDescriptor = fixtureDescriptor(true);
  const carrier = {
    id: carrierDescriptor.release.id,
    tag_name: carrierDescriptor.release.tag,
  };
  const assetRecords = expectedBetaChannelAssetNames(
    sourceDescriptor.expectedTargets,
  ).map((name, index) => ({ name, sha256: String(index + 1).repeat(64) }));
  const state = createBetaChannelState({
    assetRecords,
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    productIndexSha256: "b".repeat(64),
    sourceDescriptor,
    sourceDescriptorSha256: "c".repeat(64),
  });
  assert.equal(
    validateBetaChannelState(state, {
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      expectedTargets: carrierDescriptor.expectedTargets,
      productIndexSha256: "b".repeat(64),
    }),
    state,
  );
  assert.throws(
    () =>
      validateBetaChannelState(state, {
        carrier: { ...carrier, id: 99 },
        carrierDescriptorSha256: "a".repeat(64),
        expectedTargets: carrierDescriptor.expectedTargets,
        productIndexSha256: "b".repeat(64),
      }),
    /malformed or stale/i,
  );

  const permanentNames = permanentBetaChannelAssetNames(
    carrierDescriptor.expectedTargets,
  );
  const desired = new Map(
    permanentNames.map((name, index) => [name, String(index + 2).repeat(64)]),
  );
  const previous = new Map(
    permanentNames.map((name, index) => [name, String(index + 6).repeat(64)]),
  );
  const transaction = createBetaChannelTransaction({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    desiredRecords: desired,
    previousRecords: previous,
    productIndexSha256: "b".repeat(64),
    sourceDescriptorSha256: "c".repeat(64),
    sourceReleaseId: sourceDescriptor.release.id,
    sourceTag: sourceDescriptor.release.tag,
  });
  const validated = validateBetaChannelTransaction(transaction, {
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    expectedNames: permanentNames,
    productIndexSha256: "b".repeat(64),
  });
  assert.deepEqual(validated.desired, desired);
  assert.deepEqual(validated.previous, previous);
  assert.throws(
    () =>
      validateBetaChannelTransaction(
        { ...transaction, transactionId: "0".repeat(64) },
        {
          carrier,
          carrierDescriptorSha256: "a".repeat(64),
          expectedNames: permanentNames,
          productIndexSha256: "b".repeat(64),
        },
      ),
    /transaction id is invalid/i,
  );
});

test("signed stable rollover leases bind both releases and the exact beta snapshot", () => {
  const carrierDescriptor = fixtureDescriptor(false);
  const successorDescriptor = {
    ...fixtureDescriptor(false),
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
  const channelRecords = new Map(
    permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets).map(
      (name, index) => [name, String(index + 1).repeat(64)],
    ),
  );
  const rollover = createBetaChannelRollover({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    channelRecords,
    productIndexSha256: "b".repeat(64),
    successor,
    successorDescriptor,
    successorDescriptorSha256: "c".repeat(64),
    successorProductIndexSha256: "d".repeat(64),
  });
  assert.deepEqual(
    validateBetaChannelRollover(rollover, {
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      expectedTargets: carrierDescriptor.expectedTargets,
      productIndexSha256: "b".repeat(64),
      successor,
      successorDescriptor,
      successorDescriptorSha256: "c".repeat(64),
      successorProductIndexSha256: "d".repeat(64),
    }),
    channelRecords,
  );
  assert.throws(
    () =>
      validateBetaChannelRollover(
        { ...rollover, rolloverId: "0".repeat(64) },
        {
          carrier,
          carrierDescriptorSha256: "a".repeat(64),
          expectedTargets: carrierDescriptor.expectedTargets,
          productIndexSha256: "b".repeat(64),
        },
      ),
    /rollover id is invalid/i,
  );
  assert.throws(
    () =>
      validateBetaChannelRollover(rollover, {
        carrier,
        carrierDescriptorSha256: "a".repeat(64),
        expectedTargets: carrierDescriptor.expectedTargets,
        productIndexSha256: "b".repeat(64),
        successor: { ...successor, id: 99 },
      }),
    /successor release is stale/i,
  );
});

test("beta promotion swaps only channel assets, verifies JSON last, and retries idempotently", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-channel-transaction-"),
  );
  try {
    const desiredFiles = new Map();
    for (const name of permanentBetaChannelAssetNames(
      descriptor.expectedTargets,
    )) {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `desired:${name}`);
      desiredFiles.set(name, filePath);
    }
    const desired = recordsFromFiles(desiredFiles);
    const previous = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`previous:${name}`)]),
    );
    const remote = makeRemote(previous);
    const transaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: previous,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    const transactionPath = path.join(directory, BETA_CHANNEL_TRANSACTION_NAME);
    const transactionSignaturePath = path.join(
      directory,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    );
    fs.writeFileSync(transactionPath, JSON.stringify(transaction));
    fs.writeFileSync(transactionSignaturePath, "transaction signature");
    const productBefore = { ...remote.assets.get("stable-product.zip") };
    const assertCarrier = async (assets) => {
      const product = assets.find(({ name }) => name === "stable-product.zip");
      assert.deepEqual(product, productBefore);
    };
    let desiredVerifications = 0;
    const result = await promoteBetaChannelAssets({
      assertCarrier,
      deleteAsset: remote.deleteAsset,
      descriptor,
      desiredFilesByName: desiredFiles,
      listAssets: remote.listAssets,
      releaseId: carrier.id,
      renameAsset: remote.renameAsset,
      publicationOwner: transaction.owner,
      transaction,
      transactionFiles: [transactionPath, transactionSignaturePath],
      uploadAsset: remote.uploadAsset,
      verifyDesired: async () => {
        desiredVerifications += 1;
        assertRemoteRecords(remote, desired);
      },
      verifyPrevious: async () => assertRemoteRecords(remote, previous),
    });
    assert.equal(result, "promoted");
    assert.equal(desiredVerifications, 1);
    assert.deepEqual(
      remote.mutations
        .filter(({ type }) => type === "upload")
        .slice(0, 2)
        .map(({ name }) => name),
      [BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME, BETA_CHANNEL_TRANSACTION_NAME],
    );
    assertRemoteRecords(remote, desired);
    const canonicalRenames = remote.mutations
      .filter(({ type, name }) => type === "rename" && desired.has(name))
      .map(({ name }) => name);
    assert.deepEqual(canonicalRenames, [
      "latest-linux-beta-x86_64.json.asc",
      "latest-linux-beta-x86_64.json",
      BETA_CHANNEL_STATE_SIGNATURE_NAME,
      BETA_CHANNEL_STATE_NAME,
    ]);
    assert.equal(
      Array.from(remote.assets.keys()).some(
        (name) =>
          name.startsWith("beta-channel-stage--") ||
          name.startsWith("beta-channel-backup--") ||
          name.startsWith("beta-channel-transaction"),
      ),
      false,
    );
    assert.deepEqual(remote.assets.get("stable-product.zip"), productBefore);

    const mutationCount = remote.mutations.length;
    const retryTransaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: desired,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    assert.equal(
      await promoteBetaChannelAssets({
        assertCarrier,
        deleteAsset: remote.deleteAsset,
        descriptor,
        desiredFilesByName: desiredFiles,
        listAssets: remote.listAssets,
        releaseId: carrier.id,
        renameAsset: remote.renameAsset,
        publicationOwner: retryTransaction.owner,
        transaction: retryTransaction,
        transactionFiles: [transactionPath, transactionSignaturePath],
        uploadAsset: remote.uploadAsset,
        verifyDesired: async () => assertRemoteRecords(remote, desired),
        verifyPrevious: async () => assertRemoteRecords(remote, desired),
      }),
      "unchanged",
    );
    assert.equal(remote.mutations.length, mutationCount);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("promotion failures restore the exact previous pointer set and leave stable products untouched", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-channel-rollback-"),
  );
  try {
    const desiredFiles = new Map();
    for (const name of permanentBetaChannelAssetNames(
      descriptor.expectedTargets,
    )) {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `desired:${name}`);
      desiredFiles.set(name, filePath);
    }
    const desired = recordsFromFiles(desiredFiles);
    const previous = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`previous:${name}`)]),
    );
    const remote = makeRemote(previous);
    const productBefore = { ...remote.assets.get("stable-product.zip") };
    remote.setFailure("latest-linux-beta-x86_64.json");
    const transaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: previous,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    const transactionPath = path.join(directory, BETA_CHANNEL_TRANSACTION_NAME);
    const transactionSignaturePath = path.join(
      directory,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    );
    fs.writeFileSync(transactionPath, JSON.stringify(transaction));
    fs.writeFileSync(transactionSignaturePath, "transaction signature");
    await assert.rejects(
      () =>
        promoteBetaChannelAssets({
          assertCarrier: async (assets) => {
            const product = assets.find(
              ({ name }) => name === "stable-product.zip",
            );
            assert.deepEqual(product, productBefore);
          },
          deleteAsset: remote.deleteAsset,
          descriptor,
          desiredFilesByName: desiredFiles,
          listAssets: remote.listAssets,
          releaseId: carrier.id,
          renameAsset: remote.renameAsset,
          publicationOwner: transaction.owner,
          transaction,
          transactionFiles: [transactionPath, transactionSignaturePath],
          uploadAsset: remote.uploadAsset,
          verifyDesired: async () => assertRemoteRecords(remote, desired),
          verifyPrevious: async () => assertRemoteRecords(remote, previous),
        }),
      /injected rename failure/i,
    );
    assertRemoteRecords(remote, previous);
    assert.deepEqual(remote.assets.get("stable-product.zip"), productBefore);
    assert.equal(
      Array.from(remote.assets.keys()).some(
        (name) =>
          name.startsWith("beta-channel-stage--") ||
          name.startsWith("beta-channel-backup--") ||
          name.startsWith("beta-channel-transaction"),
      ),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("durable retry recovery restores remote backups after an interrupted swap", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const names = permanentBetaChannelAssetNames(descriptor.expectedTargets);
  const previous = new Map(
    names.map((name) => [name, sha256(`previous:${name}`)]),
  );
  const desired = new Map(
    names.map((name) => [name, sha256(`desired:${name}`)]),
  );
  const transaction = createBetaChannelTransaction({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    desiredRecords: desired,
    previousRecords: previous,
    productIndexSha256: "b".repeat(64),
    sourceDescriptorSha256: "c".repeat(64),
    sourceReleaseId: 84,
    sourceTag: "v1.2.4-beta.1",
  });
  const remote = makeRemote(previous);
  const interruptedName = "latest-linux-beta-x86_64.json.asc";
  const old = remote.assets.get(interruptedName);
  remote.assets.delete(interruptedName);
  remote.assets.set(backupName(interruptedName), {
    ...old,
    name: backupName(interruptedName),
  });
  remote.assets.set(interruptedName, {
    id: 999,
    name: interruptedName,
    digest: `sha256:${desired.get(interruptedName)}`,
  });
  remote.assets.set(BETA_CHANNEL_TRANSACTION_NAME, {
    id: 1000,
    name: BETA_CHANNEL_TRANSACTION_NAME,
    digest: `sha256:${sha256("transaction")}`,
  });
  remote.assets.set(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME, {
    id: 1001,
    name: BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    digest: `sha256:${sha256("signature")}`,
  });
  const transactionAssets = new Map([
    [
      BETA_CHANNEL_TRANSACTION_NAME,
      remote.assets.get(BETA_CHANNEL_TRANSACTION_NAME),
    ],
    [
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
      remote.assets.get(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
    ],
  ]);
  assert.equal(
    await recoverBetaChannelTransaction({
      assertCarrier: async () => true,
      deleteAsset: remote.deleteAsset,
      descriptor,
      expectedOwner: transaction.owner,
      listAssets: remote.listAssets,
      releaseId: carrier.id,
      renameAsset: remote.renameAsset,
      transaction,
      transactionAssets,
      verifyDesired: async () => assertRemoteRecords(remote, desired),
      verifyPrevious: async () => assertRemoteRecords(remote, previous),
    }),
    "rolled-back",
  );
  assert.equal(transactionAssets.size, 0);
  assertRemoteRecords(remote, previous);
  assert.equal(remote.assets.has(BETA_CHANNEL_TRANSACTION_NAME), false);
  assert.equal(
    remote.assets.has(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
    false,
  );
});
test("incomplete transaction and rollover pairs are cleaned only before channel mutation", async () => {
  const descriptor = fixtureDescriptor(false);
  const previous = new Map(
    permanentBetaChannelAssetNames(descriptor.expectedTargets).map((name) => [
      name,
      sha256(`previous:${name}`),
    ]),
  );
  for (const [kind, name] of [
    ["transaction", BETA_CHANNEL_TRANSACTION_NAME],
    ["transaction", BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME],
    ["rollover", BETA_CHANNEL_ROLLOVER_NAME],
    ["rollover", BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME],
  ]) {
    const remote = makeRemote(previous);
    const expectedAsset = {
      id: 900,
      name,
      digest: `sha256:${sha256(`${kind}:${name}`)}`,
    };
    remote.assets.set(name, expectedAsset);
    let permanentVerifications = 0;
    assert.equal(
      await recoverIncompleteChannelControlPair({
        assertCarrier: async () => true,
        deleteAsset: remote.deleteAsset,
        descriptor,
        expectedAsset,
        kind,
        listAssets: remote.listAssets,
        releaseId: descriptor.release.id,
        verifyPermanent: async () => {
          permanentVerifications += 1;
          assertRemoteRecords(remote, previous);
        },
      }),
      "cleaned",
    );
    assert.equal(permanentVerifications, 2);
    assert.equal(remote.assets.has(name), false);
    assertRemoteRecords(remote, previous);
  }

  const remote = makeRemote(previous);
  const expectedAsset = {
    id: 901,
    name: BETA_CHANNEL_TRANSACTION_NAME,
    digest: `sha256:${sha256("transaction")}`,
  };
  remote.assets.set(expectedAsset.name, expectedAsset);
  const stagedName = stageName("latest-linux-beta-x86_64.json.asc");
  remote.assets.set(stagedName, {
    id: 902,
    name: stagedName,
    digest: `sha256:${sha256("staged")}`,
  });
  await assert.rejects(
    () =>
      recoverIncompleteChannelControlPair({
        assertCarrier: async () => true,
        deleteAsset: remote.deleteAsset,
        descriptor,
        expectedAsset,
        kind: "transaction",
        listAssets: remote.listAssets,
        releaseId: descriptor.release.id,
        verifyPermanent: async () => assertRemoteRecords(remote, previous),
      }),
    /cannot be repaired after channel mutation/i,
  );
  assert.equal(remote.assets.has(expectedAsset.name), true);
  assert.equal(remote.assets.has(stagedName), true);
});

test("partial transaction-pair uploads recover without leaving a retry-blocking singleton", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-partial-transaction-"),
  );
  try {
    const desiredFiles = new Map();
    for (const name of permanentBetaChannelAssetNames(
      descriptor.expectedTargets,
    )) {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `desired:${name}`);
      desiredFiles.set(name, filePath);
    }
    const desired = recordsFromFiles(desiredFiles);
    const previous = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`previous:${name}`)]),
    );
    const transaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: previous,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    const transactionPath = path.join(directory, BETA_CHANNEL_TRANSACTION_NAME);
    const transactionSignaturePath = path.join(
      directory,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    );
    fs.writeFileSync(transactionPath, JSON.stringify(transaction));
    fs.writeFileSync(transactionSignaturePath, "transaction signature");

    for (const failedName of [
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
      BETA_CHANNEL_TRANSACTION_NAME,
    ]) {
      const remote = makeRemote(previous);
      remote.setUploadFailure(failedName, { afterWrite: true });
      await assert.rejects(
        () =>
          promoteBetaChannelAssets({
            assertCarrier: async () => true,
            deleteAsset: remote.deleteAsset,
            descriptor,
            desiredFilesByName: desiredFiles,
            listAssets: remote.listAssets,
            publicationOwner: transaction.owner,
            releaseId: carrier.id,
            renameAsset: remote.renameAsset,
            transaction,
            transactionFiles: [transactionPath, transactionSignaturePath],
            uploadAsset: remote.uploadAsset,
            verifyDesired: async () => assertRemoteRecords(remote, desired),
            verifyPrevious: async () => assertRemoteRecords(remote, previous),
          }),
        /injected post-write upload failure/i,
      );
      assertRemoteRecords(remote, previous);
      assert.equal(remote.assets.has(BETA_CHANNEL_TRANSACTION_NAME), false);
      assert.equal(
        remote.assets.has(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
        false,
      );
      assert.equal(
        Array.from(remote.assets.keys()).some(
          (name) =>
            name.startsWith("beta-channel-stage--") ||
            name.startsWith("beta-channel-backup--"),
        ),
        false,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an active or partial stable rollover lease blocks beta promotion before mutation", async () => {
  const descriptor = fixtureDescriptor(false);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-rollover-block-"),
  );
  try {
    const desiredFiles = new Map();
    for (const name of permanentBetaChannelAssetNames(
      descriptor.expectedTargets,
    )) {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `desired:${name}`);
      desiredFiles.set(name, filePath);
    }
    const desired = recordsFromFiles(desiredFiles);
    const previous = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`previous:${name}`)]),
    );
    const remote = makeRemote(previous);
    remote.assets.set(BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME, {
      id: 999,
      name: BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
      digest: `sha256:${sha256("rollover signature")}`,
    });
    const transaction = createBetaChannelTransaction({
      carrier: { id: 42, tag_name: "v1.2.3" },
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: previous,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    const transactionPath = path.join(directory, BETA_CHANNEL_TRANSACTION_NAME);
    const transactionSignaturePath = path.join(
      directory,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    );
    fs.writeFileSync(transactionPath, JSON.stringify(transaction));
    fs.writeFileSync(transactionSignaturePath, "transaction signature");
    await assert.rejects(
      () =>
        promoteBetaChannelAssets({
          assertCarrier: async () => true,
          deleteAsset: remote.deleteAsset,
          descriptor,
          desiredFilesByName: desiredFiles,
          listAssets: remote.listAssets,
          releaseId: 42,
          renameAsset: remote.renameAsset,
          publicationOwner: transaction.owner,
          transaction,
          transactionFiles: [transactionPath, transactionSignaturePath],
          uploadAsset: remote.uploadAsset,
          verifyDesired: async () => assertRemoteRecords(remote, desired),
          verifyPrevious: async () => assertRemoteRecords(remote, previous),
        }),
      /unfinished channel control assets/i,
    );
    assert.equal(remote.mutations.length, 0);
    assertRemoteRecords(remote, previous);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("publication owners bind transactions and rollover leases to one exact session", () => {
  const carrierDescriptor = fixtureDescriptor(false);
  const sourceDescriptor = fixtureDescriptor(true);
  const carrier = {
    id: carrierDescriptor.release.id,
    tag_name: carrierDescriptor.release.tag,
  };
  const names = permanentBetaChannelAssetNames(
    carrierDescriptor.expectedTargets,
  );
  const desired = new Map(
    names.map((name, index) => [name, String(index + 1).repeat(64)]),
  );
  const previous = new Map(
    names.map((name, index) => [name, String(index + 5).repeat(64)]),
  );
  const transaction = createBetaChannelTransaction({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    desiredRecords: desired,
    previousRecords: previous,
    productIndexSha256: "b".repeat(64),
    sourceDescriptorSha256: "c".repeat(64),
    sourceReleaseId: sourceDescriptor.release.id,
    sourceTag: sourceDescriptor.release.tag,
  });
  const foreignOwner = {
    ...transaction.owner,
    sessionId: "223e4567-e89b-42d3-a456-426614174000",
  };
  assert.equal(validatePublicationOwner(transaction.owner), transaction.owner);
  assert.deepEqual(
    validateBetaChannelTransaction(transaction, {
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      expectedNames: names,
      expectedOwner: transaction.owner,
      productIndexSha256: "b".repeat(64),
    }).desired,
    desired,
  );
  assert.throws(
    () =>
      validateBetaChannelTransaction(transaction, {
        carrier,
        carrierDescriptorSha256: "a".repeat(64),
        expectedNames: names,
        expectedOwner: foreignOwner,
        productIndexSha256: "b".repeat(64),
      }),
    /different publication session/i,
  );
  assert.throws(
    () =>
      validateBetaChannelTransaction(
        { ...transaction, owner: foreignOwner },
        {
          carrier,
          carrierDescriptorSha256: "a".repeat(64),
          expectedNames: names,
          productIndexSha256: "b".repeat(64),
        },
      ),
    /transaction id is invalid/i,
  );

  const successorDescriptor = {
    ...fixtureDescriptor(false),
    release: {
      id: 43,
      prerelease: false,
      tag: "v1.2.4",
      version: "1.2.4",
    },
    source: { commit: "d".repeat(40) },
  };
  const successor = {
    id: successorDescriptor.release.id,
    tag_name: successorDescriptor.release.tag,
  };
  const rollover = createBetaChannelRollover({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    channelRecords: previous,
    productIndexSha256: "b".repeat(64),
    successor,
    successorDescriptor,
    successorDescriptorSha256: "c".repeat(64),
    successorProductIndexSha256: "d".repeat(64),
  });
  assert.deepEqual(
    validateBetaChannelRollover(rollover, {
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      expectedOwner: rollover.owner,
      expectedTargets: carrierDescriptor.expectedTargets,
      productIndexSha256: "b".repeat(64),
      successor,
      successorDescriptor,
      successorDescriptorSha256: "c".repeat(64),
      successorProductIndexSha256: "d".repeat(64),
    }),
    previous,
  );
  assert.throws(
    () =>
      validateBetaChannelRollover(rollover, {
        carrier,
        carrierDescriptorSha256: "a".repeat(64),
        expectedOwner: { ...rollover.owner, sessionId: foreignOwner.sessionId },
        expectedTargets: carrierDescriptor.expectedTargets,
        productIndexSha256: "b".repeat(64),
      }),
    /different publication session/i,
  );
});

test("signed stable rollover receipts bind exact predecessor controls and stay outside product closure", () => {
  const carrierDescriptor = fixtureDescriptor(false);
  const successorDescriptor = {
    ...fixtureDescriptor(false),
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
  const channelRecords = new Map(
    permanentBetaChannelAssetNames(carrierDescriptor.expectedTargets).map(
      (name, index) => [name, String(index + 1).repeat(64)],
    ),
  );
  const rollover = createBetaChannelRollover({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    channelRecords,
    productIndexSha256: "b".repeat(64),
    successor,
    successorDescriptor,
    successorDescriptorSha256: "c".repeat(64),
    successorProductIndexSha256: "d".repeat(64),
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
    owner: rollover.owner,
    rollover,
    successor,
    successorDescriptor,
    successorDescriptorSha256: "c".repeat(64),
    successorProductIndexSha256: "d".repeat(64),
  });
  const validated = validateStableRolloverReceipt(receipt, {
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    carrierProductIndexSha256: "b".repeat(64),
    expectedOwner: rollover.owner,
    rollover,
    successor,
    successorDescriptor,
    successorDescriptorSha256: "c".repeat(64),
    successorProductIndexSha256: "d".repeat(64),
  });
  assert.deepEqual(Array.from(validated.values()), receipt.leaseAssets);
  assert.throws(
    () =>
      validateStableRolloverReceipt(receipt, {
        expectedOwner: {
          ...rollover.owner,
          sessionId: "223e4567-e89b-42d3-a456-426614174000",
        },
        successor,
        successorDescriptor,
        successorDescriptorSha256: "c".repeat(64),
        successorProductIndexSha256: "d".repeat(64),
      }),
    /different publication session/i,
  );
  const tampered = structuredClone(receipt);
  tampered.leaseAssets[0].id += 1;
  assert.throws(
    () =>
      validateStableRolloverReceipt(tampered, {
        successor,
        successorDescriptor,
        successorDescriptorSha256: "c".repeat(64),
        successorProductIndexSha256: "d".repeat(64),
      }),
    /receipt id is invalid/i,
  );

  const assets = new Map([
    ["stable-product.zip", { id: 1, name: "stable-product.zip" }],
    [
      STABLE_ROLLOVER_RECEIPT_NAME,
      { id: 2, name: STABLE_ROLLOVER_RECEIPT_NAME },
    ],
    [
      STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
      { id: 3, name: STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME },
    ],
    [
      `${STABLE_ROLLOVER_RECEIPT_NAME}.unexpected`,
      { id: 4, name: `${STABLE_ROLLOVER_RECEIPT_NAME}.unexpected` },
    ],
  ]);
  const split = splitStableReleaseAssets(successorDescriptor, assets);
  assert.equal(
    split.channelAssetsByName.has(STABLE_ROLLOVER_RECEIPT_NAME),
    true,
  );
  assert.equal(
    split.channelAssetsByName.has(STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME),
    true,
  );
  assert.equal(
    split.productAssetsByName.has(`${STABLE_ROLLOVER_RECEIPT_NAME}.unexpected`),
    true,
  );
});

test("beta promotion compare-and-swap refuses a newer pointer set installed before journal ownership", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-channel-cas-"),
  );
  try {
    const desiredFiles = new Map();
    for (const name of permanentBetaChannelAssetNames(
      descriptor.expectedTargets,
    )) {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, `desired:${name}`);
      desiredFiles.set(name, filePath);
    }
    const desired = recordsFromFiles(desiredFiles);
    const previous = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`previous:${name}`)]),
    );
    const newer = new Map(
      Array.from(desired.keys(), (name) => [name, sha256(`newer:${name}`)]),
    );
    const remote = makeRemote(previous);
    const transaction = createBetaChannelTransaction({
      carrier,
      carrierDescriptorSha256: "a".repeat(64),
      desiredRecords: desired,
      previousRecords: previous,
      productIndexSha256: "b".repeat(64),
      sourceDescriptorSha256: "c".repeat(64),
      sourceReleaseId: 84,
      sourceTag: "v1.2.4-beta.1",
    });
    const transactionPath = path.join(directory, BETA_CHANNEL_TRANSACTION_NAME);
    const transactionSignaturePath = path.join(
      directory,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    );
    fs.writeFileSync(transactionPath, JSON.stringify(transaction));
    fs.writeFileSync(transactionSignaturePath, "transaction signature");
    const racingUpload = async (releaseId, filePath) => {
      await remote.uploadAsset(releaseId, filePath);
      if (path.basename(filePath) === BETA_CHANNEL_TRANSACTION_NAME) {
        for (const [name, digest] of newer) {
          remote.assets.set(name, {
            ...remote.assets.get(name),
            digest: `sha256:${digest}`,
          });
        }
      }
    };
    let previousVerifications = 0;
    await assert.rejects(
      () =>
        promoteBetaChannelAssets({
          assertCarrier: async () => true,
          deleteAsset: remote.deleteAsset,
          descriptor,
          desiredFilesByName: desiredFiles,
          listAssets: remote.listAssets,
          publicationOwner: transaction.owner,
          releaseId: carrier.id,
          renameAsset: remote.renameAsset,
          transaction,
          transactionFiles: [transactionPath, transactionSignaturePath],
          uploadAsset: racingUpload,
          verifyDesired: async () => assertRemoteRecords(remote, desired),
          verifyPrevious: async () => {
            previousVerifications += 1;
          },
        }),
      /changed before the promotion journal acquired ownership/i,
    );
    assert.equal(previousVerifications, 0);
    assertRemoteRecords(remote, newer);
    assert.equal(
      remote.mutations.some(({ type }) => type === "rename"),
      false,
    );
    assert.equal(remote.assets.has(BETA_CHANNEL_TRANSACTION_NAME), false);
    assert.equal(
      remote.assets.has(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction recovery stops before pointer mutation when exact journal ownership changes", async () => {
  const descriptor = fixtureDescriptor(false);
  const carrier = { id: 42, tag_name: "v1.2.3" };
  const names = permanentBetaChannelAssetNames(descriptor.expectedTargets);
  const previous = new Map(
    names.map((name) => [name, sha256(`previous:${name}`)]),
  );
  const desired = new Map(
    names.map((name) => [name, sha256(`desired:${name}`)]),
  );
  const transaction = createBetaChannelTransaction({
    carrier,
    carrierDescriptorSha256: "a".repeat(64),
    desiredRecords: desired,
    previousRecords: previous,
    productIndexSha256: "b".repeat(64),
    sourceDescriptorSha256: "c".repeat(64),
    sourceReleaseId: 84,
    sourceTag: "v1.2.4-beta.1",
  });
  const remote = makeRemote(previous);
  remote.assets.set(BETA_CHANNEL_TRANSACTION_NAME, {
    id: 1000,
    name: BETA_CHANNEL_TRANSACTION_NAME,
    digest: `sha256:${sha256("transaction")}`,
  });
  remote.assets.set(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME, {
    id: 1001,
    name: BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    digest: `sha256:${sha256("signature")}`,
  });
  const stagedName = stageName(names.at(-1));
  remote.assets.set(stagedName, {
    id: 1002,
    name: stagedName,
    digest: `sha256:${desired.get(names.at(-1))}`,
  });
  const transactionAssets = new Map([
    [
      BETA_CHANNEL_TRANSACTION_NAME,
      remote.assets.get(BETA_CHANNEL_TRANSACTION_NAME),
    ],
    [
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
      remote.assets.get(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME),
    ],
  ]);
  let carrierChecks = 0;
  await assert.rejects(
    () =>
      recoverBetaChannelTransaction({
        assertCarrier: async () => {
          carrierChecks += 1;
          if (carrierChecks === 1) {
            remote.assets.set(BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME, {
              id: 2001,
              name: BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
              digest: `sha256:${sha256("foreign signature")}`,
            });
          }
        },
        deleteAsset: remote.deleteAsset,
        descriptor,
        expectedOwner: transaction.owner,
        listAssets: remote.listAssets,
        releaseId: carrier.id,
        renameAsset: remote.renameAsset,
        transaction,
        transactionAssets,
        verifyDesired: async () => assert.fail("desired verification ran"),
        verifyPrevious: async () => assert.fail("previous verification ran"),
      }),
    /recovery ownership changed/i,
  );
  assert.equal(remote.mutations.length, 0);
  assertRemoteRecords(remote, previous);
  assert.equal(remote.assets.has(stagedName), true);
});
