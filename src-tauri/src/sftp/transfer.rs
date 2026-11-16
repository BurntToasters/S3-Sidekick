//! SFTP upload and download commands.
//!
//! The webview names an upload source and a download destination only by the
//! grant tokens the native dialogs issue. It never names a local path.

//! Failure modes, enumerated before the bodies:
//! - A path reaches the server unvalidated, or a stale connection ID starts work. The path is
//!   validated, then `require_session` checks the ID before any gate or server call.
//! - The upload source is reopened by path, or its size drifts unnoticed. The granted handle is
//!   streamed, and the source must end exactly at the size it was granted.
//! - Partial bytes become visible at the target. Data goes to a hidden temp sibling, and the target
//!   appears only through a hardlink or a rename after the temp size is checked.
//! - A create-only upload replaces an existing target. A hardlink is atomic. Without one, an lstat
//!   runs before the rename, which leaves a narrow race (see `commit_create_only`).
//! - An overwrite loses the old target when the publish fails. The target is swapped to a backup
//!   first, and the backup is restored when the rename fails.
//! - An overwrite loosens or drops the target's permissions, or exposes the new bytes while they
//!   upload. The temp is created at 0600 and given the target's permission bits before the swap.
//! - An overwrite replaces a symlink with a regular file. A symlink target is refused.

//! - A cancelled or dead transport reports success. Streaming races the cancel token. Finalization
//!   does not, so a cancel before the commit never publishes and a commit is never reported as
//!   cancelled.
//! - A download scratch is a symlink, or the renderer names it. The scratch path is derived by
//!   `download_temp_path`, opened without following links, and identity-checked before publication.
//! - A resume splices bytes from another remote generation, or from another user's file at the same
//!   path. The checkpoint must match the endpoint, username, path, size, mtime, scratch identity
//!   and scratch length, or the download restarts from zero.
//! - A checkpoint from another protocol is misread. It carries a protocol marker and refuses unknown
//!   fields, and the S3 checkpoint parser rejects this shape.
//! - A remote change during a download publishes stale bytes. The open handle and the path are both
//!   compared with the size and mtime read before the first byte.
//! - A checkpoint records bytes that are not on disk. The scratch is fsynced before a checkpoint
//!   records its length.

use std::future::Future;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::File as RemoteFile;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::fs::{
    already_exists, call, classify, free_backup_path, is_dir, is_symlink, kind_of,
    leftover_backup_warning, validated_path, CallError, LEASE_NAMESPACE, MAX_NAME_BYTES,
};
use super::path::{join_remote, split_parent};
use super::session::{map_sftp_error, require_session, RegisteredSftp, SftpHandle};
use super::types::{SftpEntryKind, SftpUploadOutcome};
use crate::s3::{
    acquire_transfer_storage_cancellable, cancelled_error, clamp_bandwidth_limit_bps,
    compute_speed_eta, encode_transfer_error, normalize_attempt, now_ms, CancelToken,
};
use crate::{AppState, S3MutationScope};

/// Largest browser-supplied upload. Matches the cap the S3 fallback applies.
const MAX_UPLOAD_BYTES: usize = 16 * 1024 * 1024;
const STREAM_BUFFER_BYTES: usize = 128 * 1024;
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);
const CHECKPOINT_STEP_BYTES: u64 = 16 * 1024 * 1024;
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(3);
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const TEMP_NONCE_ATTEMPTS: usize = 8;
/// Mode of the temp file while it holds the bytes of an overwrite, so the new content is never
/// readable by more users than the file it replaces.
const PRIVATE_TEMP_MODE: u32 = 0o600;
/// Permission bits an overwrite carries over from the file it replaces. Set-user-ID, set-group-ID
/// and sticky bits are dropped: the new content was not vetted for them.
const KEPT_MODE_BITS: u32 = 0o777;
/// The message for a remote file that moved while it was being read.
const CHANGED_DURING_DOWNLOAD: &str =
    "The remote file changed during download; nothing was published and the partial copy was discarded";

/// Upload a granted local file to a remote path and return the bytes written.
#[tauri::command(async)]
pub(crate) fn sftp_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    upload_token: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: bool,
    bandwidth_limit_mbps: Option<u32>,
) -> impl std::future::Future<Output = Result<SftpUploadOutcome, String>> + Send + use<'_> {
    Box::pin(sftp_upload_inner(
        app,
        state,
        connection_id,
        path,
        upload_token,
        transfer_id,
        attempt,
        overwrite,
        bandwidth_limit_mbps,
    ))
}

/// The upload body, generic over the runtime so the E2E checks can drive it on the mock app.
pub(crate) async fn sftp_upload_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    upload_token: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: bool,
    bandwidth_limit_mbps: Option<u32>,
) -> Result<SftpUploadOutcome, String> {
    let path = validated_path(&path)?;
    // Register before waiting for the storage gate, so a pause or cancel sent during the wait
    // reaches this transfer.
    let registered = require_session(&state, &connection_id, Some(transfer_id))?;
    let token = registered.token();
    let _storage_guard = acquire_transfer_storage_cancellable(&token).await?;
    // Re-check the grant and keep the opened handle. The bytes sent are then the bytes it named.
    let source = crate::path_authority::revalidate_upload_source(&upload_token)?;
    let expected = source.size;
    let mut file = tokio::fs::File::from_std(source.file);
    let _lease = crate::acquire_s3_mutation_cancellable(
        vec![S3MutationScope::key(&connection_id, LEASE_NAMESPACE, &path)],
        &token,
    )
    .await?;
    upload_stream(
        &app,
        &registered,
        &path,
        &mut file,
        expected,
        transfer_id,
        normalize_attempt(attempt),
        overwrite,
        clamp_bandwidth_limit_bps(bandwidth_limit_mbps),
    )
    .await
}

/// Upload base64-encoded bytes to a remote path. The bytes are not a local path.
#[tauri::command(async)]
pub(crate) fn sftp_upload_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    bytes_base64: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
) -> impl std::future::Future<Output = Result<SftpUploadOutcome, String>> + Send + use<'_> {
    Box::pin(sftp_upload_bytes_inner(
        app,
        state,
        connection_id,
        path,
        bytes_base64,
        transfer_id,
        attempt,
        overwrite,
    ))
}

/// The byte-upload body, generic over the runtime for the same reason as `sftp_upload_inner`.
pub(crate) async fn sftp_upload_bytes_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    bytes_base64: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
) -> Result<SftpUploadOutcome, String> {
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, Some(transfer_id))?;
    let token = registered.token();
    let _storage_guard = acquire_transfer_storage_cancellable(&token).await?;
    // Reject an oversized payload before decoding, so a compromised webview cannot force the
    // allocation.
    let max_encoded_len = MAX_UPLOAD_BYTES / 3 * 4 + 4;
    if bytes_base64.trim().len() > max_encoded_len {
        return Err(upload_limit_message());
    }
    let bytes = B64
        .decode(bytes_base64.trim())
        .map_err(|err| format!("Invalid browser upload payload: {err}"))?;
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(upload_limit_message());
    }
    let _lease = crate::acquire_s3_mutation_cancellable(
        vec![S3MutationScope::key(&connection_id, LEASE_NAMESPACE, &path)],
        &token,
    )
    .await?;
    let expected = bytes.len() as u64;
    let mut source: &[u8] = &bytes;
    upload_stream(
        &app,
        &registered,
        &path,
        &mut source,
        expected,
        transfer_id,
        normalize_attempt(attempt),
        overwrite.unwrap_or(false),
        0,
    )
    .await
}

