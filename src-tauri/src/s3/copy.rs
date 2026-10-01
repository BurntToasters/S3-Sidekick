//! Single-object copy with receipts, and rename.

use super::*;

/// Everything about a source object that a copy has to carry forward.
///
/// A single-part `CopyObject` preserves all of this implicitly (the default
/// metadata directive is COPY). A multipart copy does not: the destination is
/// created by `CreateMultipartUpload`, which starts from nothing, so every
/// header has to be supplied explicitly.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub(crate) struct CopyReceipt {
    pub(super) source_key: String,
    pub(super) source_etag: String,
    #[serde(default)]
    pub(super) source_fingerprint: String,
    #[serde(default)]
    pub(super) source_acl_fingerprint: String,
    #[serde(default)]
    pub(super) source_tag_fingerprint: String,
    pub(super) source_version_id: Option<String>,
    pub(super) destination_key: String,
    pub(super) destination_etag: String,
    #[serde(default)]
    pub(super) destination_fingerprint: String,
    #[serde(default)]
    pub(super) destination_acl_fingerprint: String,
    #[serde(default)]
    pub(super) destination_tag_fingerprint: String,
    pub(super) destination_version_id: Option<String>,
    /// See `DestinationIdentity::ownership_ambiguous`. Never serialized: a
    /// receipt coming back from the frontend only authorizes source deletes.
    #[serde(skip)]
    pub(crate) ownership_ambiguous: bool,
}

#[derive(Clone)]
pub(super) struct SourceObjectInfo {
    pub(super) size: i64,
    pub(super) last_modified: Option<String>,
    pub(super) etag: Option<String>,
    pub(super) version_id: Option<String>,
    pub(super) content_type: Option<String>,
    pub(super) cache_control: Option<String>,
    pub(super) content_disposition: Option<String>,
    pub(super) content_encoding: Option<String>,
    pub(super) content_language: Option<String>,
    pub(super) website_redirect_location: Option<String>,
    pub(super) storage_class: Option<aws_sdk_s3::types::StorageClass>,
    pub(super) server_side_encryption: Option<aws_sdk_s3::types::ServerSideEncryption>,
    pub(super) ssekms_key_id: Option<String>,
    pub(super) bucket_key_enabled: Option<bool>,
    pub(super) metadata: Option<HashMap<String, String>>,
    pub(super) acl: Option<ObjectCannedAcl>,
    pub(super) acl_fingerprint: String,
    pub(super) tagging: Option<String>,
    pub(super) tag_fingerprint: String,
}

pub(super) struct DestinationIdentity {
    pub(super) etag: String,
    pub(super) version_id: Option<String>,
    /// Bound by an unversioned HEAD after a create-only retry met 412. The
    /// object is either this operation's committed write or an identical one
    /// from another client, so rollback must never delete it.
    pub(super) ownership_ambiguous: bool,
}

