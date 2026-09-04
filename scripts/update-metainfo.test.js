import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "./update-metainfo.js";

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
