<!-- > [!NOTE]
> 🅱️ This is a beta build.
-->

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Windows-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-x64.AppImage) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> --> | **[Universal ZIP](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-x64.deb) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-arm64.deb) --> |
| | | **RPM:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-x64.rpm) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-arm64.rpm) --> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-x64.flatpak) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.11.0/S3-Sidekick-Linux-arm64.flatpak) --> |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> ⚠️ Arm64 Linux Binaries are _NOT_ available at the moment. It's something I may get around to in the future but it's not a priority. I do have the logic set up in the repo in case people would like to build their own :)

### ℹ️ Enjoying S3 Sidekick? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

## Changes in `v0.11.0:`

It's finally here! v0.11.0 is a major reliability and UX release: a docked **Inspector** pane, custom desktop chrome, stronger data safety across uploads/downloads/moves, encrypted-vault hardening, and a long polish pass over browsing, transfers, and keyboard flow.

### Desktop chrome & window

- **Custom titlebar (macOS & Windows):** macOS uses Tauri overlay title bar with traffic-light spacing; Windows uses frameless chrome with in-app minimize/maximize/close. Linux keeps native window decorations.
- **Draggable regions:** Top drag strip, `data-tauri-drag-region`, selective `-webkit-app-region`, and a `startDragging` fallback so the header moves the window without blocking bookmark chips and buttons.
- **Window size:** First launch opens at the default medium size (`1100×720`, centered). Relaunch restores the last saved window size, and user resizes persist correctly without saving a maximized frame or overwriting settings during startup restore.

### Connection & browsing

- **Saved connections & bookmarks:** Saved connections and header bookmark chips share the same data; one-click connect from chips and the saved list. Inline connect errors, connecting spinner, Enter-to-connect in credential fields, bookmark tooltips, and a saved-list empty state.
- **Connection UI:** Successful connections keep the fetched bucket sidebar visible when no saved bucket can be restored; failed last-bucket restores also leave the sidebar available for retry or another selection.
- **Location omnibar:** Replaces separate breadcrumb + path field (browse vs edit path).
- **Object browsing:** The selection toolbar keeps a permanent 36px action row, table columns and row dividers stay aligned across the native table geometry, and compact selection actions fit beside a docked inspector. Checkbox double-clicks no longer navigate into folders accidentally.
- **Selection & filtering:** Shift-click ranges follow sorted filtered listings, including virtualized rows. Selections hidden by a filter remain selected and are disclosed in the count; object filters are clearable in one click, and sidebar filtering keeps keyboard focus on a visible bucket. Checkbox/Space updates the shift-click anchor; selection is stored structurally so a key named `prefix:…` can no longer be treated as a folder.
- **Toolbar:** Up navigation, download action, batch bar at one or more selected items with action tooltips (e.g. download files-only). **Download** disables when only folders are selected.

### Inspector (Preview | Properties)

- **Docked pane:** Preview and Properties render in a resizable panel beside the object list, off-canvas below 900px; open state is persisted and wide first visit defaults to open. Modal **File Info** tabs remain the fallback when the inspector is closed.
- **Reliable chrome:** Toggle, close (X), backdrop, and **Escape** show/hide the panel; selection sync uses a generation counter so updates are not dropped while preview/properties load.
- **Preview:** Previewable files render in the docked pane; non-previewable selections show a dedicated “not available” message and the Preview tab is dimmed when preview cannot apply. A native stack overflow while previewing JSON and other objects is fixed.
- **Properties:** Non-previewable files, folders, and multi-select route to Properties instead of an empty placeholder. Choosing **Properties** from the context menu or batch toolbar opens the Properties pane instead of auto-switching to Preview. Folder-only selections show a clear message instead of a failed `head_object` call. Unsaved edits prompt **Discard / Keep editing** when closing the inspector or dismissing File Info.
- **Layout:** Properties pane scrolls reliably, drops the redundant “File Info” header, tightens docked padding, hides Save/Cancel for folder-only views, and allows a wider panel (default ~360px, up to 560px). Batch toolbar wraps and collapses to icons when the docked panel steals width.
- **Keyboard & commands:** Inspector resize gutter supports keyboard adjustment (arrow keys). Command palette: **Toggle Inspector**, **Preview Selected File**, **Open Properties for Selection**; **⌘/Ctrl+Shift+I** toggles the inspector when connected. **Escape** dismisses one transient layer at a time (settings and modal overlays before drawer/sidebar/inspector). Disconnect closes the inspector panel.

### Transfers & activity

- **Drawer UI:** Queue summary, Pause/Resume all, overflow menu for prioritize/retry/clear; row presentation with operation chips, indeterminate progress, and failure badges. Status bar **Transfers** control is always visible (muted when idle).
- **Progress & errors:** Progress indicators distinguish queued, active, paused, completed, and failed transfers; transfer rows expose full source and destination paths and wrap readable error messages. Stalled uploads show a stalled state.
- **Setting:** Open transfer drawer when a transfer starts (default on); one-time toast pointing users to the transfers control.
- **Reliability:** Transfer IDs persist across webview reloads. Queue-manifest writes are serialized and failures surface in the activity log. Pause and cancel are re-checked at each step so a cancelled move cannot fall through to deletion. Download scratch paths are derived in the backend. Part retries honor error classification; failed checkpoints are written off the async coordinator; the recovery sweep reclaims orphaned scratch leases.

