use aws_sdk_s3::types::{Delete, MetadataDirective, ObjectIdentifier};
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

use crate::{lock_s3_state, make_temp_path, validate_destination_path, validate_existing_path, AppState};

const MAX_UPLOAD_OBJECT_BYTES: usize = 16 * 1024 * 1024;
const MULTIPART_THRESHOLD: u64 = 50 * 1024 * 1024;
const PART_SIZE: usize = 10 * 1024 * 1024;
const MULTIPART_COPY_PART_SIZE: u64 = 500 * 1024 * 1024;
const MULTIPART_COPY_THRESHOLD: i64 = 5_368_709_120;

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

#[tauri::command]
pub(crate) async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    access_key: String,
    secret_key: String,
) -> Result<String, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("Endpoint is required".to_string());
    }
    let resolved_region = resolve_region(&endpoint, &region)?;
    let (normalized, bucket_hint) = normalize_endpoint(&endpoint);

    let creds =
        aws_sdk_s3::config::Credentials::new(&access_key, &secret_key, None, None, "s3-sidekick");

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
pub(crate) async fn update_metadata(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    content_type: String,
    metadata: HashMap<String, String>,
) -> Result<(), String> {
    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let source = encode_copy_source(&bucket, &key);
    let mut req = client
        .copy_object()
        .bucket(&bucket)
        .key(&key)
        .copy_source(&source)
        .content_type(&content_type)
        .metadata_directive(MetadataDirective::Replace);

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
) -> Result<(), String> {
    let upload_path = validate_existing_path(&file_path, "Upload file")?;

    let client = {
        let s3 = lock_s3_state(&state)?;
        s3.client.clone().ok_or("Not connected")?
    };

    let file_size = tokio::fs::metadata(&upload_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: 0,
            total_bytes: file_size,
        },
    );

    if file_size >= MULTIPART_THRESHOLD {
        upload_multipart(
            &app,
            &client,
            &bucket,
            &key,
            &upload_path,
            &content_type,
            transfer_id,
            file_size,
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

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: file_size,
            total_bytes: file_size,
        },
    );
    clear_cancelled(transfer_id);

    Ok(())
}

async fn upload_multipart(
    app: &tauri::AppHandle,
    client: &Client,
    bucket: &str,
    key: &str,
    file_path: &Path,
    content_type: &str,
    transfer_id: u32,
    file_size: u64,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

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

    let mut completed_parts = Vec::new();
    let mut part_number = 1i32;
    let mut bytes_sent = 0u64;

    loop {
        if is_cancelled(transfer_id) {
            clear_cancelled(transfer_id);
            let _ = client
                .abort_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .send()
                .await;
            return Err("Transfer cancelled".to_string());
        }

        let mut buf = vec![0u8; PART_SIZE];
        let mut read = 0;
        while read < PART_SIZE {
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
            break;
        }
        buf.truncate(read);

        let body = aws_sdk_s3::primitives::ByteStream::from(buf);
        let part_output = client
            .upload_part()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(body)
            .send()
            .await;

        match part_output {
            Ok(output) => {
                let etag = output.e_tag().unwrap_or_default().to_string();
                completed_parts.push(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .part_number(part_number)
                        .e_tag(etag)
                        .build(),
                );
                bytes_sent += read as u64;
                let _ = app.emit(
                    "upload-progress",
                    UploadProgress {
                        transfer_id,
                        bytes_sent,
                        total_bytes: file_size,
                    },
                );
                part_number += 1;
            }
            Err(e) => {
                let _ = client
                    .abort_multipart_upload()
                    .bucket(bucket)
                    .key(key)
                    .upload_id(&upload_id)
                    .send()
                    .await;
                return Err(format!("Failed to upload part {}: {}", part_number, e));
            }
        }
    }

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
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
        let _ = client
            .abort_multipart_upload()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .send()
            .await;
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
) -> Result<(), String> {
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
    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: 0,
            total_bytes: total,
        },
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

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: total,
            total_bytes: total,
        },
    );

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_object_acl(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<AclResponse, String> {
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
pub(crate) async fn download_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let destination_path = validate_destination_path(&destination)?;
    let temp_path = make_temp_path(&destination_path, "download");

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
    let _ = app.emit(
        "download-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: 0,
            total_bytes,
        },
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
            let _ = app.emit(
                "download-progress",
                UploadProgress {
                    transfer_id,
                    bytes_sent: written,
                    total_bytes,
                },
            );
            last_emitted = written;
        }
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

    if let Err(e) = std::fs::rename(&temp_path, &destination_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to finalize download: {}", e));
    }

    let _ = app.emit(
        "download-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: written,
            total_bytes: written,
        },
    );
    clear_cancelled(transfer_id);

    Ok(written)
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

    if key.as_bytes().iter().any(|&b| b == 0) {
        return Err("Object key contains invalid characters".to_string());
    }
    if key.len() > 1024 {
        return Err("Object key is too long (max 1024 characters)".to_string());
    }
    if key.split('/').any(|seg| seg == "..") {
        return Err("Object key must not contain '..' path segments".to_string());
    }
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
    bucket: &str,
    source_key: &str,
    dest_key: &str,
    total_size: i64,
) -> Result<(), String> {
    let create_output = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(dest_key)
        .send()
        .await
        .map_err(|e| format!("Failed to create multipart copy: {}", e))?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned for multipart copy")?
        .to_string();

    let copy_source = encode_copy_source(bucket, source_key);
    let mut completed_parts = Vec::new();
    let mut part_number = 1i32;
    let mut offset = 0u64;
    let size = total_size as u64;

    while offset < size {
        let end = std::cmp::min(offset + MULTIPART_COPY_PART_SIZE, size) - 1;
        let range = format!("bytes={}-{}", offset, end);

        let part_result = client
            .upload_part_copy()
            .bucket(bucket)
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
                    .bucket(bucket)
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
        .bucket(bucket)
        .key(dest_key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload)
        .send()
        .await
    {
        let _ = client
            .abort_multipart_upload()
            .bucket(bucket)
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
        copy_object_multipart(&client, &bucket, &old_key, &new_key, size).await?;
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
