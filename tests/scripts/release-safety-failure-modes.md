# Release safety regression inventory

Written before implementation changes for the 0.11.1 audit fixes.

Release asset verification must reject missing or duplicate assets, unsafe filenames,
invalid or foreign-key GPG signatures, expired/revoked signatures, altered installer
bytes, signed but incorrect checksum entries, empty/malformed checksum manifests,
duplicate checksum entries, unknown/path-traversing checksum names, and manifests
that omit required installers or updater signature files. A correctly signed full
release matrix must pass draft and published verification. Public-key-only
verification must work without a signing passphrase. Temporary downloads must be
cleaned on failure. Downloading a large binary must not truncate it or decode it
as text. Signing subkeys must remain tied to the approved primary fingerprint.

Release preflight must accept canonical HTTPS and SSH origins, reject a fork or
non-GitHub origin even when its upstream/HEAD match, and reject noncanonical stable
release destination overrides. It must not fetch an origin that failed validation.
Beta checkouts may use their explicitly configured GitHub release destination.

The AWS-null-version runner must bound frontend build and Cargo execution, record
timeout/error status, preserve readable failure logs, clean its isolated app-data
directory, reject a missing/failed/malformed check artifact, and pass a complete
positive fixture. A stalled command must never turn into a successful report.

The script E2E fixtures use disposable files, generated signing keys, fake GitHub/Git
processes, and a copied production runner. They do not publish releases or modify
the real repository configuration. Their JSON reports record the fixture boundary.
