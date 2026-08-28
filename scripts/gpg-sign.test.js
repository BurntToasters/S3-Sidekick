import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLinuxX64PackageSet,
  normalizeUpdaterSignature,
  verifyUpdaterSignature,
} from "./gpg-sign.js";

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
      ]),
    ),
  );
});
