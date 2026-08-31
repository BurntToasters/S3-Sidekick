# S3 Sidekick long-term codebase audit

**Audit date:** 2026-08-29
**Repository:** `BurntToasters/S3-Sidekick`
**Branch / baseline:** `next-0.11.0` at `620829d5fc1d4a324fb7677c0e4ab7254cd4cb6e`
**Product context:** `0.11.0` is intended to be the final pre-1.0 line.
**Audit mode:** static, read-only whole-repository review. No application source, tests, dependencies, build outputs, staged changes, or prior semantic-review reports were modified. No provider endpoints, credential stores, installers, or packaged applications were exercised.

## Executive decision

S3 Sidekick has unusually strong defensive work for a pre-1.0 desktop S3 client: create-only capability handling, receipt-backed moves, connection generations, durable local writes, migration fencing, bounded transfer behavior, and substantial frontend/native unit coverage are all materially better than a typical GUI client. The current beta gate was previously reported green at 388/388 frontend tests and 130/130 Rust tests, with Clippy, builds, assets, icons, audits, and semantic review passing. This audit did not rerun that gate because the working tree contains preserved staged and unstaged work.

The code is nevertheless **not ready to be declared 1.0-stable**. Three independently verified application races can violate transaction/recovery semantics, and four release-pipeline conditions can publish mutable, unavailable, unsigned, or secret-exposed artifacts. These are publication blockers, not general refactoring wishes.

### Required before the next public release

1. Serialize overlapping app-owned S3 keyspaces through copy/move validation, rollback, and source deletion.
2. Make `movePhase="copied"` a deletion-only state that cannot re-enter generic destination conflict handling.
3. Make download scratch leases ownership-checked and atomic for a destination.
4. Refuse all mutation of published GitHub releases and bind uploads to one immutable release record.
5. Publish beta updater channel pointers only after the referenced prerelease assets are public and verified.
6. Remove aggregate `.env` inheritance from dependency-executing builds and exclude secret env files from Flatpak sources.
7. Require and independently verify macOS signing, notarization, stapling, and Gatekeeper acceptance.

### Required before 1.0

The durable transfer lifecycle must survive disconnect/lock and crash boundaries without turning recoverable work into terminal, unpersisted errors; upload/download memory must be governed process-wide; retained download ranges need local integrity evidence; metadata/Object Lock semantics need an explicit support contract; and release artifacts from every host must be tied to one canonical source descriptor. A real packaged-app/provider/failpoint test boundary is also necessary before making a stability claim.

## Priority and confidence model

- **P0 — publication blocker:** credible data-loss, recovery-loss, release-integrity, signing, or secret-boundary failure. Resolve before another public build.
- **P1 — 1.0 blocker:** significant correctness, compatibility, resilience, or assurance risk. Resolve or explicitly remove the affected feature from the 1.0 support promise.
- **P2 — strategic hardening:** performance, accessibility, maintainability, observability, or defense-in-depth work that should be scheduled but does not alone block a beta hotfix.
- **Confidence:** `confirmed` means the complete static path was independently traced; `high` means the implementation clearly permits the outcome but runtime/provider behavior affects reproduction; `medium` means the risk depends materially on platform or threat-model assumptions.

## Root causes

The retained findings collapse into six architectural causes rather than dozens of unrelated defects:

1. **No app-local S3 keyspace transaction isolation.** Storage lifecycle guards admit concurrent transfers and do not lock bucket/key/prefix ranges.
2. **The durable transfer state machine is implicit.** Queue status, operation phase, conflict policy, retry state, connection ownership, and recovery inclusion are separate booleans/strings rather than one validated transition model.
3. **Filesystem authority is pathname-based.** Durable scratch ownership, validation, and later I/O are not consistently bound to an unforgeable capability or stable file identity.
4. **Publication is mutable and host-local.** Each release host proves its own tree, while draft lookup, asset replacement, beta-channel promotion, and published state are not governed by one immutable descriptor.
5. **Contracts and domains are manually duplicated.** Rust commands/events/errors and TypeScript DTOs/strings can drift; `s3.rs` and `transfers.ts` own too many concerns.
6. **Production boundaries are not tested or observable.** Unit tests are substantial, but provider protocols, process death, credential stores, installers/updaters, and performance limits lack executable gates and correlated diagnostics.

# P0 findings — next-publication blockers

## P0-APP-01 — Overlapping copy/move transactions can invalidate a destination after validation and before source deletion

**Severity / confidence / target:** P0 / confirmed / next public release
**Affected code:** `src-tauri/src/main.rs::acquire_transfer_storage`; `src-tauri/src/s3.rs::{copy_with_receipt,rename_object,copy_prefix_objects,rollback_prefix_copy_unbounded,delete_receipts_checked,rename_prefix,copy_object_to,copy_prefix_to}`; `src/transfers.ts::processQueue`.

**Failure sequence:**