fn upload_limit_message() -> String {
    format!(
        "Browser upload fallback is limited to {} MB.",
        MAX_UPLOAD_BYTES / (1024 * 1024)
    )
}

/// Download a remote file to a granted local destination and return the bytes
/// written. `checkpoint_id` and `enable_resume` control resumable downloads, and
/// `recovery_session` authorizes the checkpoint store.
#[tauri::command(async)]
pub(crate) fn sftp_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    destination_token: String,
    destination_name: Option<String>,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checkpoint_id: Option<String>,
    recovery_session: String,
    enable_resume: Option<bool>,
    bandwidth_limit_mbps: Option<u32>,
) -> impl std::future::Future<Output = Result<u64, String>> + Send + use<'_> {
    Box::pin(sftp_download_inner(
        app,
        state,
        connection_id,
        path,
        destination_token,
        destination_name,
        transfer_id,
        overwrite,
        attempt,
        checkpoint_id,
        recovery_session,
        enable_resume,
        bandwidth_limit_mbps,
    ))
}

/// The download body, generic over the runtime for the same reason as `sftp_upload_inner`.
pub(crate) async fn sftp_download_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    destination_token: String,
    destination_name: Option<String>,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checkpoint_id: Option<String>,
    recovery_session: String,
    enable_resume: Option<bool>,
    bandwidth_limit_mbps: Option<u32>,
) -> Result<u64, String> {
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, Some(transfer_id))?;
    let token = registered.token();
    let _storage_guard = acquire_transfer_storage_cancellable(&token).await?;
    let checkpoint_id = checkpoint_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let checkpoint = match checkpoint_id {
        Some(id) if enable_resume.unwrap_or(true) => Some((id, recovery_session.clone())),
        _ => None,
    };
    if checkpoint.is_some() {
        crate::validate_transfer_recovery_session(&app, &recovery_session)?;
    }
    // The destination is a file the user picked, or one backend-validated name inside a folder
    // they picked. The webview never supplies an absolute path.
    let destination =
        crate::resolve_download_destination(&destination_token, destination_name.as_deref())?;
    if overwrite {
        crate::validate_destination_path_allow_overwrite_parsed(&destination)?;
    } else {
        crate::validate_destination_path_parsed(&destination)?;
    }
    crate::validate_user_write_target(&app, &destination)?;
    // Derived here, never accepted from the caller: see `download_object`.
    let temp = crate::download_temp_path(&destination);
    if temp == destination {
        return Err("Temp path must be different from destination".to_string());
    }
    let claim = {
        let (temp, destination) = (temp.clone(), destination.clone());
        crate::security::run_blocking(move || crate::claim_download_temp(&temp, &destination))
            .await?
    };
    let parent = claim.parent_identity();
    let nonce = {
        let (app, destination, temp) = (app.clone(), destination.clone(), temp.clone());
        crate::security::run_blocking(move || {
            crate::issue_download_scratch_lease(&app, &destination, &temp)
        })
        .await?
    };
    if checkpoint.is_none() {
        // Without a checkpoint nothing can resume, so a leftover scratch is only a hazard.
        let temp = temp.clone();
        crate::security::run_blocking(move || crate::clear_unusable_download_scratch(&temp))
            .await?;
    }
    let target = DownloadTarget {
        destination,
        temp,
        overwrite,
        parent,
        checkpoint,
    };
    let result = run_download(
        &app,
        &registered,
        &path,
        &target,
        transfer_id,
        normalize_attempt(attempt),
        clamp_bandwidth_limit_bps(bandwidth_limit_mbps),
    )
    .await;
    // A retained scratch keeps its lease, so a later purge still finds it. Once the scratch is
    // gone, nothing needs the lease.
    if !tokio::fs::try_exists(&target.temp).await.unwrap_or(true) {
        let (app, destination) = (app.clone(), target.destination.clone());
        let _ = tokio::task::spawn_blocking(move || {
            crate::release_download_scratch_lease(&app, &destination, &nonce)
        })
        .await;
    }
    result
}

/// Checkpoint protocol marker. S3 checkpoints never carry it.
const CHECKPOINT_PROTOCOL: &str = "sftp";
const CHECKPOINT_MODE: &str = "sftp_download";
/// Version 2 added `username`. A version 1 checkpoint is refused, so its download restarts.
const CHECKPOINT_VERSION: u8 = 2;

/// The resumable state of one SFTP download, stored as the checkpoint JSON.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SftpDownloadCheckpoint {
    protocol: String,
    version: u8,
    mode: String,
    endpoint: String,
    username: String,
    remote_path: String,
    destination: String,
    temp_path: String,
    size: u64,
    mtime: u64,
    bytes_written: u64,
    scratch_device: Option<u64>,
    scratch_inode: Option<u64>,
    updated_at_ms: i64,
}

/// What a checkpoint must still match before its scratch bytes are trusted.
#[derive(Clone, Debug, PartialEq, Eq)]
struct DownloadIdentity {
    endpoint: String,
    username: String,
    remote_path: String,
    destination: String,
    temp_path: String,
    size: u64,
    mtime: u64,
}

/// Identity of the scratch file a checkpoint's bytes were written into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScratchId {
    device: u64,
    inode: u64,
}

/// The remote file's size and modification time, as measured before the first byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RemoteIdentity {
    size: u64,
    mtime: u64,
}

/// A download's destination, derived scratch, and the grants it holds.
struct DownloadTarget {
    destination: PathBuf,
    temp: PathBuf,
    overwrite: bool,
    parent: crate::DestinationParentIdentity,
    /// The checkpoint ID and the recovery session that authorizes it.
    checkpoint: Option<(String, String)>,
}

/// Why a download stopped before publication.
enum Stop {
    /// The remote file no longer matches the bytes read. Everything is discarded.
    Changed(String),
    /// A cancel, a lost connection, or a local error. A checkpointed scratch is kept.
    Failed(String),
}

/// A temp sibling name for an upload: hidden, marked, and 16 random hex digits. `None` when the
/// name would exceed the file-name limit.
fn temp_leaf(leaf: &str, nonce: u64) -> Option<String> {
    let name = format!(".{}.s3sk-{:016x}.part", leaf, nonce);
    (name.len() <= MAX_NAME_BYTES).then_some(name)
}

/// Parse a checkpoint, accepting only this protocol's shape.
fn parse_checkpoint(json: &str) -> Option<SftpDownloadCheckpoint> {
    let saved: SftpDownloadCheckpoint = serde_json::from_str(json).ok()?;
    let ours = saved.protocol == CHECKPOINT_PROTOCOL
        && saved.mode == CHECKPOINT_MODE
        && saved.version == CHECKPOINT_VERSION;
    ours.then_some(saved)
}

