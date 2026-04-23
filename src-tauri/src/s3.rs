use aws_sdk_s3::types::{Delete, MetadataDirective, ObjectCannedAcl, ObjectIdentifier};
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use zeroize::Zeroize;

use crate::{
    load_transfer_checkpoint_json, lock_s3_state, make_temp_path, remove_transfer_checkpoint,
    save_transfer_checkpoint_json, validate_destination_path, validate_destination_path_allow_overwrite,
    validate_existing_path, AppState,
};

const MAX_UPLOAD_OBJECT_BYTES: usize = 16 * 1024 * 1024;
const MULTIPART_THRESHOLD: u64 = 128 * 1024 * 1024;
const DEFAULT_UPLOAD_PART_SIZE_MB: u32 = 32;
const DEFAULT_DOWNLOAD_PART_SIZE_MB: u32 = 32;
const MIN_PART_SIZE_MB: u32 = 16;
const MAX_PART_SIZE_MB: u32 = 128;
const DEFAULT_TRANSFER_CONCURRENCY: u32 = 6;
const MAX_TRANSFER_CONCURRENCY: u32 = 16;
const UPLOAD_PART_RETRY_ATTEMPTS: u32 = 3;
const PARALLEL_DOWNLOAD_THRESHOLD_MB: u32 = 128;
const RANGE_UNSUPPORTED_CODE: &str = "__range_unsupported__";
const MULTIPART_COPY_PART_SIZE: u64 = 500 * 1024 * 1024;
const MULTIPART_COPY_THRESHOLD: i64 = 5_368_709_120;
const MAX_KEY_LEN: usize = 1024;

fn validate_key(key: &str, label: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!("{} is too long (max {} characters)", label, MAX_KEY_LEN));
    }
    if key.as_bytes().iter().any(|&b| b == 0) {
        return Err(format!("{} contains invalid characters", label));
    }
    if key.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(format!("{} must not contain '..' or '.' path segments", label));
    }
    Ok(())
}

fn validate_prefix(prefix: &str, label: &str) -> Result<(), String> {
    if prefix.is_empty() {
        return Ok(());
    }
    validate_key(prefix, label)
}

static CANCELLED_TRANSFERS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();

fn cancelled_set() -> &'static Mutex<HashSet<u32>> {
    CANCELLED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_cancelled(transfer_id: u32) -> bool {
    cancelled_set()
        .lock()
        .map(|set| set.contains(&transfer_id))
        .unwrap_or(false)
}

fn mark_cancelled(transfer_id: u32) {
    if let Ok(mut set) = cancelled_set().lock() {
        set.insert(transfer_id);
    }
}

fn clear_cancelled(transfer_id: u32) {
    if let Ok(mut set) = cancelled_set().lock() {
        set.remove(&transfer_id);
    }
}

#[tauri::command]
pub(crate) fn cancel_transfer(transfer_id: u32) {
    mark_cancelled(transfer_id);
}

#[derive(serde::Serialize)]
pub(crate) struct BucketInfo {
    name: String,
    creation_date: String,
}

