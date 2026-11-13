# AppStream screenshots

Capture version: 0.12.0-beta.2
Captured: 2026-11-12

| File                 | Viewport | Source state                     |
| -------------------- | -------- | -------------------------------- |
| `browse-light.png`   | 1280x800 | object listing, light theme      |
| `inspector-dark.png` | 1440x800 | text preview docked, dark theme  |
| `settings-dark.png`  | 1280x800 | Settings / Transfers, dark theme |

The AppStream metadata points at `next-0.12.0` because that is the first branch
that contains these files. Point it at `main` only after the 0.12.0 merge.

## Regenerate

```sh
npx playwright test tests/browser/ux-visual-tour.spec.ts --project=chromium
cp test-results/ux-visual-tour/chromium/current/light/browse-1280x800.png docs/screenshots/browse-light.png
cp test-results/ux-visual-tour/chromium/current/dark/inspector-preview-text-docked.png docs/screenshots/inspector-dark.png
cp test-results/ux-visual-tour/chromium/current/dark/settings-transfers.png docs/screenshots/settings-dark.png
```

The visual tour freezes the clock and disables animations, so the copies are
repeatable. Update the capture version line above and `run.rosie.s3-sidekick.metainfo.xml`
in the same change. `scripts/screenshots.test.js` fails when the capture version
falls behind the app's major/minor version, when an AppStream URL points at a
branch that does not contain the file, or when an image size differs from the
metadata.
