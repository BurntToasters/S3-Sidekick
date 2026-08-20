import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialResults, main } from "./test-all.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readPackageJsonScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    .scripts;
}

test("createInitialResults includes cargoSafeUpdate and cargoUpdatePolicy in initial state", () => {
  const results = createInitialResults();
  assert.equal(results.cargoSafeUpdate.status, "pending");
  assert.equal(results.cargoUpdatePolicy.status, "pending");
});

test("package.json scripts define cargo safe update test and policy check", () => {
  const scripts = readPackageJsonScripts();
  assert.equal(
    scripts["test:cargo-safe-update"],
    "node --test scripts/cargo-safe-update.test.mjs",
  );
  assert.equal(
    scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
});

test("main fails when cargoSafeUpdate fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoSafeUpdate") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoSafeUpdate"));
  assert.equal(exitCode, 1);
});

test("main fails when cargoUpdatePolicy fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoUpdatePolicy") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoUpdatePolicy"));
  assert.equal(exitCode, 1);
});

test("main succeeds when all checks pass", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      results[name].status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 0);
});
