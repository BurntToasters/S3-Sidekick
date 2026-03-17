#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

const VERSION = pkg.version;
const TAG = `v${VERSION}`;

const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "S3-Sidekick";
const RELEASE_DOWNLOAD_BASE_URL = (
  process.env.RELEASE_DOWNLOAD_BASE_URL ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download`
).replace(/\/+$/, "");
const RELEASE_NOTES = process.env.RELEASE_NOTES || "";
const RELEASE_PUB_DATE = process.env.RELEASE_PUB_DATE || new Date().toISOString();

const ext = (e) => (n) => n.toLowerCase().endsWith(e);
const rx = (r) => (n) => r.test(n);
const isPerTargetManifest = rx(/^latest-[a-z0-9]+-[a-z0-9_]+\.json$/i);
const isChecksumTextName = rx(/^SHA256SUMS(?:-[a-z0-9_]+(?:-[a-z0-9_]+)?)?\.txt$/i);

const ARTIFACT_RULES = [
  rx(/-setup\.exe$/i),
  rx(/^S3-Sidekick-(?:Windows|Linux|macOS)-(?:x64|arm64)\.exe$/i),
  ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
  rx(/\.(?:exe|msi|dmg|deb|rpm|flatpak|appimage|zip)\.sig$/i),
  rx(/\.tar\.gz\.sig$/i),
  isPerTargetManifest,
];

const SIGN_RULES = [
  ext(".exe"), ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
];

const isArtifact = (name) => ARTIFACT_RULES.some((r) => r(name));
const isSignable = (name) => SIGN_RULES.some((r) => r(name));

const SEARCH_DIRS = [
  path.join(root, "src-tauri", "target"),
  path.join(root, "dist"),
];

function artifactMatchesVersion(name) {
  if (isPerTargetManifest(name)) return true;
  const versions = name.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g);
  if (!versions || versions.length === 0) return true;
  return versions.includes(VERSION);
}

function clearReleaseStaging() {
  if (!fs.existsSync(releaseDir)) return;
  for (const name of fs.readdirSync(releaseDir)) {
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    if (isArtifact(name) || name.endsWith(".asc") || isChecksumTextName(name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function pickNewestByBasename(paths) {
  const latest = new Map();
  for (const filePath of paths) {
    const name = path.basename(filePath);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const current = latest.get(name);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      latest.set(name, { filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return Array.from(latest.values()).map((entry) => entry.filePath);
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && isArtifact(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function cleanArtifactBaseName(name) {
  if (/\.tar\.gz$/i.test(name)) return name;
  if (/\.nsis\.zip$/i.test(name)) return name;

  if (/\.dmg$/i.test(name)) return "S3-Sidekick-macOS.dmg";
  if (/^S3\.Sidekick\.zip$/i.test(name)) return "S3-Sidekick-macOS.zip";

  if (/x64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-x64.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "S3-Sidekick-Windows-arm64.exe";

  if (/amd64\.AppImage$/i.test(name)) return "S3-Sidekick-Linux-x64.AppImage";
  if (/aarch64\.AppImage$/i.test(name)) return "S3-Sidekick-Linux-arm64.AppImage";

  if (/amd64\.deb$/i.test(name)) return "S3-Sidekick-Linux-x64.deb";
  if (/aarch64\.deb$/i.test(name)) return "S3-Sidekick-Linux-arm64.deb";

  if (/x86_64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-x64.rpm";
  if (/aarch64\.rpm$/i.test(name)) return "S3-Sidekick-Linux-arm64.rpm";

  return name;
}

function cleanArtifactName(name) {
  if (name.endsWith(".sig")) {
    const base = name.slice(0, -4);
    return `${cleanArtifactBaseName(base)}.sig`;
  }
  return cleanArtifactBaseName(name);
}

function shouldUploadReleaseEntry(name) {
  return isArtifact(name) || name.endsWith(".asc") || isChecksumTextName(name);
}

const FALLBACK_INSTALLER_PRIORITY = {
  windows: { nsis: 3, msi: 2 },
  linux: { appimage: 3, deb: 2, rpm: 1 },
  darwin: { app: 3 },
};

function inferArchFromName(name) {
  if (/(?:^|[-_.])(aarch64|arm64)(?:[-_.]|$)/i.test(name)) return "aarch64";
  if (/(?:^|[-_.])(x86_64|amd64|x64)(?:[-_.]|$)/i.test(name)) return "x86_64";
  if (/(?:^|[-_.])(i686|x86)(?:[-_.]|$)/i.test(name)) return "i686";
  return null;
}

function resolveUpdaterTargets(name) {
  const targets = [];
  if (/\.app\.tar\.gz$/i.test(name)) {
    const arch = inferArchFromName(name);
    const arches = arch ? [arch] : ["x86_64", "aarch64"];
    for (const a of arches) {
      targets.push({ os: "darwin", arch: a, installer: "app" });
    }
    return targets;
  }

  if (/\.exe$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "nsis" });
    return targets;
  }

  if (/\.msi$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "msi" });
    return targets;
  }

  if (/\.appimage$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "appimage" });
    return targets;
  }

  if (/\.deb$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "deb" });
    return targets;
  }

  if (/\.rpm$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "rpm" });
    return targets;
  }

  return targets;
}

function releaseAssetUrl(fileName) {
  return `${RELEASE_DOWNLOAD_BASE_URL}/${encodeURIComponent(fileName)}`;
}

function normalizeUpdaterSignature(sigPath) {
  const trimmed = fs.readFileSync(sigPath, "utf8").trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("untrusted comment:")) {
      return trimmed;
    }
  } catch {
  }

  if (trimmed.includes("untrusted comment:")) {
    return Buffer.from(trimmed, "utf8").toString("base64");
  }

  return trimmed;
}

function generateUpdaterManifests(files) {
  const byName = new Map();
  for (const filePath of files) {
    byName.set(path.basename(filePath), filePath);
  }

  const signatureByBaseName = new Map();
  for (const [name, filePath] of byName) {
    if (name.endsWith(".sig")) {
      signatureByBaseName.set(name.slice(0, -4), filePath);
    }
  }

  const manifests = new Map();
  const requiredTargetKeys = new Set();
  const missingSignatures = [];
  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    if (targets.length === 0) continue;
    for (const target of targets) {
      requiredTargetKeys.add(`${target.os}-${target.arch}`);
    }

    const sigPath = signatureByBaseName.get(name);
    if (!sigPath) {
      missingSignatures.push(`${name}.sig`);
      continue;
    }

    const signature = normalizeUpdaterSignature(sigPath);
    const url = releaseAssetUrl(name);
    for (const target of targets) {
      const manifestName = `latest-${target.os}-${target.arch}.json`;
      if (!manifests.has(manifestName)) {
        manifests.set(manifestName, {
          version: VERSION,
          notes: RELEASE_NOTES,
          pub_date: RELEASE_PUB_DATE,
          platforms: {},
          fallbackPriority: -1,
        });
      }

      const manifest = manifests.get(manifestName);
      const installerKey = `${target.os}-${target.arch}-${target.installer}`;
      const fallbackKey = `${target.os}-${target.arch}`;
      manifest.platforms[installerKey] = { url, signature };

      const priority = FALLBACK_INSTALLER_PRIORITY[target.os]?.[target.installer] ?? 0;
      if (!manifest.platforms[fallbackKey] || priority > manifest.fallbackPriority) {
        manifest.platforms[fallbackKey] = { url, signature };
        manifest.fallbackPriority = priority;
      }
    }
  }

  if (missingSignatures.length > 0) {
    const sorted = Array.from(new Set(missingSignatures)).sort((a, b) =>
      a.localeCompare(b),
    );
    throw new Error(
      `Missing updater signature file(s): ${sorted.join(", ")}. ` +
        "Every updater-target artifact must include a matching .sig file.",
    );
  }

  const generated = [];
  const generatedTargetKeys = new Set();
  for (const manifestName of Array.from(manifests.keys()).sort()) {
    const manifest = manifests.get(manifestName);
    const output = {
      version: manifest.version,
      pub_date: manifest.pub_date,
      platforms: manifest.platforms,
    };
    if (manifest.notes) {
      output.notes = manifest.notes;
    }
    const dest = path.join(releaseDir, manifestName);
    fs.writeFileSync(dest, JSON.stringify(output, null, 2) + "\n");
    console.log(`  + ${manifestName} (${Object.keys(output.platforms).length} platform entries)`);
    generated.push(dest);
    const targetKey = parseManifestTargetKey(manifestName);
    if (targetKey) {
      generatedTargetKeys.add(targetKey);
    }
  }

  const missingTargets = Array.from(requiredTargetKeys)
    .filter((targetKey) => !generatedTargetKeys.has(targetKey))
    .sort((a, b) => a.localeCompare(b));
  if (missingTargets.length > 0) {
    throw new Error(
      `Updater manifest generation is incomplete for target(s): ${missingTargets.join(", ")}.`,
    );
  }

  return generated;
}

function parseManifestTargetKey(name) {
  const m = name.match(/^latest-([a-z0-9]+)-([a-z0-9_]+)\.json$/i);
  if (!m) return null;
  return `${m[1].toLowerCase()}-${m[2].toLowerCase()}`;
}

function targetKeysForArtifactName(name) {
  const manifestKey = parseManifestTargetKey(name);
  if (manifestKey) return [manifestKey];

  const baseName = name.endsWith(".sig") ? name.slice(0, -4) : name;
  return Array.from(
    new Set(resolveUpdaterTargets(baseName).map((t) => `${t.os}-${t.arch}`))
  );
}

function collectArtifacts() {
  fs.mkdirSync(releaseDir, { recursive: true });

  const discovered = SEARCH_DIRS.flatMap((d) => walk(d));
  const found = discovered.filter((filePath) => artifactMatchesVersion(path.basename(filePath)));
  if (found.length > 0) {
    clearReleaseStaging();
    if (found.length < discovered.length) {
      console.log(`  ~ Skipped ${discovered.length - found.length} artifact(s) not matching ${VERSION}`);
    }

    const selected = pickNewestByBasename(found);
    const collected = [];
    for (const src of selected) {
      const originalName = path.basename(src);
      const cleanName = cleanArtifactName(originalName);
      const dest = path.join(releaseDir, cleanName);
      fs.copyFileSync(src, dest);
      if (cleanName !== originalName) {
        console.log(`  + ${originalName} → ${cleanName}`);
      } else {
        console.log(`  + ${originalName}`);
      }
      collected.push(dest);
    }
    const manifests = generateUpdaterManifests(collected);
    return [...collected, ...manifests];
  }

  const staged = fs.readdirSync(releaseDir)
    .filter((n) => isArtifact(n) && artifactMatchesVersion(n) && !n.endsWith(".asc") && !isChecksumTextName(n))
    .map((n) => path.join(releaseDir, n));

  if (staged.length === 0) {
    console.error("No build artifacts found in:", [...SEARCH_DIRS, releaseDir].join(", "));
    process.exit(1);
  }

  console.log(`  Found ${staged.length} pre-staged artifact(s) in release/`);
  const manifests = generateUpdaterManifests(staged);
  return Array.from(new Set([...staged, ...manifests]));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function generateChecksums(files) {
  const candidates = files.filter((f) => {
    const name = path.basename(f);
    return !name.endsWith(".asc") && !isChecksumTextName(name);
  });

  const manifestTargetKeys = Array.from(
    new Set(candidates.map((f) => parseManifestTargetKey(path.basename(f))).filter(Boolean))
  );

  const buckets = new Map();
  const addToBucket = (targetKey, filePath) => {
    if (!buckets.has(targetKey)) {
      buckets.set(targetKey, []);
    }
    buckets.get(targetKey).push(filePath);
  };

  for (const filePath of candidates) {
    const name = path.basename(filePath);
    let targetKeys = targetKeysForArtifactName(name);
    if (targetKeys.length === 0 && manifestTargetKeys.length > 0) {
      targetKeys = manifestTargetKeys;
    }
    if (targetKeys.length === 0) {
      targetKeys = ["generic"];
    }
    for (const targetKey of targetKeys) {
      addToBucket(targetKey, filePath);
    }
  }

  const outputs = [];
  for (const targetKey of Array.from(buckets.keys()).sort()) {
    const uniqueFiles = Array.from(new Set(buckets.get(targetKey)));
    const entries = uniqueFiles
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
      .map((f) => `${sha256(f)}  ${path.basename(f)}`);
    const fileName = `SHA256SUMS-${targetKey}.txt`;
    const out = path.join(releaseDir, fileName);
    fs.writeFileSync(out, entries.join("\n") + "\n");
    console.log(`  + ${fileName} (${entries.length} entries)`);
    outputs.push(out);
  }
  return outputs;
}

function signFile(filePath) {
  const asc = `${filePath}.asc`;
  const args = ["--batch", "--yes", "--armor", "--detach-sign"];
  if (GPG_KEY_ID) {
    args.push("--local-user", GPG_KEY_ID);
  }
  if (GPG_PASSPHRASE) {
    args.push("--pinentry-mode", "loopback", "--passphrase", GPG_PASSPHRASE);
  }
  args.push("--output", asc, filePath);

  const result = spawnSync("gpg", args, { stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GPG signing failed: ${result.stderr?.toString() || "unknown error"}`);
  }
  return asc;
}

