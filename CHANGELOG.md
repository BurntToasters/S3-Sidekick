> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Windows-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-x64.AppImage) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> --> | **[Universal ZIP](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-x64.deb) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-arm64.deb) --> |
| | | **RPM:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-x64.rpm) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-arm64.rpm) --> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-x64.flatpak) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0-beta.4/S3-Sidekick-Linux-arm64.flatpak) --> |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> ⚠️ Arm64 Linux Binaries are _NOT_ available at the moment. It's something I may get around to in the future but it's not a priority. I do have the logic set up in the repo in case people would like to build their own :)

### ℹ️ Enjoying S3 Sidekick? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

## Changes in `v0.11.0-beta.4:`

Beta 4 is a polish-and-unbreak pass: the docked inspector behaves for files that cannot preview, release VMs stop dying on a false quality-gate miss, and Windows security tests no longer wedge on Credential Manager when there is no interactive logon session.

- **Inspector:** Selecting anything that is not previewable (`.flatpak`, `.exe`, `.zip`, folders, multi-select, … — anything outside the image/text allowlist) opens **Properties** instead of leaving the empty “Select an object to inspect.” placeholder.
- **Inspector:** Clicking the **Preview** tab on a non-previewable selection stays on Preview and shows a dedicated “not available” message; the Preview tab is dimmed (`aria-disabled`) when the current selection cannot preview.
- **Inspector:** Batch selection toolbar wraps and collapses to icons when the docked panel steals width, so **Deselect** / **Copy URLs** no longer clip off the edge.
- **Inspector:** Properties pane scrolls reliably (`min-height: 0`), drops the redundant “File Info” header, tightens docked padding, hides Save/Cancel for folder-only views, and allows a wider panel (default ~360px, up to 560px).
- **Release pipeline:** Quality-gate recording no longer trims git porcelain XY columns. Bootstrap-only metainfo drift (` M path`) was being misparsed as an empty dirty set, so `coverage/.release-quality.json` was never written and `release:prepare` failed with ENOENT on clean release VMs.
- **Release pipeline / CI:** Rust toolchain and CI install `clippy` + `rustfmt` with the pinned `1.97.1` toolchain (CI was failing after tests on “clippy not installed”).
- **Testing:** `test:all` prints failed Rust test names instead of only the last log lines; security tests clear the process-global migration-recovery latch between cases so one failure cannot poison the rest of the suite.
- **Windows:** Biometric credential presence checks treat `ERROR_NO_SUCH_LOGON_SESSION` (`0x80070520`) as “no usable key” so vault migration cleanup does not fail closed on headless/RDP/test VMs without an interactive Credential Manager session.
- **Testing:** Frontend suite at **339** tests passing.
- **Ver:** Bumped version to `v0.11.0-beta.4`.

## Changes in `v0.11.0-beta.3:`

Beta 3 is a correctness pass over the parts of the app that can lose data: moves, downloads, uploads, and the encrypted vault. A lot of this is invisible when everything goes right, and the whole point is what happens when it doesn't :)

