"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  githubApiArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseAssetDeleteArgs,
  releaseAssetDownloadArgs,
  releaseAssetUploadArgs,
  releaseUploadArgs,
} = require("./github-cli.cjs");

test("GitHub CLI uses stored authentication and strips token environment variables", () => {
  assert.deepEqual(
    githubCliEnvironment({
      PATH: "/bin",
      GH_TOKEN: "old",
      GITHUB_TOKEN: "old-too",
      GPG_KEY_ID: "release-key",
      gpg_passphrase: "release-secret",
    }),
    { PATH: "/bin" },
  );
  assert.deepEqual(githubApiArgs("PATCH", "repos/o/r/releases/1", true), [
    "api",
    "--method",
    "PATCH",
    "repos/o/r/releases/1",
    "--input",
    "-",
  ]);
});

test("GitHub CLI errors expose only recognized HTTP status codes", () => {
  assert.equal(githubStatusCode("HTTP 404: Not Found"), 404);
  assert.equal(githubStatusCode("request failed with status 403"), 403);
  assert.equal(githubStatusCode("request failed with status code 500"), 500);
  assert.equal(githubStatusCode("network connection failed"), undefined);
});

test("normal release uploads never request clobber and can bind directly to a release id", () => {
  assert.deepEqual(releaseUploadArgs("o/r", "v1", "/tmp/app.zip"), [
    "release",
    "upload",
    "v1",
    "--repo",
    "o/r",
    "/tmp/app.zip",
  ]);
  assert.doesNotMatch(
    releaseUploadArgs("o/r", "v1", "/tmp/app.zip").join(" "),
    /clobber/,
  );
  assert.deepEqual(releaseAssetUploadArgs("o/r", 42, "/tmp/app build.zip"), [
    "api",
    "--method",
    "POST",
    "-H",
    "Content-Type: application/octet-stream",
    "/repos/o/r/releases/42/assets?name=app%20build.zip",
    "--input",
    "/tmp/app build.zip",
  ]);
  assert.deepEqual(releaseAssetDownloadArgs("o/r", 99), [
    "api",
    "-H",
    "Accept: application/octet-stream",
    "/repos/o/r/releases/assets/99",
  ]);
  assert.deepEqual(releaseAssetDeleteArgs("o/r", 99), [
    "api",
    "--method",
    "DELETE",
    "/repos/o/r/releases/assets/99",
  ]);
});
