import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { isDirectExecution } from "./direct-execution.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const RELEASE_SESSION_RELATIVE_PATH = path.join(
  "release",
  ".build-session.json",
);
const QUALITY_GATE_RELATIVE_PATH = path.join(
  "coverage",
  ".release-quality.json",
);
const QUALITY_GATE_EVIDENCE_RELATIVE_PATH = path.join(
  "coverage",
  ".release-tests.json",
);
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_CLOCK_SKEW_MS = 120_000;
const REQUIRED_QUALITY_CHECK_NAMES = Object.freeze([
  "typecheck",
  "lint",
  "format",
  "cargoSafeUpdate",
  "cargoUpdatePolicy",
  "tauriAlignment",
  "icons",
  "clippy",
  "cargoFmt",
  "frontendBuild",
  "nativeBuild",
  "tauriBuild",
  "scriptTests",
  "releaseAssets",
  "test",
  "rust",
]);
const QUALITY_GATE_REPORT_SPECS = Object.freeze([
  Object.freeze({
    path: "coverage/coverage-summary.json",
    kind: "vitest-coverage",
  }),
]);

function command(commandName, args, root) {
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Porcelain status; preserve leading XY spaces (do not trim). */
function gitPorcelainStatus(root = defaultRoot) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).replace(/(?:\r?\n)+$/, "");
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function gitFileList(root, args) {
  return execFileSync("git", ["ls-files", ...args, "-z"], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function sha256WorkingTree(root) {
  const files = [
    ...gitFileList(root, []),
    ...gitFileList(root, ["--others", "--exclude-standard"]),
  ].sort();
  const digest = crypto.createHash("sha256");
  for (const filePath of files) {
    const normalizedPath = filePath.replace(/\\/g, "/");
    digest.update(normalizedPath);
    digest.update("\0");
    try {
      const stat = fs.lstatSync(path.join(root, filePath));
      if (stat.isSymbolicLink()) {
        digest.update("symlink\0");
        digest.update(fs.readlinkSync(path.join(root, filePath)));
      } else {
        digest.update("file\0");
        digest.update(fs.readFileSync(path.join(root, filePath)));
      }
    } catch {
      digest.update("missing\0");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

function currentReleaseIdentity(root = defaultRoot) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return {
    version: String(packageJson.version ?? ""),
    commit: command("git", ["rev-parse", "HEAD"], root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rustc: command("rustc", ["--version"], root),
    packageLockSha256: sha256File(path.join(root, "package-lock.json")),
    cargoLockSha256: sha256File(path.join(root, "src-tauri", "Cargo.lock")),
    sourceTreeSha256: sha256WorkingTree(root),
  };
}

function validateIdentity(record, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new Error(
        `${label} ${key} does not match this checkout/environment.`,
      );
    }
  }
}

function validateReleaseSession(
  session,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!session || typeof session !== "object") {
    throw new Error("Release build session is not an object.");
  }
  if (!Number.isFinite(session.startedAt)) {
    throw new Error("Release build session has no valid start time.");
  }
  const age = now - session.startedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release build session is expired; run release:prepare again.",
    );
  }

  validateIdentity(session, expected, "Release build session");
  if (
    !Number.isFinite(session.qualityGateCompletedAt) ||
    session.qualityGateCompletedAt >= session.startedAt
  ) {
    throw new Error("Release build session has no valid quality-gate proof.");
  }
  return session;
}

function validateQualityGate(
  qualityGate,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!qualityGate || typeof qualityGate !== "object") {
    throw new Error("Release quality-gate proof is not an object.");
  }
  if (!Number.isFinite(qualityGate.completedAt)) {
    throw new Error("Release quality-gate proof has no valid completion time.");
  }
  const age = now - qualityGate.completedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release quality-gate proof is expired; run test:all again.",
    );
  }
  validateIdentity(qualityGate, expected, "Release quality-gate proof");
  if (!Number.isFinite(qualityGate.evidenceCompletedAt)) {
    throw new Error(
      "Release quality-gate proof has no valid test-evidence completion time.",
    );
  }
  if (
    !Array.isArray(qualityGate.evidence) ||
    qualityGate.evidence.length !== QUALITY_GATE_REPORT_SPECS.length + 1
  ) {
    throw new Error(
      "Release quality-gate proof has no complete report evidence list.",
    );
  }
  const evidencePaths = new Set();
  for (const entry of qualityGate.evidence) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !/^[0-9a-f]{64}$/i.test(String(entry.sha256 || ""))
    ) {
      throw new Error("Release quality-gate proof has malformed evidence.");
    }
    if (evidencePaths.has(entry.path)) {
      throw new Error(
        `Release quality-gate proof repeats evidence ${entry.path}.`,
      );
    }
    evidencePaths.add(entry.path);
  }
  for (const expectedPath of [
    QUALITY_GATE_EVIDENCE_RELATIVE_PATH.replace(/\\/g, "/"),
    ...QUALITY_GATE_REPORT_SPECS.map((spec) => spec.path),
  ]) {
    if (!evidencePaths.has(expectedPath)) {
      throw new Error(
        `Release quality-gate proof is missing evidence ${expectedPath}.`,
      );
    }
  }
  return qualityGate;
}