- **Security:** Encrypted payloads now carry a key-check value, so unlocking with the wrong key is detected instead of producing garbage, and PBKDF2 parameters are validated before use.
- **Security:** Migrations (enabling encryption, changing your password, rekeying) are staged and journaled. An interruption mid-migration now either restores the originals or completes the commit on next launch rather than leaving a half-converted vault.
- **Security:** The one-time adoption of files left in plaintext by an older version is now proven by a key-derived, constant-time-checked value instead of a plain boolean, so the sweep cannot be re-armed by editing the config file. The proof is regenerated on password/KDF rekey and cleared when key material is discarded.
- **Security:** Disabling biometric unlock is journaled, so a credential is still removed from the OS credential store if the app is killed part way through. A stale `enrolled` flag no longer leaves the key behind.
- **Security:** Factory reset is journaled too, and a partially applied reset is replayed to completion on next launch.
- **Uploads:** Upload integrity is now verified by S3 itself. Single `PUT`s, browser-byte uploads, every multipart part, and the multipart completion all send a precalculated SHA-256 and the response checksum is checked against it. Previously the check could be satisfied by metadata the app had written itself.
- **Downloads:** Parallel downloads pin every range to one object generation (version ID where the bucket is versioned, `If-Match` otherwise), so ranges can no longer be mixed across a concurrent overwrite.
- **Downloads:** Right before a completed parallel download is published, the pinned generation is re-checked against what is current. If the object changed while downloading, the destination is left untouched and the downloaded data is kept for resuming instead of overwriting your file with a stale copy.
- **Downloads:** Resume checkpoints record the version ID as well as the ETag, and native S3 checksums are preferred over the app's own metadata hint when verifying a finished download.
- **Downloads:** Checkpoint garbage collection no longer expires the resume state (or the scratch file) of a transfer that is still queued.
- **Moves:** A move now records a copy receipt — key, ETag and version ID for both sides — and that receipt is made durable *before* anything is deleted. A crash between the copy and the delete resumes the delete instead of duplicating or re-copying the object.
- **Moves:** Source deletion re-verifies both the destination and the source against the receipt and refuses to delete on any mismatch. On versioned buckets the source is retired with a conditional delete marker rather than a permanent version-targeted delete, so a write that races the deletion is recoverable instead of destroyed.
- **Moves:** Prefix copies keep rollback backups and name every backup they could not clean up, so a partial failure is always recoverable and never silently leaves stray objects.
- **Transfers:** Transfer IDs persist across webview reloads. They are the handle the backend uses to cancel work, and restarting them at 1 could point a new transfer at an old one.
- **Transfers:** Queue-manifest writes are serialized and their failures are surfaced in the activity log instead of being swallowed. Recovery data is loaded once secure storage is unlocked.
- **Transfers:** Pause and cancel are re-checked at each step of a transfer, so a cancelled move cannot fall through to the deletion phase.
- **Transfers:** Download scratch paths are derived in the backend instead of being passed in from the webview.
- **Conflicts:** A failed "does this already exist?" check now counts as a conflict and prompts, for both downloads and object writes. A throttle, a `403`, or a transient error used to read as "not there" and quietly authorise an overwrite.
- **Settings:** Factory reset asks for a second, explicit confirmation and now states what it destroys, including transfer checkpoints and partial download files. Running transfers are stopped first.
- **UI:** The dev build opens at the same default window size as the release build.
- **Codebase:** Removed an unreachable direct-download path in the download handler, the stale `src-tauri/tree.txt` dump, and an unused legacy `.icns`.
- **Logo:** The iconset normalizer decodes PNGs to verify dimensions and opacity rather than trusting file names, with tests covering the checks.
- **Release workflow:** GitHub release titles are generated from one shared helper and follow the BurntToasters Changelog Standard, so this release is titled `0.11.0 Beta 3` while the tag stays `v0.11.0-beta.3`.
- **Testing:** Added coverage for checksum verification, generation pinning, move receipts and resume classification, the adoption proof, migration recovery, and release titling (**338** frontend and **114** Rust tests passing).
- **Ver:** Bumped version to `v0.11.0-beta.3`.
- **PKG:** Pinned every Rust dependency to an exact version and pinned the Rust toolchain to `1.97.1` in both the repo and CI, so local and CI builds resolve identically.

## Changes in `v0.11.0-beta.2:`

Inspector pane fixes and release-pipeline hardening for VM builds (`npm run b && npm run release:*`).

- **Inspector pane (Preview | Properties):**
  - Toggle, close (X), backdrop, and **Escape** reliably show/hide the panel; duplicate event wiring guarded.
  - Selection sync uses a generation counter (no dropped updates while preview/properties load); empty vs. active pane state fixed so content is not stacked with the placeholder.
  - Preview and properties render in the **open docked/slide-out panel** on all widths when the inspector is open (no duplicate full-screen modals on narrow layouts).
  - Resizable gutter on desktop; layout/CSS fixes for clipped headers and panel height; default first-visit open aligned to **901px** (matches mobile breakpoint).
  - Non-previewable single files stay on Preview with an inline message; multi-select and folders route to Properties; modal **File Info** tabs work when the inspector is closed.
  - Batch toolbar **Properties** opens the panel for a single selected item (not only multi-select); folder-only selections included.
  - Single selected **folders** show a clear properties message instead of a failed `head_object` call.
  - Toolbar **Download** disables when only folders are selected (files-only, matching batch download).
  - Disconnect closes the inspector panel.
  - Inspector resize gutter supports keyboard adjustment (arrow keys) and platform-aware toggle shortcut labels (⌘⇧I on macOS).
  - Command palette: **Toggle Inspector**, **Preview Selected File**, **Open Properties for Selection**; **⌘/Ctrl+Shift+I** toggles the inspector when connected.
  - Closing the inspector clears preview and properties content; mobile inspector closes on bucket/folder navigation.
  - **Escape** order: settings and modal overlays close before drawer/sidebar/inspector; docked preview clears before the panel closes.
  - Unsaved property edits prompt **Discard / Keep editing** when closing the inspector or dismissing File Info (X, Cancel, backdrop, Escape).
  - Opening the inspector on narrow layouts closes the bottom activity/transfers drawer; resizing into the mobile breakpoint does the same.
  - Context menu: multi-folder selection and single-folder **Properties**; properties use the full selection (files + folders).
  - Selection: checkbox/Space updates shift-click anchor; preview/properties errors use friendly messages; **Load more** reports failures in the status bar.
