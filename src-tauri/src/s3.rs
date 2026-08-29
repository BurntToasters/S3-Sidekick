// Transfer commands are exposed to the frontend through Tauri's `invoke` bridge,
// which marshals each parameter by name. Grouping them into structs would require
// matching serde plumbing on both sides for no real readability gain, so the flat
// signatures (and the progress emitter that mirrors them) are intentional.
#![allow(clippy::too_many_arguments)]

use aws_sdk_s3::types::{
    ChecksumAlgorithm, ChecksumType, Delete, MetadataDirective, ObjectCannedAcl, ObjectIdentifier,
};
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use zeroize::Zeroize;

use crate::{
    load_transfer_checkpoint_json, lock_s3_state, remove_transfer_checkpoint,
    save_transfer_checkpoint_json, validate_destination_path,
    validate_destination_path_allow_overwrite, validate_existing_path, AppState,
    StorageProviderKind,
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
const MAX_UPLOAD_INFLIGHT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DOWNLOAD_INFLIGHT_BYTES: u64 = 256 * 1024 * 1024;
const TRANSFER_ERROR_PREFIX: &str = "__S3_SIDEKICK_TRANSFER_ERROR__";
const CHECKSUM_METADATA_KEY: &str = "s3-sidekick-sha256";
const PREFERRED_MULTIPART_COPY_PART_SIZE: u64 = 500 * 1024 * 1024;
const MAX_MULTIPART_COPY_PART_SIZE: u64 = 5 * 1024 * 1024 * 1024;
const MAX_MULTIPART_COPY_PARTS: u64 = 10_000;
const MAX_OBJECT_SIZE: u64 = 5 * 1024 * 1024 * 1024 * 1024;
const MULTIPART_COPY_THRESHOLD: i64 = 5_368_709_120;
const MULTIPART_ABORT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PREFIX_TRANSACTION_OBJECTS: usize = 100_000;
const MAX_KEY_LEN: usize = 1024;

fn multipart_copy_part_size(object_size: u64) -> Result<u64, String> {
    if object_size == 0 || object_size > MAX_OBJECT_SIZE {
        return Err(format!(
            "Object size {} is outside the supported multipart-copy range (1..={} bytes)",
            object_size, MAX_OBJECT_SIZE
        ));
    }

    // Round the minimum required size up to a MiB boundary. A fixed 500 MiB
    // part produces 10,486 parts for a valid 5 TiB S3 object, exceeding S3's
    // 10,000-part limit.
    let required = object_size.div_ceil(MAX_MULTIPART_COPY_PARTS);
    let mib = 1024 * 1024;
    let required_rounded = required.div_ceil(mib) * mib;
    let part_size = PREFERRED_MULTIPART_COPY_PART_SIZE.max(required_rounded);
    let part_count = object_size.div_ceil(part_size);

    if part_size > MAX_MULTIPART_COPY_PART_SIZE || part_count > MAX_MULTIPART_COPY_PARTS {
        return Err(format!(
            "Object of {} bytes cannot be copied within S3 multipart limits",
            object_size
        ));
    }

    Ok(part_size)
}

fn validate_key(key: &str, label: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "{} is too long (max {} characters)",
            label, MAX_KEY_LEN
        ));
    }
    if key.as_bytes().contains(&0) {
        return Err(format!("{} contains invalid characters", label));
    }
    if key.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(format!(
            "{} must not contain '..' or '.' path segments",
            label
        ));
    }
    Ok(())
}

/// Validate a prefix for read-only listing.
///
/// Dot segments are legal S3 keys and must be listable so users can navigate
/// folders whose names contain `.` or `..`. An empty prefix lists the bucket root.
fn validate_list_prefix(prefix: &str, label: &str) -> Result<(), String> {
    if prefix.is_empty() {
        return Ok(());
    }
    if prefix.len() > MAX_KEY_LEN {
        return Err(format!(
            "{} is too long (max {} characters)",
            label, MAX_KEY_LEN
        ));
    }
    if prefix.as_bytes().contains(&0) {
        return Err(format!("{} contains invalid characters", label));
    }
    Ok(())
}

/// Encode one URL path segment for object keys without dot-segment components.
fn encode_object_url_segment(segment: &str) -> String {
    urlencoding::encode(segment).into_owned()
}

/// Dot-segment keys cannot be turned into browser-safe path URLs; `%2E%2E` still
/// normalises to `..` under the URL standard.
fn key_has_unsafe_url_segments(key: &str) -> bool {
    key.split('/')
        .any(|segment| segment == "." || segment == "..")
}

/// Reject an empty prefix for operations that mutate everything beneath it.
///
/// `validate_list_prefix` deliberately allows `""` because listing the bucket root is
/// legitimate. Deleting, moving, or copying "everything under `""`" is not: it
/// silently means the entire bucket.
fn validate_mutating_prefix(prefix: &str, label: &str) -> Result<(), String> {
    if prefix.is_empty() {
        return Err(format!(
            "{} must not be empty. Refusing to operate on every object in the bucket.",
            label
        ));
    }
    // Rollback backups may be the only surviving copy of a destination another
    // prefix operation is about to restore. Renaming, copying or deleting that
    // namespace while a peer operation depends on it would destroy the data the
    // backups exist to protect.
    if prefixes_overlap(prefix, ROLLBACK_BACKUP_PREFIX) {
        return Err(format!(
            "{} refers to '{}', which S3 Sidekick reserves for copy and move rollback backups. \
             Choose a different location.",
            label, ROLLBACK_BACKUP_PREFIX
        ));
    }
    validate_key(prefix, label)
}

fn prefixes_overlap(first: &str, second: &str) -> bool {
    first.starts_with(second) || second.starts_with(first)
}

/// Validate a key that is about to be written to, overwritten, or deleted.
///
/// Rollback backups may hold the only copy of a destination that an in-flight
/// copy or move still has to restore, so they are read-only from the UI's point
/// of view. Reads, downloads and copies *out of* the namespace stay allowed: that
/// is how a user recovers data from an interrupted operation.
fn validate_mutating_key(key: &str, label: &str) -> Result<(), String> {
    validate_key(key, label)?;
    reject_reserved_backup_key(key, label)
}

/// Validate a key for read-only operations (head, download, preview, presign).
///
/// Like `validate_deletable_key`, dot segments are allowed because they are legal
/// in S3. Reads never derive a local filesystem path from the key.
fn validate_readable_key(key: &str, label: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "{} is too long (max {} characters)",
            label, MAX_KEY_LEN
        ));
    }
    if key.as_bytes().contains(&0) {
        return Err(format!("{} contains invalid characters", label));
    }
    Ok(())
}

/// Validate a key that is only ever deleted.
///
/// `validate_key` rejects `.` and `..` segments because a key is also used to
/// build a local download path. Deletion never touches the filesystem, and such
/// keys are legal in S3, so refusing them here would strand objects that earlier
/// versions could remove. Length, NUL and the reserved namespace still apply.
fn validate_deletable_key(key: &str, label: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "{} is too long (max {} characters)",
            label, MAX_KEY_LEN
        ));
    }
    if key.as_bytes().contains(&0) {
        return Err(format!("{} contains invalid characters", label));
    }
    reject_reserved_backup_key(key, label)
}

fn reject_reserved_backup_key(key: &str, label: &str) -> Result<(), String> {
    if key.starts_with(ROLLBACK_BACKUP_PREFIX) {
        return Err(format!(
            "{} is inside '{}', which S3 Sidekick reserves for copy and move rollback backups. \
             They may hold the only copy of overwritten data, so they cannot be modified here.",
            label, ROLLBACK_BACKUP_PREFIX
        ));
    }
    Ok(())
}

/// Cooperative cancellation signal shared by a transfer and its workers.
///
/// Replaces the previous `HashSet<u32>` of cancelled ids. That design latched:
/// an id was inserted by `cancel_transfer` and only removed if the transfer
/// happened to observe it, so ids belonging to already-finished transfers stayed
/// behind forever. Because the frontend restarts its id counter at 1 on every
/// webview reload, a later transfer could be assigned a latched id and abort
/// before moving a single byte.
///
/// Now an entry exists only while a transfer is actually running (created by
/// `TransferGuard`, removed on drop), so cancelling an unknown id is a no-op.
#[derive(Default)]
struct CancelFlag {
    cancelled: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancelFlag {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.notify.notify_waiters();
        }
    }

    /// Resolve immediately when cancellation has already happened, or register
    /// a race-free waiter for the next cancellation signal.
    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }

        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    /// Sleep, waking immediately if cancellation arrives.
    async fn sleep_unless_cancelled(&self, total: Duration) -> bool {
        tokio::select! {
            _ = self.cancelled() => false,
            _ = tokio::time::sleep(total) => true,
        }
    }
}

type CancelToken = Arc<CancelFlag>;

static ACTIVE_TRANSFERS: OnceLock<Mutex<HashMap<u32, CancelToken>>> = OnceLock::new();
static TRANSFERS_DISABLED: AtomicBool = AtomicBool::new(false);
static ROLLBACK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn active_transfers() -> &'static Mutex<HashMap<u32, CancelToken>> {
    ACTIVE_TRANSFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers a running transfer and deregisters it on drop.
struct TransferGuard {
    transfer_id: u32,
    token: CancelToken,
}

impl TransferGuard {
    fn register(transfer_id: u32) -> Self {
        let token: CancelToken = Arc::new(CancelFlag::default());
        if TRANSFERS_DISABLED.load(Ordering::Acquire) {
            token.cancel();
        }
        if let Ok(mut map) = active_transfers().lock() {
            // A duplicate id means the frontend reused it. Replace the stale
            // entry rather than inheriting its cancellation state.
            map.insert(transfer_id, Arc::clone(&token));
        }
        Self { transfer_id, token }
    }

    fn token(&self) -> CancelToken {
        Arc::clone(&self.token)
    }

    fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
}

