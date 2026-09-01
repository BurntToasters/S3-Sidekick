# Release runbook

This runbook covers the local, credentialed work that CI cannot perform. A release is not ready until every target has uploaded its signed artifacts, exact checksums, semantic evidence, and install/update smoke report to the descriptor-bound draft.

## Pinned release hosts

All release hosts must use Node.js `24.20.0`, npm `12.0.2`, Rust `1.98.0`, and `cargo-audit 0.22.2`. The Flatpak manifest uses the Node 24 SDK extension and fails unless its in-sandbox Node/npm versions exactly match those signed coordinator pins. Install the pinned advisory scanner once per host:

```sh
npm run setup:cargo-audit
```

`npm run release:prepare` verifies Node/npm and `npm run release:supply-chain` now refuses any other `cargo-audit` version. CI uses the same Node/npm/Rust/cargo-audit pins.

On Windows, open an elevated PowerShell terminal and run:

```powershell
npm run setup:win:release
```

This provisions Microsoft Artifact Signing Client Tools and 7-Zip `26.02`. Strict NSIS verification rejects any other 7-Zip version. The version pin follows the [official 7-Zip release history](https://www.7-zip.org/history.txt); winget verifies the exact-version installer against its manifest hash.

On macOS, create the keychain profile named by `APPLE_NOTARY_PROFILE` with `xcrun notarytool store-credentials`, and configure the Developer ID identity and team from `.env.example`. Ad-hoc signing and missing notarization inputs are rejected.

## Freeze Flatpak inputs before draft creation

On a trusted Linux release host with the Flathub remote configured, resolve both architectures:

```sh
npm run release:flatpak-inputs
```

Copy the single emitted `RELEASE_FLATPAK_INPUTS=...` line to the draft coordinator's `.env` without editing it. The descriptor requires exact commits for every manifest `release-ref` on both x64 and arm64. Do this before `npm run release:draft`; never resolve or change Flatpak inputs after the descriptor is signed.

## Draft and target ownership

The draft coordinator creates and signs the canonical descriptor. Before draft creation, set `RELEASE_INSTALL_SMOKE_PREVIOUS_VERSION` to the one immediate public predecessor (`0.11.0-beta.4` for this RC); descriptor creation rejects missing, non-strict, or non-older values, and every target report must match the signed value exactly. For the one-time migration from legacy GitHub Latest, set `RELEASE_LEGACY_LATEST_BOOTSTRAP` to the exact JSON documented in `.env.example`; remove it after the migration. Publication rechecks the exact Latest release, tag commit, and preexisting asset snapshot before each control upload, accepts only byte-identical partial retries, and performs strict post-bootstrap verification.

### Cross-host publication-owner takeover

Run `npm run release:publish` normally on the host that created the descriptor-bound publication owner. If that host is permanently unavailable after it installed a signed remote transaction, rollover lease, or receipt, an operator may explicitly resume with:

```sh
npm run release:publish -- --takeover-publication-owner
```

`RELEASE_PUBLICATION_TAKEOVER=1` is the recovery-only environment equivalent; only exact `0` and `1` values are accepted, and unset or `0` disables takeover. Prefer the one-shot CLI flag so takeover is not accidentally left enabled.

Takeover adopts the existing owner exactly; it never creates a replacement session or weakens owner equality. Authority must come from a complete signed beta transaction pair or stable rollover/receipt pair bound to the same descriptor SHA-256, release id, and source commit. All available signed controls must identify the same owner. Publication reads the evidence twice while holding the local lock and installs the owner with compare-and-swap. Missing or singleton evidence, changing evidence, and local or remote owner conflicts fail closed. Do not delete or replace controls to force a takeover.

### Channel control history and recovery

`legacy-beta-channel-migration.json` and `.asc` are permanent signed audit authority on the bootstrapped legacy stable carrier. They remain after the exact five unsigned legacy pointers are removed and stay outside product closure. Re-running the same authorized bootstrap resumes byte-identical control uploads and remaining pointer deletions. A matching signature-only upload is recoverable only before deletion starts; changed controls or pointers, unexpected overlays, stale release/tag/base snapshots, and other partial states fail closed and require separately reviewed recovery.

`stable-rollover-receipt.json` and `.asc` are permanent signed history on each stable successor. Publication removes only the temporary predecessor rollover lease and retains the receipt pair. A published retry uses that receipt to settle a complete, partial, or already-removed predecessor lease. A receipt singleton cannot be repaired automatically and must not be deleted or replaced casually; stop and use separately reviewed recovery.

Historical migration and receipt pairs are excluded from signed product closure and do not block later beta promotion or stable rollover. Active transaction/rollover pairs and stage/backup assets are operational controls and do block concurrent transitions.

Target owners:

| Host              | Required targets and package set                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64/arm64 | NSIS and MSI installer per architecture, Authenticode outer and extracted-runtime verification                                                                            |
| macOS universal   | `darwin-x86_64` and `darwin-aarch64`; every shipped Mach-O must contain exact x86_64+arm64 slices before notarized/stapled app archive, ZIP, and DMG evidence is accepted |
| Linux x64         | AppImage + DEB + RPM + Flatpak; AppImage alone participates in the native updater                                                                                         |
| Linux arm64       | AppImage + DEB + RPM + Flatpak; set `REQUIRE_LINUX_AARCH64=1`                                                                                                             |

The Linux staging gate requires the complete AppImage/DEB/RPM trio for every Linux architecture it sees, and install-smoke closure additionally requires the staged Flatpak. DEB, RPM, and Flatpak are GPG-signed/manual package artifacts and intentionally do not require Tauri `.sig` files or updater-manifest entries.

Each `release:<host>` / `release:<host>:continue` command intentionally stops after updater signing and `release:stage`. This pause keeps the final package bytes available for clean-machine smoke testing; it does not sign, upload, mirror, or publish them yet.

## Install/update smoke ownership

For every descriptor target, use a clean disposable VM or machine image and test all three required checks against the final staged package bytes:

1. clean install;
2. launch and basic connection UI startup;
3. update from the immediately previous public version (for this RC, `0.11.0-beta.4`) to the candidate through the installation mode appropriate to the package.

After the checks pass, record the target report before GPG signing. Example:

```sh
npm run release:record-install-smoke -- \
  --confirmed \
  --target linux-x86_64 \
  --previous-version 0.11.0-beta.4 \
  --runner-image ubuntu-24.04-clean \
  --run-id rc-beta5-linux-x64-001 \
  --artifact release/S3-Sidekick-Linux-x64.AppImage \
  --artifact release/S3-Sidekick-Linux-x64.deb \
  --artifact release/S3-Sidekick-Linux-x64.rpm \
  --artifact release/S3-Sidekick-Linux-x64.flatpak
```

A universal macOS build has the same three-package closure for both Darwin targets. Record one report for each target, listing all three package bytes each time:

```sh
npm run release:record-install-smoke -- \
  --confirmed \
  --target darwin-x86_64 \
  --previous-version 0.11.0-beta.4 \
  --runner-image macos-clean \
  --run-id rc-beta5-macos-x64-001 \
  --artifact release/S3-Sidekick-macOS.app.tar.gz \
  --artifact release/S3-Sidekick-macOS.dmg \
  --artifact release/S3-Sidekick-macOS.zip
```

Repeat that command for `darwin-aarch64` with a distinct run id and the same three universal package arguments. Windows reports must likewise list every staged EXE/MSI owned by their architecture.

The recorder discovers the staged final-package closure for the target and requires the `--artifact` arguments to equal it exactly. Its `--previous-version` value must equal the descriptor's signed `installSmokePreviousVersion`; a merely older version is rejected. Omissions, duplicates, non-package files, and packages owned by another target are rejected. It computes every SHA-256 digest, validates the complete report, and creates `release-install-smoke-<target>.json` without overwriting an existing report. Recording a report does not execute the smoke checks; `--confirmed` is the operator's explicit attestation that the listed checks were completed on the named runner.

After every target owned by that host has a report, run the matching finalizer (`release:win:finalize`, `release:mac:finalize`, `release:linux:x64:finalize`, or `release:linux:arm64:finalize`). The finalizer revalidates the release session, verifies that each report exactly covers its signed `packagesByTarget` ownership set and that the deduplicated report union equals package-smoke, then GPG-signs and uploads the staged artifacts/evidence and mirrors stable artifacts when applicable. It still does not publish the GitHub draft; publication remains the separate `release:publish` step.

## Final publication gate

Before publication, run the full local validation listed in `README.md`/package scripts and ensure the draft contains exactly the descriptor-authorized assets. The publication verifier enforces:

- exact target attestation ownership;
- package-smoke, SLSA provenance, SPDX SBOM, and install-smoke body semantics;
- duplicate-free, exact per-target checksum closure;
- GPG and updater signatures;
- immutable signed asset-index closure;
- GitHub tag/source identity and stable carrier state.

Do not publish from a dirty checkout. Do not replace a colliding asset; create a new version or use a separately reviewed recovery procedure.

## External validation still required

Credentials and native hosts are required for Apple notarization, Windows Artifact Signing, signed installer extraction, ARM64 package builds, Flatpak install/update tests, and live GitHub publication. Live S3-provider testing must include versioned buckets and verify that every selected source exposes a non-`null` immutable version ID. Automatic moves on unversioned or null-version objects are rejected during the lease-held source preflight, before any destination or rollback-backup mutation; ordinary copies remain supported.