/// The byte offset a download may resume from, or 0 when it must restart. Every identity field
/// must match, the scratch must be the same file, and its length must be exactly the length the
/// checkpoint records.
fn resume_offset(
    saved: &SftpDownloadCheckpoint,
    want: &DownloadIdentity,
    scratch_len: u64,
    scratch: Option<ScratchId>,
) -> u64 {
    let same_remote = saved.endpoint == want.endpoint
        && saved.username == want.username
        && saved.remote_path == want.remote_path
        && saved.size == want.size
        && saved.mtime == want.mtime;
    let same_files = saved.destination == want.destination && saved.temp_path == want.temp_path;
    let same_scratch = match (saved.scratch_device, saved.scratch_inode, scratch) {
        (Some(device), Some(inode), Some(actual)) => {
            device == actual.device && inode == actual.inode
        }
        _ => false,
    };
    let in_range = saved.bytes_written <= saved.size && saved.bytes_written == scratch_len;
    if same_remote && same_files && same_scratch && in_range {
        saved.bytes_written
    } else {
        0
    }
}

/// Whether enough has moved since the last progress event to emit another.
fn progress_due(advanced: u64, since_last: Duration) -> bool {
    advanced >= PROGRESS_STEP_BYTES && since_last >= PROGRESS_MIN_INTERVAL
}

/// Whether the scratch has moved far enough past the last checkpoint to record it again.
fn checkpoint_due(advanced: u64, since_saved: Duration) -> bool {
    advanced > 0 && (advanced >= CHECKPOINT_STEP_BYTES || since_saved >= CHECKPOINT_INTERVAL)
}

/// How long to wait so the bytes moved in this attempt stay at or under the limit.
fn throttle_delay(moved: u64, bytes_per_second: u64, elapsed: Duration) -> Option<Duration> {
    if bytes_per_second == 0 {
        return None;
    }
    let target = Duration::from_secs_f64(moved as f64 / bytes_per_second as f64);
    target.checked_sub(elapsed).filter(|wait| !wait.is_zero())
}

/// The file identity a download must hold on both sides of the transfer.
fn remote_identity_of(attrs: &FileAttributes, path: &str) -> Result<RemoteIdentity, String> {
    if !matches!(kind_of(attrs.permissions), SftpEntryKind::File) {
        return Err(format!("Remote path is not a regular file: {}", path));
    }
    let size = attrs.size.ok_or_else(|| {
        format!(
            "Download is unavailable because the size of {} is unknown",
            path
        )
    })?;
    let mtime = attrs.mtime.map(u64::from).ok_or_else(|| {
        format!(
            "Download is unavailable because the modification time of {} is unknown",
            path
        )
    })?;
    Ok(RemoteIdentity { size, mtime })
}

/// Measure a remote file. A symbolic link is followed once, as the preview does, so the target's
/// kind decides what is read.
async fn remote_identity(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
) -> Result<RemoteIdentity, String> {
    let link = call(
        handle,
        token,
        context,
        handle.sftp.symlink_metadata(path.to_string()),
    )
    .await
    .map_err(|err| err.into_message(path))?;
    let attrs = if is_symlink(&link) {
        call(
            handle,
            token,
            context,
            handle.sftp.metadata(path.to_string()),
        )
        .await
        .map_err(|err| err.into_message(path))?
    } else {
        link
    };
    remote_identity_of(&attrs, path)
}

/// Await an SFTP call without the cancel race. Finalization steps use this, so a commit either
/// finishes or fails cleanly.
async fn settle<T>(
    handle: &SftpHandle,
    context: &str,
    future: impl Future<Output = Result<T, SftpError>>,
) -> Result<T, CallError> {
    future.await.map_err(|err| classify(handle, context, &err))
}

fn rename_message(err: CallError, path: &str) -> String {
    match err {
        CallError::NotFound => format!("Destination folder not found for {}", path),
        other => other.into_message(path),
    }
}

/// Confirm the parent folder exists and is a real folder, before any bytes are sent.
async fn check_parent(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    parent: &str,
) -> Result<(), String> {
    let attrs = call(
        handle,
        token,
        context,
        handle.sftp.symlink_metadata(parent.to_string()),
    )
    .await
    .map_err(|err| match err {
        CallError::NotFound => format!("Parent folder not found for {}", path),
        other => other.into_message(path),
    })?;
    if !is_dir(&attrs) {
        return Err(format!("Parent is not a folder: {}", parent));
    }
    Ok(())
}

/// Refuse a target that is anything but a regular file the upload may replace.
fn replaceable(attrs: &FileAttributes, path: &str) -> Result<(), String> {
    match kind_of(attrs.permissions) {
        SftpEntryKind::File => Ok(()),
        SftpEntryKind::Dir => Err(format!("Refusing to replace the folder {}", path)),
        SftpEntryKind::Symlink => Err(format!(
            "Refusing to replace the symbolic link {}; upload to the file it points to instead",
            path
        )),
        SftpEntryKind::Other => Err(format!(
            "Refusing to replace {}: it is not a regular file",
            path
        )),
    }
}

/// Refuse a target that cannot be published, before any bytes are sent. Returns true when an
/// overwrite will replace an existing file, so the temp starts private.
async fn check_target(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    overwrite: bool,
) -> Result<bool, String> {
    match call(
        handle,
        token,
        context,
        handle.sftp.symlink_metadata(path.to_string()),
    )
    .await
    {
        Ok(attrs) => {
            if !overwrite {
                return Err(already_exists(path));
            }
            replaceable(&attrs, path)?;
            Ok(true)
        }
        Err(CallError::NotFound) => Ok(false),
        Err(err) => Err(err.into_message(path)),
    }
}

/// Create the hidden temp sibling of `path` with an exclusive create. The name is checked free
/// first, and the create itself refuses a name that appears in between.
async fn create_temp(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    parent: &str,
    leaf: &str,
    private: bool,
) -> Result<(String, RemoteFile), String> {
    for _ in 0..TEMP_NONCE_ATTEMPTS {
        let name = temp_leaf(leaf, rand::random::<u64>()).ok_or_else(|| {
            format!(
                "Cannot upload {}: its name is too long for a temporary file name",
                path
            )
        })?;
        let candidate = join_remote(parent, &name)?;
        match call(
            handle,
            token,
            context,
            handle.sftp.symlink_metadata(candidate.clone()),
        )
        .await
        {
            Err(CallError::NotFound) => {}
            Ok(_) => continue,
            Err(err) => return Err(err.into_message(path)),
        }
        // The create is not raced against cancel: a create that completes after its caller
        // gave up would leave a file nothing refers to.
        // A new file gets the server's default mode, as `sftp put` gives it. The client cannot
        // read the server's umask, so it cannot start private and restore that default later.
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        let attributes = if private {
            FileAttributes {
                permissions: Some(PRIVATE_TEMP_MODE),
                ..FileAttributes::empty()
            }
        } else {
            FileAttributes::empty()
        };
        let file = settle(
            handle,
            context,
            handle
                .sftp
                .open_with_flags_and_attributes(candidate.clone(), flags, attributes),
        )
        .await
        .map_err(|err| err.into_message(path))?;
        return Ok((candidate, file));
    }
    Err(format!(
        "Cannot upload {}: no free temporary file name was found",
        path
    ))
}

/// Remove a temp file after a failed transfer. Best effort: a dead transport cannot be told, and
/// the name is hidden and unique.
async fn discard_temp(handle: &SftpHandle, temp: &str) {
    let _ = handle.sftp.remove_file(temp.to_string()).await;
}

/// The progress payload. Its shape matches the S3 events, so the webview reads one form for both
/// protocols.
#[derive(Clone, Serialize)]
struct ProgressEvent {
    transfer_id: u32,
    bytes_sent: u64,
    total_bytes: u64,
    attempt: u32,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed_bps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resumable: Option<bool>,
}