function signArtifacts(files) {
  const ascFiles = [];
  for (const f of files) {
    if (isSignable(path.basename(f))) {
      ascFiles.push(signFile(f));
      console.log(`  + ${path.basename(f)}.asc`);
    }
  }
  return ascFiles;
}

function ghRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: endpoint,
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "User-Agent": "S3Sidekick-Release",
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (body) opts.headers["Content-Type"] = "application/json";

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`GitHub ${res.statusCode}: ${json.message || data}`));
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getOrCreateRelease() {
  try {
    return await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`);
  } catch {
  }

  try {
    const releases = await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`);
    const draft = releases.find((r) => r.draft && r.tag_name === TAG);
    if (draft) return draft;
  } catch {
  }

  return await ghRequest("POST", `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, {
    tag_name: TAG,
    name: `S3 Sidekick ${VERSION}`,
    draft: true,
    prerelease: VERSION.includes("beta") || VERSION.includes("alpha"),
  });
}

async function uploadAsset(uploadUrl, filePath) {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath);
  const url = new URL(uploadUrl.replace("{?name,label}", ""));
  url.searchParams.set("name", fileName);

  const isText = /\.(asc|txt|json)$/i.test(fileName);

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          "User-Agent": "S3Sidekick-Release",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": isText ? "text/plain" : "application/octet-stream",
          "Content-Length": content.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 300) {
            resolve(true);
          } else if (res.statusCode === 422) {
            let detail = data;
            try {
              const parsed = JSON.parse(data);
              if (parsed && typeof parsed.message === "string") {
                detail = parsed.message;
              }
            } catch {
            }
            reject(
              new Error(
                `Upload ${fileName} was rejected (422): ${detail}. Remove the conflicting release asset and retry.`,
              ),
            );
          } else {
            reject(new Error(`Upload ${fileName} failed ${res.statusCode}: ${data}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(content);
    req.end();
  });
}

