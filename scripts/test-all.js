import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  blockingReleaseWorkingTreePaths,
  clearQualityGateProof,
  recordSuccessfulQualityGate,
} from "./release-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const appVersion = packageJson.version ?? "unknown";
const scriptVersion = "1.1.1";

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
    format: { status: "pending" },
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

function printRustFailures(output) {
  const cleanOutput = stripAnsi(output);
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
    ? failuresBlock[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("----"))
    : [];
  const names = [...new Set([...failedNames, ...listed])].filter(Boolean);
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

  const allPassed = Object.values(results).every(
    (result) => result.status === "passed",
  );

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

function main() {
  clearQualityGateProof(resolve(__dirname, ".."));
  const results = createInitialResults();
  const npm = getNpmCommand();
  printBanner();

  runCommand("typecheck", npm, ["run", "typecheck"], null, results);
  runCommand("format", npm, ["run", "format:check"], null, results);
  runCommand("test", npm, ["run", "test"], parseTest, results);
  runCommand(
    "rust",
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml"],
    parseRustTest,
    results,
    { timeout: rustTimeoutMs },
  );

  const exitCode = printSummary(results);
  if (exitCode === 0) {
    const root = resolve(__dirname, "..");
    if (recordSuccessfulQualityGate(root)) {
      console.log("Release quality-gate proof recorded for this clean commit.");
    } else {
      const blockers = blockingReleaseWorkingTreePaths(root);
      console.log(
        "Release quality-gate proof not recorded because the working tree is dirty.",
      );
      if (blockers.length > 0) {
        console.log("Blocking paths:");
        for (const p of blockers) {
          console.log(`  - ${p}`);
        }
      }
      console.log(
        "Commit or stash changes (only version/metainfo lockfile drift from bootstrap is allowed).",
      );
    }
  }
  return exitCode;
}

process.exit(main());