/// Emits the progress events of one attempt, with the S3 cadence.
struct Progress<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    event: &'static str,
    transfer_id: u32,
    attempt: u32,
    total: u64,
    /// Bytes present before this attempt. Speed and ETA count only bytes moved since.
    base: u64,
    started_at: Instant,
    last_bytes: u64,
    last_at: Instant,
    checkpoint_id: Option<String>,
    resumable: Option<bool>,
}

impl<R: tauri::Runtime> Progress<'_, R> {
    fn emit(&mut self, sent: u64, phase: &'static str) {
        let (speed_bps, eta_seconds) = compute_speed_eta(
            sent.saturating_sub(self.base),
            self.total.saturating_sub(self.base),
            self.started_at,
        );
        let _ = self.app.emit(
            self.event,
            ProgressEvent {
                transfer_id: self.transfer_id,
                bytes_sent: sent,
                total_bytes: self.total,
                attempt: self.attempt,
                phase,
                speed_bps,
                eta_seconds,
                checkpoint_id: self.checkpoint_id.clone(),
                resumable: self.resumable,
            },
        );
        self.last_bytes = sent;
        self.last_at = Instant::now();
    }

    fn tick(&mut self, sent: u64) {
        if progress_due(sent.saturating_sub(self.last_bytes), self.last_at.elapsed()) {
            self.emit(sent, "running");
        }
    }
}

/// Wait `wait`, or return the cancel as soon as it arrives.
async fn sleep_unless_cancelled(token: &CancelToken, wait: Duration) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(cancelled_error()),
        _ = tokio::time::sleep(wait) => Ok(()),
    }
}

async fn read_source<S: AsyncRead + Unpin>(
    source: &mut S,
    buffer: &mut [u8],
    token: &CancelToken,
) -> Result<usize, String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(cancelled_error()),
        result = source.read(buffer) => {
            result.map_err(|err| format!("Failed to read upload source: {}", err))
        }
    }
}

async fn write_remote(
    handle: &SftpHandle,
    context: &str,
    remote: &mut RemoteFile,
    bytes: &[u8],
    token: &CancelToken,
) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(cancelled_error()),
        result = remote.write_all(bytes) => {
            result.map_err(|err| map_sftp_error(handle, context, err))
        }
    }
}

/// Stream `source` into the temp file, bounded and throttled, then confirm it ends at `expected`.
async fn stream_source<S: AsyncRead + Unpin, R: tauri::Runtime>(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    remote: &mut RemoteFile,
    source: &mut S,
    expected: u64,
    bandwidth_bps: u64,
    started_at: Instant,
    progress: &mut Progress<'_, R>,
) -> Result<(), String> {
    let mut buffer = vec![0u8; STREAM_BUFFER_BYTES];
    let mut sent = 0u64;
    while sent < expected {
        if token.is_cancelled() {
            return Err(cancelled_error());
        }
        let want = STREAM_BUFFER_BYTES.min((expected - sent) as usize);
        let read = read_source(source, &mut buffer[..want], token).await?;
        if read == 0 {
            return Err(format!(
                "Upload source changed during upload: expected {} bytes, read {}",
                expected, sent
            ));
        }
        write_remote(handle, context, remote, &buffer[..read], token).await?;
        sent += read as u64;
        if let Some(wait) = throttle_delay(sent, bandwidth_bps, started_at.elapsed()) {
            sleep_unless_cancelled(token, wait).await?;
        }
        progress.tick(sent);
    }
    // The source must end at the size it was granted. One more byte means it grew mid-upload.
    let mut probe = [0u8; 1];
    if read_source(source, &mut probe, token).await? != 0 {
        return Err(format!(
            "Upload source changed during upload: it holds more than the {} bytes it was granted",
            expected
        ));
    }
    Ok(())
}

/// Publish a new target without replacing one. A hardlink creates the name only when nothing holds
/// it, so the check and the publish are one step. Without hardlinks, an lstat runs before the
/// rename. A file created between the two would be replaced: that window is the one this path
/// cannot close, and it exists only on servers without the hardlink extension or whose
/// filesystem refuses the link.
async fn commit_create_only(
    handle: &SftpHandle,
    context: &str,
    path: &str,
    temp: &str,
) -> Result<Option<String>, String> {
    if handle.hardlink_supported {
        match settle(
            handle,
            context,
            handle.sftp.hardlink(temp.to_string(), path.to_string()),
        )
        .await
        {
            Ok(true) => {
                // The target now holds the complete bytes; the temp name is a second link to them.
                // A failed removal leaves that second name, so the user is told where it is.
                let warning = handle
                    .sftp
                    .remove_file(temp.to_string())
                    .await
                    .err()
                    .map(|_| leftover_temp_warning(path, temp));
                return Ok(warning);
            }
            Ok(false) => {}
            Err(err) => {
                // OpenSSH reports an existing target as a generic failure, so look again. A
                // target that is still absent means the link itself failed: the extension is
                // advertised, but the filesystem (FAT, exFAT, some network mounts) refuses links.
                // That case falls through to the lstat + rename publish below.
                match settle(
                    handle,
                    context,
                    handle.sftp.symlink_metadata(path.to_string()),
                )
                .await
                {
                    Ok(_) => return Err(already_exists(path)),
                    Err(CallError::NotFound) => {}
                    Err(_) => return Err(err.into_message(path)),
                }
            }
        }
    }
    match settle(
        handle,
        context,
        handle.sftp.symlink_metadata(path.to_string()),
    )
    .await
    {
        Ok(_) => return Err(already_exists(path)),
        Err(CallError::NotFound) => {}
        Err(err) => return Err(err.into_message(path)),
    }
    settle(
        handle,
        context,
        handle.sftp.rename(temp.to_string(), path.to_string()),
    )
    .await
    .map_err(|err| rename_message(err, path))?;
    Ok(None)
}

/// Warning for a published upload whose hardlinked temp name could not be removed.
fn leftover_temp_warning(path: &str, temp: &str) -> String {
    format!(
        "{} was uploaded, but its temporary name {} could not be removed. It is a second name for the same bytes; delete it.",
        path, temp
    )
}

/// Publish over an existing target. The target is renamed aside first and put back if the publish
/// fails, so a failed overwrite never leaves the path empty.
async fn commit_overwrite(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    temp: &str,
) -> Result<Option<String>, String> {
    let existing = match settle(
        handle,
        context,
        handle.sftp.symlink_metadata(path.to_string()),
    )
    .await
    {
        Ok(attrs) => Some(attrs),
        Err(CallError::NotFound) => None,
        Err(err) => return Err(err.into_message(path)),
    };
    let Some(target) = existing else {
        settle(
            handle,
            context,
            handle.sftp.rename(temp.to_string(), path.to_string()),
        )
        .await
        .map_err(|err| rename_message(err, path))?;
        return Ok(None);
    };
    replaceable(&target, path)?;
    let backup = free_backup_path(handle, token, context, path).await?;
    settle(
        handle,
        context,
        handle.sftp.rename(path.to_string(), backup.clone()),
    )
    .await
    .map_err(|err| err.into_message(path))?;
    match settle(
        handle,
        context,
        handle.sftp.rename(temp.to_string(), path.to_string()),
    )
    .await
    {
        Ok(()) => {
            // The new target is in place, so a failed removal leaves only the hidden backup. It
            // still holds the replaced content, so the user is told.
            let warning = handle
                .sftp
                .remove_file(backup.clone())
                .await
                .err()
                .map(|_| leftover_backup_warning(path, &backup));
            Ok(warning)
        }
        Err(err) => {
            let message = rename_message(err, path);
            Err(
                match settle(
                    handle,
                    context,
                    handle.sftp.rename(backup.clone(), path.to_string()),
                )
                .await
                {
                    Ok(()) => message,
                    Err(restore) => format!(
                        "{}; the original destination could not be restored and is kept at {} ({})",
                        message,
                        backup,
                        restore.into_message(path)
                    ),
                },
            )
        }
    }
}

