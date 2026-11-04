import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./direct-execution.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cargoManifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
const outputPath = join(repoRoot, "public", "licenses-cargo.json");
const npmOutputPath = join(repoRoot, "public", "licenses.json");

function runCargoMetadata() {
  const args = [
    "metadata",
    "--manifest-path",
    cargoManifestPath,
    "--format-version",
    "1",
    "--locked",
  ];
  const result = spawnSync("cargo", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to run cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with exit code ${result.status}: ${(
        result.stderr || result.stdout
      ).trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

function computeReachablePackageIds(metadata) {
  const workspaceMembers = new Set(
    Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
  );
  const resolveNodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  const nodesById = new Map(resolveNodes.map((node) => [node.id, node]));

  const queue = [...workspaceMembers];
  const reachable = new Set(queue);

  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodesById.get(id);
    if (!node || !Array.isArray(node.deps)) continue;

    for (const dep of node.deps) {
      const depId = typeof dep?.pkg === "string" ? dep.pkg : null;
      if (!depId || reachable.has(depId)) continue;
      reachable.add(depId);
      queue.push(depId);
    }
  }

  return { reachable, workspaceMembers };
}

function toLicenseEntry(pkg) {
  const entry = {
    licenses:
      typeof pkg.license === "string" && pkg.license.trim()
        ? pkg.license.trim()
        : "UNKNOWN",
    repository:
      typeof pkg.repository === "string" && pkg.repository.trim()
        ? pkg.repository.trim()
        : null,
    packageManager: "cargo",
  };

  if (Array.isArray(pkg.authors) && pkg.authors.length > 0) {
    const joined = pkg.authors
      .filter((author) => typeof author === "string" && author.trim())
      .join(", ");
    if (joined) {
      entry.publisher = joined;
    }
  }

  if (typeof pkg.source === "string" && pkg.source.trim()) {
    entry.source = pkg.source.trim();
  }

  return entry;
}

function buildCargoLicenses(metadata) {
  const { reachable, workspaceMembers } = computeReachablePackageIds(metadata);
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];

  const entries = {};
  for (const pkg of packages) {
    if (!pkg || typeof pkg.id !== "string") continue;
    if (!reachable.has(pkg.id) || workspaceMembers.has(pkg.id)) continue;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
      continue;

    const key = `cargo:${pkg.name}@${pkg.version}`;
    entries[key] = toLicenseEntry(pkg);
  }

  return Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Strip build-host absolute paths from both license feeds.
 *
 * `license-checker` records `path` and `licenseFile` as absolute paths under
 * the build checkout. Those files are copied into the app bundle, so publishing
 * them leaks the builder's home directory. The UI only needs the license
 * identifier, repository, and optional license text.
 */
export function stripLicensePaths(licenses) {
  if (!licenses || typeof licenses !== "object" || Array.isArray(licenses)) {
    return licenses;
  }
  return Object.fromEntries(
    Object.entries(licenses).map(([key, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [key, entry];
      }
      const { path: _path, licenseFile: _licenseFile, ...rest } = entry;
      return [key, rest];
    }),
  );
}

function stripNpmLicensePaths() {
  if (!existsSync(npmOutputPath)) return 0;
  const raw = readFileSync(npmOutputPath, "utf8");
  const parsed = JSON.parse(raw);
  const sanitized = stripLicensePaths(parsed);
  const next = `${JSON.stringify(sanitized, null, 2)}\n`;
  if (next !== raw) writeFileSync(npmOutputPath, next, "utf8");
  return Object.keys(sanitized).length;
}

function main() {
  const metadata = runCargoMetadata();
  const licenses = stripLicensePaths(buildCargoLicenses(metadata));

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
  const npmEntries = stripNpmLicensePaths();
  console.log(
    `[licenses:cargo] Wrote ${Object.keys(licenses).length} cargo entries to ${outputPath}`,
  );
  if (npmEntries > 0) {
    console.log(
      `[licenses:cargo] Removed build-host paths from ${npmEntries} npm entries`,
    );
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