pub(super) fn hash_generation_fields(fields: Vec<(&str, String)>) -> String {
    let mut hasher = Sha256::new();
    for (name, value) in fields {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

pub(super) fn is_canonical_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A nonempty version selector is valid for reads and copies, including the
/// literal `null` selector returned by a versioning-suspended bucket.
pub(super) fn readable_version_id(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|version_id| !version_id.is_empty())
}

/// Only a non-null version ID is immutable enough to authorize move deletion.
pub(super) fn immutable_version_id(value: Option<&str>) -> Option<&str> {
    readable_version_id(value).filter(|version_id| !version_id.eq_ignore_ascii_case("null"))
}

pub(super) fn require_immutable_move_version(
    value: Option<&str>,
    key: &str,
) -> Result<String, String> {
    match readable_version_id(value) {
        Some(version_id) if version_id.eq_ignore_ascii_case("null") => Err(format!(
            "Source '{}' has a mutable null version ID. Automatic move requires an immutable version; no destination was changed.",
            key
        )),
        Some(version_id) => Ok(version_id.to_string()),
        None => Err(format!(
            "Source '{}' has no immutable version ID. Automatic move requires object versioning; no destination was changed.",
            key
        )),
    }
}

pub(super) async fn preflight_immutable_source_version(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<String, String> {
    let request = client.head_object().bucket(bucket).key(key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result.map_err(|err| {
            format!("Failed to verify move source '{}': {}", key, err)
        })?,
    };
    require_immutable_move_version(head.version_id(), key)
}

/// Marker for the one preflight failure that means "unversioned bucket" rather
/// than a real error. Matched with `contains` like the other provider-message
/// probes in this file; it is produced only by `require_immutable_move_version`.
pub(super) const MISSING_MOVE_VERSION_MARKER: &str = "no immutable version ID";

/// Best-effort immutable source version: `Some` on versioned buckets, `None`
/// on unversioned ones. A literal null version is readable but mutable, so it
/// remains a hard error instead of entering the ETag-based delete path.
pub(super) async fn preflight_optional_move_version(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<Option<String>, String> {
    match preflight_immutable_source_version(client, bucket, key, cancel).await {
        Ok(version_id) => Ok(Some(version_id)),
        Err(err) if err.contains(MISSING_MOVE_VERSION_MARKER) => Ok(None),
        Err(err) => Err(err),
    }
}

pub(super) fn validate_receipt_fingerprints(receipts: &[CopyReceipt]) -> Result<(), String> {
    for receipt in receipts {
        if !is_canonical_fingerprint(&receipt.source_fingerprint)
            || !is_canonical_fingerprint(&receipt.source_acl_fingerprint)
            || !is_canonical_fingerprint(&receipt.source_tag_fingerprint)
            || !is_canonical_fingerprint(&receipt.destination_fingerprint)
            || !is_canonical_fingerprint(&receipt.destination_acl_fingerprint)
            || !is_canonical_fingerprint(&receipt.destination_tag_fingerprint)
        {
            return Err(format!(
                "Copy receipt for source '{}' is missing canonical source or destination HEAD, ACL, or tag fingerprints; source deletion was refused.",
                receipt.source_key
            ));
        }
        if immutable_version_id(receipt.source_version_id.as_deref()).is_none() {
            return Err(format!(
                "Source '{}' has no immutable version ID. Automatic move deletion requires bucket versioning; source deletion was refused, the copied destination was retained, and the source was not deleted.",
                receipt.source_key
            ));
        }
    }
    Ok(())
}

pub(super) fn head_generation_fingerprint(
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

pub(super) fn source_generation_fingerprint(info: &SourceObjectInfo) -> String {
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

pub(super) async fn destination_identity_from_head(
    client: &Client,
    bucket: &str,
    key: &str,
    response_version_id: Option<&str>,
    cancel: &CancelToken,
) -> Result<DestinationIdentity, String> {
    let version_id = response_version_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Copy to '{}' may have committed, but the response contained neither an ETag nor a version ID. The destination was retained.",
                key
            )
        })?;
    // After the write commits, only its response-owned version can identify the
    // destination safely. An unversioned HEAD could bind a concurrent writer.
    let request = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .version_id(version_id)
        .send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(format!(
            "Copy to '{}' may have committed, but destination identity verification was cancelled. The destination was retained.",
            key
        )),
        result = request => result.map_err(|err| format!(
            "Copy to '{}' may have committed, but exact version '{}' could not be verified: {}. The destination was retained.",
            key, version_id, err
        ))?,
    };
    if head.version_id() != Some(version_id) {
        return Err(format!(
            "Copy to '{}' may have committed, but exact version '{}' was not confirmed by the provider. The destination was retained.",
            key, version_id
        ));
    }
    let etag = head
        .e_tag()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Copy to '{}' may have committed, but exact version '{}' returned no ETag. The destination was retained.",
                key, version_id
            )
        })?;
    Ok(DestinationIdentity {
        etag: etag.to_string(),
        version_id: Some(version_id.to_string()),
        ownership_ambiguous: false,
    })
}

/// Identity of a destination a create-only retry found occupied after an
/// earlier attempt may have committed. Only an unversioned HEAD is available,
/// so the identity is marked ambiguous (see `DestinationIdentity`).
pub(super) fn ambiguous_destination_identity(
    head: &aws_sdk_s3::operation::head_object::HeadObjectOutput,
    key: &str,
) -> Result<DestinationIdentity, String> {
    let etag = head
        .e_tag()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Copy to '{}' may have committed, but the destination returned no ETag. The destination was retained.",
                key
            )
        })?;
    Ok(DestinationIdentity {
        etag: etag.to_string(),
        version_id: head.version_id().map(|value| value.to_string()),
        ownership_ambiguous: true,
    })
}

pub(super) fn source_info_from_head(
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
        acl_fingerprint: String::new(),
        tagging: None,
        tag_fingerprint: String::new(),
    }
}

