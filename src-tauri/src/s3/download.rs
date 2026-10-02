//! Sequential and parallel (resumable) downloads.

use super::*;

#[tauri::command]
pub(crate) async fn download_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checksum_verification: Option<bool>,
) -> Result<u64, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, Some(transfer_id))?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    let destination_path = if overwrite {
        validate_destination_path_allow_overwrite(&destination)?
    } else {
        validate_destination_path(&destination)?
    };
    // The scratch path is derived here rather than accepted from the caller.
    // Accepting it meant any script in the webview could name an arbitrary
    // existing file and have the backend truncate and overwrite it.
    let temp_path = crate::download_temp_path(&destination_path);
    if temp_path == destination_path {
        return Err("Temp path must be different from destination".to_string());
    }
    let cancel = client.token();
    let _temp_guard = claim_download_temp_async(&temp_path, &destination_path).await?;
    let download_lease_nonce =
        issue_download_lease_async(&app, &destination_path, &temp_path).await?;
    if tokio::fs::try_exists(&temp_path).await.unwrap_or(false) {
        clear_download_scratch_async(&temp_path).await?;
    }
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);

    if client.is_cancelled() {
        return Err(cancelled_error());
    }

    let head_request = client.head_object().bucket(&bucket).key(&key).send();
    let generation_head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = head_request => {
            result.map_err(|e| {
                structured_transfer_sdk_error(
                    "Failed to read object metadata",
                    &e,
                    "download_head",
                    true,
                )
            })?
        }
    };
    let object_etag = generation_head
        .e_tag()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            encode_transfer_error(
                "generation_unavailable",
                false,
                None,
                "Sequential download is unsafe because the provider returned no ETag.".to_string(),
            )
        })?
        .to_string();
    let object_version_id = generation_head
        .version_id()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let expected_checksum = if checksum_enabled {
        Some(expected_download_checksum(&client, &bucket, &key, &generation_head, &cancel).await?)
    } else {
        None
    };

    let mut download_request = client.get_object().bucket(&bucket).key(&key);
    if let Some(version_id) = object_version_id.as_deref() {
        download_request = download_request.version_id(version_id);
    } else {
        download_request = download_request.if_match(&object_etag);
    }
    let download_request = download_request.send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = download_request => {
            result.map_err(|e| {
                structured_transfer_sdk_error("Failed to download", &e, "download", true)
            })?
        }
    };

    let total_bytes = sanitized_content_length(output.content_length());
    emit_transfer_progress(
        &app,
        "download-progress",
        transfer_id,
        0,
        total_bytes,
        attempt,
        "running",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    // Stream into the scratch file in a scope that owns the handle, so every
    // failure path closes the file *before* the caller tries to unlink it.
    // Removing a file that is still open fails outright on Windows, and the
    // previous code discarded that failure, orphaning the scratch file.
    let stream_result = stream_body_to_temp(
        &app,
        output,
        &temp_path,
        transfer_id,
        attempt,
        total_bytes,
        started_at,
        &cancel,
    )
    .await;

    let written = match stream_result {
        Ok(written) => written,
        Err(err) => {
            remove_download_scratch(&temp_path).await;
            return Err(err);
        }
    };

    if total_bytes > 0 && written != total_bytes {
        remove_download_scratch(&temp_path).await;
        return Err(format!(
            "Downloaded byte count mismatch. Expected {}, wrote {}.",
            total_bytes, written
        ));
    }

    if let Some(expected) = expected_checksum.as_ref() {
        if let Err(err) = verify_file_checksum(&temp_path, expected, &cancel).await {
            remove_download_scratch(&temp_path).await;
            return Err(err);
        }
    }

    if let Err(err) = sync_completed_download_file(&temp_path).await {
        remove_download_scratch(&temp_path).await;
        return Err(err);
    }
    let still_current = match current_identity_matches(
        &client,
        &bucket,
        &key,
        &object_etag,
        None,
        object_version_id.as_deref(),
        None,
        &cancel,
    )
    .await
    {
        Ok(result) => result,
        Err(err) => {
            remove_download_scratch(&temp_path).await;
            return Err(err);
        }
    };
    if still_current != Some(true) {
        remove_download_scratch(&temp_path).await;
        return Err(encode_transfer_error(
            "stale_object",
            false,
            None,
            format!(
                "'{}' changed while it was being downloaded, so stale bytes were not published over '{}'.",
                key,
                destination_path.display()
            ),
        ));
    }

    publish_completed_download_file(&temp_path, &destination_path, overwrite, false).await?;
    release_download_lease_async(&app, &destination_path, &download_lease_nonce).await;

    emit_transfer_progress(
        &app,
        "download-progress",
        transfer_id,
        written,
        written,
        attempt,
        "verifying",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    Ok(written)
}

/// Copy a response body into `temp_path`, returning the byte count.
///
/// Owns the file handle for its whole lifetime so the handle is always closed by
/// the time this returns, whether it succeeds or fails.
pub(super) async fn stream_body_to_temp(
    app: &tauri::AppHandle,
    output: aws_sdk_s3::operation::get_object::GetObjectOutput,
    temp_path: &Path,
    transfer_id: u32,
    attempt: u32,
    total_bytes: u64,
    started_at: Instant,
    cancel: &CancelToken,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut reader = output.body.into_async_read();
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut written = 0u64;
    let mut last_emitted = 0u64;
    let mut last_emitted_at = Instant::now();
    let mut buf = [0u8; 64 * 1024];
    const PROGRESS_INTERVAL: u64 = 256 * 1024;
    // Bandwidth-proportional events would flood the IPC bridge on fast links;
    // keep byte granularity but never emit more than ten times a second. The
    // caller emits the terminal update after this returns.
    const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);
    // A body read that yields nothing for this long is a stalled endpoint, not
    // a slow transfer: fail retryably instead of hanging the transfer forever.
    const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }

        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = tokio::time::timeout(BODY_IDLE_TIMEOUT, reader.read(&mut buf)) => {
                match result {
                    Ok(read_result) => read_result
                        .map_err(|e| format!("Failed to read body: {}", e))?,
                    Err(_) => {
                        return Err(encode_transfer_error(
                            "stalled",
                            true,
                            None,
                            format!(
                                "Download stalled: no data received for {} seconds.",
                                BODY_IDLE_TIMEOUT.as_secs()
                            ),
                        ));
                    }
                }
            }
        };
        if count == 0 {
            break;
        }

        tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = file.write_all(&buf[..count]) => {
                result.map_err(|e| format!("Failed to write temp file: {}", e))?;
            }
        }
        written += count as u64;

        if written - last_emitted >= PROGRESS_INTERVAL
            && last_emitted_at.elapsed() >= PROGRESS_MIN_INTERVAL
        {
            emit_transfer_progress(
                app,
                "download-progress",
                transfer_id,
                written,
                total_bytes,
                attempt,
                "running",
                started_at,
                None,
                None,
                None,
                Some(false),
            );
            last_emitted = written;
            last_emitted_at = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush temp file: {}", e))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync temp file: {}", e))?;

    Ok(written)
}