1. Every mutating S3 command acquires `StorageTransferGuard`, but that guard increments an `active_transfers` count; it does not exclude another transfer.
2. Move A copies source `S` to destination `D` and stores a receipt.
3. `delete_receipts_checked` validates all destination identities, then separately validates all source identities, then starts source deletion.
4. During any await between those stages, move/copy B can overwrite `D` because there is no bucket/key/prefix lease.
5. Move A can then delete `S` based on the earlier destination observation. On an unversioned destination, the receipt-backed content may no longer exist anywhere.
6. Prefix rollback has the same root problem: it restores an old backup to a destination with `overwrite=true`, so it can overwrite a peer transaction that committed after the backup was taken.

Conditional source deletes, destination receipts, and version-specific checks are good controls, but they do not make the multi-request validation/delete sequence atomic. Bucket versioning reduces recoverability impact; it does not make concurrent UI operations serializable.

**Tactical remediation:** add a process-wide keyspace lease manager in native code. Acquire ordered leases for every source and destination bucket/key or prefix before conflict probing; hold them through copy, durable receipt publication, rollback, and source deletion. Reject or queue overlapping prefix/key ranges. Revalidate each destination immediately before its paired delete as an additional fail-closed check.

**Strategic remediation:** represent moves as durable transactions with explicit intent, copy identities, and completion records. Define semantics for external writers: guarantee serializability only among app-owned operations, recommend versioning for recoverability, and fail with a precise “destination changed; source retained” outcome when external atomicity cannot be guaranteed.

**Required test:** a deterministic mock-S3 barrier suite that pauses after destination validation, commits a second overlapping operation, and proves the first operation never deletes its source or clobbers the peer. Cover object/object, object/prefix, prefix/prefix, rollback, versioned, and unversioned buckets.

## P0-APP-02 — Receipt-backed copied moves re-enter conflict handling and can discard the only durable path to completion

**Severity / confidence / target:** P0 / confirmed / next public release
**Affected code:** `src/transfers.ts::{buildQueueManifestJson,runItemWithRetry,resolveConflict,executeTransfer}`.

**Failure sequence:**

1. A move finishes its copy, stores receipts, sets `movePhase="copied"`, and durably persists the queue.
2. The process stops, the transfer is paused, or deletion fails; recovery restores that receipt-backed state.
3. `runItemWithRetry` always calls `resolveConflict` before `executeTransfer` inspects `movePhase`.
4. The already-created destination necessarily looks like a conflict. With `ask`, the user can choose Skip; with a persisted/global `skip` policy, skipping is automatic.
5. The item becomes `skipped`. `buildQueueManifestJson` only retains `queued`/`uploading` work, so the receipt-backed deletion intent falls out of recovery. The source and destination remain duplicated and the app loses its safe automated completion record.

This does not usually destroy object bytes, but it violates the move contract and discards durable safety evidence precisely after the destructive half of the transaction was prepared.

**Tactical remediation:** branch on a validated receipt-backed copied phase before conflict handling. That phase may only verify receipts and attempt source deletion; it must never ask whether to replace or skip the destination. If verification fails, retain the item and receipts in a recoverable “intervention required” state.

**Strategic remediation:** replace generic status/phase combinations with a discriminated durable state machine such as `QueuedCopy -> Copying -> CopiedReceiptDurable -> DeletingSource -> Completed`, with allowed transitions and recovery behavior enforced in one module.

**Required test:** serialize and reload a copied move under `ask`, `skip`, and `replace` policies; prove no dialog is shown, no recopy occurs, and receipts remain durable until deletion succeeds or the user explicitly abandons them.

## P0-APP-03 — A losing same-destination download can delete the winning transfer’s durable scratch lease

**Severity / confidence / target:** P0 / confirmed / next public release
**Affected code:** `src-tauri/src/main.rs::{issue_download_scratch_lease,release_download_scratch_lease,claim_download_temp}`; `src-tauri/src/s3.rs::{download_object,download_object_parallel}`.

**Failure sequence:**

1. Transfer A writes the destination-derived lease and then attempts the in-memory temp claim.
2. Transfer B for the same destination writes the same lease path, replacing A’s lease, before attempting the same claim.
3. One transfer wins the in-memory claim. The loser calls `release_download_scratch_lease`, which deletes by destination without checking the nonce or owner.
4. The winning transfer continues with no durable lease. If the process crashes, recovery/GC can no longer prove ownership of its scratch file.

**Tactical remediation:** claim the runtime destination before creating a lease, create leases with `create_new`, return an ownership token, and require that exact token for release. Never let a failed claimant delete a lease it did not create.

**Strategic remediation:** use one native `DownloadDestinationCapability` that owns destination identity, scratch handle/path, lease token, checkpoint ID, and final publication. Make acquisition/release RAII-based and idempotent across success, cancellation, and crash recovery.

**Required test:** use barriers to interleave two downloads to the same destination at every issue/claim/release boundary; assert one owner, one intact lease, and no loser-controlled cleanup.

## P0-REL-01 — Release tooling can select a published release and replace its assets

**Severity / confidence / target:** P0 / confirmed / before next upload
**Affected code:** `scripts/ensure-draft-release.cjs::{findExistingRelease,ensureDraftRelease,waitForDraftRelease}`; `scripts/gpg-sign.js::{getOrCreateRelease,uploadAssetWithReplace}`; `scripts/github-cli.cjs::releaseUploadArgs`.

