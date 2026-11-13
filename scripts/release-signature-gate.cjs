"use strict";

const { spawnSync } = require("node:child_process");

const SKIP_ENV = ["SKIP_WIN_CODESIGN", "SKIP_MAC_NOTARIZATION"];

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

/** Release verification must never accept an artifact whose signing was skipped. */
/**
 * Production release commands must never run with the synthetic-installer
 * fixture bypass. Only the test harness may set it, and only when invoking
 * the verification helpers directly rather than the published CLI.
 */
function assertProductionSignatureEnvironment(environment = process.env) {
  if (
    environment.S3_SIDEKICK_RELEASE_FIXTURE === "1" &&
    environment.S3_SIDEKICK_RELEASE_E2E !== "1"
  ) {
    throw new Error(
      "S3_SIDEKICK_RELEASE_FIXTURE is test-only and cannot be used by a release command.",
    );
  }
}

function assertNoSignatureSkips(environment = process.env) {
  const skipped = SKIP_ENV.filter((name) => isTruthy(environment[name]));
  if (skipped.length > 0) {
    throw new Error(
      `Release verification refuses ${skipped.join(", ")}. Rebuild with signed artifacts before verifying or publishing.`,
    );
  }
}

function verifyWindowsAuthenticode(filePath, environment) {
  const script = [
    "$sig = Get-AuthenticodeSignature -LiteralPath $env:S3_SIDEKICK_VERIFY_FILE",
    'if ($sig.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { Write-Error "Invalid Authenticode signature: $($sig.Status)"; exit 1 }',
    "if (-not $sig.TimeStamperCertificate) { Write-Error 'Missing RFC3161 timestamp'; exit 2 }",
    "Write-Output 'valid'",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      env: { ...environment, S3_SIDEKICK_VERIFY_FILE: filePath },
      timeout: 120_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !/valid/i.test(String(result.stdout || ""))) {
    throw new Error(
      `Windows Authenticode verification failed for ${filePath}: ${String(result.stderr || result.stdout || "").trim()}`,
    );
  }
}

function verifyMacNotarization(filePath, environment) {
  for (const [command, args] of [
    ["xcrun", ["stapler", "validate", filePath]],
    ["spctl", ["--assess", "--type", "install", "-vv", filePath]],
  ]) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: environment,
      timeout: 120_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `macOS notarization verification failed for ${filePath} (${command}): ${String(result.stderr || result.stdout || "").trim()}`,
      );
    }
  }
}

/**
 * Verify the signature that the publishing host can actually check. Signing
 * gates remain fail-closed on hosts without the matching verifier: the
 * skipped-signing flags above are rejected everywhere.
 */
function verifyDownloadedArtifactSignature(
  name,
  filePath,
  { environment = process.env, platform = process.platform } = {},
) {
  assertNoSignatureSkips(environment);
  // The release-assets E2E serves synthetic installer bytes. It sets this
  // explicit fixture flag; production release verification never does.
  if (environment.S3_SIDEKICK_RELEASE_FIXTURE === "1") return true;
  if (platform === "win32" && /\.(?:exe|msi)$/i.test(name)) {
    verifyWindowsAuthenticode(filePath, environment);
  }
  if (platform === "darwin" && /\.dmg$/i.test(name)) {
    verifyMacNotarization(filePath, environment);
  }
  return true;
}

module.exports = {
  SKIP_ENV,
  assertNoSignatureSkips,
  assertProductionSignatureEnvironment,
  verifyDownloadedArtifactSignature,
};