/// Publish a completed download over its destination.
///
/// `std::fs::rename` replaces an existing destination atomically on every
/// platform this app targets — on Windows it maps to `MoveFileExW` /
/// `SetFileInformationByHandle`, which replace rather than fail. The previous
/// implementation moved the destination aside to a backup first and only then
/// renamed the scratch file into place. That extra step bought nothing and
/// created a window in which the destination did not exist at all: losing the
/// process in between left the user with no file at the destination and an
/// opaque `.download-backup.<pid>.<n>.tmp` beside it that nothing would ever
/// clean up (the startup sweep only covers the app data directory).
pub(super) async fn sync_completed_download_file(temp_path: &Path) -> Result<(), String> {
    // Async open + sync: the scratch file can be gigabytes and sync_all
    // flushes real bytes, so this must never park a Tokio worker thread.
    // Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle
    // returns ERROR_ACCESS_DENIED, so open with write as well.
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp_path)
        .await
        .map_err(|e| format!("Failed to sync completed download: {}", e))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync completed download: {}", e))
}

/// File identity for the scratch inode trusted by one parallel download.
/// Workers reopen the pathname independently so each has its own seek cursor,
/// but they must all resolve to this original file.
#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct DownloadScratchIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct DownloadScratchIdentity {
    volume: u32,
    file_index: u64,
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct DownloadScratchIdentity;

fn download_scratch_identity(file: &std::fs::File) -> std::io::Result<DownloadScratchIdentity> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "download scratch is not a regular file",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(DownloadScratchIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        if metadata.file_attributes() & 0x0000_0400 != 0 {
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
        if info.dwFileAttributes & 0x0000_0400 != 0 {
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
        Ok(DownloadScratchIdentity {
            volume: info.dwVolumeSerialNumber,
            file_index,
        })
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "download scratch identity is unsupported on this platform",
        ))
    }
}

fn open_download_scratch_file(
    path: &Path,
    create: bool,
    expected_identity: Option<&DownloadScratchIdentity>,
) -> std::io::Result<(std::fs::File, DownloadScratchIdentity)> {
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Rust's portable OpenOptionsExt API accepts raw flags. These values are
        // O_NOFOLLOW on the supported Unix desktop targets; unknown targets fail
        // closed below instead of opening a link.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NOFOLLOW: i32 = 0x0002_0000;
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "openbsd",
            target_os = "netbsd"
        ))]
        const O_NOFOLLOW: i32 = 0x0000_0100;
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
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "no-follow download scratch opens are unsupported on this Unix platform",
        ));
        #[cfg(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "openbsd",
            target_os = "netbsd"
        ))]
        options.custom_flags(O_NOFOLLOW);
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    #[cfg(not(any(unix, windows)))]
    return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no-follow download scratch opens are unsupported on this platform",
    ));

    let file = options.open(path)?;
    let identity = download_scratch_identity(&file)?;
    if expected_identity.is_some_and(|expected| expected != &identity) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "download scratch file identity changed",
        ));
    }
    Ok((file, identity))
}

