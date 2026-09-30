# Architecture and Security

## Versioning

S3 Sidekick follows semantic versioning. Stable releases use `X.Y.Z`; pre-releases use `X.Y.Z-beta.N` or another explicit pre-release identifier. Release proof binds the tested working tree, commit, lockfiles, platform, and toolchain.

## Storage flow

The webview owns presentation state and sends named commands through Tauri. The Rust backend owns S3 clients, credentials, filesystem access, transfer checkpoints, and vault migration. Connection and listing generations prevent late async responses from changing a newer destination.

## Transfer integrity

Uploads use S3 checksums when enabled. Large downloads use range requests pinned to an object version ID, or to an ETag when version IDs are unavailable. Resume checkpoints retain that identity and are rejected when the object generation changes. Copy receipts record source and destination ETags/version IDs plus canonical source HEAD, ACL-grant, and raw-tag fingerprints. Supported empty ACL/tag state is fingerprinted differently from a provider that explicitly reports the feature unsupported; ordinary read failures fail closed. Receipt-producing copies collect all three source fingerprints even for small objects.

Automatic moves require every selected source HEAD to expose a nonempty, non-`null` immutable version ID. While holding the app-local source/destination mutation lease, a single-object move preflights its source before copying; a prefix move paginates and validates the complete bounded source set before the first destination or rollback-backup mutation. Execution copies the exact preflighted versions, so a later external version cannot silently replace the selected bytes. Unversioned objects remain supported for ordinary copies, downloads, and other non-deleting operations, but automatic move refusal leaves every destination unchanged.

A move persists only complete version 6 receipts. Version 1-5 copied markers and malformed version 6 receipts lose copied authority and must copy again. After reacquiring one mutation lease for the complete receipt set, the backend rejects missing fingerprints, verifies every destination, and re-reads every present source's exact version plus current HEAD, ACL, and tags before deleting any source. This is an app-local guarantee: overlapping S3 Sidekick mutations cannot enter the leased keyspace between that preflight and deletion, and any failed preflight preserves the full source set. Source retirement writes a recoverable delete marker rather than permanently erasing the copied version.

Every S3 command requires the backend-minted connection session ID from the current `connect()` call. Transfer records persist that session ID plus a fingerprint of endpoint and access key. After reconnect or restart, a transfer whose fingerprint does not match the current account is refused rather than running against a different set of credentials.

ETags are provider-defined object identities, not universal content hashes. An external writer is outside S3 Sidekick's process-local lease, so deletion still rechecks both the exact copied version and the current key immediately before every source delete. If a newer version became current, deletion fails closed. Versioning keeps the copied generation recoverable even after a successful move.

Prefix copy and move operations first build a complete, duplicate-free, paginated source plan within the bounded object limit. Move plans additionally bind every source to an immutable version before destination mutation; ordinary copy plans retain unversioned compatibility. Destination updates remain rollback-protected, and prefix moves retain version 6 receipts so source deletion can be resumed safely.

## IPC contract and access control

`src-tauri/src/ipc_contract.rs` generates `src/generated/ipc-contract.ts` from every command registered in `generate_handler!`: the command name and its argument keys (camelCased, as Tauri reads them), types, and optionality. A Rust test fails when the checked-in file drifts. The webview calls native commands only through `src/ipc.ts`, whose `invoke` is typed against that contract (ESLint forbids importing the raw `invoke`). The Playwright mock backend is typed against the same command set.

`build.rs` declares an app manifest, so every app command gets an `allow-<command>` permission that only `capabilities/default.json` grants, through the permission sets in `permissions/app.toml`, and only to the `main` window. `src/ipc_acl.rs` runs Tauri's own access check against the real capabilities: every registered command is allowed for `main`; unknown commands and other windows are denied; and the build.rs list must equal the registered list.

## Cancellation and transfer state

A transfer registers with the backend (`TransferGuard`) before it waits for the storage gate, so pause and cancel reach it at any point. A `cancel_transfer` that arrives before registration is kept for 30 seconds (at most 4,096 entries) and cancels the next command with that ID. The frontend treats the resulting cancellation as the pause it came from (`pauseCancelInFlight`), not as a failure.

Queue rows change status only through the named transitions in `src/transfer-state.ts`, checked against a table of legal moves (`queued → uploading → done`, with side exits to `error`, `skipped`, and back to `queued`). An illegal move throws in development and tests. The queue loop and the worker claim share one `isClaimable` predicate and one `queueHeld` predicate, so the loop never spins on work that nothing may claim.

## Create-only retries

A create-only write can commit while its response is lost; the SDK retry then gets 412 against its own object. Uploads recognise their own write by size plus the SHA-256 ownership marker in metadata. Single-part copies accept a destination with the source ETag, and multipart copies accept a consumed upload ID. Both copy cases bind the destination with an unversioned HEAD, which could equally be an identical object from another client, so the receipt is marked ownership-ambiguous and rollback keeps that object (and reports it) instead of deleting it.

## Lock order

Synchronous locks are taken in one global order, outer to inner: the storage gate and `STORAGE_OP_LOCK` (`lock_storage_meta`, `lock_storage_ops`), the cross-process vault file lock, the S3 session state, then the vault key. `src/lock_order.rs` checks this order in debug builds (every test run) and costs nothing in release builds. The async S3 mutation leases are awaited, never held under these locks, and are not ranked.

## Auto-lock

The backend expires the vault key lazily. The webview polls the vault state and, when an inactivity timeout has locked it, disconnects the session and clears decrypted credentials and bookmarks from memory. Pointer and keyboard input count as activity, and so do running transfers: the timeout starts once the queue is idle, so an unattended transfer is never interrupted.

## Testing layers

End-to-end suites are the primary evidence and each writes a repeatable report under `test-results/`: Playwright drives the production webview against a mock backend typed by the IPC contract (`npm run test:ui`); the MinIO suite runs the Rust S3 command layer against a real server (`npm run test:e2e:minio`, in CI); script suites cover release and dependency tooling (`tests/scripts/`). Unit suites (Vitest for the webview, `cargo test` for Rust) cover pure logic and failure paths that the end-to-end layers cannot reach.

## Preview policy

Preview responses are capped at 1 MiB and are streamed with a hard one-byte overflow check. Text detection ignores parameters such as `; charset=utf-8` and recognizes `text/*`, JSON, XML, JavaScript, SVG, YAML, and TOML. Other content is offered as a download rather than rendered as text.

## Vault and biometric storage

Saved connection data, bookmarks, transfer manifests, and checkpoints follow the vault encryption state. Migrations use a journal and an exclusive storage gate so a rekey/reset cannot race transfer checkpoint I/O. Biometric unlock currently gates access through the OS credential store as defense in depth; it is not a hardware-bound Secure Enclave or Windows Hello key.

## Update modes

AppImage builds use the native updater. Flatpak, DEB, and RPM installations use the release page or package manager because replacing package-managed files through the native updater is unsafe. Updater manifests contain Minisign signatures verified against the public key configured in `src-tauri/tauri.conf.json` before release upload.

The frontend unit suite enforces global coverage floors for lines, functions, statements, and branches. Native Tauri/WebDriver behavior still requires the signed desktop build matrix because it depends on OS credential stores, windowing, and real provider responses.