/// The refusal when the server will not copy the target's permissions onto the upload. The
/// target is untouched at that point, so the message says it was kept and how to replace it.
fn mode_copy_refused(path: &str, detail: &str) -> String {
    format!(
        "The server would not copy the permissions of {} to the upload ({}). The existing file was kept unchanged. Delete the remote file and upload again to replace it.",
        path, detail
    )
}

/// Give the temp the permission bits of the file it will replace, through the open handle, so
/// the swap keeps the target's mode. A target that is gone keeps the temp's own mode.
async fn keep_target_mode(
    handle: &SftpHandle,
    context: &str,
    path: &str,
    remote: &RemoteFile,
) -> Result<(), String> {
    let target = match settle(
        handle,
        context,
        handle.sftp.symlink_metadata(path.to_string()),
    )
    .await
    {
        Ok(attrs) => attrs,
        Err(CallError::NotFound) => return Ok(()),
        Err(err) => return Err(err.into_message(path)),
    };
    replaceable(&target, path)?;
    let Some(mode) = target.permissions.map(|mode| mode & KEPT_MODE_BITS) else {
        return Ok(());
    };
    remote
        .set_metadata(FileAttributes {
            permissions: Some(mode),
            ..FileAttributes::empty()
        })
        .await
        .map_err(|err| mode_copy_refused(path, &map_sftp_error(handle, context, err)))
}

/// Make the temp file durable, check its size, and publish it. Any error here leaves the target
/// as it was; the caller removes the temp.
async fn finish_upload(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    temp: &str,
    mut remote: RemoteFile,
    expected: u64,
    overwrite: bool,
) -> Result<Option<String>, String> {
    if token.is_cancelled() {
        return Err(cancelled_error());
    }
    remote
        .flush()
        .await
        .map_err(|err| map_sftp_error(handle, context, err))?;
    if overwrite {
        keep_target_mode(handle, context, path, &remote).await?;
    }
    remote
        .sync_all()
        .await
        .map_err(|err| map_sftp_error(handle, context, err))?;
    remote
        .close()
        .await
        .map_err(|err| map_sftp_error(handle, context, err))?;
    let attrs = settle(
        handle,
        context,
        handle.sftp.symlink_metadata(temp.to_string()),
    )
    .await
    .map_err(|err| err.into_message(path))?;
    let on_server = attrs.size.unwrap_or(0);
    if attrs.size != Some(expected) {
        return Err(format!(
            "Upload to {} was not written completely: sent {} bytes, the temporary file holds {}",
            path, expected, on_server
        ));
    }
    if overwrite {
        commit_overwrite(handle, token, context, path, temp).await
    } else {
        commit_create_only(handle, context, path, temp).await
    }
}

/// Upload one source to `path`. A failure after the temp file exists removes the temp, so the
/// target never holds partial bytes and an existing target survives a failed upload.
async fn upload_stream<S: AsyncRead + Unpin, R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    registered: &RegisteredSftp,
    path: &str,
    source: &mut S,
    expected: u64,
    transfer_id: u32,
    attempt: u32,
    overwrite: bool,
    bandwidth_bps: u64,
) -> Result<SftpUploadOutcome, String> {
    let handle: &SftpHandle = &registered.handle;
    let token = registered.token();
    let context = format!("upload {}", path);
    let (parent, leaf) = split_parent(path)?;
    check_parent(handle, &token, &context, path, &parent).await?;
    let replaces_file = check_target(handle, &token, &context, path, overwrite).await?;
    let (temp, mut remote) = create_temp(
        handle,
        &token,
        &context,
        path,
        &parent,
        &leaf,
        replaces_file,
    )
    .await?;
    let started_at = Instant::now();
    let mut progress = Progress {
        app,
        event: "upload-progress",
        transfer_id,
        attempt,
        total: expected,
        base: 0,
        started_at,
        last_bytes: 0,
        last_at: started_at,
        checkpoint_id: None,
        resumable: None,
    };
    progress.emit(0, "running");
    let streamed = stream_source(
        handle,
        &token,
        &context,
        &mut remote,
        source,
        expected,
        bandwidth_bps,
        started_at,
        &mut progress,
    )
    .await;
    let result = match streamed {
        Ok(()) => {
            finish_upload(
                handle, &token, &context, path, &temp, remote, expected, overwrite,
            )
            .await
        }
        Err(err) => {
            drop(remote);
            Err(err)
        }
    };
    let warning = match result {
        Ok(warning) => warning,
        Err(err) => {
            discard_temp(handle, &temp).await;
            return Err(err);
        }
    };
    progress.emit(expected, "verifying");
    Ok(SftpUploadOutcome {
        bytes_written: expected,
        warning,
    })
}

/// Open the scratch without following a link, and report its identity. A link is refused by the
/// no-follow open itself.
#[cfg(unix)]
fn no_follow_flag() -> std::io::Result<i32> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        Ok(0x0002_0000)
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        Ok(0x0000_0100)
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "no-follow download scratch opens are unsupported on this Unix platform",
        ))
    }
}

#[cfg(unix)]
fn scratch_identity(file: &std::fs::File) -> std::io::Result<Option<ScratchId>> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(Some(ScratchId {
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

#[cfg(windows)]
fn scratch_identity(file: &std::fs::File) -> std::io::Result<Option<ScratchId>> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "download scratch is a Windows reparse point",
        ));
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(
        |error| {
            std::io::Error::other(format!(
                "download scratch identity lookup failed: {}",
                error
            ))
        },
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "download scratch is a Windows reparse point",
        ));
    }
    let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    if info.dwVolumeSerialNumber == 0 || file_index == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "download scratch stable file identity is unavailable",
        ));
    }
    Ok(Some(ScratchId {
        device: u64::from(info.dwVolumeSerialNumber),
        inode: file_index,
    }))
}

#[cfg(not(any(unix, windows)))]
fn scratch_identity(_file: &std::fs::File) -> std::io::Result<Option<ScratchId>> {
    Ok(None)
}

/// Open the scratch read-write without following links, owner-only, and report its identity.
/// With `create` false, a missing scratch is an error.
fn open_scratch(path: &Path, create: bool) -> std::io::Result<(std::fs::File, Option<ScratchId>)> {
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(no_follow_flag()?).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open a link itself rather than its target, so the reparse check refuses it.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "download scratch is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `mode` applies only on creation, so tighten a scratch left under a laxer umask too.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(err) = crate::harden_private_file(path) {
        eprintln!(
            "Download scratch '{}' could not be restricted to its owner: {}",
            path.display(),
            err
        );
    }
    let identity = scratch_identity(&file)?;
    Ok((file, identity))
}

