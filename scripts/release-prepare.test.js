import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runReleasePreparation, steps } from "./release-prepare.js";

test("release preparation runs every pinned step and rechecks source after each", () => {
  const commit = "a".repeat(40);
  const npmExecPath = path.resolve("npm-cli.js");
  const sourceChecks = [];
  const commands = [];

  runReleasePreparation({
    environment: { npm_execpath: npmExecPath },
    assertSource(_root, { expectedCommit } = {}) {
      sourceChecks.push(expectedCommit ?? null);
      return expectedCommit ?? commit;
    },
    assertToolVersions: () => {},
    execute(command, args, options) {
      commands.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(
    commands.map(({ args }) => args),
    steps.map((step) => [npmExecPath, "run", step]),
  );
  assert.ok(commands.every(({ options }) => options.cwd));
  assert.deepEqual(sourceChecks, [null, ...steps.map(() => commit)]);
});
