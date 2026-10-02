#!/usr/bin/env node
// Failure modes were recorded in release-safety-failure-modes.md before this
// fixture and the product changes. Real GPG/Minisign bytes are checked by copied
// production release CLIs; GitHub transport and the final live-feed gate are
// disposable local fixtures. No release is published.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requiredDraftAssetNames,
  requiredDraftInstallerNames,
  requiredDraftManifestNames,
} from "../../scripts/verify-release-draft.js";
import { targetKeysForArtifact } from "../../scripts/gpg-sign.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const out = path.join(root, "test-results", "release-assets-e2e");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s3sk-assets-"));
const home = path.join(scratch, "gpg");
const fixture = path.join(scratch, "checkout");
const baseline = path.join(scratch, "baseline");
const bin = path.join(scratch, "bin");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const checks = [];
let error = null;
const environment = {
  ...process.env,
  GNUPGHOME: home,
  GPG_PASSPHRASE: "",
  GH_REPO_OWNER: "BurntToasters",
  GH_REPO_NAME: "S3-Sidekick",
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
};
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message || result.stderr}`,
    );
  }
  return result.stdout;
}
function record(name, passed, observed) {
  checks.push({ name, passed, observed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}
function sign(file, key = environment.GPG_KEY_ID) {
  run("gpg", [
    "--batch",
    "--yes",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
    "--armor",
    "--detach-sign",
    "--local-user",
    key,
    "--output",
    `${file}.asc`,
    file,
  ]);
}
function makeKey(name, usage = "sign") {
  run("gpg", [
    "--batch",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
    "--quick-generate-key",
    `${name} <${name}@fixture.invalid>`,
    "ed25519",
    usage,
    "0",
  ]);
  const listing = run("gpg", ["--batch", "--with-colons", "--list-keys", name]);
  return listing
    .split(/\r?\n/)
    .find((line) => line.startsWith("fpr:"))
    .split(":")[9];
}
function cliCase(name, mutate = () => {}, expectedError = undefined, env = {}) {
  const assets = path.join(scratch, name);
  fs.cpSync(baseline, assets, { recursive: true });
  mutate(assets);
  for (const mode of ["draft", "published"]) {
    const tempBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith("s3-sidekick-integrity-")),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(fixture, "scripts", `verify-release-${mode}.js`)],
      {
        encoding: "utf8",
        cwd: fixture,
        timeout: 60_000,
        killSignal: "SIGKILL",
        env: {
          ...environment,
          FIXTURE_ASSETS: assets,
          FIXTURE_PUBLISHED: mode === "published" ? "1" : "0",
          ...env,
        },
      },
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    fs.writeFileSync(path.join(out, `${name}-${mode}.log`), output);
    const temporaryDownloadsRemoved =
      fs
        .readdirSync(os.tmpdir())
        .filter(
          (name) =>
            name.startsWith("s3-sidekick-integrity-") && !tempBefore.has(name),
        ).length === 0;
    record(
      `${mode}: ${name}`,
      temporaryDownloadsRemoved &&
        !result.error &&
        (expectedError
          ? result.status !== 0 && expectedError.test(output)
          : result.status === 0),
      {
        exitCode: result.status,
        error: result.error?.message || null,
        temporaryDownloadsRemoved,
        diagnostic: output.trim().slice(-900),
      },
    );
  }
}

try {
  if (process.platform === "win32")
    throw new Error(
      "This Unix transport fixture runs in the Linux CI job; Windows release scripts are covered by existing gates.",
    );
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(bin);
  fs.mkdirSync(baseline);
  fs.cpSync(path.join(root, "scripts"), path.join(fixture, "scripts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fixture, "src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify(pkg));
  // Only the final public /releases/latest network gate is stubbed in the copied
  // checkout. All preceding asset, updater and GPG verification remains real.
  fs.writeFileSync(
    path.join(fixture, "scripts", "validate-updater-live.js"),
    'console.log("fixture live-feed boundary");\n',
  );
  const head = "a".repeat(40);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(head)});\n`,
    { mode: 0o755 },
  );
  environment.GPG_KEY_ID = makeKey("approved", "cert");
  run("gpg", [
    "--batch",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
    "--quick-add-key",
    environment.GPG_KEY_ID,
    "ed25519",
    "sign",
    "0",
  ]);
  const foreign = makeKey("foreign");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = Buffer.alloc(8, 7);
  const rawPublic = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const updaterPublic = Buffer.from(
    `untrusted comment: fixture key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPublic]).toString("base64")}\n`,
  ).toString("base64");
  fs.writeFileSync(
    path.join(fixture, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: updaterPublic } } }),
  );
  const updaterByTarget = {
    "windows-x86_64": "S3-Sidekick-Windows-x64.exe",
    "windows-aarch64": "S3-Sidekick-Windows-arm64.exe",
    "darwin-x86_64": "S3-Sidekick-macOS.app.tar.gz",
    "darwin-aarch64": "S3-Sidekick-macOS.app.tar.gz",
    "linux-x86_64": "S3-Sidekick-Linux-x64.AppImage",
  };
  for (const name of requiredDraftInstallerNames()) {
    const bytes = Buffer.alloc(256 * 1024, 0xff);
    Buffer.from(name).copy(bytes);
    fs.writeFileSync(path.join(baseline, name), bytes);
  }
  for (const name of new Set(Object.values(updaterByTarget))) {
    const hash = crypto
      .createHash("blake2b512")
      .update(fs.readFileSync(path.join(baseline, name)))
      .digest();
    const signature = crypto.sign(null, hash, privateKey);
    const comment = `timestamp:1 file:${name}`;
    const global = crypto.sign(
      null,
      Buffer.concat([signature, Buffer.from(comment)]),
      privateKey,
    );
    fs.writeFileSync(
      path.join(baseline, `${name}.sig`),
      `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
    );
  }
  for (const name of requiredDraftManifestNames()) {
    const target = name.slice(7, -5).replace("-beta-", "-");
    const artifact = updaterByTarget[target];
    fs.writeFileSync(
      path.join(baseline, name),
      JSON.stringify({
        version: pkg.version,
        platforms: {
          [target]: {
            url: `https://github.com/BurntToasters/S3-Sidekick/releases/download/v${pkg.version}/${artifact}`,
            signature: Buffer.from(
              fs
                .readFileSync(path.join(baseline, `${artifact}.sig`), "utf8")
                .trim(),
            ).toString("base64"),
          },
        },
      }),
    );
  }
  const payloads = fs.readdirSync(baseline);
  for (const name of requiredDraftAssetNames().filter((name) =>
    /^SHA256SUMS-.*\.txt$/.test(name),
  )) {
    const target = name.slice(11, -4);
    const rows = payloads
      .filter((payload) => targetKeysForArtifact(payload).includes(target))
      .sort()
      .map(
        (payload) =>
          `${digest(fs.readFileSync(path.join(baseline, payload)))}  ${payload}`,
      );
    fs.writeFileSync(path.join(baseline, name), `${rows.join("\n")}\n`);
  }
  for (const name of fs
    .readdirSync(baseline)
    .filter((name) => !name.endsWith(".sig")))
    sign(path.join(baseline, name));
  const names = requiredDraftAssetNames();
  const ghSource = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const names = ${JSON.stringify(names)};
