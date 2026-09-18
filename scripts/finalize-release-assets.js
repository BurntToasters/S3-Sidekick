import fs from "node:fs";
import {
  RELEASE_DIR,
  finalizeReleaseAssets,
  getAfterPackLocation,
  readPackageVersion,
  shouldSkipBetaMirror,
} from "./post-release-assets.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

function banner(message) {
  fs.writeSync(2, `[release:mirror] ${message}\n`);
}

const version = readPackageVersion();
assertStableReleaseOverridesAllowed(process.env, version);
banner(`version=${JSON.stringify(version)}`);
banner(`releaseDir=${RELEASE_DIR}`);
banner(`AFTER_PACK_LOC=${JSON.stringify(getAfterPackLocation())}`);

try {
  const skipBeta = shouldSkipBetaMirror(process.env, version);
  if (!skipBeta && !getAfterPackLocation()) {
    throw new Error(
      `Stable release ${version} requires AFTER_PACK_LOC. Beta releases skip the mirror by default.`,
    );
  }
  const result = finalizeReleaseAssets({ logger: console, version });
  if (!skipBeta && !result.mirrored) {
    throw new Error(
      `Stable release ${version} did not mirror to AFTER_PACK_LOC.`,
    );
  }
  banner(
    `finished ok; copied=${result.copiedEntries ?? 0}; destination=${result.destination ?? ""}`,
  );
} catch (error) {
  banner(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
