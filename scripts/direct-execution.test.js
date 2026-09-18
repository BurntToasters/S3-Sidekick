import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDirectExecution, pathsEqual } from "./direct-execution.js";

const scriptPath = fileURLToPath(import.meta.url);
const scriptUrl = pathToFileURL(scriptPath).href;

test("direct execution comparison tolerates Windows path spelling", () => {
  assert.equal(
    isDirectExecution(scriptUrl, ["node", scriptPath.toUpperCase()], "win32"),
    true,
  );
  assert.equal(
    pathsEqual(
      "C:\\Users\\Main\\S3-Sidekick\\scripts\\test.js",
      "c:/users/main/s3-sidekick/scripts/test.js",
      "win32",
    ),
    true,
  );
});