### Data safety (uploads, downloads, moves, conflicts)

- **Create-only writes:** Uploads, copies, moves, and renames use provider-supported atomic create-only requests when overwrite is disabled, preventing a concurrent writer from being silently replaced after the initial conflict check. Create-only support is detected per operation for AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2, and DigitalOcean Spaces.
- **Conflict UX:** Providers that cannot guarantee a create-only write require an explicit **Write anyway** confirmation. Apply-to-all consent is serialized, cancellations are distinguished from destination conflicts, and queued copies retain source size so multipart safety is evaluated correctly. A failed “does this already exist?” check now counts as a conflict and prompts for both downloads and object writes.
- **Upload integrity:** Single `PUT`s, browser-byte uploads, every multipart part, and multipart completion send a precalculated SHA-256 and the response checksum is checked against it.
- **Downloads:** Parallel downloads pin every range to one object generation (version ID where versioned, `If-Match` otherwise). Before publishing a completed parallel download, the pinned generation is re-checked; if the object changed, the destination is left untouched and scratch data is kept for resume. Resume checkpoints record version ID as well as ETag; native S3 checksums are preferred when verifying finished downloads. Checkpoint garbage collection no longer expires resume state for queued transfers.
- **Moves:** A move records a durable copy receipt (key, ETag, version ID for both sides) before anything is deleted; a crash between copy and delete resumes the delete instead of duplicating. Source deletion re-verifies both sides against the receipt. On versioned buckets the source is retired with a conditional delete marker. Prefix copies keep rollback backups and name any backup that could not be cleaned up.
- **Filesystem safety:** S3 keys map to local file names structurally — traversal segments are rejected, Windows-illegal characters are percent-encoded with collision detection, and Unicode is folded to NFC. Create-only downloads fall back to exclusive reservation or atomic no-replace move on filesystems without hard links.
- **Publishing & cleanup:** Removing unusable scratch data flushes the parent directory entry, including a native Windows directory flush, so cleanup survives interruption and power loss.

### S3 & connection

- **Endpoints & listings:** Virtual-hosted AWS endpoints are normalized; listings request `encoding-type=url` so keys with XML-hostile characters no longer break pages.
- **Multipart & timeouts:** `CompleteMultipartUpload` retries 200-with-error-body responses instead of aborting a possibly live upload. Request-body timeouts scale with part size; download bodies have a stall timeout.
- **Session tokens:** Optional STS session tokens are supported in the connection form.
- **Connection safety:** Rename and conflict checks stay bound to the connection that initiated them; late async results cannot act on a newly selected connection or location.

### Security & settings

- **Encrypted vault:** Payloads carry a key-check value so unlocking with the wrong key is detected. Migrations (enabling encryption, password change, rekeying) are staged and journaled; interruption restores originals or completes on next launch. Plaintext adoption from older versions is proven by a key-derived value that cannot be re-armed by editing config. Disabling biometric unlock and factory reset are journaled and replay to completion if interrupted.
- **Windows:** Biometric credential checks handle sessions without an interactive Credential Manager (e.g. RDP).
- **Factory reset:** Requires a second explicit confirmation, states what it destroys (including transfer checkpoints and partial download files), and stops running transfers first.
- **Settings:** Failed saves surface inside the modal. The sidebar includes a **Support Me** button (Lucide heart) that opens `https://rosie.run/support` in the browser.

### UI, accessibility & onboarding

- **Panels & keyboard flow:** Sidebar and inspector widths fit available desktop space while preserving preferred sizes. The activity drawer collapses and restores cleanly with focus returned to its opener. Opening the inspector on narrow layouts closes the bottom transfers drawer.
- **Feedback & dialogs:** Disabled controls have consistent states, toast countdowns pause while hovered or focused, sticky messages stay available until dismissed, and long confirmation dialogs fit within the viewport. Destructive confirmations focus the safe choice. Queued confirmation dialogs cannot overlap or reorder.
- **Onboarding:** Setup wizard ends with **Connect to storage** and focuses the connection form; wizard uses the same modal focus trap as settings. Skip link to main content, `<main>` landmark, modal overlays inset below custom titlebar on macOS/Windows.

## Click below for the full `v0.X` Changelog

<details>
<summary>Full v0.X changelog</summary>

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

## ℹ️ Release Info

> [!IMPORTANT]
> **Note:** MSI builds are NOT provided for beta releases. Use the EXE installer.

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
- **Code Signing:** macOS releases are fully signed. Windows releases are fully signed using Azure Artifact Signing. Linux releases are GPG signed.
- **Legacy Binaries:** Separate x64/arm64 Windows binaries are deprecated in favor of the Universal installer. They are still listed in the downloads section, but the universal installer is recommended for simplicity.
