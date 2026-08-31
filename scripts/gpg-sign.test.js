import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLinuxX64PackageSet,
  normalizeUpdaterSignature,
  orderHostUploadFiles,
  runGpg,
  uploadImmutableDraftAsset,
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

test("direct GPG execution receives an explicit secret-bearing environment without a shell", () => {
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
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.env.GPG_KEY_ID, "release-key");
  assert.equal(calls[0].options.env.GPG_PASSPHRASE, "release-secret");
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
