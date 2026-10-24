//! SDK error formatting and retry classification.

use super::*;

const SECRET_MARKERS: &[&str] = &[
    "X-Amz-Security-Token",
    "X-Amz-Credential",
    "X-Amz-Signature",
    "AWSAccessKeyId",
    "secret_access_key",
    "session_token",
    "secret_key",
    "access_key",
    "Authorization",
    "Signature",
    "password",
];

/// Redact credentials from a diagnostic string before it reaches stderr.
///
/// S3 and the AWS SDK can echo presigned URLs, authorization headers, or
/// request payloads in error text. Keep the diagnostic shape (status, error
/// code, message) while replacing anything that looks like a credential value.
pub(super) fn redact_sensitive(input: &str) -> String {
    let mut redacted = input.to_string();
    for marker in SECRET_MARKERS {
        redacted = redact_marker(&redacted, marker);
    }
    redacted
}

fn redact_marker(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let needle = marker.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let authorization = marker.eq_ignore_ascii_case("Authorization");
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(offset) = lower[cursor..].find(&needle) {
        let marker_start = cursor + offset;
        let marker_end = marker_start + marker.len();
        let mut separator = marker_end;
        while separator < bytes.len() && matches!(bytes[separator], b' ' | b'\t' | b'"' | b'\'') {
            separator += 1;
        }
        if separator >= bytes.len() || !matches!(bytes[separator], b':' | b'=') {
            output.push_str(&input[cursor..marker_end]);
            cursor = marker_end;
            continue;
        }

        let mut value_start = separator + 1;
        while value_start < bytes.len() && matches!(bytes[value_start], b' ' | b'\t') {
            value_start += 1;
        }
        if value_start < bytes.len() && matches!(bytes[value_start], b'"' | b'\'') {
            value_start += 1;
        }

        let mut value_end = value_start;
        while value_end < bytes.len() {
            let byte = bytes[value_end];
            if authorization {
                if byte == b'\r' || byte == b'\n' {
                    break;
                }
            } else if matches!(
                byte,
                b'&' | b' ' | b'\t' | b'"' | b'\'' | b',' | b'}' | b']' | b'\r' | b'\n'
            ) {
                break;
            }
            value_end += 1;
        }

        output.push_str(&input[cursor..value_start]);
        if value_end > value_start {
            output.push_str("[REDACTED]");
        }
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

pub(super) fn format_sdk_error<E: std::fmt::Debug>(
    prefix: &str,
    err: &aws_sdk_s3::error::SdkError<E>,
) -> String {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => {
            let raw = ctx.raw();
            let status = raw.status().as_u16();
            let body =
                redact_sensitive(&String::from_utf8_lossy(raw.body().bytes().unwrap_or(&[])));
            // Service bodies can embed multi-kilobyte XML Debug payloads; keep
            // the user-facing message to status plus a short excerpt and send
            // the full redacted body to stderr for diagnostics.
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
            let detail = redact_sensitive(&format!("{:?}", err));
            eprintln!("S3 {} (dispatch): full error: {}", prefix, detail);
            let mut excerpt = detail.chars().take(200).collect::<String>();
            if detail.chars().count() > 200 {
                excerpt.push('…');
            }
            format!("{} (dispatch): {}", prefix, excerpt)
        }
        other => {
            let detail = redact_sensitive(&format!("{:?}", other));
            eprintln!("S3 {}: full error: {}", prefix, detail);
            let mut excerpt = detail.chars().take(200).collect::<String>();
            if detail.chars().count() > 200 {
                excerpt.push('…');
            }
            format!("{}: {}", prefix, excerpt)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_presigned_query_credentials() {
        let input = "GET https://bucket.s3.amazonaws.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261023&X-Amz-Signature=deadbeef&X-Amz-Security-Token=session-token";
        let redacted = redact_sensitive(input);

        assert!(
            redacted.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"),
            "{redacted}"
        );
        assert!(!redacted.contains("AKIAEXAMPLE"), "{redacted}");
        assert!(!redacted.contains("deadbeef"), "{redacted}");
        assert!(!redacted.contains("session-token"), "{redacted}");
        assert!(
            redacted.contains("X-Amz-Signature=[REDACTED]"),
            "{redacted}"
        );
    }

    #[test]
    fn redacts_authorization_headers() {
        let input =
            "request failed\r\nAuthorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261023/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=deadbeef\r\nx-amz-request-id: request-123";
        let redacted = redact_sensitive(input);

        assert!(!redacted.contains("AKIAEXAMPLE"), "{redacted}");
        assert!(!redacted.contains("deadbeef"), "{redacted}");
        assert!(
            redacted.contains("x-amz-request-id: request-123"),
            "{redacted}"
        );
    }

    #[test]
    fn redacts_json_style_secret_fields() {
        let input = r#"{"access_key":"AKIAEXAMPLE","secret_key":"super-secret-value","session_token":"session-token","message":"Access Denied"}"#;
        let redacted = redact_sensitive(input);

        assert!(!redacted.contains("AKIAEXAMPLE"), "{redacted}");
        assert!(!redacted.contains("super-secret-value"), "{redacted}");
        assert!(!redacted.contains("session-token"), "{redacted}");
        assert!(redacted.contains("Access Denied"), "{redacted}");
    }
}