async fn open_download_scratch_async(
    path: &Path,
    create: bool,
    expected_identity: Option<DownloadScratchIdentity>,
) -> Result<(tokio::fs::File, DownloadScratchIdentity), String> {
    let path = path.to_path_buf();
    let (file, identity) = tokio::task::spawn_blocking(move || {
        open_download_scratch_file(&path, create, expected_identity.as_ref())
    })
    .await
    .map_err(|error| format!("Download scratch open task failed: {}", error))?
    .map_err(|error| {
        format!(
            "Failed to open download scratch without following links; scratch and checkpoint were retained: {}",
            error
        )
    })?;
    Ok((tokio::fs::File::from_std(file), identity))
}

async fn verify_download_scratch_checksum(
    path: &Path,
    identity: &DownloadScratchIdentity,
    expected: &ExpectedChecksum,
    cancel: &CancelToken,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let (mut file, _) = open_download_scratch_async(path, false, Some(identity.clone())).await?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = file.read(&mut buffer) => {
                result.map_err(|error| format!("Failed to read verified download scratch: {}", error))?
            }
        };
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    match expected {
        ExpectedChecksum::Hex(hex) => {
            let actual = digest_to_hex(&digest);
            if actual != *hex {
                return Err(encode_transfer_error(
                    "checksum_mismatch",
                    false,
                    None,
                    format!(
                        "Checksum verification failed: expected {}, got {}.",
                        hex, actual
                    ),
                ));
            }
        }
        ExpectedChecksum::Base64(base64) => {
            let actual = digest_to_base64(&digest);
            if actual != *base64 {
                return Err(encode_transfer_error(
                    "checksum_mismatch",
                    false,
                    None,
                    "Checksum verification failed.".to_string(),
                ));
            }
        }
    }
    Ok(())
}

async fn sync_verified_download_scratch_file(
    temp_path: &Path,
    identity: &DownloadScratchIdentity,
) -> Result<(), String> {
    let (file, _) = open_download_scratch_async(temp_path, false, Some(identity.clone())).await?;
    file.sync_all()
        .await
        .map_err(|error| format!("Failed to sync verified download scratch: {}", error))
}

async fn publish_verified_download_file(
    temp_path: &Path,
    identity: &DownloadScratchIdentity,
    destination_path: &Path,
    overwrite: bool,
    keep_temp_on_failure: bool,
) -> Result<(), String> {
    let temp_path = temp_path.to_path_buf();
    let identity = identity.clone();
    let destination_path = destination_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let (_validated_file, _) = open_download_scratch_file(&temp_path, false, Some(&identity))
            .map_err(|error| {
                format!(
                    "Download scratch identity changed before publication; scratch and checkpoint were retained: {}",
                    error
                )
            })?;
        crate::publish_temp_file(
            &temp_path,
            &destination_path,
            overwrite,
            keep_temp_on_failure,
        )
    })
    .await
    .map_err(|error| format!("Download finalize task failed: {}", error))?
    .map_err(|error| format!("Failed to finalize download: {}", error))
}

pub(super) async fn publish_completed_download_file(
    temp_path: &Path,
    destination_path: &Path,
    overwrite: bool,
    keep_temp_on_failure: bool,
) -> Result<(), String> {
    // publish_temp_file performs rename/hard_link/fsync — blocking syscalls
    // on potentially large files — so run it on the blocking pool following
    // the files.rs::list_local_files_recursive pattern.
    let temp_path = temp_path.to_path_buf();
    let destination_path = destination_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::publish_temp_file(
            &temp_path,
            &destination_path,
            overwrite,
            keep_temp_on_failure,
        )
    })
    .await
    .map_err(|err| format!("Download finalize task failed: {}", err))?
    .map_err(|err| format!("Failed to finalize download: {}", err))
}

/// Async wrappers for the remaining blocking scratch/lease filesystem work on
/// the download paths (canonicalize, create_dir_all, small-file read/remove).
/// Each is fast in isolation but must not run on a Tokio worker thread.
pub(super) async fn claim_download_temp_async(
    temp_path: &Path,
    destination: &Path,
) -> Result<crate::DownloadTempGuard, String> {
    let temp_path = temp_path.to_path_buf();
    let destination = destination.to_path_buf();
    tokio::task::spawn_blocking(move || crate::claim_download_temp(&temp_path, &destination))
        .await
        .map_err(|err| format!("Download scratch claim task failed: {}", err))?
}

pub(super) async fn issue_download_lease_async(
    app: &tauri::AppHandle,
    destination: &Path,
    temp_path: &Path,
) -> Result<String, String> {
    let app = app.clone();
    let destination = destination.to_path_buf();
    let temp_path = temp_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::issue_download_scratch_lease(&app, &destination, &temp_path)
    })
    .await
    .map_err(|err| format!("Download lease task failed: {}", err))?
}

pub(super) async fn release_download_lease_async(
    app: &tauri::AppHandle,
    destination: &Path,
    nonce: &str,
) {
    let app = app.clone();
    let destination = destination.to_path_buf();
    let nonce = nonce.to_owned();
    let _ = tokio::task::spawn_blocking(move || {
        crate::release_download_scratch_lease(&app, &destination, &nonce);
    })
    .await;
}