`findExistingRelease` prefers a draft but falls back to any matching tag. `getOrCreateRelease` first uses GitHub’s tag endpoint, which normally returns a published release. `uploadAssetWithReplace` retries collisions with `--clobber`. A rerun can therefore refresh published release notes and replace signed binaries or updater manifests under an immutable public version.

**Tactical remediation:** require `release.draft === true`, expected tag, expected prerelease flag, and a recorded release ID before any mutation. Treat a published match as a terminal error. On drafts, allow idempotent reuse only when the existing asset digest equals the new digest; require an explicit recovery command for any replacement.

**Strategic remediation:** create one release descriptor once, record its GitHub release ID, tag, source digest, expected asset names/digests, and channel. Sign that descriptor and make publication a compare-and-set transition from draft to published. Never mutate a published release; publish a new version to correct it.

**Required test:** fixture the GitHub API with draft, published, duplicate-tag, and asset-collision states. Prove normal commands cannot patch notes or clobber assets after publication.

## P0-REL-02 — Beta updater manifests are promoted before their draft assets are publicly available

**Severity / confidence / target:** P0 / confirmed / before next beta upload
**Affected code:** `scripts/gpg-sign.js::{generateUpdaterManifests,syncBetaManifestsToLatestStable,main}`; `src/updater.ts::{updaterCheckTargetForChannel,checkNativeUpdate}`.

Prerelease beta manifests use tag-specific asset URLs. After uploading a host’s artifacts to the current release, `main` immediately copies `latest-*-beta-*.json` onto the latest stable release. The current beta can still be a draft and multi-host assembly can still be incomplete, so beta clients can observe a manifest whose URL is inaccessible or whose release has not completed verification. Stable-channel filenames are separate, so the main risk is a broken or partially promoted beta channel rather than stable users receiving a beta.

**Tactical remediation:** remove beta-channel synchronization from per-host signing/upload. After all expected assets and signatures are present, publish the prerelease, verify public downloads and signatures, and only then update beta channel manifests. If any step fails, retain the previous channel pointer.

**Strategic remediation:** host channels as small signed indices updated atomically from a final publication job. A channel update should reference an immutable release descriptor and occur only after public smoke verification.

**Required test:** model draft, partially assembled, published, and rollback states. Assert no channel-visible manifest ever references a draft/missing asset.

## P0-REL-03 — Build commands expose the aggregate release environment to dependencies, and Flatpak sources do not exclude secret env files

**Severity / confidence / target:** P0 / confirmed configuration, high exploitability dependence / before next release build
**Affected code:** `package.json` release/build scripts; `src-tauri/tauri.conf.json::build.beforeBuildCommand`; `run.rosie.s3-sidekick.yml`; `.env.example`.

Windows, macOS, Linux, signing, draft, and mirror commands are wrapped in `dotenv -e .env`. Tauri then runs `npm run build`, so every build-time package/plugin inherits all release secrets rather than a minimum command-specific set. The Flatpak `type: dir` source skips `.git`, build outputs, and dependencies but not `.env`/`.env.*`; the build sandbox has network access and runs npm, Vite, Cargo, `curl | sh`, and a floating npm install.

This is a supply-chain blast-radius problem even if all currently locked dependencies are trusted. It also makes accidental inclusion/logging of release secrets easier.

**Tactical remediation:**

- Add explicit Flatpak source skips for `.env`, `.env.local`, and secret-bearing `.env.*` files while retaining the non-secret example intentionally.
- Stop wrapping compilation in an aggregate dotenv environment. Pass only the exact signing/updater variable to the exact process that needs it.
- Build unsigned artifacts in a secret-free, network-disabled environment; sign/notarize in a separate minimal job.
- Ensure logs and generated frontend bundles contain no secret values or secret variable names with values.

**Strategic remediation:** use short-lived platform signing identities from CI secret stores, hermetic locked dependency builds, offline Flatpak sources, and isolated signing/publishing jobs that consume digested artifacts rather than source trees.

**Required test:** a canary-secret build that fails if the canary reaches npm/Vite/Cargo child environments, build logs, source bundles, packaged files, or the Flatpak build context.

## P0-REL-04 — macOS release success does not require or verify signing, notarization, stapling, or Gatekeeper acceptance

**Severity / confidence / target:** P0 / confirmed / before distributing macOS artifacts
**Affected code:** `package.json::{build:mac:universal:prepared,release:mac:continue,build:mac:zip}`; `src-tauri/tauri.conf.json::bundle.macOS`; `src-tauri/entitlements.plist`; `.github/workflows/ci.yml`.

The bundle enables hardened runtime and entitlements, but the release path does not require a Developer ID identity/notary profile and has no final `codesign`, `notarytool`, stapler, or `spctl` verification gate. A build can therefore complete and upload an unsigned, ad-hoc-signed, unstapled, or Gatekeeper-rejected app/DMG.

**Tactical remediation:** fail release preparation unless the intended Developer ID and notary credentials are present; sign nested code and the app; notarize the exact distributed app/DMG; staple; then run `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl --assess` against extracted final artifacts before upload.