const args = process.argv.slice(2); const endpoint = args.find(arg => arg.startsWith('/repos/')) || '';
if (args[0] === 'auth') process.exit(0);
const match = endpoint.match(/\\/releases\\/assets\\/(\\d+)$/);
if (match) { const name = names[Number(match[1])-1]; if (!name) process.exit(2); fs.writeSync(1, fs.readFileSync(path.join(process.env.FIXTURE_ASSETS,name))); }
else if (endpoint.includes('/assets?')) { const assets = names.map((name,i) => ({name,id:i+1})); if(process.env.FIXTURE_DUPLICATE==='1') assets.push({name:names[0],id:999}); console.log(JSON.stringify(assets)); }
else { const release = {id:1,name:${JSON.stringify(pkg.version)},tag_name:${JSON.stringify(`v${pkg.version}`)},draft:process.env.FIXTURE_PUBLISHED !== '1',prerelease:false,target_commitish:${JSON.stringify(head)}}; console.log(JSON.stringify(endpoint.includes('/tags/') ? release : [release])); }
`;
  fs.writeFileSync(path.join(bin, "gh"), ghSource, { mode: 0o755 });
  cliCase("valid-approved-signing-subkey");
  cliCase(
    "altered-non-updater-installer",
    (assets) =>
      fs.appendFileSync(
        path.join(assets, "S3-Sidekick-Windows-x64.msi"),
        "altered",
      ),
    /GPG|signature|checksum/i,
  );
  cliCase(
    "invalid-installer-signature",
    (assets) =>
      fs.writeFileSync(
        path.join(assets, "S3-Sidekick-macOS.dmg.asc"),
        "not a signature",
      ),
    /GPG|signature/i,
  );
  cliCase(
    "foreign-key-signature",
    (assets) =>
      sign(path.join(assets, "S3-Sidekick-Linux-x64.flatpak"), foreign),
    /approved|fingerprint|signing key/i,
  );
  const checksum = "SHA256SUMS-windows-x86_64.txt";
  const signedChecksumCase = (name, transform, expected) =>
    cliCase(
      name,
      (assets) => {
        const file = path.join(assets, checksum);
        fs.writeFileSync(file, transform(fs.readFileSync(file, "utf8")));
        sign(file);
      },
      expected,
    );
  signedChecksumCase(
    "signed-wrong-digest",
    (text) => text.replace(/^[a-f0-9]{64}/, "0".repeat(64)),
    /checksum|digest/i,
  );
  signedChecksumCase("empty-checksums", () => "", /empty|checksum/i);
  signedChecksumCase(
    "malformed-checksums",
    () => "invalid checksum\n",
    /malformed|checksum/i,
  );
  signedChecksumCase(
    "duplicate-checksum-entry",
    (text) => text + text.split("\n")[0] + "\n",
    /duplicate|checksum/i,
  );
  signedChecksumCase(
    "unsafe-checksum-name",
    (text) => text.replace(/ {2}[^\n]+/, "  ../outside"),
    /unsafe|checksum/i,
  );
  signedChecksumCase(
    "unknown-checksum-name",
    (text) => text.replace(/ {2}[^\n]+/, "  unknown.bin"),
    /unknown|checksum/i,
  );
  cliCase(
    "missing-installer-coverage",
    (assets) => {
      for (const name of names.filter((name) =>
        /^SHA256SUMS-.*\.txt$/.test(name),
      )) {
        const file = path.join(assets, name);
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => !line.endsWith("  S3-Sidekick-macOS.zip"))
            .join("\n"),
        );
        sign(file);
      }
    },
    /checksum|coverage|covered/i,
  );
  cliCase(
    "missing-updater-signature-coverage",
    (assets) => {
      for (const name of names.filter((name) =>
        /^SHA256SUMS-.*\.txt$/.test(name),
      )) {
        const file = path.join(assets, name);
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(
              (line) => !line.endsWith("  S3-Sidekick-Windows-x64.exe.sig"),
            )
            .join("\n"),
        );
        sign(file);
      }
    },
    /checksum|coverage|covered/i,
  );
  cliCase("duplicate-assets", () => {}, /duplicate/i, {
    FIXTURE_DUPLICATE: "1",
  });
  cliCase(
    "empty-installer",
    (assets) => {
      const file = path.join(assets, "S3-Sidekick-macOS.zip");
      fs.writeFileSync(file, "");
      sign(file);
    },
    /empty|checksum/i,
  );
  const past = Math.floor(Date.now() / 1000) - 14 * 86400;
  run("gpg", [
    "--batch",
    "--faked-system-time",
    `${past}!`,
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
    "--quick-generate-key",
    "expired <expired@fixture.invalid>",
    "ed25519",
    "sign",
    "1d",
  ]);
  const expired = run("gpg", [
    "--batch",
    "--with-colons",
    "--list-keys",
    "expired",
  ])
    .split(/\r?\n/)
    .find((line) => line.startsWith("fpr:"))
    .split(":")[9];
  cliCase(
    "expired-approved-key",
    (assets) => {
      const file = path.join(assets, "S3-Sidekick-macOS.zip");
      run("gpg", [
        "--batch",
        "--yes",
        "--faked-system-time",
        `${past + 3600}!`,
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--armor",
        "--detach-sign",
        "--local-user",
        expired,
        "--output",
        `${file}.asc`,
        file,
      ]);
    },
    /expired|GPG|signing key/i,
    { GPG_KEY_ID: expired },
  );
  const revocation = fs
    .readFileSync(
      path.join(home, "openpgp-revocs.d", `${environment.GPG_KEY_ID}.rev`),
      "utf8",
    )
    .replace(
      /^:-----BEGIN PGP PUBLIC KEY BLOCK-----/m,
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
    );
  const revocationPath = path.join(scratch, "revocation.asc");
  fs.writeFileSync(revocationPath, revocation);
  run("gpg", ["--batch", "--import", revocationPath]);
  cliCase("revoked-approved-key", () => {}, /revoked|GPG|signing key/i);
  cliCase("missing-approved-key", () => {}, /GPG_KEY_ID|approved/i, {
    GPG_KEY_ID: "",
  });
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
  record("fixture completes", false, error);
} finally {
  spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], {
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const passed =
    !error && checks.length === 34 && checks.every((check) => check.passed);
  fs.writeFileSync(
    path.join(out, "report.json"),
    `${JSON.stringify({ suite: "release-assets-integrity", passed, fixture: "copied production CLIs; real GPG signing-subkey and Minisign verification; fake GitHub transport; final live-feed gate stubbed", checkCount: checks.length, expectedCheckCount: 34, error, checks }, null, 2)}\n`,
  );
  process.exitCode = passed ? 0 : 1;
}
