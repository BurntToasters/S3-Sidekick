//! Bounded object preview.

use super::*;

/// Largest body the preview reads. Text keeps this prefix with a size hint;
/// images above it are not drawn from a partial body.
const MAX_PREVIEW: i64 = 1_048_576;

/// What the preview does once HEAD has named the content type and size.
/// Only `Read` fetches the body; the other plans answer from HEAD alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewPlan {
    Read,
    TooLarge,
    Unsupported,
}

fn preview_media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn is_previewable_image_type(content_type: &str) -> bool {
    matches!(
        preview_media_type(content_type).as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/svg+xml"
            | "image/bmp"
            | "image/x-icon"
    )
}

fn plan_preview(content_type: &str, total_size: i64) -> PreviewPlan {
    if is_previewable_image_type(content_type) {
        if total_size > MAX_PREVIEW {
            PreviewPlan::TooLarge
        } else {
            PreviewPlan::Read
        }
    } else if is_text_content_type(content_type) {
        PreviewPlan::Read
    } else {
        PreviewPlan::Unsupported
    }
}

// Keep the future held by Tauri's IPC responder small. The implementation
// owns AWS SDK request state and the bounded preview body, so returning it
// boxed prevents that state from being copied onto the responder's stack.
#[tauri::command(async)]
pub(crate) fn preview_object(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> impl std::future::Future<Output = Result<PreviewResponse, String>> + Send + use<'_> {
    Box::pin(preview_object_inner(state, connection_id, bucket, key))
}

pub(super) async fn preview_object_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<PreviewResponse, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let head_request = client.head_object().bucket(&bucket).key(&key).send();
    let head = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = head_request => result,
    }
    .map_err(|e| format!("Failed to get object info: {}", e))?;

    let total_size = head.content_length().unwrap_or(0);
    let content_type = head
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();

    if plan_preview(&content_type, total_size) != PreviewPlan::Read {
        return Ok(PreviewResponse {
            content_type,
            data: String::new(),
            is_text: false,
            truncated: false,
            total_size,
        });
    }

    let head_truncated = total_size > MAX_PREVIEW;
    let version_id = head
        .version_id()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let etag = head
        .e_tag()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if version_id.is_none() && etag.is_none() {
        return Err(
            "Preview is unavailable because the provider returned no object generation identity."
                .to_string(),
        );
    }

    let mut req = client.get_object().bucket(&bucket).key(&key);
    // Prefer a conditional current-object read so preview does not require the
    // broader GetObjectVersion permission on otherwise readable versioned buckets.
    if let Some(etag) = etag {
        req = req.if_match(etag);
    } else if let Some(version_id) = version_id.as_deref() {
        req = req.version_id(version_id);
    }
    if head_truncated {
        req = req.range(format!("bytes=0-{}", MAX_PREVIEW - 1));
    }

    let request = req.send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to download preview: {}", e))?;

    if head_truncated {
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
    let mut buffer = vec![0u8; 64 * 1024];
    while raw_bytes.len() <= max_bytes {
        let read = reader.read(&mut buffer);
        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = read => result,
        }
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

    let observed_truncation = raw_bytes.len() > max_bytes;
    let bytes: &[u8] = if observed_truncation {
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
        truncated: head_truncated || observed_truncation,
        total_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: i64 = 1_048_576;

    #[test]
    fn small_images_are_read() {
        assert_eq!(plan_preview("image/png", 4096), PreviewPlan::Read);
        assert_eq!(plan_preview("image/jpeg", MIB), PreviewPlan::Read);
        assert_eq!(
            plan_preview("image/png; charset=binary", 10),
            PreviewPlan::Read
        );
    }

    #[test]
    fn images_over_the_limit_are_too_large_without_a_read() {
        assert_eq!(plan_preview("image/png", MIB + 1), PreviewPlan::TooLarge);
        assert_eq!(plan_preview("image/webp", 50 * MIB), PreviewPlan::TooLarge);
    }

    #[test]
    fn svg_follows_the_image_size_rule() {
        assert_eq!(plan_preview("image/svg+xml", 2048), PreviewPlan::Read);
        assert_eq!(
            plan_preview("image/svg+xml", 2 * MIB),
            PreviewPlan::TooLarge
        );
    }

    #[test]
    fn text_is_read_even_when_larger_than_the_limit() {
        // Text keeps its first megabyte; the size hint explains the cut.
        assert_eq!(plan_preview("text/plain", 5 * MIB), PreviewPlan::Read);
        assert_eq!(plan_preview("application/json", 5 * MIB), PreviewPlan::Read);
    }

    #[test]
    fn archives_binaries_and_media_are_unsupported_without_a_read() {
        assert_eq!(
            plan_preview("application/zip", 2048),
            PreviewPlan::Unsupported
        );
        assert_eq!(
            plan_preview("application/octet-stream", 2048),
            PreviewPlan::Unsupported
        );
        assert_eq!(plan_preview("video/mp4", 2048), PreviewPlan::Unsupported);
        assert_eq!(plan_preview("", 2048), PreviewPlan::Unsupported);
    }

    #[test]
    fn unknown_image_subtypes_are_not_previewed() {
        assert_eq!(plan_preview("image/heic", 2048), PreviewPlan::Unsupported);
    }
}
