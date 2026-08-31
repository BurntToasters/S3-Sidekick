#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  assertCleanSource,
  canonicalMacosArtifactName,
} = require("./release-integrity.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const targetRoot = path.join(root, "src-tauri", "target");
const releaseDir = path.join(root, "release");
const entitlements = path.join(root, "src-tauri", "entitlements.plist");

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${capture ? `: ${String(result.stderr || result.stdout || "").trim()}` : ""}`,
    );
  }
  return capture ? `${result.stdout || ""}${result.stderr || ""}` : "";
}

function walk(directory) {
  const values = [];
  if (!fs.existsSync(directory)) return values;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    values.push(fullPath);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      values.push(...walk(fullPath));
  }
  return values;
}

function findBundles(rootPath = targetRoot) {
  const values = walk(rootPath);
  return {
    apps: values.filter(
      (value) =>
        value.endsWith(".app") &&
        value.includes(`${path.sep}bundle${path.sep}macos${path.sep}`),
    ),
    dmgs: values.filter(
      (value) =>
        value.endsWith(".dmg") &&
        value.includes(`${path.sep}bundle${path.sep}dmg${path.sep}`),
    ),
  };
}

function requiredMacEnvironment(environment = process.env) {
  const required = [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_NOTARY_PROFILE",
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length > 0)
    throw new Error(
      `Missing mandatory macOS release variables: ${missing.join(", ")}`,
    );
  if (environment.APPLE_SIGNING_IDENTITY.trim() === "-") {
    throw new Error("Ad-hoc signing is forbidden for release artifacts.");
  }
  return {
    identity: environment.APPLE_SIGNING_IDENTITY.trim(),
    notaryProfile: environment.APPLE_NOTARY_PROFILE.trim(),
    teamId: environment.APPLE_TEAM_ID.trim(),
  };
}

function signingCandidates(appPath) {
  const nestedBundles = walk(appPath)
    .filter((value) => /\.(?:app|appex|framework|plugin|xpc)$/i.test(value))
    .sort(
      (left, right) =>
        right.split(path.sep).length - left.split(path.sep).length,
    );
  const machoFiles = walk(appPath)
    .filter((value) => fs.existsSync(value) && fs.statSync(value).isFile())
    .filter((value) => {
      const result = spawnSync("file", ["-b", value], { encoding: "utf8" });
      return result.status === 0 && /Mach-O/.test(result.stdout || "");
    })
    .sort(
      (left, right) =>
        right.split(path.sep).length - left.split(path.sep).length,
    );
  return Array.from(new Set([...machoFiles, ...nestedBundles]));
}

function signApp(appPath, identity) {
  for (const candidate of signingCandidates(appPath)) {
    run("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      candidate,
    ]);
  }
  run("codesign", [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    entitlements,
    "--sign",
    identity,
    appPath,
  ]);
}

function verifyCodeSignature(targetPath, identity, teamId) {
  run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    targetPath,
  ]);
  const details = run("codesign", ["-dv", "--verbose=4", targetPath], {
    capture: true,
  });
  if (!details.includes(`Authority=${identity}`)) {
    throw new Error(
      `Unexpected signing authority for ${targetPath}; expected ${identity}.`,
    );
  }
  if (!details.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error(
      `Unexpected signing team for ${targetPath}; expected ${teamId}.`,
    );
  }
}

function notarize(targetPath, profile) {
  const output = run(
    "xcrun",
    [
      "notarytool",
      "submit",
      targetPath,
      "--keychain-profile",
      profile,
      "--wait",
      "--output-format",
      "json",
    ],
    { capture: true },
  );
  let response;
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error(`notarytool returned invalid JSON for ${targetPath}.`);
  }
  if (response.status !== "Accepted" || !response.id) {
    throw new Error(
      `Apple notarization was not accepted for ${targetPath}: ${JSON.stringify(response)}`,
    );
  }
  return { id: response.id, status: response.status };
}

function zipApp(appPath, outputPath) {
  fs.rmSync(outputPath, { force: true });
  run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    outputPath,
  ]);
}

function createTarGzApp(appPath, outputPath) {
  fs.rmSync(outputPath, { force: true });
  run("tar", [
    "-czf",
    outputPath,
    "-C",
    path.dirname(appPath),
    path.basename(appPath),
  ]);
}

function createDmg(appPath, outputPath) {
  fs.rmSync(outputPath, { force: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  run("hdiutil", [
    "create",
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    "-srcfolder",
    appPath,
    "-volname",
    "S3 Sidekick",
    outputPath,
  ]);
}

function gatekeeperAssess(appPath, dmgPath) {
  run("xcrun", ["stapler", "validate", appPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);

  const quarantineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-gatekeeper-"),
  );
  const quarantinedApp = path.join(quarantineRoot, path.basename(appPath));
  try {
    fs.cpSync(appPath, quarantinedApp, {
      recursive: true,
      preserveTimestamps: true,
    });
    run("xattr", [
      "-w",
      "com.apple.quarantine",
      "0081;00000000;S3SidekickRelease;",
      quarantinedApp,
    ]);
    run("spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      quarantinedApp,
    ]);
  } finally {
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
}

function finalizeMacRelease(
  environment = process.env,
  { platform = process.platform, assertSource = assertCleanSource } = {},
) {
  if (platform !== "darwin")
    throw new Error("macOS release trust checks must run on macOS.");
  const sourceCommit = assertSource(root, { environment });
  try {
    const { identity, notaryProfile, teamId } =
      requiredMacEnvironment(environment);
    const { apps, dmgs } = findBundles();
    if (apps.length !== 1)
      throw new Error(
        `Expected exactly one universal .app bundle; found ${apps.length}.`,
      );
    if (dmgs.length > 1)
      throw new Error(
        `Expected at most one universal DMG path; found ${dmgs.length}.`,
      );

    const appPath = apps[0];
    const zipPath = path.join(
      path.dirname(appPath),
      `${path.basename(appPath, ".app")}.zip`,
    );
    const updaterArchivePath = path.join(
      path.dirname(appPath),
      `${path.basename(appPath)}.tar.gz`,
    );
    const dmgPath =
      dmgs[0] ||
      path.join(path.dirname(path.dirname(appPath)), "dmg", "S3 Sidekick.dmg");
    const temporaryZip = path.join(
      os.tmpdir(),
      `s3-sidekick-notary-${process.pid}.zip`,
    );

    signApp(appPath, identity);
    verifyCodeSignature(appPath, identity, teamId);
    zipApp(appPath, temporaryZip);
    const appNotarization = notarize(temporaryZip, notaryProfile);
    fs.rmSync(temporaryZip, { force: true });
    run("xcrun", ["stapler", "staple", appPath]);
    verifyCodeSignature(appPath, identity, teamId);

    zipApp(appPath, zipPath);
    createTarGzApp(appPath, updaterArchivePath);
    const zipNotarization = notarize(zipPath, notaryProfile);
    createDmg(appPath, dmgPath);
    run("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath]);
    verifyCodeSignature(dmgPath, identity, teamId);
    const dmgNotarization = notarize(dmgPath, notaryProfile);
    run("xcrun", ["stapler", "staple", dmgPath]);
    verifyCodeSignature(dmgPath, identity, teamId);
    gatekeeperAssess(appPath, dmgPath);

    fs.mkdirSync(releaseDir, { recursive: true });
    const reportPath = path.join(releaseDir, "macos-trust.json");
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          identity,
          teamId,
          notarization: {
            app: appNotarization,
            dmg: dmgNotarization,
            zip: zipNotarization,
          },
          artifacts: [zipPath, updaterArchivePath, dmgPath]
            .map((filePath) => {
              const name = canonicalMacosArtifactName(path.basename(filePath));
              if (!name) {
                throw new Error(
                  `Unsupported final macOS artifact name: ${path.basename(filePath)}.`,
                );
              }
              return { name, sha256: sha256File(filePath) };
            })
            .sort((left, right) => left.name.localeCompare(right.name)),
          checks: [
            "codesign-deep-strict",
            "notary-accepted",
            "stapler-validate",
            "gatekeeper",
            "quarantine-gatekeeper",
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(`[macos-release] Trust report: ${reportPath}`);
    return reportPath;
  } finally {
    assertSource(root, { environment, expectedCommit: sourceCommit });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    finalizeMacRelease();
  } catch (error) {
    console.error(
      `macos-release: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  finalizeMacRelease,
  findBundles,
  gatekeeperAssess,
  requiredMacEnvironment,
  signingCandidates,
  verifyCodeSignature,
};
