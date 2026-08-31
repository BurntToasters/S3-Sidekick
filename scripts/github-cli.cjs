"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { withoutGpgSecrets } = require("./release-integrity.cjs");

function githubCliEnvironment(environment = process.env) {
  const childEnvironment = withoutGpgSecrets(environment);
  delete childEnvironment.GH_TOKEN;
  delete childEnvironment.GITHUB_TOKEN;
  return childEnvironment;
}

function githubStatusCode(detail) {
  const match = String(detail || "").match(
    /\bHTTP\s+(\d{3})\b|\bstatus(?: code)?\s+(\d{3})\b/i,
  );
  return match ? Number(match[1] || match[2]) : undefined;
}

function githubApiArgs(method, endpoint, hasBody = false) {
  const args = ["api", "--method", method, endpoint];
  if (hasBody) args.push("--input", "-");
  return args;
}

function releaseUploadArgs(repository, tag, filePath) {
  return ["release", "upload", tag, "--repo", repository, filePath];
}

function releaseAssetUploadArgs(repository, releaseId, filePath) {
  const fileName = encodeURIComponent(path.basename(filePath));
  return [
    "api",
    "--method",
    "POST",
    "-H",
    "Content-Type: application/octet-stream",
    `/repos/${repository}/releases/${releaseId}/assets?name=${fileName}`,
    "--input",
    filePath,
  ];
}

function releaseAssetDownloadArgs(repository, assetId) {
  return [
    "api",
    "-H",
    "Accept: application/octet-stream",
    `/repos/${repository}/releases/assets/${assetId}`,
  ];
}

function runGitHub(args, { input, allowFailure = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: githubCliEnvironment(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "GitHub CLI is required. Install gh and run `gh auth login` on this release VM.",
      );
    }
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    const error = new Error(
      `gh ${args.join(" ")} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  return result;
}

function githubOutput(args, options) {
  return String(runGitHub(args, options).stdout || "").trim();
}

function githubJson(args, options) {
  const output = githubOutput(args, options);
  return output ? JSON.parse(output) : {};
}

function githubApi(method, endpoint, body) {
  return githubJson(githubApiArgs(method, endpoint, body !== undefined), {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assertGitHubCliAuthenticated() {
  runGitHub(["auth", "status", "--hostname", "github.com"]);
}

function uploadReleaseAsset(repository, tag, filePath) {
  runGitHub(releaseUploadArgs(repository, tag, filePath));
}

function uploadReleaseAssetById(repository, releaseId, filePath) {
  runGitHub(releaseAssetUploadArgs(repository, releaseId, filePath));
}

function downloadReleaseAsset(repository, assetId, filePath) {
  const args = releaseAssetDownloadArgs(repository, assetId);
  const result = spawnSync("gh", args, {
    env: githubCliEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    const error = new Error(
      `gh ${args.join(" ")} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
    error.statusCode = githubStatusCode(detail);
    throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, result.stdout, { mode: 0o600 });
  return filePath;
}

module.exports = {
  assertGitHubCliAuthenticated,
  downloadReleaseAsset,
  githubApi,
  githubApiArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseAssetDownloadArgs,
  releaseAssetUploadArgs,
  releaseUploadArgs,
  runGitHub,
  uploadReleaseAsset,
  uploadReleaseAssetById,
};
