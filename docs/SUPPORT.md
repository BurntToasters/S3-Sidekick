# Support

- Report reproducible bugs and feature requests in [GitHub Issues](https://github.com/BurntToasters/S3-Sidekick/issues).
- Use [GitHub Discussions](https://github.com/BurntToasters/S3-Sidekick/discussions) for configuration and provider questions.
- For private support or security reports, contact `code@rosie.run`. Do not include access keys, secret keys, or private object contents.
- Include S3 provider, operating system, app version, relevant Activity log text, and a minimal reproduction. Redact credentials and object names when sharing logs.

## Security reports

Do not publish credential material in an issue. Describe impact and reproduction privately first. The app has no crash telemetry; reports must be sent through one of the channels above.

## Links and "Show in folder" do nothing

External links, **Open folder** and **Show in folder** start the operating system's launcher from a fixed location; the app never searches `PATH`, so a same-named program placed earlier on `PATH` cannot intercept them.

- macOS: `/usr/bin/open` (or `/bin/open`).
- Linux: `/usr/bin/xdg-open`, `/bin/xdg-open` or `/usr/local/bin/xdg-open`.
- Windows: `explorer.exe` and `rundll32.exe` from `%SystemRoot%`.

Systems that install `xdg-open` elsewhere, such as NixOS (`/run/current-system/sw/bin`), report "Unable to find the system launcher". Making `xdg-open` available at one of the paths above (for example with a symlink in `/usr/local/bin`) fixes it.
