import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  artifactNameFromDescriptorReleaseUrl,
  canonicalJson,
  githubAssetSha256,
  normalizeGitHubRepository,
  sha256Buffer,
  sha256File,
  verifyDescriptorSignature,
} = require("./release-integrity.cjs");

const BETA_CHANNEL_STATE_NAME = "beta-channel.json";
const BETA_CHANNEL_STATE_SIGNATURE_NAME = `${BETA_CHANNEL_STATE_NAME}.asc`;
const BETA_CHANNEL_TRANSACTION_NAME = "beta-channel-transaction.json";
const BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME = `${BETA_CHANNEL_TRANSACTION_NAME}.asc`;
const BETA_CHANNEL_ROLLOVER_NAME = "beta-channel-rollover.json";
const BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME = `${BETA_CHANNEL_ROLLOVER_NAME}.asc`;
const STABLE_ROLLOVER_RECEIPT_NAME = "stable-rollover-receipt.json";
const STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME = `${STABLE_ROLLOVER_RECEIPT_NAME}.asc`;
const STAGE_PREFIX = "beta-channel-stage--";
const BACKUP_PREFIX = "beta-channel-backup--";
const TARGET_PATTERN = /^(darwin|linux|windows)-(aarch64|x86_64)$/;
const BETA_MANIFEST_PATTERN =
  /^latest-(darwin|linux|windows)-beta-(aarch64|x86_64)\.json$/;

function normalizedTargets(expectedTargets) {
  if (!Array.isArray(expectedTargets) || expectedTargets.length === 0) {
    throw new Error("Beta channel requires a nonempty expected target set.");
  }
  const targets = expectedTargets.map((target) => String(target));
  if (targets.some((target) => !TARGET_PATTERN.test(target))) {
    throw new Error("Beta channel contains an unsupported target.");
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error("Beta channel target set contains duplicates.");
  }
  return targets.sort((left, right) => left.localeCompare(right));
}

function expectedBetaManifestNames(expectedTargets) {
  return normalizedTargets(expectedTargets).map((target) => {
    const [osName, architecture] = target.split("-");
    return `latest-${osName}-beta-${architecture}.json`;
  });
}

function expectedBetaChannelAssetNames(expectedTargets) {
  return expectedBetaManifestNames(expectedTargets).flatMap((name) => [
    name,
    `${name}.asc`,
  ]);
}

function permanentBetaChannelAssetNames(expectedTargets) {
  return [
    ...expectedBetaChannelAssetNames(expectedTargets),
    BETA_CHANNEL_STATE_NAME,
    BETA_CHANNEL_STATE_SIGNATURE_NAME,
  ];
}

function stageName(name) {
  return `${STAGE_PREFIX}${name}`;
}

function backupName(name) {
  return `${BACKUP_PREFIX}${name}`;
}

function operationalBetaChannelAssetNames(expectedTargets) {
  const permanent = permanentBetaChannelAssetNames(expectedTargets);
  return [
    BETA_CHANNEL_TRANSACTION_NAME,
    BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    BETA_CHANNEL_ROLLOVER_NAME,
    BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
    STABLE_ROLLOVER_RECEIPT_NAME,
    STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
    ...permanent.map(stageName),
    ...permanent.map(backupName),
  ];
}

function stableChannelAssetNames(descriptor) {
  if (
    descriptor?.release?.prerelease ||
    !Array.isArray(descriptor?.expectedTargets) ||
    descriptor.expectedTargets.length === 0
  ) {
    return new Set();
  }
  return new Set([
    ...permanentBetaChannelAssetNames(descriptor.expectedTargets),
    ...operationalBetaChannelAssetNames(descriptor.expectedTargets),
  ]);
}

function isStableChannelAssetName(descriptor, name) {
  return stableChannelAssetNames(descriptor).has(name);
}

function splitStableReleaseAssets(descriptor, assetsByName) {
  const productAssetsByName = new Map();
  const channelAssetsByName = new Map();
  for (const [name, asset] of assetsByName) {
    if (isStableChannelAssetName(descriptor, name)) {
      channelAssetsByName.set(name, asset);
    } else {
      productAssetsByName.set(name, asset);
    }
  }
  return { channelAssetsByName, productAssetsByName };
}

function assertCanonicalFile(filePath, value, label) {
  if (fs.readFileSync(filePath, "utf8") !== canonicalJson(value)) {
    throw new Error(`${label} is not canonical JSON.`);
  }
}

function strictRecordMap(
  records,
  allowedNames,
  label,
  { complete = true } = {},
) {
  if (!Array.isArray(records)) {
    throw new Error(`${label} has no asset records.`);
  }
  const allowed = new Set(allowedNames);
  const values = new Map();
  for (const record of records) {
    if (
      typeof record?.name !== "string" ||
      !allowed.has(record.name) ||
      !/^[a-f0-9]{64}$/.test(record.sha256 || "") ||
      values.has(record.name)
    ) {
      throw new Error(`${label} contains a malformed asset record.`);
    }
    values.set(record.name, record.sha256);
  }
  if (complete && values.size !== allowed.size) {
    throw new Error(`${label} asset set is incomplete.`);
  }
  return values;
}

function assertSameTargets(actual, expected, label) {
  const actualTargets = normalizedTargets(actual);
  const expectedTargets = normalizedTargets(expected);
  if (canonicalJson(actualTargets) !== canonicalJson(expectedTargets)) {
    throw new Error(`${label} target set does not match the carrier.`);
  }
  return actualTargets;
}

function validatePublicationOwner(owner) {
  if (
    owner?.schemaVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      owner.sessionId || "",
    ) ||
    !Number.isSafeInteger(owner.releaseId) ||
    !/^[a-f0-9]{40,64}$/.test(owner.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(owner.descriptorSha256 || "")
  ) {
    throw new Error("Release publication owner is malformed.");
  }
  return owner;
}

