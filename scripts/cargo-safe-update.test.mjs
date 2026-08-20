import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIN_PUBLISH_AGE_MS,
  crateIndexPath,
  isPublishAgeAllowed,
  parseArguments,
  parsePublishTime,
} from "./cargo-safe-update.mjs";

const now = Date.parse("2026-08-20T12:00:00Z");

test("enforces exact 72-hour boundary", () => {
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS, now), true);
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS + 1, now), false);
});

test("fails closed for bad pubtime", () => {
  assert.equal(parsePublishTime(undefined), null);
  assert.equal(parsePublishTime("invalid"), null);
  assert.equal(isPublishAgeAllowed(null, now), false);
});

test("uses official sparse index paths", () => {
  assert.equal(crateIndexPath("serde"), "se/rd/serde");
  assert.equal(crateIndexPath("ab"), "2/ab");
  assert.equal(crateIndexPath("a"), "1/a");
});

test("does not forward emergency override arguments", () => {
  const parsed = parseArguments([
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--allow-git",
    "foo@abc",
    "--reason",
    "reviewed",
  ]);
  assert.deepEqual(parsed.cargoArgs, [
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]);
  assert.equal(parsed.allowGit.has("foo@abc"), true);
});

test("dependency update entry point uses guarded Cargo resolution", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(packageJson.scripts.u, /\bcargo update\b/);
  assert.match(packageJson.scripts.u, /cargo-safe-update/);
});