pub(super) async fn clear_download_scratch_async(temp_path: &Path) -> Result<(), String> {
    let temp_path = temp_path.to_path_buf();
    tokio::task::spawn_blocking(move || crate::clear_unusable_download_scratch(&temp_path))
        .await
        .map_err(|err| format!("Download scratch cleanup task failed: {}", err))?
}

pub(super) async fn remove_download_scratch(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

#[cfg(test)]
pub(super) async fn finalize_download_file(
    temp_path: &Path,
    destination_path: &Path,
    overwrite: bool,
) -> Result<(), String> {
    // Publish only bytes that have reached stable storage. Keeping the sync as
    // a separate step lets network downloads perform their final remote
    // generation check after disk flush and immediately before publication.
    sync_completed_download_file(temp_path).await?;
    publish_completed_download_file(temp_path, destination_path, overwrite, false).await
}

/// Confirm a response actually honoured the byte range that was requested.
///
/// A server that ignores `Range` answers with 200 and the whole object. Without
/// this check every worker would write the entire object at its own offset,
/// inflating the scratch file to `workers * object size` and corrupting it,
/// with the mismatch only surfacing later as a confusing byte-count error.
pub(super) fn ensure_range_honoured(
    content_range: Option<&str>,
    content_length: Option<i64>,
    start: u64,
    end: u64,
) -> Result<(), String> {
    let expected_len = end - start + 1;

    if let Some(range) = content_range {
        // Expected shape: "bytes <start>-<end>/<total>".
        let spec = range.trim().strip_prefix("bytes").unwrap_or(range).trim();
        let spec = spec.split('/').next().unwrap_or("").trim();
        let mut halves = spec.split('-');
        let got_start = halves.next().and_then(|v| v.trim().parse::<u64>().ok());
        let got_end = halves.next().and_then(|v| v.trim().parse::<u64>().ok());
        if got_start == Some(start) && got_end == Some(end) {
            return Ok(());
        }
        return Err(format!(
            "{}: server returned Content-Range '{}' for requested bytes {}-{}",
            RANGE_UNSUPPORTED_CODE, range, start, end
        ));
    }

    // No Content-Range at all means the response was not a partial one. Accept it
    // only in the degenerate case where the requested range is the whole object
    // and the length still matches.
    match content_length {
        Some(len) if len as u64 == expected_len => Ok(()),
        _ => Err(format!(
            "{}: server did not return a Content-Range header for requested bytes {}-{}",
            RANGE_UNSUPPORTED_CODE, start, end
        )),
    }
}

async fn download_parallel_part(
    client: Client,
    bucket: String,
    key: String,
    temp_path: PathBuf,
    temp_identity: DownloadScratchIdentity,
    start: u64,
    end: u64,
    version_id: Option<String>,
    etag: String,
    cancel: CancelToken,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }

    let expected_len = end - start + 1;

    let mut request = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range(format!("bytes={}-{}", start, end));
    if let Some(version_id) = version_id {
        request = request.version_id(version_id);
    } else {
        request = request.if_match(etag);
    }
    let request = request.send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => {
            result.map_err(|e| {
                generation_pinned_download_error(
                    &format!("Failed ranged download {}-{}", start, end),
                    &e,
                )
            })?
        }
    };

    ensure_range_honoured(output.content_range(), output.content_length(), start, end)?;

    let mut reader = output.body.into_async_read();
    let (mut file, _) = open_download_scratch_async(&temp_path, false, Some(temp_identity)).await?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("Failed to seek temp file: {}", e))?;

    let mut written = 0u64;
    let mut buf = [0u8; 128 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = reader.read(&mut buf) => {
                result.map_err(|e| format!("Failed to read ranged body: {}", e))?
            }
        };
        if count == 0 {
            break;
        }

        // Never write past the requested range, even if the body keeps going.
        if written + count as u64 > expected_len {
            return Err(format!(
                "{}: server sent more than the requested {} bytes for range {}-{}",
                RANGE_UNSUPPORTED_CODE, expected_len, start, end
            ));
        }

        tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = file.write_all(&buf[..count]) => {
                result.map_err(|e| format!("Failed to write ranged temp file: {}", e))?;
            }
        }
        written += count as u64;
    }

    if written != expected_len {
        return Err(format!(
            "Ranged download {}-{} returned {} bytes, expected {}.",
            start, end, written, expected_len
        ));
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush ranged temp file: {}", e))?;
    // The coordinator records this range in the resumable checkpoint as soon as
    // the worker returns. Make the bytes durable first so a power loss cannot
    // leave a checkpoint claiming a range that only lived in the page cache.
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync ranged temp file: {}", e))?;
    Ok(written)
}

