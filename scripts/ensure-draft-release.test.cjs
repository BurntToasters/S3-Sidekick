"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SOURCE_COMMIT,
  assertExistingTagMatchesSource,
  descriptorAssets,
  isRetryableGithubError,
  readChangelogReleaseBody,
  releaseValidationOptions,
} = require("./ensure-draft-release.cjs");

test("draft coordinator recognizes descriptor pairs and exact release identity", () => {
  const descriptor = { id: 1, name: "release-descriptor.json" };
  const signature = { id: 2, name: "release-descriptor.json.asc" };
  assert.deepEqual(descriptorAssets([signature, descriptor]), {
    descriptor,
    signature,
  });
  assert.deepEqual(descriptorAssets([]), {
    descriptor: undefined,
    signature: undefined,
  });
  assert.match(releaseValidationOptions(42).expectedTag, /^v\d+\.\d+\.\d+/);
  assert.equal(releaseValidationOptions(42).expectedId, 42);
  assert.equal(
    releaseValidationOptions(42).expectedTargetCommitish,
    SOURCE_COMMIT,
  );
});

test("draft tag preflight allows only an absent tag reference", async () => {
  const missingReference = new Error("tag reference missing");
  missingReference.statusCode = 404;
  assert.equal(
    await assertExistingTagMatchesSource(async () => {
      throw missingReference;
    }),
    null,
  );

  let calls = 0;
  await assert.rejects(
    () =>
      assertExistingTagMatchesSource(async () => {
        calls += 1;
        if (calls === 1) {
          return { object: { type: "tag", sha: "a".repeat(40) } };
        }
        const missingObject = new Error("annotated tag object missing");
        missingObject.statusCode = 404;
        throw missingObject;
      }),
    /annotated tag object missing/i,
  );
  assert.equal(calls, 2);
});

test("release notes must exist and retries are limited to transient failures", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-notes-"),
  );
  try {
    const notes = path.join(directory, "CHANGELOG.md");
    fs.writeFileSync(notes, "release notes\n");
    assert.equal(readChangelogReleaseBody(notes), "release notes\n");
    fs.writeFileSync(notes, "  \n");
    assert.throws(() => readChangelogReleaseBody(notes), /empty/i);
    assert.equal(isRetryableGithubError({ statusCode: 503 }), true);
    assert.equal(isRetryableGithubError({ statusCode: 422 }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator source has no published fallback or normal clobber path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "ensure-draft-release.cjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /draft\s*\|\|\s*matching\[0\]/);
  assert.doesNotMatch(source, /--clobber/);
  assert.match(source, /validateMutableRelease/);
  assert.match(source, /target_commitish:\s*SOURCE_COMMIT/);
  assert.match(source, /assertExistingTagMatchesSource/);
  assert.match(source, /require\.main === module/);
});
