import assert from "node:assert/strict";
import test from "node:test";
import { expectedReleaseBranch } from "./release-preflight.js";

test("beta releases use versioned next branches", () => {
  assert.equal(expectedReleaseBranch("0.11.0-beta.5"), "next-0.11.0");
});

test("stable releases use main", () => {
  assert.equal(expectedReleaseBranch("0.11.0"), "main");
});

test("release preflight rejects unsupported versions", () => {
  assert.throws(
    () => expectedReleaseBranch("0.11.0-rc.1"),
    /beta or stable versions only/,
  );
  assert.throws(
    () => expectedReleaseBranch("0.11.0-beta.01"),
    /beta or stable versions only/,
  );
});