function assertSamePublicationOwner(actual, expected, label) {
  validatePublicationOwner(actual);
  validatePublicationOwner(expected);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} is owned by a different publication session.`);
  }
  return actual;
}

function createBetaChannelState({
  carrier,
  carrierDescriptorSha256,
  productIndexSha256,
  sourceDescriptor,
  sourceDescriptorSha256,
  assetRecords,
}) {
  const expectedTargets = normalizedTargets(sourceDescriptor.expectedTargets);
  const records = Array.from(
    strictRecordMap(
      assetRecords,
      expectedBetaChannelAssetNames(expectedTargets),
      "Beta channel source",
    ),
    ([name, sha256]) => ({ name, sha256 }),
  ).sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    channel: "beta",
    carrier: {
      descriptorSha256: carrierDescriptorSha256,
      id: carrier.id,
      productIndexSha256,
      tag: carrier.tag_name,
    },
    source: {
      descriptorSha256: sourceDescriptorSha256,
      expectedTargets,
      id: sourceDescriptor.release.id,
      prerelease: true,
      repository: normalizeGitHubRepository(sourceDescriptor.repository),
      sourceCommit: sourceDescriptor.source.commit,
      tag: sourceDescriptor.release.tag,
      version: sourceDescriptor.release.version,
    },
    assets: records,
  };
}

function validateBetaChannelState(
  state,
  { carrier, carrierDescriptorSha256, expectedTargets, productIndexSha256 },
) {
  if (
    state?.schemaVersion !== 1 ||
    state.channel !== "beta" ||
    state.carrier?.id !== carrier.id ||
    state.carrier?.tag !== carrier.tag_name ||
    state.carrier?.descriptorSha256 !== carrierDescriptorSha256 ||
    state.carrier?.productIndexSha256 !== productIndexSha256 ||
    state.source?.prerelease !== true ||
    !Number.isSafeInteger(state.source?.id) ||
    typeof state.source?.tag !== "string" ||
    typeof state.source?.version !== "string" ||
    typeof state.source?.sourceCommit !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.source?.descriptorSha256 || "")
  ) {
    throw new Error("Beta channel state identity is malformed or stale.");
  }
  normalizeGitHubRepository(state.source.repository);
  assertSameTargets(
    state.source.expectedTargets,
    expectedTargets,
    "Beta channel state",
  );
  strictRecordMap(
    state.assets,
    expectedBetaChannelAssetNames(expectedTargets),
    "Beta channel state",
  );
  return state;
}

function verifyManifestForState(filePath, manifestName, state) {
  const match = manifestName.match(BETA_MANIFEST_PATTERN);
  if (!match)
    throw new Error(`Invalid beta channel manifest name: ${manifestName}.`);
  const targetName = `${match[1]}-beta`;
  const architecture = match[2];
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (manifest.version !== state.source.version) {
    throw new Error(`Beta channel manifest version mismatch: ${manifestName}.`);
  }
  const entries = Object.entries(manifest.platforms || {});
  if (entries.length === 0) {
    throw new Error(`Beta channel manifest has no platforms: ${manifestName}.`);
  }
  const sourceDescriptor = {
    repository: state.source.repository,
    release: { tag: state.source.tag },
  };
  for (const [platform, entry] of entries) {
    if (
      platform !== targetName &&
      platform !== `${targetName}-${architecture}` &&
      !platform.startsWith(`${targetName}-${architecture}-`)
    ) {
      throw new Error(
        `Beta channel manifest contains an unexpected platform ${platform}: ${manifestName}.`,
      );
    }
    artifactNameFromDescriptorReleaseUrl(sourceDescriptor, entry?.url);
    if (typeof entry?.signature !== "string" || entry.signature.length === 0) {
      throw new Error(
        `Beta channel manifest contains a missing updater signature: ${manifestName}.`,
      );
    }
  }
  return manifest;
}

function verifyBetaChannelOverlay({
  carrier,
  carrierDescriptor,
  carrierDescriptorSha256,
  channelAssetsByName,
  digestByName,
  directory,
  productIndexSha256,
}) {
  const permanentNames = permanentBetaChannelAssetNames(
    carrierDescriptor.expectedTargets,
  );
  const permanent = new Set(permanentNames);
  const presentPermanent = permanentNames.filter((name) =>
    channelAssetsByName.has(name),
  );
  const operational = Array.from(channelAssetsByName.keys()).filter(
    (name) => !permanent.has(name),
  );
  if (operational.length > 0) {
    throw new Error(
      `Beta channel has unfinished channel control assets: ${operational.sort().join(", ")}.`,
    );
  }
  if (presentPermanent.length === 0) return null;
  if (presentPermanent.length !== permanentNames.length) {
    throw new Error("Beta channel pointer set is incomplete.");
  }

  const statePath = path.join(directory, BETA_CHANNEL_STATE_NAME);
  const stateSignaturePath = path.join(
    directory,
    BETA_CHANNEL_STATE_SIGNATURE_NAME,
  );
  verifyDescriptorSignature(
    statePath,
    stateSignaturePath,
    carrierDescriptor.release.signingKeyFingerprint,
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assertCanonicalFile(statePath, state, "Beta channel state");
  validateBetaChannelState(state, {
    carrier,
    carrierDescriptorSha256,
    expectedTargets: carrierDescriptor.expectedTargets,
    productIndexSha256,
  });

  const records = strictRecordMap(
    state.assets,
    expectedBetaChannelAssetNames(carrierDescriptor.expectedTargets),
    "Beta channel state",
  );
  for (const [name, expectedSha256] of records) {
    const asset = channelAssetsByName.get(name);
    if (
      digestByName.get(name) !== expectedSha256 ||
      githubAssetSha256(asset) !== expectedSha256
    ) {
      throw new Error(`Beta channel digest mismatch for ${name}.`);
    }
    if (name.endsWith(".json")) {
      verifyDescriptorSignature(
        path.join(directory, name),
        path.join(directory, `${name}.asc`),
        carrierDescriptor.release.signingKeyFingerprint,
      );
      verifyManifestForState(path.join(directory, name), name, state);
    }
  }
  return state;
}

function extractBetaChannelSource({ descriptor, directory, assetsByName }) {
  if (descriptor?.release?.prerelease !== true) {
    throw new Error("Beta channel promotion source must be a prerelease.");
  }
  const expectedNames = expectedBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  const expected = new Set(expectedNames);
  const betaLikeNames = Array.from(assetsByName.keys()).filter((name) =>
    /^latest-.*-beta-.*\.json(?:\.asc)?$/.test(name),
  );
  const unexpected = betaLikeNames.filter((name) => !expected.has(name));
  const missing = expectedNames.filter((name) => !assetsByName.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Beta channel source set is not exact (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }

  const records = [];
  const filesByName = new Map();
  for (const name of expectedNames) {
    const filePath = path.join(directory, name);
    const sha256 = sha256File(filePath);
    const remoteSha256 = githubAssetSha256(assetsByName.get(name));
    if (!remoteSha256 || remoteSha256 !== sha256) {
      throw new Error(
        `Beta channel source GitHub digest mismatch for ${name}.`,
      );
    }
    records.push({ name, sha256 });
    filesByName.set(name, filePath);
  }
  for (const manifestName of expectedBetaManifestNames(
    descriptor.expectedTargets,
  )) {
    verifyDescriptorSignature(
      filesByName.get(manifestName),
      filesByName.get(`${manifestName}.asc`),
      descriptor.release.signingKeyFingerprint,
    );
    const state = {
      source: {
        expectedTargets: descriptor.expectedTargets,
        repository: descriptor.repository,
        tag: descriptor.release.tag,
        version: descriptor.release.version,
      },
    };
    verifyManifestForState(filesByName.get(manifestName), manifestName, state);
  }
  return { filesByName, records };
}

function sortedRecords(records) {
  return Array.from(records, ([name, sha256]) => ({ name, sha256 })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
}

function createBetaChannelTransaction({
  carrier,
  carrierDescriptorSha256,
  productIndexSha256,
  previousRecords,
  desiredRecords,
  owner,
  sourceDescriptorSha256,
  sourceCommit,
  sourceReleaseId,
  sourceTag,
  sourceVersion,
}) {
  const permanentNames = Array.from(desiredRecords.keys()).sort();
  const desired = strictRecordMap(
    sortedRecords(desiredRecords),
    permanentNames,
    "Desired beta channel transaction",
  );
  const previous = strictRecordMap(
    sortedRecords(previousRecords),
    permanentNames,
    "Previous beta channel transaction",
    { complete: previousRecords.size !== 0 },
  );
  if (previous.size !== 0 && previous.size !== desired.size) {
    throw new Error("Previous beta channel transaction set is incomplete.");
  }
  validatePublicationOwner(owner);
  if (
    owner.releaseId !== sourceReleaseId ||
    owner.descriptorSha256 !== sourceDescriptorSha256 ||
    owner.sourceCommit !== sourceCommit
  ) {
    throw new Error(
      "Beta channel transaction owner does not match its source.",
    );
  }
  const body = {
    schemaVersion: 2,
    operation: "promote-beta",
    owner,
    carrier: {
      descriptorSha256: carrierDescriptorSha256,
      id: carrier.id,
      productIndexSha256,
      tag: carrier.tag_name,
    },
    source: {
      descriptorSha256: sourceDescriptorSha256,
      id: sourceReleaseId,
      sourceCommit,
      tag: sourceTag,
      version: sourceVersion,
    },
    previous: sortedRecords(previous),
    desired: sortedRecords(desired),
  };
  return {
    ...body,
    transactionId: sha256Buffer(canonicalJson(body)),
  };
}

function validateBetaChannelTransaction(
  transaction,
  {
    carrier,
    carrierDescriptorSha256,
    expectedNames,
    expectedOwner = null,
    productIndexSha256,
  },
) {
  if (
    transaction?.schemaVersion !== 2 ||
    transaction.operation !== "promote-beta" ||
    transaction.carrier?.id !== carrier.id ||
    transaction.carrier?.tag !== carrier.tag_name ||
    transaction.carrier?.descriptorSha256 !== carrierDescriptorSha256 ||
    transaction.carrier?.productIndexSha256 !== productIndexSha256 ||
    !/^[a-f0-9]{64}$/.test(transaction.source?.descriptorSha256 || "") ||
    !Number.isSafeInteger(transaction.source?.id) ||
    !/^[a-f0-9]{40,64}$/.test(transaction.source?.sourceCommit || "") ||
    typeof transaction.source?.tag !== "string" ||
    typeof transaction.source?.version !== "string"
  ) {
    throw new Error("Beta channel transaction identity is malformed or stale.");
  }
  validatePublicationOwner(transaction.owner);
  if (
    transaction.owner.releaseId !== transaction.source.id ||
    transaction.owner.descriptorSha256 !==
      transaction.source.descriptorSha256 ||
    transaction.owner.sourceCommit !== transaction.source.sourceCommit
  ) {
    throw new Error("Beta channel transaction owner is stale.");
  }
  if (expectedOwner) {
    assertSamePublicationOwner(
      transaction.owner,
      expectedOwner,
      "Beta channel transaction",
    );
  }
  const desired = strictRecordMap(
    transaction.desired,
    expectedNames,
    "Desired beta channel transaction",
  );
  const previous = strictRecordMap(
    transaction.previous,
    expectedNames,
    "Previous beta channel transaction",
    { complete: transaction.previous.length !== 0 },
  );
  if (previous.size !== 0 && previous.size !== desired.size) {
    throw new Error("Previous beta channel transaction set is incomplete.");
  }
  const { transactionId, ...body } = transaction;
  if (transactionId !== sha256Buffer(canonicalJson(body))) {
    throw new Error("Beta channel transaction id is invalid.");
  }
  return { desired, previous };
}

function createBetaChannelRollover({
  carrier,
  carrierDescriptorSha256,
  carrierVersion,
  channelRecords,
  owner,
  productIndexSha256,
  successor,
  successorDescriptor,
  successorDescriptorSha256,
  successorProductIndexSha256,
}) {
  const expectedTargets = normalizedTargets(
    successorDescriptor.expectedTargets,
  );
  if (
    successor.id !== successorDescriptor.release.id ||
    successor.tag_name !== successorDescriptor.release.tag ||
    successorDescriptor.release.prerelease !== false
  ) {
    throw new Error("Stable rollover successor identity is malformed.");
  }
  const allowedNames = permanentBetaChannelAssetNames(expectedTargets);
  const records = strictRecordMap(
    sortedRecords(channelRecords),
    allowedNames,
    "Stable rollover channel snapshot",
    { complete: channelRecords.size !== 0 },
  );
  if (records.size !== 0 && records.size !== allowedNames.length) {
    throw new Error("Stable rollover channel snapshot is incomplete.");
  }
  validatePublicationOwner(owner);
  if (
    owner.releaseId !== successor.id ||
    owner.descriptorSha256 !== successorDescriptorSha256 ||
    owner.sourceCommit !== successorDescriptor.source.commit
  ) {
    throw new Error("Stable rollover owner does not match its successor.");
  }
  const body = {
    schemaVersion: 2,
    operation: "stable-rollover",
    owner,
    carrier: {
      descriptorSha256: carrierDescriptorSha256,
      id: carrier.id,
      productIndexSha256,
      tag: carrier.tag_name,
      version: carrierVersion,
    },
    successor: {
      descriptorSha256: successorDescriptorSha256,
      expectedTargets,
      id: successor.id,
      productIndexSha256: successorProductIndexSha256,
      sourceCommit: successorDescriptor.source.commit,
      tag: successor.tag_name,
      version: successorDescriptor.release.version,
    },
    channel: sortedRecords(records),
  };
  return {
    ...body,
    rolloverId: sha256Buffer(canonicalJson(body)),
  };
}

function validateBetaChannelRollover(
  rollover,
  {
    carrier,
    carrierDescriptorSha256,
    carrierVersion,
    expectedTargets,
    expectedOwner = null,
    productIndexSha256,
    successor = null,
    successorDescriptor = null,
    successorDescriptorSha256 = null,
    successorProductIndexSha256 = null,
  },
) {
  if (
    rollover?.schemaVersion !== 2 ||
    rollover.operation !== "stable-rollover" ||
    rollover.carrier?.id !== carrier.id ||
    rollover.carrier?.tag !== carrier.tag_name ||
    rollover.carrier?.descriptorSha256 !== carrierDescriptorSha256 ||
    rollover.carrier?.productIndexSha256 !== productIndexSha256 ||
    rollover.carrier?.version !== carrierVersion ||
    !Number.isSafeInteger(rollover.successor?.id) ||
    typeof rollover.successor?.tag !== "string" ||
    typeof rollover.successor?.version !== "string" ||
    typeof rollover.successor?.sourceCommit !== "string" ||
    !/^[a-f0-9]{64}$/.test(rollover.successor?.descriptorSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(rollover.successor?.productIndexSha256 || "")
  ) {
    throw new Error("Stable rollover identity is malformed or stale.");
  }
  validatePublicationOwner(rollover.owner);
  if (
    rollover.owner.releaseId !== rollover.successor.id ||
    rollover.owner.descriptorSha256 !== rollover.successor.descriptorSha256 ||
    rollover.owner.sourceCommit !== rollover.successor.sourceCommit
  ) {
    throw new Error("Stable rollover owner is stale.");
  }
  if (expectedOwner) {
    assertSamePublicationOwner(
      rollover.owner,
      expectedOwner,
      "Stable rollover lease",
    );
  }
  const targets = assertSameTargets(
    rollover.successor.expectedTargets,
    expectedTargets,
    "Stable rollover",
  );
  if (
    successor &&
    (rollover.successor.id !== successor.id ||
      rollover.successor.tag !== successor.tag_name)
  ) {
    throw new Error("Stable rollover successor release is stale.");
  }
  if (
    successorDescriptor &&
    (successorDescriptor.release.prerelease !== false ||
      rollover.successor.id !== successorDescriptor.release.id ||
      rollover.successor.tag !== successorDescriptor.release.tag ||
      rollover.successor.version !== successorDescriptor.release.version ||
      rollover.successor.sourceCommit !== successorDescriptor.source.commit ||
      rollover.successor.descriptorSha256 !== successorDescriptorSha256 ||
      rollover.successor.productIndexSha256 !== successorProductIndexSha256)
  ) {
    throw new Error("Stable rollover successor descriptor is stale.");
  }
  const allowedNames = permanentBetaChannelAssetNames(targets);
  const records = strictRecordMap(
    rollover.channel,
    allowedNames,
    "Stable rollover channel snapshot",
    { complete: rollover.channel.length !== 0 },
  );
  if (records.size !== 0 && records.size !== allowedNames.length) {
    throw new Error("Stable rollover channel snapshot is incomplete.");
  }
  const { rolloverId, ...body } = rollover;
  if (rolloverId !== sha256Buffer(canonicalJson(body))) {
    throw new Error("Stable rollover id is invalid.");
  }
  return records;
}

function strictRemoteAssetRecords(records, allowedNames, label) {
  if (!Array.isArray(records)) {
    throw new Error(`${label} has no remote asset records.`);
  }
  const allowed = new Set(allowedNames);
  const values = new Map();
  for (const record of records) {
    if (
      typeof record?.name !== "string" ||
      !allowed.has(record.name) ||
      !Number.isSafeInteger(record.id) ||
      !/^[a-f0-9]{64}$/.test(record.sha256 || "") ||
      values.has(record.name)
    ) {
      throw new Error(`${label} contains a malformed remote asset record.`);
    }
    values.set(record.name, record);
  }
  if (values.size !== allowed.size) {
    throw new Error(`${label} remote asset set is incomplete.`);
  }
  return values;
}

function createStableRolloverReceipt({
  carrier,
  carrierDescriptorSha256,
  carrierProductIndexSha256,
  leaseAssets,
  owner,
  rollover,
  successor,
  successorDescriptor,
  successorDescriptorSha256,
  successorProductIndexSha256,
}) {
  validatePublicationOwner(owner);
  if (
    owner.releaseId !== successor.id ||
    owner.descriptorSha256 !== successorDescriptorSha256 ||
    owner.sourceCommit !== successorDescriptor.source.commit
  ) {
    throw new Error("Stable rollover receipt owner does not match successor.");
  }
  assertSamePublicationOwner(
    rollover.owner,
    owner,
    "Stable rollover receipt lease",
  );
  const leaseRecords = [
    BETA_CHANNEL_ROLLOVER_NAME,
    BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  ]
    .map((name) => {
      const asset = leaseAssets.get(name);
      const sha256 = githubAssetSha256(asset);
      if (!Number.isSafeInteger(asset?.id) || !sha256) {
        throw new Error("Stable rollover receipt lease assets are incomplete.");
      }
      return { id: asset.id, name, sha256 };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const body = {
    schemaVersion: 1,
    operation: "stable-rollover-receipt",
    owner,
    predecessor: {
      descriptorSha256: carrierDescriptorSha256,
      id: carrier.id,
      productIndexSha256: carrierProductIndexSha256,
      rolloverId: rollover.rolloverId,
      tag: carrier.tag_name,
    },
    successor: {
      descriptorSha256: successorDescriptorSha256,
      id: successor.id,
      productIndexSha256: successorProductIndexSha256,
      sourceCommit: successorDescriptor.source.commit,
      tag: successor.tag_name,
    },
    leaseAssets: leaseRecords,
  };
  return {
    ...body,
    receiptId: sha256Buffer(canonicalJson(body)),
  };
}

function validateStableRolloverReceipt(
  receipt,
  {
    carrier = null,
    carrierDescriptorSha256 = null,
    carrierProductIndexSha256 = null,
    expectedOwner = null,
    rollover = null,
    successor,
    successorDescriptor,
    successorDescriptorSha256,
    successorProductIndexSha256,
  },
) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.operation !== "stable-rollover-receipt" ||
    !Number.isSafeInteger(receipt.predecessor?.id) ||
    typeof receipt.predecessor?.tag !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.predecessor?.descriptorSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(receipt.predecessor?.productIndexSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(receipt.predecessor?.rolloverId || "") ||
    receipt.successor?.id !== successor.id ||
    receipt.successor?.tag !== successor.tag_name ||
    receipt.successor?.id !== successorDescriptor.release.id ||
    receipt.successor?.tag !== successorDescriptor.release.tag ||
    receipt.successor?.sourceCommit !== successorDescriptor.source.commit ||
    receipt.successor?.descriptorSha256 !== successorDescriptorSha256 ||
    receipt.successor?.productIndexSha256 !== successorProductIndexSha256
  ) {
    throw new Error("Stable rollover receipt identity is malformed or stale.");
  }
  validatePublicationOwner(receipt.owner);
  if (
    receipt.owner.releaseId !== receipt.successor.id ||
    receipt.owner.descriptorSha256 !== receipt.successor.descriptorSha256 ||
    receipt.owner.sourceCommit !== receipt.successor.sourceCommit
  ) {
    throw new Error("Stable rollover receipt owner is stale.");
  }
  if (expectedOwner) {
    assertSamePublicationOwner(
      receipt.owner,
      expectedOwner,
      "Stable rollover receipt",
    );
  }
  if (
    carrier &&
    (receipt.predecessor.id !== carrier.id ||
      receipt.predecessor.tag !== carrier.tag_name ||
      receipt.predecessor.descriptorSha256 !== carrierDescriptorSha256 ||
      receipt.predecessor.productIndexSha256 !== carrierProductIndexSha256)
  ) {
    throw new Error("Stable rollover receipt predecessor is stale.");
  }
  if (rollover) {
    assertSamePublicationOwner(
      rollover.owner,
      receipt.owner,
      "Stable rollover receipt lease",
    );
    if (receipt.predecessor.rolloverId !== rollover.rolloverId) {
      throw new Error("Stable rollover receipt lease id is stale.");
    }
  }
  const leaseAssets = strictRemoteAssetRecords(
    receipt.leaseAssets,
    [BETA_CHANNEL_ROLLOVER_NAME, BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME],
    "Stable rollover receipt",
  );
  const { receiptId, ...body } = receipt;
  if (receiptId !== sha256Buffer(canonicalJson(body))) {
    throw new Error("Stable rollover receipt id is invalid.");
  }
  return leaseAssets;
}

function strictAssetMap(assets) {
  const values = new Map();
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset?.id) || typeof asset?.name !== "string") {
      throw new Error("Beta channel transaction received malformed assets.");
    }
    if (values.has(asset.name)) {
      throw new Error(
        `Beta channel transaction found duplicate ${asset.name}.`,
      );
    }
    values.set(asset.name, asset);
  }
  return values;
}

function assetHasDigest(asset, sha256) {
  return Boolean(asset) && githubAssetSha256(asset) === sha256;
}

function sameRemoteAsset(actual, expected) {
  const expectedSha256 = githubAssetSha256(expected);
  return (
    Boolean(actual) &&
    Boolean(expectedSha256) &&
    actual.id === expected.id &&
    actual.name === expected.name &&
    githubAssetSha256(actual) === expectedSha256
  );
}

async function deleteNames(
  names,
  { deleteAsset, expectedAssets = null, listAssets, releaseId },
) {
  for (const name of names) {
    const asset = strictAssetMap(await listAssets(releaseId)).get(name);
    if (!asset) continue;
    const expected = expectedAssets?.get(name);
    if (expectedAssets && (!expected || !sameRemoteAsset(asset, expected))) {
      throw new Error(
        `Refusing to delete changed channel control asset ${name}.`,
      );
    }
    await deleteAsset(asset.id);
  }
}

async function recoverIncompleteChannelControlPair({
  assertCarrier,
  deleteAsset,
  descriptor,
  expectedAsset,
  kind,
  listAssets,
  releaseId,
  verifyPermanent,
}) {
  const pairNames =
    kind === "transaction"
      ? [BETA_CHANNEL_TRANSACTION_NAME, BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME]
      : kind === "rollover"
        ? [BETA_CHANNEL_ROLLOVER_NAME, BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME]
        : null;
  if (
    !pairNames ||
    !pairNames.includes(expectedAsset?.name) ||
    !Number.isSafeInteger(expectedAsset?.id) ||
    !githubAssetSha256(expectedAsset)
  ) {
    throw new Error("Incomplete channel control asset identity is malformed.");
  }
  let assets = strictAssetMap(await listAssets(releaseId));
  const operationalNames = operationalBetaChannelAssetNames(
    descriptor.expectedTargets,
  ).filter((name) => assets.has(name));
  if (
    operationalNames.length !== 1 ||
    operationalNames[0] !== expectedAsset.name ||
    !sameRemoteAsset(assets.get(expectedAsset.name), expectedAsset)
  ) {
    throw new Error(
      "Incomplete channel control pair cannot be repaired after channel mutation.",
    );
  }
  await verifyPermanent();
  await assertCarrier(Array.from(assets.values()));
  await deleteAsset(expectedAsset.id);
  assets = strictAssetMap(await listAssets(releaseId));
  if (pairNames.some((name) => assets.has(name))) {
    throw new Error(
      "Incomplete channel control pair cleanup did not converge.",
    );
  }
  await verifyPermanent();
  await assertCarrier(Array.from(assets.values()));
  return "cleaned";
}

async function recoverBetaChannelTransaction({
  assertCarrier,
  deleteAsset,
  descriptor,
  expectedOwner,
  listAssets,
  releaseId,
  renameAsset,
  transaction,
  transactionAssets: ownedTransactionAssets = new Map(),
  verifyDesired,
  verifyPrevious,
}) {
  validatePublicationOwner(expectedOwner);
  const expectedNames = permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  const { desired, previous } = validateBetaChannelTransaction(transaction, {
    carrier: {
      id: transaction.carrier.id,
      tag_name: transaction.carrier.tag,
    },
    carrierDescriptorSha256: transaction.carrier.descriptorSha256,
    expectedNames,
    expectedOwner,
    productIndexSha256: transaction.carrier.productIndexSha256,
  });
  const transactionNames = [
    BETA_CHANNEL_TRANSACTION_NAME,
    BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
  ];
  const assertRecoveryCarrier = async (currentAssets = null) => {
    const listed = currentAssets ?? (await listAssets(releaseId));
    const current = strictAssetMap(listed);
    if (
      current.has(BETA_CHANNEL_ROLLOVER_NAME) ||
      current.has(BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME)
    ) {
      throw new Error(
        "Cannot recover beta promotion while a stable rollover lease exists.",
      );
    }
    const currentTransactionNames = transactionNames.filter((name) =>
      current.has(name),
    );
    if (currentTransactionNames.length !== ownedTransactionAssets.size) {
      throw new Error("Beta channel recovery ownership changed.");
    }
    for (const name of currentTransactionNames) {
      if (
        !sameRemoteAsset(current.get(name), ownedTransactionAssets.get(name))
      ) {
        throw new Error(`Beta channel recovery ownership changed for ${name}.`);
      }
    }
    await assertCarrier(listed);
    return current;
  };
  const mutateWhileOwned = async (operation) => {
    await assertRecoveryCarrier();
    await operation();
    await assertRecoveryCarrier();
  };

  let assets = await assertRecoveryCarrier();
  const transactionAssets = new Map(
    transactionNames
      .filter((name) => assets.has(name))
      .map((name) => [name, ownedTransactionAssets.get(name)]),
  );
  const desiredComplete = expectedNames.every((name) =>
    assetHasDigest(assets.get(name), desired.get(name)),
  );
  const operationalNames = expectedNames.flatMap((name) => [
    stageName(name),
    backupName(name),
  ]);
  if (desiredComplete) {
    await verifyDesired();
    for (const name of operationalNames) {
      const asset = strictAssetMap(await listAssets(releaseId)).get(name);
      if (asset) {
        await mutateWhileOwned(() => deleteAsset(asset.id));
      }
    }
    await assertRecoveryCarrier();
    await deleteNames(transactionNames, {
      deleteAsset,
      expectedAssets: transactionAssets,
      listAssets,
      releaseId,
    });
    ownedTransactionAssets.clear();
    await assertRecoveryCarrier();
    return "committed";
  }

  for (const name of [...expectedNames].reverse()) {
    assets = await assertRecoveryCarrier();
    const expectedPrevious = previous.get(name);
    const canonical = assets.get(name);
    const backup = assets.get(backupName(name));
    if (expectedPrevious) {
      if (assetHasDigest(canonical, expectedPrevious)) {
        if (backup) {
          await mutateWhileOwned(() => deleteAsset(backup.id));
        }
      } else if (assetHasDigest(backup, expectedPrevious)) {
        if (canonical) {
          await mutateWhileOwned(() => deleteAsset(canonical.id));
        }
        await mutateWhileOwned(() => renameAsset(backup.id, name));
      } else {
        throw new Error(
          `Cannot recover previous beta channel asset ${name}; its remote backup is missing or changed.`,
        );
      }
    } else {
      if (canonical) {
        await mutateWhileOwned(() => deleteAsset(canonical.id));
      }
      if (backup) {
        await mutateWhileOwned(() => deleteAsset(backup.id));
      }
    }
    const staged = strictAssetMap(await listAssets(releaseId)).get(
      stageName(name),
    );
    if (staged) {
      await mutateWhileOwned(() => deleteAsset(staged.id));
    }
  }
  await verifyPrevious();
  await assertRecoveryCarrier();
  await deleteNames(transactionNames, {
    deleteAsset,
    expectedAssets: transactionAssets,
    listAssets,
    releaseId,
  });
  ownedTransactionAssets.clear();
  await assertRecoveryCarrier();
  return "rolled-back";
}

function promotionOrder(expectedTargets) {
  const manifests = expectedBetaManifestNames(expectedTargets);
  return [
    ...manifests.flatMap((name) => [`${name}.asc`, name]),
    BETA_CHANNEL_STATE_SIGNATURE_NAME,
    BETA_CHANNEL_STATE_NAME,
  ];
}

async function uploadExact(filePath, { listAssets, releaseId, uploadAsset }) {
  const name = path.basename(filePath);
  let current = strictAssetMap(await listAssets(releaseId)).get(name);
  const expectedSha256 = sha256File(filePath);
  if (current) {
    if (!assetHasDigest(current, expectedSha256)) {
      throw new Error(`Beta channel staging collision for ${name}.`);
    }
    return current;
  }
  await uploadAsset(releaseId, filePath);
  current = strictAssetMap(await listAssets(releaseId)).get(name);
  if (!assetHasDigest(current, expectedSha256)) {
    throw new Error(`Beta channel upload verification failed for ${name}.`);
  }
  return current;
}

async function promoteBetaChannelAssets({
  assertCarrier,
  deleteAsset,
  descriptor,
  desiredFilesByName,
  listAssets,
  publicationOwner,
  releaseId,
  renameAsset,
  transaction,
  transactionFiles,
  uploadAsset,
  verifyDesired,
  verifyPrevious,
}) {
  validatePublicationOwner(publicationOwner);
  const expectedNames = permanentBetaChannelAssetNames(
    descriptor.expectedTargets,
  );
  if (
    desiredFilesByName.size !== expectedNames.length ||
    expectedNames.some((name) => !desiredFilesByName.has(name))
  ) {
    throw new Error("Desired beta channel promotion file set is incomplete.");
  }
  const transactionRecords = validateBetaChannelTransaction(transaction, {
    carrier: {
      id: transaction.carrier.id,
      tag_name: transaction.carrier.tag,
    },
    carrierDescriptorSha256: transaction.carrier.descriptorSha256,
    expectedNames,
    expectedOwner: publicationOwner,
    productIndexSha256: transaction.carrier.productIndexSha256,
  });
  for (const [name, expectedSha256] of transactionRecords.desired) {
    if (sha256File(desiredFilesByName.get(name)) !== expectedSha256) {
      throw new Error(`Desired beta channel file digest mismatch for ${name}.`);
    }
  }
  const transactionPathsByName = new Map();
  for (const filePath of transactionFiles || []) {
    const name = path.basename(filePath);
    if (transactionPathsByName.has(name)) {
      throw new Error("Beta channel transaction file set contains duplicates.");
    }
    transactionPathsByName.set(name, filePath);
  }
  const transactionInstallOrder = [
    BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    BETA_CHANNEL_TRANSACTION_NAME,
  ];
  if (
    transactionPathsByName.size !== transactionInstallOrder.length ||
    transactionInstallOrder.some((name) => !transactionPathsByName.has(name))
  ) {
    throw new Error("Beta channel transaction file set is not exact.");
  }

  const assertPromotionCarrier = async (currentAssets = null) => {
    const listed = currentAssets ?? (await listAssets(releaseId));
    const current = strictAssetMap(listed);
    if (
      current.has(BETA_CHANNEL_ROLLOVER_NAME) ||
      current.has(BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME)
    ) {
      throw new Error("Stable rollover lease blocks beta channel promotion.");
    }
    const currentTransactionAssets = [
      BETA_CHANNEL_TRANSACTION_NAME,
      BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
    ].filter((name) => current.has(name));
    if (currentTransactionAssets.length !== ownedTransactionAssets.size) {
      throw new Error("Beta channel transaction ownership changed.");
    }
    for (const name of currentTransactionAssets) {
      if (
        !sameRemoteAsset(current.get(name), ownedTransactionAssets.get(name))
      ) {
        throw new Error(
          `Beta channel transaction ownership changed for ${name}.`,
        );
      }
    }
    return assertCarrier(listed);
  };

  const initial = strictAssetMap(await listAssets(releaseId));
  if (
    expectedNames.every((name) =>
      assetHasDigest(initial.get(name), transactionRecords.desired.get(name)),
    )
  ) {
    await verifyDesired();
    return "unchanged";
  }
  const dirtyOperational = operationalBetaChannelAssetNames(
    descriptor.expectedTargets,
  ).filter((name) => initial.has(name));
  if (dirtyOperational.length > 0) {
    throw new Error(
      `Beta channel has unfinished channel control assets: ${dirtyOperational.sort().join(", ")}.`,
    );
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-beta-channel-"),
  );
  let transactionStarted = false;
  let recoveryEnabled = false;
  const ownedTransactionAssets = new Map();
  try {
    transactionStarted = true;
    for (const name of transactionInstallOrder) {
      const filePath = transactionPathsByName.get(name);
      try {
        const uploaded = await uploadExact(filePath, {
          listAssets,
          releaseId,
          uploadAsset,
        });
        ownedTransactionAssets.set(name, uploaded);
      } catch (error) {
        const current = strictAssetMap(await listAssets(releaseId)).get(name);
        if (assetHasDigest(current, sha256File(filePath))) {
          ownedTransactionAssets.set(name, current);
        }
        throw error;
      }
      await assertPromotionCarrier();
    }

    const lockedAssets = strictAssetMap(await listAssets(releaseId));
    await assertPromotionCarrier(Array.from(lockedAssets.values()));
    const desiredAlreadyInstalled = expectedNames.every((name) =>
      assetHasDigest(
        lockedAssets.get(name),
        transactionRecords.desired.get(name),
      ),
    );
    if (desiredAlreadyInstalled) {
      await verifyDesired();
      await deleteNames(transactionInstallOrder, {
        deleteAsset,
        expectedAssets: ownedTransactionAssets,
        listAssets,
        releaseId,
      });
      ownedTransactionAssets.clear();
      transactionStarted = false;
      await assertPromotionCarrier();
      return "unchanged";
    }
    const previousStillInstalled =
      transactionRecords.previous.size === 0
        ? expectedNames.every((name) => !lockedAssets.has(name))
        : expectedNames.every((name) =>
            assetHasDigest(
              lockedAssets.get(name),
              transactionRecords.previous.get(name),
            ),
          );
    if (!previousStillInstalled) {
      throw new Error(
        "Beta channel changed before the promotion journal acquired ownership.",
      );
    }
    recoveryEnabled = true;

    for (const name of expectedNames) {
      const stagedPath = path.join(temporaryDirectory, stageName(name));
      fs.copyFileSync(desiredFilesByName.get(name), stagedPath);
      await assertPromotionCarrier();
      await uploadExact(stagedPath, { listAssets, releaseId, uploadAsset });
      await assertPromotionCarrier();
    }

    for (const name of promotionOrder(descriptor.expectedTargets)) {
      let assets = strictAssetMap(await listAssets(releaseId));
      await assertPromotionCarrier(Array.from(assets.values()));
      const desiredSha256 = transactionRecords.desired.get(name);
      const canonical = assets.get(name);
      const staged = assets.get(stageName(name));
      if (assetHasDigest(canonical, desiredSha256)) {
        if (staged) {
          await assertPromotionCarrier();
          await deleteAsset(staged.id);
          await assertPromotionCarrier();
        }
        continue;
      }
      if (!assetHasDigest(staged, desiredSha256)) {
        throw new Error(`Staged beta channel asset is missing: ${name}.`);
      }
      if (assets.has(backupName(name))) {
        throw new Error(`Beta channel backup collision for ${name}.`);
      }
      if (canonical) {
        await assertPromotionCarrier();
        await renameAsset(canonical.id, backupName(name));
        await assertPromotionCarrier();
      }
      await assertPromotionCarrier();
      await renameAsset(staged.id, name);
      await assertPromotionCarrier();
      assets = strictAssetMap(await listAssets(releaseId));
      if (!assetHasDigest(assets.get(name), desiredSha256)) {
        throw new Error(`Beta channel swap verification failed for ${name}.`);
      }
    }

    await assertPromotionCarrier();
    await verifyDesired();
    for (const name of expectedNames.map(backupName)) {
      const backup = strictAssetMap(await listAssets(releaseId)).get(name);
      if (!backup) continue;
      await assertPromotionCarrier();
      await deleteAsset(backup.id);
      await assertPromotionCarrier();
    }
    await deleteNames(
      [BETA_CHANNEL_TRANSACTION_NAME, BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME],
      {
        deleteAsset,
        expectedAssets: ownedTransactionAssets,
        listAssets,
        releaseId,
      },
    );
    ownedTransactionAssets.clear();
    transactionStarted = false;
    recoveryEnabled = false;
    await assertPromotionCarrier();
    return "promoted";
  } catch (error) {
    if (transactionStarted && !recoveryEnabled) {
      try {
        await deleteNames(transactionInstallOrder, {
          deleteAsset,
          expectedAssets: ownedTransactionAssets,
          listAssets,
          releaseId,
        });
        ownedTransactionAssets.clear();
        await assertPromotionCarrier();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Beta channel journal acquisition failed and owned cleanup remains incomplete.",
        );
      }
      throw error;
    }
    if (recoveryEnabled) {
      try {
        const outcome = await recoverBetaChannelTransaction({
          assertCarrier: assertPromotionCarrier,
          deleteAsset,
          descriptor,
          expectedOwner: publicationOwner,
          listAssets,
          releaseId,
          renameAsset,
          transaction,
          transactionAssets: ownedTransactionAssets,
          verifyDesired,
          verifyPrevious,
        });
        if (outcome === "committed") return "promoted";
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Beta channel promotion failed and durable recovery remains incomplete.",
        );
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export {
  BACKUP_PREFIX,
  BETA_CHANNEL_ROLLOVER_NAME,
  BETA_CHANNEL_ROLLOVER_SIGNATURE_NAME,
  BETA_CHANNEL_STATE_NAME,
  BETA_CHANNEL_STATE_SIGNATURE_NAME,
  BETA_CHANNEL_TRANSACTION_NAME,
  BETA_CHANNEL_TRANSACTION_SIGNATURE_NAME,
  STABLE_ROLLOVER_RECEIPT_NAME,
  STABLE_ROLLOVER_RECEIPT_SIGNATURE_NAME,
  STAGE_PREFIX,
  backupName,
  createBetaChannelRollover,
  createBetaChannelState,
  createBetaChannelTransaction,
  createStableRolloverReceipt,
  expectedBetaChannelAssetNames,
  expectedBetaManifestNames,
  extractBetaChannelSource,
  isStableChannelAssetName,
  operationalBetaChannelAssetNames,
  permanentBetaChannelAssetNames,
  promoteBetaChannelAssets,
  recoverBetaChannelTransaction,
  recoverIncompleteChannelControlPair,
  splitStableReleaseAssets,
  stableChannelAssetNames,
  stageName,
  validateBetaChannelRollover,
  validateBetaChannelState,
  validateBetaChannelTransaction,
  validatePublicationOwner,
  validateStableRolloverReceipt,
  verifyBetaChannelOverlay,
};
