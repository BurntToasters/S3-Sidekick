> [!NOTE]
> 🅱️ This is a BETA build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> MacOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :--- | :--- | :--- |
| **EXE: [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-macOS.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Linux-x64.AppImage) <!--/  [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.AppImage) --> |
| <!-- <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>--> | **[Universal ZIP](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-macOS.zip)** | **DEB:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Linux-x64.deb) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-arm64.deb)--> |
| <!--*See MSI note below*--> | | **RPM:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Linux-x64.rpm) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.rpm)--> |
| | | **Flatpak:** [x64](https://github.com/BurntToasters/S3-Sidekick/releases/download/v0.9.4-beta.3/S3-Sidekick-Linux-x64.flatpak) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v1.0.4/IYERIS-Linux-aarch64.flatpak)--> |

### ℹ️ Enjoying S3 Sidekick? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

## Changes  in `v0.9.4-beta.3:`
* **Win:** Addressed an issue with the new biometric unlock code where windows hello would fail.

## Changes  in `v0.9.4-beta.2:`
* **Updater:** Fixed a regression where customizing the Tauri Updater resulted in incorrect schemas causing the updater to fail.

## Changes  in `v0.9.4-beta.1:`
*Releases before v0.9.2 require a manual update.*
* **Biometric Unlock:** Biometric unlock has been re-done to increase the security of the S3 Sidekick app by fully integrating into the windows credential manager and macOS keychain. This requires a schema update to a user's current bookmarks. After launching S3 Sidekick, the migration process will automatically take please and require a restart.
* **PKG:** Updated packages.


* **Security:** Updated Tauri V2 updater signer key.
  * I accidentally leaked the (still encrypted) private key via a package.json entry. Rookie mistake I am very sorry I know how annoying this is. You will have to manually download and install `v0.9.2 (or later)` from this release to update the pubkey.
  * Since the private key that was leaked was still encrypted with a password, it is a better state than if it was the full unencrypted privkey.
  * All previous releases and accompanying binaries have been removed from github and my mirror. The tags still remain.
* **S3:** A bunch of new S3 additions (unstable as I was still testing. Better release notes to come).

## Full v0.9 release notes:

<details>
<summary>Full changelog</summary>

## Changes in `v0.9.0:`
* **Large file uploads:** Fixed an issue where larger files experienced slower uploads.
* **Activity:** Activity badges now clear when a user clicks on the activity tab.
* **Transfer Queue:** Successful transfers now move to the activity feed instead of staying in the transfer queue.
* **Misc:** Multiple security fixes.
* **PKG:** Updated packages.

</details>


> [!IMPORTANT]
The `.sig` files in this repo are NOT normal gpg signatures they are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
⚠️ Arm64 Linux Binaries are *NOT* available at the moment. Its something I may get around to in the future but its not a priority. However, I do have the logic setup in the repo in-case people would like to build their own :)
