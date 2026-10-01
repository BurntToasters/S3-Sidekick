//! Create-only (If-None-Match) write strategy per provider.

use super::*;

/// S3 create-only writes use `If-None-Match: *` so the destination must be absent
/// at commit time, not merely at an earlier probe.
pub(super) const CREATE_ONLY_IF_NONE_MATCH: &str = "*";
/// Cloudflare R2 requires this proprietary header on CopyObject (beta).
pub(super) const R2_COPY_DESTINATION_IF_NONE_MATCH: &str = "cf-copy-destination-if-none-match";
/// DigitalOcean Spaces documents `x-amz-copy-if-none-match`, not destination `If-None-Match`.
pub(super) const DIGITALOCEAN_COPY_IF_NONE_MATCH: &str = "x-amz-copy-if-none-match";

/// Provider-specific support for atomic create-only writes (`overwrite: false`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CopyCreateOnlyStrategy {
    AwsIfNoneMatch,
    R2DestinationHeader,
    DigitalOceanCopyIfNoneMatch,
}

pub(super) struct CreateOnlyCapabilities {
    pub(super) put_object: bool,
    pub(super) complete_multipart: bool,
    pub(super) copy_object: Option<CopyCreateOnlyStrategy>,
}

impl CreateOnlyCapabilities {
    pub(super) fn for_provider(provider: StorageProviderKind) -> Self {
        match provider {
            StorageProviderKind::Aws | StorageProviderKind::Wasabi => Self {
                put_object: true,
                complete_multipart: true,
                copy_object: Some(CopyCreateOnlyStrategy::AwsIfNoneMatch),
            },
            // The pinned MinIO server guards PutObject but does not enforce the
            // destination condition on CopyObject or multipart completion.
            StorageProviderKind::Minio => Self {
                put_object: true,
                complete_multipart: false,
                copy_object: None,
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

/// Automatic source retirement and unversioned rollback require a provider
/// that enforces the S3 DeleteObject If-Match precondition. Only AWS has a
/// verified contract in the current provider matrix; compatibility claims for
/// other endpoints do not grant deletion authority.
pub(super) fn supports_conditional_delete(provider: StorageProviderKind) -> bool {
    provider == StorageProviderKind::Aws
}

pub(super) fn require_conditional_delete_support(
    provider: StorageProviderKind,
    key: &str,
) -> Result<(), String> {
    if supports_conditional_delete(provider) {
        Ok(())
    } else {
        Err(format!(
            "This storage provider cannot enforce conditional DELETE for '{}'. Automatic moves and unversioned rollback are refused; sources and destinations were retained.",
            key
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct CreateOnlyCapabilityInfo {
    pub put_object: bool,
    pub complete_multipart: bool,
    pub copy_object: bool,
}

impl CreateOnlyCapabilityInfo {
    pub(super) fn from_provider(provider: StorageProviderKind) -> Self {
        let caps = CreateOnlyCapabilities::for_provider(provider);
        Self {
            put_object: caps.put_object,
            complete_multipart: caps.complete_multipart,
            copy_object: caps.copy_object.is_some(),
        }
    }
}

pub(super) fn create_only_unsupported_error(key: &str, action: &str) -> String {
    format!(
        "This storage provider cannot enforce a create-only {} for '{}'. Explicitly authorize an unconditional write before retrying.",
        action, key
    )
}

pub(super) fn apply_put_create_only_guard(
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

pub(super) fn require_put_create_only_support(
    provider: StorageProviderKind,
    key: &str,
) -> Result<(), String> {
    if CreateOnlyCapabilities::for_provider(provider).put_object {
        Ok(())
    } else {
        Err(create_only_unsupported_error(key, "upload"))
    }
}

pub(super) fn apply_complete_multipart_create_only_guard(
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

pub(super) fn require_complete_multipart_create_only_support(
    provider: StorageProviderKind,
    key: &str,
) -> Result<(), String> {
    if CreateOnlyCapabilities::for_provider(provider).complete_multipart {
        Ok(())
    } else {
        Err(create_only_unsupported_error(key, "multipart write"))
    }
}

pub(super) fn require_copy_create_only_strategy(
    provider: StorageProviderKind,
    key: &str,
) -> Result<CopyCreateOnlyStrategy, String> {
    CreateOnlyCapabilities::for_provider(provider)
        .copy_object
        .ok_or_else(|| create_only_unsupported_error(key, "copy"))
}

pub(super) fn service_error_status<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<E>,
) -> Option<u16> {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => Some(ctx.raw().status().as_u16()),
        _ => None,
    }
}

pub(super) fn is_destination_occupied<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<E>,
) -> bool {
    service_error_status(err) == Some(412)
}

pub(super) fn is_concurrent_write_conflict<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<E>,
) -> bool {
    service_error_status(err) == Some(409)
}

pub(super) fn destination_conflict_error(key: &str) -> String {
    format!(
        "Destination '{}' already exists. Choose overwrite to replace it.",
        key
    )
}

pub(super) fn map_create_only_write_error<E: std::fmt::Debug>(
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

/// A create-only write can commit while its response is lost. The SDK (or the
/// multipart completion loop) then retries with the same `If-None-Match: *`
/// and gets 412 against the object it just wrote. Recognise that case by the
/// exact size and SHA-256 ownership marker the write carried.
pub(super) async fn destination_is_own_write(
    client: &Client,
    bucket: &str,
    key: &str,
    checksum_hex: &str,
    size: u64,
    cancel: &CancelToken,
) -> bool {
    let request = client.head_object().bucket(bucket).key(key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return false,
        result = request => match result {
            Ok(head) => head,
            Err(_) => return false,
        },
    };
    let size_matches = head
        .content_length()
        .is_some_and(|length| u64::try_from(length).ok() == Some(size));
    let marker_matches = head
        .metadata()
        .and_then(|metadata| metadata.get(CHECKSUM_METADATA_KEY))
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(checksum_hex));
    size_matches && marker_matches
}

pub(super) fn detect_storage_provider(endpoint: &str) -> StorageProviderKind {
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
    // Loopback endpoints host many S3 emulators (LocalStack, Garage,
    // SeaweedFS, Ceph dev clusters). Only MinIO's default API port is trusted
    // to honor If-None-Match; anything else stays Generic and asks first.
    let is_loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if (is_loopback && parse_endpoint_port(endpoint) == Some(9000))
        || host.split('.').any(|label| label == "minio")
    {
        return StorageProviderKind::Minio;
    }
    StorageProviderKind::Generic
}

pub(super) fn parse_endpoint_port(endpoint: &str) -> Option<u16> {
    let trimmed = endpoint.trim();
    let after_scheme = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    let authority = after_scheme.split('/').next()?.trim();
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let port = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split_once("]:")?.1
    } else {
        host_port.split_once(':')?.1
    };
    port.parse().ok()
}

pub(super) fn apply_aws_copy_create_only_guard(
    request: aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder,
) -> aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder {
    request.if_none_match(CREATE_ONLY_IF_NONE_MATCH)
}

pub(super) async fn send_copy_object_create_only(
    request: aws_sdk_s3::operation::copy_object::builders::CopyObjectFluentBuilder,
    create_only_strategy: Option<CopyCreateOnlyStrategy>,
) -> Result<
    aws_sdk_s3::operation::copy_object::CopyObjectOutput,
    Box<aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::copy_object::CopyObjectError>>,
> {
    let result = match create_only_strategy {
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
    };
    result.map_err(Box::new)
}

pub(super) async fn destination_object_exists(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<bool, String> {
    let request = client.head_object().bucket(bucket).key(key).send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };
    match result {
        Ok(_) => Ok(true),
        Err(err) if is_not_found(&err) => Ok(false),
        Err(err) => Err(format!("Failed to check destination '{}': {}", key, err)),
    }
}

pub(super) async fn prefix_has_content(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
    cancel: &CancelToken,
) -> Result<bool, String> {
    let request = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .max_keys(1)
        .encoding_type(EncodingType::Url)
        .send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to check destination prefix '{}': {}", prefix, e))?;
    // Some S3-compatible providers omit KeyCount, so the returned entries are
    // authoritative when present.
    Ok(output.key_count().unwrap_or(0) > 0
        || !output.contents().is_empty()
        || !output.common_prefixes().is_empty())
}