pub(super) async fn describe_object(
    client: &Client,
    bucket: &str,
    key: &str,
    requested_version_id: Option<&str>,
    cancel: &CancelToken,
) -> Result<SourceObjectInfo, String> {
    let mut head_request = client.head_object().bucket(bucket).key(key);
    if let Some(version_id) = requested_version_id {
        head_request = head_request.version_id(version_id);
    }
    let head_request = head_request.send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = head_request => {
            result.map_err(|e| format!("Failed to get object info for '{}': {}", key, e))?
        }
    };
    let mut info = source_info_from_head(&head);
    if let Some(expected_version_id) = requested_version_id {
        if info.version_id.as_deref() != Some(expected_version_id) {
            return Err(format!(
                "Object '{}' did not confirm requested version '{}'.",
                key, expected_version_id
            ));
        }
    }

    // Receipt-producing copies bind deletion authority to all object state that
    // can change independently of the ETag: HEAD metadata, ACL grants and raw
    // tags. Read ACLs and tags for small copies too, even though CopyObject can
    // preserve tags server-side, because a later move deletion must prove they
    // still match. Unsupported features receive explicit, distinct fingerprints;
    // ordinary read failures remain fail-closed.
    let version_id = info.version_id.clone();
    let properties = async {
        tokio::join!(
            source_acl_state_for_object(client, bucket, key, version_id.as_deref()),
            source_tag_state_for_object(client, bucket, key, version_id.as_deref())
        )
    };
    let (acl, tagging) = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = properties => result,
    };
    let acl = acl?;
    let tagging = tagging?;
    info.acl = acl.canned_acl;
    info.acl_fingerprint = acl.fingerprint;
    info.tagging = tagging.encoded;
    info.tag_fingerprint = tagging.fingerprint;
    Ok(info)
}

pub(super) async fn describe_source(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<SourceObjectInfo, String> {
    describe_object(client, bucket, key, None, cancel).await
}

pub(super) async fn describe_immutable_move_source(
    client: &Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<SourceObjectInfo, String> {
    let version_id = preflight_immutable_source_version(client, bucket, key, cancel).await?;
    describe_object(client, bucket, key, Some(&version_id), cancel).await
}

/// Copy a single object, preserving metadata and picking the right mechanism
/// for its size.
///
/// This is the one place that decides between `CopyObject` and a multipart copy.
/// Previously only `rename_object` and `copy_object_to` made that decision, so
/// the prefix-wide operations always issued a single `CopyObject` and failed
/// outright on any object at or above S3's 5 GiB copy-source limit.
pub(super) async fn copy_one(
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
                if !overwrite && is_destination_occupied(err.as_ref()) {
                    return resolve_copy_precondition_failure(
                        client, dst_bucket, dst_key, src_key, &info, cancel,
                    )
                    .await;
                }
                if !overwrite && is_concurrent_write_conflict(err.as_ref()) {
                    return Err(map_create_only_write_error(
                        dst_key,
                        err.as_ref(),
                        overwrite,
                        "copy",
                    ));
                }
                if is_destination_occupied(err.as_ref()) {
                    return Err(format!(
                        "Source '{}' changed after it was inspected. Refresh and retry.",
                        src_key
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
            ownership_ambiguous: false,
        });
    }
    destination_identity_from_head(
        client,
        dst_bucket,
        dst_key,
        copy_output.version_id(),
        cancel,
    )
    .await
}

/// A single-part create-only copy failed with 412. That status has three
/// causes, told apart by the destination:
/// - absent: `x-amz-copy-source-if-match` failed, so the source changed;
/// - same ETag as the source: an earlier attempt of this copy committed and
///   the SDK retry hit it (a single-part copy preserves the source ETag);
/// - anything else: the destination really is occupied.
pub(super) async fn resolve_copy_precondition_failure(
    client: &Client,
    dst_bucket: &str,
    dst_key: &str,
    src_key: &str,
    info: &SourceObjectInfo,
    cancel: &CancelToken,
) -> Result<DestinationIdentity, String> {
    let request = client.head_object().bucket(dst_bucket).key(dst_key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };
    match head {
        Err(err) if is_not_found(&err) => Err(format!(
            "Source '{}' changed after it was inspected. Refresh and retry.",
            src_key
        )),
        Ok(head) => {
            let own_copy = matches!(
                (head.e_tag(), info.etag.as_deref()),
                (Some(dst), Some(src)) if !dst.is_empty() && dst == src
            );
            if own_copy {
                ambiguous_destination_identity(&head, dst_key)
            } else {
                Err(destination_conflict_error(dst_key))
            }
        }
        Err(_) => Err(destination_conflict_error(dst_key)),
    }
}

/// A create-only CompleteMultipartUpload failed with 412. If the upload ID is
/// gone, an earlier completion attempt of this upload committed; a real
/// conflict rejects the request without consuming the upload.
pub(super) async fn multipart_upload_already_completed(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    cancel: &CancelToken,
) -> bool {
    let request = client
        .list_parts()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .max_parts(1)
        .send();
    tokio::select! {
        _ = cancel.cancelled() => false,
        result = request => matches!(result, Err(ref err) if is_not_found(err)),
    }
}

pub(super) async fn copy_object_multipart(
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
        let part_bytes = end - offset + 1;
        let part_request = part_builder
            .customize()
            .config_override(body_attempt_timeout_override(part_bytes))
            .send();
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
            if !overwrite
                && is_destination_occupied(&e)
                && multipart_upload_already_completed(
                    client, dst_bucket, dest_key, &upload_id, cancel,
                )
                .await
            {
                // The upload ID is consumed, so an earlier completion
                // committed. Bind what is there now, without claiming it.
                let head = client.head_object().bucket(dst_bucket).key(dest_key).send();
                let head = tokio::select! {
                    _ = cancel.cancelled() => return Err(cancelled_error()),
                    result = head => result.map_err(|err| format!(
                        "Copy to '{}' may have committed, but the destination could not be read: {}. The destination was retained.",
                        dest_key, err
                    ))?,
                };
                return ambiguous_destination_identity(&head, dest_key);
            }
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
            ownership_ambiguous: false,
        });
    }
    destination_identity_from_head(
        client,
        dst_bucket,
        dest_key,
        complete_output.version_id(),
        cancel,
    )
    .await
}

