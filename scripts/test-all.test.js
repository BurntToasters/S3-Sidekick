import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitialResults,
  main,
  parseRustFailureNames,
} from "./test-all.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readPackageJsonScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    .scripts;
}

test("createInitialResults includes cargo quality and frontend build keys", () => {
  const results = createInitialResults();
  assert.equal(results.cargoSafeUpdate.status, "pending");
  assert.equal(results.cargoUpdatePolicy.status, "pending");
  assert.equal(results.cargoFmt.status, "pending");
  assert.equal(results.frontendBuild.status, "pending");
  assert.equal(results.nativeBuild.status, "pending");
  assert.equal(results.tauriBuild.status, "pending");
});

test("Rust failure summary lists test names, not panic detail lines", () => {
  const output = [
    "test tests::checkpoint_scratch_path ... FAILED",
    "",
    "failures:",
    "",
    "---- tests::checkpoint_scratch_path stdout ----",
    "thread 'tests::checkpoint_scratch_path' panicked at src\\main.rs:1:1:",
    'called `Result::unwrap()` on an `Err` value: "path must be absolute"',
    "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    "",
    "failures:",
    "    tests::checkpoint_scratch_path",
    "",
    "test result: FAILED. 134 passed; 1 failed;",
  ].join("\r\n");

  assert.deepEqual(parseRustFailureNames(output), [
    "tests::checkpoint_scratch_path",
  ]);
});

test("package.json scripts define cargo safe update test and policy check", () => {
  const scripts = readPackageJsonScripts();
  assert.equal(
    scripts["test:cargo-safe-update"],
    "node --test scripts/cargo-safe-update.test.mjs scripts/check-cargo-update-policy.test.mjs",
  );
  assert.equal(
    scripts["check:cargo-update-policy"],
    "node scripts/check-cargo-update-policy.mjs",
  );
  assert.match(scripts["test:all"], /node scripts\/test-all\.js/);
});

test("main fails when cargoFmt fails", () => {
  const calls = [];
  const exitCode = main({
    root: repoRoot,
    clearProof: () => calls.push("clearProof"),
    runner: (name, _cmd, _args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "cargoFmt") {
        results[name].status = "failed";
        return false;
      }
      results[name].status = "passed";
      return true;
    },
  });

  assert.ok(calls.includes("run:cargoFmt"));
  assert.equal(exitCode, 1);
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
    runner: (name, _cmd, args, _parser, results) => {
      calls.push(`run:${name}`);
      if (name === "test") assert.deepEqual(args, ["run", "test:cov"]);
      if (name === "cargoFmt") {
        assert.deepEqual(args, [
          "fmt",
          "--all",
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "--",
          "--check",
        ]);
      }
      if (name === "frontendBuild") {
        assert.deepEqual(args, ["run", "build"]);
      }
      if (name === "tauriBuild") {
        assert.deepEqual(args, [
          "run",
          "tauri",
          "--",
          "build",
          "--no-bundle",
          "--",
          "--locked",
        ]);
      }
      results[name].status = "passed";
      return true;
    },
  });

  assert.equal(exitCode, 0);
});