**Strategic remediation:** make macOS signing/notarization an isolated provenance-producing CI job with ephemeral credentials and retain Apple submission IDs plus verification output in the canonical release descriptor.

**Required test:** packaged-app smoke on a clean macOS runner with quarantine attributes, launch verification, credential-store exercise, and updater install/relaunch.

# P1 findings — resolve before 1.0

## P1-01 — Disconnect and lock turn recoverable transfer work into terminal state omitted from recovery

**Confidence:** confirmed disconnect path; high for timing-dependent queue exhaustion.
**Affected code:** `src/app-events.ts` lock handler; `src/app-connection.ts::handleDisconnect`; `src/connection.ts::disconnect`; `src/transfers.ts::{buildQueueManifestJson,processQueue,runWorker}`; `src-tauri/src/s3.rs::disconnect`.

Lock explicitly disconnects first. Native disconnect closes registration, cancels and drains active operations, then invalidates the session. Frontend worker catches generally convert non-user cancellation into `status="error"`; workers can then claim queued items while registration/session shutdown is underway. The manifest retains only `queued`/`uploading` work, and active uploads are intentionally excluded. Recoverable downloads, copied moves, and never-started work can therefore become terminal UI errors and disappear from the next-start manifest.

**Fix:** introduce a lifecycle reason (`user_cancel`, `pause`, `disconnect`, `lock`, `shutdown`, `fatal`) and transition disconnect/lock work back to durable paused/blocked state before native cancellation. Persist the critical snapshot, then drain. Preserve active uploads as “interrupted; manual retry required” records even if byte resume is unsupported. **Milestone:** first 30 days.

## P1-02 — Multipart memory limits are per transfer rather than process-wide

**Confidence:** confirmed.
**Affected code:** `src-tauri/src/s3.rs::{MAX_UPLOAD_INFLIGHT_BYTES,MAX_DOWNLOAD_INFLIGHT_BYTES,upload_object,upload_multipart,download_object_parallel}`; `src/settings-model.ts::{maxConcurrentTransfers,uploadPartConcurrency,downloadPartConcurrency}`.

Each upload independently clamps buffered parts to 256 MiB. With the default three transfer workers, uploads alone can retain roughly 768 MiB, and the maximum ten workers can approach 2.5 GiB before SDK buffers, checksums, UI state, downloads, and process overhead. Downloads have the same per-transfer pattern.

**Fix:** add one weighted process-wide semaphore covering upload buffers, download ranges, previews, and browser-byte fallback. Reserve bytes before allocation, release on every path, expose pressure in diagnostics, and lower concurrency dynamically. Add peak-RSS benchmarks for default and maximum settings. **Milestone:** first 30 days.

## P1-03 — Parallel-download resume trusts retained local ranges based on file length and checkpoint bits

**Confidence:** confirmed.
**Affected code:** `src-tauri/src/s3.rs::download_object_parallel`; `src/settings-model.ts::SETTING_DEFAULTS.enableTransferChecksumVerification`.

Remote generation pinning is strong: version ID or ETag is required. Local resume safety is weaker. If scratch length, checkpoint identity, generation, total bytes, and part size match, `completed_parts` ranges are accepted without rehashing them. A same-length corrupted, tampered, stale, or misdirected scratch region is retained. End-to-end checksum verification defaults to false, and many S3-compatible objects do not carry the app’s checksum metadata.

**Fix:** persist a digest for every completed range and verify it before reuse; otherwise redownload that range. Enable end-to-end verification by default where a trustworthy remote checksum exists, and clearly label the residual when it does not. Bind scratch identity to the ownership capability from P0-APP-03. **Milestone:** first 30–60 days.

## P1-04 — Startup migration recovery failure does not place the application in a recovery-only mode

**Confidence:** confirmed behavior, medium-to-high impact.
**Affected code:** `src-tauri/src/main.rs` Tauri `setup` and `invoke_handler`; `src-tauri/src/security.rs` migration recovery latch.

Startup logs migration recovery failure and latches protected storage so protected I/O fails closed, which is a strength. It still registers the full command surface and launches the normal application. Users can perform unrelated S3 mutations while local security/recovery is unresolved, and the only startup signal may be stderr.

**Fix:** expose an explicit startup health state and show a recovery-only UI when migration/journal recovery fails. Permit diagnostics, retry, export-safe recovery information, and an explicitly confirmed reset—nothing else. Keep the native command gate authoritative. **Milestone:** first 30 days.

## P1-05 — Copy commit-response loss can leave destinations outside transaction receipts

**Confidence:** high; distributed outcome depends on provider/network timing.
**Affected code:** `src-tauri/src/s3.rs::{copy_one,copy_object_multipart,copy_with_receipt,copy_prefix_objects}`.

A CopyObject or CompleteMultipartUpload can commit remotely while the response is lost. Without a response ETag/version ID, current code correctly refuses to invent an identity, but the destination may exist without entering `created_destinations`/receipts. Prefix rollback cannot safely remove it, and retry may conflict or duplicate intent.

