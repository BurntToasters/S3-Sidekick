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
npm run setup:deb
npm run setup:flatpak
```

Windows needs Azure Artifact Signing values, including
`AZURE_ARTIFACT_SIGNING_PUBLISHER_DN` (full certificate Subject). macOS needs
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`.
All signing hosts need `GPG_KEY_ID`, `GPG_PASSPHRASE`,
`TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Run host builds

Run one command per host:

```sh
npm run release:win
npm run release:mac
npm run release:linux
```

Each command checks branch/upstream state, bootstraps dependencies, runs the
quality gate, creates or waits for the draft, builds current artifacts, signs
updater payloads, creates checksums and GPG signatures, uploads to the draft,
mirrors stable artifacts when configured, and cleans checkout.

Linux release contains x64 AppImage, DEB, RPM, and Flatpak. ARM64 Linux build
commands remain available for local packaging, but public release matrix is
x64-only.

Beta signing copies `latest-*-beta-*.json` onto the latest *stable* GitHub
release so native beta clients can fetch
`/releases/latest/download/latest-{{target}}-{{arch}}.json`. If that copy is
interrupted, recover with `npm run release:sync-beta-manifests`.

## Verify and publish

After all host uploads complete:

```sh
npm run release:verify:draft
npm run release:publish
npm run release:verify:published
```

`release:verify:draft` checks draft identity, required S3 package matrix,
checksums, detached signatures, updater manifests, and updater signatures.
`release:publish` refuses a stale or incomplete draft.
`release:verify:published` checks the tagged release matrix, then the public
`/releases/latest` updater feed and signatures after publication.

Perform clean-machine checks before publishing:

1. Install each package.
2. Launch app and verify basic connection UI.
3. Update from immediately previous public version.
4. Verify x64 Linux Flatpak installation and launch.

Record results in release checklist or issue. Release scripts do not treat
self-attested local JSON reports as publication authority.

## Stable mirror

Stable release requires absolute `AFTER_PACK_LOC` outside repository. Beta
release skips mirror unless `OVERRIDE_BETA_MIRROR_SKIP=1`.

Never set release skip or replacement overrides for stable releases. Fix draft
or create new version instead.
