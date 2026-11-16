//! Upload and download checks against the OpenSSH fleet: byte identity, create-only
//! and overwrite finalization, cancellation, resumable downloads, remote change
//! detection, progress events, and the session guards. Each check is named in
//! `tests/sftp/expected-checks/transfer.json`.

// Failure modes, enumerated before `sftp/transfer.rs`, and the guard for each:
// - Uploaded bytes differ from the source, or a short write counts as success.
//   The server-side sha256 of every upload must equal the local one.
// - A temp file (`.<name>.s3sk-<hex>.part`) or a backup survives success, failure
//   or cancel. The folder listing is checked after every transfer.

// - A create-only upload replaces an existing file. The existing bytes are hashed
//   on the server after the refused upload.
// - An overwrite drops the old target before the new bytes land, or loses the
//   old target when it fails. The hash after a successful overwrite is checked.
// - A cancelled upload publishes partial bytes. The target must be absent, and
//   no temp file may remain.

// - A missing parent folder is created, or the upload reports success. The
//   parent listing is checked after the refused upload.
// - A download's bytes differ, or a create-only download writes into an existing
//   local file. Local hashes and the untouched local file are checked.
// - A cancelled download loses its scratch file or checkpoint, so resume restarts.
//   The retained scratch length and the resumed offset in events are checked.

// - A resume after the remote file changed splices old and new bytes. The next
//   attempt must restart at zero and hash equal to the new remote content.
// - A remote change during a download publishes stale bytes. The error must
//   name the change, and no destination, scratch or checkpoint may remain.
// - A progress stream ends short of the size or skips the verifying phase. The
//   last event of each direction must be verifying at bytes_sent equal to size.

// - A stale connection ID reaches the server or the local disk. Neither side may
//   change when the ID is refused.
// - A dead transport reports success or a generic error. The error must carry the
//   lost-connection prefix, and a reconnect must find no temp file.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Listener, Manager};

use super::*;
use crate::path_authority::{mint, GrantPurpose};
use crate::s3::cancel_transfer_in_registry;
use crate::sftp::session::{require_session, SFTP_CONNECTION_LOST};

const CHECK_UPLOAD_LARGE: &str =
    "a 6 MiB upload arrives byte-identical on the server and leaves no .s3sk- temp file";
const CHECK_UPLOAD_BYTES: &str =
    "upload of base64 bytes round-trips byte-identical and leaves no temp file";
const CHECK_CREATE_ONLY: &str =
    "create-only upload onto an existing file fails with 'already exists' and leaves the file byte-identical";
const CHECK_OVERWRITE: &str =
    "overwrite upload replaces the file and leaves no backup or temp file";
const CHECK_MISSING_PARENT: &str =
    "upload into a missing parent folder fails with 'Parent folder not found' and creates nothing";
const CHECK_UPLOAD_CANCEL: &str =
    "an upload cancelled mid-stream leaves no target and no temp file";
const CHECK_PROGRESS_UPLOAD: &str =
    "upload progress runs from running to verifying and ends at bytes_sent equal to the size";
const CHECK_DOWNLOAD: &str =
    "a download arrives byte-identical to the server file and leaves no scratch file";
const CHECK_DOWNLOAD_CREATE_ONLY: &str =
    "create-only download onto an existing local file is refused and the local file is unchanged";
const CHECK_PROGRESS_DOWNLOAD: &str =
    "download progress runs from running to verifying and ends at bytes_sent equal to the size";
const CHECK_RESUME: &str =
    "a cancelled download keeps its scratch and checkpoint, and the next attempt resumes and is byte-identical";
const CHECK_RESUME_CHANGED: &str =
    "a resume after the remote file changed restarts from zero and is byte-identical to the new file";
const CHECK_REMOTE_CHANGE: &str =
    "a remote change during a download fails closed with no destination, scratch, or checkpoint";
const CHECK_STALE: &str =
    "upload and download with a stale connection id fail closed and change neither side";
const CHECK_LOST: &str =
    "transfers after the server dropped the SSH session fail with 'SFTP connection lost' and leave no temp file";
const CHECK_KEEP_PRIVATE_MODE: &str =
    "overwrite upload of a mode 600 file keeps mode 600 and the new bytes";
const CHECK_KEEP_EXEC_MODE: &str =
    "overwrite upload of a mode 755 file keeps mode 755 and the new bytes";
const CHECK_TEMP_PRIVATE: &str =
    "an overwrite upload's temporary file is mode 600 while bytes are moving";
const CHECK_SYMLINK_REFUSED: &str =
    "overwrite upload onto a symlink is refused and the link and its target are unchanged";
const CHECK_NOLINK_CAPABILITY: &str =
    "a server without the hardlink extension reports create_only_supported false";
const CHECK_NOLINK_UPLOAD: &str =
    "create-only upload to a server without the hardlink extension arrives byte-identical and leaves no temp file";
const CHECK_NOLINK_REFUSE: &str =
    "create-only upload to a server without the hardlink extension still refuses an existing file and keeps its bytes";
const CHECK_SILENT_DROP: &str =
    "a server that stops answering mid-download is reported as 'SFTP connection lost' within 75 seconds";

/// Unpauses the container on drop, so a failed check cannot leave the fleet frozen for the
/// checks that follow.
struct Unpause(String);

impl Drop for Unpause {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["unpause", &self.0]).status();
    }
}

