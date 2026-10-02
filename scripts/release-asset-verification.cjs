"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { downloadReleaseAsset } = require("./github-cli.cjs");
const { withoutGpgSecrets } = require("./release-integrity.cjs");

function gpg(args, environment) {
  const result = spawnSync(
    "gpg",
    ["--batch", "--no-options", "--no-auto-key-retrieve", ...args],
    {
      encoding: "utf8",
      env: withoutGpgSecrets(environment),
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `GPG verification failed: ${result.error?.message || String(result.stderr || "unknown error").trim()}`,
    );
  }
  return result.stdout;
}

function approvedFingerprint(environment) {
  const key = String(environment.GPG_KEY_ID || "").trim();
  if (!key)
    throw new Error(
      "GPG_KEY_ID is required to select the approved release signing key.",
    );
  const listing = gpg(
    ["--with-colons", "--fingerprint", "--list-keys", "--", key],
    environment,
  );
  const fingerprints = [];
  let primary = false;
  for (const line of listing.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === "pub") {
      if (/^[redi]/.test(fields[1]) || fields[11]?.includes("D")) {
        throw new Error(
          "Approved GPG signing key is revoked, expired, disabled, or invalid.",
        );
      }
      primary = true;
    } else if (fields[0] === "sub") {
      primary = false;
    } else if (fields[0] === "fpr" && primary) {
      fingerprints.push(fields[9]?.toUpperCase());
      primary = false;
    }
  }
  if (
    fingerprints.length !== 1 ||
    !/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(fingerprints[0] || "")
  ) {
    throw new Error(
      "GPG_KEY_ID must resolve to exactly one approved primary fingerprint.",
    );
  }
  return fingerprints[0];
}

function verifyGpgSignature(file, signature, fingerprint, environment) {
  const output = gpg(
    ["--status-fd", "1", "--verify", signature, file],
    environment,
  );
  const records = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice(9).split(/\s+/));
  const valid = records.filter((record) => record[0] === "VALIDSIG");
  const rejected = records.some((record) =>
    /^(?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY|FAILURE)$/.test(
      record[0],
    ),
  );
  // GnuPG doc/DETAILS defines VALIDSIG's optional tenth argument as the
  // primary fingerprint, allowing an approved key's signing subkey.
  if (
    rejected ||
    valid.length !== 1 ||
    (valid[0][10] || valid[0][1]).toUpperCase() !== fingerprint
  ) {
    throw new Error(
      `GPG signature for ${path.basename(file)} does not match the approved signing key fingerprint.`,
    );
  }
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyReleaseAssetIntegrity({
  assets,
  repository,
  requiredNames,
  environment = process.env,
}) {
  const fingerprint = approvedFingerprint(environment);
  const byName = new Map();
  for (const asset of assets) {
    if (byName.has(asset.name))
      throw new Error(`Duplicate release asset: ${asset.name}.`);
    byName.set(asset.name, asset);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "s3-sidekick-integrity-"));
  try {
    for (const name of requiredNames) {
      if (
        name !== path.posix.basename(name) ||
        name !== path.win32.basename(name) ||
        /[\\/:\r\n\0]/.test(name) ||
        name === "." ||
        name === ".."
      ) {
        throw new Error(`Unsafe required release asset name: ${name}.`);
      }
      const asset = byName.get(name);
      if (!asset) throw new Error(`Missing required release asset ${name}.`);
      const file = path.join(temp, name);
      downloadReleaseAsset(repository, asset.id, file);
      if (fs.statSync(file).size === 0)
        throw new Error(`Release asset ${name} is empty.`);
    }
    for (const signature of requiredNames.filter((name) =>
      name.endsWith(".asc"),
    )) {
      const name = signature.slice(0, -4);
      if (!requiredNames.includes(name))
        throw new Error(`GPG signature has no required payload: ${signature}.`);
      verifyGpgSignature(
        path.join(temp, name),
        path.join(temp, signature),
        fingerprint,
        environment,
      );
    }
    const covered = new Set();
    const hashes = new Map();
    for (const manifest of requiredNames.filter((name) =>
      /^SHA256SUMS-[a-z0-9_-]+\.txt$/i.test(name),
    )) {
      const seen = new Set();
      const lines = fs
        .readFileSync(path.join(temp, manifest), "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== "");
      if (lines.length === 0)
        throw new Error(`Checksum manifest ${manifest} is empty.`);
      for (const line of lines) {
        const match = line.match(/^([a-f0-9]{64}) {2}([^\r\n]+)$/i);
        if (!match) throw new Error(`Malformed checksum entry in ${manifest}.`);
        const [, expected, name] = match;
        if (
          name !== path.posix.basename(name) ||
          name !== path.win32.basename(name) ||
          /[\\/:\0]/.test(name) ||
          name === "." ||
          name === ".."
        ) {
          throw new Error(`Unsafe checksum filename in ${manifest}.`);
        }
        if (
          !requiredNames.includes(name) ||
          name.endsWith(".asc") ||
          /^SHA256SUMS-/i.test(name)
        ) {
          throw new Error(`Unknown checksum payload ${name} in ${manifest}.`);
        }
        if (seen.has(name))
          throw new Error(
            `Duplicate checksum entry for ${name} in ${manifest}.`,
          );
        seen.add(name);
        if (!hashes.has(name)) hashes.set(name, sha256(path.join(temp, name)));
        if (hashes.get(name) !== expected.toLowerCase())
          throw new Error(`Checksum mismatch for ${name} in ${manifest}.`);
        covered.add(name);
      }
    }
    for (const name of requiredNames.filter(
      (name) => !name.endsWith(".asc") && !/^SHA256SUMS-/i.test(name),
    )) {
      if (!covered.has(name))
        throw new Error(
          `Release payload ${name} is not covered by a signed checksum manifest.`,
        );
    }
    return { fingerprint, verifiedAssetCount: requiredNames.length };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { verifyReleaseAssetIntegrity };
