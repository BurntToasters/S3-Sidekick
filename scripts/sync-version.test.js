import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncBetaBanner } from "./sync-version-helpers.js";

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

const ACTIVE = "> [!NOTE]\n> 🅱️ This is a beta build.";
const HIDDEN = "<!-- > [!NOTE]\n> 🅱️ This is a beta build.\n-->";
const doc = (banner) => `${banner}\n\n# ⬇️ Downloads\n`;

test("syncBetaBanner shows the banner for prerelease versions", () => {
  assert.equal(syncBetaBanner(doc(HIDDEN), "0.12.0-beta.4"), doc(ACTIVE));
  assert.equal(syncBetaBanner(doc(ACTIVE), "0.12.0-beta.4"), doc(ACTIVE));
});

test("syncBetaBanner hides the banner for stable versions", () => {
  assert.equal(syncBetaBanner(doc(ACTIVE), "0.12.0"), doc(HIDDEN));
  assert.equal(syncBetaBanner(doc(HIDDEN), "0.12.0"), doc(HIDDEN));
});

test("syncBetaBanner keeps CRLF line endings", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  assert.equal(
    syncBetaBanner(crlf(doc(ACTIVE)), "0.12.0"),
    crlf(doc(HIDDEN)),
  );
  assert.equal(
    syncBetaBanner(crlf(doc(HIDDEN)), "0.12.1-beta.1"),
    crlf(doc(ACTIVE)),
  );
});

test("syncBetaBanner fails closed when the banner is missing or edited", () => {
  assert.throws(
    () => syncBetaBanner("# ⬇️ Downloads\n", "0.12.0"),
    /beta banner not found/,
  );
  assert.throws(
    () =>
      syncBetaBanner(
        "> [!NOTE]\n> Something else entirely.\n\n# ⬇️ Downloads\n",
        "0.12.0",
      ),
    /beta banner not found/,
  );
  // A banner-like block that is not at the top of the file is not touched.
  assert.throws(
    () => syncBetaBanner(`# Title\n\n${ACTIVE}\n`, "0.12.0"),
    /beta banner not found/,
  );
});

test("syncBetaBanner never touches text after the banner", () => {
  const input = `${ACTIVE}\n\nafter <!-- keep -->\n> [!NOTE]\n`;
  assert.equal(
    syncBetaBanner(input, "0.12.0"),
    `${HIDDEN}\n\nafter <!-- keep -->\n> [!NOTE]\n`,
  );
});