async fn open_scratch_async(
    path: PathBuf,
    create: bool,
) -> Result<(tokio::fs::File, Option<ScratchId>), String> {
    let (file, identity) = tokio::task::spawn_blocking(move || open_scratch(&path, create))
        .await
        .map_err(|err| format!("Download scratch open task failed: {}", err))?
        .map_err(|err| {
            format!(
                "Failed to open download scratch without following links: {}",
                err
            )
        })?;
    Ok((tokio::fs::File::from_std(file), identity))
}

fn checkpoint_record(
    identity: &DownloadIdentity,
    scratch: Option<ScratchId>,
    bytes_written: u64,
) -> SftpDownloadCheckpoint {
    SftpDownloadCheckpoint {
        protocol: CHECKPOINT_PROTOCOL.to_string(),
        version: CHECKPOINT_VERSION,
        mode: CHECKPOINT_MODE.to_string(),
        endpoint: identity.endpoint.clone(),
        username: identity.username.clone(),
        remote_path: identity.remote_path.clone(),
        destination: identity.destination.clone(),
        temp_path: identity.temp_path.clone(),
        size: identity.size,
        mtime: identity.mtime,
        bytes_written,
        scratch_device: scratch.map(|id| id.device),
        scratch_inode: scratch.map(|id| id.inode),
        updated_at_ms: now_ms(),
    }
}

async fn save_checkpoint<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    session: &str,
    record: &SftpDownloadCheckpoint,
) -> Result<(), String> {
    let json = serde_json::to_string(record).map_err(|err| err.to_string())?;
    let app = app.clone();
    let (id, session) = (id.to_string(), session.to_string());
    crate::security::run_blocking(move || {
        crate::save_transfer_checkpoint_json(&app, &id, &json, &session)
    })
    .await
}

async fn remove_checkpoint<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    session: &str,
) -> Result<(), String> {
    let app = app.clone();
    let (id, session) = (id.to_string(), session.to_string());
    crate::security::run_blocking(move || crate::remove_transfer_checkpoint(&app, &id, &session))
        .await
}

/// Make the scratch durable through `written`, then record that length in the checkpoint. The
/// order matters: a checkpoint must never name bytes that are not on disk.
async fn checkpoint_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint: &(String, String),
    local: &mut tokio::fs::File,
    identity: &DownloadIdentity,
    scratch: Option<ScratchId>,
    written: u64,
) -> Result<(), String> {
    local
        .flush()
        .await
        .map_err(|err| format!("Failed to flush download scratch: {}", err))?;
    local
        .sync_all()
        .await
        .map_err(|err| format!("Failed to sync download scratch: {}", err))?;
    save_checkpoint(
        app,
        &checkpoint.0,
        &checkpoint.1,
        &checkpoint_record(identity, scratch, written),
    )
    .await
}

async fn remove_scratch(temp: &Path) {
    let _ = tokio::fs::remove_file(temp).await;
}

async fn write_local(
    local: &mut tokio::fs::File,
    bytes: &[u8],
    token: &CancelToken,
) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(cancelled_error()),
        result = local.write_all(bytes) => {
            result.map_err(|err| format!("Failed to write download scratch: {}", err))
        }
    }
}

async fn read_remote(
    handle: &SftpHandle,
    context: &str,
    remote: &mut RemoteFile,
    buffer: &mut [u8],
    token: &CancelToken,
) -> Result<usize, String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(cancelled_error()),
        result = tokio::time::timeout(BODY_IDLE_TIMEOUT, remote.read(buffer)) => match result {
            Ok(read) => read.map_err(|err| map_sftp_error(handle, context, err)),
            Err(_) => Err(encode_transfer_error(
                "stalled",
                true,
                None,
                format!(
                    "Download stalled: no data received for {} seconds.",
                    BODY_IDLE_TIMEOUT.as_secs()
                ),
            )),
        },
    }
}

/// Publish the verified scratch over the destination. The scratch must still be the file that was
/// written, and the destination parent must still be the one the claim pinned.
fn publish_scratch(
    temp: &Path,
    destination: &Path,
    overwrite: bool,
    keep_temp: bool,
    parent: &crate::DestinationParentIdentity,
    expected: Option<ScratchId>,
) -> Result<(), String> {
    let (file, identity) = open_scratch(temp, false).map_err(|err| {
        format!(
            "Download scratch identity changed before publication: {}",
            err
        )
    })?;
    drop(file);
    if expected.is_some() && identity != expected {
        return Err("Download scratch identity changed before publication".to_string());
    }
    crate::verify_destination_parent_identity(destination, parent)?;
    crate::publish_download_temp_file(temp, destination, overwrite, keep_temp)
        .map_err(|err| format!("Failed to finalize download: {}", err))
}

/// Copy the remote bytes from `*written` to the end, then confirm both sides still match the
/// measurement. A stop is classified so `abandon_download` can apply the failure policy.
async fn download_body<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    path: &str,
    target: &DownloadTarget,
    identity: &DownloadIdentity,
    scratch: Option<ScratchId>,
    remote: RemoteIdentity,
    local: &mut tokio::fs::File,
    written: &mut u64,
    transfer_id: u32,
    attempt: u32,
    bandwidth_bps: u64,
) -> Result<(), Stop> {
    let fail = |err: CallError| Stop::Failed(err.into_message(path));
    let mut remote_file = call(handle, token, context, handle.sftp.open(path.to_string()))
        .await
        .map_err(fail)?;
    // The open handle pins the inode. Its metadata must match the measurement, or the file moved.
    let opened = settle(handle, context, remote_file.metadata())
        .await
        .map_err(fail)?;
    if remote_identity_of(&opened, path) != Ok(remote) {
        return Err(Stop::Changed(CHANGED_DURING_DOWNLOAD.to_string()));
    }
    let offset = *written;
    if offset > 0 {
        remote_file
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|err| Stop::Failed(map_sftp_error(handle, context, err)))?;
    }

    let started_at = Instant::now();
    let mut progress = Progress {
        app,
        event: "download-progress",
        transfer_id,
        attempt,
        total: remote.size,
        base: offset,
        started_at,
        last_bytes: offset,
        last_at: started_at,
        checkpoint_id: target.checkpoint.as_ref().map(|(id, _)| id.clone()),
        resumable: Some(target.checkpoint.is_some()),
    };
    progress.emit(offset, if offset > 0 { "resuming" } else { "running" });

    let mut buffer = vec![0u8; STREAM_BUFFER_BYTES];
    let mut last_saved = offset;
    let mut last_saved_at = Instant::now();
    while *written < remote.size {
        if token.is_cancelled() {
            return Err(Stop::Failed(cancelled_error()));
        }
        let want = STREAM_BUFFER_BYTES.min((remote.size - *written) as usize);
        let read = read_remote(
            handle,
            context,
            &mut remote_file,
            &mut buffer[..want],
            token,
        )
        .await
        .map_err(Stop::Failed)?;
        if read == 0 {
            // The file ended before the measured size, so it shrank during the download.
            return Err(Stop::Changed(CHANGED_DURING_DOWNLOAD.to_string()));
        }
        write_local(local, &buffer[..read], token)
            .await
            .map_err(Stop::Failed)?;
        *written += read as u64;
        if let Some(wait) = throttle_delay(*written - offset, bandwidth_bps, started_at.elapsed()) {
            sleep_unless_cancelled(token, wait)
                .await
                .map_err(Stop::Failed)?;
        }
        progress.tick(*written);
        if let Some(checkpoint) = &target.checkpoint {
            let advanced = *written - last_saved;
            if checkpoint_due(advanced, last_saved_at.elapsed()) {
                checkpoint_progress(app, checkpoint, local, identity, scratch, *written)
                    .await
                    .map_err(Stop::Failed)?;
                last_saved = *written;
                last_saved_at = Instant::now();
            }
        }
    }

    // The file must still be the one measured, through the handle and by path. Growth past the
    // measured size shows up here, not in the bytes already read.
    let after_handle = settle(handle, context, remote_file.metadata())
        .await
        .map_err(fail)?;
    if remote_identity_of(&after_handle, path) != Ok(remote) {
        return Err(Stop::Changed(CHANGED_DURING_DOWNLOAD.to_string()));
    }
    let after_path = remote_identity(handle, token, context, path)
        .await
        .map_err(Stop::Failed)?;
    if after_path != remote {
        return Err(Stop::Changed(CHANGED_DURING_DOWNLOAD.to_string()));
    }
    let _ = remote_file.close().await;

    local
        .flush()
        .await
        .map_err(|err| Stop::Failed(format!("Failed to flush download scratch: {}", err)))?;
    local
        .sync_all()
        .await
        .map_err(|err| Stop::Failed(format!("Failed to sync download scratch: {}", err)))?;
    let on_disk = local
        .metadata()
        .await
        .map_err(|err| Stop::Failed(format!("Failed to inspect download scratch: {}", err)))?
        .len();
    if on_disk != remote.size {
        return Err(Stop::Failed(format!(
            "Download incomplete: expected {} bytes, the scratch file holds {}",
            remote.size, on_disk
        )));
    }
    Ok(())
}

