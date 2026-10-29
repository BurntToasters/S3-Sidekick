#!/usr/bin/env node
// Refuse to continue when the working tree has local changes. `npm run b`
// and `npm run r` hard-reset and clean the checkout; without this guard one
// mistyped command silently destroys uncommitted work. Set
// ALLOW_DISCARD_LOCAL_CHANGES=1 to discard on purpose.

import { spawnSync } from "node:child_process";
import process from "node:process";

const status = spawnSync("git", ["status", "--porcelain=v1"], {
  encoding: "utf8",
});
if (status.status !== 0) {
  process.stderr.write(
    `require-clean-tree: not a git working tree (${status.stderr.trim()})\n`,
  );
  process.exit(1);
}

const changes = status.stdout.split("\n").filter(Boolean);
if (changes.length === 0) process.exit(0);

if (/^(1|true|yes)$/i.test(process.env.ALLOW_DISCARD_LOCAL_CHANGES ?? "")) {
  process.stderr.write(
    `require-clean-tree: ALLOW_DISCARD_LOCAL_CHANGES is set; ${changes.length} local change(s) will be discarded.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `require-clean-tree: refusing to reset a checkout with local changes:\n${changes
    .slice(0, 20)
    .map((line) => `  ${line}`)
    .join("\n")}${changes.length > 20 ? `\n  ...and ${changes.length - 20} more` : ""}\nCommit or stash them, or rerun with ALLOW_DISCARD_LOCAL_CHANGES=1 to discard.\n`,
);
process.exit(1);
