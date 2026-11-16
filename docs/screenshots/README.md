# AppStream screenshots

Capture version: 0.13.0-beta.1
Captured: 2026-11-14

| File                 | Viewport | Source state                     |
| -------------------- | -------- | -------------------------------- |
| `browse-light.png`   | 1280x800 | object listing, light theme      |
| `inspector-dark.png` | 1440x800 | text preview docked, dark theme  |
| `settings-dark.png`  | 1280x800 | Settings / Transfers, dark theme |

The AppStream metadata points at `main` for stable versions and at the
`next-X.Y.0` branch for beta versions, because that branch is the first to
contain newly captured files. `npm run sync-version` rewrites the branch
segment and `scripts/screenshots.test.js` enforces it.

## Regenerate

```sh
npm run screenshots
```

`scripts/screenshots.mjs` runs the Chromium visual tour, checks each capture
against the sizes in `run.rosie.s3-sidekick.metainfo.xml`, copies the three
files here, and rewrites the capture version and date above. If the tour fails
or a size differs, nothing in this directory changes. The run writes
`test-results/screenshots/report.json` and keeps its Playwright report there
too, so the quality gate's `test-results/playwright-report.json` is untouched.

The visual tour freezes the clock and disables animations, so the copies are
repeatable. If a viewport changes, update the sizes in the metainfo file in the
same change. `scripts/screenshots.test.js` fails when the capture version
falls behind the app's major/minor version, when an AppStream URL points at a
branch that does not contain the file, or when an image size differs from the
metadata.