#[derive(serde::Serialize)]
pub(crate) struct ObjectInfo {
    key: String,
    size: i64,
    last_modified: String,
    is_folder: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct ListObjectsResponse {
    objects: Vec<ObjectInfo>,
    prefixes: Vec<String>,
    truncated: bool,
    next_continuation_token: String,
}

#[derive(serde::Serialize)]
pub(crate) struct HeadObjectResponse {
    content_type: String,
    content_length: i64,
    last_modified: String,
    etag: String,
    storage_class: String,
    cache_control: String,
    content_disposition: String,
    content_encoding: String,
    server_side_encryption: String,
    metadata: HashMap<String, String>,
}

#[derive(serde::Serialize)]
pub(crate) struct AclGrant {
    grantee: String,
    permission: String,
}

#[derive(serde::Serialize)]
pub(crate) struct AclResponse {
    owner: String,
    grants: Vec<AclGrant>,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct UploadProgress {
    transfer_id: u32,
    bytes_sent: u64,
    total_bytes: u64,
    attempt: u32,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed_bps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_parts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_parts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resumable: Option<bool>,
}

fn normalize_attempt(attempt: Option<u32>) -> u32 {
    attempt.unwrap_or(1).max(1)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct TransferCheckpoint {
    version: u8,
    mode: String,
    bucket: String,
    key: String,
    destination: Option<String>,
    temp_path: String,
    total_bytes: u64,
    part_size: u64,
    completed_parts: Vec<u32>,
    updated_at_ms: i64,
}

fn clamp_part_size_mb(value: Option<u32>, fallback: u32) -> u32 {
    value
        .unwrap_or(fallback)
        .clamp(MIN_PART_SIZE_MB, MAX_PART_SIZE_MB)
}

fn clamp_transfer_concurrency(value: Option<u32>) -> usize {
    value
        .unwrap_or(DEFAULT_TRANSFER_CONCURRENCY)
        .clamp(1, MAX_TRANSFER_CONCURRENCY) as usize
}

fn clamp_bandwidth_limit_bps(value: Option<u32>) -> u64 {
    let mbps = value.unwrap_or(0);
    if mbps == 0 {
        return 0;
    }
    (mbps as u64) * 1024 * 1024 / 8
}

fn choose_upload_part_size_bytes(file_size: u64, requested_mb: Option<u32>) -> Result<usize, String> {
    let part_mb = clamp_part_size_mb(requested_mb, DEFAULT_UPLOAD_PART_SIZE_MB);
    let part_size = (part_mb as u64) * 1024 * 1024;
    let parts = (file_size + part_size - 1) / part_size;
    if parts > 10_000 {
        return Err(format!(
            "File requires too many multipart parts ({}) with {}MB part size.",
            parts, part_mb
        ));
    }
    Ok(part_size as usize)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn compute_speed_eta(bytes_sent: u64, total_bytes: u64, started_at: Instant) -> (Option<u64>, Option<u64>) {
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

fn emit_transfer_progress(
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
    let (speed_bps, eta_seconds) = compute_speed_eta(bytes_sent, total_bytes, started_at);
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

fn checkpoint_from_json(json: &str) -> Option<TransferCheckpoint> {
    serde_json::from_str::<TransferCheckpoint>(json).ok()
}

fn save_checkpoint_payload(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
    payload: &TransferCheckpoint,
) -> Result<(), String> {
    let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    save_transfer_checkpoint_json(app, checkpoint_id, &json)
}

fn normalize_checkpoint_parts(parts: &[u32], total_parts: u32) -> Vec<u32> {
    let mut set = BTreeSet::new();
    for part in parts {
        if *part < total_parts {
            set.insert(*part);
        }
    }
    set.into_iter().collect()
}

fn maybe_range_unsupported(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("invalid range")
        || lower.contains("range")
            && (lower.contains("not satisfiable")
                || lower.contains("unsupported")
                || lower.contains("status code: 416")
                || lower.contains("http 416"))
}

#[derive(serde::Serialize)]
pub(crate) struct PreviewResponse {
    content_type: String,
    data: String,
    is_text: bool,
    truncated: bool,
    total_size: i64,
}

fn is_text_content_type(ct: &str) -> bool {
    ct.starts_with("text/")
        || ct == "application/json"
        || ct == "application/xml"
        || ct == "application/javascript"
        || ct == "image/svg+xml"
        || ct == "application/x-yaml"
        || ct == "application/toml"
}

fn encode_copy_source(bucket: &str, key: &str) -> String {
    let encoded_bucket = urlencoding::encode(bucket);
    let encoded_key = key
        .split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!("{}/{}", encoded_bucket, encoded_key)
}

fn parse_endpoint_host(endpoint: &str) -> Option<String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return None;
    }

    let after_scheme = match trimmed.split_once("://") {
        Some((_, rest)) => rest,
        None => trimmed,
    };
    let authority = after_scheme.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }

    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if host_port.starts_with('[') {
        return None;
    }

    let host = host_port
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.');
    if host.is_empty() {
        return None;
    }

    Some(host.to_ascii_lowercase())
}

fn is_region_like_label(label: &str) -> bool {
    let parts: Vec<&str> = label.split('-').collect();
    if parts.len() < 3 || parts.iter().any(|p| p.is_empty()) {
        return false;
    }
    if parts[0].len() != 2 || !parts[0].chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    if !parts
        .last()
        .map(|p| p.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
    {
        return false;
    }
    parts[1..parts.len() - 1]
        .iter()
        .all(|segment| segment.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn infer_region_from_host(host: &str) -> Option<String> {
    if host == "s3.amazonaws.com" || host.ends_with(".s3.amazonaws.com") {
        return Some("us-east-1".to_string());
    }

    let do_suffix = ".digitaloceanspaces.com";
    if host.ends_with(do_suffix) {
        let prefix = host.trim_end_matches(do_suffix).trim_end_matches('.');
        if !prefix.is_empty() {
            return prefix.rsplit('.').next().map(|s| s.to_string());
        }
    }

    for label in host.split('.') {
        if is_region_like_label(label) {
            return Some(label.to_string());
        }
    }

    None
}

fn resolve_region(endpoint: &str, region: &str) -> Result<String, String> {
    let provided = region.trim();
    if !provided.is_empty() {
        return Ok(provided.to_string());
    }

    let host = parse_endpoint_host(endpoint).ok_or_else(|| {
        "Region is required when endpoint host cannot be parsed. Enter region (for example: nyc3 or us-east-1)."
            .to_string()
    })?;

    infer_region_from_host(&host).ok_or_else(|| {
        "Region is required for this endpoint. Enter region manually (for example: nyc3 or us-east-1)."
            .to_string()
    })
}

/// Normalize an endpoint string into a full URL suitable for the AWS SDK.
fn normalize_endpoint(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim().trim_end_matches('/');

    // Ensure scheme is present.
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let (scheme, after_scheme) = with_scheme.split_once("://").unwrap();
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let path = after_scheme
        .strip_prefix(authority)
        .unwrap_or("")
        .trim_matches('/');

    // Separate host from optional port.
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (authority, None),
    };

    let host_lower = host.to_ascii_lowercase();
    let mut bucket_hint: Option<String> = None;

    // Extract bucket from path if present
    if !path.is_empty() {
        let first_segment = path.split('/').next().unwrap_or("");
        if !first_segment.is_empty() {
            bucket_hint = Some(first_segment.to_string());
        }
    }

    let do_suffix = ".digitaloceanspaces.com";
    let normalized_host = if host_lower.ends_with(do_suffix) {
        let prefix = host_lower.trim_end_matches(do_suffix);
        let parts: Vec<&str> = prefix.split('.').collect();
        if parts.len() >= 2 {
            if bucket_hint.is_none() {
                bucket_hint = Some(parts[0].to_string());
            }
            format!("{}{}", parts[parts.len() - 1], do_suffix)
        } else {
            host_lower
        }
    } else {
        host_lower
    };

    let url = match port {
        Some(p) => format!("{}://{}:{}", scheme, normalized_host, p),
        None => format!("{}://{}", scheme, normalized_host),
    };

    (url, bucket_hint)
}

fn format_sdk_error<E: std::fmt::Debug>(prefix: &str, err: &aws_sdk_s3::error::SdkError<E>) -> String {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => {
            let raw = ctx.raw();
            let status = raw.status().as_u16();
            let body = String::from_utf8_lossy(raw.body().bytes().unwrap_or(&[]));
            format!("{} (HTTP {}): {}", prefix, status, body)
        }
        SdkError::DispatchFailure(err) => {
            format!("{} (dispatch): {:?}", prefix, err)
        }
        other => format!("{}: {:?}", prefix, other),
    }
}

async fn infer_canned_acl_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
) -> Option<ObjectCannedAcl> {
    let output = client
        .get_object_acl()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .ok()?;

    let has_public_read = output.grants().iter().any(|grant| {
        let is_read = grant
            .permission()
            .map(|permission| permission.as_str().eq_ignore_ascii_case("READ"))
            .unwrap_or(false);
        if !is_read {
            return false;
        }

        let uri = grant
            .grantee()
            .and_then(|grantee| grantee.uri())
            .unwrap_or_default()
            .to_ascii_lowercase();
        uri.contains("allusers")
    });

    Some(if has_public_read {
        ObjectCannedAcl::PublicRead
    } else {
        ObjectCannedAcl::Private
    })
}

#[tauri::command]
pub(crate) async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    mut access_key: String,
    mut secret_key: String,
) -> Result<String, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("Endpoint is required".to_string());
    }
    let resolved_region = resolve_region(&endpoint, &region)?;
    let (normalized, bucket_hint) = normalize_endpoint(&endpoint);

    let creds =
        aws_sdk_s3::config::Credentials::new(&access_key, &secret_key, None, None, "s3-sidekick");

    // Zeroize the plaintext credential strings now that they've been consumed
    access_key.zeroize();
    secret_key.zeroize();

    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(&normalized)
        .region(aws_sdk_s3::config::Region::new(resolved_region.clone()))
        .credentials_provider(creds)
        .force_path_style(true)
        .behavior_version_latest()
        .build();

    let client = Client::from_conf(config);

    // Verify connectivity. Try list_buckets first; if that gets AccessDenied
    // (common with scoped keys on DO Spaces), fall back to head_bucket using
    // the bucket extracted from the endpoint URL.
    let list_result = client.list_buckets().send().await;
    if let Err(list_err) = &list_result {
        let is_access_denied = {
            use aws_sdk_s3::error::SdkError;
            matches!(list_err, SdkError::ServiceError(ctx)
                if ctx.raw().status().as_u16() == 403)
        };
        if is_access_denied {
            if let Some(ref bucket) = bucket_hint {
                // Fall back: verify we can at least reach this specific bucket.
                client
                    .head_bucket()
                    .bucket(bucket)
                    .send()
                    .await
                    .map_err(|e| format_sdk_error("Connection failed", &e))?;
            } else {
                // No bucket hint to fall back on — report the 403.
                return Err(format_sdk_error("Connection failed", list_err));
            }
        } else {
            return Err(format_sdk_error("Connection failed", list_err));
        }
    }

    let mut s3 = lock_s3_state(&state)?;
    s3.client = Some(client);
    s3.endpoint = normalized;
    s3.region = resolved_region.clone();
    s3.bucket_hint = bucket_hint;

    Ok(resolved_region)
}