#[tauri::command]
pub(crate) async fn download_object_parallel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    parallel_threshold_mb: Option<u32>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checkpoint_id: Option<String>,
    recovery_session: String,
    enable_resume: Option<bool>,
    checksum_verification: Option<bool>,
) -> Result<u64, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, Some(transfer_id))?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    let checkpoint_enabled = enable_resume.unwrap_or(true)
        && checkpoint_id
            .as_ref()
            .map(|id| !id.trim().is_empty())
            .unwrap_or(false);
    if checkpoint_enabled {
        validate_transfer_recovery_session(&app, &recovery_session)?;
    }
    // Same dot-tolerant read validation as `download_object`: the key never
    // becomes a local path (the destination is caller-chosen and validated
    // separately), so `.`/`..` segments must remain downloadable.
    validate_readable_key(&key, "Object key")?;
    let destination_path = if overwrite {
        validate_destination_path_allow_overwrite(&destination)?
    } else {
        validate_destination_path(&destination)?
    };
    // Derived, not caller-supplied: see `download_object`.
    let temp_path = crate::download_temp_path(&destination_path);
    if temp_path == destination_path {
        return Err("Temp path must be different from destination".to_string());
    }
    let cancel = client.token();
    let _temp_guard = claim_download_temp_async(&temp_path, &destination_path).await?;
    let download_lease_nonce =
        issue_download_lease_async(&app, &destination_path, &temp_path).await?;
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let threshold_mb = parallel_threshold_mb
        .unwrap_or(PARALLEL_DOWNLOAD_THRESHOLD_MB)
        .max(1);
    let checksum_enabled = checksum_verification.unwrap_or(false);

    if client.is_cancelled() {
        return Err(cancelled_error());
    }

    let head_request = client.head_object().bucket(&bucket).key(&key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = head_request => {
            result.map_err(|e| {
                structured_transfer_sdk_error(
                    "Failed to read object metadata",
                    &e,
                    "download_head",
                    true,
                )
            })?
        }
    };
    let total_bytes = sanitized_content_length(head.content_length());
    let object_etag = head.e_tag().unwrap_or_default().to_string();
    let object_version_id = head
        .version_id()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let expected_checksum = if checksum_enabled {
        Some(expected_download_checksum(&client, &bucket, &key, &head, &cancel).await?)
    } else {
        None
    };
    let threshold_bytes = (threshold_mb as u64) * 1024 * 1024;

    if total_bytes < threshold_bytes || total_bytes == 0 {
        // Hand off to the sequential path. Release our registered client first
        // so disconnect/reset never observes an untracked credential clone.
        drop(client);
        drop(_storage_guard);
        drop(_temp_guard);
        return download_object(
            app,
            state,
            connection_id,
            bucket,
            key,
            destination,
            transfer_id,
            overwrite,
            Some(attempt),
            Some(checksum_enabled),
        )
        .await;
    }

    let part_size =
        (clamp_part_size_mb(part_size_mb, DEFAULT_DOWNLOAD_PART_SIZE_MB) as u64) * 1024 * 1024;
    let total_parts_u64 = total_bytes.div_ceil(part_size);
    if total_parts_u64 > MAX_DOWNLOAD_PARTS {
        return Err(format!(
            "Object metadata reports {} bytes ({} parts), beyond the supported download range.",
            total_bytes, total_parts_u64
        ));
    }
    let total_parts = total_parts_u64 as u32;
    if total_parts <= 1 {
        // Hand off to the sequential path. Release our registered client first
        // so disconnect/reset never observes an untracked credential clone.
        drop(client);
        drop(_storage_guard);
        drop(_temp_guard);
        return download_object(
            app,
            state,
            connection_id,
            bucket,
            key,
            destination,
            transfer_id,
            overwrite,
            Some(attempt),
            Some(checksum_enabled),
        )
        .await;
    }

    let requested_workers = clamp_transfer_concurrency(part_concurrency);
    let part_workers = clamp_concurrency_for_budget(
        requested_workers,
        part_size as usize,
        MAX_DOWNLOAD_INFLIGHT_BYTES,
    );
    let bandwidth_limit_bps = clamp_bandwidth_limit_bps(bandwidth_limit_mbps);

    // Preflight: confirm the endpoint really implements ranged reads and pin
    // the probe to the same immutable generation every worker will request.
    if object_version_id.is_none() && object_etag.is_empty() {
        return Err(encode_transfer_error(
            "generation_unavailable",
            false,
            None,
            "Parallel download is unsafe because the provider returned neither a version ID nor an ETag."
                .to_string(),
        ));
    }
    let mut probe_request = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range("bytes=0-0");
    if let Some(version_id) = object_version_id.as_deref() {
        probe_request = probe_request.version_id(version_id);
    } else {
        probe_request = probe_request.if_match(&object_etag);
    }
    let probe_request = probe_request.send();
    let probe_result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = probe_request => result,
    };
    match probe_result {
        Ok(probe) => {
            ensure_range_honoured(probe.content_range(), probe.content_length(), 0, 0)?;
        }
        Err(err) => {
            let mapped = generation_pinned_download_error("Ranged download preflight failed", &err);
            if maybe_range_unsupported(&mapped) {
                return Err(format!("{}: {}", RANGE_UNSUPPORTED_CODE, mapped));
            }
            return Err(mapped);
        }
    }

    // Decide whether a resume is actually safe before trusting any completed
    // parts. Read the length from the no-follow handle: a missing or truncated
    // scratch cannot validate a checkpoint, and a same-length symlink is never
    // accepted as the scratch file.
    let (init_file, temp_identity) = open_download_scratch_async(&temp_path, true, None).await?;
    let temp_len = init_file
        .metadata()
        .await
        .map_err(|error| format!("Failed to inspect opened download scratch: {}", error))
        .map(|metadata| metadata.len())?;
    let temp_usable = temp_len == total_bytes;

    let mut completed = vec![false; total_parts as usize];

    if checkpoint_enabled {
        if let Some(id) = checkpoint_id.as_deref() {
            let checkpoint_json = load_transfer_checkpoint_json(&app, id, &recovery_session)
                .map_err(|err| {
                format!(
                    "Failed to load resumable download checkpoint '{}'; checkpoint and scratch data were retained: {}",
                    id, err
                )
            })?;
            if let Some(json) = checkpoint_json {
                let payload = checkpoint_from_json(&json).map_err(|err| {
                    format!(
                        "Failed to parse resumable download checkpoint '{}'; checkpoint and scratch data were retained: {}",
                        id, err
                    )
                })?;
                // Require the recorded immutable generation to match. Versioned
                // objects must have the exact version ID; unversioned objects
                // are pinned by ETag. Old versioned checkpoints lack a version
                // ID and therefore restart cleanly.
                let generation_matches = checkpoint_generation_matches(
                    &payload,
                    &object_etag,
                    object_version_id.as_deref(),
                );
                if temp_usable
                    && payload.mode == "download_parallel"
                    && payload.bucket == bucket
                    && payload.key == key
                    && payload.temp_path == temp_path.to_string_lossy()
                    && payload.total_bytes == total_bytes
                    && payload.part_size == part_size
                    && generation_matches
                {
                    for part in normalize_checkpoint_parts(&payload.completed_parts, total_parts) {
                        completed[part as usize] = true;
                    }
                }
            }
        }
    }

    // Keep the initial no-follow handle through sizing and sync. When resume is
    // rejected, every part is scheduled again and overwrites its full range, so
    // unlinking a pathname here would add a race without clearing usable bytes.
    init_file
        .set_len(total_bytes)
        .await
        .map_err(|e| format!("Failed to size opened download scratch: {}", e))?;
    init_file
        .sync_all()
        .await
        .map_err(|e| format!("Failed to sync opened download scratch: {}", e))?;
    drop(init_file);

    let mut completed_bytes = 0u64;
    for index in 0..total_parts {
        if completed[index as usize] {
            let start = (index as u64) * part_size;
            let end = std::cmp::min(start + part_size, total_bytes);
            completed_bytes += end - start;
        }
    }

    let _progress_baseline = ProgressBaseline::set(transfer_id, completed_bytes);
    emit_transfer_progress(
        &app,
        "download-progress",
        transfer_id,
        completed_bytes,
        total_bytes,
        attempt,
        if completed_bytes > 0 {
            "resuming"
        } else {
            "running"
        },
        started_at,
        Some(completed.iter().filter(|v| **v).count() as u32),
        Some(total_parts),
        checkpoint_id.as_deref(),
        Some(checkpoint_enabled),
    );

    let bytes_done = Arc::new(AtomicU64::new(completed_bytes));
    let mut join_set = tokio::task::JoinSet::new();
    let mut next_part = 0u32;
    let mut last_checkpoint_saved_at = Instant::now();
    let mut last_checkpoint_saved_parts = completed.iter().filter(|v| **v).count() as u32;

    while next_part < total_parts || !join_set.is_empty() {
        if cancel.is_cancelled() {
            // `abort_all` only *requests* cancellation. Workers may still hold
            // the scratch file open and be mid-write, so drain the set before
            // touching it: unlinking an open handle fails outright on Windows
            // (orphaning a full-size scratch file) and on Unix lets surviving
            // workers keep writing into the unlinked inode.
            join_set.abort_all();
            while join_set.join_next().await.is_some() {}
            if !checkpoint_enabled {
                remove_download_scratch(&temp_path).await;
            }
            return Err(cancelled_error());
        }

        while join_set.len() < part_workers && next_part < total_parts {
            let index = next_part;
            next_part += 1;
            if completed[index as usize] {
                continue;
            }
            let start = (index as u64) * part_size;
            let end = std::cmp::min(start + part_size, total_bytes) - 1;
            let bucket_clone = bucket.clone();
            let key_clone = key.clone();
            let path_clone = temp_path.clone();
            let identity_clone = temp_identity.clone();
            let client_clone = client.clone();
            let version_id_clone = object_version_id.clone();
            let etag_clone = object_etag.clone();
            let part_cancel = Arc::clone(&cancel);
            join_set.spawn(async move {
                let size = download_parallel_part(
                    client_clone,
                    bucket_clone,
                    key_clone,
                    path_clone,
                    identity_clone,
                    start,
                    end,
                    version_id_clone,
                    etag_clone,
                    part_cancel,
                )
                .await?;
                Ok::<(u32, u64), String>((index, size))
            });
        }

        let joined = tokio::select! {
            _ = cancel.cancelled() => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                if !checkpoint_enabled {
                    remove_download_scratch(&temp_path).await;
                }
                return Err(cancelled_error());
            }
            result = join_set.join_next() => result,
        };

        match joined {
            Some(Ok(Ok((index, written)))) => {
                completed[index as usize] = true;
                let sent = bytes_done.fetch_add(written, Ordering::Relaxed) + written;
                if bandwidth_limit_bps > 0 {
                    let elapsed = started_at.elapsed().as_secs_f64();
                    let target = sent as f64 / bandwidth_limit_bps as f64;
                    if target > elapsed
                        && !cancel
                            .sleep_unless_cancelled(Duration::from_secs_f64(target - elapsed))
                            .await
                    {
                        continue;
                    }
                }
                let completed_count = completed.iter().filter(|v| **v).count() as u32;

                if checkpoint_enabled {
                    if let Some(id) = checkpoint_id.as_deref() {
                        let elapsed_ms = last_checkpoint_saved_at.elapsed().as_millis() as u64;
                        if completed_count == total_parts
                            || completed_count.saturating_sub(last_checkpoint_saved_parts) >= 8
                            || elapsed_ms >= 1500
                        {
                            let payload = TransferCheckpoint {
                                version: 1,
                                mode: "download_parallel".to_string(),
                                bucket: bucket.clone(),
                                key: key.clone(),
                                destination: Some(destination_path.to_string_lossy().to_string()),
                                temp_path: temp_path.to_string_lossy().to_string(),
                                total_bytes,
                                part_size,
                                completed_parts: completed
                                    .iter()
                                    .enumerate()
                                    .filter_map(
                                        |(i, done)| if *done { Some(i as u32) } else { None },
                                    )
                                    .collect(),
                                updated_at_ms: now_ms(),
                                etag: object_etag.clone(),
                                version_id: object_version_id.clone(),
                            };
                            if let Err(err) = persist_checkpoint_and_advance(
                                &mut last_checkpoint_saved_at,
                                &mut last_checkpoint_saved_parts,
                                completed_count,
                                {
                                    let save_app = app.clone();
                                    let save_id = id.to_string();
                                    let save_session = recovery_session.clone();
                                    let save_payload = payload.clone();
                                    move || async move {
                                        tokio::task::spawn_blocking(move || {
                                            save_checkpoint_payload(
                                                &save_app,
                                                &save_id,
                                                &save_payload,
                                                &save_session,
                                            )
                                        })
                                        .await
                                        .map_err(
                                            |err| format!("Checkpoint writer task failed: {}", err),
                                        )?
                                    }
                                },
                            )
                            .await
                            {
                                // Other workers may still be writing later
                                // ranges. Stop and drain them before returning,
                                // while retaining both checkpoint and scratch so
                                // the failed persistence can be diagnosed/retried.
                                join_set.abort_all();
                                while join_set.join_next().await.is_some() {}
                                return Err(format!(
                                    "Failed to persist resumable download checkpoint '{}'; scratch data was retained: {}",
                                    id, err
                                ));
                            }
                        }
                    }
                }

                emit_transfer_progress(
                    &app,
                    "download-progress",
                    transfer_id,
                    sent,
                    total_bytes,
                    attempt,
                    "running",
                    started_at,
                    Some(completed_count),
                    Some(total_parts),
                    checkpoint_id.as_deref(),
                    Some(checkpoint_enabled),
                );
            }
            Some(Ok(Err(err))) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                if !checkpoint_enabled {
                    remove_download_scratch(&temp_path).await;
                }
                if maybe_range_unsupported(&err) {
                    return Err(format!("{}: {}", RANGE_UNSUPPORTED_CODE, err));
                }
                return Err(err);
            }
            Some(Err(err)) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                if !checkpoint_enabled {
                    remove_download_scratch(&temp_path).await;
                }
                return Err(format!("Parallel worker failed: {}", err));
            }
            None => break,
        }
    }

    let final_bytes = bytes_done.load(Ordering::Relaxed);
    let missing_parts = completed.iter().filter(|done| !**done).count();
    let (scratch_file, _) =
        open_download_scratch_async(&temp_path, false, Some(temp_identity.clone())).await?;
    let on_disk = scratch_file
        .metadata()
        .await
        .map_err(|error| format!("Failed to inspect verified download scratch: {}", error))?
        .len();
    drop(scratch_file);
    // Aggregate byte accounting alone cannot prove the file is intact, so check
    // the part bitmap and the actual file length too.
    if final_bytes != total_bytes || missing_parts > 0 || on_disk != total_bytes {
        if !checkpoint_enabled {
            remove_download_scratch(&temp_path).await;
        }
        return Err(format!(
            "Download incomplete: expected {} bytes across {} part(s), accounted for {} bytes \
             with {} part(s) missing, scratch file is {} bytes.",
            total_bytes, total_parts, final_bytes, missing_parts, on_disk
        ));
    }

    if let Some(expected) = expected_checksum.as_ref() {
        if let Err(err) =
            verify_download_scratch_checksum(&temp_path, &temp_identity, expected, &cancel).await
        {
            if !checkpoint_enabled {
                remove_download_scratch(&temp_path).await;
            }
            return Err(err);
        }
    }

    if let Err(err) = sync_verified_download_scratch_file(&temp_path, &temp_identity).await {
        if !checkpoint_enabled {
            remove_download_scratch(&temp_path).await;
        }
        return Err(err);
    }

    // Pinning every range to one generation guarantees the assembled bytes are
    // self-consistent, but it says nothing about whether that generation is still
    // the object. A resumed download can span an arbitrary amount of wall clock,
    // so the pinned version may have been superseded — or expired — while the
    // ranges were being fetched, and publishing it would silently overwrite the
    // destination with a stale object. Confirm the pinned generation is still
    // current immediately before the rename, and treat anything else as stale
    // without touching the destination. The scratch file and checkpoint are kept
    // so the transfer stays resumable and nothing has to be re-downloaded once
    // the user re-runs it against the new generation.
    let still_current = match current_identity_matches(
        &client,
        &bucket,
        &key,
        &object_etag,
        None,
        object_version_id.as_deref(),
        None,
        &cancel,
    )
    .await
    {
        Ok(result) => result,
        Err(err) => {
            // The generation could not be confirmed either way, so publishing
            // would be a guess. Fail without renaming, and apply the same scratch
            // retention rule as the stale case below.
            if !checkpoint_enabled {
                remove_download_scratch(&temp_path).await;
            }
            return Err(err);
        }
    };
    if still_current != Some(true) {
        // Resumable transfers keep their scratch file and checkpoint, exactly as
        // every other late failure in this function does, so re-running against
        // the new generation reuses whatever is still valid. Without checkpoints
        // there is nothing to resume, and the scratch file lives beside the
        // destination where no sweep would ever reclaim it, so it goes now.
        if !checkpoint_enabled {
            remove_download_scratch(&temp_path).await;
        }
        return Err(encode_transfer_error(
            "stale_object",
            false,
            None,
            format!(
                "'{}' changed while it was being downloaded, so a partially stale copy was not \
                 published over '{}'.",
                key,
                destination_path.display()
            ),
        ));
    }

    // A checkpointed download keeps its finished scratch if publication fails
    // (for example the old destination is open in another app), so a retry
    // publishes it instead of downloading every byte again.
    publish_verified_download_file(
        &temp_path,
        &temp_identity,
        &destination_path,
        overwrite,
        checkpoint_enabled,
    )
    .await?;
    release_download_lease_async(&app, &destination_path, &download_lease_nonce).await;

    emit_transfer_progress(
        &app,
        "download-progress",
        transfer_id,
        total_bytes,
        total_bytes,
        attempt,
        "finalizing",
        started_at,
        Some(total_parts),
        Some(total_parts),
        checkpoint_id.as_deref(),
        Some(checkpoint_enabled),
    );

    if checkpoint_enabled {
        if let Some(id) = checkpoint_id.as_deref() {
            // The destination is already durably published. A metadata cleanup
            // failure must not turn a successful create-only download into a
            // failed transfer that retries against the completed destination.
            // The retained unreferenced checkpoint remains eligible for GC.
            if let Err(err) = remove_transfer_checkpoint(&app, id, &recovery_session) {
                eprintln!(
                    "Download completed, but checkpoint '{}' cleanup was deferred: {}",
                    id, err
                );
            }
        }
    }

    Ok(total_bytes)
}

