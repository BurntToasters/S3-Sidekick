# Dependency update safety

`npm run u` is a lockfile-only dependency proposal. It does not install npm packages, run npm lifecycle scripts, compile Rust, execute Cargo build scripts or procedural macros, format source files, or run tests.

The command requires Node.js `^24.18.0 || >=26.0.0`, npm 12.0.2 or newer, and an already-installed Rust stable toolchain. It performs these steps:

1. Resolve npm updates with `--package-lock-only`, `--ignore-scripts`, and a three-day minimum release age in a disposable npm cache.
2. Reject high-severity npm audit findings without populating the project `node_modules` directory.
3. Resolve Cargo updates through the local crates.io age-filter proxy in a disposable Cargo home.
4. Reject releases younger than 72 hours, unknown registries, unapproved Git revisions, concurrent lock edits, and unverifiable publication metadata.
5. Atomically install only the validated lockfile and remove temporary caches.
6. Check that the Tauri family is aligned (`npm run check:tauri-alignment`, also a `test:all` step): `tauri-runtime`/`tauri-runtime-wry` and the npm `@tauri-apps/api`/`@tauri-apps/cli` packages on the same minor line as the exact-pinned `tauri` crate, and every `@tauri-apps/plugin-*` on its Rust plugin's minor line. Semver alone lets Cargo pick a runtime that does not compile against the pinned `tauri`, and `tauri build` refuses mismatched npm packages. The check reads lockfiles only, so it runs no dependency code.

Move the Tauri family as one change: the Cargo.toml pins, `Cargo.lock`, and package.json together.

Both updaters serialize their own runs. npm rollback and final Cargo lock installation compare expected bytes, preserving a concurrent process's lockfile edit instead of overwriting it.

Review both lockfile diffs, then run `npm run test:all` locally before committing. Local validation is allowed right after a lock update. `test:all`, `npm run workspace:prepare`, and Cargo checks, builds, and tests run the newly selected dependency code (build scripts, procedural macros, and test binaries) on the workstation. The publish-age filter is the only guard before that code runs, so read the lock diff first. Push the update branch afterward; CI repeats the validation with npm lifecycle scripts disabled and registry signatures verified.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.

## October 2026 Cargo security remediation

`rustls` is a runtime dependency of the S3 SDK and updater, not a dev-only dependency. The lockfile selects 0.23.46 to fix RUSTSEC-2026-0346 through RUSTSEC-2026-0349. Resolve it with the age-filtered updater; no young-crate or advisory exception is needed.

The updater's default `zip` feature supports legacy Tauri v1 updater archives and pulls in Windows-only `zip` 4.6.1. Even the currently available updater 2.14.0 still requests zip 4, so a compatible lockfile update cannot select zip 9. Disable updater defaults and explicitly retain `rustls-tls` and `system-proxy` instead. This removes zip and RUSTSEC-2026-0367 through RUSTSEC-2026-0369 from the resolved graph on every target. Keep `bundle.createUpdaterArtifacts` set to `true`: our v2 Windows installers and Linux AppImages do not require legacy archive support; macOS `.app.tar.gz` support remains enabled independently. Legacy v1 updater archives are no longer accepted. See [Tauri updater artifact formats](https://v2.tauri.app/plugin/updater/#building).

No RustSec ignore list is added. The existing informational warnings for `proc-macro-error`, `zbus_names`, `zvariant`, `zvariant_derive`, and `glib` remain visible in the audit report. These come through the upstream Linux GTK/notification stack, not solely dev dependencies. Unmaintained warnings are maintenance risks; the glib unsoundness remains unresolved upstream in the selected GTK stack. They do not currently fail the audit gate and should not be described as fixed.

Run `npm run test:e2e:cargo-security` to resolve all target dependencies with `--locked`, confirm patched TLS and removal of zip, verify updater features/artifact configuration, and run the real RustSec scanner with no ignored advisories. This executes no dependency build scripts or procedural macros. The repeatable evidence is `test-results/cargo-security/report.json`, including the lockfile SHA-256, plus full Cargo metadata and audit JSON. CI runs this on Linux, Windows, and macOS and uploads the reports. Native builds and signed updater installation still need CI/platform validation; this security check does not certify those flows.

`scripts/cargo-safe-update.mjs` and `scripts/check-cargo-update-policy.mjs` are a temporary stand-in for a minimum publish age in Cargo itself. Remove both (and restore direct `cargo update` call sites) once the supported stable Cargo ships a global minimum publish age.