**Fix:** durably record operation intent before send, include an operation marker where provider metadata semantics permit it, and reconcile exact versions after ambiguous outcomes. On unversioned providers where ownership cannot be proven, retain source and present a first-class “remote outcome unknown” recovery workflow rather than a generic error. **Milestone:** first 30–60 days.

## P1-06 — Copy/move and metadata editing do not define complete Object Lock and legacy expiration semantics

**Confidence:** confirmed omissions; provider impact varies.
**Affected code:** `src-tauri/src/s3.rs::{SourceObjectInfo,source_info_from_head,describe_source,update_metadata,copy_one,copy_object_multipart}`.

`SourceObjectInfo` preserves many headers, ACL inference, tags, storage class, and encryption, but has no Object Lock mode/retain-until/legal-hold fields. `Expires` is explicitly omitted. Large multipart copies must restate destination attributes, so copy/move/metadata update can produce an object with materially different governance or cache semantics. Source deletion may then fail due retention, leaving a confusing partial move, or may eventually remove the only object with the intended policy.

**Fix:** document a precise preservation matrix per operation/provider. Read and restate retention/legal hold and supported expiration values, or refuse move/metadata update when they cannot be preserved. Require explicit permissions and test locked/versioned buckets. **Milestone:** before 1.0 provider-support declaration.

## P1-07 — In-place metadata update lacks a destination-current compare-and-set, especially at multipart completion

**Confidence:** high.
**Affected code:** `src-tauri/src/s3.rs::update_metadata` and `copy_object_multipart`.

Source `copy_source_if_match` guards the generation read by each copy request. For objects above the single-copy threshold, multipart parts can be copied from the original generation while a concurrent writer publishes a newer current object; final multipart completion can then replace that newer destination with the older bytes plus edited metadata. There is no destination-current condition spanning the multipart transaction.

**Fix:** acquire the same keyspace lease as P0-APP-01 for app-owned writers, pin an exact version where possible, recheck current destination immediately before completion, and abort if it changed. State clearly that external atomic metadata CAS cannot be guaranteed on unversioned endpoints lacking conditional completion. **Milestone:** first 30–60 days.

## P1-08 — Windows biometric deletion can report absence when Credential Manager is merely unreachable

**Confidence:** confirmed code, platform behavior requires Windows validation.
**Affected code:** `src-tauri/src/biometric.rs` Windows `store_key`, `remove_key`, and `has_stored_key`.

`remove_key` ignores `CredDeleteW` errors. `has_stored_key` maps both “not found” and `ERROR_NO_SUCH_LOGON_SESSION` to false, so disable/reset can appear to remove a key when the credential store is unavailable and the enterprise-persistent credential may become readable in a later session. `CRED_PERSIST_ENTERPRISE` also broadens persistence beyond a local-session expectation.

**Fix:** distinguish absent, deleted, inaccessible/unknown, and still present. Do not commit “biometric disabled” after unknown deletion without a durable pending-cleanup record and retry. Reassess local-machine versus enterprise persistence. Validate local console, RDP, service/headless, account switch, and reboot cases. **Milestone:** first 30 days on Windows.

## P1-09 — Release hosts prove themselves independently but are not bound to one canonical cross-host source descriptor

**Confidence:** confirmed.
**Affected code:** `scripts/release-session.js`; `scripts/ensure-draft-release.cjs`; `scripts/gpg-sign.js`; `scripts/finalize-release-assets.js`.

A local release session records version, commit, platform, tool versions, lockfile hashes, and working-tree hash—good host-local evidence. Each machine creates/verifies its own session. The GitHub draft and uploaded assets do not require all hosts to present the same canonical descriptor, so artifacts built from differing uncommitted trees/toolchain resolutions can be assembled under one version.

**Fix:** generate one source descriptor from a clean tagged commit, including source archive digest, lockfiles, toolchain versions, expected targets, and release ID. Every host must consume and attest to that descriptor; final publication verifies all asset digests against it. **Milestone:** before next multi-host stable candidate.

## P1-10 — Release inputs still float and the supply-chain gate is incomplete

**Confidence:** confirmed.
**Affected code:** `rust-toolchain.toml`; `run.rosie.s3-sidekick.yml`; `.github/workflows/ci.yml`; `package.json`.

GitHub Actions are full-SHA pinned, but Rust uses `stable`; Flatpak runs live `curl | sh`, installs a floating npm 12 release by age, enables build networking, and resolves SDK extension content outside a checked source manifest. No Cargo advisory/license policy gate, SBOM, provenance/attestation, or package install/updater smoke gate was found.

**Fix:** pin Rust and bootstrap tool versions/content digests; vendor or predeclare Flatpak sources and disable build network; add `cargo deny`/equivalent advisory and license policy; produce CycloneDX/SPDX SBOMs and signed provenance; verify installation and update from the exact final artifacts. **Milestone:** before 1.0 RC.

## P1-11 — Copy/move completion is missing from transfer summaries and listing refresh ownership

**Confidence:** confirmed.
**Affected code:** `src/transfers.ts::{TransferRunSummary,processQueue}`; `src/app-events.ts` transfer completion handler.

The run summary tracks only upload/download attempts and counts. A run containing only copy/move can complete without invoking the same completion refresh path, leaving the object table stale and user feedback inconsistent.