#[tauri::command]
pub(crate) fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut s3 = lock_s3_state(&state)?;
    s3.client = None;
    s3.bucket_hint = None;
    s3.endpoint.clear();
    s3.region.clear();
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_buckets(state: tauri::State<'_, AppState>) -> Result<Vec<BucketInfo>, String> {
    let (client, bucket_hint) = {
        let s3 = lock_s3_state(&state)?;
        (s3.client.clone().ok_or("Not connected")?, s3.bucket_hint.clone())
    };

    match client.list_buckets().send().await {
        Ok(output) => {
            let buckets = output
                .buckets()
                .iter()
                .map(|b| BucketInfo {
                    name: b.name().unwrap_or_default().to_string(),
                    creation_date: b.creation_date().map(|d| d.to_string()).unwrap_or_default(),
                })
                .collect();
            Ok(buckets)
        }
        Err(err) => {
            // If list_buckets is denied (scoped key), return the bucket hint.
            use aws_sdk_s3::error::SdkError;
            let is_access_denied = matches!(&err, SdkError::ServiceError(ctx)
                if ctx.raw().status().as_u16() == 403);
            if is_access_denied {
                if let Some(name) = bucket_hint {
                    return Ok(vec![BucketInfo {
                        name,
                        creation_date: String::new(),
                    }]);
                }
            }
            Err(format_sdk_error("Failed to list buckets", &err))
        }
    }
}

#[tauri::command]
pub(crate) async fn list_objects(
    state: tauri::State<'_, AppState>,
    bucket: String,
    prefix: String,
    delimiter: String,
    continuation_token: String,
) -> Result<ListObjectsResponse, String> {
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let mut req = client.list_objects_v2().bucket(&bucket).max_keys(1000);

    if !prefix.is_empty() {
        req = req.prefix(&prefix);
    }
    if !delimiter.is_empty() {
        req = req.delimiter(&delimiter);
    }
    if !continuation_token.is_empty() {
        req = req.continuation_token(&continuation_token);
    }

    let output = req
        .send()
        .await
        .map_err(|e| format!("Failed to list objects: {}", e))?;

    let objects = output
        .contents()
        .iter()
        .map(|obj| {
            let key = obj.key().unwrap_or_default().to_string();
            let is_folder = key.ends_with('/');
            ObjectInfo {
                key,
                size: obj.size().unwrap_or(0),
                last_modified: obj
                    .last_modified()
                    .map(|d| d.to_string())
                    .unwrap_or_default(),
                is_folder,
            }
        })
        .collect();

    let prefixes = output
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|s| s.to_string()))
        .collect();

    let truncated = output.is_truncated().unwrap_or(false);
    let next_continuation_token = output.next_continuation_token().unwrap_or("").to_string();

    Ok(ListObjectsResponse {
        objects,
        prefixes,
        truncated,
        next_continuation_token,
    })
}

#[tauri::command]
pub(crate) async fn head_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<HeadObjectResponse, String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let metadata = output
        .metadata()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    Ok(HeadObjectResponse {
        content_type: output.content_type().unwrap_or("").to_string(),
        content_length: output.content_length().unwrap_or(0),
        last_modified: output
            .last_modified()
            .map(|d| d.to_string())
            .unwrap_or_default(),
        etag: output.e_tag().unwrap_or("").to_string(),
        storage_class: output
            .storage_class()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        cache_control: output.cache_control().unwrap_or("").to_string(),
        content_disposition: output.content_disposition().unwrap_or("").to_string(),
        content_encoding: output.content_encoding().unwrap_or("").to_string(),
        server_side_encryption: output
            .server_side_encryption()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        metadata,
    })
}

