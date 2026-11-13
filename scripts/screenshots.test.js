import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const metadata = fs.readFileSync(
  path.join(root, "run.rosie.s3-sidekick.metainfo.xml"),
  "utf8",
);
const screenshotsReadme = fs.readFileSync(
  path.join(root, "docs", "screenshots", "README.md"),
  "utf8",
);

/** Beta screenshots live on the next-X.Y.0 branch until the merge to main. */
function screenshotBranch(version) {
  return version.includes("-") ? `next-${version.split("-")[0]}` : "main";
}

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `${file} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("AppStream screenshots point at the branch that ships them", () => {
  const images = [
    ...metadata.matchAll(
      /<image type="source" width="(\d+)" height="(\d+)">([^<]+)<\/image>/g,
    ),
  ];
  assert.equal(images.length, 3, "AppStream has three screenshots");
  const branch = screenshotBranch(packageJson.version);

  for (const [, width, height, url] of images) {
    const match =
      /^https:\/\/raw\.githubusercontent\.com\/BurntToasters\/S3-Sidekick\/([^/]+)\/(.+)$/.exec(
        url,
      );
    assert.ok(match, `${url} is a raw.githubusercontent.com URL`);
    assert.equal(match[1], branch, `${url} points at ${branch}`);
    const file = path.join(root, match[2]);
    assert.ok(fs.existsSync(file), `${file} exists in this checkout`);
    assert.deepEqual(pngSize(file), {
      width: Number(width),
      height: Number(height),
    });
  }
});

test("screenshot capture version tracks the app minor version", () => {
  const match = /^Capture version:\s*(\S+)$/m.exec(screenshotsReadme);
  assert.ok(match, "docs/screenshots/README.md records a capture version");
  const minor = (value) => value.split("-")[0].split(".").slice(0, 2).join(".");
  assert.equal(
    minor(match[1]),
    minor(packageJson.version),
    "recapture the AppStream screenshots and update Capture version for this release line",
  );
});
