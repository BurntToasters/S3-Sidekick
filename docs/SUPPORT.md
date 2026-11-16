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

## SFTP

SFTP is a beta connection type. The items below cover the messages and limits most often reported.

### The server only offers RSA keys

RSA is not supported in this beta. Host keys must be Ed25519 or ECDSA (P-256, P-384, or P-521), and user keys must not be RSA. A server that offers only RSA host keys fails with "This server only offers RSA host keys." Ask the server administrator for an Ed25519 or ECDSA host key, or use a key type this app supports for sign-in.

### "Host key changed"

The server presented a different host key from the one saved with the connection, so the app refuses to connect. The server may have been reinstalled or its key replaced. The key may also be intercepted. Confirm the new fingerprint (SHA-256) with the server administrator before you change anything. The trust dialog has a **Copy fingerprint** button, which helps when you compare it with the one the administrator gives you. During **Test connection** the trust button reads **Trust and test**. If it is the expected key, open the saved connection in the connection editor, choose **Reset host key**, and connect again. The next connection asks you to trust the new key.

### Authentication method not accepted

The message "Authentication failed. This server does not accept Password sign-in for this user. It accepts: Private key." means the server does not allow the method you chose for that account. Choose one of the methods listed, or ask the server administrator to enable the method. A plain "Authentication failed." means the server accepts the method you chose, so check the username, password, or key and passphrase.

### Preview is not available for a file

SFTP does not store a content type, so the app decides from the file extension. A file with no extension or an unknown one is shown as text only when its first 1 MiB is valid UTF-8 without NUL bytes. Binary files and files with a known binary extension, such as `.zip`, `.pdf`, or `.png`, have no text preview. Download the file to open it.

### Upload refused: the server would not copy permissions

Uploading over an existing file copies the existing file's permissions to the new one. If the server refuses that copy, the upload fails and the existing file is kept unchanged. Delete the remote file and upload again. The new file gets the server's default permissions, not the old file's.

### Folder download includes only files in the folder

A folder download queues only the files directly inside the folder. Subfolders, symbolic links, and names that are not valid UTF-8 are skipped and listed as skipped. To download a subfolder, open it and download its contents. This limit is a known beta gap.

### Connect is slow or fails on a dual-stack network

The app tries each address the host name resolves to, in order, within a 10 second budget for the TCP connect. A refused address moves on at once. An address that does not answer uses its share of the budget before the next address is tried. If the connect still fails, check that the host and port are reachable from this network, and check any VPN or firewall rules.
