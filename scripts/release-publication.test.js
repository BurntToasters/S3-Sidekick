import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BETA_CHANNEL_ROLLOVER_NAME,
  BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  STABLE_ROLLOVER_RECEIPT_NAME,
  STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  createBetaChannelRollover,
  createStableRolloverReceipt,
  permanentBetaChannelAssetNames,
} from "./release-channel.js";
import {
  abortStableRolloverDraft,
  clearStableRolloverReceiptOwnership,
  deleteOwnedStableDraftChannelAssets,
  loadStableRolloverReceiptOwnership,
  persistStableRolloverReceiptOwnership,
  runPublication,
  settlePublishedStableRolloverReceipt,
  uploadStableDraftChannelAsset,
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

test("published stable retries settle full, partial, and already-removed predecessor leases before deleting the receipt", async (t) => {
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
        "cleaned",
      );
      assert.deepEqual(events, ["predecessor", "receipt"]);
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

test("published stable retry handles only protocol-reachable receipt singleton states", async () => {
  const fixture = rolloverFixture();
  const indexAsset = fixture.successorAssets[0];
  const signatureAsset = fixture.receiptAssets.get(
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  );
  const singletonEvents = [];
  assert.equal(
    await settlePublishedStableRolloverReceipt(
      fixture.latest,
      fixture.successorDescriptor,
      {
        deleteSuccessorReceipt: async (
          release,
          descriptor,
          assets,
          options,
        ) => {
          assert.equal(release, fixture.latest);
          assert.equal(descriptor, fixture.successorDescriptor);
          assert.deepEqual(
            assets,
            new Map([[STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME, signatureAsset]]),
          );
          assert.deepEqual(options, { requireDraft: false });
          singletonEvents.push("signature");
        },
        clearReceiptOwnership: async () => {},
        getLatestRelease: async () => fixture.latest,
        listReleaseAssets: async () => [indexAsset, signatureAsset],
        loadReceiptOwnership: async () => ({
          assets: fixture.receiptAssets,
          owner: fixture.receipt.owner,
        }),
        successorDescriptorSha256,
      },
    ),
    "cleaned-receipt",
  );
  assert.deepEqual(singletonEvents, ["signature"]);

  const replacedSignature = {
    ...signatureAsset,
    id: signatureAsset.id + 1,
    digest: `sha256:${"0".repeat(64)}`,
  };
  await assert.rejects(
    () =>
      settlePublishedStableRolloverReceipt(
        fixture.latest,
        fixture.successorDescriptor,
        {
          deleteSuccessorReceipt: async () =>
            assert.fail("replaced receipt signature was deleted"),
          getLatestRelease: async () => fixture.latest,
          listReleaseAssets: async () => [indexAsset, replacedSignature],
          loadReceiptOwnership: async () => ({
            assets: fixture.receiptAssets,
            owner: fixture.receipt.owner,
          }),
          successorDescriptorSha256,
        },
      ),
    /signature singleton is not owned/i,
  );

  const jsonAsset = fixture.receiptAssets.get(STABLE_ROLLOVER_RECEIPT_NAME);
  await assert.rejects(
    () =>
      settlePublishedStableRolloverReceipt(
        fixture.latest,
        fixture.successorDescriptor,
        {
          getLatestRelease: async () => fixture.latest,
          listReleaseAssets: async () => [indexAsset, jsonAsset],
          loadReceiptOwnership: async () => null,
          successorDescriptorSha256,
        },
      ),
    /missing its signature/i,
  );
  assert.equal(
    await settlePublishedStableRolloverReceipt(
      fixture.latest,
      fixture.successorDescriptor,
      {
        getLatestRelease: async () => fixture.latest,
        listReleaseAssets: async () => [indexAsset],
        loadReceiptOwnership: async () => null,
        successorDescriptorSha256,
      },
    ),
    "none",
  );
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
