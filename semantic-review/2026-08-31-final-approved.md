# Descriptor-bound updater channels and recoverable RC publication

The 0.11.0-beta.5 release path keeps manifest discovery on GitHub Latest while binding every payload URL to the signed descriptor’s immutable tag. Signed owner-bound transactions and leases serialize beta promotion and stable rollover without adding mutable controls to the stable product closure. Persistent process ownership, protected GPG stdin, and signed rollover receipts make interrupted publication resumable. The supplied full validation evidence and a fresh 99/99 release-assets run are green.

Watch for: **[confirmed]** no P0, P1, or P2 blocker remains in the reviewed updater discovery, promotion, rollover, publication-lock, process-identity, GPG, or orchestration/recovery paths.

**Verdict**: APPROVED

## High-level view

GitHub Latest carries stable and beta manifests, but their entries use canonical `releases/download/<descriptor-tag>/...` URLs. Verification binds repository, tag, artifact, remote digest, updater signature, and descriptor, so a later Latest change cannot retarget payload bytes.

Prereleases publish with `make_latest: "false"`, pass anonymous verification, then advance beta through a signed compare-and-swap transaction. Stable releases lease the current carrier, copy its exact beta snapshot, and revalidate the frozen draft, lease, receipt, channel, tag, and SemVer ordering immediately before `make_latest: "true"`.

Publication contenders install complete private lock files atomically and identify processes by OS start-time tokens rather than PID alone. Descriptor-scoped owners and receipt identities survive artifact cleanup under `.release-state`; signed GitHub controls bracket remote mutations and keep unresolved cleanup locked.

`runPublication` now composes preflight, freeze, carry, final recheck, PATCH, settlement, anonymous verification, and beta promotion in order. Ambiguous PATCH outcomes and already-published retries recover from observed GitHub state and exact signed receipt identities.

<details>
<summary>Issues (0)</summary>

No P0/P1/P2 action items.

</details>

<details>
<summary>Details</summary>

## Latest discovery with immutable tagged payloads

Manifest generation and verification reject Latest-based payload URLs, alternate repositories or tags, noncanonical path encoding, query strings, and fragments. Every platform entry must resolve to an artifact and updater signature in the exact descriptor release. Stable product indexing excludes only exact channel protocol names, so similarly named assets remain inside the immutable product closure.

## Journaled beta promotion and receipted stable rollover

Beta promotion starts only after anonymous prerelease verification. Its signed journal binds the previous and desired pointer sets, source, carrier, product index, and publication owner; strict SemVer and exact-source retries prevent downgrade, while ownership checks around every mutation support commit-or-rollback recovery.

Stable rollover binds the predecessor controls and successor’s frozen product index into a signed receipt. Draft abort removes exact carried assets before releasing receipt and lease controls. After PATCH, retries authenticate and settle full, partial, or absent predecessor leases plus the reachable receipt-signature singleton, preserving enough control state whenever an earlier cleanup boundary fails.

## Atomic contender identity and protected GPG transport

Lock records are mode 0600 and complete before atomic installation. Linux uses boot ID plus process start ticks, Windows uses process start ticks, and macOS uses BSD start seconds and microseconds; PID reuse is stale, malformed pre-install residue is nonblocking, and unverifiable live ownership fails closed.

Detached signing requires an explicit key and passphrase, rejects line breaks, scrubs GPG credentials case-insensitively from the child environment, disables shell execution, and sends the passphrase only through file descriptor 0. The shared path covers descriptor, index, artifact, checksum, evidence, channel state, transaction, lease, and receipt signatures.

## Validation summary

Fresh review checks passed release-assets **99/99**, syntax checks for the changed publication/channel/signing/integrity modules, and `git diff --check`. Supplied evidence reports cargo/dependency policy **88/88**, frontend **398/398**, Rust **130/130**, icons **19/19**, and `test:all` fully green. Supply-chain verification found **0 npm vulnerabilities**, verified **255 signatures** and **74 attestations**, and found no Rust vulnerabilities with **17 accepted warnings**. Lint, typecheck, format, Prettier, diff checks, Clippy `-D warnings`, rustfmt, frontend and native release builds, and Tauri no-bundle builds are green.

</details>

<details>
<summary>File map</summary>

- `.gitignore` — preserves publication state outside cleaned artifacts.
- `package.json` — adds channel and publication behavior tests to the release gate.
- `scripts/ensure-draft-release.cjs` — binds draft setup to the configured repository and descriptor release.
- `scripts/github-cli.cjs`, `scripts/github-cli.test.cjs` — delete exact release assets by authenticated ID.
- `scripts/gpg-sign.js`, `scripts/gpg-sign.test.js` — generate tagged updater URLs and protect signing secrets.
- `scripts/release-env.js` — removes the mutable updater base override.
- `scripts/release-integrity.cjs`, `scripts/release-integrity.test.cjs` — enforce canonical URLs, SemVer, immutable collisions, and shared signing.
- `scripts/release-channel.js`, `scripts/release-channel.test.js` — define signed channel controls, mutation ownership, and recovery.
- `scripts/release-publication.js`, `scripts/release-publication.test.js` — orchestrate locking, promotion, rollover, PATCH settlement, and retries.
- `scripts/release-hardening.test.js` — covers process identity, persistent owners, stable closure, and channel progression.

Full reviewed diff: `git diff HEAD`, including untracked channel and publication implementation tests.

</details>
