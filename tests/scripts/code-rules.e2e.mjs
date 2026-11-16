#!/usr/bin/env node
// E2E for the code rules in AGENTS.md that a gate must enforce, not review.
//
// Failure modes checked before implementation:
// - `as any` in src/ is only a warning, so `npm run lint` still passes.
// - `@ts-ignore` in src/ is not reported at all.
// - `npm run lint` lets warnings through (no --max-warnings 0).
// - Production Rust can add `unwrap`, `expect` or `panic!` and Clippy stays
//   green, because no Clippy lint denies them.
// - The test-code allowance for those lints leaks into production code.
// - Credential and transfer modules have no per-module coverage floor, so the
//   aggregate surplus hides a drop in exactly that code.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const outDir = path.join(root, "test-results", "code-rules");
const results = [];
const EXPECTED_CHECKS = 8;

function check(name, passed, observed = undefined) {
  results.push({
    name,
    passed,
    ...(observed === undefined ? {} : { observed }),
  });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
}

// Type-aware linting reads the file from the TypeScript program, so text sent
// on stdin is not what gets checked. The probe is written into src/ (inside
// the tsconfig project) and always removed again.
function lintSource(source) {
  const probe = path.join(root, "src", "__code-rules-probe.ts");
  const eslint = path.join(root, "node_modules", ".bin", "eslint");
  fs.writeFileSync(probe, source, { flag: "wx" });
  let result;
  try {
    result = spawnSync(eslint, ["--format", "json", probe], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(probe, { force: true });
  }
  let messages = [];
  try {
    messages = JSON.parse(result.stdout)[0]?.messages ?? [];
  } catch {
    messages = [{ ruleId: "unparsed", severity: 0, message: result.stderr }];
  }
  return messages;
}

function hasError(messages, ruleId) {
  return messages.some(
    (message) => message.ruleId === ruleId && message.severity === 2,
  );
}

const anyMessages = lintSource(
  "export function widen(value: unknown): number {\n  return (value as any).length;\n}\n",
);
check(
  "`as any` in src/ is a lint error",
  hasError(anyMessages, "@typescript-eslint/no-explicit-any"),
  anyMessages,
);

const tsIgnoreMessages = lintSource(
  "// @ts-ignore\nexport const value: number = 'text';\n",
);
check(
  "`@ts-ignore` in src/ is a lint error",
  hasError(tsIgnoreMessages, "@typescript-eslint/ban-ts-comment"),
  tsIgnoreMessages,
);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
check(
  "npm run lint fails on any warning",
  /\beslint\b[^&]*--max-warnings[ =]0\b/.test(packageJson.scripts.lint),
  packageJson.scripts.lint,
);

const cargoToml = fs.readFileSync(
  path.join(root, "src-tauri", "Cargo.toml"),
  "utf8",
);
const clippyTable =
  /^\[lints\.clippy\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ??
  "";
for (const lint of ["unwrap_used", "expect_used", "panic"]) {
  check(
    `Clippy denies ${lint} in the crate`,
    new RegExp(`^${lint}\\s*=\\s*"deny"\\s*$`, "m").test(clippyTable),
    clippyTable.trim(),
  );
}

const mainRs = fs.readFileSync(
  path.join(root, "src-tauri", "src", "main.rs"),
  "utf8",
);
check(
  "the unwrap/expect/panic allowance applies to test builds only",
  /#!\[cfg_attr\(\s*test,\s*allow\([^)]*clippy::unwrap_used[^)]*clippy::expect_used[^)]*clippy::panic[^)]*\)\s*\)\]/.test(
    mainRs,
  ) && !/#!\[allow\([^)]*clippy::(unwrap_used|expect_used|panic)/.test(mainRs),
);

const vitestConfig = fs.readFileSync(
  path.join(root, "vitest.config.ts"),
  "utf8",
);
const floored = [
  "src/sftp.ts",
  "src/sftp-commands.ts",
  "src/sftp-connect-dialogs.ts",
  "src/sftp-move.ts",
  "src/transfers.ts",
  "src/security.ts",
];
const missingFloors = floored.filter(
  (file) => !vitestConfig.includes(`"${file}": {`),
);
check(
  "credential and transfer modules have per-module coverage floors",
  missingFloors.length === 0,
  { missingFloors },
);

const passed =
  results.length === EXPECTED_CHECKS && results.every((row) => row.passed);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "report.json"),
  `${JSON.stringify({ passed, expectedChecks: EXPECTED_CHECKS, checks: results }, null, 2)}\n`,
);
process.stdout.write(
  `${passed ? "PASS" : "FAIL"} code rules (${results.filter((row) => row.passed).length}/${EXPECTED_CHECKS})\n`,
);
process.exit(passed ? 0 : 1);
