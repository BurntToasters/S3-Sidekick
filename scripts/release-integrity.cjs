"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalMacosArtifactName(name) {
  const baseName = String(name || "");
  if (/\.app\.tar\.gz$/i.test(baseName)) return "S3-Sidekick-macOS.app.tar.gz";
  if (/\.dmg$/i.test(baseName)) return "S3-Sidekick-macOS.dmg";
  if (/^S3(?:[ ._-])Sidekick\.zip$/i.test(baseName)) {
    return "S3-Sidekick-macOS.zip";
  }
  return null;
}

function withoutGpgSecrets(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !["GPG_KEY_ID", "GPG_PASSPHRASE"].includes(name.toUpperCase()),
    ),
  );
}

function command(
  root,
  commandName,
  args,
  { binary = false, environment = process.env } = {},
) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: binary ? undefined : "utf8",
    env: withoutGpgSecrets(environment),
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = binary
      ? String(result.stderr || "")
      : String(result.stderr || result.stdout || "");
    throw new Error(
      `${commandName} ${args.join(" ")} failed: ${detail.trim()}`,
    );
  }
  return binary ? result.stdout : String(result.stdout || "").trim();
}

function sourceCommit(root, environment = process.env) {
  const commit = command(root, "git", ["rev-parse", "HEAD"], { environment });
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error(`Git HEAD did not resolve to a full commit id: ${commit}.`);
  }
  return commit.toLowerCase();
}

function assertCleanSource(
  root,
  { environment = process.env, expectedCommit } = {},
) {
  const before = sourceCommit(root, environment);
  if (
    expectedCommit !== undefined &&
    before !== String(expectedCommit).toLowerCase()
  ) {
    throw new Error(
      `Source checkout is at ${before}, not expected commit ${expectedCommit}.`,
    );
  }
  const status = command(
    root,
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { binary: true, environment },
  );
  if (!Buffer.isBuffer(status) || status.length > 0) {
    throw new Error("Release source working tree is not clean.");
  }
  const after = sourceCommit(root, environment);
  if (after !== before) {
    throw new Error(`Source commit changed while checking the working tree.`);
  }
  return after;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value)
      .replace(/^v/, "")
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error(`Invalid semantic version: ${value}`);
    return match;
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 1; index <= 3; index += 1) {
    const result = Number(a[index]) - Number(b[index]);
    if (result) return result;
  }
  if (!a[4] && !b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  return a[4].localeCompare(b[4]);
}

function assertReleaseToolVersions(
  packageJson,
  {
    environment = process.env,
    root = process.cwd(),
    nodeVersion = process.versions.node,
  } = {},
) {
  const expectedNode = String(packageJson.releaseToolchain?.node || "");
  const expectedNpm = String(packageJson.releaseToolchain?.npm || "");
  const nodeMatch = expectedNode.match(/^(?:>=\s*|\^)?(\d+\.\d+\.\d+)$/);
  if (!nodeMatch || !/^\d+\.\d+\.\d+$/.test(expectedNpm)) {
    throw new Error("releaseToolchain must pin Node.js and npm versions.");
  }
  const actualNpm =
    String(environment.npm_config_user_agent || "").match(
      /(?:^|\s)npm\/(\d+\.\d+\.\d+)(?:\s|$)/,
    )?.[1] || command(root, "npm", ["--version"], { environment });
  const nodeMeets =
    compareVersions(String(nodeVersion).replace(/^v/, ""), nodeMatch[1]) >= 0;
  if (packageJson.packageManager !== `npm@${expectedNpm}`) {
    throw new Error("packageManager and releaseToolchain.npm must match.");
  }
  if (!nodeMeets || actualNpm !== expectedNpm) {
    throw new Error(
      `Release tools do not match package.json pins (node ${nodeVersion}/${expectedNode}, npm ${actualNpm}/${expectedNpm}).`,
    );
  }
  return { node: expectedNode, npm: expectedNpm };
}

function signDetachedFile(
  filePath,
  signaturePath,
  { environment = process.env, epoch = Number.NaN, execute = spawnSync } = {},
) {
  const keyId = environment.GPG_KEY_ID;
  const passphrase = environment.GPG_PASSPHRASE;
  if (!String(keyId || "").trim() || !String(passphrase || "").trim()) {
    throw new Error("GPG_KEY_ID and GPG_PASSPHRASE are required for signing.");
  }
  if (/[\r\n]/.test(passphrase)) {
    throw new Error("GPG_PASSPHRASE must not contain line breaks.");
  }
  const args = [
    "--batch",
    "--yes",
    "--armor",
    "--pinentry-mode",
    "loopback",
    "--passphrase-fd",
    "0",
    "--detach-sign",
    "--local-user",
    keyId,
  ];
  if (Number.isSafeInteger(epoch))
    args.push("--faked-system-time", `${epoch}!`);
  args.push("--output", signaturePath, filePath);
  const result = execute("gpg", args, {
    encoding: "utf8",
    env: withoutGpgSecrets(environment),
    input: Buffer.from(`${passphrase}\n`, "utf8"),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG detached signing failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return signaturePath;
}

module.exports = {
  assertCleanSource,
  assertReleaseToolVersions,
  canonicalJson,
  canonicalMacosArtifactName,
  compareVersions,
  sha256File,
  signDetachedFile,
  sourceCommit,
  withoutGpgSecrets,
};
