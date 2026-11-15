import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  run,
  screenshotBranch,
  syncScreenshotBranch,
} from "./update-metainfo.js";

function fixture(releases) {
  return `<component>\n  <releases>\n${releases}\n  </releases>\n</component>\n`;
}

test("update-metainfo preserves existing release dates", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-metainfo-"),
  );
  const packagePath = path.join(directory, "package.json");
  const metadataPath = path.join(directory, "app.metainfo.xml");
  const original = fixture(
    '    <release version="1.2.3-beta.1" date="2026-08-29"/>\n    <release version="1.2.2" date="2026-07-30"/>',
  );

  try {
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.3-beta.1" }));
    fs.writeFileSync(metadataPath, original);

    assert.deepEqual(
      run({
        now: new Date("2026-09-04T00:00:00Z"),
        packagePath,
        metadataPath,
      }),
      { updated: false, version: "1.2.3-beta.1", date: "2026-08-29" },
    );
    assert.equal(fs.readFileSync(metadataPath, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("update-metainfo dates new releases with UTC date and keeps history", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-metainfo-"),
  );
  const packagePath = path.join(directory, "package.json");
  const metadataPath = path.join(directory, "app.metainfo.xml");

  try {
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.4" }));
    fs.writeFileSync(
      metadataPath,
      fixture('    <release version="1.2.3" date="2026-08-29"/>'),
    );

    const result = run({
      now: new Date("2026-09-04T00:00:00Z"),
      packagePath,
      metadataPath,
    });

    assert.deepEqual(result, {
      updated: true,
      version: "1.2.4",
      date: "2026-09-04",
    });
    assert.match(
      fs.readFileSync(metadataPath, "utf8"),
      /<release version="1\.2\.4" date="2026-09-04"\/>/,
    );
    assert.match(
      fs.readFileSync(metadataPath, "utf8"),
      /<release version="1\.2\.3" date="2026-08-29"\/>/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("update-metainfo keeps Windows line endings when metadata is unchanged", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-metainfo-"),
  );
  const packagePath = path.join(directory, "package.json");
  const metadataPath = path.join(directory, "app.metainfo.xml");
  const original = fixture(
    '    <release version="1.2.3" date="2026-08-29"/>\n    <release version="1.2.2" date="2026-07-30"/>',
  ).replace(/\n/g, "\r\n");

  try {
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(metadataPath, original);

    assert.deepEqual(
      run({
        now: new Date("2026-09-04T00:00:00Z"),
        packagePath,
        metadataPath,
      }),
      { updated: false, version: "1.2.3", date: "2026-08-29" },
    );
    assert.equal(fs.readFileSync(metadataPath, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const RAW = "https://raw.githubusercontent.com/BurntToasters/S3-Sidekick";
const shots = (branch) =>
  `<screenshots>\n  <image type="source" width="1" height="1">${RAW}/${branch}/docs/screenshots/a.png</image>\n  <image type="source" width="1" height="1">${RAW}/${branch}/docs/screenshots/b.png</image>\n</screenshots>\n`;

test("screenshotBranch maps stable to main and betas to next-X.Y.Z", () => {
  assert.equal(screenshotBranch("0.12.0"), "main");
  assert.equal(screenshotBranch("0.13.0-beta.1"), "next-0.13.0");
  assert.throws(() => screenshotBranch("not-a-version"), /version/);
});

test("syncScreenshotBranch moves beta screenshot URLs to main on stable", () => {
  assert.equal(
    syncScreenshotBranch(shots("next-0.12.0"), "0.12.0"),
    shots("main"),
  );
});

test("syncScreenshotBranch moves main screenshot URLs to next branch on beta", () => {
  assert.equal(
    syncScreenshotBranch(shots("main"), "0.13.0-beta.1"),
    shots("next-0.13.0"),
  );
});

test("syncScreenshotBranch leaves correct and unrelated URLs untouched", () => {
  assert.equal(syncScreenshotBranch(shots("main"), "0.12.0"), shots("main"));
  const other = `<url>${RAW}/next-0.12.0/README.md</url>\n<url>https://raw.githubusercontent.com/Other/Repo/next-0.12.0/docs/screenshots/a.png</url>\n`;
  assert.equal(syncScreenshotBranch(other, "0.12.0"), other);
});

test("update-metainfo rewrites the screenshot branch with the release entry", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s3-sidekick-metainfo-"),
  );
  const packagePath = path.join(directory, "package.json");
  const metadataPath = path.join(directory, "app.metainfo.xml");
  const releases = '    <release version="0.12.0" date="2026-11-01"/>';

  try {
    fs.writeFileSync(packagePath, JSON.stringify({ version: "0.12.0" }));
    fs.writeFileSync(metadataPath, shots("next-0.12.0") + fixture(releases));

    const result = run({
      now: new Date("2026-11-14T00:00:00Z"),
      packagePath,
      metadataPath,
    });

    assert.equal(result.updated, true);
    assert.equal(
      fs.readFileSync(metadataPath, "utf8"),
      shots("main") + fixture(releases),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
