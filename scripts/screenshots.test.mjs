import assert from "node:assert/strict";
import test from "node:test";
import {
  SCREENSHOTS,
  metainfoSizes,
  pngSize,
  sizeProblems,
  updateCaptureLines,
} from "./screenshots.mjs";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const README = `# AppStream screenshots

Capture version: 0.12.0-beta.2
Captured: 2026-11-12

Body text stays.
`;

const METAINFO = `<screenshots>
  <image type="source" width="1280" height="800">https://raw.githubusercontent.com/BurntToasters/S3-Sidekick/main/docs/screenshots/browse-light.png</image>
  <image type="source" width="1440" height="800">https://raw.githubusercontent.com/BurntToasters/S3-Sidekick/main/docs/screenshots/inspector-dark.png</image>
</screenshots>`;

test("updateCaptureLines rewrites version and date and keeps the body", () => {
  const next = updateCaptureLines(README, "0.13.0-beta.1", "2026-11-14");
  assert.match(next, /^Capture version: 0\.13\.0-beta\.1$/m);
  assert.match(next, /^Captured: 2026-11-14$/m);
  assert.match(next, /Body text stays\./);
  assert.doesNotMatch(next, /0\.12\.0-beta\.2|2026-11-12/);
});

test("updateCaptureLines fails when a capture line is missing", () => {
  assert.throws(
    () => updateCaptureLines("Captured: 2026-11-12\n", "0.13.0", "2026-11-14"),
    /Capture version/,
  );
  assert.throws(
    () =>
      updateCaptureLines("Capture version: 0.12.0\n", "0.13.0", "2026-11-14"),
    /Captured/,
  );
});

test("pngSize reads IHDR dimensions and rejects non-PNG bytes", () => {
  assert.deepEqual(pngSize(pngHeader(1440, 800)), { width: 1440, height: 800 });
  assert.throws(() => pngSize(Buffer.from("not a png at all, really")), /PNG/);
  assert.throws(() => pngSize(Buffer.alloc(4)), /PNG/);
});

test("metainfoSizes maps screenshot files to declared dimensions", () => {
  const sizes = metainfoSizes(METAINFO);
  assert.deepEqual(sizes.get("docs/screenshots/browse-light.png"), {
    width: 1280,
    height: 800,
  });
  assert.deepEqual(sizes.get("docs/screenshots/inspector-dark.png"), {
    width: 1440,
    height: 800,
  });
  assert.equal(sizes.size, 2);
});

test("sizeProblems reports missing captures, undeclared targets, and mismatches", () => {
  const declared = metainfoSizes(METAINFO);
  const problems = sizeProblems(
    [
      { target: "docs/screenshots/browse-light.png", size: null },
      {
        target: "docs/screenshots/inspector-dark.png",
        size: { width: 1280, height: 800 },
      },
      { target: "docs/screenshots/other.png", size: { width: 1, height: 1 } },
    ],
    declared,
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /browse-light\.png.*missing/);
  assert.match(problems[1], /inspector-dark\.png.*1280x800.*1440x800/);
  assert.match(problems[2], /other\.png.*not declared/);
});

test("sizeProblems is empty when every capture matches", () => {
  const declared = metainfoSizes(METAINFO);
  assert.deepEqual(
    sizeProblems(
      [
        {
          target: "docs/screenshots/browse-light.png",
          size: { width: 1280, height: 800 },
        },
        {
          target: "docs/screenshots/inspector-dark.png",
          size: { width: 1440, height: 800 },
        },
      ],
      declared,
    ),
    [],
  );
});

test("SCREENSHOTS maps the three tour captures to docs/screenshots", () => {
  assert.deepEqual(
    SCREENSHOTS.map((shot) => shot.target),
    [
      "docs/screenshots/browse-light.png",
      "docs/screenshots/inspector-dark.png",
      "docs/screenshots/settings-dark.png",
    ],
  );
  for (const shot of SCREENSHOTS) {
    assert.match(
      shot.source,
      /^test-results\/ux-visual-tour\/chromium\/current\//,
    );
  }
});
