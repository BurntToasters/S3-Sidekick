import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  clearQualityGateEvidence,
  clearQualityGateProof,
  sha256WorkingTree,
  writeQualityGateEvidence,
} from "./release-session.js";
import { isDirectExecution } from "./direct-execution.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const appVersion = packageJson.version ?? "unknown";
const scriptVersion = "1.2.0";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};
const defaultTimeoutMs = 300_000;
const rustTimeoutMs = process.platform === "win32" ? 1_200_000 : 600_000;

function createInitialResults() {
  return {
    typecheck: { status: "pending" },
    lint: { status: "pending" },
    format: { status: "pending" },
    cargoSafeUpdate: { status: "pending" },
    cargoUpdatePolicy: { status: "pending" },
    tauriAlignment: { status: "pending" },
    icons: { status: "pending" },
    clippy: { status: "pending" },
    cargoFmt: { status: "pending" },
    frontendBuild: { status: "pending" },
    nativeBuild: { status: "pending" },
    tauriBuild: { status: "pending" },
    scriptTests: { status: "pending" },
    releaseAssets: { status: "pending" },
    releaseAssetsE2e: { status: "pending" },
    test: { status: "pending", passed: null, failed: null, files: null },
    rust: { status: "pending", passed: null, failed: null },
  };
}

function getNpmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function printTail(output) {
  const cleanOutput = stripAnsi(output).trim();
  if (!cleanOutput) return;
  const lines = cleanOutput.split("\n");
  const tail = lines.slice(-20).join("\n");
  console.log(`${colors.red}${tail}${colors.reset}`);
}

function parseRustFailureNames(output) {
  const cleanOutput = stripAnsi(output).replace(/\r\n?/g, "\n");
  const failedNames = cleanOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("FAILED"))
    .map((line) =>
      line
        .replace(/\s+FAILED$/, "")
        .replace(/^test\s+/, "")
        .replace(/\s+\.\.\.$/, "")
        .trim(),
    );
  const failuresBlock = cleanOutput.match(
    /\nfailures:\n\n([\s\S]*?)\n\ntest result:/,
  );
  const listed = failuresBlock
    ? Array.from(
        failuresBlock[1].matchAll(/^---- (.+?) stdout ----$/gm),
        (match) => match[1],
      )
    : [];
  return [...new Set([...failedNames, ...listed])].filter(Boolean);
}

function printRustFailures(output) {
  const names = parseRustFailureNames(output);
  if (names.length === 0) {
    printTail(output);
    return;
  }
  console.log(`${colors.red}Failed tests (${names.length}):${colors.reset}`);
  for (const name of names) {
    console.log(`${colors.red}  - ${name}${colors.reset}`);
  }
}

function parseTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const passedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+passed/);
  const failedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+failed/);
  const filesMatch = cleanOutput.match(
    /Test Files\s+(\d+)\s+passed(?:\s+\((\d+)\))?/,
  );

  results.test.passed = passedMatch ? parseInt(passedMatch[1], 10) : null;
  results.test.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

  if (filesMatch) {
    results.test.files = parseInt(filesMatch[1], 10);
  }
}

function parseRustTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const resultMatch = cleanOutput.match(
    /test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/,
  );
  if (resultMatch) {
    results.rust.passed = parseInt(resultMatch[1], 10);
    results.rust.failed = parseInt(resultMatch[2], 10);
  }
}

function runCommand(name, command, args, parser, results, options = {}) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
  const timeout = options.timeout ?? defaultTimeoutMs;
  const run = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: useShell,
    windowsHide: true,
    timeout,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;
  if (parser) parser(output, results);

  if (!run.error && run.status === 0) {
    results[name].status = "passed";
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return true;
  }

  results[name].status = "failed";
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || "unknown"}`
      : `exit code ${run.status}`;
  console.log(`${colors.red}✗ ${name} failed (${reason})${colors.reset}`);
  if (name === "rust") {
    printRustFailures(output);
  } else {
    printTail(output);
  }
  console.log("");
  return false;
}

function printBanner() {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║      S3 SIDEKICK TEST SUITE          ║
╚══════════════════════════════════════╝
S3 Sidekick Version: ${appVersion}
Script Version: ${scriptVersion}
${colors.reset}`);
}

