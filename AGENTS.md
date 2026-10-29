# Critical Information - Do not modify
- NEVER write unit tests after you write code. 
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact. 
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code. 

# Repository working agreement

The section above governs the order in which new tests are authored. It does
not permit skipping or deleting the existing suites that CI enforces.

## Testing is a merge gate

`npm run test:all` runs typecheck, lint, Prettier, Cargo update policy checks,
Tauri alignment, Clippy, `cargo fmt --check`, the frontend build, a native
release build, a Tauri no-bundle build, script tests, Vitest with coverage
floors, and the Rust test suite. CI also runs Playwright, the MinIO command
layer suite, the full-stack WebDriver suite, and the move/release safety
checks. A red job blocks the quality gate.

When changing behavior:

1. Write the failing E2E or failure-mode inventory first when a new failure
   mode exists.
2. Run the narrowest relevant suite while iterating.
3. Run `npm run test:all` before declaring the change ready.
4. Keep the report under `test-results/`; it is the repeatable artifact.

Do not replace an existing unit test with a hand-written manual check. Unit
tests are appropriate for pure logic, parsers, and failure paths that the E2E
layers cannot reach; write those tests before the implementation.

## Architecture boundaries

- The webview owns presentation state. Rust owns S3 clients, credentials,
  filesystem access, transfer checkpoints, and vault migration.
- Every S3 command requires the connection session ID minted by the current
  `connect()`. Never accept a renderer-supplied session ID as authority.
- Webview-to-native calls go through `src/ipc.ts`. Do not import or call the
  raw Tauri `invoke`.
- Filesystem destinations are backend-derived or backend-validated. Do not
  add a command that lets the webview name an arbitrary scratch path.
- Move authority is limited to providers with verified `DeleteObject If-Match`
  behavior. Do not widen the matrix without an E2E contract test against the
  real provider.
- Receipts and transfer identity checks fail closed. A missing fingerprint,
  malformed receipt, or changed generation must retain the source.

## Change discipline

- Read `docs/ARCHITECTURE.md` before changing transfer, vault, IPC, or release
  behavior. It is the current source of truth.
- Keep the existing file style: named exports, typed IPC arguments, no raw
  `unwrap`/`expect`/`panic` in production Rust, and no `as any` or `ts-ignore`
  in `src/`.
- Prefer a narrow fix at the responsible layer over a broad rewrite.
- Do not commit generated artifacts, `node_modules`, `target`, `dist`, local
  reports, or secrets. `.env` stays ignored.
- Version changes flow through `npm run sync-version`; do not hand-edit one
  version surface and leave the others stale.

## Release work

- Stable releases run from `main`; beta releases run from `beta`. Release
  preflight requires a clean, pushed checkout. It does not check the CI
  workflow for the commit.
- `npm run release:prepare` is a real quality gate. Do not add `--skip-e2e`
  or equivalent flags that make the gate look stricter than it is.
- Signed builds remain a manual per-host step. CI compiles the unsigned
  Windows arm64, macOS universal, and Flatpak targets so toolchain breaks are
  found before a release VM is spent.
- Never treat a local JSON report as publication authority. Draft and
  published release verification re-check the uploaded bytes and signatures.

## Documentation

- User-facing security limitations belong in the settings UI, not only in a
  source comment.
- Keep `README.md` version text synchronized by `scripts/sync-version.js`.
- Record durable design decisions in `docs/ARCHITECTURE.md`; keep the release
  runbook in `docs/RELEASE.md`.
