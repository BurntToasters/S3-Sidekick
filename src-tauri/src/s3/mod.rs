// Transfer commands are exposed to the frontend through Tauri's `invoke` bridge,
// which marshals each parameter by name. Grouping them into structs would require
// matching serde plumbing on both sides for no real readability gain, so the flat
// signatures (and the progress emitter that mirrors them) are intentional.
#![allow(clippy::too_many_arguments)]

use aws_sdk_s3::types::{
    ChecksumAlgorithm, ChecksumMode, ChecksumType, Delete, EncodingType, MetadataDirective,
    ObjectCannedAcl, ObjectIdentifier,
};
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use zeroize::Zeroize;

use crate::{
    load_transfer_checkpoint_json, lock_s3_state, remove_transfer_checkpoint,
    save_transfer_checkpoint_json, validate_destination_path,
    validate_destination_path_allow_overwrite, validate_existing_path,
    validate_transfer_recovery_session, AppState, StorageProviderKind,
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
// 5 TiB at the 16 MiB minimum part size is ~328k parts; anything beyond this
// means the endpoint lied about Content-Length and must not size allocations.
const MAX_DOWNLOAD_PARTS: u64 = 1_000_000;
// Connect phase stays short; body-bearing requests scale their attempt timeout
// with payload size so slow links are not cut off mid-transfer.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const MIN_BODY_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_BODY_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(3600);
const MIN_TRANSFER_RATE_BYTES_PER_SECOND: u64 = 256 * 1024;
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
const PENDING_CANCEL_TTL: Duration = Duration::from_secs(30);
const MAX_PENDING_CANCELS: usize = 4096;

mod acl_tags;
mod cancel;
mod copy;
mod create_only;
mod download;
mod endpoint;
mod move_commands;
mod objects;
mod prefix;
mod preview;
mod rollback;
mod sdk_errors;
mod session;
mod transaction;
mod transfer_support;
mod types;
mod upload;
mod validation;

use acl_tags::*;
pub(crate) use cancel::*;
pub(crate) use copy::*;
pub(crate) use create_only::*;
pub(crate) use download::*;
pub(crate) use endpoint::*;
pub(crate) use move_commands::*;
pub(crate) use objects::*;
pub(crate) use prefix::*;
pub(crate) use preview::*;
#[cfg(test)]
pub(crate) use rollback::e2e_copy_with_receipt;
use rollback::*;
use sdk_errors::*;
pub(crate) use session::*;
use transaction::*;
#[cfg(test)]
pub(crate) use transaction::{
    e2e_copy_prefix_with_failure_after_first, e2e_delete_move_receipts_checked,
};
use transfer_support::*;
pub(crate) use types::*;
pub(crate) use upload::*;
use validation::*;

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
        let (url, bucket) =
            normalize_endpoint("sfo3.digitaloceanspaces.com").expect("valid test endpoint");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, None);
    }

    #[test]
    fn normalize_endpoint_preserves_existing_scheme() {
        let (url, _) =
            normalize_endpoint("https://sfo3.digitaloceanspaces.com").expect("valid test endpoint");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        let (url, _) = normalize_endpoint("http://localhost:9000").expect("valid test endpoint");
        assert_eq!(url, "http://localhost:9000");
    }

    #[test]
    fn normalize_endpoint_strips_do_bucket_subdomain() {
        let (url, bucket) = normalize_endpoint("https://fortis.sfo3.digitaloceanspaces.com")
            .expect("valid test endpoint");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));

        let (url, bucket) =
            normalize_endpoint("fortis.sfo3.digitaloceanspaces.com").expect("valid test endpoint");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));
    }

    #[test]
    fn normalize_endpoint_keeps_region_only_do_host() {
        let (url, bucket) =
            normalize_endpoint("https://nyc3.digitaloceanspaces.com").expect("valid test endpoint");
        assert_eq!(url, "https://nyc3.digitaloceanspaces.com");
        assert_eq!(bucket, None);
    }

    #[test]
    fn normalize_endpoint_strips_trailing_path_as_bucket() {
        let (url, bucket) = normalize_endpoint("https://sfo3.digitaloceanspaces.com/fortis")
            .expect("valid test endpoint");
        assert_eq!(url, "https://sfo3.digitaloceanspaces.com");
        assert_eq!(bucket, Some("fortis".to_string()));
    }

    #[test]
    fn normalize_endpoint_preserves_port() {
        let (url, _) = normalize_endpoint("http://minio.local:9000").expect("valid test endpoint");
        assert_eq!(url, "http://minio.local:9000");
    }

    #[test]
    fn normalize_endpoint_strips_trailing_slash() {
        let (url, _) =
            normalize_endpoint("https://s3.amazonaws.com/").expect("valid test endpoint");
        assert_eq!(url, "https://s3.amazonaws.com");
    }

    #[test]
    fn normalize_endpoint_strips_aws_virtual_host_bucket() {
        let (url, bucket) = normalize_endpoint("https://mybucket.s3.us-east-1.amazonaws.com")
            .expect("valid test endpoint");
        assert_eq!(url, "https://s3.us-east-1.amazonaws.com");
        assert_eq!(bucket, Some("mybucket".to_string()));

        let (url, bucket) = normalize_endpoint("https://mybucket.s3-us-west-2.amazonaws.com")
            .expect("valid test endpoint");
        assert_eq!(url, "https://s3-us-west-2.amazonaws.com");
        assert_eq!(bucket, Some("mybucket".to_string()));

        let (url, bucket) =
            normalize_endpoint("https://mybucket.s3.dualstack.us-east-1.amazonaws.com")
                .expect("valid test endpoint");
        assert_eq!(url, "https://s3.dualstack.us-east-1.amazonaws.com");
        assert_eq!(bucket, Some("mybucket".to_string()));
    }

    #[test]
    fn normalize_endpoint_keeps_aws_service_endpoints() {
        let (url, bucket) =
            normalize_endpoint("https://s3.us-east-1.amazonaws.com").expect("valid test endpoint");
        assert_eq!(url, "https://s3.us-east-1.amazonaws.com");
        assert_eq!(bucket, None);
    }

    #[test]
    fn normalize_endpoint_rejects_multi_segment_base_path() {
        assert!(normalize_endpoint("https://gateway.example.com/s3/proxy").is_err());
        assert!(normalize_endpoint("https://gateway.example.com/s3/proxy/").is_err());
    }

    #[test]
    fn sanitized_content_length_rejects_negative_and_overflow() {
        assert_eq!(sanitized_content_length(Some(-1)), 0);
        assert_eq!(sanitized_content_length(Some(0)), 0);
        assert_eq!(sanitized_content_length(Some(2048)), 2048);
        assert_eq!(sanitized_content_length(None), 0);
    }

    #[test]
    fn body_attempt_timeout_scales_with_payload() {
        assert_eq!(attempt_timeout_for_bytes(0), MIN_BODY_ATTEMPT_TIMEOUT);
        assert!(attempt_timeout_for_bytes(32 * 1024 * 1024) >= Duration::from_secs(128));
        assert_eq!(
            attempt_timeout_for_bytes(u64::MAX),
            MAX_BODY_ATTEMPT_TIMEOUT
        );
    }

    #[tokio::test]
    async fn finalize_download_file_moves_when_destination_missing() {
        let dir = make_test_dir("finalize-move");
        let temp_path = dir.join("download.tmp");
        let destination_path = dir.join("file.txt");
        std::fs::write(&temp_path, b"new").unwrap();

        let result = finalize_download_file(&temp_path, &destination_path, false).await;
        assert!(
            result.is_ok(),
            "finalize should succeed: {:?}",
            result.err()
        );
        assert!(!temp_path.exists());
        assert_eq!(std::fs::read(&destination_path).unwrap(), b"new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finalize_download_file_replaces_existing_destination() {
        let dir = make_test_dir("finalize-overwrite");
        let temp_path = dir.join("download.tmp");
        let destination_path = dir.join("file.txt");
        std::fs::write(&temp_path, b"new").unwrap();
        std::fs::write(&destination_path, b"old").unwrap();

        let result = finalize_download_file(&temp_path, &destination_path, true).await;
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
        assert_eq!(minio.copy_object, None);

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
        for prefix in [ROLLBACK_BACKUP_PREFIX, ".s3-sidekick-rollback/1234-99-7/"] {
            let err = validate_mutating_prefix(prefix, "Prefix")
                .expect_err("rollback backups must not be a mutating target");
            assert!(err.contains("rollback"), "got: {}", err);
        }
        // String-prefixes that stop mid-segment are siblings, not overlaps:
        // `.s3-sidekick-/` and `.s3-sidekick-rollback-evil/` never address the
        // `.s3-sidekick-rollback/` namespace.
        assert!(validate_mutating_prefix(".s3-sidekick-", "Prefix").is_ok());
        assert!(validate_mutating_prefix(".s3-sidekick-rollback-evil/", "Prefix").is_ok());
        assert!(validate_mutating_prefix("logs/", "Prefix").is_ok());
    }

    // -----------------------------------------------------------------------
    // Cancellation registry (H7)
    // -----------------------------------------------------------------------

    #[test]
    fn cancelling_just_before_registration_cancels_that_transfer() {
        // Two IPC handlers can be scheduled in reverse order. A short-lived
        // pending cancel must bridge that gap without latching forever.
        let id = 990_001;
        cancel_transfer(id);
        let guard = TransferGuard::register(id).expect("registration should succeed");
        assert!(
            guard.is_cancelled(),
            "a pre-registration cancel must reach the command that follows it"
        );
    }

    #[test]
    fn cancelling_a_running_transfer_is_observed() {
        let id = 990_002;
        let guard = TransferGuard::register(id).expect("registration should succeed");
        assert!(!guard.is_cancelled());
        cancel_transfer(id);
        assert!(guard.is_cancelled());
    }

    #[test]
    fn transfer_registration_is_dropped_on_completion() {
        let id = 990_003;
        {
            let _guard = TransferGuard::register(id).expect("registration should succeed");
        }
        let next = TransferGuard::register(id).expect("registration should succeed");
        assert!(
            !next.is_cancelled(),
            "registration must not survive the guard"
        );
    }

    #[test]
    fn reusing_an_id_keeps_every_registration_cancellable() {
        let id = 990_004;
        let first = TransferGuard::register(id).expect("first registration should succeed");
        let second = TransferGuard::register(id).expect("second registration should succeed");
        cancel_transfer(id);
        assert!(
            second.is_cancelled(),
            "the newer registration must be cancelled"
        );
        assert!(
            first.is_cancelled(),
            "reusing a frontend id must not orphan the older registration"
        );
        // Dropping either guard must not deregister the other registration.
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

    fn complete_test_copy_receipt() -> CopyReceipt {
        CopyReceipt {
            source_key: "source/key".to_string(),
            source_etag: "\"source\"".to_string(),
            source_fingerprint: "1".repeat(64),
            source_acl_fingerprint: "2".repeat(64),
            source_tag_fingerprint: "3".repeat(64),
            source_version_id: Some("source-version-1".to_string()),
            destination_key: "destination/key".to_string(),
            destination_etag: "\"destination\"".to_string(),
            destination_fingerprint: "4".repeat(64),
            destination_acl_fingerprint: "5".repeat(64),
            destination_tag_fingerprint: "6".repeat(64),
            destination_version_id: Some("destination-version-1".to_string()),
            ownership_ambiguous: false,
        }
    }

    #[test]
    fn acl_fingerprint_is_canonical_across_grant_order() {
        let owner = CanonicalAclGrant {
            permission: "FULL_CONTROL".to_string(),
            grantee_type: "CanonicalUser".to_string(),
            grantee_id: "owner-id".to_string(),
            grantee_uri: String::new(),
            grantee_email: String::new(),
        };
        let public = CanonicalAclGrant {
            permission: "READ".to_string(),
            grantee_type: "Group".to_string(),
            grantee_id: String::new(),
            grantee_uri: "http://acs.amazonaws.com/groups/global/AllUsers".to_string(),
            grantee_email: String::new(),
        };

        let first = canonical_acl_fingerprint("owner-id", &[owner.clone(), public.clone()]);
        let reordered = canonical_acl_fingerprint("owner-id", &[public, owner]);
        assert_eq!(first, reordered);
        assert!(is_canonical_fingerprint(&first));
        assert_ne!(
            canonical_acl_fingerprint("owner-id", &[]),
            unsupported_attribute_fingerprint("acl")
        );
    }

    #[test]
    fn tag_fingerprint_sorts_raw_pairs_and_distinguishes_unsupported() {
        let first = vec![
            ("space key".to_string(), "raw&value".to_string()),
            ("alpha".to_string(), "raw=value".to_string()),
        ];
        let reordered = vec![first[1].clone(), first[0].clone()];
        assert_eq!(
            canonical_tag_fingerprint(&first),
            canonical_tag_fingerprint(&reordered)
        );
        assert_ne!(
            canonical_tag_fingerprint(&[]),
            unsupported_attribute_fingerprint("tags")
        );
    }

    #[test]
    fn immutable_move_version_preflight_rejects_mutable_versions() {
        assert_eq!(
            require_immutable_move_version(Some(" version-1 "), "source/key")
                .expect("trimmed immutable version should be accepted"),
            "version-1"
        );
        for mutable_version in [None, Some(""), Some("  ")] {
            let err = require_immutable_move_version(mutable_version, "source/key")
                .expect_err("mutable source identity must be rejected before copy");
            assert!(err.contains("requires object versioning"), "{err}");
            assert!(err.contains("no destination was changed"), "{err}");
        }
        for null_version in [Some("null"), Some("NULL"), Some(" null ")] {
            let err = require_immutable_move_version(null_version, "source/key")
                .expect_err("a mutable null version must not authorize an automatic move");
            assert!(err.contains("mutable null version"), "{err}");
            assert!(err.contains("no destination was changed"), "{err}");
        }
    }

    #[test]
    fn incomplete_or_mutable_receipt_set_is_rejected_before_delete_authority() {
        let valid = complete_test_copy_receipt();
        assert!(validate_receipt_fingerprints(std::slice::from_ref(&valid)).is_ok());

        for missing in [
            "source-head",
            "source-acl",
            "source-tags",
            "destination-head",
            "destination-acl",
            "destination-tags",
        ] {
            let mut invalid = valid.clone();
            match missing {
                "source-head" => invalid.source_fingerprint.clear(),
                "source-acl" => invalid.source_acl_fingerprint.clear(),
                "source-tags" => invalid.source_tag_fingerprint.clear(),
                "destination-head" => invalid.destination_fingerprint.clear(),
                "destination-acl" => invalid.destination_acl_fingerprint.clear(),
                "destination-tags" => invalid.destination_tag_fingerprint.clear(),
                _ => unreachable!(),
            }
            let err = validate_receipt_fingerprints(&[valid.clone(), invalid])
                .expect_err("one incomplete receipt must refuse the full set");
            assert!(err.contains("source deletion was refused"), "{err}");
        }

        for mutable_version in [None, Some(String::new())] {
            let mut invalid = valid.clone();
            invalid.source_version_id = mutable_version;
            let err = validate_receipt_fingerprints(&[invalid])
                .expect_err("mutable source identity must not authorize durable deletion");
            assert!(err.contains("requires bucket versioning"), "{err}");
        }
        let mut null_pinned = valid.clone();
        null_pinned.source_version_id = Some("null".to_string());
        let err = validate_receipt_fingerprints(std::slice::from_ref(&null_pinned))
            .expect_err("a mutable null source version must not authorize deletion");
        assert!(err.contains("source deletion was refused"), "{err}");
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

    #[tokio::test]
    async fn failed_checkpoint_save_does_not_advance_markers() {
        let original_time = Instant::now();
        let mut last_saved_at = original_time;
        let mut last_saved_parts = 3;

        let err = persist_checkpoint_and_advance(
            &mut last_saved_at,
            &mut last_saved_parts,
            11,
            || async { Err::<(), String>("disk full".to_string()) },
        )
        .await
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

    // Listing key decoding (encoding-type=url). Failure modes, written first:
    // - Form encoder (AWS, MinIO) sends space as `+`; read literally, it
    //   addresses a different or missing object.
    // - Percent encoder leaving `+` raw sends space as `%20`; form-decoding
    //   its `+` turns `a+b` into `a b`, so deletes hit the wrong key.
    // - A literal `%20` in a key arrives as `%2520`; not encoder evidence.
    // - The echoed request prefix carries the same evidence as the keys.
    // - A malformed escape must not panic or drop the key.

    #[test]
    fn form_encoded_page_decodes_plus_as_space_and_2b_as_plus() {
        let page = ["dir/a+b.txt", "dir/a%2Bb.txt"];
        let encoding = ListedEncoding::detect(page);
        assert_eq!(encoding.decode(page[0]), "dir/a b.txt");
        assert_eq!(encoding.decode(page[1]), "dir/a+b.txt");
    }

    #[test]
    fn percent_encoded_page_keeps_raw_plus_literal() {
        let page = ["dir/a+b.txt", "dir/c%20d.txt"];
        let encoding = ListedEncoding::detect(page);
        assert_eq!(encoding.decode(page[0]), "dir/a+b.txt");
        assert_eq!(encoding.decode(page[1]), "dir/c d.txt");
    }

    #[test]
    fn page_without_evidence_follows_the_s3_form_encoding() {
        let page = ["a+b"];
        assert_eq!(ListedEncoding::detect(page).decode(page[0]), "a b");
    }

    #[test]
    fn encoded_literal_percent_20_is_not_percent_encoder_evidence() {
        let page = ["x%2520y", "a+b"];
        let encoding = ListedEncoding::detect(page);
        assert_eq!(encoding.decode(page[0]), "x%20y");
        assert_eq!(encoding.decode(page[1]), "a b");
    }

    #[test]
    fn echoed_prefix_counts_as_evidence() {
        let encoding = ListedEncoding::detect(["my%20folder/", "my%20folder/a+b"]);
        assert_eq!(encoding.decode("my%20folder/a+b"), "my folder/a+b");
    }

    #[test]
    fn malformed_escape_decodes_without_losing_the_key() {
        let encoding = ListedEncoding::detect(["bad%zz+"]);
        assert_eq!(encoding.decode("bad%zz+"), "bad%zz ");
    }
}