**Fix:** include per-operation attempted/completed counts and affected source/destination locations. Coalesce refreshes by current connection/bucket/prefix generation; never refresh a superseding navigation. **Milestone:** first 30 days.

## P1-12 — Active uploads are deliberately erased from crash recovery history

**Confidence:** confirmed.
**Affected code:** `src/transfers.ts::{buildQueueManifestJson,isIncludedInQueueManifest}`.

Because uploads are not byte-resumable, active uploads are excluded from the durable manifest. Avoiding unsafe automatic restart is correct; erasing the record is not. After a crash, the user cannot distinguish completed, remotely ambiguous, interrupted, or never-started uploads.

**Fix:** persist an interruption record without a browser `File` capability or automatic-retry promise. File-path uploads can retain validated identity and require confirmation; browser-only uploads should become a visible unrecoverable item. Reconcile remote outcome before offering retry. **Milestone:** first 30–60 days.

# P2 findings — performance, UX, accessibility, and maintainability

<!-- prettier-ignore -->
| ID | Finding and evidence | Recommended action | Target |
|---|---|---|---|
| P2-01 | Retry backoff uses an uncancellable `setTimeout` in `src/transfers.ts::{delay,runItemWithRetry}`. It occupies a worker slot and cancel waits until the timer ends. | Use an abortable scheduler; release the worker during delayed retry or manage retries in a priority queue. | 30–60 days |
| P2-02 | `src/browser.ts::renderObjectTable` filters/sorts all loaded rows and replaces `tbody.innerHTML`; no virtualization/windowing is present. | Introduce keyed incremental rendering and row virtualization; benchmark 10k/50k/100k entries, filter latency, selection, and memory. | 60 days |
| P2-03 | `src/browser.ts::updateSelectionUI` always calls `syncInspectorFromSelection`; table repaint ends in `updateSelectionUI`, so routine renders can refetch preview/properties. | Separate visual selection repaint from semantic selection changes; cache inspector requests by connection/bucket/key/version. | 30 days |
| P2-04 | Mobile `src/inspector.ts::setInspectorOpen` shows a backdrop but does not provide dialog semantics, focus entry/return, focus trap, or background inertness. | Implement one modal-layer controller shared with dialogs/drawers; add keyboard and screen-reader tests. | Before 1.0 |
| P2-05 | `src/transfers.ts::updateQueueChrome` updates `#transfer-queue-summary` on animation-frame progress; `src/index.html` marks it `aria-live="polite"`. | Keep visual throughput updates separate from a debounced semantic live region announcing only state transitions or coarse milestones. | 30 days |
| P2-06 | `src/dialogs.ts::shakeDialogBox` provides animation-only validation feedback and ignores reduced-motion preference. | Add inline `role="alert"` error text, `aria-invalid`/description, and suppress movement under `prefers-reduced-motion`. | 30 days |
| P2-07 | `.setup-wizard-card` sets `overflow-y:auto` and then overrides it with `overflow:hidden` in `src/styles/setup-wizard.css`. | Keep vertical scrolling, constrain decorative clipping to an inner wrapper, and test small/zoomed viewports. | Immediate polish |
| P2-08 | `src/app-objects.ts::handleDelete` has no in-flight guard/button disable; repeated activation can launch duplicate confirmed deletes. `src/settings.ts::saveSettings` similarly has no serialization/version check. | Add single-flight guards, disable/relabel controls, snapshot mutation generations, and coalesce settings saves. | 30 days |
| P2-09 | Raw absolute paths cross the webview/native boundary and are validated before later path-based open/write. Parent/symlink checks reduce risk but leave pathname TOCTOU; upload files can change after validation. | Under the trusted-webview threat model, classify as defense in depth. Move to picker-issued capabilities/handles, no-follow opens, stable file IDs, and final identity checks. | 60–90 days |
| P2-10 | Rust command names, arguments, DTOs, events, phases, and structured errors are manually mirrored in TypeScript. | Generate TypeScript bindings and schemas from Rust, validate event payload versions, and make unknown error codes explicit. | 60 days |
| P2-11 | `src-tauri/src/s3.rs` exceeds 7,200 lines and `src/transfers.ts` exceeds 3,000; S3 transport is not injectable at the operation boundary. | Split by domain: provider capabilities, object CRUD, multipart, move transactions, downloads/checkpoints, transfer state machine, queue UI. Inject a transport trait and clock/fault scheduler. | 60–90 days |
| P2-12 | Diagnostics are mostly in-memory human strings without durable correlation across frontend, native commands, retries, provider request IDs, recovery sessions, and release operations. | Add opt-in persistent structured, redacted diagnostics with correlation/transaction IDs, bounded retention, export, and a documented secret-scrubbing policy. | Before 1.0 RC |

# Assurance and observability matrix