pub(super) async fn copy_with_receipt(
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
    if !is_canonical_fingerprint(&source_fingerprint)
        || !is_canonical_fingerprint(&info.acl_fingerprint)
        || !is_canonical_fingerprint(&info.tag_fingerprint)
    {
        return Err(format!(
            "Source '{}' did not produce complete canonical HEAD, ACL, and tag fingerprints",
            src_key
        ));
    }
    let source_acl_fingerprint = info.acl_fingerprint.clone();
    let source_tag_fingerprint = info.tag_fingerprint.clone();

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
    let destination_info = describe_object(
        client,
        dst_bucket,
        dst_key,
        destination.version_id.as_deref(),
        cancel,
    )
    .await
    .map_err(|err| {
        format!(
            "Copy to '{}' completed, but destination preservation state could not be bound: {}. The destination was retained.",
            dst_key, err
        )
    })?;
    if destination_info.etag.as_deref() != Some(destination.etag.as_str()) {
        return Err(format!(
            "Copy to '{}' completed, but destination ETag changed before preservation state was recorded. The destination was retained.",
            dst_key
        ));
    }
    let destination_fingerprint = source_generation_fingerprint(&destination_info);
    if !is_canonical_fingerprint(&destination_fingerprint)
        || !is_canonical_fingerprint(&destination_info.acl_fingerprint)
        || !is_canonical_fingerprint(&destination_info.tag_fingerprint)
    {
        return Err(format!(
            "Copy to '{}' completed, but destination HEAD, ACL, and tag fingerprints were incomplete. The destination was retained.",
            dst_key
        ));
    }

    Ok(CopyReceipt {
        source_key: src_key.to_string(),
        source_etag,
        source_fingerprint,
        source_acl_fingerprint,
        source_tag_fingerprint,
        source_version_id: info.version_id,
        destination_key: dst_key.to_string(),
        destination_etag: destination.etag,
        destination_fingerprint,
        destination_acl_fingerprint: destination_info.acl_fingerprint,
        destination_tag_fingerprint: destination_info.tag_fingerprint,
        destination_version_id: destination.version_id.or(destination_info.version_id),
        ownership_ambiguous: destination.ownership_ambiguous,
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
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, transfer_id)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    // The source is only ever deleted, never mapped to a local path, so
    // dot-segment keys (legal in S3) must not strand it here after a
    // dot-tolerant copy created the destination — that asymmetry caused
    // half-moves. The destination is still a mutating target.
    validate_deletable_key(&old_key, "Source key")?;
    validate_mutating_key(&new_key, "Destination key")?;
    if old_key == new_key {
        return Err("Source and destination keys are identical.".to_string());
    }
    let provider = client.provider();
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![
            crate::S3MutationScope::key(&connection_id, &bucket, &old_key),
            crate::S3MutationScope::key(&connection_id, &bucket, &new_key),
        ],
        &cancel,
    )
    .await?;

    // Reject mutable null versions before provider gating so the reason is
    // explicit, while keeping this read under the source/destination lease.
    let source_version =
        preflight_optional_move_version(&client, &bucket, &old_key, &cancel).await?;
    require_conditional_delete_support(provider, &old_key)?;

    if !overwrite && destination_object_exists(&client, &bucket, &new_key, &cancel).await? {
        return Err(format!(
            "Destination '{}' already exists. Rename with overwrite to replace it.",
            new_key
        ));
    }

    // Versioned buckets take the exact-version path; unversioned buckets fall
    // back to an ETag-pinned copy plus a HEAD-fingerprint and If-Match guarded
    // delete under the mutation lease held above. Either way the copy carries
    // `copy-source-if-match`, and deletion revalidates both ends.
    let source_info = describe_object(
        &client,
        &bucket,
        &old_key,
        source_version.as_deref(),
        &cancel,
    )
    .await?;
    let receipt = copy_with_receipt(
        &client,
        &bucket,
        &old_key,
        &bucket,
        &new_key,
        Some(source_info),
        overwrite,
        provider,
        &cancel,
    )
    .await?;
    delete_move_receipts_checked(&client, &bucket, &bucket, &[receipt], provider, &cancel).await?;
    Ok(())
}
