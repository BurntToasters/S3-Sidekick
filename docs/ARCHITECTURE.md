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

## Preview policy

Preview responses are capped at 1 MiB and are streamed with a hard one-byte overflow check. Text detection ignores parameters such as `; charset=utf-8` and recognizes `text/*`, JSON, XML, JavaScript, SVG, YAML, and TOML. Other content is offered as a download rather than rendered as text.

## Vault and biometric storage

Saved connection data, bookmarks, transfer manifests, and checkpoints follow the vault encryption state. Migrations use a journal and an exclusive storage gate so a rekey/reset cannot race transfer checkpoint I/O. Biometric unlock currently gates access through the OS credential store as defense in depth; it is not a hardware-bound Secure Enclave or Windows Hello key.

## Update modes

AppImage builds use the native updater. Flatpak, DEB, and RPM installations use the release page or package manager because replacing package-managed files through the native updater is unsafe. Updater manifests contain Minisign signatures verified against the public key configured in `src-tauri/tauri.conf.json` before release upload.

The frontend unit suite enforces global coverage floors for lines, functions, statements, and branches. Native Tauri/WebDriver behavior still requires the signed desktop build matrix because it depends on OS credential stores, windowing, and real provider responses.
