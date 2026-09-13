import assert from "node:assert/strict";
import test from "node:test";
import {
  mergedCoordinatorEnv,
  validateDraftCoordinatorEnv,
} from "./release-preflight.js";

const REFS = ["org.gnome.Platform//49", "org.gnome.Sdk//49"];
const VERSION = "0.11.0-beta.5";

function inputs() {
  return JSON.stringify({
    x64: REFS.map((ref) => ({ ref, commit: "a".repeat(64) })),
    arm64: REFS.map((ref) => ({ ref, commit: "b".repeat(64) })),
  });
}

function validMerged() {
  return {
    RELEASE_FLATPAK_INPUTS: inputs(),
    RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION: "0.11.0-beta.4",
    RELEASE_GPG_FINGERPRINT: "F".repeat(40),
  };
}

test("merged coordinator env prefers inherited values and ignores empties", () => {
  const merged = mergedCoordinatorEnv(
    { RELEASE_FLATPAK_INPUTS: "from-process", RELEASE_GPG_FINGERPRINT: "" },
    { RELEASE_FLATPAK_INPUTS: "from-dotenv", GPG_KEY_ID: "key-1" },
  );
  assert.equal(merged.RELEASE_FLATPAK_INPUTS, "from-process");
  assert.equal(merged.GPG_KEY_ID, "key-1");
  assert.equal(
    "RELEASE_GPG_FINGERPRINT" in merged,
    false,
    "empty strings must not shadow",
  );
});

test("draft coordinator env passes with a complete configuration", () => {
  validateDraftCoordinatorEnv({
    version: VERSION,
    manifestRefs: REFS,
    merged: validMerged(),
  });
});

test("draft coordinator env fails closed on missing flatpak inputs", () => {
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: {
          ...validMerged(),
          RELEASE_FLATPAK_INPUTS: undefined,
        },
      }),
    /release:flatpak-inputs/,
  );
});

test("draft coordinator env fails closed on malformed flatpak inputs", () => {
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: { ...validMerged(), RELEASE_FLATPAK_INPUTS: "nope" },
      }),
    /release:flatpak-inputs/,
  );
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: {
          ...validMerged(),
          RELEASE_FLATPAK_INPUTS: JSON.stringify({ x64: [] }),
        },
      }),
    /release:flatpak-inputs/,
  );
});

test("draft coordinator env fails closed on a bad smoke predecessor", () => {
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: {
          ...validMerged(),
          RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION: "0.11.0-beta.5",
        },
      }),
    /RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION/,
  );
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: {
          ...validMerged(),
          RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION: undefined,
        },
      }),
    /RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION/,
  );
});

test("draft coordinator env fails closed without a signing identity", () => {
  assert.throws(
    () =>
      validateDraftCoordinatorEnv({
        version: VERSION,
        manifestRefs: REFS,
        merged: {
          ...validMerged(),
          RELEASE_GPG_FINGERPRINT: undefined,
        },
      }),
    /GPG_KEY_ID/,
  );
});