function printSummary(results) {
  console.log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║               SUMMARY                ║
╚══════════════════════════════════════╝
${colors.reset}`);

  // A skipped check counts as passed only when it carries the explicit
  // waiver reason it was given by the runner (H11). Blank reasons fail the
  // gate: a skip without a recorded waiver cannot read as green.
  const allPassed = Object.entries(results).every(([name, result]) => {
    if (result.status === "passed") return true;
    if (
      name === "releaseAssetsE2e" &&
      process.platform === "win32" &&
      result.status === "skipped" &&
      typeof result.reason === "string" &&
      result.reason.trim().length > 0
    ) {
      return true;
    }
    return false;
  });

  console.log(
    `${colors.bold}TypeCheck:${colors.reset}  ${
      results.typecheck.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Format:${colors.reset}     ${
      results.format.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Lint:${colors.reset}       ${
      results.lint.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Cargo Safe Update:${colors.reset} ${
      results.cargoSafeUpdate?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Cargo Policy:${colors.reset}      ${
      results.cargoUpdatePolicy?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Tauri Alignment:${colors.reset}   ${
      results.tauriAlignment?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Icons:${colors.reset}     ${
      results.icons?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Clippy:${colors.reset}     ${
      results.clippy.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Cargo fmt:${colors.reset}  ${
      results.cargoFmt?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Frontend build:${colors.reset} ${
      results.frontendBuild?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Native build:${colors.reset} ${
      results.nativeBuild.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Tauri build:${colors.reset}  ${
      results.tauriBuild?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Script tests:${colors.reset} ${
      results.scriptTests.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Release assets:${colors.reset} ${
      results.releaseAssets?.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Release assets E2E:${colors.reset} ${
      results.releaseAssetsE2e?.status === "passed"
        ? `${colors.green}✓ PASS`
        : results.releaseAssetsE2e?.status === "skipped"
          ? `${colors.blue}SKIP`
          : `${colors.red}✗ FAIL`
    }${colors.reset}`,
  );
  console.log(
    `${colors.bold}Tests:${colors.reset}      ${
      results.test.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset} (${results.test.passed ?? "n/a"} passed${
      results.test.failed && results.test.failed > 0
        ? `, ${results.test.failed} failed`
        : ""
    }${results.test.files ? `, ${results.test.files} files` : ""})`,
  );
  console.log(
    `${colors.bold}Rust tests:${colors.reset}  ${
      results.rust.status === "passed"
        ? `${colors.green}✓ PASS`
        : `${colors.red}✗ FAIL`
    }${colors.reset} (${results.rust.passed ?? "n/a"} passed${
      results.rust.failed && results.rust.failed > 0
        ? `, ${results.rust.failed} failed`
        : ""
    })`,
  );

  console.log("");
  if (allPassed) {
    console.log(
      `${colors.green}${colors.bold}✓ All checks passed.${colors.reset}`,
    );
    return 0;
  }

  console.log(
    `${colors.red}${colors.bold}✗ Some checks failed. Review output above.${colors.reset}`,
  );
  return 1;
}

function main({
  root = resolve(__dirname, ".."),
  clearProof = clearQualityGateProof,
  clearEvidence = clearQualityGateEvidence,
  writeEvidence = false,
  runner = runCommand,
} = {}) {
  const startedAt = Date.now();
  let workingTreeSha256Start = null;
  if (writeEvidence) {
    try {
      workingTreeSha256Start = sha256WorkingTree(root);
    } catch (error) {
      console.error(
        `Could not hash the working tree before test:all: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  clearProof(root);
  if (writeEvidence) clearEvidence(root);
  const results = createInitialResults();
  const npm = getNpmCommand();
  printBanner();

  runner("typecheck", npm, ["run", "typecheck"], null, results);
  runner("lint", npm, ["run", "lint"], null, results);
  runner("format", npm, ["run", "format:check"], null, results);
  runner(
    "cargoSafeUpdate",
    npm,
    ["run", "test:cargo-safe-update"],
    null,
    results,
  );
  runner(
    "cargoUpdatePolicy",
    npm,
    ["run", "check:cargo-update-policy"],
    null,
    results,
  );
  runner(
    "tauriAlignment",
    npm,
    ["run", "check:tauri-alignment"],
    null,
    results,
  );
  runner("icons", npm, ["run", "icons:check"], null, results);
  runner(
    "clippy",
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  runner(
    "cargoFmt",
    "cargo",
    [
      "fmt",
      "--all",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--",
      "--check",
    ],
    null,
    results,
  );
  runner("frontendBuild", npm, ["run", "build"], null, results);
  runner(
    "nativeBuild",
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  runner(
    "tauriBuild",
    npm,
    ["run", "tauri", "--", "build", "--no-bundle", "--", "--locked"],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  runner(
    "scriptTests",
    "node",
    ["--test", "scripts/github-cli.test.cjs", "scripts/test-all.test.js"],
    null,
    results,
  );
  runner("releaseAssets", npm, ["run", "test:release-assets"], null, results);
  if (process.platform === "win32") {
    results.releaseAssetsE2e.status = "skipped";
    results.releaseAssetsE2e.reason =
      "The release-assets E2E uses a Unix GPG/Git/GitHub transport fixture; CI runs it on Linux.";
    console.log(
      `${colors.blue}Release assets E2E skipped on Windows; CI runs it on Linux.${colors.reset}\n`,
    );
  } else {
    runner(
      "releaseAssetsE2e",
      npm,
      ["run", "test:e2e:release-assets"],
      null,
      results,
    );
  }
  runner("test", npm, ["run", "test:cov"], parseTest, results);
  runner(
    "rust",
    "cargo",
    ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"],
    parseRustTest,
    results,
    { timeout: rustTimeoutMs },
  );

  const exitCode = printSummary(results);
  if (writeEvidence) {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sha = String(commit.stdout || "").trim();
    if (commit.status !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
      console.error(
        "Could not bind release quality-gate evidence to an exact git commit.",
      );
      return 1;
    }
    let workingTreeSha256End;
    try {
      workingTreeSha256End = sha256WorkingTree(root);
    } catch (error) {
      console.error(
        `Could not hash the working tree after test:all: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    const treeStable = workingTreeSha256Start === workingTreeSha256End;
    if (!treeStable) {
      console.error(
        "Working tree changed while test:all ran; the release quality-gate proof will be rejected.",
      );
    }
    const evidencePath = writeQualityGateEvidence(root, {
      commit: sha,
      startedAt,
      completedAt: Date.now(),
      checks: results,
      passed: exitCode === 0 && treeStable,
      workingTreeSha256Start,
      workingTreeSha256End,
    });
    console.log(`Release quality-gate evidence: ${evidencePath}`);
    if (!treeStable) return 1;
  }
  return exitCode;
}

if (isDirectExecution(import.meta.url)) {
  process.exit(
    main({ writeEvidence: process.argv.includes("--write-evidence") }),
  );
}

export {
  createInitialResults,
  getNpmCommand,
  main,
  parseRustFailureNames,
  parseRustTest,
  parseTest,
  printSummary,
  runCommand,
};