- **Release pipeline:**
  - `release:prepare` writes `release/.build-session.json` via `release:session:start` (fixes ENOENT on `release:session:verify`).
  - Quality-gate proof tolerates bootstrap-only git drift (`sync-version` / metainfo / Cargo lockfiles); porcelain parsing fix for `git status`.
- **Tests:** Inspector sync, keyboard shortcuts, release-session, and info-panel discard flows (**335** tests passing).

## Changes in `v0.10.2:`

- **NEW - Windows code signing:** WOO HOO!! Windows Codesigning is here!
  - After a good while of not having it, Windows Binaries are now signed by Azure Artifact Signing!
- **Release workflow:** Added resilient GitHub draft-release creation and wait steps so Windows creates one shared draft and macOS/Linux reuse it instead of creating duplicate drafts.
- **Build performance:** Switched the Rust release profile to thin LTO with parallel code generation for faster release builds.
- **UI:** Restored the missing upload icon in the file-upload toolbar and command palette.

## Click below for the full `v0.X` Changelog

<details>
<summary>Full v0.X changelog</summary>

## Changes in `v0.11.0-beta.1:`

Focused UX polish for connection flow, browsing chrome, transfers, and desktop window framing—without a full redesign.

- **Custom titlebar (macOS & Windows):**
  - macOS uses Tauri overlay title bar with traffic-light spacing; Windows uses frameless chrome with in-app minimize/maximize/close.
  - Linux keeps native window decorations (unchanged).
  - Draggable regions: top drag strip, `data-tauri-drag-region`, selective `-webkit-app-region`, and `startDragging` fallback so the header can move the window without blocking bookmark chips and buttons.
- **Connection & bookmarks:**
  - Saved connections and header bookmark chips share the same data; one-click connect from chips and saved list.
  - Inline connect errors, connecting spinner, Enter-to-connect in credential fields, bookmark tooltips (name in bar, endpoint on hover).
  - Saved-list empty state, row selection/focus/Enter, form disabled while connecting; copy links saved connections to title-bar bookmarks.
- **Browser chrome:**
  - **Location omnibar** replaces separate breadcrumb + path field (browse vs edit path).
  - **Inspector pane** (Preview | Properties) docked beside the object list, resizable, off-canvas below 900px; open state persisted; wide first visit defaults to open; Preview/Properties open the inspector on desktop (modals remain fallback on narrow layouts).
  - Toolbar: Up navigation, download action, batch bar at one or more selected items with action tooltips (e.g. download files-only).
- **Transfers & activity:**
  - Drawer header: queue summary, Pause/Resume all, overflow menu for prioritize/retry/clear (legacy toolbar buttons removed).
  - Row presentation: operation chips, indeterminate progress, failure badge; status bar **Transfers** control always visible (muted when idle).
  - Setting: open transfer drawer when a transfer starts (default on); one-time toast pointing users to the transfers control.
- **Onboarding & accessibility:**
  - Setup wizard ends with **Connect to storage** and focuses the connection form; wizard uses the same modal focus trap as settings.
  - Skip link to main content, `<main>` landmark, modal overlays inset below custom titlebar on macOS/Windows.
- **Dev / tooling:**
  - `scripts/sync-version.js` updates the workspace package version in `Cargo.lock` when the npm version changes (fixes `cargo metadata --locked` after version bumps).
