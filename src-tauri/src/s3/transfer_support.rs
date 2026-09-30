//! Transfer tuning, checkpoints, progress events and checksums.

use super::*;

pub(super) fn normalize_attempt(attempt: Option<u32>) -> u32 {
    attempt.unwrap_or(1).max(1)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(super) struct TransferCheckpoint {
    pub(super) version: u8,
    pub(super) mode: String,
    pub(super) bucket: String,
    pub(super) key: String,
    pub(super) destination: Option<String>,
    pub(super) temp_path: String,
    pub(super) total_bytes: u64,
    pub(super) part_size: u64,
    pub(super) completed_parts: Vec<u32>,
    pub(super) updated_at_ms: i64,
    // ETag of the object the checkpoint was created against. Used to detect a
    // server-side change between sessions so we don't resume into stale bytes.
    // Defaulted for backward compatibility with checkpoints written before this
    // field existed (those are treated as "no recorded etag" and discarded).
    #[serde(default)]
    pub(super) etag: String,
    // Version ID of the immutable object generation when versioning is enabled.
    // Old checkpoints have no value and are intentionally not resumable against
    // a versioned object: an ETag can be reused by distinct versions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) version_id: Option<String>,
}

pub(super) fn clamp_part_size_mb(value: Option<u32>, fallback: u32) -> u32 {
    value
        .unwrap_or(fallback)
        .clamp(MIN_PART_SIZE_MB, MAX_PART_SIZE_MB)
}

/// Content-Length is endpoint-controlled. A negative or overflowing value must
/// never become a huge unsigned progress total or part count.
pub(super) fn sanitized_content_length(value: Option<i64>) -> u64 {
    value.and_then(|v| u64::try_from(v).ok()).unwrap_or(0)
}

/// Attempt timeout for a request whose body can take real time to move.
///
/// The SDK's `operation_attempt_timeout` covers the whole attempt including
/// body streaming, so the fixed 45s global value fails large parts below
/// ~6 Mbps. Scale with payload size at a conservative floor rate instead.
pub(super) fn attempt_timeout_for_bytes(bytes: u64) -> Duration {
    Duration::from_secs(bytes / MIN_TRANSFER_RATE_BYTES_PER_SECOND)
        .clamp(MIN_BODY_ATTEMPT_TIMEOUT, MAX_BODY_ATTEMPT_TIMEOUT)
}

/// Per-operation config override that applies the scaled attempt timeout.
pub(super) fn body_attempt_timeout_override(bytes: u64) -> aws_sdk_s3::config::Builder {
    let timeout = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .operation_attempt_timeout(attempt_timeout_for_bytes(bytes))
        .build();
    aws_sdk_s3::config::Builder::new().timeout_config(timeout)
}

pub(super) fn clamp_transfer_concurrency(value: Option<u32>) -> usize {
    value
        .unwrap_or(DEFAULT_TRANSFER_CONCURRENCY)
        .clamp(1, MAX_TRANSFER_CONCURRENCY) as usize
}

pub(super) fn clamp_concurrency_for_budget(
    requested: usize,
    part_size_bytes: usize,
    budget_bytes: u64,
) -> usize {
    if part_size_bytes == 0 {
        return 1;
    }
    let cap = std::cmp::max(1, (budget_bytes / part_size_bytes as u64) as usize);
    requested.clamp(1, cap)
}

pub(super) fn clamp_bandwidth_limit_bps(value: Option<u32>) -> u64 {
    let mbps = value.unwrap_or(0);
    if mbps == 0 {
        return 0;
    }
    (mbps as u64) * 1024 * 1024 / 8
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct TransferErrorEnvelope {
    pub(super) code: String,
    pub(super) retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) http_status: Option<u16>,
    pub(super) message: String,
}

pub(super) fn encode_transfer_error(
    code: &str,
    retryable: bool,
    http_status: Option<u16>,
    message: String,
) -> String {
    let payload = TransferErrorEnvelope {
        code: code.to_string(),
        retryable,
        http_status,
        message: message.clone(),
    };
    match serde_json::to_string(&payload) {
        Ok(json) => format!("{}{}", TRANSFER_ERROR_PREFIX, json),
        Err(_) => message,
    }
}

pub(super) fn choose_upload_part_size_bytes(
    file_size: u64,
    requested_mb: Option<u32>,
) -> Result<usize, String> {
    let part_mb = clamp_part_size_mb(requested_mb, DEFAULT_UPLOAD_PART_SIZE_MB);
    let mut part_size = (part_mb as u64) * 1024 * 1024;
    let mut parts = file_size.div_ceil(part_size);
    if parts > 10_000 {
        // Grow the part size toward the 5 GiB provider maximum rather than
        // refusing objects above ~1.25 TiB at the default preset. Every part
        // except the last must be equal, which `div_ceil` preserves.
        const MAX_UPLOAD_PART_SIZE: u64 = 5 * 1024 * 1024 * 1024;
        part_size = file_size.div_ceil(10_000).min(MAX_UPLOAD_PART_SIZE);
        parts = file_size.div_ceil(part_size);
        if parts > 10_000 {
            return Err(
                "Object is too large to upload within the 10,000-part multipart limit.".to_string(),
            );
        }
    }
    Ok(part_size as usize)
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn compute_speed_eta(
    bytes_sent: u64,
    total_bytes: u64,
    started_at: Instant,
) -> (Option<u64>, Option<u64>) {
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    if elapsed_ms == 0 || bytes_sent == 0 {
        return (None, None);
    }
    let speed = ((bytes_sent as f64) * 1000.0 / (elapsed_ms as f64)).round() as u64;
    if speed == 0 {
        return (Some(0), None);
    }
    let remaining = total_bytes.saturating_sub(bytes_sent);
    let eta = if remaining == 0 {
        Some(0)
    } else {
        Some(((remaining as f64) / (speed as f64)).ceil() as u64)
    };
    (Some(speed), eta)
}

/// Bytes a transfer already had when this attempt began (a resumed download's
/// completed parts). Speed and ETA count only bytes moved by this attempt, or
/// resuming 9 of 10 GB would report ~9 GB/s and an ETA of zero.
pub(super) fn progress_baselines() -> &'static Mutex<HashMap<u32, u64>> {
    static BASELINES: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
    BASELINES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct ProgressBaseline {
    pub(super) transfer_id: u32,
}

impl ProgressBaseline {
    pub(super) fn set(transfer_id: u32, resumed_bytes: u64) -> Self {
        if let Ok(mut baselines) = progress_baselines().lock() {
            baselines.insert(transfer_id, resumed_bytes);
        }
        Self { transfer_id }
    }
}

impl Drop for ProgressBaseline {
    fn drop(&mut self) {
        if let Ok(mut baselines) = progress_baselines().lock() {
            baselines.remove(&self.transfer_id);
        }
    }
}

pub(super) fn emit_transfer_progress(
    app: &tauri::AppHandle,
    event: &str,
    transfer_id: u32,
    bytes_sent: u64,
    total_bytes: u64,
    attempt: u32,
    phase: &str,
    started_at: Instant,
    completed_parts: Option<u32>,
    total_parts: Option<u32>,
    checkpoint_id: Option<&str>,
    resumable: Option<bool>,
) {
    let baseline = progress_baselines()
        .lock()
        .ok()
        .and_then(|baselines| baselines.get(&transfer_id).copied())
        .unwrap_or(0)
        .min(bytes_sent);
    let (speed_bps, eta_seconds) = compute_speed_eta(
        bytes_sent - baseline,
        total_bytes.saturating_sub(baseline),
        started_at,
    );
    let _ = app.emit(
        event,
        UploadProgress {
            transfer_id,
            bytes_sent,
            total_bytes,
            attempt,
            phase: phase.to_string(),
            speed_bps,
            eta_seconds,
            completed_parts,
            total_parts,
            checkpoint_id: checkpoint_id.map(|v| v.to_string()),
            resumable,
        },
    );
}

pub(super) fn checkpoint_from_json(json: &str) -> Result<TransferCheckpoint, String> {
    serde_json::from_str::<TransferCheckpoint>(json)
        .map_err(|err| format!("Invalid transfer checkpoint JSON: {}", err))
}

pub(super) fn save_checkpoint_payload(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
    payload: &TransferCheckpoint,
    recovery_session: &str,
) -> Result<(), String> {
    let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    save_transfer_checkpoint_json(app, checkpoint_id, &json, recovery_session)
}

pub(super) async fn persist_checkpoint_and_advance<F, Fut>(
    last_saved_at: &mut Instant,
    last_saved_parts: &mut u32,
    completed_count: u32,
    persist: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    persist().await?;
    *last_saved_at = Instant::now();
    *last_saved_parts = completed_count;
    Ok(())
}

pub(super) fn normalize_checkpoint_parts(parts: &[u32], total_parts: u32) -> Vec<u32> {
    let mut set = BTreeSet::new();
    for part in parts {
        if *part < total_parts {
            set.insert(*part);
        }
    }
    set.into_iter().collect()
}

pub(super) fn maybe_range_unsupported(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("invalid range")
        || lower.contains("range")
            && (lower.contains("not satisfiable")
                || lower.contains("unsupported")
                || lower.contains("status code: 416")
                || lower.contains("http 416"))
}

pub(super) enum ExpectedChecksum {
    Hex(String),
    Base64(String),
}

pub(super) fn digest_to_hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

pub(super) fn digest_to_base64(digest: &[u8]) -> String {
    B64.encode(digest)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Sha256Checksum {
    pub(super) hex: String,
    pub(super) base64: String,
}

pub(super) type UploadedPart = (i32, usize, String, Option<Sha256Checksum>);

pub(super) fn sha256_checksum_from_digest(digest: &[u8]) -> Sha256Checksum {
    Sha256Checksum {
        hex: digest_to_hex(digest),
        base64: digest_to_base64(digest),
    }
}

pub(super) fn sha256_checksum_bytes(bytes: &[u8]) -> Sha256Checksum {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    sha256_checksum_from_digest(&hasher.finalize())
}

pub(super) fn sha256_composite_checksum(
    parts: &[Sha256Checksum],
) -> Result<(String, String), String> {
    if parts.is_empty() {
        return Err("Cannot calculate a multipart checksum without parts".to_string());
    }
    let mut hasher = Sha256::new();
    for part in parts {
        let digest = B64
            .decode(&part.base64)
            .map_err(|err| format!("Invalid multipart checksum encoding: {}", err))?;
        if digest.len() != 32 {
            return Err("Invalid multipart SHA-256 checksum length".to_string());
        }
        hasher.update(digest);
    }
    let base64 = digest_to_base64(&hasher.finalize());
    let response_value = format!("{}-{}", base64, parts.len());
    Ok((base64, response_value))
}

pub(super) async fn sha256_file(path: &Path, cancel: &CancelToken) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut hasher = Sha256::new();
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file for checksum: {}", e))?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let read = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = file.read(&mut buf) => {
                result.map_err(|e| format!("Failed to read file for checksum: {}", e))?
            }
        };
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hasher.finalize().to_vec())
}