async function main() {
  console.log(`\nS3 Sidekick ${VERSION} — release pipeline\n`);

  console.log("[1/5] Checking GPG...");
  try {
    execSync("gpg --version", { stdio: "pipe" });
  } catch {
    console.error("gpg not found. Install GnuPG and try again.");
    process.exit(1);
  }

  console.log("[2/5] Collecting artifacts...");
  const artifacts = collectArtifacts();

  console.log("[3/5] Generating checksums...");
  const checksumFiles = generateChecksums(artifacts);

  console.log("[4/5] Signing...");
  const ascFiles = signArtifacts(artifacts);
  for (const checksumFile of checksumFiles) {
    ascFiles.push(signFile(checksumFile));
    console.log(`  + ${path.basename(checksumFile)}.asc`);
  }

  if (!GH_TOKEN) {
    console.log("\n[5/5] GH_TOKEN not set — skipping GitHub upload.");
    console.log(`Artifacts staged in: ${releaseDir}\n`);
    return;
  }

  console.log("[5/5] Uploading to GitHub...");
  const release = await getOrCreateRelease();
  console.log(`  Release: ${release.html_url || TAG}`);

  const everything = fs
    .readdirSync(releaseDir)
    .filter((name) => shouldUploadReleaseEntry(name))
    .map((n) => path.join(releaseDir, n));
  for (const f of everything) {
    await uploadAsset(release.upload_url, f);
    console.log(`  ^ ${path.basename(f)}`);
  }

  console.log(`\nDone — ${TAG} uploaded as ${release.draft ? "draft" : "published"}.\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