#[cfg(all(test, unix))]
mod file_safety_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn scratch_test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "s3-sidekick-download-scratch-{}-{}",
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    async fn ranged_response_server() -> (Client, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                if stream.read_exact(&mut byte).await.is_err() {
                    panic!("client closed before completing the request headers");
                }
                request.push(byte[0]);
                assert!(
                    request.len() < 16 * 1024,
                    "request headers exceeded fixture limit"
                );
            }
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 0-3/4\r\nETag: \"fixture-etag\"\r\nConnection: close\r\n\r\nEVIL",
                )
                .await
                .unwrap();
        });

        let credentials = aws_sdk_s3::config::Credentials::new(
            "fixture-access",
            "fixture-secret",
            None,
            None,
            "scratch-safety-test",
        );
        let config = aws_sdk_s3::config::Builder::new()
            .endpoint_url(endpoint)
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .credentials_provider(credentials)
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::disabled())
            .force_path_style(true)
            .behavior_version_latest()
            .build();
        (Client::from_conf(config), server)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ranged_worker_rejects_same_length_scratch_symlink_without_mutating_target() {
        use std::os::unix::fs::symlink;

        let dir = scratch_test_dir();
        let temp_path = dir.join("download.tmp");
        let external_target = dir.join("important.bin");
        std::fs::write(&external_target, b"SAFE").unwrap();
        let (_, external_identity) =
            open_download_scratch_file(&external_target, false, None).unwrap();
        symlink(&external_target, &temp_path).unwrap();
        assert_eq!(std::fs::metadata(&temp_path).unwrap().len(), 4);

        let (client, server) = ranged_response_server().await;
        let cancel: CancelToken = Arc::new(CancelFlag::default());
        let result = download_parallel_part(
            client,
            "bucket".to_string(),
            "object.bin".to_string(),
            temp_path,
            external_identity,
            0,
            3,
            None,
            "\"fixture-etag\"".to_string(),
            cancel,
        )
        .await;
        server.await.unwrap();

        assert!(
            result.is_err(),
            "ranged worker must reject a symlink scratch entry"
        );
        assert_eq!(
            std::fs::read(&external_target).unwrap(),
            b"SAFE",
            "the symlink target must remain unchanged"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