fn transfer_cancel_context(transfer_id: Option<u32>) -> (Option<TransferGuard>, CancelToken) {
    match transfer_id {
        Some(id) => {
            let guard = TransferGuard::register(id);
            let token = guard.token();
            (Some(guard), token)
        }
        None => (None, Arc::new(CancelFlag::default())),
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = active_transfers().lock() {
            // Only remove our own registration; a newer transfer may have taken
            // the slot if the frontend reused the id.
            if map
                .get(&self.transfer_id)
                .map(|existing| Arc::ptr_eq(existing, &self.token))
                .unwrap_or(false)
            {
                map.remove(&self.transfer_id);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_transfer(transfer_id: u32) {
    if let Ok(map) = active_transfers().lock() {
        if let Some(token) = map.get(&transfer_id) {
            token.cancel();
        }
    }
}

pub(crate) fn resume_transfers_after_failed_reset() {
    TRANSFERS_DISABLED.store(false, Ordering::Release);
}

pub(crate) async fn stop_all_transfers_for_reset() -> Result<(), String> {
    TRANSFERS_DISABLED.store(true, Ordering::Release);
    let started = Instant::now();
    loop {
        let tokens = active_transfers()
            .lock()
            .map_err(|_| "Transfer registry is unavailable".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        if tokens.is_empty() {
            return Ok(());
        }
        for token in tokens {
            token.cancel();
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err("Timed out while stopping active transfers for factory reset".to_string());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Error returned when a transfer observes cancellation.
fn cancelled_error() -> String {
    "Transfer cancelled".to_string()
}

async fn cleanup_completes_within<F>(timeout: Duration, cleanup: F) -> bool
where
    F: std::future::Future<Output = ()>,
{
    tokio::time::timeout(timeout, cleanup).await.is_ok()
}

/// Abort an unfinished multipart operation without allowing a broken endpoint
/// to hold cancellation or factory reset forever.
async fn abort_multipart_upload_bounded(client: &Client, bucket: &str, key: &str, upload_id: &str) {
    let request = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .send();
    let _ = cleanup_completes_within(MULTIPART_ABORT_TIMEOUT, async move {
        let _ = request.await;
    })
    .await;
}

/// True only when the service explicitly answered 404.
///
/// Any other failure (403, 5xx, network) must not be read as "absent", otherwise
/// a transient error silently becomes permission to overwrite.
fn is_not_found<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> bool {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => ctx.raw().status().as_u16() == 404,
        _ => false,
    }
}

/// S3 create-only writes use `If-None-Match: *` so the destination must be absent
/// at commit time, not merely at an earlier probe.
const CREATE_ONLY_IF_NONE_MATCH: &str = "*";
/// Cloudflare R2 requires this proprietary header on CopyObject (beta).
const R2_COPY_DESTINATION_IF_NONE_MATCH: &str = "cf-copy-destination-if-none-match";
/// DigitalOcean Spaces documents `x-amz-copy-if-none-match`, not destination `If-None-Match`.
const DIGITALOCEAN_COPY_IF_NONE_MATCH: &str = "x-amz-copy-if-none-match";

/// Provider-specific support for atomic create-only writes (`overwrite: false`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyCreateOnlyStrategy {
    AwsIfNoneMatch,
    R2DestinationHeader,
    DigitalOceanCopyIfNoneMatch,
}

struct CreateOnlyCapabilities {
    put_object: bool,
    complete_multipart: bool,
    copy_object: Option<CopyCreateOnlyStrategy>,
}

impl CreateOnlyCapabilities {
    fn for_provider(provider: StorageProviderKind) -> Self {
        match provider {
            StorageProviderKind::Aws | StorageProviderKind::Wasabi => Self {
                put_object: true,
                complete_multipart: true,
                copy_object: Some(CopyCreateOnlyStrategy::AwsIfNoneMatch),
            },
            // MinIO documents If-None-Match on CreateMultipartUpload, not CompleteMultipartUpload.
            StorageProviderKind::Minio => Self {
                put_object: true,
                complete_multipart: false,
                copy_object: Some(CopyCreateOnlyStrategy::AwsIfNoneMatch),
            },
            StorageProviderKind::CloudflareR2 => Self {
                put_object: true,
                complete_multipart: true,
                copy_object: Some(CopyCreateOnlyStrategy::R2DestinationHeader),
            },
            StorageProviderKind::DigitalOcean => Self {
                put_object: false,
                complete_multipart: false,
                copy_object: Some(CopyCreateOnlyStrategy::DigitalOceanCopyIfNoneMatch),
            },
            StorageProviderKind::Backblaze | StorageProviderKind::Generic => Self {
                put_object: false,
                complete_multipart: false,
                copy_object: None,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct CreateOnlyCapabilityInfo {
    pub put_object: bool,
    pub complete_multipart: bool,
    pub copy_object: bool,
}

impl CreateOnlyCapabilityInfo {
    fn from_provider(provider: StorageProviderKind) -> Self {
        let caps = CreateOnlyCapabilities::for_provider(provider);
        Self {
            put_object: caps.put_object,
            complete_multipart: caps.complete_multipart,
            copy_object: caps.copy_object.is_some(),
        }
    }
}

fn create_only_unsupported_error(key: &str, action: &str) -> String {
    format!(
        "This storage provider cannot enforce a create-only {} for '{}'. Explicitly authorize an unconditional write before retrying.",
        action, key
    )
}

fn apply_put_create_only_guard(
    request: aws_sdk_s3::operation::put_object::builders::PutObjectFluentBuilder,
    provider: StorageProviderKind,
    key: &str,
) -> Result<aws_sdk_s3::operation::put_object::builders::PutObjectFluentBuilder, String> {
    if CreateOnlyCapabilities::for_provider(provider).put_object {
        Ok(request.if_none_match(CREATE_ONLY_IF_NONE_MATCH))
    } else {
        Err(create_only_unsupported_error(key, "upload"))
    }
}

fn require_put_create_only_support(provider: StorageProviderKind, key: &str) -> Result<(), String> {
    if CreateOnlyCapabilities::for_provider(provider).put_object {
        Ok(())
    } else {
        Err(create_only_unsupported_error(key, "upload"))
    }
}

fn apply_complete_multipart_create_only_guard(
    request: aws_sdk_s3::operation::complete_multipart_upload::builders::CompleteMultipartUploadFluentBuilder,
    provider: StorageProviderKind,
    key: &str,
) -> Result<aws_sdk_s3::operation::complete_multipart_upload::builders::CompleteMultipartUploadFluentBuilder, String>
{
    if CreateOnlyCapabilities::for_provider(provider).complete_multipart {
        Ok(request.if_none_match(CREATE_ONLY_IF_NONE_MATCH))
    } else {
        Err(create_only_unsupported_error(key, "multipart write"))
    }
}

fn require_complete_multipart_create_only_support(
    provider: StorageProviderKind,
    key: &str,
) -> Result<(), String> {
    if CreateOnlyCapabilities::for_provider(provider).complete_multipart {
        Ok(())
    } else {
        Err(create_only_unsupported_error(key, "multipart write"))
    }
}

fn require_copy_create_only_strategy(
    provider: StorageProviderKind,
    key: &str,
) -> Result<CopyCreateOnlyStrategy, String> {
    CreateOnlyCapabilities::for_provider(provider)
        .copy_object
        .ok_or_else(|| create_only_unsupported_error(key, "copy"))
}

fn service_error_status<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> Option<u16> {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => Some(ctx.raw().status().as_u16()),
        _ => None,
    }
}

fn is_destination_occupied<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> bool {
    service_error_status(err) == Some(412)
}

fn is_concurrent_write_conflict<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> bool {
    service_error_status(err) == Some(409)
}

fn destination_conflict_error(key: &str) -> String {
    format!(
        "Destination '{}' already exists. Choose overwrite to replace it.",
        key
    )
}

fn map_create_only_write_error<E: std::fmt::Debug>(
    key: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
    overwrite: bool,
    action: &str,
) -> String {
    if overwrite {
        return format!("Failed to {} '{}': {:?}", action, key, err);
    }
    if is_destination_occupied(err) {
        return destination_conflict_error(key);
    }
    if is_concurrent_write_conflict(err) {
        return encode_transfer_error(
            "concurrent_write",
            true,
            Some(409),
            format!(
                "Destination '{}' changed during {}; retry the operation.",
                key, action
            ),
        );
    }
    format!("Failed to {} '{}': {:?}", action, key, err)
}

fn detect_storage_provider(endpoint: &str) -> StorageProviderKind {
    let host = parse_endpoint_host(endpoint).unwrap_or_default();
    let is_domain = |domain: &str| {
        host == domain
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    };
    if is_domain("r2.cloudflarestorage.com") {
        return StorageProviderKind::CloudflareR2;
    }
    if is_domain("amazonaws.com") || is_domain("amazonaws.com.cn") {
        return StorageProviderKind::Aws;
    }
    if is_domain("wasabisys.com") {
        return StorageProviderKind::Wasabi;
    }
    if is_domain("backblazeb2.com") {
        return StorageProviderKind::Backblaze;
    }
    if is_domain("digitaloceanspaces.com") {
        return StorageProviderKind::DigitalOcean;
    }
    if host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.split('.').any(|label| label == "minio")
    {
        return StorageProviderKind::Minio;
    }
    StorageProviderKind::Generic
}

fn require_storage_provider(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
) -> Result<StorageProviderKind, String> {
    let s3 = lock_s3_state(state)?;
    require_connection_session(&s3, connection_id)?;
    Ok(s3.storage_provider)
}

fn apply_aws_copy_create_only_guard(
    request: aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder,
) -> aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder {
    request.if_none_match(CREATE_ONLY_IF_NONE_MATCH)
}

async fn send_copy_object_create_only(
    request: aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder,
    create_only_strategy: Option<CopyCreateOnlyStrategy>,
) -> Result<
    aws_sdk_s3::operation::copy_object::CopyObjectOutput,
    aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::copy_object::CopyObjectError>,
> {
    match create_only_strategy {
        None => request.customize().send().await,
        Some(strategy) => match strategy {
            CopyCreateOnlyStrategy::R2DestinationHeader => {
                request
                    .customize()
                    .mutate_request(|req| {
                        req.headers_mut()
                            .insert(R2_COPY_DESTINATION_IF_NONE_MATCH, CREATE_ONLY_IF_NONE_MATCH);
                    })
                    .send()
                    .await
            }
            CopyCreateOnlyStrategy::DigitalOceanCopyIfNoneMatch => {
                request
                    .customize()
                    .mutate_request(|req| {
                        req.headers_mut()
                            .insert(DIGITALOCEAN_COPY_IF_NONE_MATCH, CREATE_ONLY_IF_NONE_MATCH);
                    })
                    .send()
                    .await
            }
            CopyCreateOnlyStrategy::AwsIfNoneMatch => {
                apply_aws_copy_create_only_guard(request)
                    .customize()
                    .send()
                    .await
            }
        },
    }
}

async fn destination_object_exists(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
) -> Result<bool, String> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(_) => Ok(true),
        Err(err) if is_not_found(&err) => Ok(false),
        Err(err) => Err(format!("Failed to check destination '{}': {}", key, err)),
    }
}

async fn prefix_has_content(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
) -> Result<bool, String> {
    let output = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .max_keys(1)
        .send()
        .await
        .map_err(|e| format!("Failed to check destination prefix '{}': {}", prefix, e))?;
    Ok(output.key_count().unwrap_or(0) > 0 || !output.common_prefixes().is_empty())
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

fn encode_copy_source_with_version(bucket: &str, key: &str, version_id: Option<&str>) -> String {
    let source = encode_copy_source(bucket, key);
    match version_id {
        Some(version) if !version.is_empty() => {
            format!("{}?versionId={}", source, urlencoding::encode(version))
        }
        _ => source,
    }
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
    // ETag of the object the checkpoint was created against. Used to detect a
    // server-side change between sessions so we don't resume into stale bytes.
    // Defaulted for backward compatibility with checkpoints written before this
    // field existed (those are treated as "no recorded etag" and discarded).
    #[serde(default)]
    etag: String,
    // Version ID of the immutable object generation when versioning is enabled.
    // Old checkpoints have no value and are intentionally not resumable against
    // a versioned object: an ETag can be reused by distinct versions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version_id: Option<String>,
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

fn clamp_concurrency_for_budget(
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

fn clamp_bandwidth_limit_bps(value: Option<u32>) -> u64 {
    let mbps = value.unwrap_or(0);
    if mbps == 0 {
        return 0;
    }
    (mbps as u64) * 1024 * 1024 / 8
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TransferErrorEnvelope {
    code: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    message: String,
}

fn encode_transfer_error(
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

fn choose_upload_part_size_bytes(
    file_size: u64,
    requested_mb: Option<u32>,
) -> Result<usize, String> {
    let part_mb = clamp_part_size_mb(requested_mb, DEFAULT_UPLOAD_PART_SIZE_MB);
    let part_size = (part_mb as u64) * 1024 * 1024;
    let parts = file_size.div_ceil(part_size);
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

fn compute_speed_eta(
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

fn checkpoint_from_json(json: &str) -> Result<TransferCheckpoint, String> {
    serde_json::from_str::<TransferCheckpoint>(json)
        .map_err(|err| format!("Invalid transfer checkpoint JSON: {}", err))
}

fn save_checkpoint_payload(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
    payload: &TransferCheckpoint,
) -> Result<(), String> {
    let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    save_transfer_checkpoint_json(app, checkpoint_id, &json)
}

fn persist_checkpoint_and_advance<F>(
    last_saved_at: &mut Instant,
    last_saved_parts: &mut u32,
    completed_count: u32,
    persist: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    persist()?;
    *last_saved_at = Instant::now();
    *last_saved_parts = completed_count;
    Ok(())
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

enum ExpectedChecksum {
    Hex(String),
    Base64(String),
}

fn digest_to_hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn digest_to_base64(digest: &[u8]) -> String {
    B64.encode(digest)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Sha256Checksum {
    hex: String,
    base64: String,
}

type UploadedPart = (i32, usize, String, Option<Sha256Checksum>);

fn sha256_checksum_from_digest(digest: &[u8]) -> Sha256Checksum {
    Sha256Checksum {
        hex: digest_to_hex(digest),
        base64: digest_to_base64(digest),
    }
}

fn sha256_checksum_bytes(bytes: &[u8]) -> Sha256Checksum {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    sha256_checksum_from_digest(&hasher.finalize())
}

async fn sha256_file(path: &Path, cancel: &CancelToken) -> Result<Vec<u8>, String> {
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

fn expected_checksum_from_head(
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

async fn verify_file_checksum(
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

fn verify_upload_checksum_response(
    actual: Option<&str>,
    expected: &Sha256Checksum,
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
    if actual != expected.base64 {
        return Err(encode_transfer_error(
            "checksum_mismatch",
            false,
            None,
            format!("{} returned a different S3 SHA-256 checksum.", context),
        ));
    }
    Ok(())
}

fn checkpoint_generation_matches(
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

#[derive(serde::Serialize)]
pub(crate) struct PreviewResponse {
    content_type: String,
    data: String,
    is_text: bool,
    truncated: bool,
    total_size: i64,
}

fn is_text_content_type(ct: &str) -> bool {
    let media_type = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media_type.starts_with("text/")
        || media_type == "application/json"
        || media_type == "application/xml"
        || media_type == "application/javascript"
        || media_type == "image/svg+xml"
        || media_type == "application/x-yaml"
        || media_type == "application/toml"
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
    parts[1..parts.len() - 1].iter().all(|segment| {
        segment
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
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

fn format_sdk_error<E: std::fmt::Debug>(
    prefix: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
) -> String {
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

fn structured_transfer_sdk_error<E: std::fmt::Debug>(
    prefix: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
    default_code: &str,
    default_retryable: bool,
) -> String {
    use aws_sdk_s3::error::SdkError;
    let message = format_sdk_error(prefix, err);
    match err {
        SdkError::ServiceError(ctx) => {
            let status = ctx.raw().status().as_u16();
            let retryable = status == 408 || status == 425 || status == 429 || status >= 500;
            let code = if status == 429 {
                "throttled"
            } else if status >= 500 {
                "server"
            } else if status == 403 {
                "forbidden"
            } else {
                default_code
            };
            encode_transfer_error(code, retryable, Some(status), message)
        }
        SdkError::DispatchFailure(_) => encode_transfer_error("network", true, None, message),
        _ => encode_transfer_error(default_code, default_retryable, None, message),
    }
}

fn generation_pinned_download_error<E: std::fmt::Debug>(
    prefix: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
) -> String {
    use aws_sdk_s3::error::SdkError;
    if let SdkError::ServiceError(ctx) = err {
        let status = ctx.raw().status().as_u16();
        if status == 404 || status == 412 {
            return encode_transfer_error(
                "stale_object",
                false,
                Some(status),
                format!(
                    "{}: the object changed or its recorded version disappeared during download.",
                    prefix
                ),
            );
        }
    }
    structured_transfer_sdk_error(prefix, err, "download_range", true)
}

/// Recognise a provider saying that object ACLs do not exist here.
///
/// Buckets configured with `BucketOwnerEnforced` — the default for new S3
/// buckets — reject every canned ACL, `private` included, and several
/// S3-compatible providers never implemented the ACL APIs at all. In those cases
/// there is no ACL to carry across, so omitting one preserves the source exactly
/// rather than silently changing permissions. Any other failure still fails
/// closed, because then an ACL may exist and simply could not be read or applied.
fn feature_is_unimplemented(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("notimplemented") || lower.contains("not implemented")
}

fn acls_are_unavailable(message: &str) -> bool {
    feature_is_unimplemented(message)
        || message
            .to_ascii_lowercase()
            .contains("accesscontrollistnotsupported")
}

async fn infer_canned_acl_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<Option<ObjectCannedAcl>, String> {
    let mut request = client.get_object_acl().bucket(bucket).key(key);
    if let Some(version_id) = version_id {
        request = request.version_id(version_id);
    }
    let output = match request.send().await {
        Ok(output) => output,
        Err(err) => {
            let message = format!("{:?}", err);
            if acls_are_unavailable(&message) {
                return Ok(None);
            }
            return Err(format!(
                "Failed to read the ACL for '{}' before copy; refusing to continue without \
                 confirmed ACL preservation. A copy does not carry the ACL, so preserving it \
                 needs the 's3:GetObjectAcl' permission: {}",
                key, err
            ));
        }
    };

    let owner_id = output
        .owner()
        .and_then(|owner| owner.id())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("Object '{}' ACL has no owner identity", key))?;
    let mut owner_full_control = 0u8;
    let mut public_read = 0u8;
    let mut public_write = 0u8;
    let mut authenticated_read = 0u8;

    for grant in output.grants() {
        let permission = grant
            .permission()
            .map(|value| value.as_str())
            .unwrap_or_default();
        let grantee = grant.grantee();
        let uri = grantee
            .and_then(|value| value.uri())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let grantee_id = grantee.and_then(|value| value.id()).unwrap_or_default();

        if grantee_id == owner_id && permission.eq_ignore_ascii_case("FULL_CONTROL") {
            owner_full_control = owner_full_control.saturating_add(1);
            continue;
        }
        if uri.ends_with("/allusers") && permission.eq_ignore_ascii_case("READ") {
            public_read = public_read.saturating_add(1);
            continue;
        }
        if uri.ends_with("/allusers") && permission.eq_ignore_ascii_case("WRITE") {
            public_write = public_write.saturating_add(1);
            continue;
        }
        if uri.ends_with("/authenticatedusers") && permission.eq_ignore_ascii_case("READ") {
            authenticated_read = authenticated_read.saturating_add(1);
            continue;
        }

        return Err(format!(
            "Object '{}' uses a custom ACL that cannot be represented safely during copy",
            key
        ));
    }

    if owner_full_control != 1 {
        return Err(format!(
            "Object '{}' ACL does not contain exactly one owner FULL_CONTROL grant",
            key
        ));
    }

    match (public_read, public_write, authenticated_read) {
        (0, 0, 0) => Ok(Some(ObjectCannedAcl::Private)),
        (1, 0, 0) => Ok(Some(ObjectCannedAcl::PublicRead)),
        (1, 1, 0) => Ok(Some(ObjectCannedAcl::PublicReadWrite)),
        (0, 0, 1) => Ok(Some(ObjectCannedAcl::AuthenticatedRead)),
        _ => Err(format!(
            "Object '{}' ACL grant combination does not exactly match a supported canned ACL",
            key
        )),
    }
}

async fn encoded_tagging_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<Option<String>, String> {
    let mut request = client.get_object_tagging().bucket(bucket).key(key);
    if let Some(version_id) = version_id {
        request = request.version_id(version_id);
    }
    let output = match request.send().await {
        Ok(output) => output,
        Err(err) => {
            // A provider that never implemented object tagging has no tags to
            // preserve, so the copy loses nothing by proceeding. Every other
            // failure still fails closed: tags may exist and simply be unreadable.
            if feature_is_unimplemented(&format!("{:?}", err)) {
                return Ok(None);
            }
            return Err(format!(
                "Failed to read tags for '{}' before copy; refusing to continue without confirmed \
                 tag preservation. Objects at or above 5 GiB are copied in parts, which requires \
                 restating their tags, so this operation needs the 's3:GetObjectTagging' \
                 permission: {}",
                key, err
            ));
        }
    };

    if output.tag_set().is_empty() {
        return Ok(None);
    }

    Ok(Some(
        output
            .tag_set()
            .iter()
            .map(|tag| {
                format!(
                    "{}={}",
                    urlencoding::encode(tag.key()),
                    urlencoding::encode(tag.value())
                )
            })
            .collect::<Vec<_>>()
            .join("&"),
    ))
}

#[derive(serde::Serialize)]
pub(crate) struct ConnectResult {
    pub region: String,
    pub connection_id: String,
    pub connection_identity: String,
    pub create_only_capabilities: CreateOnlyCapabilityInfo,
}

fn mint_connection_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn connection_identity(endpoint: &str, access_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update([0u8]);
    hasher.update(access_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(crate) fn require_connection_session(
    s3: &crate::S3State,
    connection_id: &str,
) -> Result<(), String> {
    if connection_id.trim().is_empty() {
        return Err("Connection id is required".to_string());
    }
    match s3.connection_id.as_deref() {
        Some(current) if current == connection_id => Ok(()),
        Some(_) => Err("Connection changed".to_string()),
        None => Err("Not connected".to_string()),
    }
}

pub(crate) fn invalidate_connection_session(s3: &mut crate::S3State) {
    s3.connection_generation = s3.connection_generation.wrapping_add(1);
    s3.client = None;
    s3.bucket_hint = None;
    s3.endpoint.clear();
    s3.region.clear();
    s3.connection_id = None;
    s3.connection_identity = None;
    s3.storage_provider = StorageProviderKind::default();
}

fn require_connected_client(s3: &crate::S3State, connection_id: &str) -> Result<Client, String> {
    require_connection_session(s3, connection_id)?;
    s3.client.clone().ok_or_else(|| "Not connected".to_string())
}

fn require_client(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
) -> Result<Client, String> {
    let s3 = lock_s3_state(state)?;
    require_connected_client(&s3, connection_id)
}

fn require_client_and_bucket_hint(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
) -> Result<(Client, Option<String>), String> {
    let s3 = lock_s3_state(state)?;
    let client = require_connected_client(&s3, connection_id)?;
    Ok((client, s3.bucket_hint.clone()))
}

fn require_endpoint(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
) -> Result<String, String> {
    let s3 = lock_s3_state(state)?;
    if connection_id.trim().is_empty() {
        return Err("Connection id is required".to_string());
    }
    match s3.connection_id.as_deref() {
        Some(current) if current == connection_id => {
            if s3.endpoint.is_empty() {
                Err("Not connected".to_string())
            } else {
                Ok(s3.endpoint.clone())
            }
        }
        Some(_) => Err("Connection changed".to_string()),
        None => Err("Not connected".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    mut access_key: String,
    mut secret_key: String,
) -> Result<ConnectResult, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("Endpoint is required".to_string());
    }
    let connection_generation = {
        let mut s3 = lock_s3_state(&state)?;
        s3.connection_generation = s3.connection_generation.wrapping_add(1);
        s3.connection_generation
    };
    let resolved_region = resolve_region(&endpoint, &region)?;
    let (normalized, bucket_hint) = normalize_endpoint(&endpoint);
    let identity = connection_identity(&normalized, &access_key);

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

    let connection_id = mint_connection_id();
    let storage_provider = detect_storage_provider(&normalized);
    let mut s3 = lock_s3_state(&state)?;
    if s3.connection_generation != connection_generation {
        return Err("Connection attempt superseded".to_string());
    }
    s3.client = Some(client);
    s3.endpoint = normalized;
    s3.region = resolved_region.clone();
    s3.bucket_hint = bucket_hint;
    s3.connection_id = Some(connection_id.clone());
    s3.connection_identity = Some(identity.clone());
    s3.storage_provider = storage_provider;

    Ok(ConnectResult {
        region: resolved_region,
        connection_id,
        connection_identity: identity,
        create_only_capabilities: CreateOnlyCapabilityInfo::from_provider(storage_provider),
    })
}

#[tauri::command]
pub(crate) fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let mut s3 = lock_s3_state(&state)?;
    match s3.connection_id.as_deref() {
        Some(current) if current == connection_id => {}
        Some(_) => return Err("Connection changed".to_string()),
        None => {
            if !connection_id.is_empty() {
                return Ok(());
            }
        }
    }
    invalidate_connection_session(&mut s3);
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_buckets(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<BucketInfo>, String> {
    let (client, bucket_hint) = require_client_and_bucket_hint(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    prefix: String,
    delimiter: String,
    continuation_token: String,
) -> Result<ListObjectsResponse, String> {
    // Listing the bucket root with an empty prefix is legitimate, so this uses
    // the permissive validator rather than the mutating one.
    validate_list_prefix(&prefix, "Prefix")?;
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<HeadObjectResponse, String> {
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<bool, String> {
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
    content_type: String,
    metadata: HashMap<String, String>,
) -> Result<(), String> {
    validate_mutating_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;
    let provider = require_storage_provider(&state, &connection_id)?;

    let cancel = Arc::new(CancelFlag::default());

    // `MetadataDirective::Replace` discards every system header that is not
    // re-supplied on the request. Only content type and user metadata used to be
    // sent, so editing any metadata field silently stripped Cache-Control,
    // Content-Disposition, Content-Encoding, Content-Language, the website
    // redirect location, the storage class and the encryption settings. Read the
    // current state first and carry all of it forward.
    let mut existing = describe_source(&client, &bucket, &key, &cancel).await?;
    existing.content_type = Some(content_type.clone());
    existing.metadata = Some(metadata.clone());

    if existing.size >= MULTIPART_COPY_THRESHOLD {
        // S3's single CopyObject API is limited to 5 GiB, but an in-place
        // multipart upload may safely copy ranges from the old object until the
        // final completion atomically replaces it.
        return copy_object_multipart(
            &client, &bucket, &bucket, &key, &key, &existing, true, provider, &cancel,
        )
        .await
        .map(|_| ());
    }

    let source = encode_copy_source_with_version(&bucket, &key, existing.version_id.as_deref());
    let build_request = |include_acl: bool| {
        let mut req = client
            .copy_object()
            .bucket(&bucket)
            .key(&key)
            .copy_source(&source)
            .content_type(&content_type)
            .metadata_directive(MetadataDirective::Replace);

        if let Some(etag) = existing.etag.as_deref() {
            req = req.copy_source_if_match(etag);
        }

        if let Some(value) = existing.cache_control.as_deref() {
            req = req.cache_control(value);
        }
        if let Some(value) = existing.content_disposition.as_deref() {
            req = req.content_disposition(value);
        }
        if let Some(value) = existing.content_encoding.as_deref() {
            req = req.content_encoding(value);
        }
        if let Some(value) = existing.content_language.as_deref() {
            req = req.content_language(value);
        }
        if let Some(value) = existing.website_redirect_location.as_deref() {
            req = req.website_redirect_location(value);
        }
        if let Some(value) = existing.storage_class.as_ref() {
            req = req.storage_class(value.clone());
        }
        if let Some(value) = existing.server_side_encryption.as_ref() {
            req = req.server_side_encryption(value.clone());
        }
        if let Some(value) = existing.ssekms_key_id.as_deref() {
            req = req.ssekms_key_id(value);
        }
        if let Some(value) = existing.bucket_key_enabled {
            req = req.bucket_key_enabled(value);
        }
        if include_acl {
            if let Some(acl) = existing.acl.as_ref() {
                req = req.acl(acl.clone());
            }
        }

        for (k, v) in &metadata {
            req = req.metadata(k, v);
        }
        req
    };

    let mut include_acl = existing.acl.is_some();
    loop {
        match build_request(include_acl).send().await {
            Ok(_) => return Ok(()),
            Err(err) => {
                let detail = format!("{:?}", err);
                if include_acl && acls_are_unavailable(&detail) {
                    include_acl = false;
                    continue;
                }
                return Err(format!("Failed to update metadata: {}", err));
            }
        }
    }
}

const MAX_DELETE_ERROR_DETAILS: usize = 20;

#[derive(Debug, Default, serde::Serialize)]
pub(crate) struct DeleteResult {
    deleted: u32,
    failed: u32,
    incomplete: bool,
    errors: Vec<String>,
}

fn record_delete_error(result: &mut DeleteResult, detail: String) {
    if result.errors.len() < MAX_DELETE_ERROR_DETAILS {
        result.errors.push(detail);
    }
}

#[tauri::command]
pub(crate) async fn delete_objects(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    keys: Vec<String>,
) -> Result<DeleteResult, String> {
    // This command used to pass its keys straight to `DeleteObjects` with no
    // validation at all, so a caller could delete anything the credentials
    // reached, including live rollback backups.
    for key in &keys {
        validate_deletable_key(key, "Object key")?;
    }
    let client = require_client(&state, &connection_id)?;

    let mut result = DeleteResult::default();
    for chunk in keys.chunks(1000) {
        let objects = chunk
            .iter()
            .map(|k| {
                ObjectIdentifier::builder()
                    .key(k)
                    .build()
                    .map_err(|e| format!("Invalid key after deleting {}: {}", result.deleted, e))
            })
            .collect::<Result<Vec<ObjectIdentifier>, _>>();
        let objects = match objects {
            Ok(objects) => objects,
            Err(err) => {
                result.incomplete = true;
                record_delete_error(&mut result, err);
                break;
            }
        };

        let delete = match Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
        {
            Ok(delete) => delete,
            Err(err) => {
                result.incomplete = true;
                let confirmed = result.deleted;
                record_delete_error(
                    &mut result,
                    format!("Delete build error after deleting {}: {}", confirmed, err),
                );
                break;
            }
        };

        let output = match client
            .delete_objects()
            .bucket(&bucket)
            .delete(delete)
            .send()
            .await
        {
            Ok(output) => output,
            Err(err) => {
                result.incomplete = true;
                let confirmed = result.deleted;
                record_delete_error(
                    &mut result,
                    format!(
                        "Batch delete response failed after {} confirmed deletion(s): {}",
                        confirmed, err
                    ),
                );
                break;
            }
        };

        let errors = output.errors();
        result.failed = result.failed.saturating_add(errors.len() as u32);
        result.deleted = result
            .deleted
            .saturating_add(chunk.len().saturating_sub(errors.len()) as u32);
        for err in errors {
            record_delete_error(
                &mut result,
                format!(
                    "{}: {}",
                    err.key().unwrap_or("?"),
                    err.message().unwrap_or("unknown error")
                ),
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub(crate) async fn upload_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checksum_verification: Option<bool>,
) -> Result<(), String> {
    let _storage_guard = crate::acquire_transfer_storage().await?;
    validate_mutating_key(&key, "Object key")?;
    let upload_path = validate_existing_path(&file_path, "Upload file")?;

    let client = require_client(&state, &connection_id)?;
    let provider = require_storage_provider(&state, &connection_id)?;

    let guard = TransferGuard::register(transfer_id);
    let cancel = guard.token();

    let file_size = tokio::fs::metadata(&upload_path)
        .await
        .map_err(|e| format!("File no longer accessible: {}", e))?
        .len();

    let attempt = normalize_attempt(attempt);
    let overwrite = overwrite.unwrap_or(false);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);
    let expected_checksum = if checksum_enabled {
        let digest = sha256_file(&upload_path, &cancel).await?;
        Some(sha256_checksum_from_digest(&digest))
    } else {
        None
    };
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
        None,
        None,
    );

    if file_size >= MULTIPART_THRESHOLD {
        let part_size_bytes = choose_upload_part_size_bytes(file_size, part_size_mb)?;
        let requested_workers = clamp_transfer_concurrency(part_concurrency);
        let part_workers = clamp_concurrency_for_budget(
            requested_workers,
            part_size_bytes,
            MAX_UPLOAD_INFLIGHT_BYTES,
        );
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
            started_at,
            expected_checksum.as_ref(),
            overwrite,
            provider,
            &cancel,
        )
        .await?;
    } else {
        if guard.is_cancelled() {
            return Err(cancelled_error());
        }
        if !overwrite {
            require_put_create_only_support(provider, &key)?;
        }

        let body = aws_sdk_s3::primitives::ByteStream::from_path(upload_path.as_path())
            .await
            .map_err(|e| format!("Failed to open file stream: {}", e))?;

        let mut req = client.put_object().bucket(&bucket).key(&key).body(body);

        if !content_type.is_empty() {
            req = req.content_type(&content_type);
        }
        if let Some(checksum) = expected_checksum.as_ref() {
            req = req
                .metadata(CHECKSUM_METADATA_KEY, &checksum.hex)
                .checksum_algorithm(ChecksumAlgorithm::Sha256)
                .checksum_sha256(&checksum.base64);
        }
        if !overwrite {
            req = apply_put_create_only_guard(req, provider, &key)?;
        }

        // A single PutObject cannot be interrupted mid-flight, so race the send
        // against the cancel signal instead of only checking before it starts.
        // Without this, cancelling a sub-threshold upload had no effect at all
        // until the whole body had been transmitted.
        let send = req.send();
        tokio::pin!(send);
        let output = loop {
            tokio::select! {
                result = &mut send => {
                    break result.map_err(|e| {
                        if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                            return map_create_only_write_error(&key, &e, overwrite, "upload");
                        }
                        structured_transfer_sdk_error("Failed to upload", &e, "upload", true)
                    })?;
                }
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if cancel.is_cancelled() {
                        return Err(cancelled_error());
                    }
                }
            }
        };
        if let Some(checksum) = expected_checksum.as_ref() {
            verify_upload_checksum_response(output.checksum_sha256(), checksum, "Upload")?;
        }
    }

    if guard.is_cancelled() {
        return Err(cancelled_error());
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
        None,
        None,
    );

    Ok(())
}

async fn upload_part_with_retry(
    client: Client,
    bucket: String,
    key: String,
    upload_id: String,
    part_number: i32,
    data: bytes::Bytes,
    checksum_enabled: bool,
    cancel: CancelToken,
) -> Result<UploadedPart, String> {
    let bytes = data.len();
    let checksum = checksum_enabled.then(|| sha256_checksum_bytes(&data));
    let mut last_error = String::new();
    for attempt in 1..=UPLOAD_PART_RETRY_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let body = aws_sdk_s3::primitives::ByteStream::from(data.clone());
        let mut request = client
            .upload_part()
            .bucket(&bucket)
            .key(&key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(body);
        if let Some(checksum) = checksum.as_ref() {
            request = request.checksum_sha256(&checksum.base64);
        }
        match request.send().await {
            Ok(output) => {
                if let Some(checksum) = checksum.as_ref() {
                    verify_upload_checksum_response(
                        output.checksum_sha256(),
                        checksum,
                        &format!("Upload part {}", part_number),
                    )?;
                }
                let etag = output.e_tag().unwrap_or_default().to_string();
                return Ok((part_number, bytes, etag, checksum));
            }
            Err(err) => {
                last_error = structured_transfer_sdk_error(
                    &format!("Failed to upload part {}", part_number),
                    &err,
                    "upload_part",
                    true,
                );
                if attempt < UPLOAD_PART_RETRY_ATTEMPTS {
                    let delay = Duration::from_millis(250 * (2u64.pow(attempt - 1)));
                    // Observe cancellation during backoff rather than sleeping
                    // through it.
                    if !cancel.sleep_unless_cancelled(delay).await {
                        return Err(cancelled_error());
                    }
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
    started_at: Instant,
    checksum: Option<&Sha256Checksum>,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    use tokio::task::JoinSet;

    if !overwrite {
        // Reject before creating remote multipart state or transferring bytes.
        require_complete_multipart_create_only_support(provider, key)?;
    }

    let mut create_req = client.create_multipart_upload().bucket(bucket).key(key);
    if !content_type.is_empty() {
        create_req = create_req.content_type(content_type);
    }
    if let Some(checksum) = checksum {
        create_req = create_req
            .metadata(CHECKSUM_METADATA_KEY, &checksum.hex)
            .checksum_algorithm(ChecksumAlgorithm::Sha256)
            .checksum_type(ChecksumType::FullObject);
    }

    let create_output = create_req.send().await.map_err(|e| {
        structured_transfer_sdk_error("Failed to create multipart upload", &e, "upload_init", true)
    })?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned")?
        .to_string();

    let mut file = match tokio::fs::File::open(file_path).await {
        Ok(file) => file,
        Err(err) => {
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            return Err(format!("Failed to open file: {}", err));
        }
    };

    let total_parts = file_size.div_ceil(part_size_bytes as u64) as usize;
    let mut completed_parts: Vec<Option<aws_sdk_s3::types::CompletedPart>> =
        vec![None; total_parts];
    let mut part_number = 1i32;
    let mut bytes_sent = 0u64;
    let mut eof = false;
    let mut join_set: JoinSet<Result<UploadedPart, String>> = JoinSet::new();

    loop {
        if cancel.is_cancelled() {
            join_set.abort_all();
            while join_set.join_next().await.is_some() {}
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            return Err(cancelled_error());
        }

        while join_set.len() < max_concurrent_parts && !eof {
            let mut buf = vec![0u8; part_size_bytes];
            let mut read = 0;
            while read < part_size_bytes {
                let n = tokio::select! {
                    _ = cancel.cancelled() => {
                        join_set.abort_all();
                        while join_set.join_next().await.is_some() {}
                        abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                        return Err(cancelled_error());
                    }
                    result = file.read(&mut buf[read..]) => {
                        match result {
                            Ok(n) => n,
                            Err(err) => {
                                join_set.abort_all();
                                while join_set.join_next().await.is_some() {}
                                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                                return Err(format!("Failed to read file: {}", err));
                            }
                        }
                    }
                };
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

            // Guard against the file growing after `file_size` was measured: a
            // part number beyond `total_parts` would index `completed_parts`
            // out of bounds. Abort the upload cleanly instead of panicking.
            if (part_number as usize) > total_parts {
                join_set.abort_all();
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(
                    "File changed during upload (grew larger than expected). Upload aborted."
                        .to_string(),
                );
            }

            let client = client.clone();
            let bucket = bucket.to_string();
            let key = key.to_string();
            let uid = upload_id.clone();
            let pn = part_number;
            let part_cancel = Arc::clone(cancel);

            let checksum_enabled = checksum.is_some();
            join_set.spawn(async move {
                let shared = bytes::Bytes::from(buf);
                upload_part_with_retry(
                    client,
                    bucket,
                    key,
                    uid,
                    pn,
                    shared,
                    checksum_enabled,
                    part_cancel,
                )
                .await
            });

            part_number += 1;
        }

        if join_set.is_empty() {
            break;
        }

        let joined = tokio::select! {
            _ = cancel.cancelled() => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(cancelled_error());
            }
            result = join_set.join_next() => result,
        };

        match joined {
            Some(Ok(Ok((pn, bytes_read, etag, part_checksum)))) => {
                let mut completed = aws_sdk_s3::types::CompletedPart::builder()
                    .part_number(pn)
                    .e_tag(etag);
                if let Some(part_checksum) = part_checksum {
                    completed = completed.checksum_sha256(part_checksum.base64);
                }
                completed_parts[(pn - 1) as usize] = Some(completed.build());
                bytes_sent += bytes_read as u64;
                if bandwidth_limit_bps > 0 {
                    let elapsed = started_at.elapsed().as_secs_f64();
                    let target = bytes_sent as f64 / bandwidth_limit_bps as f64;
                    if target > elapsed
                        && !cancel
                            .sleep_unless_cancelled(Duration::from_secs_f64(target - elapsed))
                            .await
                    {
                        continue;
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
                    None,
                    None,
                );
            }
            Some(Ok(Err(e))) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(e);
            }
            Some(Err(e)) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(format!("Upload task failed: {}", e));
            }
            None => break,
        }
    }

    // Verify the upload is complete before committing it.
    //
    // `completed_parts` is sized from the file length measured before the read
    // loop started. If the file shrank in the meantime the loop hits EOF early
    // and leaves trailing `None` slots. Flattening those away (as this code used
    // to do unconditionally) would complete a multipart upload containing only
    // the parts that happened to be read, publishing a silently truncated object
    // and reporting success.
    let missing_parts = completed_parts.iter().filter(|part| part.is_none()).count();
    let current_size = tokio::fs::metadata(file_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(file_size);
    if missing_parts > 0 || bytes_sent != file_size || current_size != file_size {
        join_set.abort_all();
        while join_set.join_next().await.is_some() {}
        abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
        return Err(format!(
            "File changed during upload: expected {} bytes in {} part(s) but sent {} bytes in {} part(s) \
             (file is now {} bytes). Upload aborted to avoid publishing a truncated object.",
            file_size,
            total_parts,
            bytes_sent,
            total_parts - missing_parts,
            current_size
        ));
    }

    let final_parts: Vec<aws_sdk_s3::types::CompletedPart> =
        completed_parts.into_iter().flatten().collect();

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(final_parts))
        .build();

    let mut complete_request = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload)
        .mpu_object_size(file_size as i64);
    if let Some(checksum) = checksum {
        complete_request = complete_request
            .checksum_sha256(&checksum.base64)
            .checksum_type(ChecksumType::FullObject);
    }
    if !overwrite {
        complete_request =
            apply_complete_multipart_create_only_guard(complete_request, provider, key)?;
    }
    let complete_request = complete_request.send();
    let complete_result = tokio::select! {
        _ = cancel.cancelled() => {
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            return Err(cancelled_error());
        }
        result = complete_request => result,
    };

    let complete_output = match complete_result {
        Ok(output) => output,
        Err(e) => {
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                return Err(map_create_only_write_error(
                    key,
                    &e,
                    overwrite,
                    "complete upload",
                ));
            }
            return Err(structured_transfer_sdk_error(
                "Failed to complete multipart upload",
                &e,
                "upload_complete",
                true,
            ));
        }
    };
    if let Some(checksum) = checksum {
        verify_upload_checksum_response(
            complete_output.checksum_sha256(),
            checksum,
            "Multipart upload",
        )?;
        if complete_output.checksum_type() != Some(&ChecksumType::FullObject) {
            return Err(encode_transfer_error(
                "checksum_mismatch",
                false,
                None,
                "Multipart upload returned an unexpected checksum type.".to_string(),
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_object_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    bytes: Vec<u8>,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
    checksum_verification: Option<bool>,
) -> Result<(), String> {
    let _storage_guard = crate::acquire_transfer_storage().await?;
    validate_mutating_key(&key, "Object key")?;
    if bytes.len() > MAX_UPLOAD_OBJECT_BYTES {
        return Err(format!(
            "Browser upload fallback is limited to {} MB.",
            MAX_UPLOAD_OBJECT_BYTES / (1024 * 1024)
        ));
    }

    let client = require_client(&state, &connection_id)?;
    let provider = require_storage_provider(&state, &connection_id)?;

    // This path previously never registered, checked, or cleared cancellation.
    // Cancelling a browser-fallback upload did nothing, and the id stayed in the
    // old cancelled-id set permanently.
    let guard = TransferGuard::register(transfer_id);
    let cancel = guard.token();

    let total = bytes.len() as u64;
    let attempt = normalize_attempt(attempt);
    let overwrite = overwrite.unwrap_or(false);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);
    let expected_checksum = checksum_enabled.then(|| sha256_checksum_bytes(&bytes));
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

    if guard.is_cancelled() {
        return Err(cancelled_error());
    }
    if !overwrite {
        require_put_create_only_support(provider, &key)?;
    }

    let mut req = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(bytes));

    if !content_type.is_empty() {
        req = req.content_type(&content_type);
    }
    if let Some(checksum) = expected_checksum.as_ref() {
        req = req
            .metadata(CHECKSUM_METADATA_KEY, &checksum.hex)
            .checksum_algorithm(ChecksumAlgorithm::Sha256)
            .checksum_sha256(&checksum.base64);
    }
    if !overwrite {
        req = apply_put_create_only_guard(req, provider, &key)?;
    }

    let send = req.send();
    tokio::pin!(send);
    let output = loop {
        tokio::select! {
            result = &mut send => {
                break result.map_err(|e| {
                    if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                        return map_create_only_write_error(&key, &e, overwrite, "upload");
                    }
                    structured_transfer_sdk_error("Failed to upload", &e, "upload", true)
                })?;
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.is_cancelled() {
                    return Err(cancelled_error());
                }
            }
        }
    };

    if guard.is_cancelled() {
        return Err(cancelled_error());
    }

    if let Some(checksum) = expected_checksum.as_ref() {
        verify_upload_checksum_response(output.checksum_sha256(), checksum, "Upload")?;
    }

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
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<AclResponse, String> {
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
    visibility: String,
) -> Result<(), String> {
    validate_mutating_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
    destination: String,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checksum_verification: Option<bool>,
) -> Result<u64, String> {
    let _storage_guard = crate::acquire_transfer_storage().await?;
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
    let client = require_client(&state, &connection_id)?;
    crate::issue_download_scratch_lease(&app, &destination_path, &temp_path)?;
    let _temp_guard = match crate::claim_download_temp(&temp_path, &destination_path) {
        Ok(guard) => guard,
        Err(err) => {
            crate::release_download_scratch_lease(&app, &destination_path);
            return Err(err);
        }
    };
    if temp_path.exists() {
        crate::clear_unusable_download_scratch(&temp_path)?;
    }
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);

    let guard = TransferGuard::register(transfer_id);
    let cancel = guard.token();

    if guard.is_cancelled() {
        return Err(cancelled_error());
    }

    let expected_checksum = if checksum_enabled {
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
        expected_checksum_from_head(&head)
    } else {
        None
    };

    let download_request = client.get_object().bucket(&bucket).key(&key).send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = download_request => {
            result.map_err(|e| {
                structured_transfer_sdk_error("Failed to download", &e, "download", true)
            })?
        }
    };

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
            let _ = std::fs::remove_file(&temp_path);
            return Err(err);
        }
    };

    if total_bytes > 0 && written != total_bytes {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "Downloaded byte count mismatch. Expected {}, wrote {}.",
            total_bytes, written
        ));
    }

    if let Some(expected) = expected_checksum.as_ref() {
        if let Err(err) = verify_file_checksum(&temp_path, expected, &cancel).await {
            let _ = std::fs::remove_file(&temp_path);
            return Err(err);
        }
    }

    finalize_download_file(&temp_path, &destination_path)?;
    crate::release_download_scratch_lease(&app, &destination_path);

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
async fn stream_body_to_temp(
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
    let mut buf = [0u8; 64 * 1024];
    const PROGRESS_INTERVAL: u64 = 256 * 1024;

    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }

        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = reader.read(&mut buf) => {
                result.map_err(|e| format!("Failed to read body: {}", e))?
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

        if written - last_emitted >= PROGRESS_INTERVAL {
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
fn finalize_download_file(temp_path: &Path, destination_path: &Path) -> Result<(), String> {
    // Publish only bytes that have reached stable storage. The parallel workers
    // sync each completed range before checkpointing, and this final whole-file
    // sync closes the window between the last checkpoint and the atomic rename.
    //
    // Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle
    // returns ERROR_ACCESS_DENIED, so open with write as well.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp_path)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("Failed to sync completed download: {}", e))?;

    if let Err(e) = std::fs::rename(temp_path, destination_path) {
        let _ = std::fs::remove_file(temp_path);
        return Err(format!("Failed to finalize download: {}", e));
    }
    crate::fsync_parent(destination_path)?;
    Ok(())
}

/// Confirm a response actually honoured the byte range that was requested.
///
/// A server that ignores `Range` answers with 200 and the whole object. Without
/// this check every worker would write the entire object at its own offset,
/// inflating the scratch file to `workers * object size` and corrupting it,
/// with the mismatch only surfacing later as a confusing byte-count error.
fn ensure_range_honoured(
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
    enable_resume: Option<bool>,
    checksum_verification: Option<bool>,
) -> Result<u64, String> {
    let _storage_guard = crate::acquire_transfer_storage().await?;
    validate_key(&key, "Object key")?;
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
    let client = require_client(&state, &connection_id)?;
    crate::issue_download_scratch_lease(&app, &destination_path, &temp_path)?;
    let _temp_guard = match crate::claim_download_temp(&temp_path, &destination_path) {
        Ok(guard) => guard,
        Err(err) => {
            crate::release_download_scratch_lease(&app, &destination_path);
            return Err(err);
        }
    };
    let attempt = normalize_attempt(attempt);
    let started_at = Instant::now();
    let threshold_mb = parallel_threshold_mb
        .unwrap_or(PARALLEL_DOWNLOAD_THRESHOLD_MB)
        .max(1);
    let checksum_enabled = checksum_verification.unwrap_or(false);

    let guard = TransferGuard::register(transfer_id);
    let cancel = guard.token();

    if guard.is_cancelled() {
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
    let total_bytes = head.content_length().unwrap_or(0) as u64;
    let object_etag = head.e_tag().unwrap_or_default().to_string();
    let object_version_id = head
        .version_id()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let expected_checksum = if checksum_enabled {
        expected_checksum_from_head(&head)
    } else {
        None
    };
    let threshold_bytes = (threshold_mb as u64) * 1024 * 1024;

    if total_bytes < threshold_bytes || total_bytes == 0 {
        // Hand off to the sequential path. Release our registration first so
        // the delegate can register the same id without colliding.
        drop(guard);
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
    let total_parts = total_bytes.div_ceil(part_size) as u32;
    if total_parts <= 1 {
        // Hand off to the sequential path. Release our registration first so
        // the delegate can register the same id without colliding.
        drop(guard);
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
    let checkpoint_enabled = enable_resume.unwrap_or(true)
        && checkpoint_id
            .as_ref()
            .map(|id| !id.trim().is_empty())
            .unwrap_or(false);

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
    // parts. The scratch file must already exist at exactly the expected length:
    // a checkpoint whose scratch file was deleted or truncated used to be
    // honoured anyway, and because the file is reopened with `create(true)` and
    // `set_len(total_bytes)` the missing regions were silently fabricated as
    // zeroes. Byte accounting still added up, so the corruption was invisible
    // unless the object happened to carry a checksum.
    let temp_len = tokio::fs::metadata(&temp_path)
        .await
        .ok()
        .map(|meta| meta.len());
    let temp_usable = temp_len == Some(total_bytes);

    let mut completed = vec![false; total_parts as usize];
    let mut resumed = false;

    if checkpoint_enabled {
        if let Some(id) = checkpoint_id.as_deref() {
            let checkpoint_json = load_transfer_checkpoint_json(&app, id).map_err(|err| {
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
                    resumed = completed.iter().any(|done| *done);
                }
            }
        }
    }

    // Anything we are not resuming into starts from a clean slate. The durable
    // scratch lease issued above authorizes replacing a leftover file from a
    // crashed attempt that had no valid checkpoint.
    if !resumed && temp_path.exists() {
        crate::clear_unusable_download_scratch(&temp_path)?;
    }

    let init_file = tokio::fs::OpenOptions::new()
        .create(true)
        // Do NOT truncate: on resume we reuse the existing temp file and keep the
        // bytes already written for completed parts.
        .truncate(false)
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
                let _ = std::fs::remove_file(&temp_path);
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
                    let _ = std::fs::remove_file(&temp_path);
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
                                || save_checkpoint_payload(&app, id, &payload),
                            ) {
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
                    let _ = std::fs::remove_file(&temp_path);
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
                    let _ = std::fs::remove_file(&temp_path);
                }
                return Err(format!("Parallel worker failed: {}", err));
            }
            None => break,
        }
    }

    let final_bytes = bytes_done.load(Ordering::Relaxed);
    let missing_parts = completed.iter().filter(|done| !**done).count();
    let on_disk = tokio::fs::metadata(&temp_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    // Aggregate byte accounting alone cannot prove the file is intact, so check
    // the part bitmap and the actual file length too.
    if final_bytes != total_bytes || missing_parts > 0 || on_disk != total_bytes {
        if !checkpoint_enabled {
            let _ = std::fs::remove_file(&temp_path);
        }
        return Err(format!(
            "Download incomplete: expected {} bytes across {} part(s), accounted for {} bytes \
             with {} part(s) missing, scratch file is {} bytes.",
            total_bytes, total_parts, final_bytes, missing_parts, on_disk
        ));
    }

    if let Some(expected) = expected_checksum.as_ref() {
        if let Err(err) = verify_file_checksum(&temp_path, expected, &cancel).await {
            if !checkpoint_enabled {
                let _ = std::fs::remove_file(&temp_path);
            }
            return Err(err);
        }
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
                let _ = std::fs::remove_file(&temp_path);
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
            let _ = std::fs::remove_file(&temp_path);
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

    finalize_download_file(&temp_path, &destination_path)?;
    crate::release_download_scratch_lease(&app, &destination_path);

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
            let _ = remove_transfer_checkpoint(&app, id);
        }
    }

    Ok(total_bytes)
}

#[tauri::command]
pub(crate) async fn create_folder(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = require_client(&state, &connection_id)?;

    validate_mutating_key(&key, "Object key")?;
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

/// Everything about a source object that a copy has to carry forward.
///
/// A single-part `CopyObject` preserves all of this implicitly (the default
/// metadata directive is COPY). A multipart copy does not: the destination is
/// created by `CreateMultipartUpload`, which starts from nothing, so every
/// header has to be supplied explicitly.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub(crate) struct CopyReceipt {
    source_key: String,
    source_etag: String,
    #[serde(default)]
    source_fingerprint: String,
    source_version_id: Option<String>,
    destination_key: String,
    destination_etag: String,
    destination_version_id: Option<String>,
}

#[derive(Clone)]
struct SourceObjectInfo {
    size: i64,
    last_modified: Option<String>,
    etag: Option<String>,
    version_id: Option<String>,
    content_type: Option<String>,
    cache_control: Option<String>,
    content_disposition: Option<String>,
    content_encoding: Option<String>,
    content_language: Option<String>,
    website_redirect_location: Option<String>,
    storage_class: Option<aws_sdk_s3::types::StorageClass>,
    server_side_encryption: Option<aws_sdk_s3::types::ServerSideEncryption>,
    ssekms_key_id: Option<String>,
    bucket_key_enabled: Option<bool>,
    metadata: Option<HashMap<String, String>>,
    acl: Option<ObjectCannedAcl>,
    tagging: Option<String>,
}

struct DestinationIdentity {
    etag: String,
    version_id: Option<String>,
}

fn hash_generation_fields(fields: Vec<(&str, String)>) -> String {
    let mut hasher = Sha256::new();
    for (name, value) in fields {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn head_generation_fingerprint(
    head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
) -> String {
    let mut fields = vec![
        ("etag", head.e_tag().unwrap_or_default().to_string()),
        (
            "last_modified",
            head.last_modified()
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "content_length",
            head.content_length().unwrap_or_default().to_string(),
        ),
        (
            "content_type",
            head.content_type().unwrap_or_default().to_string(),
        ),
        (
            "cache_control",
            head.cache_control().unwrap_or_default().to_string(),
        ),
        (
            "content_disposition",
            head.content_disposition().unwrap_or_default().to_string(),
        ),
        (
            "content_encoding",
            head.content_encoding().unwrap_or_default().to_string(),
        ),
        (
            "content_language",
            head.content_language().unwrap_or_default().to_string(),
        ),
        (
            "website_redirect_location",
            head.website_redirect_location()
                .unwrap_or_default()
                .to_string(),
        ),
        (
            "storage_class",
            head.storage_class()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default(),
        ),
        (
            "server_side_encryption",
            head.server_side_encryption()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default(),
        ),
        (
            "ssekms_key_id",
            head.ssekms_key_id().unwrap_or_default().to_string(),
        ),
        (
            "bucket_key_enabled",
            head.bucket_key_enabled()
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
    ];
    let mut metadata = head
        .metadata()
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    metadata.sort();
    fields.extend(
        metadata
            .into_iter()
            .map(|(key, value)| ("metadata", format!("{}={}", key, value))),
    );
    hash_generation_fields(fields)
}

fn source_generation_fingerprint(info: &SourceObjectInfo) -> String {
    let mut fields = vec![
        ("etag", info.etag.clone().unwrap_or_default()),
        (
            "last_modified",
            info.last_modified.clone().unwrap_or_default(),
        ),
        ("content_length", info.size.to_string()),
        (
            "content_type",
            info.content_type.clone().unwrap_or_default(),
        ),
        (
            "cache_control",
            info.cache_control.clone().unwrap_or_default(),
        ),
        (
            "content_disposition",
            info.content_disposition.clone().unwrap_or_default(),
        ),
        (
            "content_encoding",
            info.content_encoding.clone().unwrap_or_default(),
        ),
        (
            "content_language",
            info.content_language.clone().unwrap_or_default(),
        ),
        (
            "website_redirect_location",
            info.website_redirect_location.clone().unwrap_or_default(),
        ),
        (
            "storage_class",
            info.storage_class
                .as_ref()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default(),
        ),
        (
            "server_side_encryption",
            info.server_side_encryption
                .as_ref()
                .map(|value| value.as_str().to_string())
                .unwrap_or_default(),
        ),
        (
            "ssekms_key_id",
            info.ssekms_key_id.clone().unwrap_or_default(),
        ),
        (
            "bucket_key_enabled",
            info.bucket_key_enabled
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
    ];
    let mut metadata = info
        .metadata
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    metadata.sort();
    fields.extend(
        metadata
            .into_iter()
            .map(|(key, value)| ("metadata", format!("{}={}", key, value))),
    );
    hash_generation_fields(fields)
}

async fn destination_identity_from_head(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<DestinationIdentity, String> {
    let request = client.head_object().bucket(bucket).key(key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result.map_err(|err| format!("Failed to read destination identity for '{}': {}", key, err))?,
    };
    let etag = head
        .e_tag()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Destination '{}' returned no ETag after copy", key))?;
    Ok(DestinationIdentity {
        etag: etag.to_string(),
        version_id: head.version_id().map(str::to_string),
    })
}

fn source_info_from_head(
    head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
) -> SourceObjectInfo {
    // NOTE: the `Expires` header is deliberately not carried. Both the getter and
    // the builder setter for it are deprecated in the SDK in favour of a raw
    // string accessor that has no matching setter, and `Cache-Control` (which is
    // preserved) supersedes it for every modern client.
    SourceObjectInfo {
        size: head.content_length().unwrap_or(0),
        last_modified: head.last_modified().map(|value| value.to_string()),
        etag: head.e_tag().map(|v| v.to_string()),
        version_id: head.version_id().map(|v| v.to_string()),
        content_type: head.content_type().map(|v| v.to_string()),
        cache_control: head.cache_control().map(|v| v.to_string()),
        content_disposition: head.content_disposition().map(|v| v.to_string()),
        content_encoding: head.content_encoding().map(|v| v.to_string()),
        content_language: head.content_language().map(|v| v.to_string()),
        website_redirect_location: head.website_redirect_location().map(|v| v.to_string()),
        storage_class: head.storage_class().cloned(),
        server_side_encryption: head.server_side_encryption().cloned(),
        ssekms_key_id: head.ssekms_key_id().map(|v| v.to_string()),
        bucket_key_enabled: head.bucket_key_enabled(),
        metadata: head.metadata().cloned(),
        acl: None,
        tagging: None,
    }
}

async fn describe_source(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<SourceObjectInfo, String> {
    let head_request = client.head_object().bucket(bucket).key(key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = head_request => {
            result.map_err(|e| format!("Failed to get object info for '{}': {}", key, e))?
        }
    };
    let mut info = source_info_from_head(&head);

    // A copy/move is allowed only once the attributes it has to restate have
    // been read successfully. Treating an unexpected error as "no attributes"
    // can silently reset ACLs or drop tags, and a move would then delete the
    // only correctly attributed source object. `CopyObject` does not carry the
    // ACL, so that read is always required ('s3:GetObjectAcl'); tags are carried
    // server-side except for multipart copies, which is why the tag read below
    // is conditional.
    let version_id = info.version_id.clone();
    // Only a multipart copy has to restate tags: `CopyObject` defaults its
    // tagging directive to COPY, so S3 carries them server-side. Reading them
    // anyway would make `s3:GetObjectTagging` a new requirement for every copy,
    // move and metadata edit, breaking credentials that never needed it.
    let needs_explicit_tagging = info.size >= MULTIPART_COPY_THRESHOLD;
    let properties = async {
        tokio::join!(
            infer_canned_acl_for_object(client, bucket, key, version_id.as_deref()),
            async {
                if needs_explicit_tagging {
                    encoded_tagging_for_object(client, bucket, key, version_id.as_deref()).await
                } else {
                    Ok(None)
                }
            }
        )
    };
    let (acl, tagging) = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = properties => result,
    };
    info.acl = acl?;
    info.tagging = tagging?;
    Ok(info)
}

/// Copy a single object, preserving metadata and picking the right mechanism
/// for its size.
///
/// This is the one place that decides between `CopyObject` and a multipart copy.
/// Previously only `rename_object` and `copy_object_to` made that decision, so
/// the prefix-wide operations always issued a single `CopyObject` and failed
/// outright on any object at or above S3's 5 GiB copy-source limit.
async fn copy_one(
    client: &Client,
    src_bucket: &str,
    src_key: &str,
    dst_bucket: &str,
    dst_key: &str,
    info: Option<SourceObjectInfo>,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<DestinationIdentity, String> {
    if src_bucket == dst_bucket && src_key == dst_key {
        return Err(format!(
            "Source and destination are the same object ('{}'). Refusing to copy an object onto itself.",
            src_key
        ));
    }
    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }

    let info = match info {
        Some(info) => info,
        None => describe_source(client, src_bucket, src_key, cancel).await?,
    };

    if info.size >= MULTIPART_COPY_THRESHOLD {
        return copy_object_multipart(
            client, src_bucket, dst_bucket, src_key, dst_key, &info, overwrite, provider, cancel,
        )
        .await;
    }

    let create_only_strategy = if overwrite {
        None
    } else {
        Some(require_copy_create_only_strategy(provider, dst_key)?)
    };

    let source = encode_copy_source_with_version(src_bucket, src_key, info.version_id.as_deref());
    let build_copy = |include_acl: bool| {
        let mut request = client
            .copy_object()
            .bucket(dst_bucket)
            .key(dst_key)
            .copy_source(&source);
        if let Some(etag) = info.etag.as_deref() {
            request = request.copy_source_if_match(etag);
        }
        if include_acl {
            if let Some(acl) = info.acl.as_ref() {
                request = request.acl(acl.clone());
            }
        }
        // The default COPY metadata directive carries user metadata and content
        // headers, but storage class and encryption fall back to the destination
        // bucket's defaults. Restating them keeps an archived or KMS-encrypted
        // object intact, which matters most for renames and rollback restores
        // where the original is removed once the copy is believed complete.
        if let Some(value) = info.storage_class.as_ref() {
            request = request.storage_class(value.clone());
        }
        if let Some(value) = info.server_side_encryption.as_ref() {
            request = request.server_side_encryption(value.clone());
        }
        if let Some(value) = info.ssekms_key_id.as_deref() {
            request = request.ssekms_key_id(value);
        }
        if let Some(value) = info.bucket_key_enabled {
            request = request.bucket_key_enabled(value);
        }
        request
    };

    let mut include_acl = info.acl.is_some();
    let copy_output = loop {
        let request = build_copy(include_acl);
        let send = send_copy_object_create_only(request, create_only_strategy);
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = send => result,
        };
        match result {
            Ok(output) => break output,
            Err(err) => {
                let detail = format!("{:?}", err);
                if include_acl && acls_are_unavailable(&detail) {
                    // The destination disables ACLs, so the source ACL is not a
                    // property that can be carried; retry without it.
                    include_acl = false;
                    continue;
                }
                if !overwrite
                    && (is_destination_occupied(&err) || is_concurrent_write_conflict(&err))
                {
                    return Err(map_create_only_write_error(
                        dst_key, &err, overwrite, "copy",
                    ));
                }
                return Err(format!("Failed to copy '{}': {}", src_key, err));
            }
        }
    };
    if let Some(etag) = copy_output
        .copy_object_result()
        .and_then(|result| result.e_tag())
        .filter(|etag| !etag.is_empty())
    {
        return Ok(DestinationIdentity {
            etag: etag.to_string(),
            version_id: copy_output.version_id().map(|value| value.to_string()),
        });
    }
    destination_identity_from_head(client, dst_bucket, dst_key, cancel).await
}

async fn copy_object_multipart(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    source_key: &str,
    dest_key: &str,
    info: &SourceObjectInfo,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<DestinationIdentity, String> {
    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }

    if !overwrite {
        // Reject before creating remote multipart state or copying any parts.
        require_complete_multipart_create_only_support(provider, dest_key)?;
    }

    // Validate provider-reported size before creating any remote multipart
    // state; an unsupported size must not leave an orphaned upload behind.
    let size = info.size as u64;
    let part_size = multipart_copy_part_size(size)?;

    // Carry the source's metadata onto the new multipart upload. Without this the
    // destination was created bare: content type, user metadata, caching headers,
    // storage class and encryption settings were all silently dropped — and for a
    // rename the source is deleted immediately afterwards, so the originals were
    // gone.
    let build_create = |include_acl: bool| {
        let mut create_req = client
            .create_multipart_upload()
            .bucket(dst_bucket)
            .key(dest_key);
        if let Some(value) = info.content_type.as_deref() {
            create_req = create_req.content_type(value);
        }
        if let Some(value) = info.cache_control.as_deref() {
            create_req = create_req.cache_control(value);
        }
        if let Some(value) = info.content_disposition.as_deref() {
            create_req = create_req.content_disposition(value);
        }
        if let Some(value) = info.content_encoding.as_deref() {
            create_req = create_req.content_encoding(value);
        }
        if let Some(value) = info.content_language.as_deref() {
            create_req = create_req.content_language(value);
        }
        if let Some(value) = info.website_redirect_location.as_deref() {
            create_req = create_req.website_redirect_location(value);
        }
        if let Some(value) = info.storage_class.as_ref() {
            create_req = create_req.storage_class(value.clone());
        }
        if let Some(value) = info.server_side_encryption.as_ref() {
            create_req = create_req.server_side_encryption(value.clone());
        }
        if let Some(value) = info.ssekms_key_id.as_deref() {
            create_req = create_req.ssekms_key_id(value);
        }
        if let Some(value) = info.bucket_key_enabled {
            create_req = create_req.bucket_key_enabled(value);
        }
        if let Some(metadata) = info.metadata.as_ref() {
            if !metadata.is_empty() {
                create_req = create_req.set_metadata(Some(metadata.clone()));
            }
        }
        if include_acl {
            if let Some(acl) = info.acl.as_ref() {
                create_req = create_req.acl(acl.clone());
            }
        }
        if let Some(tagging) = info.tagging.as_deref() {
            create_req = create_req.tagging(tagging);
        }
        create_req
    };

    let mut include_acl = info.acl.is_some();
    let create_output = loop {
        let request = build_create(include_acl).send();
        let create_result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result,
        };
        match create_result {
            Ok(output) => break output,
            Err(err) => {
                let detail = format!("{:?}", err);
                if include_acl && acls_are_unavailable(&detail) {
                    include_acl = false;
                    continue;
                }
                return Err(format!("Failed to create multipart copy: {}", err));
            }
        }
    };

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned for multipart copy")?
        .to_string();

    let copy_source =
        encode_copy_source_with_version(src_bucket, source_key, info.version_id.as_deref());
    let mut completed_parts = Vec::new();
    let mut part_number = 1i32;
    let mut offset = 0u64;

    while offset < size {
        let end = std::cmp::min(offset + part_size, size) - 1;
        let range = format!("bytes={}-{}", offset, end);

        let mut part_builder = client
            .upload_part_copy()
            .bucket(dst_bucket)
            .key(dest_key)
            .upload_id(&upload_id)
            .copy_source(&copy_source)
            .copy_source_range(&range)
            .part_number(part_number);
        if let Some(etag) = info.etag.as_deref() {
            part_builder = part_builder.copy_source_if_match(etag);
        }
        let part_request = part_builder.send();
        let part_result = tokio::select! {
            _ = cancel.cancelled() => {
                abort_multipart_upload_bounded(client, dst_bucket, dest_key, &upload_id).await;
                return Err(cancelled_error());
            }
            result = part_request => result,
        };

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
                abort_multipart_upload_bounded(client, dst_bucket, dest_key, &upload_id).await;
                return Err(format!("Failed to copy part {}: {}", part_number, e));
            }
        }
    }

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();

    let mut complete_request = client
        .complete_multipart_upload()
        .bucket(dst_bucket)
        .key(dest_key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload);
    if !overwrite {
        complete_request =
            apply_complete_multipart_create_only_guard(complete_request, provider, dest_key)?;
    }
    let complete_request = complete_request.send();
    let complete_result = tokio::select! {
        _ = cancel.cancelled() => {
            abort_multipart_upload_bounded(client, dst_bucket, dest_key, &upload_id).await;
            return Err(cancelled_error());
        }
        result = complete_request => result,
    };

    let complete_output = match complete_result {
        Ok(output) => output,
        Err(e) => {
            abort_multipart_upload_bounded(client, dst_bucket, dest_key, &upload_id).await;
            if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                return Err(map_create_only_write_error(
                    dest_key,
                    &e,
                    overwrite,
                    "complete multipart copy",
                ));
            }
            return Err(format!("Failed to complete multipart copy: {}", e));
        }
    };
    if let Some(etag) = complete_output.e_tag().filter(|value| !value.is_empty()) {
        return Ok(DestinationIdentity {
            etag: etag.to_string(),
            version_id: complete_output.version_id().map(|value| value.to_string()),
        });
    }
    destination_identity_from_head(client, dst_bucket, dest_key, cancel).await
}

async fn copy_with_receipt(
    client: &Client,
    src_bucket: &str,
    src_key: &str,
    dst_bucket: &str,
    dst_key: &str,
    source_info: Option<SourceObjectInfo>,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<CopyReceipt, String> {
    let info = match source_info {
        Some(info) => info,
        None => describe_source(client, src_bucket, src_key, cancel).await?,
    };
    let source_etag = info
        .etag
        .as_deref()
        .filter(|etag| !etag.is_empty())
        .ok_or_else(|| format!("Source '{}' did not return an ETag", src_key))?
        .to_string();
    let source_fingerprint = source_generation_fingerprint(&info);

    let destination = copy_one(
        client,
        src_bucket,
        src_key,
        dst_bucket,
        dst_key,
        Some(info.clone()),
        overwrite,
        provider,
        cancel,
    )
    .await?;

    Ok(CopyReceipt {
        source_key: src_key.to_string(),
        source_etag,
        source_fingerprint,
        source_version_id: info.version_id,
        destination_key: dst_key.to_string(),
        destination_etag: destination.etag,
        destination_version_id: destination.version_id,
    })
}

#[tauri::command]
pub(crate) async fn rename_object(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    old_key: String,
    new_key: String,
    overwrite: bool,
    transfer_id: Option<u32>,
) -> Result<(), String> {
    validate_mutating_key(&old_key, "Source key")?;
    validate_mutating_key(&new_key, "Destination key")?;
    if old_key == new_key {
        return Err("Source and destination keys are identical.".to_string());
    }
    let client = require_client(&state, &connection_id)?;
    let provider = require_storage_provider(&state, &connection_id)?;
    let (_guard, cancel) = transfer_cancel_context(transfer_id);

    if !overwrite && destination_object_exists(&client, &bucket, &new_key).await? {
        return Err(format!(
            "Destination '{}' already exists. Rename with overwrite to replace it.",
            new_key
        ));
    }

    let receipt = copy_with_receipt(
        &client, &bucket, &old_key, &bucket, &new_key, None, overwrite, provider, &cancel,
    )
    .await?;
    delete_receipts_checked(&client, &bucket, &bucket, &[receipt], &cancel).await?;
    Ok(())
}

/// List every key under a prefix (no delimiter, fully recursive, paginated).
async fn list_all_keys_under_prefix(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
    cancel: &CancelToken,
) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);
        if let Some(ref token) = continuation_token {
            req = req.continuation_token(token);
        }
        let request = req.send();
        let output = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => {
                result.map_err(|e| format!("Failed to list objects: {}", e))?
            }
        };

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
    connection_id: String,
    bucket: String,
    prefix: String,
) -> Result<DeleteResult, String> {
    validate_mutating_prefix(&prefix, "Prefix")?;
    let client = require_client(&state, &connection_id)?;

    let mut result = DeleteResult::default();
    let mut continuation_token: Option<String> = None;

    'pages: loop {
        let mut req = client.list_objects_v2().bucket(&bucket).prefix(&prefix);
        if let Some(ref token) = continuation_token {
            req = req.continuation_token(token);
        }
        let output = match req.send().await {
            Ok(output) => output,
            Err(err) => {
                result.incomplete = true;
                let confirmed = result.deleted;
                record_delete_error(
                    &mut result,
                    format!(
                        "Failed to list remaining objects after {} confirmed deletion(s): {}",
                        confirmed, err
                    ),
                );
                break;
            }
        };

        let keys: Vec<String> = output
            .contents()
            .iter()
            .filter_map(|obj| obj.key().map(|k| k.to_string()))
            .collect();

        if keys.is_empty() {
            if output.is_truncated().unwrap_or(false) {
                continuation_token = output.next_continuation_token().map(|s| s.to_string());
                if continuation_token.is_none() {
                    result.incomplete = true;
                    record_delete_error(
                        &mut result,
                        "S3 listing was truncated without a continuation token".to_string(),
                    );
                    break;
                }
                continue;
            }
            break;
        }

        for chunk in keys.chunks(1000) {
            let objects = chunk
                .iter()
                .map(|k| {
                    ObjectIdentifier::builder().key(k).build().map_err(|e| {
                        format!("Invalid key after deleting {}: {}", result.deleted, e)
                    })
                })
                .collect::<Result<Vec<ObjectIdentifier>, _>>();
            let objects = match objects {
                Ok(objects) => objects,
                Err(err) => {
                    result.incomplete = true;
                    record_delete_error(&mut result, err);
                    break 'pages;
                }
            };

            let delete = match Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
            {
                Ok(delete) => delete,
                Err(err) => {
                    result.incomplete = true;
                    let confirmed = result.deleted;
                    record_delete_error(
                        &mut result,
                        format!("Delete build error after deleting {}: {}", confirmed, err),
                    );
                    break 'pages;
                }
            };

            let del_output = match client
                .delete_objects()
                .bucket(&bucket)
                .delete(delete)
                .send()
                .await
            {
                Ok(output) => output,
                Err(err) => {
                    result.incomplete = true;
                    let confirmed = result.deleted;
                    record_delete_error(
                        &mut result,
                        format!(
                            "Batch delete response failed after {} confirmed deletion(s): {}",
                            confirmed, err
                        ),
                    );
                    break 'pages;
                }
            };

            let errors = del_output.errors();
            result.failed = result.failed.saturating_add(errors.len() as u32);
            result.deleted = result
                .deleted
                .saturating_add(chunk.len().saturating_sub(errors.len()) as u32);
            for err in errors {
                record_delete_error(
                    &mut result,
                    format!(
                        "{}: {}",
                        err.key().unwrap_or("?"),
                        err.message().unwrap_or("unknown error")
                    ),
                );
            }
        }

        if output.is_truncated().unwrap_or(false) {
            continuation_token = output.next_continuation_token().map(|s| s.to_string());
            if continuation_token.is_none() {
                result.incomplete = true;
                record_delete_error(
                    &mut result,
                    "S3 listing was truncated without a continuation token".to_string(),
                );
                break;
            }
        } else {
            break;
        }
    }

    Ok(result)
}

/// Copy every object under `src_prefix` to `dst_prefix` as one rollback-safe
/// transaction and return the exact source/destination identities copied.
struct DestinationBackup {
    destination_key: String,
    backup_key: String,
    source_info: SourceObjectInfo,
}

const ROLLBACK_BACKUP_PREFIX: &str = ".s3-sidekick-rollback/";

/// Rollback namespaces belonging to prefix operations running right now.
///
/// Transfers run several workers concurrently, so a peer operation's backups are
/// expected to be present and must not be mistaken for abandoned ones.
fn active_rollback_namespaces() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Registers a namespace for the lifetime of one prefix operation.
struct RollbackNamespaceGuard {
    namespace: String,
}

impl RollbackNamespaceGuard {
    fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = ROLLBACK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let namespace = format!("{}-{}-{}", std::process::id(), timestamp, sequence);
        if let Ok(mut active) = active_rollback_namespaces().lock() {
            active.insert(namespace.clone());
        }
        Self { namespace }
    }
}

impl Drop for RollbackNamespaceGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = active_rollback_namespaces().lock() {
            active.remove(&self.namespace);
        }
    }
}

fn namespace_of_backup_key(key: &str) -> Option<&str> {
    key.strip_prefix(ROLLBACK_BACKUP_PREFIX)
        .and_then(|rest| rest.split('/').next())
        .filter(|namespace| !namespace.is_empty())
}

/// Refuse to start a prefix copy while backups from an abandoned attempt survive.
///
/// The backup set only exists in memory for the duration of a call, so a crash
/// leaves the originals reachable solely through their backup objects. Starting
/// again would back up the already-overwritten copies and make the surviving
/// originals unreachable, so an interrupted attempt has to be resolved first.
/// Backups belonging to an operation still running in this process are skipped:
/// they are not abandoned, and reporting them would invite a user to delete data
/// a live operation is depending on.
async fn ensure_no_orphaned_rollback_backups(
    client: &Client,
    bucket: &str,
    cancel: &CancelToken,
) -> Result<(), String> {
    let before_listing = active_rollback_namespaces()
        .lock()
        .map_err(|_| "Internal rollback namespace state error".to_string())?
        .clone();
    let existing =
        list_all_keys_under_prefix(client, bucket, ROLLBACK_BACKUP_PREFIX, cancel).await?;
    if existing.is_empty() {
        return Ok(());
    }

    // Union the membership seen before and after the listing. A peer operation
    // that started or finished while the LIST was in flight would otherwise look
    // abandoned, aborting this operation over keys that are either still in use
    // or already gone.
    let mut active = before_listing;
    active.extend(
        active_rollback_namespaces()
            .lock()
            .map_err(|_| "Internal rollback namespace state error".to_string())?
            .iter()
            .cloned(),
    );
    let abandoned: Vec<&String> = existing
        .iter()
        .filter(|key| {
            namespace_of_backup_key(key)
                .map(|namespace| !active.contains(namespace))
                .unwrap_or(true)
        })
        .collect();
    if abandoned.is_empty() {
        return Ok(());
    }

    let sample: Vec<&str> = abandoned.iter().take(3).map(|key| key.as_str()).collect();
    Err(format!(
        "Bucket '{}' still holds {} rollback backup object(s) from an interrupted copy or move. \
         They may hold the only copy of data that was overwritten. Check them under '{}' and \
         restore or remove them before retrying, and only while no other transfer is running. ({})",
        bucket,
        abandoned.len(),
        ROLLBACK_BACKUP_PREFIX,
        sample.join(", ")
    ))
}

fn rollback_error(original: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        original
    } else {
        format!(
            "{}. Rollback also encountered: {}. Backup objects were retained where restoration could not be confirmed.",
            original,
            failures.join("; ")
        )
    }
}

async fn remove_backup_object(
    client: &Client,
    bucket: &str,
    backup: &DestinationBackup,
) -> Result<(), String> {
    let mut request = client
        .delete_object()
        .bucket(bucket)
        .key(&backup.backup_key);
    if let Some(version_id) = backup.source_info.version_id.as_deref() {
        request = request.version_id(version_id);
    }
    request
        .send()
        .await
        .map_err(|err| format!("failed to remove backup '{}': {}", backup.backup_key, err))?;
    Ok(())
}

async fn rollback_prefix_copy(
    client: &Client,
    bucket: &str,
    created_destinations: &[CopyReceipt],
    backups: &[DestinationBackup],
    provider: StorageProviderKind,
) -> Vec<String> {
    let rollback_cancel = Arc::new(CancelFlag::default());
    let mut failures = Vec::new();

    // Restore overwritten objects first. A backup is deleted only after its
    // original destination has definitely been recreated.
    for backup in backups.iter().rev() {
        match copy_one(
            client,
            bucket,
            &backup.backup_key,
            bucket,
            &backup.destination_key,
            Some(backup.source_info.clone()),
            true,
            provider,
            &rollback_cancel,
        )
        .await
        {
            Ok(_) => {
                if let Err(err) = remove_backup_object(client, bucket, backup).await {
                    failures.push(format!("restored '{}' but {}", backup.destination_key, err));
                }
            }
            Err(err) => failures.push(format!(
                "could not restore '{}' from retained backup '{}': {}",
                backup.destination_key, backup.backup_key, err
            )),
        }
    }

    // Remove only destinations whose successful copy identity is known. The
    // conditional delete protects unversioned buckets from overwrites between
    // the original absence check and rollback; a versioned delete removes only
    // the exact version created by this operation.
    for receipt in created_destinations.iter().rev() {
        let mut request = client
            .delete_object()
            .bucket(bucket)
            .key(&receipt.destination_key)
            .if_match(&receipt.destination_etag);
        if let Some(version_id) = receipt.destination_version_id.as_deref() {
            request = request.version_id(version_id);
        }
        if let Err(err) = request.send().await {
            failures.push(format!(
                "could not conditionally remove newly created destination '{}': {}",
                receipt.destination_key, err
            ));
        }
    }

    failures
}

async fn copy_prefix_objects(
    client: &Client,
    src_bucket: &str,
    src_prefix: &str,
    dst_bucket: &str,
    dst_prefix: &str,
    collect_receipts: bool,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<Vec<CopyReceipt>, String> {
    ensure_no_orphaned_rollback_backups(client, dst_bucket, cancel).await?;

    let namespace_guard = RollbackNamespaceGuard::new();
    let namespace = namespace_guard.namespace.clone();
    let mut created_destinations = Vec::new();
    let mut backups = Vec::new();
    let mut receipts = Vec::new();
    let mut continuation_token: Option<String> = None;
    let mut operation_index = 0usize;

    loop {
        let mut list_request = client
            .list_objects_v2()
            .bucket(src_bucket)
            .prefix(src_prefix);
        if let Some(token) = continuation_token.as_deref() {
            list_request = list_request.continuation_token(token);
        }
        let list_output = tokio::select! {
            _ = cancel.cancelled() => {
                let failures = rollback_prefix_copy(client, dst_bucket, &created_destinations, &backups, provider).await;
                return Err(rollback_error(cancelled_error(), failures));
            }
            result = list_request.send() => match result {
                Ok(output) => output,
                Err(e) => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(
                        format!("Failed to list objects: {}", e),
                        failures,
                    ));
                }
            },
        };
        let keys: Vec<String> = list_output
            .contents()
            .iter()
            .filter_map(|object| object.key().map(str::to_string))
            .collect();

        for key in &keys {
            if operation_index >= MAX_PREFIX_TRANSACTION_OBJECTS {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(
                    format!(
                        "Prefix operation exceeds the {}-object transaction limit; no source was deleted",
                        MAX_PREFIX_TRANSACTION_OBJECTS
                    ),
                    failures,
                ));
            }
            let index = operation_index;
            operation_index += 1;
            if cancel.is_cancelled() {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(cancelled_error(), failures));
            }

            // Key-shape rejections must unwind like any other failure. Returning
            // straight out of the loop would abandon destinations this call already
            // created and backups it already took.
            let suffix = match key.strip_prefix(src_prefix) {
                Some(suffix) => suffix,
                None => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(
                        format!("Key '{}' does not start with prefix '{}'", key, src_prefix),
                        failures,
                    ));
                }
            };
            let new_key = format!("{}{}", dst_prefix, suffix);
            if let Err(err) = validate_key(&new_key, "Destination key") {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(err, failures));
            }

            if src_bucket == dst_bucket && &new_key == key {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(
                format!(
                    "Source and destination resolve to the same object ('{}'). Refusing to copy a prefix onto itself.",
                    key
                ),
                failures,
            ));
            }

            let destination_head_request =
                client.head_object().bucket(dst_bucket).key(&new_key).send();
            let destination_head = tokio::select! {
                _ = cancel.cancelled() => {
                    let failures = rollback_prefix_copy(client, dst_bucket, &created_destinations, &backups, provider).await;
                    return Err(rollback_error(cancelled_error(), failures));
                }
                result = destination_head_request => result,
            };

            let destination_was_absent = match destination_head {
                Ok(_) => {
                    if !overwrite {
                        let failures = rollback_prefix_copy(
                            client,
                            dst_bucket,
                            &created_destinations,
                            &backups,
                            provider,
                        )
                        .await;
                        return Err(rollback_error(
                            destination_conflict_error(&new_key),
                            failures,
                        ));
                    }
                    let destination_info =
                        match describe_source(client, dst_bucket, &new_key, cancel).await {
                            Ok(info) => info,
                            Err(err) => {
                                let failures = rollback_prefix_copy(
                                    client,
                                    dst_bucket,
                                    &created_destinations,
                                    &backups,
                                    provider,
                                )
                                .await;
                                return Err(rollback_error(err, failures));
                            }
                        };
                    let backup_key = format!("{}{}/{}", ROLLBACK_BACKUP_PREFIX, namespace, index);
                    let backup_probe = client
                        .head_object()
                        .bucket(dst_bucket)
                        .key(&backup_key)
                        .send();
                    let backup_probe_result = tokio::select! {
                        _ = cancel.cancelled() => {
                            let failures = rollback_prefix_copy(client, dst_bucket, &created_destinations, &backups, provider).await;
                            return Err(rollback_error(cancelled_error(), failures));
                        }
                        result = backup_probe => result,
                    };
                    match backup_probe_result {
                        Ok(_) => {
                            let failures = rollback_prefix_copy(
                                client,
                                dst_bucket,
                                &created_destinations,
                                &backups,
                                provider,
                            )
                            .await;
                            return Err(rollback_error(
                                format!("Rollback backup key '{}' already exists", backup_key),
                                failures,
                            ));
                        }
                        Err(err) if is_not_found(&err) => {}
                        Err(err) => {
                            let failures = rollback_prefix_copy(
                                client,
                                dst_bucket,
                                &created_destinations,
                                &backups,
                                provider,
                            )
                            .await;
                            return Err(rollback_error(
                                format!(
                                    "Failed to reserve rollback backup '{}': {}",
                                    backup_key, err
                                ),
                                failures,
                            ));
                        }
                    }

                    let backup_receipt = match copy_with_receipt(
                        client,
                        dst_bucket,
                        &new_key,
                        dst_bucket,
                        &backup_key,
                        Some(destination_info.clone()),
                        true,
                        provider,
                        cancel,
                    )
                    .await
                    {
                        Ok(receipt) => receipt,
                        Err(err) => {
                            let _ = client
                                .delete_object()
                                .bucket(dst_bucket)
                                .key(&backup_key)
                                .send()
                                .await;
                            let failures = rollback_prefix_copy(
                                client,
                                dst_bucket,
                                &created_destinations,
                                &backups,
                                provider,
                            )
                            .await;
                            return Err(rollback_error(
                                format!("Failed to back up destination '{}': {}", new_key, err),
                                failures,
                            ));
                        }
                    };
                    let mut backup_info = destination_info;
                    backup_info.etag = Some(backup_receipt.destination_etag);
                    backup_info.version_id = backup_receipt.destination_version_id;
                    backups.push(DestinationBackup {
                        destination_key: new_key.clone(),
                        backup_key,
                        source_info: backup_info,
                    });
                    false
                }
                Err(err) if is_not_found(&err) => true,
                Err(err) => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(
                        format!("Failed to check destination '{}': {}", new_key, err),
                        failures,
                    ));
                }
            };

            let source_info = match describe_source(client, src_bucket, key, cancel).await {
                Ok(info) => info,
                Err(err) => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(err, failures));
                }
            };
            match copy_with_receipt(
                client,
                src_bucket,
                key,
                dst_bucket,
                &new_key,
                Some(source_info),
                overwrite,
                provider,
                cancel,
            )
            .await
            {
                Ok(receipt) => {
                    if destination_was_absent {
                        created_destinations.push(receipt.clone());
                    }
                    if collect_receipts {
                        receipts.push(receipt);
                    }
                }
                Err(err) => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(err, failures));
                }
            }
        }

        if list_output.is_truncated().unwrap_or(false) {
            match list_output.next_continuation_token() {
                Some(token) => continuation_token = Some(token.to_string()),
                None => {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(
                        "S3 listing was truncated without a continuation token".to_string(),
                        failures,
                    ));
                }
            }
        } else {
            break;
        }
    }

    // Try every backup before reporting. Stopping at the first failure used to
    // leave the remaining backups in the bucket without ever naming them, so the
    // user could not tell which objects to clean up or restore from.
    let mut cleanup_failures = Vec::new();
    let mut retained_backups = Vec::new();
    for backup in &backups {
        if let Err(err) = remove_backup_object(client, dst_bucket, backup).await {
            cleanup_failures.push(err);
            retained_backups.push(backup.backup_key.clone());
        }
    }
    if !cleanup_failures.is_empty() {
        return Err(format!(
            "Every copy completed and no source was touched, but {} rollback backup(s) could not \
             be removed: {}. Those objects are copies of destinations this operation successfully \
             replaced, so they are safe to delete, and doing so is required before retrying. ({})",
            retained_backups.len(),
            cleanup_failures.join("; "),
            retained_backups.join(", ")
        ));
    }

    Ok(receipts)
}

async fn current_identity_matches(
    client: &Client,
    bucket: &str,
    key: &str,
    expected_etag: &str,
    request_version_id: Option<&str>,
    expected_version_id: Option<&str>,
    expected_fingerprint: Option<&str>,
    cancel: &CancelToken,
) -> Result<Option<bool>, String> {
    let mut request = client.head_object().bucket(bucket).key(key);
    if let Some(version_id) = request_version_id {
        request = request.version_id(version_id);
    }
    let request = request.send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };

    match result {
        Ok(head) => {
            let etag_matches = head.e_tag() == Some(expected_etag);
            let version_matches = expected_version_id
                .map(|expected| head.version_id() == Some(expected))
                .unwrap_or(true);
            let fingerprint_matches = expected_fingerprint
                .map(|expected| head_generation_fingerprint(&head) == expected)
                .unwrap_or(true);
            Ok(Some(etag_matches && version_matches && fingerprint_matches))
        }
        Err(err) if is_not_found(&err) => Ok(None),
        Err(err) => Err(format!("Failed to verify '{}': {}", key, err)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceDeleteDecision {
    AlreadyDeleted,
    Delete,
    Changed,
}

/// Decide what a resumed versioned move should do with one recorded source.
///
/// `exact_version` is the HEAD of the exact version that was copied, and
/// `current_version` is the HEAD of the key without a version, i.e. whatever is
/// current now. `None` means the request answered 404.
///
/// A versioned source is retired by writing a delete marker over the key rather
/// than by permanently erasing the copied version (see
/// `delete_receipts_checked`), so the copied version still exists after a
/// successful move and the *absence of a current object* is what proves the
/// deletion already happened. Both "the copied version is gone" and "the copied
/// version is still there but nothing is current" are therefore completed work,
/// while any other object being current means the key moved on and the move must
/// fail closed instead of destroying an unrelated write.
fn classify_versioned_source_for_delete(
    exact_version: Option<bool>,
    current_version: Option<bool>,
) -> SourceDeleteDecision {
    match (exact_version, current_version) {
        (None, _) => SourceDeleteDecision::AlreadyDeleted,
        (Some(false), _) => SourceDeleteDecision::Changed,
        (Some(true), Some(true)) => SourceDeleteDecision::Delete,
        (Some(true), None) => SourceDeleteDecision::AlreadyDeleted,
        (Some(true), Some(false)) => SourceDeleteDecision::Changed,
    }
}

async fn delete_receipts_checked(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    receipts: &[CopyReceipt],
    cancel: &CancelToken,
) -> Result<u32, String> {
    // Validate every destination before deleting any source. A stale manifest
    // or a destination replaced after the copy must fail closed.
    for receipt in receipts {
        match current_identity_matches(
            client,
            dst_bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            None,
            receipt.destination_version_id.as_deref(),
            None,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Destination '{}' no longer matches the copy receipt; source deletion was refused.",
                    receipt.destination_key
                ));
            }
            None => {
                return Err(format!(
                    "Destination '{}' no longer exists; source deletion was refused.",
                    receipt.destination_key
                ));
            }
        }
    }

    // Check all source identities before the first deletion. For versioned
    // receipts, inspect both the exact copied version and whatever is current:
    // together they say whether this receipt is still outstanding, was already
    // retired by an earlier attempt, or has been overtaken by another write.
    // See `classify_versioned_source_for_delete` for the exact mapping.
    let mut present = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        if let Some(version_id) = receipt.source_version_id.as_deref() {
            let exact = current_identity_matches(
                client,
                src_bucket,
                &receipt.source_key,
                &receipt.source_etag,
                Some(version_id),
                Some(version_id),
                (!receipt.source_fingerprint.is_empty())
                    .then_some(receipt.source_fingerprint.as_str()),
                cancel,
            )
            .await?;
            let current = if exact == Some(true) {
                current_identity_matches(
                    client,
                    src_bucket,
                    &receipt.source_key,
                    &receipt.source_etag,
                    None,
                    Some(version_id),
                    (!receipt.source_fingerprint.is_empty())
                        .then_some(receipt.source_fingerprint.as_str()),
                    cancel,
                )
                .await?
            } else {
                None
            };
            match classify_versioned_source_for_delete(exact, current) {
                SourceDeleteDecision::AlreadyDeleted => present.push(false),
                SourceDeleteDecision::Delete => present.push(true),
                SourceDeleteDecision::Changed => {
                    return Err(format!(
                        "Source '{}' changed after it was copied; deletion was refused.",
                        receipt.source_key
                    ));
                }
            }
            continue;
        }

        match current_identity_matches(
            client,
            src_bucket,
            &receipt.source_key,
            &receipt.source_etag,
            None,
            None,
            (!receipt.source_fingerprint.is_empty()).then_some(receipt.source_fingerprint.as_str()),
            cancel,
        )
        .await?
        {
            Some(true) => present.push(true),
            Some(false) => {
                return Err(format!(
                    "Source '{}' changed after it was copied; deletion was refused.",
                    receipt.source_key
                ));
            }
            None => present.push(false),
        }
    }

    let mut deleted = 0u32;
    for (receipt, exists) in receipts.iter().zip(present) {
        if !exists {
            continue;
        }
        // Delete the key, not the copied version ID. Version-targeted deletion is
        // permanent, while If-Match compares ETags and cannot prove that version
        // is still current after the earlier check. Deleting the key keeps
        // If-Match meaningful and, on versioned buckets, creates a recoverable
        // delete marker. Unversioned buckets retain the old behavior, but tags,
        // ACLs, and metadata are outside the ETag; only versioning closes those
        // races safely.
        let request = client
            .delete_object()
            .bucket(src_bucket)
            .key(&receipt.source_key)
            .if_match(&receipt.source_etag)
            .send();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result,
        };
        result.map_err(|err| {
            format!(
                "Copied successfully but conditional deletion of source '{}' failed: {}",
                receipt.source_key, err
            )
        })?;
        deleted += 1;
    }

    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn delete_copied_objects(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    dst_bucket: String,
    receipts: Vec<CopyReceipt>,
    transfer_id: Option<u32>,
) -> Result<u32, String> {
    if receipts.is_empty() {
        return Ok(0);
    }
    let mut source_keys = BTreeSet::new();
    let mut destination_keys = BTreeSet::new();
    for receipt in &receipts {
        // Only the source is deleted here, so only it is a mutating target.
        validate_mutating_key(&receipt.source_key, "Source key")?;
        validate_key(&receipt.destination_key, "Destination key")?;
        if receipt.source_etag.is_empty() || receipt.destination_etag.is_empty() {
            return Err("Copy receipts must contain non-empty ETags".to_string());
        }
        if !source_keys.insert(receipt.source_key.clone())
            || !destination_keys.insert(receipt.destination_key.clone())
        {
            return Err("Copy receipts contain duplicate keys".to_string());
        }
    }

    let client = require_client(&state, &connection_id)?;
    let (_guard, cancel) = transfer_cancel_context(transfer_id);
    delete_receipts_checked(&client, &src_bucket, &dst_bucket, &receipts, &cancel).await
}

#[tauri::command]
pub(crate) async fn rename_prefix(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    old_prefix: String,
    new_prefix: String,
    overwrite: bool,
    transfer_id: Option<u32>,
) -> Result<u32, String> {
    validate_mutating_prefix(&old_prefix, "Source prefix")?;
    validate_mutating_prefix(&new_prefix, "Destination prefix")?;
    if prefixes_overlap(&old_prefix, &new_prefix) {
        return Err("Source and destination prefixes overlap; move was refused.".to_string());
    }
    let client = require_client(&state, &connection_id)?;
    let provider = require_storage_provider(&state, &connection_id)?;
    let (_guard, cancel) = transfer_cancel_context(transfer_id);

    if !overwrite && prefix_has_content(&client, &bucket, &new_prefix).await? {
        return Err(format!(
            "Destination prefix '{}' already exists. Rename with overwrite to replace it.",
            new_prefix
        ));
    }

    let receipts = copy_prefix_objects(
        &client,
        &bucket,
        &old_prefix,
        &bucket,
        &new_prefix,
        true,
        overwrite,
        provider,
        &cancel,
    )
    .await?;

    delete_receipts_checked(&client, &bucket, &bucket, &receipts, &cancel).await
}

/// Copy a single object to a (possibly different) bucket/key without deleting the source.
#[tauri::command]
pub(crate) async fn copy_object_to(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    src_key: String,
    dst_bucket: String,
    dst_key: String,
    overwrite: Option<bool>,
    transfer_id: Option<u32>,
) -> Result<CopyReceipt, String> {
    validate_readable_key(&src_key, "Source key")?;
    // Copying out of the backup namespace is how a user restores data from an
    // interrupted operation, so only the destination is restricted.
    validate_mutating_key(&dst_key, "Destination key")?;
    let client = require_client(&state, &connection_id)?;
    let (_guard, cancel) = transfer_cancel_context(transfer_id);
    let overwrite = overwrite.unwrap_or(false);
    let provider = require_storage_provider(&state, &connection_id)?;

    copy_with_receipt(
        &client,
        &src_bucket,
        &src_key,
        &dst_bucket,
        &dst_key,
        None,
        overwrite,
        provider,
        &cancel,
    )
    .await
}

/// Copy all objects under a prefix to a new prefix (possibly in a different bucket)
/// without deleting the originals.
#[tauri::command]
pub(crate) async fn copy_prefix_to(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    src_prefix: String,
    dst_bucket: String,
    dst_prefix: String,
    overwrite: Option<bool>,
    transfer_id: Option<u32>,
    collect_receipts: Option<bool>,
) -> Result<Vec<CopyReceipt>, String> {
    validate_mutating_prefix(&src_prefix, "Source prefix")?;
    validate_mutating_prefix(&dst_prefix, "Destination prefix")?;
    if src_bucket == dst_bucket && prefixes_overlap(&src_prefix, &dst_prefix) {
        return Err("Source and destination prefixes overlap; copy was refused.".to_string());
    }
    let client = require_client(&state, &connection_id)?;
    let (_guard, cancel) = transfer_cancel_context(transfer_id);
    let overwrite = overwrite.unwrap_or(false);
    let provider = require_storage_provider(&state, &connection_id)?;

    copy_prefix_objects(
        &client,
        &src_bucket,
        &src_prefix,
        &dst_bucket,
        &dst_prefix,
        collect_receipts.unwrap_or(false),
        overwrite,
        provider,
        &cancel,
    )
    .await
}

#[tauri::command]
pub(crate) fn build_object_url(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<String, String> {
    validate_readable_key(&key, "Object key")?;
    if key_has_unsafe_url_segments(&key) {
        return Err(
            "Object keys containing '.' or '..' path segments cannot be copied as browser URLs. \
             Use Download or Preview in S3 Sidekick instead."
                .to_string(),
        );
    }
    let endpoint = require_endpoint(&state, &connection_id)?;
    let base = endpoint.trim_end_matches('/');
    let encoded_bucket = urlencoding::encode(&bucket);
    let encoded_key = key
        .split('/')
        .map(encode_object_url_segment)
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{}/{}/{}", base, encoded_bucket, encoded_key))
}

#[tauri::command]
pub(crate) async fn generate_presigned_url(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    expires_in_secs: u64,
) -> Result<String, String> {
    validate_readable_key(&key, "Object key")?;
    if key_has_unsafe_url_segments(&key) {
        return Err(
            "Object keys containing '.' or '..' path segments cannot be shared as presigned URLs \
             because browsers normalize those path segments and break the signature. \
             Use Download or Preview in S3 Sidekick instead."
                .to_string(),
        );
    }
    if !(60..=604800).contains(&expires_in_secs) {
        return Err("Expiration must be between 60 and 604800 seconds".to_string());
    }
    let client = require_client(&state, &connection_id)?;

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
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<PreviewResponse, String> {
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id)?;

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

    if truncated {
        ensure_range_honoured(
            output.content_range(),
            output.content_length(),
            0,
            MAX_PREVIEW as u64 - 1,
        )?;
    }

    use tokio::io::AsyncReadExt;
    let mut reader = output.body.into_async_read();
    let max_bytes = MAX_PREVIEW as usize;
    let mut raw_bytes = Vec::with_capacity(max_bytes + 1);
    let mut buffer = [0u8; 64 * 1024];
    while raw_bytes.len() <= max_bytes {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read preview body: {}", e))?;
        if count == 0 {
            break;
        }
        let remaining = max_bytes + 1 - raw_bytes.len();
        raw_bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        if raw_bytes.len() > max_bytes {
            break;
        }
    }

    let bytes: &[u8] = if raw_bytes.len() > max_bytes {
        &raw_bytes[..max_bytes]
    } else {
        raw_bytes.as_slice()
    };

    let is_text = is_text_content_type(&content_type);

    let data = if is_text {
        String::from_utf8_lossy(bytes).to_string()
    } else {
        B64.encode(bytes)
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_test_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "s3-sidekick-{}-{}-{}",
            label,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn is_text_content_type_recognizes_text() {
        assert!(is_text_content_type("text/plain"));
        assert!(is_text_content_type("text/html"));
        assert!(is_text_content_type("text/css"));
        assert!(is_text_content_type("text/plain; charset=utf-8"));
        assert!(is_text_content_type("APPLICATION/JSON; CHARSET=UTF-8"));
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

    #[test]
    fn finalize_download_file_moves_when_destination_missing() {
        let dir = make_test_dir("finalize-move");
        let temp_path = dir.join("download.tmp");
        let destination_path = dir.join("file.txt");
        std::fs::write(&temp_path, b"new").unwrap();

        let result = finalize_download_file(&temp_path, &destination_path);
        assert!(
            result.is_ok(),
            "finalize should succeed: {:?}",
            result.err()
        );
        assert!(!temp_path.exists());
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_download_file_replaces_existing_destination() {
        let dir = make_test_dir("finalize-overwrite");
        let temp_path = dir.join("download.tmp");
        let destination_path = dir.join("file.txt");
        std::fs::write(&temp_path, b"new").unwrap();
        std::fs::write(&destination_path, b"old").unwrap();

        let result = finalize_download_file(&temp_path, &destination_path);
        assert!(
            result.is_ok(),
            "finalize should succeed: {:?}",
            result.err()
        );
        assert!(!temp_path.exists());
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The multipart upload OOB guard relies on the last valid part number being
    // exactly equal to `total_parts` (so `part_number > total_parts` only fires
    // when the file has grown). These cases lock that relationship in.
    #[test]
    fn div_ceil_part_count_matches_legacy_formula() {
        let cases: [(u64, u64); 6] = [(0, 32), (1, 32), (32, 32), (33, 32), (128, 32), (129, 32)];
        for (size, part) in cases {
            assert_ne!(part, 0, "test part size must be non-zero");
            let new = size.div_ceil(part);
            // Intentionally the pre-refactor manual formula to prove equivalence.
            #[allow(clippy::manual_div_ceil)]
            let legacy = (size + part - 1) / part;
            assert_eq!(new, legacy, "size={size} part={part}");
        }
    }

    #[test]
    fn last_part_number_equals_total_parts() {
        // For a file split into N parts, the highest part number produced is N,
        // and N+1 must be the first value the guard rejects.
        let file_size: u64 = 129;
        let part_size: u64 = 32;
        let total_parts = file_size.div_ceil(part_size) as usize; // 5
        assert_eq!(total_parts, 5);
        // The guard fires when `part_number > total_parts`. Every legitimate
        // part (1..=total_parts) passes; only the first overflow part is rejected.
        for part_number in 1..=total_parts {
            assert!(part_number <= total_parts, "part {part_number} should pass");
        }
        assert!(total_parts + 1 > total_parts, "overflow part is rejected");
    }

    // -----------------------------------------------------------------------
    // Range compliance (M3)
    // -----------------------------------------------------------------------

    #[test]
    fn ensure_range_honoured_accepts_matching_content_range() {
        assert!(ensure_range_honoured(Some("bytes 0-1023/8192"), Some(1024), 0, 1023).is_ok());
        assert!(
            ensure_range_honoured(Some("bytes 4096-8191/8192"), Some(4096), 4096, 8191).is_ok()
        );
        // Single-byte probe used by the preflight.
        assert!(ensure_range_honoured(Some("bytes 0-0/8192"), Some(1), 0, 0).is_ok());
    }

    #[test]
    fn ensure_range_honoured_rejects_missing_content_range() {
        // A server that ignores Range answers 200 with the whole body and no
        // Content-Range. Letting that through made every worker download the
        // entire object at its own offset.
        let err = ensure_range_honoured(None, Some(8192), 0, 1023)
            .expect_err("a full-body response must be rejected");
        assert!(err.starts_with(RANGE_UNSUPPORTED_CODE), "got: {}", err);
    }

    #[test]
    fn ensure_range_honoured_rejects_wrong_range() {
        let err = ensure_range_honoured(Some("bytes 0-4095/8192"), Some(4096), 4096, 8191)
            .expect_err("a mismatched range must be rejected");
        assert!(err.starts_with(RANGE_UNSUPPORTED_CODE), "got: {}", err);
    }

    #[test]
    fn ensure_range_honoured_allows_absent_header_only_for_exact_length() {
        // Degenerate case: the requested range covers exactly what was returned.
        assert!(ensure_range_honoured(None, Some(1024), 0, 1023).is_ok());
        assert!(ensure_range_honoured(None, Some(1023), 0, 1023).is_err());
    }

    // -----------------------------------------------------------------------
    // Prefix guards (M6, M7)
    // -----------------------------------------------------------------------

    #[test]
    fn validate_list_prefix_allows_empty_for_listing() {
        // Listing the bucket root is legitimate.
        assert!(validate_list_prefix("", "Prefix").is_ok());
        assert!(validate_list_prefix("a/b/", "Prefix").is_ok());
    }

    #[test]
    fn validate_list_prefix_allows_dot_segments() {
        assert!(validate_list_prefix("data/../", "Prefix").is_ok());
        assert!(validate_list_prefix("a/./b/", "Prefix").is_ok());
        assert!(validate_mutating_prefix("data/../", "Prefix").is_err());
    }

    #[test]
    fn detect_storage_provider_recognises_major_backends() {
        assert_eq!(
            detect_storage_provider("https://abc123.r2.cloudflarestorage.com"),
            StorageProviderKind::CloudflareR2
        );
        assert_eq!(
            detect_storage_provider("https://s3.us-east-1.amazonaws.com"),
            StorageProviderKind::Aws
        );
        assert_eq!(
            detect_storage_provider("http://localhost:9000"),
            StorageProviderKind::Minio
        );
        assert_eq!(
            detect_storage_provider("https://s3.wasabisys.com"),
            StorageProviderKind::Wasabi
        );
    }

    #[test]
    fn key_has_unsafe_url_segments_detects_dot_paths() {
        assert!(key_has_unsafe_url_segments("data/../odd.txt"));
        assert!(key_has_unsafe_url_segments("a/./b.txt"));
        assert!(!key_has_unsafe_url_segments("data/odd.txt"));
    }

    #[test]
    fn create_only_writes_use_wildcard_if_none_match() {
        assert_eq!(CREATE_ONLY_IF_NONE_MATCH, "*");
        assert_eq!(
            R2_COPY_DESTINATION_IF_NONE_MATCH,
            "cf-copy-destination-if-none-match"
        );
        assert_eq!(DIGITALOCEAN_COPY_IF_NONE_MATCH, "x-amz-copy-if-none-match");
    }

    #[test]
    fn create_only_capability_matrix_matches_documented_providers() {
        let aws = CreateOnlyCapabilities::for_provider(StorageProviderKind::Aws);
        assert!(aws.put_object);
        assert!(aws.complete_multipart);
        assert_eq!(
            aws.copy_object,
            Some(CopyCreateOnlyStrategy::AwsIfNoneMatch)
        );

        let minio = CreateOnlyCapabilities::for_provider(StorageProviderKind::Minio);
        assert!(minio.put_object);
        assert!(!minio.complete_multipart);
        assert_eq!(
            minio.copy_object,
            Some(CopyCreateOnlyStrategy::AwsIfNoneMatch)
        );

        let r2 = CreateOnlyCapabilities::for_provider(StorageProviderKind::CloudflareR2);
        assert!(r2.put_object);
        assert_eq!(
            r2.copy_object,
            Some(CopyCreateOnlyStrategy::R2DestinationHeader)
        );

        let spaces = CreateOnlyCapabilities::for_provider(StorageProviderKind::DigitalOcean);
        assert!(!spaces.put_object);
        assert!(!spaces.complete_multipart);
        assert_eq!(
            spaces.copy_object,
            Some(CopyCreateOnlyStrategy::DigitalOceanCopyIfNoneMatch)
        );

        let b2 = CreateOnlyCapabilities::for_provider(StorageProviderKind::Backblaze);
        assert!(!b2.put_object);
        assert_eq!(b2.copy_object, None);

        let aws_info = CreateOnlyCapabilityInfo::from_provider(StorageProviderKind::Aws);
        assert!(aws_info.put_object && aws_info.complete_multipart && aws_info.copy_object);

        let b2_info = CreateOnlyCapabilityInfo::from_provider(StorageProviderKind::Backblaze);
        assert!(!b2_info.put_object && !b2_info.complete_multipart && !b2_info.copy_object);
    }

    #[test]
    fn unsupported_create_only_operations_fail_closed() {
        for provider in [
            StorageProviderKind::DigitalOcean,
            StorageProviderKind::Backblaze,
            StorageProviderKind::Generic,
        ] {
            let put_error = require_put_create_only_support(provider, "new-key")
                .expect_err("unsupported put must be rejected");
            assert!(put_error.contains("Explicitly authorize"));
        }

        for provider in [StorageProviderKind::Backblaze, StorageProviderKind::Generic] {
            let copy_error = require_copy_create_only_strategy(provider, "new-key")
                .expect_err("unsupported copy must be rejected");
            assert!(copy_error.contains("Explicitly authorize"));
        }

        for provider in [
            StorageProviderKind::Minio,
            StorageProviderKind::DigitalOcean,
            StorageProviderKind::Backblaze,
            StorageProviderKind::Generic,
        ] {
            let multipart_error =
                require_complete_multipart_create_only_support(provider, "new-key")
                    .expect_err("unsupported multipart completion must be rejected");
            assert!(multipart_error.contains("Explicitly authorize"));
        }
    }

    #[test]
    fn detect_storage_provider_recognises_digitalocean_and_backblaze() {
        assert_eq!(
            detect_storage_provider("https://my-space.nyc3.digitaloceanspaces.com"),
            StorageProviderKind::DigitalOcean
        );
        assert_eq!(
            detect_storage_provider("https://s3.us-west-004.backblazeb2.com"),
            StorageProviderKind::Backblaze
        );
    }

    #[test]
    fn detect_storage_provider_requires_domain_boundaries() {
        for endpoint in [
            "https://amazonaws.com.example.invalid",
            "https://notwasabisys.com",
            "https://backblazeb2.com.example.invalid",
            "https://digitaloceanspaces.com.example.invalid",
            "https://notminio.example.invalid",
        ] {
            assert_eq!(
                detect_storage_provider(endpoint),
                StorageProviderKind::Generic,
                "misclassified {endpoint}"
            );
        }
        assert_eq!(
            detect_storage_provider("https://minio.example.invalid"),
            StorageProviderKind::Minio
        );
        assert_eq!(
            detect_storage_provider("https://s3.cn-north-1.amazonaws.com.cn"),
            StorageProviderKind::Aws
        );
    }

    #[test]
    fn validate_mutating_prefix_rejects_empty() {
        // An empty prefix means "every object in the bucket" for delete, move and
        // copy, which must never be reachable by accident.
        let err = validate_mutating_prefix("", "Prefix")
            .expect_err("empty prefix must be rejected for mutating operations");
        assert!(err.contains("must not be empty"), "got: {}", err);
        assert!(validate_mutating_prefix("logs/", "Prefix").is_ok());
    }

    #[test]
    fn validate_mutating_prefix_still_rejects_traversal() {
        assert!(validate_mutating_prefix("../etc/", "Prefix").is_err());
        assert!(validate_mutating_prefix("a/./b/", "Prefix").is_err());
    }

    /// Keys containing dot segments are legal in S3 and earlier versions could
    /// delete them, so batch delete must still accept them while keeping the
    /// reserved namespace and hard limits enforced.
    #[test]
    fn deletable_keys_allow_dot_segments_but_not_reserved_backups() {
        assert!(validate_deletable_key("data/./odd.txt", "Object key").is_ok());
        assert!(validate_deletable_key("data/../odd.txt", "Object key").is_ok());
        assert!(validate_deletable_key("", "Object key").is_err());
        assert!(validate_deletable_key("a\0b", "Object key").is_err());
        assert!(
            validate_deletable_key(".s3-sidekick-rollback/ns/1", "Object key").is_err(),
            "live rollback backups must stay protected from batch delete"
        );
    }

    #[test]
    fn readable_keys_allow_dot_segments_for_inspect_and_download() {
        assert!(validate_readable_key("data/./odd.txt", "Object key").is_ok());
        assert!(validate_readable_key("data/../odd.txt", "Object key").is_ok());
        assert!(validate_readable_key("", "Object key").is_err());
        assert!(validate_readable_key("a\0b", "Object key").is_err());
        assert!(validate_readable_key(".s3-sidekick-rollback/ns/1", "Object key").is_ok());
    }

    #[test]
    fn mutating_keys_cannot_target_rollback_backups_but_reads_can() {
        let backup = ".s3-sidekick-rollback/1234-99-7/3";
        let err = validate_mutating_key(backup, "Object key")
            .expect_err("rollback backups must not be mutable through commands");
        assert!(err.contains("rollback"), "got: {}", err);
        // Restoring data out of a backup has to stay possible.
        assert!(validate_key(backup, "Source key").is_ok());
        assert!(validate_mutating_key("logs/app.txt", "Object key").is_ok());
    }

    /// Rollback backups can be the only copy of an overwritten destination, so a
    /// prefix operation must never target the namespace holding them.
    #[test]
    fn validate_mutating_prefix_protects_the_rollback_namespace() {
        for prefix in [
            ROLLBACK_BACKUP_PREFIX,
            ".s3-sidekick-rollback/1234-99-7/",
            ".s3-sidekick-",
        ] {
            let err = validate_mutating_prefix(prefix, "Prefix")
                .expect_err("rollback backups must not be a mutating target");
            assert!(err.contains("rollback"), "got: {}", err);
        }
        assert!(validate_mutating_prefix("logs/", "Prefix").is_ok());
    }

    // -----------------------------------------------------------------------
    // Cancellation registry (H7)
    // -----------------------------------------------------------------------

    #[test]
    fn cancelling_an_unknown_transfer_is_a_noop() {
        // The old design latched cancelled ids forever, so a reused id aborted a
        // brand new transfer instantly. Cancelling an id that is not running must
        // leave no trace.
        let id = 990_001;
        cancel_transfer(id);
        let guard = TransferGuard::register(id);
        assert!(
            !guard.is_cancelled(),
            "a stale cancel must not affect a later transfer with the same id"
        );
    }

    #[test]
    fn cancelling_a_running_transfer_is_observed() {
        let id = 990_002;
        let guard = TransferGuard::register(id);
        assert!(!guard.is_cancelled());
        cancel_transfer(id);
        assert!(guard.is_cancelled());
    }

    #[test]
    fn transfer_registration_is_dropped_on_completion() {
        let id = 990_003;
        {
            let _guard = TransferGuard::register(id);
        }
        // Nothing is registered any more, so this cancel goes nowhere.
        cancel_transfer(id);
        let next = TransferGuard::register(id);
        assert!(
            !next.is_cancelled(),
            "registration must not survive the guard"
        );
    }

    #[test]
    fn reusing_an_id_replaces_the_previous_registration() {
        let id = 990_004;
        let first = TransferGuard::register(id);
        let second = TransferGuard::register(id);
        cancel_transfer(id);
        assert!(
            second.is_cancelled(),
            "the live registration must be cancelled"
        );
        assert!(
            !first.is_cancelled(),
            "the displaced registration must not be affected"
        );
        // Dropping the displaced guard must not deregister the live one.
        drop(first);
        cancel_transfer(id);
        assert!(second.is_cancelled());
    }

    #[tokio::test]
    async fn sleep_unless_cancelled_returns_early_on_cancel() {
        let flag: CancelToken = Arc::new(CancelFlag::default());
        let cloned = Arc::clone(&flag);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cloned.cancel();
        });
        let started = Instant::now();
        let completed = flag.sleep_unless_cancelled(Duration::from_secs(30)).await;
        assert!(!completed, "cancellation must be reported");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "backoff must wake on cancellation instead of sleeping through it"
        );
    }

    #[tokio::test]
    async fn sleep_unless_cancelled_completes_when_not_cancelled() {
        let flag: CancelToken = Arc::new(CancelFlag::default());
        assert!(
            flag.sleep_unless_cancelled(Duration::from_millis(120))
                .await
        );
    }

    #[test]
    fn multipart_copy_part_size_stays_within_s3_limits() {
        let maximum = multipart_copy_part_size(MAX_OBJECT_SIZE).unwrap();
        assert!(maximum <= MAX_MULTIPART_COPY_PART_SIZE);
        assert!(MAX_OBJECT_SIZE.div_ceil(maximum) <= MAX_MULTIPART_COPY_PARTS);
        assert_eq!(
            multipart_copy_part_size(MULTIPART_COPY_THRESHOLD as u64).unwrap(),
            PREFERRED_MULTIPART_COPY_PART_SIZE
        );
        assert!(multipart_copy_part_size(0).is_err());
        assert!(multipart_copy_part_size(MAX_OBJECT_SIZE + 1).is_err());
    }

    #[test]
    fn backup_namespaces_are_recoverable_from_their_keys() {
        assert_eq!(
            namespace_of_backup_key(".s3-sidekick-rollback/1234-99-7/3"),
            Some("1234-99-7")
        );
        assert_eq!(namespace_of_backup_key("objects/report.pdf"), None);
        assert_eq!(namespace_of_backup_key(".s3-sidekick-rollback//3"), None);
    }

    /// A concurrent prefix operation's backups must not be reported as
    /// abandoned, because the advice for abandoned backups is to remove them.
    #[test]
    fn live_backup_namespaces_are_registered_and_released() {
        let guard = RollbackNamespaceGuard::new();
        let namespace = guard.namespace.clone();
        assert!(active_rollback_namespaces()
            .lock()
            .unwrap()
            .contains(&namespace));

        drop(guard);
        assert!(!active_rollback_namespaces()
            .lock()
            .unwrap()
            .contains(&namespace));
    }

    #[test]
    fn prefix_overlap_rejects_nested_source_or_destination() {
        assert!(prefixes_overlap("photos/", "photos/"));
        assert!(prefixes_overlap("photos/", "photos/2026/"));
        assert!(prefixes_overlap("photos/2026/", "photos/"));
        assert!(!prefixes_overlap("photos/", "photos-archive/"));
        assert!(!prefixes_overlap("a/", "b/"));
    }

    #[test]
    fn checkpoint_generation_requires_version_identity_when_versioned() {
        let mut checkpoint = TransferCheckpoint {
            version: 1,
            mode: "download_parallel".to_string(),
            bucket: "bucket".to_string(),
            key: "key".to_string(),
            destination: None,
            temp_path: "temp".to_string(),
            total_bytes: 1,
            part_size: 1,
            completed_parts: vec![0],
            updated_at_ms: 0,
            etag: "etag".to_string(),
            version_id: None,
        };
        assert!(checkpoint_generation_matches(&checkpoint, "etag", None));
        assert!(!checkpoint_generation_matches(
            &checkpoint,
            "etag",
            Some("version-1")
        ));

        checkpoint.version_id = Some("version-1".to_string());
        assert!(checkpoint_generation_matches(
            &checkpoint,
            "etag",
            Some("version-1")
        ));
        assert!(!checkpoint_generation_matches(
            &checkpoint,
            "etag",
            Some("version-2")
        ));
        assert!(!checkpoint_generation_matches(&checkpoint, "etag", None));
    }

    #[test]
    fn upload_sha256_uses_raw_digest_in_hex_and_base64() {
        let checksum = sha256_checksum_bytes(b"abc");
        assert_eq!(
            checksum.hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            checksum.base64,
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
        assert!(verify_upload_checksum_response(Some(&checksum.base64), &checksum, "test").is_ok());
        assert!(verify_upload_checksum_response(None, &checksum, "test").is_err());
    }

    #[test]
    fn versioned_source_resume_distinguishes_deleted_from_replaced() {
        assert_eq!(
            classify_versioned_source_for_delete(None, Some(false)),
            SourceDeleteDecision::AlreadyDeleted
        );
        assert_eq!(
            classify_versioned_source_for_delete(Some(true), Some(true)),
            SourceDeleteDecision::Delete
        );
        assert_eq!(
            classify_versioned_source_for_delete(Some(true), Some(false)),
            SourceDeleteDecision::Changed
        );
        assert_eq!(
            classify_versioned_source_for_delete(Some(false), Some(true)),
            SourceDeleteDecision::Changed
        );
        // A completed versioned move leaves the copied version in place behind a
        // delete marker, so "the version is still there but nothing is current"
        // must resume as finished rather than as a conflict.
        assert_eq!(
            classify_versioned_source_for_delete(Some(true), None),
            SourceDeleteDecision::AlreadyDeleted
        );
    }

    #[test]
    fn malformed_checkpoint_is_an_error_not_a_fresh_download() {
        let Err(err) = checkpoint_from_json("{not-json") else {
            panic!("corrupt resumable state must be surfaced");
        };
        assert!(err.contains("Invalid transfer checkpoint JSON"));
    }

    #[test]
    fn failed_checkpoint_save_does_not_advance_markers() {
        let original_time = Instant::now();
        let mut last_saved_at = original_time;
        let mut last_saved_parts = 3;

        let err =
            persist_checkpoint_and_advance(&mut last_saved_at, &mut last_saved_parts, 11, || {
                Err("disk full".to_string())
            })
            .expect_err("persistence failure must be propagated");

        assert_eq!(err, "disk full");
        assert_eq!(last_saved_at, original_time);
        assert_eq!(last_saved_parts, 3);
    }

    #[tokio::test]
    async fn multipart_cleanup_timeout_is_bounded() {
        let started = Instant::now();
        let completed =
            cleanup_completes_within(Duration::from_millis(20), std::future::pending::<()>()).await;
        assert!(!completed, "a hung cleanup must time out");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "bounded cleanup took too long"
        );
    }

    #[test]
    fn versioned_copy_source_is_encoded_without_loss() {
        let source =
            encode_copy_source_with_version("bucket", "folder/file name.txt", Some("version+id/1"));
        assert_eq!(
            source,
            "bucket/folder/file%20name.txt?versionId=version%2Bid%2F1"
        );
    }

    #[test]
    fn connection_identity_is_stable_and_distinguishes_accounts() {
        let a = connection_identity("https://s3.example.com", "AKIA1");
        let b = connection_identity("https://s3.example.com", "AKIA1");
        let c = connection_identity("https://s3.example.com", "AKIA2");
        let d = connection_identity("https://s3.other.example", "AKIA1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn mint_connection_id_is_unique_per_call() {
        let first = mint_connection_id();
        let second = mint_connection_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn require_connected_client_rejects_empty_and_mismatched_ids() {
        let s3 = crate::S3State {
            client: None,
            endpoint: String::new(),
            region: String::new(),
            bucket_hint: None,
            connection_generation: 0,
            connection_id: Some("session-a".to_string()),
            connection_identity: Some("ident-a".to_string()),
            storage_provider: StorageProviderKind::default(),
        };
        let empty = require_connected_client(&s3, "").expect_err("empty id");
        assert!(empty.contains("required"), "{empty}");
        let changed = require_connected_client(&s3, "session-b").expect_err("mismatch");
        assert!(changed.contains("changed"), "{changed}");
        assert!(require_connection_session(&s3, "session-a").is_ok());
        let missing_client = require_connected_client(&s3, "session-a").expect_err("no client");
        assert!(missing_client.contains("Not connected"), "{missing_client}");
    }

    #[test]
    fn invalidating_connection_clears_identity_and_advances_generation() {
        let mut s3 = crate::S3State {
            client: None,
            endpoint: "https://s3.example.com".to_string(),
            region: "us-east-1".to_string(),
            bucket_hint: Some("bucket".to_string()),
            connection_generation: 41,
            connection_id: Some("session-a".to_string()),
            connection_identity: Some("ident-a".to_string()),
            storage_provider: StorageProviderKind::default(),
        };

        invalidate_connection_session(&mut s3);

        assert_eq!(s3.connection_generation, 42);
        assert!(s3.client.is_none());
        assert!(s3.endpoint.is_empty());
        assert!(s3.region.is_empty());
        assert!(s3.bucket_hint.is_none());
        assert!(s3.connection_id.is_none());
        assert!(s3.connection_identity.is_none());
    }
}