const PASSWORD_METHOD: &str = "password";
/// A connection ID the backend never minted.
const BOGUS_CONNECTION_ID: &str = "00112233445566778899aabbccddeeff";
const MIB: usize = 1_048_576;
/// 16 Mbps is 2 MiB/s, so a multi-MiB transfer runs for seconds and progress
/// events arrive while it is still moving.
const SLOW_MBPS: u32 = 16;
/// The suffix the backend appends to a download destination for its scratch file.
const SCRATCH_SUFFIX: &str = ".s3-sidekick.download.tmp";

/// Run `sh -c script` in the container as the test user, with `vars` set.
fn remote_sh(
    container: &str,
    user: &str,
    vars: &[(&str, &str)],
    script: &str,
) -> Result<String, String> {
    let mut command = Command::new("docker");
    command.args(["exec", "-u", user]);
    for (name, value) in vars {
        command.arg("-e").arg(format!("{}={}", name, value));
    }
    command.args([container, "sh", "-c", script]);
    let output = command
        .output()
        .map_err(|err| format!("docker exec failed: {}", err))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "remote command failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// A folder under the test user's home, created fresh and removed on drop.
struct RemoteDir {
    container: String,
    user: String,
    root: String,
}

impl RemoteDir {
    fn new(env: &Env, home: &str, name: &str) -> Self {
        assert!(
            home.starts_with('/') && !home.contains(['"', '\'', '$', '\\', '\n']),
            "unsafe home path {home:?}"
        );
        let dir = Self {
            container: env.container.clone(),
            user: env.user.clone(),
            root: format!("{}/{}", home, name),
        };
        dir.sh("rm -rf -- \"$ROOT\" && mkdir -- \"$ROOT\"")
            .expect("create remote fixture folder");
        dir
    }

    fn path(&self, name: &str) -> String {
        format!("{}/{}", self.root, name)
    }

    fn sh_with(&self, vars: &[(&str, &str)], script: &str) -> Result<String, String> {
        let mut all = vec![("ROOT", self.root.as_str())];
        all.extend_from_slice(vars);
        remote_sh(&self.container, &self.user, &all, script)
    }

    fn sh(&self, script: &str) -> Result<String, String> {
        self.sh_with(&[], script)
    }

    /// Write `content` through base64, so binary bytes survive the shell.
    fn write(&self, name: &str, content: &[u8]) {
        let encoded = B64.encode(content);
        let path = self.path(name);
        self.sh_with(
            &[("B64", encoded.as_str()), ("P", path.as_str())],
            "printf '%s' \"$B64\" | base64 -d > \"$P\"",
        )
        .expect("write remote fixture");
    }

    /// Create `name` with `bytes` of random data, generated on the server.
    fn random(&self, name: &str, bytes: usize) {
        let path = self.path(name);
        let count = bytes.to_string();
        self.sh_with(
            &[("P", path.as_str()), ("N", count.as_str())],
            "head -c \"$N\" /dev/urandom > \"$P\"",
        )
        .expect("create random remote fixture");
    }

    /// Append text to a remote file, as an external writer would.
    fn append(&self, name: &str, text: &str) {
        let path = self.path(name);
        self.sh_with(
            &[("P", path.as_str()), ("T", text)],
            "printf '%s' \"$T\" >> \"$P\"",
        )
        .expect("append to remote fixture");
    }

    /// The server's own sha256 of `name`, or an error description.
    fn sha256(&self, name: &str) -> String {
        let path = self.path(name);
        self.sh_with(
            &[("P", path.as_str())],
            "sha256sum -- \"$P\" | cut -d' ' -f1",
        )
        .map(|out| out.trim().to_string())
        .unwrap_or_else(|err| format!("error: {}", err))
    }

    /// The server's size of `name`.
    fn size(&self, name: &str) -> Option<u64> {
        let path = self.path(name);
        self.sh_with(&[("P", path.as_str())], "stat -c %s -- \"$P\"")
            .ok()
            .and_then(|out| out.trim().parse().ok())
    }

    /// The octal permission bits of `name` as `stat` prints them, without following a link.
    fn mode(&self, name: &str) -> Option<String> {
        let path = self.path(name);
        self.sh_with(&[("P", path.as_str())], "stat -c %a -- \"$P\"")
            .ok()
            .map(|out| out.trim().to_string())
    }

    fn chmod(&self, name: &str, mode: &str) {
        let path = self.path(name);
        self.sh_with(
            &[("P", path.as_str()), ("M", mode)],
            "chmod \"$M\" -- \"$P\"",
        )
        .expect("chmod remote fixture");
    }

    /// Make `name` a symlink to `target`, a name in the same folder.
    fn symlink(&self, name: &str, target: &str) {
        let path = self.path(name);
        self.sh_with(
            &[("P", path.as_str()), ("T", target)],
            "ln -s -- \"$T\" \"$P\"",
        )
        .expect("create remote symlink");
    }

    fn is_symlink(&self, name: &str) -> bool {
        let path = self.path(name);
        self.sh_with(&[("P", path.as_str())], "test -L \"$P\"")
            .is_ok()
    }

    /// Names directly inside the folder, as the server lists them.
    fn names(&self) -> Vec<String> {
        self.sh("ls -A -- \"$ROOT\"")
            .map(|out| out.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }
}

impl Drop for RemoteDir {
    fn drop(&mut self) {
        let _ = self.sh("chmod -R u+rwX -- \"$ROOT\" 2>/dev/null; rm -rf -- \"$ROOT\"");
    }
}

/// The modes of the backend temp files in `root`, as `<mode> <path>` lines. A free function, so
/// an event listener can call it without owning a `RemoteDir`, whose drop removes the folder.
fn temp_modes(container: &str, user: &str, root: &str) -> Vec<String> {
    remote_sh(
        container,
        user,
        &[("ROOT", root)],
        "for f in \"$ROOT\"/.*.s3sk-*.part; do [ -e \"$f\" ] && stat -c '%a %n' -- \"$f\"; done; true",
    )
    .map(|out| out.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

/// True when a folder listing holds no backend temp file or backup.
fn no_temp_files(names: &[String]) -> bool {
    names.iter().all(|name| !name.contains(".s3sk-"))
}

/// A local folder for source and destination files, removed on drop.
struct LocalDir(PathBuf);

impl LocalDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "s3sk-e2e-sftp-transfer-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create local transfer folder");
        Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for LocalDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

fn file_sha256(path: &Path) -> String {
    std::fs::read(path)
        .map(|bytes| sha256_hex(&bytes))
        .unwrap_or_else(|err| format!("error: {}", err))
}

/// Deterministic bytes that do not repeat over a few MiB, so a shifted or
/// spliced copy hashes differently from the expected one.
fn pattern(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect()
}

/// The scratch file the backend derives for a download destination.
fn scratch_of(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(SCRATCH_SUFFIX);
    PathBuf::from(name)
}

/// Every event received on one progress channel, in arrival order.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<Value>>>);

impl Events {
    /// Listen on `event` for the rest of the app's life. `on_event` runs before
    /// each event is stored, so a check can react to progress as it happens.
    fn attach(
        app: &tauri::App<tauri::test::MockRuntime>,
        event: &'static str,
        on_event: impl Fn(&Value) + Send + 'static,
    ) -> Self {
        let events = Self::default();
        let sink = events.clone();
        app.handle().listen(event, move |raw| {
            if let Ok(value) = serde_json::from_str::<Value>(raw.payload()) {
                on_event(&value);
                if let Ok(mut list) = sink.0.lock() {
                    list.push(value);
                }
            }
        });
        events
    }

    /// The events of one transfer attempt.
    fn for_attempt(&self, transfer_id: u64, attempt: u64) -> Vec<Value> {
        self.0
            .lock()
            .map(|list| {
                list.iter()
                    .filter(|event| {
                        event["transfer_id"].as_u64() == Some(transfer_id)
                            && event["attempt"].as_u64() == Some(attempt)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// True when `event` is a running event of `transfer_id` at or past `bytes`.
fn running_past(event: &Value, transfer_id: u32, bytes: u64) -> bool {
    event["transfer_id"].as_u64() == Some(u64::from(transfer_id))
        && event["phase"].as_str() == Some("running")
        && event["bytes_sent"]
            .as_u64()
            .is_some_and(|sent| sent >= bytes)
}

/// Connect with the pinned main-port key and password. Returns the connection
/// ID and the canonical home path.
async fn open_session(app: &tauri::App<tauri::test::MockRuntime>, env: &Env) -> (String, String) {
    let step = connect(
        app,
        env,
        env.port_main,
        &env.user,
        PASSWORD_METHOD,
        ConnectOptions {
            password: Some(&env.password),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("password connect succeeds");
    assert_eq!(
        step_kind(&step),
        "connected",
        "connect did not reach connected: {step}"
    );
    let home = step["home_path"].as_str().unwrap_or_default().to_string();
    (connection_id(&step), home)
}

/// The transfer recovery session that authorizes checkpoint reads and writes.
fn recovery_session(app: &tauri::App<tauri::test::MockRuntime>) -> String {
    let _guard = crate::lock_storage_meta().expect("storage metadata lock");
    crate::load_or_create_transfer_recovery_session_unchecked(app.handle())
        .expect("transfer recovery session")
}

/// The checkpoint JSON for `id`, parsed, or `None` when it is absent.
fn checkpoint_of(app: &tauri::App<tauri::test::MockRuntime>, id: &str) -> Option<Value> {
    let session = recovery_session(app);
    crate::load_transfer_checkpoint_json(app.handle(), id, &session)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
}

fn upload_grant(source: &Path) -> String {
    let len = std::fs::metadata(source)
        .expect("upload source metadata")
        .len();
    mint(GrantPurpose::UploadFile, source, false, Some(len))
}

fn download_grant(dest_dir: &Path) -> String {
    mint(GrantPurpose::DownloadDestination, dest_dir, true, None)
}

#[allow(clippy::too_many_arguments)]
async fn upload(
    app: &tauri::App<tauri::test::MockRuntime>,
    connection: &str,
    remote_path: &str,
    source: &Path,
    transfer_id: u32,
    overwrite: bool,
    bandwidth: Option<u32>,
) -> Result<u64, String> {
    crate::sftp::transfer::sftp_upload_inner(
        app.handle().clone(),
        app.state::<AppState>(),
        connection.to_string(),
        remote_path.to_string(),
        upload_grant(source),
        transfer_id,
        Some(1),
        overwrite,
        bandwidth,
    )
    .await
    .and_then(no_cleanup_warning)
    .map(|outcome| outcome.bytes_written)
}

/// A cleanup warning means a leftover file on the server. None of these checks
/// expects one, so it fails the call.
fn no_cleanup_warning(
    outcome: crate::sftp::types::SftpUploadOutcome,
) -> Result<crate::sftp::types::SftpUploadOutcome, String> {
    match &outcome.warning {
        None => Ok(outcome),
        Some(warning) => Err(format!("unexpected cleanup warning: {}", warning)),
    }
}

async fn upload_bytes(
    app: &tauri::App<tauri::test::MockRuntime>,
    connection: &str,
    remote_path: &str,
    bytes: &[u8],
    transfer_id: u32,
    overwrite: Option<bool>,
) -> Result<(), String> {
    crate::sftp::transfer::sftp_upload_bytes_inner(
        app.handle().clone(),
        app.state::<AppState>(),
        connection.to_string(),
        remote_path.to_string(),
        B64.encode(bytes),
        transfer_id,
        Some(1),
        overwrite,
    )
    .await
    .and_then(no_cleanup_warning)
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn download(
    app: &tauri::App<tauri::test::MockRuntime>,
    connection: &str,
    remote_path: &str,
    dest_dir: &Path,
    dest_name: &str,
    transfer_id: u32,
    overwrite: bool,
    attempt: u32,
    checkpoint: Option<&str>,
    session: &str,
    bandwidth: Option<u32>,
) -> Result<u64, String> {
    crate::sftp::transfer::sftp_download_inner(
        app.handle().clone(),
        app.state::<AppState>(),
        connection.to_string(),
        remote_path.to_string(),
        download_grant(dest_dir),
        Some(dest_name.to_string()),
        transfer_id,
        overwrite,
        Some(attempt),
        checkpoint.map(str::to_string),
        session.to_string(),
        checkpoint.map(|_| true),
        bandwidth,
    )
    .await
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_uploads() {
    let test = "uploads";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-uploads");
    let local = LocalDir::new("uploads");

    // A multi-MiB upload, with its progress events captured.
    let big = pattern(6 * MIB + 333, 7);
    let source = local.path("big.bin");
    std::fs::write(&source, &big).expect("write upload source");
    let events = Events::attach(&app, "upload-progress", |_| {});
    let sent = upload(
        &app,
        &id,
        &remote.path("big.bin"),
        &source,
        2001,
        false,
        None,
    )
    .await;
    let names = remote.names();
    let server_sha = remote.sha256("big.bin");
    record(
        test,
        CHECK_UPLOAD_LARGE,
        sent.as_ref().ok() == Some(&(big.len() as u64))
            && server_sha == sha256_hex(&big)
            && no_temp_files(&names),
        json!({
            "sent": sent.as_ref().ok(),
            "error": sent.as_ref().err(),
            "server_sha256": server_sha,
            "expected_sha256": sha256_hex(&big),
            "names": names,
        }),
    );
    let progress = events.for_attempt(2001, 1);
    let total = big.len() as u64;
    let first_phase = progress.first().and_then(|e| e["phase"].as_str());
    let last = progress.last();
    record(
        test,
        CHECK_PROGRESS_UPLOAD,
        first_phase == Some("running")
            && last.is_some_and(|e| {
                e["phase"].as_str() == Some("verifying")
                    && e["bytes_sent"].as_u64() == Some(total)
                    && e["total_bytes"].as_u64() == Some(total)
            }),
        json!({
            "events": progress.len(),
            "first_phase": first_phase,
            "last": last,
        }),
    );

    // Base64 bytes through the browser fallback path.
    let small = pattern(1234, 9);
    let bytes_result = upload_bytes(&app, &id, &remote.path("small.bin"), &small, 2002, None).await;
    let names = remote.names();
    record(
        test,
        CHECK_UPLOAD_BYTES,
        bytes_result.is_ok()
            && remote.sha256("small.bin") == sha256_hex(&small)
            && no_temp_files(&names),
        json!({
            "error": bytes_result.as_ref().err(),
            "server_sha256": remote.sha256("small.bin"),
            "names": names,
        }),
    );

    // Create-only refuses an existing target and keeps its bytes.
    let original = b"original bytes on the server".to_vec();
    remote.write("existing.txt", &original);
    let replacement = pattern(4096, 11);
    let replacement_source = local.path("replacement.bin");
    std::fs::write(&replacement_source, &replacement).expect("write replacement source");
    let refused = upload(
        &app,
        &id,
        &remote.path("existing.txt"),
        &replacement_source,
        2003,
        false,
        None,
    )
    .await;
    let refused_error = refused.as_ref().err().cloned().unwrap_or_default();
    let names = remote.names();
    record(
        test,
        CHECK_CREATE_ONLY,
        refused_error.contains("already exists")
            && remote.sha256("existing.txt") == sha256_hex(&original)
            && no_temp_files(&names),
        json!({
            "error": refused_error,
            "server_sha256": remote.sha256("existing.txt"),
            "names": names,
        }),
    );

    // Overwrite replaces the target and leaves no backup or temp behind.
    let replaced = upload(
        &app,
        &id,
        &remote.path("existing.txt"),
        &replacement_source,
        2004,
        true,
        None,
    )
    .await;
    let names = remote.names();
    record(
        test,
        CHECK_OVERWRITE,
        replaced.is_ok()
            && remote.sha256("existing.txt") == sha256_hex(&replacement)
            && no_temp_files(&names),
        json!({
            "result": replaced.as_ref().ok(),
            "error": replaced.as_ref().err(),
            "server_sha256": remote.sha256("existing.txt"),
            "names": names,
        }),
    );

    // A parent folder that does not exist is refused, and nothing is created.
    let missing = upload(
        &app,
        &id,
        &remote.path("nope/file.bin"),
        &replacement_source,
        2005,
        false,
        None,
    )
    .await;
    let missing_error = missing.as_ref().err().cloned().unwrap_or_default();
    let names = remote.names();
    record(
        test,
        CHECK_MISSING_PARENT,
        missing_error.contains("Parent folder not found") && !names.iter().any(|n| n == "nope"),
        json!({ "error": missing_error, "names": names }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_upload_cancel() {
    let test = "upload_cancel";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-cancel");
    let local = LocalDir::new("cancel");
    let source = local.path("slow.bin");
    std::fs::write(&source, pattern(8 * MIB, 13)).expect("write cancel source");

    // Cancel once a megabyte has moved. The cancel arrives from the progress event itself.
    let fired = Arc::new(AtomicBool::new(false));
    let cancel_id = id.clone();
    let _events = Events::attach(&app, "upload-progress", move |event| {
        if running_past(event, 3001, MIB as u64) && !fired.swap(true, Ordering::SeqCst) {
            cancel_transfer_in_registry(&cancel_id, 3001);
        }
    });
    let result = upload(
        &app,
        &id,
        &remote.path("cancelled.bin"),
        &source,
        3001,
        false,
        Some(SLOW_MBPS),
    )
    .await;
    let names = remote.names();
    record(
        test,
        CHECK_UPLOAD_CANCEL,
        result
            .as_ref()
            .err()
            .is_some_and(|message| message.contains("Transfer cancelled"))
            && !names.iter().any(|n| n == "cancelled.bin")
            && no_temp_files(&names),
        json!({
            "error": result.as_ref().err(),
            "names": names,
        }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_upload_permissions() {
    let test = "upload_permissions";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-modes");
    let local = LocalDir::new("modes");

    // A private file is overwritten slowly. While bytes move, the temp file's mode is read. The
    // listener runs on the upload's own thread, so the upload waits while the mode is read.
    remote.write("secret.txt", b"old secret");
    remote.chmod("secret.txt", "600");
    let secret = pattern(3 * MIB, 21);
    let secret_source = local.path("secret.bin");
    std::fs::write(&secret_source, &secret).expect("write secret source");
    let seen = Arc::new(Mutex::new(None::<Vec<String>>));
    let sink = seen.clone();
    let (container, user, root) = (
        remote.container.clone(),
        remote.user.clone(),
        remote.root.clone(),
    );
    let _events = Events::attach(&app, "upload-progress", move |event| {
        if running_past(event, 3101, MIB as u64) {
            if let Ok(mut slot) = sink.lock() {
                if slot.is_none() {
                    *slot = Some(temp_modes(&container, &user, &root));
                }
            }
        }
    });
    let private = upload(
        &app,
        &id,
        &remote.path("secret.txt"),
        &secret_source,
        3101,
        true,
        Some(SLOW_MBPS),
    )
    .await;
    let private_mode = remote.mode("secret.txt");
    let names = remote.names();
    record(
        test,
        CHECK_KEEP_PRIVATE_MODE,
        private.is_ok()
            && private_mode.as_deref() == Some("600")
            && remote.sha256("secret.txt") == sha256_hex(&secret)
            && no_temp_files(&names),
        json!({
            "error": private.as_ref().err(),
            "mode": private_mode,
            "names": names,
        }),
    );
    let temp_modes = seen.lock().ok().and_then(|slot| slot.clone());
    record(
        test,
        CHECK_TEMP_PRIVATE,
        temp_modes.as_ref().is_some_and(|modes| {
            !modes.is_empty() && modes.iter().all(|line| line.starts_with("600 "))
        }),
        json!({ "temp_modes": temp_modes }),
    );

    // An executable keeps its execute bits.
    remote.write("tool.sh", b"#!/bin/sh\necho old\n");
    remote.chmod("tool.sh", "755");
    let script = b"#!/bin/sh\necho new\n".to_vec();
    let script_source = local.path("tool.sh");
    std::fs::write(&script_source, &script).expect("write script source");
    let exec = upload(
        &app,
        &id,
        &remote.path("tool.sh"),
        &script_source,
        3102,
        true,
        None,
    )
    .await;
    let exec_mode = remote.mode("tool.sh");
    record(
        test,
        CHECK_KEEP_EXEC_MODE,
        exec.is_ok()
            && exec_mode.as_deref() == Some("755")
            && remote.sha256("tool.sh") == sha256_hex(&script),
        json!({ "error": exec.as_ref().err(), "mode": exec_mode }),
    );

    // A symlink target is refused; neither the link nor the file it names changes.
    let target_bytes = b"the link's target".to_vec();
    remote.write("target.txt", &target_bytes);
    remote.symlink("link.txt", "target.txt");
    let linked = upload(
        &app,
        &id,
        &remote.path("link.txt"),
        &script_source,
        3103,
        true,
        None,
    )
    .await;
    let linked_error = linked.as_ref().err().cloned().unwrap_or_default();
    let names = remote.names();
    record(
        test,
        CHECK_SYMLINK_REFUSED,
        linked_error.contains("symbolic link")
            && remote.is_symlink("link.txt")
            && remote.sha256("target.txt") == sha256_hex(&target_bytes)
            && no_temp_files(&names),
        json!({ "error": linked_error, "names": names }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_downloads() {
    let test = "downloads";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-downloads");
    remote.random("source.bin", 5 * MIB);
    let server_sha = remote.sha256("source.bin");
    let size = remote.size("source.bin").unwrap_or(0);
    let local = LocalDir::new("downloads");
    let events = Events::attach(&app, "download-progress", |_| {});

    let got = download(
        &app,
        &id,
        &remote.path("source.bin"),
        &local.0,
        "copy.bin",
        4001,
        false,
        1,
        None,
        "",
        None,
    )
    .await;
    let copy_sha = file_sha256(&local.path("copy.bin"));
    record(
        test,
        CHECK_DOWNLOAD,
        got.as_ref().ok() == Some(&size)
            && copy_sha == server_sha
            && !scratch_of(&local.path("copy.bin")).exists(),
        json!({
            "result": got.as_ref().ok(),
            "error": got.as_ref().err(),
            "server_sha256": server_sha,
            "local_sha256": copy_sha,
        }),
    );
    let progress = events.for_attempt(4001, 1);
    let first_phase = progress.first().and_then(|e| e["phase"].as_str());
    let last = progress.last();
    record(
        test,
        CHECK_PROGRESS_DOWNLOAD,
        first_phase == Some("running")
            && last.is_some_and(|e| {
                e["phase"].as_str() == Some("verifying")
                    && e["bytes_sent"].as_u64() == Some(size)
                    && e["total_bytes"].as_u64() == Some(size)
            }),
        json!({
            "events": progress.len(),
            "first_phase": first_phase,
            "last": last,
        }),
    );

    // Create-only refuses an existing local file and leaves it as it was.
    let existing = local.path("exists.bin");
    std::fs::write(&existing, b"local original").expect("write local destination");
    let refused = download(
        &app,
        &id,
        &remote.path("source.bin"),
        &local.0,
        "exists.bin",
        4002,
        false,
        1,
        None,
        "",
        None,
    )
    .await;
    let refused_error = refused.as_ref().err().cloned().unwrap_or_default();
    record(
        test,
        CHECK_DOWNLOAD_CREATE_ONLY,
        refused_error.contains("already exists")
            && std::fs::read(&existing).ok().as_deref() == Some(b"local original".as_slice())
            && !scratch_of(&existing).exists(),
        json!({
            "error": refused_error,
            "scratch_exists": scratch_of(&existing).exists(),
        }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_download_resume() {
    let test = "download_resume";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-resume");
    remote.random("big.bin", 6 * MIB);
    let size = remote.size("big.bin").unwrap_or(0);
    let server_sha = remote.sha256("big.bin");
    let local = LocalDir::new("resume");
    let session = recovery_session(&app);
    let checkpoint = "e2e-resume-checkpoint-1";

    // Attempt 1 is cancelled once a megabyte has moved.
    let fired = Arc::new(AtomicBool::new(false));
    let cancel_id = id.clone();
    let events = Events::attach(&app, "download-progress", move |event| {
        if running_past(event, 4101, MIB as u64) && !fired.swap(true, Ordering::SeqCst) {
            cancel_transfer_in_registry(&cancel_id, 4101);
        }
    });
    let first = download(
        &app,
        &id,
        &remote.path("big.bin"),
        &local.0,
        "out.bin",
        4101,
        false,
        1,
        Some(checkpoint),
        &session,
        Some(SLOW_MBPS),
    )
    .await;
    let scratch = scratch_of(&local.path("out.bin"));
    let scratch_len = std::fs::metadata(&scratch).map(|m| m.len()).ok();
    let saved = checkpoint_of(&app, checkpoint);
    let bytes_written = saved.as_ref().and_then(|cp| cp["bytes_written"].as_u64());
    let kept = first
        .as_ref()
        .err()
        .is_some_and(|message| message.contains("Transfer cancelled"))
        && scratch_len.is_some()
        && scratch_len == bytes_written
        && bytes_written.is_some_and(|written| written >= MIB as u64 && written < size)
        && saved
            .as_ref()
            .is_some_and(|cp| cp["protocol"] == "sftp" && cp["mode"] == "sftp_download");

    // Attempt 2 reuses the checkpoint and must start from the saved offset.
    let second = download(
        &app,
        &id,
        &remote.path("big.bin"),
        &local.0,
        "out.bin",
        4102,
        false,
        2,
        Some(checkpoint),
        &session,
        None,
    )
    .await;
    let resumed = events.for_attempt(4102, 2);
    let first_event = resumed.first();
    let resumed_from = first_event.and_then(|e| e["bytes_sent"].as_u64());
    let resume_ok = first_event.is_some_and(|e| e["phase"].as_str() == Some("resuming"))
        && resumed_from.is_some_and(|from| from > 0 && Some(from) == bytes_written && from < size);
    let copy_sha = file_sha256(&local.path("out.bin"));
    record(
        test,
        CHECK_RESUME,
        kept && second.as_ref().ok() == Some(&size)
            && resume_ok
            && copy_sha == server_sha
            && checkpoint_of(&app, checkpoint).is_none()
            && !scratch.exists(),
        json!({
            "first_error": first.as_ref().err(),
            "scratch_length": scratch_len,
            "checkpoint_bytes_written": bytes_written,
            "second_result": second.as_ref().ok(),
            "second_error": second.as_ref().err(),
            "resumed_from": resumed_from,
            "first_resumed_phase": first_event.and_then(|e| e["phase"].as_str()),
            "server_sha256": server_sha,
            "local_sha256": copy_sha,
        }),
    );

    // The remote file changes between attempts. The next attempt must restart.
    let changed_checkpoint = "e2e-resume-checkpoint-2";
    let fired = Arc::new(AtomicBool::new(false));
    let cancel_id = id.clone();
    let events = Events::attach(&app, "download-progress", move |event| {
        if running_past(event, 4201, MIB as u64) && !fired.swap(true, Ordering::SeqCst) {
            cancel_transfer_in_registry(&cancel_id, 4201);
        }
    });
    remote.random("moving.bin", 6 * MIB);
    let interrupted = download(
        &app,
        &id,
        &remote.path("moving.bin"),
        &local.0,
        "moved.bin",
        4201,
        false,
        1,
        Some(changed_checkpoint),
        &session,
        Some(SLOW_MBPS),
    )
    .await;
    remote.append("moving.bin", "APPENDED-BY-EXTERNAL-WRITER");
    let new_size = remote.size("moving.bin").unwrap_or(0);
    let new_sha = remote.sha256("moving.bin");
    let restarted = download(
        &app,
        &id,
        &remote.path("moving.bin"),
        &local.0,
        "moved.bin",
        4202,
        false,
        2,
        Some(changed_checkpoint),
        &session,
        None,
    )
    .await;
    let attempt_two = events.for_attempt(4202, 2);
    let first_two = attempt_two.first();
    let copy_sha = file_sha256(&local.path("moved.bin"));
    record(
        test,
        CHECK_RESUME_CHANGED,
        interrupted
            .as_ref()
            .err()
            .is_some_and(|message| message.contains("Transfer cancelled"))
            && first_two.is_some_and(|e| {
                e["phase"].as_str() == Some("running") && e["bytes_sent"].as_u64() == Some(0)
            })
            && restarted.as_ref().ok() == Some(&new_size)
            && copy_sha == new_sha
            && new_size == size + "APPENDED-BY-EXTERNAL-WRITER".len() as u64,
        json!({
            "interrupted_error": interrupted.as_ref().err(),
            "first_phase": first_two.and_then(|e| e["phase"].as_str()),
            "first_bytes": first_two.and_then(|e| e["bytes_sent"].as_u64()),
            "restart_result": restarted.as_ref().ok(),
            "restart_error": restarted.as_ref().err(),
            "remote_size": new_size,
            "server_sha256": new_sha,
            "local_sha256": copy_sha,
        }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_download_remote_change() {
    let test = "download_remote_change";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-change");
    remote.random("moving.bin", 6 * MIB);
    let remote_path = remote.path("moving.bin");
    let local = LocalDir::new("change");
    let session = recovery_session(&app);
    let checkpoint = "e2e-change-checkpoint";

    // An external writer appends to the file once the download is under way.
    let fired = Arc::new(AtomicBool::new(false));
    let container = env.container.clone();
    let user = env.user.clone();
    let writer_path = remote_path.clone();
    let _events = Events::attach(&app, "download-progress", move |event| {
        if running_past(event, 4301, 512 * 1024) && !fired.swap(true, Ordering::SeqCst) {
            let (container, user, path) = (container.clone(), user.clone(), writer_path.clone());
            std::thread::spawn(move || {
                let _ = remote_sh(
                    &container,
                    &user,
                    &[("P", path.as_str())],
                    "printf '%s' EXTRA >> \"$P\"",
                );
            });
        }
    });
    let result = download(
        &app,
        &id,
        &remote_path,
        &local.0,
        "changed.bin",
        4301,
        false,
        1,
        Some(checkpoint),
        &session,
        Some(SLOW_MBPS),
    )
    .await;
    let destination = local.path("changed.bin");
    record(
        test,
        CHECK_REMOTE_CHANGE,
        result
            .as_ref()
            .err()
            .is_some_and(|message| message.contains("changed during download"))
            && !destination.exists()
            && !scratch_of(&destination).exists()
            && checkpoint_of(&app, checkpoint).is_none(),
        json!({
            "error": result.as_ref().err(),
            "destination_exists": destination.exists(),
            "scratch_exists": scratch_of(&destination).exists(),
            "checkpoint_present": checkpoint_of(&app, checkpoint).is_some(),
        }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_hardlink_refused() {
    let test = "hardlink_refused";
    let env = env();
    let app = make_app();
    // The nolink port serves the main host keys, so the main pin applies. Its sftp-server denies
    // hardlink requests, and OpenSSH then stops advertising the extension, so this exercises the
    // lstat + rename commit that servers without hardlinks get.
    let step = connect(
        &app,
        &env,
        env.port_nolink,
        &env.user,
        PASSWORD_METHOD,
        ConnectOptions {
            password: Some(&env.password),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await;
    let connected = step
        .as_ref()
        .ok()
        .filter(|step| step_kind(step) == "connected");
    let capability = connected.and_then(|step| step["create_only_supported"].as_bool());
    record(
        test,
        CHECK_NOLINK_CAPABILITY,
        capability == Some(false),
        json!({
            "error": step.as_ref().err(),
            "step": step.as_ref().ok().map(step_kind),
            "create_only_supported": capability,
        }),
    );
    let Some(connected) = connected else {
        panic!("nolink connect did not reach connected: {:?}", step);
    };
    let id = connection_id(connected);
    let home = connected["home_path"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let remote = RemoteDir::new(&env, &home, "transfer-nolink");
    let local = LocalDir::new("nolink");

    let fresh = pattern(256 * 1024 + 5, 31);
    let source = local.path("fresh.bin");
    std::fs::write(&source, &fresh).expect("write nolink source");
    let sent = upload(
        &app,
        &id,
        &remote.path("fresh.bin"),
        &source,
        2101,
        false,
        None,
    )
    .await;
    let names = remote.names();
    record(
        test,
        CHECK_NOLINK_UPLOAD,
        sent.as_ref().ok() == Some(&(fresh.len() as u64))
            && remote.sha256("fresh.bin") == sha256_hex(&fresh)
            && no_temp_files(&names),
        json!({
            "error": sent.as_ref().err(),
            "server_sha256": remote.sha256("fresh.bin"),
            "names": names,
        }),
    );

    let original = b"kept by create-only".to_vec();
    remote.write("kept.txt", &original);
    let refused = upload(
        &app,
        &id,
        &remote.path("kept.txt"),
        &source,
        2102,
        false,
        None,
    )
    .await;
    let refused_error = refused.as_ref().err().cloned().unwrap_or_default();
    let names = remote.names();
    record(
        test,
        CHECK_NOLINK_REFUSE,
        refused_error.contains("already exists")
            && remote.sha256("kept.txt") == sha256_hex(&original)
            && no_temp_files(&names),
        json!({ "error": refused_error, "names": names }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_silent_drop() {
    let test = "silent_drop";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-silent-drop");
    remote.random("frozen.bin", 6 * MIB);
    let local = LocalDir::new("silent-drop");

    // Freeze the whole server once the download is moving. No FIN or RST reaches the client: the
    // packets simply stop, as on a dropped Wi-Fi link.
    let fired = Arc::new(AtomicBool::new(false));
    let container = env.container.clone();
    let _events = Events::attach(&app, "download-progress", move |event| {
        if running_past(event, 4401, 512 * 1024) && !fired.swap(true, Ordering::SeqCst) {
            let _ = Command::new("docker").args(["pause", &container]).status();
        }
    });
    let unpause = Unpause(env.container.clone());
    let started = std::time::Instant::now();
    let result = download(
        &app,
        &id,
        &remote.path("frozen.bin"),
        &local.0,
        "frozen.bin",
        4401,
        false,
        1,
        None,
        "",
        Some(SLOW_MBPS),
    )
    .await;
    let elapsed = started.elapsed();
    drop(unpause);
    let lost = result
        .as_ref()
        .err()
        .is_some_and(|message| message.starts_with(SFTP_CONNECTION_LOST));
    record(
        test,
        CHECK_SILENT_DROP,
        lost && elapsed < Duration::from_secs(75)
            && !local.path("frozen.bin").exists()
            && !scratch_of(&local.path("frozen.bin")).exists(),
        json!({
            "error": result.as_ref().err(),
            "elapsed_ms": elapsed.as_millis() as u64,
        }),
    );
    drop(app);
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_transfer_session_guards() {
    let test = "transfer_session_guards";
    let env = env();
    let app = make_app();
    // A live session proves the stale ID is refused for its value, not for a missing session.
    let (_live_id, home) = open_session(&app, &env).await;
    let remote = RemoteDir::new(&env, &home, "transfer-guards");
    let local = LocalDir::new("guards");
    let source = local.path("guard.bin");
    std::fs::write(&source, pattern(64 * 1024, 17)).expect("write guard source");
    let session = recovery_session(&app);

    // A stale connection ID is refused before any gate, source or server call.
    let stale_upload = upload(
        &app,
        BOGUS_CONNECTION_ID,
        &remote.path("stale.bin"),
        &source,
        5001,
        false,
        None,
    )
    .await;
    let stale_bytes = upload_bytes(
        &app,
        BOGUS_CONNECTION_ID,
        &remote.path("stale-bytes.bin"),
        b"stale",
        5002,
        None,
    )
    .await;
    let stale_download = download(
        &app,
        BOGUS_CONNECTION_ID,
        &remote.path("stale.bin"),
        &local.0,
        "stale-out.bin",
        5003,
        false,
        1,
        None,
        &session,
        None,
    )
    .await;
    let names = remote.names();
    let stale_refused = stale_upload.is_err() && stale_bytes.is_err() && stale_download.is_err();
    record(
        test,
        CHECK_STALE,
        stale_refused
            && names.is_empty()
            && !local.path("stale-out.bin").exists()
            && !scratch_of(&local.path("stale-out.bin")).exists(),
        json!({
            "upload_error": stale_upload.as_ref().err(),
            "bytes_error": stale_bytes.as_ref().err(),
            "download_error": stale_download.as_ref().err(),
            "names": names,
        }),
    );
    drop(app);

    // The server drops the SSH session. Every transfer must report the loss.
    let app = make_app();
    let (id, _home) = open_session(&app, &env).await;
    let session = recovery_session(&app);
    remote.random("lost-source.bin", 64 * 1024);
    let registered = require_session(&app.state::<AppState>(), &id, None).expect("live session");
    let killed = kill_server_sessions(&env.container, &env.user).unwrap_or(0);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut closed = false;
    while std::time::Instant::now() < deadline {
        if registered.handle.ssh.is_closed() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(registered);

    let lost_upload = upload(
        &app,
        &id,
        &remote.path("lost.bin"),
        &source,
        5101,
        false,
        None,
    )
    .await;
    let lost_download = download(
        &app,
        &id,
        &remote.path("lost-source.bin"),
        &local.0,
        "lost-out.bin",
        5102,
        false,
        1,
        None,
        &session,
        None,
    )
    .await;
    let lost_prefix = |result: &Result<u64, String>| {
        result
            .as_ref()
            .err()
            .is_some_and(|message| message.starts_with(SFTP_CONNECTION_LOST))
    };
    let all_lost = lost_prefix(&lost_upload) && lost_prefix(&lost_download);
    let local_clean =
        !local.path("lost-out.bin").exists() && !scratch_of(&local.path("lost-out.bin")).exists();
    drop(app);

    // Reconnect, then look at the server: no target and no temp file may remain.
    let app = make_app();
    let (fresh_id, _) = open_session(&app, &env).await;
    let listing =
        crate::sftp::sftp_list_dir(app.state::<AppState>(), fresh_id, remote.root.clone()).await;
    let names = remote.names();
    let clean_after_reconnect = listing.is_ok()
        && no_temp_files(&names)
        && !names.iter().any(|n| n == "lost.bin" || n == "lost-out.bin");
    record(
        test,
        CHECK_LOST,
        killed > 0 && closed && all_lost && local_clean && clean_after_reconnect,
        json!({
            "killed_server_sessions": killed,
            "handle_closed": closed,
            "upload_error": lost_upload.as_ref().err(),
            "download_error": lost_download.as_ref().err(),
            "local_clean": local_clean,
            "names_after_reconnect": names,
        }),
    );
    drop(app);
}