pub(super) fn expected_checksum_from_head(
    head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
) -> Option<ExpectedChecksum> {
    // Prefer an S3-validated full-object checksum. Composite multipart SHA-256
    // values are not the SHA-256 of the object bytes, so retain the custom
    // full-object metadata hint for older composite uploads.
    if !matches!(head.checksum_type(), Some(ChecksumType::Composite)) {
        if let Some(value) = head.checksum_sha256() {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(ExpectedChecksum::Base64(trimmed));
            }
        }
    }
    if let Some(value) = head
        .metadata()
        .and_then(|metadata| metadata.get(CHECKSUM_METADATA_KEY))
    {
        let trimmed = value.trim().to_ascii_lowercase();
        if !trimmed.is_empty() {
            return Some(ExpectedChecksum::Hex(trimmed));
        }
    }
    None
}

pub(super) async fn expected_download_checksum(
    client: &Client,
    bucket: &str,
    key: &str,
    initial_head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
    cancel: &CancelToken,
) -> Result<ExpectedChecksum, String> {
    if let Some(expected) = expected_checksum_from_head(initial_head) {
        return Ok(expected);
    }

    let mut request = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .checksum_mode(ChecksumMode::Enabled);
    if let Some(etag) = initial_head
        .e_tag()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.if_match(etag);
    }
    let request = request.send();
    let checksum_head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result.map_err(|err| {
            encode_transfer_error(
                "checksum_unsupported",
                false,
                None,
                format!(
                    "Checksum verification was requested, but the provider could not return object checksums: {}",
                    err
                ),
            )
        })?,
    };

    expected_checksum_from_head(&checksum_head).ok_or_else(|| {
        encode_transfer_error(
            "checksum_unsupported",
            false,
            None,
            "Checksum verification was requested, but the object has no comparable full-object SHA-256 checksum."
                .to_string(),
        )
    })
}