<!-- prettier-ignore -->
| Boundary | Current static evidence | Missing proof required for 1.0 |
|---|---|---|
| Frontend logic | Broad Vitest/jsdom suite with navigation, transfer, security, settings, keyboard, inspector, and integration-style modules. | Real browser/webview focus, accessibility tree, drag/drop, file picker capability, long-list performance, process reload, and Tauri IPC behavior. |
| Native logic | Extensive in-module Rust tests and strong fail-closed helper design. | Injectable S3 transport, deterministic network faults, real async transaction interleavings, property tests for state transitions, and process-kill failpoints. |
| S3 protocols | Provider capability table and hostname-bound detection in code. | Contract suite against AWS S3 plus supported versions of R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces, and a deliberately incomplete generic endpoint. |
| Data recovery | Atomic writes, parent sync, recovery sessions, checkpoint validation, migration journal controls. | Crash/power-loss at every durable transition; corruption/truncation; old-version migrations; interrupted copy rollback; ambiguous remote commits. |
| Filesystems | Symlink checks, durable publication, hard-link create-new safety, scratch ownership concepts. | APFS, NTFS, ext4, exFAT/FAT, SMB/NFS/cloud-synced folders, permission changes, case folding, long paths, low disk, rename/hard-link capability matrix. |
| Credential stores | Platform-specific implementations and unit-level control flow. | macOS Keychain prompts/lock states, Windows Hello + Credential Manager console/RDP/session changes, Linux keyring/secret-service availability, reset and migration under failure. |
| Packaging | Tauri builds and artifact scripts; Windows signing helpers exist. | Install/uninstall/upgrade, first launch under quarantine/SmartScreen/Gatekeeper, code-signature verification, updater download/install/relaunch/rollback, package-manager behavior. |
| Performance | Concurrency and part-size controls; frame-coalesced transfer rendering. | Peak RSS, CPU, listing/filter latency, 10k-transfer queue behavior, 100k-object browser behavior, slow disk/network, and cancellation-latency budgets. |
| Accessibility | Semantic labels/live regions and keyboard tests exist. | Automated axe/accessibility-tree gate plus VoiceOver/NVDA/keyboard-only workflows at 200–400% zoom and reduced motion. |
| Release integrity | Host-local source/lock digests, signatures/checksums, full-SHA Actions. | Canonical cross-host descriptor, immutable release state, SBOM/provenance, public-download verification, and channel atomicity. |

## Minimum production-boundary test program

1. **Mock S3 protocol suite:** scripted responses for throttling, 403/404 ambiguity, repeated pagination tokens, range ignored, ETag/version changes, lost commit responses, multipart abort failures, and conditional-write capability mismatch.
2. **Live provider nightly/manual suite:** least-privilege temporary buckets on every advertised provider; object/prefix copy/move, metadata, tags/ACLs, versioning, Object Lock where supported, multipart thresholds, Unicode keys, cancellation, and cleanup verification.
3. **Crash matrix:** kill the process before/after each checkpoint, receipt write, source delete, manifest clear, migration journal step, scratch lease, and final rename. Restart and assert one understandable recovery state.
4. **Packaged desktop matrix:** clean VMs for Windows/macOS/Linux, install, launch, connect to a disposable endpoint, transfer, lock/unlock, update, relaunch, and uninstall without residue beyond documented user data.
5. **Performance budgets:** p95 UI input latency, listing render/filter time, transfer progress cost, cancel latency, throughput, peak RSS, and disk overhead at default and maximum concurrency.
6. **Accessibility gate:** static rules plus manual assistive-technology scripts for connection, navigation, transfer conflicts, settings, inspector, dialogs, and setup.

## Diagnostics needed to make failures supportable

A stability claim requires knowing which invariant failed without collecting secrets. Add a shared correlation model containing: app version/build descriptor, platform, provider class, connection-session hash (not endpoint/credentials), operation/transfer/transaction ID, bucket/key salted hashes or user-approved plaintext export, state transition, attempt, S3 status/error code/request ID, bytes/parts, checkpoint/receipt IDs, and recovery outcome. Redact authorization headers, credentials, presigned query strings, local usernames/paths, metadata values, and object content. Keep a bounded encrypted local ring and let the user preview/export it.

# Provider and platform residual risks

These cannot be closed by static review and should remain explicit even after code fixes.

- **AWS S3:** strongest versioning/Object Lock/conditional semantics, but external writers still prevent true multi-object move atomicity. Versioning should be the recommended safety mode.
- **Cloudflare R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces:** advertised create-only behavior is encoded from provider expectations, not continuously proven against live versions. Multipart conditional completion and metadata/ACL/tag behavior are the highest-risk compatibility points.
- **Generic S3 endpoints:** fail-closed behavior is preferable to silent overwrite. The UI must explain unsupported atomic guarantees and never turn a failed capability probe into overwrite permission.
- **Windows:** credential session behavior, NTFS sharing/deletion, long paths, SmartScreen, Authenticode, and ARM64 require packaged validation.
- **macOS:** Keychain prompts, APFS publication semantics, quarantine, universal-binary nested signatures, notarization, stapling, and Gatekeeper require final-artifact validation.
- **Linux:** Flatpak sandbox portals, package-manager updates, keyring availability, AppImage updater behavior, Wayland/X11, and distro WebKit variance require runtime coverage.
- **Non-local filesystems:** hard-link/rename guarantees, durability, sparse files, locking, case behavior, and symlink/reparse semantics vary. Detect capabilities and degrade explicitly rather than silently selecting weaker publication.

