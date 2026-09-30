//! Key, prefix and bucket name validation.

use super::*;

pub(super) fn multipart_copy_part_size(object_size: u64) -> Result<u64, String> {
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

pub(super) fn validate_key(key: &str, label: &str) -> Result<(), String> {
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
pub(super) fn validate_list_prefix(prefix: &str, label: &str) -> Result<(), String> {
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
pub(super) fn encode_object_url_segment(segment: &str) -> String {
    urlencoding::encode(segment).into_owned()
}

/// Dot-segment keys cannot be turned into browser-safe path URLs; `%2E%2E` still
/// normalises to `..` under the URL standard.
pub(super) fn key_has_unsafe_url_segments(key: &str) -> bool {
    key.split('/')
        .any(|segment| segment == "." || segment == "..")
}

/// Reject an empty prefix for operations that mutate everything beneath it.
///
/// `validate_list_prefix` deliberately allows `""` because listing the bucket root is
/// legitimate. Deleting, moving, or copying "everything under `""`" is not: it
/// silently means the entire bucket.
pub(super) fn validate_mutating_prefix(prefix: &str, label: &str) -> Result<(), String> {
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

pub(super) fn prefixes_overlap(first: &str, second: &str) -> bool {
    // Compare at `/` boundaries so `photos` and `photos2` are siblings, not
    // an overlap. A trailing slash normalizes `photos` and `photos/` alike.
    fn with_boundary(value: &str) -> String {
        if value.ends_with('/') {
            value.to_string()
        } else {
            format!("{}/", value)
        }
    }
    let first = with_boundary(first);
    let second = with_boundary(second);
    first.starts_with(&second) || second.starts_with(&first)
}

/// Validate a key that is about to be written to, overwritten, or deleted.
///
/// Rollback backups may hold the only copy of a destination that an in-flight
/// copy or move still has to restore, so they are read-only from the UI's point
/// of view. Reads, downloads and copies *out of* the namespace stay allowed: that
/// is how a user recovers data from an interrupted operation.
pub(super) fn validate_mutating_key(key: &str, label: &str) -> Result<(), String> {
    validate_key(key, label)?;
    reject_reserved_backup_key(key, label)
}

/// Validate a key for read-only operations (head, download, preview, presign).
///
/// Like `validate_deletable_key`, dot segments are allowed because they are legal
/// in S3. Reads never derive a local filesystem path from the key.
pub(super) fn validate_readable_key(key: &str, label: &str) -> Result<(), String> {
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
pub(super) fn validate_deletable_key(key: &str, label: &str) -> Result<(), String> {
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

pub(super) fn reject_reserved_backup_key(key: &str, label: &str) -> Result<(), String> {
    if key.starts_with(ROLLBACK_BACKUP_PREFIX) {
        return Err(format!(
            "{} is inside '{}', which S3 Sidekick reserves for copy and move rollback backups. \
             They may hold the only copy of overwritten data, so they cannot be modified here.",
            label, ROLLBACK_BACKUP_PREFIX
        ));
    }
    Ok(())
}

/// Validate a bucket name before it reaches the provider.
///
/// Rules (S3-compatible naming subset for AWS plus MinIO/R2/etc): 3-63
/// chars, ASCII letters plus digits with hyphen, underscore, and dot
/// separators, no empty dot segments (which also rejects leading/trailing
/// dots and adjacent dots, including `..`).
pub(super) fn validate_bucket_name(bucket: &str) -> Result<(), String> {
    if !(3..=63).contains(&bucket.len()) {
        return Err("Bucket name must be between 3 and 63 characters".to_string());
    }
    if !bucket
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.' || byte == b'_')
    {
        return Err(
            "Bucket name may only contain letters, digits, hyphens, underscores, and dots"
                .to_string(),
        );
    }
    if bucket.contains("..") || bucket.split('.').any(|segment| segment.is_empty()) {
        return Err("Bucket name must not contain adjacent dots".to_string());
    }
    Ok(())
}