- **Tests:** Vitest coverage for connection UX, omnibar/inspector, transfers UI, titlebar, and related browser/bookmark updates (**321** tests passing).

## Changes in `v0.10.1:`

- **Security:** Bumped PBKDF2-HMAC-SHA256 iterations from `210,000` to `600,000` to match current OWASP recommendations. Existing vaults auto-migrate on next unlock.
- **Security:** Added cleartext HTTP warning when connecting to non-local endpoints over plain `http://`. Credentials are sent unencrypted in that scenario.
- **Security:** Documented biometric unlock limitations (key stored in OS credential store is not hardware-bound to Touch ID / Windows Hello).
- **UI:** Fixed WCAG 1.4.3 AA contrast failures in `--text-muted`, `--text-secondary`, and `--badge-off-text` tokens across both light and dark themes. All text now meets the 4.5:1 minimum.
- **UI:** Removed dead `.connection-bar` CSS left over from the v0.10.0 redesign and added a responsive breakpoint for `#connection-screen` at narrow widths (≤700px).
- **UI:** Consolidated duplicate dark-theme token blocks into a single source of truth per selector.
- **UI:** Added full ARIA support to the command palette — `role="dialog"`, `role="combobox"`, `role="listbox"`/`role="option"`, `aria-activedescendant`, and a keyboard focus trap.
- **Codebase:** Cleaned up dead responsive CSS targeting the removed `.connection-bar` element.

## Changes in `v0.10.0:`

v0.10.0 introduces a comprehensive UI/UX modernization, window size memory on relaunch, and stabilization fixes.

- **UI Modernization:**
  - Transitioned the entire color palette to a refined, professional HSL Slate and Indigo theme.
  - Replaced the persistent top connection inputs with a dedicated welcome dashboard/connection screen (`#connection-screen`), organizing saved connection bookmarks in a sidebar and S3 credentials forms in a card layout.
  - Relocated the disconnect button to the main header actions list.
  - Upgraded the bucket list in the sidebar into modern rounded selector pills.
  - Upgraded settings layout, inputs alignment, and increased modal overlays backdrop blur to `8px` for premium visual depth.
- **Vector Iconography:** Replaced all cartoon-style Twemoji image assets across S3 Sidekick with clean, high-definition, vector-based Lucide Icons (MIT licensed). These render completely offline in modern outline vector designs and dynamically adapt to active light/dark themes natively using CSS.
- **Window Size Memory:**
  - Added window dimensions memory to settings. When resized, width and height are saved to `settings.json` (debounced by 500ms to protect disk health).
  - Automatically restores the last window size on relaunch, and resets it to default `1100x720` if settings are reset.
- **Transfers:** In-flight uploads are excluded from the session recovery manifest and restart from scratch on next launch (uploads are not resumable).
- **Transfers:** Pausing the queue no longer cancels in-flight uploads (they'd restart from byte 0 anyway); running uploads now complete before the pause takes effect.
- **Downloads:** Parallel download resume now verifies the object ETag before restoring a checkpoint, preventing stale bytes from being mixed in if the object changed server-side between sessions.
- **Security:** Fixed a potential panic in multipart upload if the source file grew larger between the initial size measurement and the upload completing.
- **UI:** Dialogs now trap focus within the modal (Tab cycles through focusable controls only) and restore focus to the previously focused element on close.
- **Misc:** Cleaned up all Clippy warnings across the Rust codebase; the build now enforces `-D warnings`.
- **PKG:** Updated packages.

## Changes in `v0.9.0:`

- **Large file uploads:** Fixed an issue where larger files experienced slower uploads.
- **Activity:** Activity badges now clear when a user clicks on the activity tab.
- **Transfer Queue:** Successful transfers now move to the activity feed instead of staying in the transfer queue.
- **Misc:** Multiple security fixes.
- **PKG:** Updated packages.

</details>

> [!IMPORTANT]
> **Note:** MSI builds are NOT provided for beta releases. Use the EXE installer.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
- **Code Signing:** macOS releases are fully signed. Windows releases are fully signed using Azure Artifact Signing. Linux releases are GPG signed.
- **Legacy Binaries:** Separate x64/arm64 Windows binaries are deprecated in favor of the Universal installer. They are still listed in the downloads section, but the universal installer is recommended for simplicity.
