# Release runbook

S3-Sidekick follows same host workflow as Zinnia: beta releases run from
`beta`, stable releases run from `main`. Windows creates one GitHub draft.
macOS and Linux wait for that draft.

## Prepare each release VM

Refresh checkout. Beta:

```sh
npm run b
```

Stable:

```sh
npm run r
```

Both commands hard-reset and clean the checkout, so they refuse to run when
the tree has local changes. On a dedicated release VM where leftovers are
expected, discard them explicitly:

```sh
ALLOW_DISCARD_LOCAL_CHANGES=1 npm run r
```

Authenticate GitHub CLI on each VM:

```sh
gh auth login
```

Install platform tools before first release.

Windows:

```sh
npm run setup:win:release
```

Linux:

```sh
npm run setup:linux
npm run setup:flatpak
```

Windows needs Azure Artifact Signing values, including
`AZURE_ARTIFACT_SIGNING_PUBLISHER_DN` (full certificate Subject). macOS needs
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`.
All signing hosts need `GPG_KEY_ID`, `GPG_PASSPHRASE`,
`TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Draft and published-release verification also require `GPG_KEY_ID` and the
corresponding public key in the verifier's GPG keyring. Prefer the full primary
fingerprint. Verification accepts that primary key's signing subkeys and does not
need the private key or `GPG_PASSPHRASE`. Both gates verify every required installer,
manifest, and checksum signature, recompute signed checksums against downloaded
bytes, and require checksum coverage for every payload and updater signature.

## Run host builds

Run one command per host:

```sh
npm run release:win
npm run release:mac
npm run release:linux
```

Each command checks branch/upstream state, bootstraps dependencies, runs
`release:prepare` (including `test:all`, Cargo audit, and license checks),
creates or waits for the draft, builds current artifacts, signs updater
payloads, creates checksums and GPG signatures, uploads to the draft, mirrors
stable artifacts when configured, and cleans checkout.

`release:prepare` runs local quality and supply-chain gates. The local `test:all` gate covers typecheck,
lint, formatting (including `scripts/*.mjs`), Cargo update policy, Tauri
alignment, icon validation, Clippy, `cargo fmt`, both builds, script and
release-asset tests, the release-assets E2E (Linux/macOS; Windows records it as
skipped because the fixture is Unix-only), Vitest, and Rust tests. Evidence
records the working-tree SHA-256 at suite start and end; a tree that changes
during `test:all` cannot produce a proof. It does not run the Ubuntu Playwright,
MinIO, or full-stack jobs; `npm run test:all:full` chains those (Playwright plus
verifier, Docker-backed MinIO, and the WebDriver full-stack suite) for a
developer or release host that has the full toolchain. Release commands do not
query GitHub Actions status or require a completed CI run. CI remains an
independent quality gate.

`release:publish` and `release:mirror` also require the current build session and
local quality-gate proof when run standalone. Run them on the host that completed
`release:prepare`. Draft and published verification still re-check uploaded bytes
and signatures.

`release:cleanup:checkout` fast-forwards to the configured upstream and
refuses a dirty tree. Set `ALLOW_RELEASE_CLEANUP_STASH=1` only to stash local
work first (restore it with `git stash pop`); the cleanup never runs
`reset --hard` or `clean -fd`. The continue chains call it through
`release:finalize`, so they cannot bypass the dirty-tree guard. The guard is
covered by an executed disposable-Git test, not only source inspection.

The browser job verifies `test-results/playwright-report.json` against
`tests/browser/required-specs.json`. Update that manifest when adding or
removing a spec or changing its test count; skipped, retried, flaky, or
unlisted specs fail the release gate.

Linux release contains the x64 AppImage and Flatpak. DEB and RPM packages are
retired: they are not built, signed, or uploaded, and a stale `.deb` or `.rpm`
left in a bundle directory is ignored. ARM64 Linux build commands remain
available for local packaging, but public release matrix is x64-only.

Beta signing copies `latest-*-beta-*.json` onto the latest _stable_ GitHub
release so native beta clients can fetch
`/releases/latest/download/latest-{{target}}-{{arch}}.json`. If that copy is
interrupted, recover with `npm run release:sync-beta-manifests`. Recovery
re-downloads each manifest and its detached signature, verifies the approved
GPG key and signed checksum coverage, and aborts before touching the stable
feed if any byte or signature does not match.

## Updater signature version binding

The updater enables `plugins.updater.requireSignedVersion`, which rejects a
manifest that pairs a version with an artifact signed for another version.
`tauri build` embeds the version automatically. The isolated
`release:sign:updater` re-sign step reads `package.json` and passes
`tauri signer sign --app-version <version>` for every artifact; it fails
instead of signing when the version is missing. Keep the package and
`src-tauri` versions synchronized with `npm run sync-version`.

## Verify and publish

After all host uploads complete:

```sh
npm run release:verify:draft
npm run release:publish
npm run release:verify:published
```

`release:verify:draft` checks draft identity, required S3 package matrix,
checksums, detached signatures, updater manifests, and updater signatures.
`release:publish` refuses a stale or incomplete draft and requires the verified
build session and local quality-gate proof.
`release:verify:published` checks the tagged release matrix, that
`target_commitish` matches the verified commit, then the public
`/releases/latest` updater feed and signatures after publication.

