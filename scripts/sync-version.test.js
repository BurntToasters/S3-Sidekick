import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("sync-version updates AppStream metadata alongside tauri and cargo versions", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "scripts", "sync-version.js"),
    "utf8",
  );
  assert.match(source, /from "\.\/update-metainfo\.js"/);
  assert.match(source, /updateMetainfo\(/);
});

test("npm run u propagates versions through sync-version", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.match(packageJson.scripts.u, /npm run sync-version/);
  assert.doesNotMatch(packageJson.scripts.u, /update-metainfo\.js/);
  assert.doesNotMatch(packageJson.scripts["workspace:bootstrap"], /update-metainfo\.js/);
});
