//! Bounded object preview.

use super::*;

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

    const MAX_PREVIEW: i64 = 1_048_576;
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
