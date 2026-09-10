import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

if (process.platform !== "darwin") {
  console.log("zip-macos can only run on macOS.");
  process.exit(0);
}

const root = process.cwd();
const targetRoot = path.join(root, "src-tauri", "target");

function findApps(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        results.push(full);
      } else {
        results.push(...findApps(full));
      }
    }
  }
  return results;
}

if (!fs.existsSync(targetRoot)) {
  console.error("No build output found in src-tauri/target.");
  process.exit(1);
}

const apps = findApps(targetRoot).filter((appPath) =>
  appPath.includes(`${path.sep}bundle${path.sep}macos`),
);

if (apps.length === 0) {
  console.error("No .app bundles found. Build macOS bundles first.");
  process.exit(1);
}

for (const appPath of apps) {
  const baseName = path.basename(appPath, ".app");
  // Dev-only footgun guard: this script produces unsigned distributables.
  // Fail if the .app is already signed so a signed build is never mistaken
  // for an unsigned dev artifact, and name outputs explicitly.
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "ignore",
    });
    console.error(
      `Refusing to pack signed bundle as unsigned dev artifact: ${appPath}. Use npm run build:mac:trust for releases.`,
    );
    process.exit(1);
  } catch (err) {
    // codesign --verify exits non-zero for unsigned bundles (expected dev
    // case): fall through to packing. Only surface unexpected failures.
    if (err?.status === undefined && err?.code !== undefined) throw err;
  }
  const zipPath = path.join(
    path.dirname(appPath),
    `${baseName}-unsigned-dev.zip`,
  );
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
    {
      stdio: "inherit",
    },
  );
  console.warn(
    `Unsigned dev artifact (quarantined by Gatekeeper on download, do not distribute): ${zipPath}`,
  );
}

console.log("Created unsigned macOS dev zip archives (-unsigned-dev).");