/// Apply the failure policy to a download that did not publish. A changed remote file discards
/// everything. Any other stop keeps a checkpointed scratch, trimmed to the bytes the checkpoint
/// will name, so the next attempt resumes exactly where this one stopped.
async fn abandon_download<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    target: &DownloadTarget,
    identity: &DownloadIdentity,
    scratch: Option<ScratchId>,
    mut local: tokio::fs::File,
    written: u64,
    stop: Stop,
) -> String {
    match stop {
        Stop::Changed(message) => {
            drop(local);
            remove_scratch(&target.temp).await;
            if let Some((id, session)) = &target.checkpoint {
                let _ = remove_checkpoint(app, id, session).await;
            }
            message
        }
        Stop::Failed(message) => {
            match &target.checkpoint {
                Some(checkpoint) => {
                    // A cancel can interrupt a write, so drain it before trimming.
                    let _ = local.flush().await;
                    if local.set_len(written).await.is_ok() {
                        let _ = checkpoint_progress(
                            app, checkpoint, &mut local, identity, scratch, written,
                        )
                        .await;
                    }
                    drop(local);
                }
                None => {
                    drop(local);
                    remove_scratch(&target.temp).await;
                }
            }
            message
        }
    }
}

/// One download attempt: measure the remote file, resume or restart from the checkpoint, copy,
/// verify, and publish.
async fn run_download<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    registered: &RegisteredSftp,
    path: &str,
    target: &DownloadTarget,
    transfer_id: u32,
    attempt: u32,
    bandwidth_bps: u64,
) -> Result<u64, String> {
    let handle: &SftpHandle = &registered.handle;
    let token = registered.token();
    let context = format!("download {}", path);
    // Measure before any scratch exists, so a refused remote leaves nothing behind.
    let remote = remote_identity(handle, &token, &context, path).await?;
    let identity = DownloadIdentity {
        endpoint: handle.endpoint.clone(),
        username: handle.username.clone(),
        remote_path: path.to_string(),
        destination: target.destination.to_string_lossy().into_owned(),
        temp_path: target.temp.to_string_lossy().into_owned(),
        size: remote.size,
        mtime: remote.mtime,
    };
    let (mut local, scratch) = open_scratch_async(target.temp.clone(), true).await?;
    let scratch_len = local
        .metadata()
        .await
        .map_err(|err| format!("Failed to inspect download scratch: {}", err))?
        .len();
    let mut offset = 0u64;
    if let Some((id, session)) = &target.checkpoint {
        let stored = crate::load_transfer_checkpoint_json(app, id, session).map_err(|err| {
            format!(
                "Failed to load resumable download checkpoint '{}'; checkpoint and scratch data were retained: {}",
                id, err
            )
        })?;
        if let Some(saved) = stored.as_deref().and_then(parse_checkpoint) {
            offset = resume_offset(&saved, &identity, scratch_len, scratch);
        }
    }

    let mut written = offset;
    let prepared: Result<(), Stop> = async {
        local
            .set_len(offset)
            .await
            .map_err(|err| Stop::Failed(format!("Failed to size download scratch: {}", err)))?;
        local
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|err| Stop::Failed(format!("Failed to position download scratch: {}", err)))?;
        if let Some(checkpoint) = &target.checkpoint {
            // The checkpoint now describes this attempt's starting point, replacing any stale one.
            checkpoint_progress(app, checkpoint, &mut local, &identity, scratch, offset)
                .await
                .map_err(Stop::Failed)?;
        }
        download_body(
            app,
            handle,
            &token,
            &context,
            path,
            target,
            &identity,
            scratch,
            remote,
            &mut local,
            &mut written,
            transfer_id,
            attempt,
            bandwidth_bps,
        )
        .await
    }
    .await;
    if let Err(stop) = prepared {
        return Err(abandon_download(app, target, &identity, scratch, local, written, stop).await);
    }

    let keep_temp = target.checkpoint.is_some();
    drop(local);
    let temp = target.temp.clone();
    let destination = target.destination.clone();
    let parent = target.parent.clone();
    let overwrite = target.overwrite;
    let published = crate::security::run_blocking(move || {
        publish_scratch(&temp, &destination, overwrite, keep_temp, &parent, scratch)
    })
    .await;
    if let Err(message) = published {
        if !keep_temp {
            remove_scratch(&target.temp).await;
        }
        return Err(message);
    }

    if let Some((id, session)) = &target.checkpoint {
        // The destination is already published, so a checkpoint cleanup failure must not turn a
        // completed download into a failed one.
        if let Err(err) = remove_checkpoint(app, id, session).await {
            eprintln!(
                "Download completed, but checkpoint '{}' cleanup was deferred: {}",
                id, err
            );
        }
    }
    let started_at = Instant::now();
    let mut progress = Progress {
        app,
        event: "download-progress",
        transfer_id,
        attempt,
        total: remote.size,
        base: 0,
        started_at,
        last_bytes: remote.size,
        last_at: started_at,
        checkpoint_id: target.checkpoint.as_ref().map(|(id, _)| id.clone()),
        resumable: Some(keep_temp),
    };
    progress.emit(remote.size, "verifying");
    Ok(remote.size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> DownloadIdentity {
        DownloadIdentity {
            endpoint: "sftp://127.0.0.1:12222".to_string(),
            username: "u".to_string(),
            remote_path: "/home/u/big.bin".to_string(),
            destination: "/home/me/out.bin".to_string(),
            temp_path: "/home/me/out.bin.s3-sidekick.download.tmp".to_string(),
            size: 6_291_456,
            mtime: 1_700_000_000,
        }
    }

    fn saved(scratch: ScratchId) -> SftpDownloadCheckpoint {
        let want = identity();
        SftpDownloadCheckpoint {
            protocol: CHECKPOINT_PROTOCOL.to_string(),
            version: CHECKPOINT_VERSION,
            mode: CHECKPOINT_MODE.to_string(),
            endpoint: want.endpoint,
            username: want.username,
            remote_path: want.remote_path,
            destination: want.destination,
            temp_path: want.temp_path,
            size: want.size,
            mtime: want.mtime,
            bytes_written: 1_048_576,
            scratch_device: Some(scratch.device),
            scratch_inode: Some(scratch.inode),
            updated_at_ms: 1,
        }
    }

    const SCRATCH: ScratchId = ScratchId {
        device: 7,
        inode: 99,
    };

    #[test]
    fn temp_leaf_is_hidden_marked_and_fits_the_name_limit() {
        assert_eq!(
            temp_leaf("a.bin", 0xabc).as_deref(),
            Some(".a.bin.s3sk-0000000000000abc.part")
        );
        let hex = temp_leaf("a.bin", 0xabc)
            .unwrap_or_default()
            .split(".s3sk-")
            .nth(1)
            .unwrap_or_default()
            .trim_end_matches(".part")
            .to_string();
        assert_eq!(hex.len(), 16);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
        // The affix is 28 bytes: a leading dot, `.s3sk-`, 16 hex digits and `.part`.
        assert_eq!(
            temp_leaf(&"a".repeat(227), 1).map(|name| name.len()),
            Some(255)
        );
        assert!(temp_leaf(&"a".repeat(228), 1).is_none());
    }

    #[test]
    fn checkpoint_parser_accepts_only_its_own_protocol_shape() {
        let json = serde_json::to_string(&saved(SCRATCH)).expect("serialize checkpoint");
        assert_eq!(parse_checkpoint(&json), Some(saved(SCRATCH)));

        // The S3 parallel-download checkpoint has no protocol marker and must not be read as ours.
        let s3 = r#"{"version":1,"mode":"download_parallel","bucket":"b","key":"k",
            "destination":"/home/me/out.bin","temp_path":"/home/me/out.bin.s3-sidekick.download.tmp",
            "total_bytes":10,"part_size":5,"completed_parts":[0],"updated_at_ms":1}"#;
        assert_eq!(parse_checkpoint(s3), None);
        assert_eq!(parse_checkpoint("not json"), None);

        let wrong_protocol = json.replace("\"protocol\":\"sftp\"", "\"protocol\":\"s3\"");
        assert_eq!(parse_checkpoint(&wrong_protocol), None);
        let wrong_mode = json.replace(
            "\"mode\":\"sftp_download\"",
            "\"mode\":\"download_parallel\"",
        );
        assert_eq!(parse_checkpoint(&wrong_mode), None);
        let wrong_version = json.replace("\"version\":2", "\"version\":3");
        assert_eq!(parse_checkpoint(&wrong_version), None);
        // A version 1 checkpoint (no username) is refused, so its download restarts.
        let version_one = json
            .replace("\"version\":2", "\"version\":1")
            .replace(",\"username\":\"u\"", "");
        assert_ne!(version_one, json);
        assert_eq!(parse_checkpoint(&version_one), None);
        let extra = json.replacen('{', "{\"etag\":\"x\",", 1);
        assert_eq!(parse_checkpoint(&extra), None);
    }

    #[test]
    fn resume_requires_every_identity_field_and_the_exact_scratch_length() {
        let checkpoint = saved(SCRATCH);
        let want = identity();
        let bytes = checkpoint.bytes_written;
        assert_eq!(
            resume_offset(&checkpoint, &want, bytes, Some(SCRATCH)),
            bytes
        );

        // Each mismatch restarts from zero.
        let mut other = want.clone();
        other.endpoint = "sftp://127.0.0.1:12223".to_string();
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.username = "someone-else".to_string();
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.remote_path = "/home/u/other.bin".to_string();
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.size += 1;
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.mtime += 1;
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.destination = "/home/me/elsewhere.bin".to_string();
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);
        let mut other = want.clone();
        other.temp_path = "/home/me/elsewhere.tmp".to_string();
        assert_eq!(resume_offset(&checkpoint, &other, bytes, Some(SCRATCH)), 0);

        // The scratch must be the same file, and exactly as long as the checkpoint says.
        assert_eq!(
            resume_offset(&checkpoint, &want, bytes + 1, Some(SCRATCH)),
            0
        );
        assert_eq!(
            resume_offset(&checkpoint, &want, bytes - 1, Some(SCRATCH)),
            0
        );
        let replaced = ScratchId {
            device: 7,
            inode: 100,
        };
        assert_eq!(resume_offset(&checkpoint, &want, bytes, Some(replaced)), 0);
        assert_eq!(resume_offset(&checkpoint, &want, bytes, None), 0);
        let mut no_identity = checkpoint.clone();
        no_identity.scratch_inode = None;
        assert_eq!(resume_offset(&no_identity, &want, bytes, Some(SCRATCH)), 0);

        // A checkpoint can never claim more bytes than the file it describes.
        let mut overrun = checkpoint.clone();
        overrun.bytes_written = want.size + 1;
        assert_eq!(
            resume_offset(&overrun, &want, want.size + 1, Some(SCRATCH)),
            0
        );
    }

    #[test]
    fn progress_is_throttled_by_bytes_and_time() {
        assert!(!progress_due(256 * 1024 - 1, Duration::from_secs(1)));
        assert!(!progress_due(256 * 1024, Duration::from_millis(99)));
        assert!(progress_due(256 * 1024, Duration::from_millis(100)));
    }

    #[test]
    fn checkpoints_are_recorded_by_bytes_or_elapsed_time_and_never_without_progress() {
        assert!(!checkpoint_due(0, Duration::from_secs(10)));
        assert!(!checkpoint_due(1, Duration::from_secs(2)));
        assert!(checkpoint_due(1, Duration::from_secs(3)));
        assert!(checkpoint_due(CHECKPOINT_STEP_BYTES, Duration::ZERO));
        assert!(!checkpoint_due(CHECKPOINT_STEP_BYTES - 1, Duration::ZERO));
    }

    #[test]
    fn bandwidth_limit_sleeps_only_when_the_attempt_is_ahead_of_its_budget() {
        let two_mib_per_second = 2 * 1024 * 1024;
        assert_eq!(
            throttle_delay(
                2 * 1024 * 1024,
                two_mib_per_second,
                Duration::from_millis(500)
            ),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            throttle_delay(2 * 1024 * 1024, two_mib_per_second, Duration::from_secs(2)),
            None
        );
        assert_eq!(
            throttle_delay(10 * 1024 * 1024, 0, Duration::from_secs(0)),
            None
        );
    }

    #[test]
    fn a_refused_mode_copy_says_the_existing_file_was_kept_and_how_to_replace_it() {
        let message = mode_copy_refused("/home/u/report.txt", "permission denied");
        assert_eq!(
            message,
            "The server would not copy the permissions of /home/u/report.txt to the upload \
             (permission denied). The existing file was kept unchanged. Delete the remote \
             file and upload again to replace it."
        );
    }
}
