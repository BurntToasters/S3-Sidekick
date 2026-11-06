# S3-Sidekick

S3 Sidekick is your buddy for quick GUI S3-compatible storage management! I made this app because I couldn't find any S3 GUI clients for Linux that I preferred so I decided to make my own!

> **Package version in this checkout: 0.12.0-beta.1.** See [GitHub Releases](https://github.com/BurntToasters/S3-Sidekick/releases) for currently available installers and release status, and [CHANGELOG.md](CHANGELOG.md) for the changes in this checkout.

## ⬇️ Downloads

Download the installers for Windows, macOS, and Linux from [GitHub Releases](https://github.com/BurntToasters/S3-Sidekick/releases).

> **Windows:** the `.exe` (NSIS) installer is the supported in-app update target. The runtime reports native update mode for every Windows package, so the `.msi` build also shows the in-app update controls; an MSI install is not a supported updater target and should be updated through managed deployment instead. Machines without WebView2 fetch it with Microsoft's bootstrapper, so that first install needs a network connection.
>
> **macOS:** requires macOS 13.3 (Ventura) or newer. The universal DMG and ZIP cover Apple silicon and Intel.

### ℹ️ Enjoying S3 Sidekick? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

See [architecture and security notes](docs/ARCHITECTURE.md), [release runbook](docs/RELEASE.md), [settings glossary](docs/SETTINGS_GLOSSARY.md), and [support channels](docs/SUPPORT.md).

## Quickstart (development)

Requirements: Node 24+ (26.13.0 is the tested CI line), the Rust version
pinned in `rust-toolchain.toml`, and the platform Tauri prerequisites. On
Linux, `npm run setup:linux` installs the GTK/WebKit and Flatpak toolchain.

```sh
npm ci                 # install dependencies
npm run tauri:dev      # run the desktop app with hot reload
npm run test:all       # local merge gate (typecheck, lint, builds, tests)
npm run test:ui        # Playwright browser suite
npm run test:e2e:minio # command layer against a real MinIO (needs Docker)
```

`npm run licenses` writes the bundled dependency notices; it fails closed when
a dependency license is unknown or outside `scripts/license-policy.mjs`.

## Privacy

I don't collect your information from this app. There is no automatic crash reports, no telemetry, no B.S. Your device, your data.
It is important to note: By default on app start S3 Sidekick does ping github to see if there is a new release available and if there is, auto-downloads the file and asks if you want to restart to update. This behavior can be switched off in settings.

## License

S3 Sidekick is licensed under the [Mozilla Public License 2.0](LICENSE).