// Only generated bootstrap metadata may differ from HEAD. Source manifests,
// lockfiles, and Tauri config must remain exactly the committed release source.
const RELEASE_BOOTSTRAP_PATHS = new Set(["run.rosie.s3-sidekick.metainfo.xml"]);
const RELEASE_BOOTSTRAP_PREFIXES = ["src-tauri/gen/schemas/"];

function normalizePorcelainPath(value) {
  let normalized = String(value).replace(/\\/g, "/");
  if (
    normalized.startsWith('"') &&
    normalized.endsWith('"') &&
    normalized.length >= 2
  ) {
    normalized = normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  return normalized;
}

function parsePorcelainPaths(status) {
  return status
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => {
      // XY (2 chars) + space + path. Leading space in XY must be preserved;
      // callers must not trim() the porcelain blob before parsing.
      const match = line.match(/^(.{2}) (.*)$/);
      if (!match) return "";
      const rest = match[2];
      const renameArrow = rest.indexOf(" -> ");
      return normalizePorcelainPath(
        renameArrow >= 0 ? rest.slice(renameArrow + 4) : rest,
      );
    })
    .filter(Boolean);
}

function isAllowedBootstrapPath(filePath) {
  if (RELEASE_BOOTSTRAP_PATHS.has(filePath)) return true;
  return RELEASE_BOOTSTRAP_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

/** Clean tree, or only files that workspace:bootstrap / cargo check may touch before proof. */
function isAcceptableReleaseWorkingTree(status) {
  if (!status.trim()) return true;
  const paths = parsePorcelainPaths(status);
  if (paths.length === 0) return false;
  return paths.every((filePath) => isAllowedBootstrapPath(filePath));
}

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function blockingReleaseWorkingTreePaths(root = defaultRoot) {
  let status;
  try {
    status = gitPorcelainStatus(root);
  } catch {
    return ["<git status failed>"];
  }
  if (isAcceptableReleaseWorkingTree(status)) {
    return [];
  }
  return parsePorcelainPaths(status).filter(
    (filePath) => !isAllowedBootstrapPath(filePath),
  );
}

function resolveRootRelative(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function clearQualityGateEvidence(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_EVIDENCE_RELATIVE_PATH), {
    force: true,
  });
}