# Strengths and rejected findings

The audit intentionally preserved the following as strengths or rejected false positives:

- `.npmrc` `min-release-age=3` is correct for npm 12 because the unit is days; converting it to seconds would be wrong.
- Copy identity now uses a response ETag or an exact response-owned version HEAD and fails closed when operation-owned identity is unavailable. Earlier reports about inheriting an ordinary concurrent HEAD are superseded by the current code.
- Hard-link create-new publication is safe where supported; the remaining issue is filesystem compatibility, not an unsafe check-then-rename fallback.
- Listing, pagination, connection, and navigation generations prevent stale async results from committing into superseding UI state.
- Move source deletion requires durable receipts and verifies destination/source identities. P0-APP-01 is the narrower inter-transaction time-of-check/time-of-delete window, not a claim that receipts are absent.
- Factory reset rotates the recovery session and closes legacy import, fencing stale webviews from republishing old recovery state.
- Current atomic local writes sync the file and parent directory, materially improving crash durability.
- GitHub Actions are full-SHA pinned, and GitHub token variables are stripped from `gh` child environments.
- Prefix operations detect abandoned rollback namespaces and retain backups when safe ownership cannot be proven.
- Failed conflict probes are treated as conflicts rather than permission to overwrite.

# 30/60/90-day remediation roadmap

## Days 0–7: freeze unsafe publication paths

- Fix P0-REL-01 through P0-REL-04 before uploading another build.
- Add temporary release assertions: draft-only mutation, no `--clobber`, no channel sync from a draft, clean canonical commit, secret-free build environment, and mandatory platform signature verification.
- Add app-level mitigation while native keyspace leases are built: prevent the queue from starting overlapping source/destination keys or prefixes and prevent duplicate download destinations.
- Patch copied-phase recovery so it bypasses conflict handling and retains receipts on every nonterminal outcome.

## Days 8–30: close data/recovery races

- Implement native ordered keyspace leases and ownership-checked download capabilities.
- Introduce explicit transfer transition reasons and make disconnect/lock a persist-then-pause workflow.
- Add process-wide weighted memory admission.
- Add per-range resume digests and retained-scratch validation.
- Add startup recovery-only mode and Windows credential deletion states.
- Extend completion summaries to copy/move and add single-flight destructive/settings actions.
- Build deterministic mock transport tests for every P0 sequence.

## Days 31–60: establish 1.0 protocol and release assurance

- Define and implement the S3 attribute-preservation matrix, including Object Lock and expiration behavior.
- Add metadata-update destination generation checks and ambiguous-commit recovery.
- Create the canonical release descriptor, per-host attestations, immutable asset map, SBOM, provenance, and advisory/license gates.
- Run live-provider compatibility tests and packaged Windows/macOS/Linux smoke tests.
- Virtualize large listings, separate semantic inspector updates from repaint, and make retry scheduling abortable.

## Days 61–90: reduce systemic change risk

- Decompose `s3.rs` and `transfers.ts` around explicit domain boundaries and inject transport/clock/fault interfaces.
- Generate IPC/event/error contracts between Rust and TypeScript.
- Add persistent redacted diagnostics and support export.
- Establish performance budgets and accessibility gates.
- Run repeated process-kill, low-disk, corrupted-state, filesystem-matrix, installer, and updater campaigns until recovery outcomes are deterministic and documented.

# Pre-1.0 exit criteria

Do not label the application 1.0 until all of the following are demonstrably true:

- [ ] All P0 findings have regression tests at the production boundary, not only helper-level unit tests.
- [ ] Overlapping app-owned copy/move operations are serializable or rejected before remote mutation.
- [ ] Every durable transfer state has one documented crash, disconnect, lock, cancellation, and retry transition.
- [ ] A copied move can never lose receipts except through verified completion or explicit user abandonment.
- [ ] Process-wide memory stays within a documented budget at maximum settings.
- [ ] Resumed ranges have local integrity evidence, and ambiguous remote commits have a visible recovery state.
- [ ] The supported S3 attribute/provider matrix is tested and published.
- [ ] Every release asset maps to one canonical source descriptor and published releases are immutable.
- [ ] Windows/macOS artifacts pass native trust verification; Linux packages install and update through their supported path.
- [ ] Beta/stable channel changes are atomic and never point at draft or missing assets.
- [ ] Build dependencies cannot read release signing/publishing secrets.
- [ ] Crash/power-loss, filesystem, credential-store, packaged-app, updater, accessibility, and performance matrices have passing evidence.
- [ ] Users can export correlated, redacted diagnostics for any failed invariant.

## Final assessment

The repository is in a strong late-beta position, not a rewrite situation. Most of the hard safety primitives already exist; the highest-value work is to connect them with explicit transaction ownership, durable state transitions, immutable publication, and production-boundary tests. Resolve the seven publication blockers first, then use the 1.0 milestone to formalize provider semantics and prove the app under crash, package, credential-store, and high-load conditions. Refactoring should follow those invariants—not precede them—so current safety behavior remains preserved while the oversized modules are decomposed.
