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

Review both lockfile diffs before committing. Push the update branch and let GitHub-hosted CI perform code-executing validation. CI installs npm packages with lifecycle scripts disabled, verifies registry signatures, and only then runs dependency code. CI is intentionally the first environment that installs or executes newly selected dependency code.

Do not run `npm run workspace:prepare`, `npm run test:all`, Cargo checks, builds, or tests on a workstation immediately after updating locks. Those commands execute dependency code. If local validation is necessary, use a disposable VM with no credentials, mounted home directory, SSH agent, signing keys, cloud metadata access, or persistent package caches.

The three-day delay reduces exposure to newly published supply-chain attacks; it cannot prove that an older package is benign. Emergency young-crate and Git overrides must name one exact version or revision and include a written reason.

`scripts/cargo-safe-update.mjs` and `scripts/check-cargo-update-policy.mjs` are a temporary stand-in for a minimum publish age in Cargo itself. Remove both (and restore direct `cargo update` call sites) once the supported stable Cargo ships a global minimum publish age.