function writeQualityGateEvidence(
  root,
  { commit, startedAt, completedAt, checks, passed },
) {
  const evidencePath = path.join(root, QUALITY_GATE_EVIDENCE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        suite: "release-quality-evidence",
        commit,
        startedAt,
        completedAt,
        passed,
        checks,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return evidencePath;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function qualityGateEvidenceProblems(
  root = defaultRoot,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, commit } = {},
) {
  const problems = [];
  const evidencePath = path.join(root, QUALITY_GATE_EVIDENCE_RELATIVE_PATH);
  let evidence;
  try {
    evidence = readJsonFile(evidencePath);
  } catch (error) {
    return {
      problems: [
        `Release quality-gate test evidence is missing or invalid (${evidencePath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      evidence: null,
      evidenceSha256: null,
      reports: [],
    };
  }
  if (!/^[0-9a-f]{40}$/i.test(String(evidence.commit || ""))) {
    problems.push("Release quality-gate test evidence has no exact commit.");
  } else if (commit && evidence.commit.toLowerCase() !== commit.toLowerCase()) {
    problems.push(
      `Release quality-gate test evidence is for ${evidence.commit}, not ${commit}.`,
    );
  }
  if (
    !Number.isFinite(evidence.startedAt) ||
    !Number.isFinite(evidence.completedAt) ||
    evidence.completedAt < evidence.startedAt
  ) {
    problems.push(
      "Release quality-gate test evidence has no valid start/completion time.",
    );
  } else {
    const age = now - evidence.completedAt;
    if (age < -EVIDENCE_CLOCK_SKEW_MS || age > maxAgeMs) {
      problems.push(
        "Release quality-gate test evidence is expired; run test:all again.",
      );
    }
  }
  if (evidence.passed !== true) {
    problems.push("Release quality-gate test evidence did not pass.");
  }
  for (const name of REQUIRED_QUALITY_CHECK_NAMES) {
    if (evidence.checks?.[name]?.status !== "passed") {
      problems.push(`Release quality-gate check "${name}" did not pass.`);
    }
  }

  const reports = [];
  for (const spec of QUALITY_GATE_REPORT_SPECS) {
    const reportPath = resolveRootRelative(root, spec.path);
    let stat;
    try {
      stat = fs.statSync(reportPath);
    } catch {
      problems.push(`Release quality-gate report is missing: ${spec.path}`);
      continue;
    }
    if (
      Number.isFinite(evidence.startedAt) &&
      stat.mtimeMs < evidence.startedAt - EVIDENCE_CLOCK_SKEW_MS
    ) {
      problems.push(
        `Release quality-gate report is stale: ${spec.path} predates test:all.`,
      );
    }
    if (stat.mtimeMs > now + EVIDENCE_CLOCK_SKEW_MS) {
      problems.push(
        `Release quality-gate report has a future timestamp: ${spec.path}.`,
      );
    }
    let report;
    try {
      report = readJsonFile(reportPath);
    } catch (error) {
      problems.push(
        `Release quality-gate report is invalid: ${spec.path} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      continue;
    }
    if (spec.kind === "vitest-coverage") {
      if (!report.total || typeof report.total !== "object") {
        problems.push(
          `Release quality-gate coverage summary is incomplete: ${spec.path}.`,
        );
      }
    }
    if (spec.kind === "release-assets") {
      if (
        report.passed !== true ||
        report.exitStatus !== "passed" ||
        report.checkCount !== report.expectedCheckCount ||
        !Number.isFinite(report.completedAt)
      ) {
        problems.push(
          `Release quality-gate release-assets report did not pass: ${spec.path}.`,
        );
      } else {
        if (
          Number.isFinite(evidence.completedAt) &&
          report.completedAt < evidence.completedAt - EVIDENCE_CLOCK_SKEW_MS
        ) {
          problems.push(
            `Release quality-gate release-assets report predates test:all: ${spec.path}.`,
          );
        }
        const reportAge = now - report.completedAt;
        if (reportAge < -EVIDENCE_CLOCK_SKEW_MS || reportAge > maxAgeMs) {
          problems.push(
            `Release quality-gate release-assets report is expired: ${spec.path}.`,
          );
        }
      }
    }
    reports.push({
      path: spec.path,
      sha256: sha256File(reportPath),
      completedAt:
        typeof report.completedAt === "number"
          ? report.completedAt
          : stat.mtimeMs,
    });
  }

  return {
    problems,
    evidence,
    evidenceSha256: sha256File(evidencePath),
    reports,
  };
}

function proofEvidenceProblems(proof, root, options = {}) {
  const collection = qualityGateEvidenceProblems(root, {
    ...options,
    commit: proof.commit,
  });
  const problems = [...collection.problems];
  const expected = new Map(
    collection.evidence
      ? [
          [
            QUALITY_GATE_EVIDENCE_RELATIVE_PATH.replace(/\\/g, "/"),
            collection.evidenceSha256,
          ],
          ...collection.reports.map((report) => [report.path, report.sha256]),
        ]
      : [],
  );
  for (const entry of proof.evidence ?? []) {
    const expectedHash = expected.get(entry.path);
    if (!expectedHash) {
      problems.push(
        `Release quality-gate proof references unknown evidence ${entry.path}.`,
      );
    } else if (expectedHash !== String(entry.sha256).toLowerCase()) {
      problems.push(
        `Release quality-gate evidence changed after proof: ${entry.path}.`,
      );
    }
  }
  if (
    collection.evidence &&
    proof.evidenceCompletedAt !== collection.evidence.completedAt
  ) {
    problems.push(
      "Release quality-gate proof does not match its test evidence.",
    );
  }
  return problems;
}

function recordSuccessfulQualityGate(root = defaultRoot) {
  let status;
  try {
    status = gitPorcelainStatus(root);
  } catch {
    return false;
  }
  if (!isAcceptableReleaseWorkingTree(status)) {
    return false;
  }
  let identity;
  try {
    identity = currentReleaseIdentity(root);
  } catch {
    return false;
  }
  const completedAt = Date.now();
  const collection = qualityGateEvidenceProblems(root, {
    commit: identity.commit,
    now: completedAt,
  });
  if (collection.problems.length > 0) return false;
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(
    proofPath,
    `${JSON.stringify(
      {
        ...identity,
        completedAt,
        evidenceCompletedAt: collection.evidence.completedAt,
        evidence: [
          {
            path: QUALITY_GATE_EVIDENCE_RELATIVE_PATH.replace(/\\/g, "/"),
            sha256: collection.evidenceSha256,
          },
          ...collection.reports.map((report) => ({
            path: report.path,
            sha256: report.sha256,
          })),
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return true;
}

function verifyQualityGate(root = defaultRoot, options) {
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  let proof;
  try {
    proof = readJsonFile(proofPath);
  } catch (error) {
    throw new Error(
      `Release quality-gate proof is missing or invalid. On a clean checkout, run "npm run test:all" (or "npm run workspace:prepare") before release:prepare. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isAcceptableReleaseWorkingTree(gitPorcelainStatus(root))) {
    const blockers = blockingReleaseWorkingTreePaths(root);
    throw new Error(
      `Release quality-gate verification requires a clean working tree or bootstrap-only drift: ${blockers.join(", ")}`,
    );
  }
  const identity = currentReleaseIdentity(root);
  const validated = validateQualityGate(proof, identity, options);
  const problems = proofEvidenceProblems(validated, root, options);
  if (problems.length > 0) {
    throw new Error(
      `Release quality-gate evidence is not valid: ${problems.join(" ")}`,
    );
  }
  return validated;
}

function writeReleaseSession(session, root = defaultRoot) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
  return session;
}

function startReleaseSession(root = defaultRoot) {
  const session = createReleaseSession(root);
  writeReleaseSession(session, root);
  return session;
}

function createReleaseSession(root = defaultRoot) {
  const qualityGate = verifyQualityGate(root);
  return {
    ...currentReleaseIdentity(root),
    qualityGateCompletedAt: qualityGate.completedAt,
    startedAt: Date.now(),
  };
}

function verifyReleaseSession(root = defaultRoot, options) {
  if (!isAcceptableReleaseWorkingTree(gitPorcelainStatus(root))) {
    const blockers = blockingReleaseWorkingTreePaths(root);
    throw new Error(
      `Release build session verification requires a clean working tree or bootstrap-only drift: ${blockers.join(", ")}`,
    );
  }
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  let session;
  try {
    session = readJsonFile(sessionPath);
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. On this machine run "npm run release:prepare" (or the full "npm run release:win" / "release:mac" / "release:linux:*" script), not *:continue alone. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const proof = verifyQualityGate(root, options);
  const validated = validateReleaseSession(
    session,
    currentReleaseIdentity(root),
    options,
  );
  if (validated.qualityGateCompletedAt !== proof.completedAt) {
    throw new Error(
      "Release build session does not reference the current quality-gate proof; run release:prepare again.",
    );
  }
  return validated;
}

if (isDirectExecution(import.meta.url)) {
  const subcommand = process.argv[2];
  if (subcommand === "start") {
    try {
      const session = startReleaseSession();
      console.log(
        `release-session: started (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`,
      );
    } catch (error) {
      console.error(
        `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  try {
    const session = verifyReleaseSession();
    console.log(
      `release-session: ok (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`,
    );
  } catch (error) {
    console.error(
      `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  DEFAULT_MAX_AGE_MS,
  QUALITY_GATE_EVIDENCE_RELATIVE_PATH,
  QUALITY_GATE_RELATIVE_PATH,
  QUALITY_GATE_REPORT_SPECS,
  RELEASE_BOOTSTRAP_PATHS,
  RELEASE_SESSION_RELATIVE_PATH,
  REQUIRED_QUALITY_CHECK_NAMES,
  blockingReleaseWorkingTreePaths,
  clearQualityGateEvidence,
  clearQualityGateProof,
  createReleaseSession,
  currentReleaseIdentity,
  gitPorcelainStatus,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  qualityGateEvidenceProblems,
  recordSuccessfulQualityGate,
  sha256WorkingTree,
  startReleaseSession,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
  writeQualityGateEvidence,
};