#[tauri::command]
pub(crate) async fn object_exists(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<bool, String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    match client.head_object().bucket(&bucket).key(&key).send().await {
        Ok(_) => Ok(true),
        Err(err) => {
            use aws_sdk_s3::error::SdkError;
            match err {
                SdkError::ServiceError(ctx) => {
                    let status = ctx.raw().status().as_u16();
                    if status == 404 {
                        Ok(false)
                    } else {
                        Err(format!(
                            "Failed to check object existence (HTTP {}): {}",
                            status,
                            String::from_utf8_lossy(ctx.raw().body().bytes().unwrap_or(&[]))
                        ))
                    }
                }
                other => Err(format!("Failed to check object existence: {:?}", other)),
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn update_metadata(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    content_type: String,
    metadata: HashMap<String, String>,
) -> Result<(), String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let source = encode_copy_source(&bucket, &key);
    let preserved_acl = infer_canned_acl_for_object(&client, &bucket, &key).await;
    let mut req = client
        .copy_object()
        .bucket(&bucket)
        .key(&key)
        .copy_source(&source)
        .content_type(&content_type)
        .metadata_directive(MetadataDirective::Replace);

    if let Some(acl) = preserved_acl {
        req = req.acl(acl);
    }

    for (k, v) in &metadata {
        req = req.metadata(k, v);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to update metadata: {}", e))?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_objects(
    state: tauri::State<'_, AppState>,
    bucket: String,
    keys: Vec<String>,
) -> Result<u32, String> {
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let mut deleted = 0u32;
    for chunk in keys.chunks(1000) {
        let objects: Vec<ObjectIdentifier> = chunk
            .iter()
            .map(|k| {
                ObjectIdentifier::builder()
                    .key(k)
                    .build()
                    .map_err(|e| format!("Invalid key: {}", e))
            })
            .collect::<Result<_, _>>()?;

        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(|e| format!("Delete build error: {}", e))?;

        let output = client
            .delete_objects()
            .bucket(&bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|e| format!("Batch delete failed: {}", e))?;

        let errors = output.errors();
        if !errors.is_empty() {
            let sample: Vec<String> = errors
                .iter()
                .take(3)
                .map(|err| {
                    format!(
                        "{}: {}",
                        err.key().unwrap_or("?"),
                        err.message().unwrap_or("unknown error")
                    )
                })
                .collect();
            return Err(format!(
                "Failed to delete {} object(s). {}",
                errors.len(),
                sample.join("; ")
            ));
        }

        deleted += chunk.len() as u32;
    }

    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn upload_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checkpoint_id: Option<String>,
    resumable: Option<bool>,
) -> Result<(), String> {
    validate_key(&key, "Object key")?;
    let upload_path = validate_existing_path(&file_path, "Upload file")?;

    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let file_size = tokio::fs::metadata(&upload_path)
        .await
        .map_err(|e| format!("File no longer accessible: {}", e))?
        .len();

    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let resumable_enabled = resumable.unwrap_or(false);
    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        0,
        file_size,
        attempt,
        "running",
        started_at,
        None,
        None,
        checkpoint_id.as_deref(),
        Some(resumable_enabled),
    );

    if file_size >= MULTIPART_THRESHOLD {
        let part_size_bytes = choose_upload_part_size_bytes(file_size, part_size_mb)?;
        let part_workers = clamp_transfer_concurrency(part_concurrency);
        let bandwidth_limit_bps = clamp_bandwidth_limit_bps(bandwidth_limit_mbps);
        upload_multipart(
            &app,
            &client,
            &bucket,
            &key,
            &upload_path,
            &content_type,
            transfer_id,
            attempt,
            file_size,
            part_size_bytes,
            part_workers,
            bandwidth_limit_bps,
            checkpoint_id.as_deref(),
            resumable_enabled,
            started_at,
        )
        .await?;
    } else {
        if is_cancelled(transfer_id) {
            clear_cancelled(transfer_id);
            return Err("Transfer cancelled".to_string());
        }

        let body = aws_sdk_s3::primitives::ByteStream::from_path(upload_path.as_path())
            .await
            .map_err(|e| format!("Failed to open file stream: {}", e))?;

        let mut req = client.put_object().bucket(&bucket).key(&key).body(body);

        if !content_type.is_empty() {
            req = req.content_type(&content_type);
        }

        req.send()
            .await
            .map_err(|e| format!("Failed to upload: {}", e))?;
    }

    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        file_size,
        file_size,
        attempt,
        "verifying",
        started_at,
        None,
        None,
        checkpoint_id.as_deref(),
        Some(resumable_enabled),
    );
    clear_cancelled(transfer_id);

    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_object_resumable(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checkpoint_id: Option<String>,
    resumable: Option<bool>,
) -> Result<(), String> {
    upload_object(
        app,
        state,
        bucket,
        key,
        file_path,
        content_type,
        transfer_id,
        attempt,
        part_size_mb,
        part_concurrency,
        bandwidth_limit_mbps,
        checkpoint_id,
        resumable,
    )
    .await
}

async fn upload_part_with_retry(
    client: Client,
    bucket: String,
    key: String,
    upload_id: String,
    part_number: i32,
    data: Vec<u8>,
) -> Result<(i32, usize, String), String> {
    let bytes = data.len();
    let mut last_error = String::new();
    for attempt in 1..=UPLOAD_PART_RETRY_ATTEMPTS {
        let body = aws_sdk_s3::primitives::ByteStream::from(data.clone());
        match client
            .upload_part()
            .bucket(&bucket)
            .key(&key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(body)
            .send()
            .await
        {
            Ok(output) => {
                let etag = output.e_tag().unwrap_or_default().to_string();
                return Ok((part_number, bytes, etag));
            }
            Err(err) => {
                last_error = format!("Failed to upload part {}: {}", part_number, err);
                if attempt < UPLOAD_PART_RETRY_ATTEMPTS {
                    let delay = Duration::from_millis(250 * (2u64.pow(attempt - 1)));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_error)
}

async fn upload_multipart(
    app: &tauri::AppHandle,
    client: &Client,
    bucket: &str,
    key: &str,
    file_path: &Path,
    content_type: &str,
    transfer_id: u32,
    attempt: u32,
    file_size: u64,
    part_size_bytes: usize,
    max_concurrent_parts: usize,
    bandwidth_limit_bps: u64,
    checkpoint_id: Option<&str>,
    resumable: bool,
    started_at: Instant,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    use tokio::task::JoinSet;

    let mut create_req = client.create_multipart_upload().bucket(bucket).key(key);
    if !content_type.is_empty() {
        create_req = create_req.content_type(content_type);
    }

    let create_output = create_req
        .send()
        .await
        .map_err(|e| format!("Failed to create multipart upload: {}", e))?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned")?
        .to_string();

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let total_parts = ((file_size + part_size_bytes as u64 - 1) / part_size_bytes as u64) as usize;
    let mut completed_parts: Vec<Option<aws_sdk_s3::types::CompletedPart>> =
        vec![None; total_parts];
    let mut part_number = 1i32;
    let mut bytes_sent = 0u64;
    let mut eof = false;
    let mut join_set: JoinSet<Result<(i32, usize, String), String>> = JoinSet::new();

    let abort = |client: &Client, bucket: &str, key: &str, upload_id: &str| {
        let client = client.clone();
        let bucket = bucket.to_string();
        let key = key.to_string();
        let upload_id = upload_id.to_string();
        async move {
            let _ = client
                .abort_multipart_upload()
                .bucket(&bucket)
                .key(&key)
                .upload_id(&upload_id)
                .send()
                .await;
        }
    };

    loop {
        if is_cancelled(transfer_id) {
            clear_cancelled(transfer_id);
            join_set.abort_all();
            abort(client, bucket, key, &upload_id).await;
            return Err("Transfer cancelled".to_string());
        }

        while join_set.len() < max_concurrent_parts && !eof {
            let mut buf = vec![0u8; part_size_bytes];
            let mut read = 0;
            while read < part_size_bytes {
                let n = file
                    .read(&mut buf[read..])
                    .await
                    .map_err(|e| format!("Failed to read file: {}", e))?;
                if n == 0 {
                    break;
                }
                read += n;
            }
            if read == 0 {
                eof = true;
                break;
            }
            buf.truncate(read);

            let client = client.clone();
            let bucket = bucket.to_string();
            let key = key.to_string();
            let uid = upload_id.clone();
            let pn = part_number;

            join_set.spawn(async move {
                upload_part_with_retry(client, bucket, key, uid, pn, buf).await
            });

            part_number += 1;
        }

        if join_set.is_empty() {
            break;
        }

        match join_set.join_next().await {
            Some(Ok(Ok((pn, bytes_read, etag)))) => {
                completed_parts[(pn - 1) as usize] = Some(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .part_number(pn)
                        .e_tag(etag)
                        .build(),
                );
                bytes_sent += bytes_read as u64;
                if bandwidth_limit_bps > 0 {
                    let elapsed = started_at.elapsed().as_secs_f64();
                    let target = bytes_sent as f64 / bandwidth_limit_bps as f64;
                    if target > elapsed {
                        tokio::time::sleep(Duration::from_secs_f64(target - elapsed)).await;
                    }
                }
                emit_transfer_progress(
                    app,
                    "upload-progress",
                    transfer_id,
                    bytes_sent,
                    file_size,
                    attempt,
                    "running",
                    started_at,
                    Some((pn as u32).min(total_parts as u32)),
                    Some(total_parts as u32),
                    checkpoint_id,
                    Some(resumable),
                );
            }
            Some(Ok(Err(e))) => {
                join_set.abort_all();
                abort(client, bucket, key, &upload_id).await;
                return Err(e);
            }
            Some(Err(e)) => {
                join_set.abort_all();
                abort(client, bucket, key, &upload_id).await;
                return Err(format!("Upload task failed: {}", e));
            }
            None => break,
        }
    }

    let final_parts: Vec<aws_sdk_s3::types::CompletedPart> =
        completed_parts.into_iter().flatten().collect();

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(final_parts))
        .build();

    if let Err(e) = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload)
        .send()
        .await
    {
        abort(client, bucket, key, &upload_id).await;
        return Err(format!("Failed to complete multipart upload: {}", e));
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_object_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    bytes: Vec<u8>,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
) -> Result<(), String> {
    validate_key(&key, "Object key")?;
    if bytes.len() > MAX_UPLOAD_OBJECT_BYTES {
        return Err(format!(
            "Browser upload fallback is limited to {} MB.",
            MAX_UPLOAD_OBJECT_BYTES / (1024 * 1024)
        ));
    }

    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let total = bytes.len() as u64;
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        0,
        total,
        attempt,
        "running",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    let mut req = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(bytes));

    if !content_type.is_empty() {
        req = req.content_type(&content_type);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to upload: {}", e))?;

    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        total,
        total,
        attempt,
        "verifying",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_object_acl(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<AclResponse, String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .get_object_acl()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get ACL: {}", e))?;

    let owner = output
        .owner()
        .and_then(|o| o.display_name())
        .unwrap_or("")
        .to_string();

    let grants = output
        .grants()
        .iter()
        .map(|g| {
            let grantee = g
                .grantee()
                .map(|gr| {
                    gr.display_name()
                        .or(gr.uri())
                        .or(gr.id())
                        .unwrap_or("Unknown")
                        .to_string()
                })
                .unwrap_or_default();
            let permission = g
                .permission()
                .map(|p| p.as_str().to_string())
                .unwrap_or_default();
            AclGrant {
                grantee,
                permission,
            }
        })
        .collect();

    Ok(AclResponse { owner, grants })
}

#[tauri::command]
pub(crate) async fn set_object_acl(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    visibility: String,
) -> Result<(), String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let acl = match visibility.trim().to_ascii_lowercase().as_str() {
        "private" => ObjectCannedAcl::Private,
        "public-read" => ObjectCannedAcl::PublicRead,
        other => return Err(format!("Unsupported ACL visibility: {}", other)),
    };

    client
        .put_object_acl()
        .bucket(&bucket)
        .key(&key)
        .acl(acl)
        .send()
        .await
        .map_err(|e| format!("Failed to update ACL: {}", e))?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn download_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
    overwrite: bool,
    temp_path: Option<String>,
    attempt: Option<u32>,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    validate_key(&key, "Object key")?;
    let destination_path = if overwrite {
        validate_destination_path_allow_overwrite(&destination)?
    } else {
        validate_destination_path(&destination)?
    };
    let temp_path = match temp_path {
        Some(custom) => {
            let custom_path = validate_destination_path_allow_overwrite(&custom)?;
            if custom_path == destination_path {
                return Err("Temp path must be different from destination".to_string());
            }
            custom_path
        }
        None => make_temp_path(&destination_path, "download"),
    };
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();

    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    if is_cancelled(transfer_id) {
        clear_cancelled(transfer_id);
        return Err("Transfer cancelled".to_string());
    }

    let output = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    let total_bytes = output.content_length().unwrap_or(0) as u64;
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

    let mut reader = output.body.into_async_read();
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    let mut written = 0u64;
    let mut last_emitted = 0u64;
    let mut buf = [0u8; 64 * 1024];
    const PROGRESS_INTERVAL: u64 = 256 * 1024;

    loop {
        if is_cancelled(transfer_id) {
            clear_cancelled(transfer_id);
            drop(file);
            let _ = std::fs::remove_file(&temp_path);
            return Err("Transfer cancelled".to_string());
        }

        let count = reader
            .read(&mut buf)
            .await
            .map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                format!("Failed to read body: {}", e)
            })?;
        if count == 0 {
            break;
        }

        file.write_all(&buf[..count]).await.map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to write temp file: {}", e)
        })?;
        written += count as u64;

        if written - last_emitted >= PROGRESS_INTERVAL {
            emit_transfer_progress(
                &app,
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
        }
    }

    if total_bytes > 0 && written != total_bytes {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "Downloaded byte count mismatch. Expected {}, wrote {}.",
            total_bytes, written
        ));
    }

    file.flush().await.map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to flush temp file: {}", e)
    })?;
    file.sync_all().await.map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to sync temp file: {}", e)
    })?;
    drop(file);

    if overwrite && destination_path.exists() {
        std::fs::remove_file(&destination_path)
            .map_err(|e| format!("Failed to replace destination: {}", e))?;
    }

    if let Err(e) = std::fs::rename(&temp_path, &destination_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to finalize download: {}", e));
    }

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
    clear_cancelled(transfer_id);

    Ok(written)
}