Perform clean-machine checks before publishing:

1. Install each package.
2. Launch app and verify basic connection UI.
3. Update from immediately previous public version.
4. Verify x64 Linux Flatpak installation and launch.
5. Biometric unlock (CI only compiles these paths; the OS credential stores
   are never exercised automatically). On macOS (Touch ID) and Windows
   (Windows Hello), with encryption on:
   - Enable biometric unlock; confirm the OS prompt appears.
   - Lock, then unlock with biometrics; saved connections reappear.
   - Cancel the OS prompt; the password prompt appears and still unlocks.
   - Disable biometric unlock; the next unlock asks for the password only.
   - Windows, when upgrading from a pre-0.11.1 enrollment: unlock once with
     Windows Hello, then confirm the credential in Credential Manager is
     stored for the local computer, not the roaming profile.

Record results in release checklist or issue. Release scripts do not treat
self-attested local JSON reports as publication authority.

## Rollback, yank, and repoint

A published release that must not be downloaded after publication is handled
in this order. Never edit a published release in place: the published bytes
and the signed updater manifests are the evidence the verification gates
re-checked.

1. **Repoint the updater feed.** Republish the previous good version's
   updater manifests (`latest-{{target}}.json` and
   `latest-{{target}}-beta-*.json` per platform) so new installs of the
   affected version stop receiving the bad build. Verify each repointed
   manifest against its detached GPG signature and signed checksum coverage
   before uploading, mirroring the beta-manifest recovery procedure above.
2. **Yank the release.** Mark the GitHub release as a draft again
   (`gh release edit <tag> --draft`) so the tag and its artifacts are no
   longer served at the public release URL. If the release is already on the
   updater feed, complete step 1 first: drafting alone does not change the
   feed.
3. **Publish a fix.** Cut a new version that contains the fix; never
   re-upload different bytes under an existing version number. Users who
   installed the bad version update normally onto the fix.
4. Record what happened in the release checklist or issue: which step was
   taken, when, and which manifest hashes were verified.

`npm run release:verify:published` re-checks the published matrix, so a
repointed feed that does not match the verified manifests fails
verification rather than silently serving a mixed state.

## Signing-key rotation

Signing secrets live outside this repository (host `.env` files), so rotation
is a host operation recorded here rather than a script in this tree:

1. Generate the new key pair on a dedicated key host; never reuse a retired
   key for another purpose.
2. Publish the new public key to the approved GPG keyring on every host that
   runs draft or published verification. Verification prefers the full
   primary fingerprint and accepts its signing subkeys.
3. Re-sign every not-yet-published artifact with the new key and re-run
   `release:verify:draft` before publishing. Published releases are never
   re-signed after the fact.
4. Delete the retired private key from every host and rotate the
   `TAURI_SIGNING_PRIVATE_KEY` and `GPG_PASSPHRASE` values in each host's
   `.env`. Azure Artifact Signing and Apple Developer certificates follow
   their publishers' rotation procedures and are re-issued, never copied
   between hosts.

## Reproducible builds

Every prepared release build runs through
`scripts/with-source-date-epoch.mjs`, which pins `SOURCE_DATE_EPOCH` to the
release commit timestamp (an explicit environment value wins). Two builds of
one commit must therefore embed the same metadata.

To verify a rebuild, download the published artifacts for a version into one
directory, build the same commit on a second host, and compare:

```sh
npm run release:verify:reproducible -- ./published ./rebuilt
```

The command hashes every file by relative path with SHA-256 and fails on any
byte difference, missing file, or extra file. Record the result in the release
checklist. CI smoke-builds the unsigned no-bundle artifacts so toolchain
breaks are found before a release VM is spent.

## Updater signing-key rotation

The updater Minisign public key lives in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); the private key is the host-only
`TAURI_SIGNING_PRIVATE_KEY` secret.

1. Generate the new Minisign key pair on a dedicated key host and store the
   private key in the secret manager used by every release host.
2. Update `plugins.updater.pubkey` in a normal commit; the next release signs
   every updater artifact with the new key. Clients older than that release
   still trust the old key and cannot verify the new manifests, so publish one
   transition release signed with the old key only after deciding how users on
   older versions update; do not rotate silently mid-stream.
3. Re-run `release:sign:updater` for the draft after the key change and verify
   with `release:verify:draft`. Published releases are never re-signed.
4. Remove the retired private key from every host and rotate the
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` value. Record the rotation date and the
   first release signed with the new key in the release checklist.

## Flatpak signing

Release hosts must set `GPG_KEY_ID`; `scripts/flatpak-bundle.js` signs the
repository refs with `flatpak build-sign` before creating the offline bundle.
Without the variable the bundle is created unsigned and the build log says so,
which is acceptable only for local testing, never for a release host.

## Dependency license policy

`npm run licenses` now fails when a bundled dependency's license is `UNKNOWN`,
`UNLICENSED`, or not on the explicit allowlist in
`scripts/license-policy.mjs`. Adding a dependency with a new license requires a
deliberate allowlist update in the same change.

## Stable mirror

Stable release requires absolute `AFTER_PACK_LOC` outside repository. Beta
release skips mirror unless `OVERRIDE_BETA_MIRROR_SKIP=1`.

Never set release skip or replacement overrides for stable releases. Fix draft
or create new version instead.