pub(super) async fn verify_file_checksum(
    path: &Path,
    expected: &ExpectedChecksum,
    cancel: &CancelToken,
) -> Result<(), String> {
    let digest = sha256_file(path, cancel).await?;
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
            Ok(())
        }
        ExpectedChecksum::Base64(b64) => {
            let actual = digest_to_base64(&digest);
            if actual != *b64 {
                return Err(encode_transfer_error(
                    "checksum_mismatch",
                    false,
                    None,
                    "Checksum verification failed.".to_string(),
                ));
            }
            Ok(())
        }
    }
}

pub(super) fn verify_upload_checksum_value(
    actual: Option<&str>,
    expected: &str,
    context: &str,
) -> Result<(), String> {
    let Some(actual) = actual.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(encode_transfer_error(
            "checksum_unsupported",
            false,
            None,
            format!(
                "{} succeeded but the storage provider did not return its S3 SHA-256 checksum.",
                context
            ),
        ));
    };
    if actual != expected {
        return Err(encode_transfer_error(
            "checksum_mismatch",
            false,
            None,
            format!("{} returned a different S3 SHA-256 checksum.", context),
        ));
    }
    Ok(())
}

pub(super) fn verify_upload_checksum_response(
    actual: Option<&str>,
    expected: &Sha256Checksum,
    context: &str,
) -> Result<(), String> {
    verify_upload_checksum_value(actual, &expected.base64, context)
}

pub(super) fn checkpoint_generation_matches(
    checkpoint: &TransferCheckpoint,
    current_etag: &str,
    current_version_id: Option<&str>,
) -> bool {
    if checkpoint.etag.is_empty() || checkpoint.etag != current_etag {
        return false;
    }
    match current_version_id {
        Some(version_id) => checkpoint.version_id.as_deref() == Some(version_id),
        None => checkpoint.version_id.is_none(),
    }
}