async fn download_parallel_part(
    client: Client,
    bucket: String,
    key: String,
    temp_path: PathBuf,
    start: u64,
    end: u64,
    transfer_id: u32,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    if is_cancelled(transfer_id) {
        return Err("Transfer cancelled".to_string());
    }

    let output = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range(format!("bytes={}-{}", start, end))
        .send()
        .await
        .map_err(|e| format!("Failed ranged download {}-{}: {}", start, end, e))?;

    let mut reader = output.body.into_async_read();
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to open temp file: {}", e))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("Failed to seek temp file: {}", e))?;

    let mut written = 0u64;
    let mut buf = [0u8; 128 * 1024];
    loop {
        if is_cancelled(transfer_id) {
            return Err("Transfer cancelled".to_string());
        }
        let count = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed to read ranged body: {}", e))?;
        if count == 0 {
            break;
        }
        file.write_all(&buf[..count])
            .await
            .map_err(|e| format!("Failed to write ranged temp file: {}", e))?;
        written += count as u64;
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush ranged temp file: {}", e))?;
    Ok(written)
}

#[tauri::command]
pub(crate) async fn download_object_parallel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
    overwrite: bool,
    temp_path: Option<String>,
    attempt: Option<u32>,
    parallel_threshold_mb: Option<u32>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checkpoint_id: Option<String>,
    enable_resume: Option<bool>,
    resume_completed_parts: Option<Vec<u32>>,
) -> Result<u64, String> {
    validate_key(&key, "Object key")?;
    let destination_path = if overwrite {
        validate_destination_path_allow_overwrite(&destination)?
    } else {
        validate_destination_path(&destination)?
    };
    let temp_path = match temp_path {
        Some(custom) => {
            let custom_path = validate_destination_path_allow_overwrite(&custom)?;
            if custom_path == destination_path {
                return Err("Temp path must be different from destination".to_string());
            }
            custom_path
        }
        None => make_temp_path(&destination_path, "download"),
    };
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let threshold_mb = parallel_threshold_mb.unwrap_or(PARALLEL_DOWNLOAD_THRESHOLD_MB).max(1);

    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    if is_cancelled(transfer_id) {
        clear_cancelled(transfer_id);
        return Err("Transfer cancelled".to_string());
    }

    let head = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to read object metadata: {}", e))?;
    let total_bytes = head.content_length().unwrap_or(0) as u64;
    let threshold_bytes = (threshold_mb as u64) * 1024 * 1024;

    if total_bytes < threshold_bytes || total_bytes == 0 {
        return download_object(
            app,
            state,
            bucket,
            key,
            destination,
            transfer_id,
            overwrite,
            Some(temp_path.to_string_lossy().to_string()),
            Some(attempt),
        )
        .await;
    }

    let part_size = (clamp_part_size_mb(part_size_mb, DEFAULT_DOWNLOAD_PART_SIZE_MB) as u64) * 1024 * 1024;
    let total_parts = ((total_bytes + part_size - 1) / part_size) as u32;
    if total_parts <= 1 {
        return download_object(
            app,
            state,
            bucket,
            key,
            destination,
            transfer_id,
            overwrite,
            Some(temp_path.to_string_lossy().to_string()),
            Some(attempt),
        )
        .await;
    }

    let part_workers = clamp_transfer_concurrency(part_concurrency);
    let bandwidth_limit_bps = clamp_bandwidth_limit_bps(bandwidth_limit_mbps);
    let checkpoint_enabled =
        enable_resume.unwrap_or(true) && checkpoint_id.as_ref().map(|id| !id.trim().is_empty()).unwrap_or(false);

    match client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range("bytes=0-0")
        .send()
        .await
    {
        Ok(_) => {}
        Err(err) => {
            let text = format!("{}", err);
            if maybe_range_unsupported(&text) {
                return Err(format!("{}: {}", RANGE_UNSUPPORTED_CODE, text));
            }
            return Err(format!("Ranged download preflight failed: {}", err));
        }
    }

    if temp_path.exists() && !checkpoint_enabled {
        let _ = std::fs::remove_file(&temp_path);
    }

    let mut completed = vec![false; total_parts as usize];
    if let Some(parts) = resume_completed_parts {
        for part in normalize_checkpoint_parts(&parts, total_parts) {
            completed[part as usize] = true;
        }
    }

    if checkpoint_enabled {
        if let Some(id) = checkpoint_id.as_deref() {
            if let Ok(Some(json)) = load_transfer_checkpoint_json(&app, id) {
                if let Some(payload) = checkpoint_from_json(&json) {
                    if payload.mode == "download_parallel"
                        && payload.bucket == bucket
                        && payload.key == key
                        && payload.temp_path == temp_path.to_string_lossy()
                        && payload.total_bytes == total_bytes
                        && payload.part_size == part_size
                    {
                        for part in normalize_checkpoint_parts(&payload.completed_parts, total_parts) {
                            completed[part as usize] = true;
                        }
                    }
                }
            }
        }
    }

    let init_file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    init_file
        .set_len(total_bytes)
        .await
        .map_err(|e| format!("Failed to set temp file length: {}", e))?;
    init_file
        .sync_all()
        .await
        .map_err(|e| format!("Failed to sync temp file: {}", e))?;
    drop(init_file);

    let mut completed_bytes = 0u64;
    for index in 0..total_parts {
        if completed[index as usize] {
            let start = (index as u64) * part_size;
            let end = std::cmp::min(start + part_size, total_bytes);
            completed_bytes += end - start;
        }
    }

    emit_transfer_progress(
        &app,
        "download-progress",
        transfer_id,
        completed_bytes,
        total_bytes,
        attempt,
        if completed_bytes > 0 { "resuming" } else { "running" },
        started_at,
        Some(completed.iter().filter(|v| **v).count() as u32),
        Some(total_parts),
        checkpoint_id.as_deref(),
        Some(checkpoint_enabled),
    );

    let bytes_done = Arc::new(AtomicU64::new(completed_bytes));
    let mut join_set = tokio::task::JoinSet::new();
    let mut next_part = 0u32;

    while next_part < total_parts || !join_set.is_empty() {
        if is_cancelled(transfer_id) {
            clear_cancelled(transfer_id);
            join_set.abort_all();
            if !checkpoint_enabled {
                let _ = std::fs::remove_file(&temp_path);
            }
            return Err("Transfer cancelled".to_string());
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
            let client_clone = client.clone();
            join_set.spawn(async move {
                let size =
                    download_parallel_part(client_clone, bucket_clone, key_clone, path_clone, start, end, transfer_id)
                        .await?;
                Ok::<(u32, u64), String>((index, size))
            });
        }

        match join_set.join_next().await {
            Some(Ok(Ok((index, written)))) => {
                completed[index as usize] = true;
                let sent = bytes_done.fetch_add(written, Ordering::Relaxed) + written;
                if bandwidth_limit_bps > 0 {
                    let elapsed = started_at.elapsed().as_secs_f64();
                    let target = sent as f64 / bandwidth_limit_bps as f64;
                    if target > elapsed {
                        tokio::time::sleep(Duration::from_secs_f64(target - elapsed)).await;
                    }
                }
                let completed_count = completed.iter().filter(|v| **v).count() as u32;

                if checkpoint_enabled {
                    if let Some(id) = checkpoint_id.as_deref() {
                        let payload = TransferCheckpoint {
                            version: 1,
                            mode: "download_parallel".to_string(),
                            bucket: bucket.clone(),
                            key: key.clone(),
                            destination: Some(destination.clone()),
                            temp_path: temp_path.to_string_lossy().to_string(),
                            total_bytes,
                            part_size,
                            completed_parts: completed
                                .iter()
                                .enumerate()
                                .filter_map(|(i, done)| if *done { Some(i as u32) } else { None })
                                .collect(),
                            updated_at_ms: now_ms(),
                        };
                        let _ = save_checkpoint_payload(&app, id, &payload);
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
                if !checkpoint_enabled {
                    let _ = std::fs::remove_file(&temp_path);
                }
                if maybe_range_unsupported(&err) {
                    return Err(format!("{}: {}", RANGE_UNSUPPORTED_CODE, err));
                }
                return Err(err);
            }
            Some(Err(err)) => {
                join_set.abort_all();
                if !checkpoint_enabled {
                    let _ = std::fs::remove_file(&temp_path);
                }
                return Err(format!("Parallel worker failed: {}", err));
            }
            None => break,
        }
    }

    let final_bytes = bytes_done.load(Ordering::Relaxed);
    if final_bytes != total_bytes {
        if !checkpoint_enabled {
            let _ = std::fs::remove_file(&temp_path);
        }
        return Err(format!(
            "Downloaded byte count mismatch. Expected {}, wrote {}.",
            total_bytes, final_bytes
        ));
    }

    if overwrite && destination_path.exists() {
        std::fs::remove_file(&destination_path)
            .map_err(|e| format!("Failed to replace destination: {}", e))?;
    }
    std::fs::rename(&temp_path, &destination_path)
        .map_err(|e| format!("Failed to finalize download: {}", e))?;

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
    clear_cancelled(transfer_id);

    if checkpoint_enabled {
        if let Some(id) = checkpoint_id.as_deref() {
            let _ = remove_transfer_checkpoint(&app, id);
        }
    }

    Ok(total_bytes)
}

#[tauri::command]
pub(crate) async fn create_folder(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    validate_key(&key, "Object key")?;
    if key.contains("//") {
        return Err("Object key must not contain consecutive slashes".to_string());
    }

    let folder_key = if key.ends_with('/') {
        key
    } else {
        format!("{}/", key)
    };

    client
        .put_object()
        .bucket(&bucket)
        .key(&folder_key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(())
}

async fn copy_object_multipart(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    source_key: &str,
    dest_key: &str,
    total_size: i64,
) -> Result<(), String> {
    let create_output = client
        .create_multipart_upload()
        .bucket(dst_bucket)
        .key(dest_key)
        .send()
        .await
        .map_err(|e| format!("Failed to create multipart copy: {}", e))?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned for multipart copy")?
        .to_string();

    let copy_source = encode_copy_source(src_bucket, source_key);
    let mut completed_parts = Vec::new();
    let mut part_number = 1i32;
    let mut offset = 0u64;
    let size = total_size as u64;

    while offset < size {
        let end = std::cmp::min(offset + MULTIPART_COPY_PART_SIZE, size) - 1;
        let range = format!("bytes={}-{}", offset, end);

        let part_result = client
            .upload_part_copy()
            .bucket(dst_bucket)
            .key(dest_key)
            .upload_id(&upload_id)
            .copy_source(&copy_source)
            .copy_source_range(&range)
            .part_number(part_number)
            .send()
            .await;

        match part_result {
            Ok(output) => {
                let etag = output
                    .copy_part_result()
                    .and_then(|r| r.e_tag())
                    .unwrap_or_default()
                    .to_string();
                completed_parts.push(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .part_number(part_number)
                        .e_tag(etag)
                        .build(),
                );
                offset = end + 1;
                part_number += 1;
            }
            Err(e) => {
                let _ = client
                    .abort_multipart_upload()
                    .bucket(dst_bucket)
                    .key(dest_key)
                    .upload_id(&upload_id)
                    .send()
                    .await;
                return Err(format!("Failed to copy part {}: {}", part_number, e));
            }
        }
    }

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();

    if let Err(e) = client
        .complete_multipart_upload()
        .bucket(dst_bucket)
        .key(dest_key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload)
        .send()
        .await
    {
        let _ = client
            .abort_multipart_upload()
            .bucket(dst_bucket)
            .key(dest_key)
            .upload_id(&upload_id)
            .send()
            .await;
        return Err(format!("Failed to complete multipart copy: {}", e));
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn rename_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    old_key: String,
    new_key: String,
) -> Result<(), String> {
    validate_key(&old_key, "Source key")?;
    validate_key(&new_key, "Destination key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let head = client
        .head_object()
        .bucket(&bucket)
        .key(&old_key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let size = head.content_length().unwrap_or(0);

    if size >= MULTIPART_COPY_THRESHOLD {
        copy_object_multipart(&client, &bucket, &bucket, &old_key, &new_key, size).await?;
    } else {
        let source = encode_copy_source(&bucket, &old_key);
        client
            .copy_object()
            .bucket(&bucket)
            .key(&new_key)
            .copy_source(&source)
            .send()
            .await
            .map_err(|e| format!("Failed to copy: {}", e))?;
    }

    if let Err(e) = client
        .delete_object()
        .bucket(&bucket)
        .key(&old_key)
        .send()
        .await
    {
        return Err(format!(
            "Rename partially completed: '{}' was copied to '{}' but the original could not be deleted: {}. You may need to remove the original manually.",
            old_key, new_key, e
        ));
    }

    Ok(())
}

/// List every key under a prefix (no delimiter, fully recursive, paginated).
async fn list_all_keys_under_prefix(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);
        if let Some(ref token) = continuation_token {
            req = req.continuation_token(token);
        }
        let output = req
            .send()
            .await
            .map_err(|e| format!("Failed to list objects: {}", e))?;

        for obj in output.contents() {
            if let Some(k) = obj.key() {
                keys.push(k.to_string());
            }
        }

        if output.is_truncated().unwrap_or(false) {
            continuation_token = output.next_continuation_token().map(|s| s.to_string());
        } else {
            break;
        }
    }

    Ok(keys)
}

#[tauri::command]
pub(crate) async fn delete_prefix(
    state: tauri::State<'_, AppState>,
    bucket: String,
    prefix: String,
) -> Result<u32, String> {
    validate_prefix(&prefix, "Prefix")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let mut deleted = 0u32;
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.list_objects_v2().bucket(&bucket).prefix(&prefix);
        if let Some(ref token) = continuation_token {
            req = req.continuation_token(token);
        }
        let output = req
            .send()
            .await
            .map_err(|e| format!("Failed to list objects: {}", e))?;

        let keys: Vec<String> = output
            .contents()
            .iter()
            .filter_map(|obj| obj.key().map(|k| k.to_string()))
            .collect();

        if keys.is_empty() && deleted == 0 {
            return Ok(0);
        }

        for chunk in keys.chunks(1000) {
            let objects: Vec<ObjectIdentifier> = chunk
                .iter()
                .map(|k| {
                    ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .map_err(|e| format!("Invalid key: {}", e))
                })
                .collect::<Result<_, _>>()?;

            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .map_err(|e| format!("Delete build error: {}", e))?;

            let del_output = client
                .delete_objects()
                .bucket(&bucket)
                .delete(delete)
                .send()
                .await
                .map_err(|e| format!("Batch delete failed: {}", e))?;

            let errors = del_output.errors();
            if !errors.is_empty() {
                let sample: Vec<String> = errors
                    .iter()
                    .take(3)
                    .map(|err| {
                        format!(
                            "{}: {}",
                            err.key().unwrap_or("?"),
                            err.message().unwrap_or("unknown error")
                        )
                    })
                    .collect();
                return Err(format!(
                    "Failed to delete {} object(s) under prefix. {}",
                    errors.len(),
                    sample.join("; ")
                ));
            }

            deleted += chunk.len() as u32;
        }

        if output.is_truncated().unwrap_or(false) {
            continuation_token = output.next_continuation_token().map(|s| s.to_string());
        } else {
            break;
        }
    }

    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn rename_prefix(
    state: tauri::State<'_, AppState>,
    bucket: String,
    old_prefix: String,
    new_prefix: String,
) -> Result<u32, String> {
    validate_prefix(&old_prefix, "Source prefix")?;
    validate_prefix(&new_prefix, "Destination prefix")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let keys = list_all_keys_under_prefix(&client, &bucket, &old_prefix).await?;
    if keys.is_empty() {
        // Nothing under prefix — just means it was an empty folder marker; nothing to move
        return Ok(0);
    }

    // Copy all objects to new prefix, tracking what was copied for rollback
    let mut copied_keys = Vec::new();
    for key in &keys {
        let suffix = key.strip_prefix(old_prefix.as_str()).ok_or_else(|| {
            format!("Key '{}' does not start with prefix '{}'", key, old_prefix)
        })?;
        let new_key = format!("{}{}", new_prefix, suffix);
        let source = encode_copy_source(&bucket, key);
        if let Err(e) = client
            .copy_object()
            .bucket(&bucket)
            .key(&new_key)
            .copy_source(&source)
            .send()
            .await
        {
            // Roll back: delete any objects already copied to new prefix
            for rollback_chunk in copied_keys.chunks(1000) {
                let objects: Vec<ObjectIdentifier> = rollback_chunk
                    .iter()
                    .filter_map(|k: &String| ObjectIdentifier::builder().key(k).build().ok())
                    .collect();
                if let Ok(del) = Delete::builder().set_objects(Some(objects)).quiet(true).build() {
                    let _ = client.delete_objects().bucket(&bucket).delete(del).send().await;
                }
            }
            return Err(format!("Failed to copy '{}': {}", key, e));
        }
        copied_keys.push(new_key);
    }

    // Delete originals in batches
    let mut moved = 0u32;
    for chunk in keys.chunks(1000) {
        let objects: Vec<ObjectIdentifier> = chunk
            .iter()
            .map(|k| {
                ObjectIdentifier::builder()
                    .key(k)
                    .build()
                    .map_err(|e| format!("Invalid key: {}", e))
            })
            .collect::<Result<_, _>>()?;

        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(|e| format!("Delete build error: {}", e))?;

        client
            .delete_objects()
            .bucket(&bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|e| format!("Failed to delete originals: {}", e))?;

        moved += chunk.len() as u32;
    }

    Ok(moved)
}

/// Copy a single object to a (possibly different) bucket/key without deleting the source.
#[tauri::command]
pub(crate) async fn copy_object_to(
    state: tauri::State<'_, AppState>,
    src_bucket: String,
    src_key: String,
    dst_bucket: String,
    dst_key: String,
) -> Result<(), String> {
    validate_key(&src_key, "Source key")?;
    validate_key(&dst_key, "Destination key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let head = client
        .head_object()
        .bucket(&src_bucket)
        .key(&src_key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let size = head.content_length().unwrap_or(0);

    if size >= MULTIPART_COPY_THRESHOLD {
        copy_object_multipart(&client, &src_bucket, &dst_bucket, &src_key, &dst_key, size).await?;
    } else {
        let source = encode_copy_source(&src_bucket, &src_key);
        client
            .copy_object()
            .bucket(&dst_bucket)
            .key(&dst_key)
            .copy_source(&source)
            .send()
            .await
            .map_err(|e| format!("Failed to copy: {}", e))?;
    }

    Ok(())
}

/// Copy all objects under a prefix to a new prefix (possibly in a different bucket)
/// without deleting the originals.
#[tauri::command]
pub(crate) async fn copy_prefix_to(
    state: tauri::State<'_, AppState>,
    src_bucket: String,
    src_prefix: String,
    dst_bucket: String,
    dst_prefix: String,
) -> Result<u32, String> {
    validate_prefix(&src_prefix, "Source prefix")?;
    validate_prefix(&dst_prefix, "Destination prefix")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let keys = list_all_keys_under_prefix(&client, &src_bucket, &src_prefix).await?;
    if keys.is_empty() {
        return Ok(0);
    }

    let mut copied_keys = Vec::new();
    for key in &keys {
        let suffix = key.strip_prefix(src_prefix.as_str()).ok_or_else(|| {
            format!("Key '{}' does not start with prefix '{}'", key, src_prefix)
        })?;
        let new_key = format!("{}{}", dst_prefix, suffix);
        let source = encode_copy_source(&src_bucket, key);
        if let Err(e) = client
            .copy_object()
            .bucket(&dst_bucket)
            .key(&new_key)
            .copy_source(&source)
            .send()
            .await
        {
            for rollback_chunk in copied_keys.chunks(1000) {
                let objects: Vec<ObjectIdentifier> = rollback_chunk
                    .iter()
                    .filter_map(|k: &String| ObjectIdentifier::builder().key(k).build().ok())
                    .collect();
                if let Ok(del) = Delete::builder().set_objects(Some(objects)).quiet(true).build() {
                    let _ = client.delete_objects().bucket(&dst_bucket).delete(del).send().await;
                }
            }
            return Err(format!("Failed to copy '{}': {}", key, e));
        }
        copied_keys.push(new_key);
    }

    Ok(keys.len() as u32)
}

#[tauri::command]
pub(crate) fn build_object_url(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<String, String> {
    let s3 = lock_s3_state(&state)?;
    if s3.endpoint.is_empty() {
        return Err("Not connected".to_string());
    }
    let base = s3.endpoint.trim_end_matches('/');
    let encoded_bucket = urlencoding::encode(&bucket);
    let encoded_key = key
        .split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{}/{}/{}", base, encoded_bucket, encoded_key))
}

#[tauri::command]
pub(crate) async fn generate_presigned_url(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    expires_in_secs: u64,
) -> Result<String, String> {
    validate_key(&key, "Object key")?;
    if expires_in_secs < 60 || expires_in_secs > 604800 {
        return Err("Expiration must be between 60 and 604800 seconds".to_string());
    }
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let presigning_config =
        aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(expires_in_secs))
            .map_err(|e| format!("Invalid expiration: {}", e))?;

    let presigned = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .presigned(presigning_config)
        .await
        .map_err(|e| format!("Failed to generate presigned URL: {}", e))?;

    Ok(presigned.uri().to_string())
}

#[tauri::command]
pub(crate) async fn preview_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<PreviewResponse, String> {
    validate_key(&key, "Object key")?;
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let head = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let total_size = head.content_length().unwrap_or(0);
    let content_type = head
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();

    const MAX_PREVIEW: i64 = 1_048_576;
    let truncated = total_size > MAX_PREVIEW;

    let mut req = client.get_object().bucket(&bucket).key(&key);
    if truncated {
        req = req.range(format!("bytes=0-{}", MAX_PREVIEW - 1));
    }

    let output = req
        .send()
        .await
        .map_err(|e| format!("Failed to download preview: {}", e))?;

    let raw_bytes = output
        .body
        .collect()
        .await
        .map_err(|e| format!("Failed to read preview body: {}", e))?
        .into_bytes();

    let bytes = if raw_bytes.len() > MAX_PREVIEW as usize {
        raw_bytes.slice(..MAX_PREVIEW as usize)
    } else {
        raw_bytes
    };

    let is_text = is_text_content_type(&content_type);

    let data = if is_text {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        B64.encode(&bytes)
    };

    Ok(PreviewResponse {
        content_type,
        data,
        is_text,
        truncated,
        total_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_text_content_type_recognizes_text() {
        assert!(is_text_content_type("text/plain"));
        assert!(is_text_content_type("text/html"));
        assert!(is_text_content_type("text/css"));
    }

    #[test]
    fn is_text_content_type_recognizes_json() {
        assert!(is_text_content_type("application/json"));
    }

    #[test]
    fn is_text_content_type_recognizes_xml() {
        assert!(is_text_content_type("application/xml"));
    }

    #[test]
    fn is_text_content_type_recognizes_svg() {
        assert!(is_text_content_type("image/svg+xml"));
    }

    #[test]
    fn is_text_content_type_rejects_binary() {
        assert!(!is_text_content_type("application/octet-stream"));
        assert!(!is_text_content_type("image/png"));
        assert!(!is_text_content_type("video/mp4"));
    }

    #[test]
    fn encode_copy_source_simple() {
        let result = encode_copy_source("my-bucket", "path/to/file.txt");
        assert_eq!(result, "my-bucket/path/to/file.txt");
    }

    #[test]
    fn encode_copy_source_encodes_special_chars() {
        let result = encode_copy_source("my-bucket", "path/to/file name.txt");
        assert!(result.contains("file%20name.txt"));
    }

    #[test]
    fn encode_copy_source_encodes_bucket_special_chars() {
        let result = encode_copy_source("my bucket", "key");
        assert!(result.starts_with("my%20bucket/"));
    }

    #[test]
    fn normalize_endpoint_adds_https_scheme() {
        let (url, bucket) = normalize_endpoint("sfo3.digitaloceanspaces.com");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, None);
    }

    #[test]
    fn normalize_endpoint_preserves_existing_scheme() {
        let (url, _) = normalize_endpoint("https://sfo3.digitaloceanspaces.com");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        let (url, _) = normalize_endpoint("http://localhost:9000");
        assert_eq!(url, "http://localhost:9000");
    }

    #[test]
    fn normalize_endpoint_strips_do_bucket_subdomain() {
        let (url, bucket) = normalize_endpoint("https://fortis.sfo3.digitaloceanspaces.com");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));

        let (url, bucket) = normalize_endpoint("fortis.sfo3.digitaloceanspaces.com");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));
    }

    #[test]
    fn normalize_endpoint_keeps_region_only_do_host() {
        let (url, bucket) = normalize_endpoint("https://nyc3.digitaloceanspaces.com");
        assert_eq!(url, "https://nyc3.digitaloceanspaces.com");
        assert_eq!(bucket, None);
    }

    #[test]
    fn normalize_endpoint_strips_trailing_path_as_bucket() {
        let (url, bucket) = normalize_endpoint("https://sfo3.digitaloceanspaces.com/fortis");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));
    }

    #[test]
    fn normalize_endpoint_preserves_port() {
        let (url, _) = normalize_endpoint("http://minio.local:9000");
        assert_eq!(url, "http://minio.local:9000");
    }

    #[test]
    fn normalize_endpoint_strips_trailing_slash() {
        let (url, _) = normalize_endpoint("https://s3.amazonaws.com/");
        assert_eq!(url, "https://s3.amazonaws.com");
    }
}
