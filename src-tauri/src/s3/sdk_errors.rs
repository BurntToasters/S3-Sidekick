//! SDK error formatting and retry classification.

use super::*;

pub(super) fn format_sdk_error<E: std::fmt::Debug>(
    prefix: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
) -> String {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => {
            let raw = ctx.raw();
            let status = raw.status().as_u16();
            let body = String::from_utf8_lossy(raw.body().bytes().unwrap_or(&[]));
            // Service bodies can embed multi-kilobyte XML Debug payloads; keep
            // the user-facing message to status plus a short excerpt and send
            // the full body to stderr for diagnostics.
            let mut excerpt: String = body.chars().take(200).collect();
            if body.chars().count() > 200 {
                excerpt.push('…');
            }
            eprintln!(
                "S3 {} (HTTP {}): full service body: {}",
                prefix, status, body
            );
            let mut message = format!("{} (HTTP {}): {}", prefix, status, excerpt);
            // Wrong-region buckets answer 301/307 with the authoritative
            // region in a header; surface it so the user can correct the
            // connection instead of staring at an opaque redirect.
            if status == 301 || status == 307 {
                if let Some(region) = raw.headers().get("x-amz-bucket-region") {
                    message.push_str(&format!(
                        " Bucket is in region '{}'; reconnect with that region.",
                        region
                    ));
                }
            }
            message
        }
        SdkError::DispatchFailure(err) => {
            eprintln!("S3 {} (dispatch): full error: {:?}", prefix, err);
            let mut detail = format!("{:?}", err);
            if detail.chars().count() > 200 {
                detail = format!("{}…", detail.chars().take(200).collect::<String>());
            }
            format!("{} (dispatch): {}", prefix, detail)
        }
        other => {
            eprintln!("S3 {}: full error: {:?}", prefix, other);
            let mut detail = format!("{:?}", other);
            if detail.chars().count() > 200 {
                detail = format!("{}…", detail.chars().take(200).collect::<String>());
            }
            format!("{}: {}", prefix, detail)
        }
    }
}

pub(super) fn structured_transfer_sdk_error<E: std::fmt::Debug>(
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

/// CompleteMultipartUpload can fail with HTTP 200 plus an embedded error body,
/// and AWS documents such completions as possibly still in progress. Retrying
/// the same completed-part list is safe; aborting a live completion is not.
/// CompleteMultipartUpload can fail with HTTP 200 plus an embedded error body,
/// and AWS documents such completions as possibly still in progress. Retrying
/// the same completed-part list is safe; aborting a live completion is not.
pub(super) fn complete_upload_error_is_retryable<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<E>,
) -> bool {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => {
            let status = ctx.raw().status().as_u16();
            status == 200 || status == 408 || status == 425 || status == 429 || status >= 500
        }
        SdkError::DispatchFailure(_) | SdkError::TimeoutError(_) => true,
        _ => false,
    }
}

/// Retry only failures a later attempt can fix. A 400/403/404 part failure is
/// deterministic; re-sending the part just burns bandwidth before the same
/// error surfaces.
pub(super) fn upload_part_error_is_retryable<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<E>,
) -> bool {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => {
            let status = ctx.raw().status().as_u16();
            status == 408 || status == 425 || status == 429 || status >= 500
        }
        SdkError::DispatchFailure(_) | SdkError::TimeoutError(_) => true,
        _ => false,
    }
}

pub(super) fn generation_pinned_download_error<E: std::fmt::Debug>(
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
pub(super) fn feature_is_unimplemented(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("notimplemented") || lower.contains("not implemented")
}

pub(super) fn acls_are_unavailable(message: &str) -> bool {
    feature_is_unimplemented(message)
        || message
            .to_ascii_lowercase()
            .contains("accesscontrollistnotsupported")
}
