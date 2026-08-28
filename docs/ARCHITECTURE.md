# Architecture and Security

## Versioning

S3 Sidekick follows semantic versioning. Stable releases use `X.Y.Z`; pre-releases use `X.Y.Z-beta.N` or another explicit pre-release identifier. Release proof binds the tested working tree, commit, lockfiles, platform, and toolchain.

## Storage flow

The webview owns presentation state and sends named commands through Tauri. The Rust backend owns S3 clients, credentials, filesystem access, transfer checkpoints, and vault migration. Connection and listing generations prevent late async responses from changing a newer destination.

## Transfer integrity

Uploads use S3 checksums when enabled. Large downloads use range requests pinned to an object version ID, or to an ETag when version IDs are unavailable. Resume checkpoints retain that identity and are rejected when the object generation changes. Copy and move receipts record source and destination ETags and version IDs before a move deletes its source.

Every S3 command requires the backend-minted connection session ID from the current `connect()` call. Transfer records persist that session ID plus a fingerprint of endpoint and access key. After reconnect or restart, a transfer whose fingerprint does not match the current account is refused rather than running against a different set of credentials.

ETags are provider-defined object identities, not universal content hashes. On unversioned buckets, a same-content overwrite can retain an ETag; S3 `If-Match` on `DeleteObject` evaluates ETag only, so tag, ACL, or metadata-only writes between copy and delete cannot be excluded. Enable object versioning for safe moves. When identity cannot be confirmed, S3 Sidekick preserves the source and refuses deletion. Versioned buckets provide stronger generation identity.

Prefix copies process source listings page by page. Prefix moves retain receipt data so source deletion can be resumed safely; prefix transactions above the bounded object limit are refused before source deletion rather than allowing unbounded memory growth.

## Preview policy

Preview responses are capped at 1 MiB and are streamed with a hard one-byte overflow check. Text detection ignores parameters such as `; charset=utf-8` and recognizes `text/*`, JSON, XML, JavaScript, SVG, YAML, and TOML. Other content is offered as a download rather than rendered as text.

## Vault and biometric storage

Saved connection data, bookmarks, transfer manifests, and checkpoints follow the vault encryption state. Migrations use a journal and an exclusive storage gate so a rekey/reset cannot race transfer checkpoint I/O. Biometric unlock currently gates access through the OS credential store as defense in depth; it is not a hardware-bound Secure Enclave or Windows Hello key.

## Update modes

AppImage builds use the native updater. Flatpak, DEB, and RPM installations use the release page or package manager because replacing package-managed files through the native updater is unsafe. Updater manifests contain Minisign signatures verified against the public key configured in `src-tauri/tauri.conf.json` before release upload.

The frontend unit suite enforces global coverage floors for lines, functions, statements, and branches. Native Tauri/WebDriver behavior still requires the signed desktop build matrix because it depends on OS credential stores, windowing, and real provider responses.
