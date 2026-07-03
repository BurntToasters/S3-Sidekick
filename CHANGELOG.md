> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                                                | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS          | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                                                      |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Windows-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-x64.AppImage) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div> -->                                          | **[Universal ZIP](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-x64.deb) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-arm64.deb) -->                |
|                                                                                                                                                                                                                                                  |                                                                                                                          | **RPM:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-x64.rpm) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-arm64.rpm) -->                |
|                                                                                                                                                                                                                                                  |                                                                                                                          | **Flatpak:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-x64.flatpak) <!-- / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.10.1-beta.1/S3-Sidekick-Linux-arm64.flatpak) -->    |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> ⚠️ Arm64 Linux Binaries are _NOT_ available at the moment. It's something I may get around to in the future but it's not a priority. I do have the logic set up in the repo in case people would like to build their own :)

### ℹ️ Enjoying S3 Sidekick? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

## Changes in `v0.10.1-beta.1:`

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

## Changes in `v0.9.5:`

- **NEW - Settings UI:** The settings UI has been fully re-designed with vertical tabs!
  - This was a goal of mine for a while; the settings UI for S3 Sidekick was too cramped and chaotic and needed a functional re-design :)
- **PKG:** Updated packages.

## Full v0.9 changelog:

<details>
<summary>Full v0.9 changelog</summary>

## Changes in `v0.9.3:`

_Releases before v0.9.2 require a manual update._

- **Security:** Updated Tauri V2 updater signer key.
  - I accidentally leaked the (still encrypted) private key via a package.json entry. Rookie mistake — I am very sorry, I know how annoying this is. You will have to manually download and install `v0.9.2 (or later)` from this release to update the pubkey.
  - Since the private key that was leaked was still encrypted with a password, it is a better state than if it was the full unencrypted privkey.
  - All previous releases and accompanying binaries have been removed from GitHub and my mirror. The tags still remain.
- **S3:** A bunch of new S3 additions (unstable as I was still testing; better release notes to come).
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
- **Code Signing:** macOS releases are fully signed. Windows releases are not signed by an org, but are signed by my GPG signature (same with Linux).
- **Legacy Binaries:** Separate x64/arm64 Windows binaries are deprecated in favor of the Universal installer. They are still listed in the downloads section, but the universal installer is recommended for simplicity.
