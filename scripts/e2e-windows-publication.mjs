#!/usr/bin/env node
// Windows-only E2E for create-only temporary-file publication. It runs the
// production publication path against newly created files under the OS temp
// directory and writes a JSON report plus the native cargo-test log.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testMode = process.env.S3_SIDEKICK_WINDOWS_PUBLICATION_TEST_MODE === "1";
const testOutDir = process.env.S3_SIDEKICK_WINDOWS_PUBLICATION_OUT_DIR;
const testCargoFixture =
  process.env.S3_SIDEKICK_WINDOWS_PUBLICATION_CARGO_FIXTURE;
const outDir = testMode
  ? testOutDir
  : path.join(
      root,
      "test-results",
      "fixes-0.11.1",
      "transfer-publication",
      "windows-publication",
    );
if (testMode && (!testOutDir || !testCargoFixture)) {
  process.stderr.write(
    "Windows publication test mode requires an isolated output directory and cargo fixture.\n",
  );
  process.exit(2);
}
const expected = [
  "publish_move_consumed_temp_keeps_the_successful_destination",
  "publish_hard_link_path_retains_source_until_cleanup",
  "publish_copy_fallback_preserves_create_only_bytes",
  "publish_existing_destination_is_preserved_and_temp_is_retained_for_checkpoint",
  "publish_copy_error_retains_partial_reservation_for_safe_recovery",
  "publish_sync_error_retains_destination_and_checkpoint",
  "publish_sync_error_preserves_an_unrelated_destination_replacement",
  "publish_final_cleanup_sync_error_keeps_durably_published_result_successful",
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

if (process.platform !== "win32" && !testMode) {
  const report = {
    suite: "windows-create-only-publication",
    status: "not_run",
    passed: false,
    platform: process.platform,
    exercisedRealMoveFileW: false,
    limitation:
      "Run this E2E on Windows to exercise MoveFileW. The runner creates only isolated files under the OS temp directory and does not mount or format volumes.",
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.error(
    "This E2E needs Windows to exercise the real MoveFileW call. Its fixtures use isolated files in the OS temp directory.",
  );
  process.exit(2);
}

const result = spawnSync(
  testMode ? process.execPath : "cargo",
  [
    ...(testMode ? [testCargoFixture] : []),
    "test",
    "--manifest-path",
    path.join(root, "src-tauri", "Cargo.toml"),
    "--locked",
    "publish_",
    "--",
    "--nocapture",
    "--test-threads=1",
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
fs.writeFileSync(path.join(outDir, "cargo-test.log"), output);

const tests = expected.map((name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(
    new RegExp(`test tests::${escaped} \\.\\.\\. (ok|FAILED)`),
  );
  return { name, passed: match?.[1] === "ok" };
});
const timedOut = result.error?.code === "ETIMEDOUT";
const passed =
  !result.error &&
  result.status === 0 &&
  tests.length === expected.length &&
  tests.every((test) => test.passed);
const report = {
  suite: "windows-create-only-publication",
  passed,
  platform: process.platform,
  testMode,
  temporaryRootIsolated: true,
  exercisedRealMoveFileW: !testMode,
  forcedHardLinkFailureThroughTestSeam: !testMode,
  filesystem: testMode
    ? "fixture output only; native filesystem publication was not exercised"
    : "reported by Windows host; this runner does not format or mount volumes",
  limitation:
    "This uses the Windows host temp filesystem. FAT/exFAT behavior requires a separate disposable-volume run.",
  exitCode: result.status ?? null,
  timedOut,
  failure: result.error?.message ?? null,
  testCount: tests.length,
  tests,
};
fs.writeFileSync(
  path.join(outDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(passed ? 0 : 1);
