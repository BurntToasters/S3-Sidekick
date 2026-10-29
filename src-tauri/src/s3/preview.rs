//! Bounded object preview.

use super::*;

/// Largest text body the preview reads. Text keeps this prefix with a size
/// hint; the rest of the object is never pulled for a preview.
const MAX_PREVIEW: i64 = 1_048_576;

/// Largest image body the preview reads. A partial image cannot be drawn, so
/// images above this are refused instead of truncated.
const MAX_IMAGE_PREVIEW: i64 = 16_777_216;

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
            | "image/avif"
            | "image/svg+xml"
            | "image/bmp"
            | "image/x-icon"
    )
}

/// The read cap for a previewable type: the image cap for images, the text
/// cap for text, and `None` when the type is not previewable at all.
fn preview_read_cap(content_type: &str) -> Option<i64> {
    if is_previewable_image_type(content_type) {
        Some(MAX_IMAGE_PREVIEW)
    } else if is_text_content_type(content_type) {
        Some(MAX_PREVIEW)
    } else {
        None
    }
}

/// How a readable body is cut to its cap. Text is truncated to its prefix;
/// images are never truncated, so they have no truncation cap.
fn preview_truncation_cap(content_type: &str) -> Option<i64> {
    if is_previewable_image_type(content_type) {
        None
    } else if is_text_content_type(content_type) {
        Some(MAX_PREVIEW)
    } else {
        None
    }
}

fn plan_preview(content_type: &str, total_size: i64) -> PreviewPlan {
    match preview_read_cap(content_type) {
        None => PreviewPlan::Unsupported,
        // Images must arrive whole: anything above the image cap is refused
        // rather than read partially.
        Some(cap) if preview_truncation_cap(content_type).is_none() && total_size > cap => {
            PreviewPlan::TooLarge
        }
        Some(_) => PreviewPlan::Read,
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

    // Only text truncates to the 1 MiB prefix. A Read-planned image is within
    // the image cap and must arrive whole.
    let is_image = is_previewable_image_type(&content_type);
    let head_truncated = !is_image && total_size > MAX_PREVIEW;
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

    let mut reader = output.body.into_async_read();
    let body = read_preview_body(&mut reader, &content_type, &cancel).await?;

    let is_text = is_text_content_type(&content_type);

    let data = if is_text {
        String::from_utf8_lossy(&body.bytes).to_string()
    } else {
        B64.encode(&body.bytes)
    };

    Ok(PreviewResponse {
        content_type,
        data,
        is_text,
        truncated: head_truncated || body.truncated,
        total_size,
    })
}

/// A preview body after the per-type read policy has been applied.
#[derive(Debug, PartialEq, Eq)]
struct PreviewBody {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Streams a preview body from `reader` up to the type's read cap, reading one
/// byte past it so an exact fit is distinguishable from an overflow. Text
/// overflow is cut to its prefix; an image overflow is refused, never cut.
async fn read_preview_body<R>(
    reader: &mut R,
    content_type: &str,
    cancel: &CancelFlag,
) -> Result<PreviewBody, String>
where
    R: tokio::io::AsyncRead + Unpin + Send,
{
    use tokio::io::AsyncReadExt;
    let cap = preview_read_cap(content_type)
        .ok_or_else(|| "Preview is unavailable for this content type.".to_string())?
        as usize;
    let mut raw_bytes = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    while raw_bytes.len() <= cap {
        let read = reader.read(&mut buffer);
        let count = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = read => result,
        }
        .map_err(|e| format!("Failed to read preview body: {}", e))?;
        if count == 0 {
            break;
        }
        let remaining = cap + 1 - raw_bytes.len();
        raw_bytes.extend_from_slice(&buffer[..count.min(remaining)]);
    }

    if raw_bytes.len() <= cap {
        return Ok(PreviewBody {
            bytes: raw_bytes,
            truncated: false,
        });
    }
    match preview_truncation_cap(content_type) {
        Some(cut) => {
            raw_bytes.truncate(cut as usize);
            Ok(PreviewBody {
                bytes: raw_bytes,
                truncated: true,
            })
        }
        // HEAD named a size inside the cap but the stream ran past it. A prefix
        // of an image cannot be drawn, so refuse rather than return it.
        None => Err(format!(
            "Preview is unavailable because the image grew past the {} MiB preview limit while downloading.",
            MAX_IMAGE_PREVIEW / 1_048_576
        )),
    }
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
        assert_eq!(
            plan_preview("image/png", 16 * MIB + 1),
            PreviewPlan::TooLarge
        );
        assert_eq!(plan_preview("image/webp", 50 * MIB), PreviewPlan::TooLarge);
    }

    #[test]
    fn svg_follows_the_image_size_rule() {
        assert_eq!(plan_preview("image/svg+xml", 2048), PreviewPlan::Read);
        assert_eq!(
            plan_preview("image/svg+xml", 17 * MIB),
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

    // Failure-mode inventory for the separate image cap: the ways the split
    // caps can fail are enumerated here before the caps exist.
    #[test]
    fn images_at_exactly_16_mib_are_read() {
        assert_eq!(plan_preview("image/png", 16 * MIB), PreviewPlan::Read);
        assert_eq!(plan_preview("image/jpeg", 16 * MIB), PreviewPlan::Read);
    }

    #[test]
    fn images_over_16_mib_are_too_large_without_a_read() {
        assert_eq!(
            plan_preview("image/png", 16 * MIB + 1),
            PreviewPlan::TooLarge
        );
        assert_eq!(plan_preview("image/webp", 64 * MIB), PreviewPlan::TooLarge);
    }

    #[test]
    fn text_at_the_1_mib_cap_is_read() {
        assert_eq!(plan_preview("text/plain", MIB), PreviewPlan::Read);
        assert_eq!(plan_preview("application/json", MIB), PreviewPlan::Read);
    }

    #[test]
    fn text_over_1_mib_is_read_and_truncated_to_the_cap() {
        // Text never refuses a read; the 1 MiB cap applies as truncation, so
        // the truncation cap for text is exactly 1 MiB.
        assert_eq!(plan_preview("text/plain", MIB + 1), PreviewPlan::Read);
        assert_eq!(plan_preview("text/csv", 5 * MIB), PreviewPlan::Read);
        assert_eq!(preview_truncation_cap("text/plain"), Some(MIB));
        assert_eq!(preview_truncation_cap("text/csv"), Some(MIB));
    }

    #[test]
    fn images_are_never_truncated_to_the_text_cap() {
        assert_eq!(preview_truncation_cap("image/png"), None);
        assert_eq!(preview_truncation_cap("image/avif"), None);
    }

    #[test]
    fn avif_is_routed_to_the_image_cap() {
        assert_eq!(plan_preview("image/avif", 2048), PreviewPlan::Read);
        assert_eq!(plan_preview("image/avif", 16 * MIB), PreviewPlan::Read);
        assert_eq!(
            plan_preview("image/avif; charset=binary", 16 * MIB),
            PreviewPlan::Read
        );
        assert_eq!(
            plan_preview("image/avif", 16 * MIB + 1),
            PreviewPlan::TooLarge
        );
    }

    // Failure modes of the body read, enumerated before the per-type cap:
    // - an image between 1 MiB and 16 MiB is cut at the text cap (red first)
    // - an image exactly at 16 MiB is cut one byte short (red first)
    // - an image stream past 16 MiB is cut and returned as a partial picture
    //   instead of refused (red first)
    // - text over 1 MiB is not cut to its prefix with a truncation flag
    // - text exactly at 1 MiB is flagged as truncated when it is not
    // - cancellation before or during the body read does not return bytes
    // - a reader error does not return partial bytes
    struct PendingReader;

    impl tokio::io::AsyncRead for PendingReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
    }

    struct FailingReader;

    impl tokio::io::AsyncRead for FailingReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("connection reset")))
        }
    }

    fn body_of(len: i64) -> std::io::Cursor<Vec<u8>> {
        std::io::Cursor::new(vec![7u8; len as usize])
    }

    #[tokio::test]
    async fn image_of_3_mib_is_read_whole() {
        let mut reader = body_of(3 * MIB);
        let body = read_preview_body(&mut reader, "image/png", &CancelFlag::default())
            .await
            .expect("read a 3 MiB image");
        assert_eq!(body.bytes.len(), (3 * MIB) as usize);
        assert!(!body.truncated);
    }

    #[tokio::test]
    async fn image_at_exactly_16_mib_is_read_whole() {
        let mut reader = body_of(16 * MIB);
        let body = read_preview_body(&mut reader, "image/jpeg", &CancelFlag::default())
            .await
            .expect("read a 16 MiB image");
        assert_eq!(body.bytes.len(), (16 * MIB) as usize);
        assert!(!body.truncated);
    }

    #[tokio::test]
    async fn image_stream_past_16_mib_is_refused_not_cut() {
        let mut reader = body_of(16 * MIB + 1);
        let err = read_preview_body(&mut reader, "image/png", &CancelFlag::default())
            .await
            .expect_err("an oversized image stream must be refused");
        assert!(err.contains("16 MiB"), "unexpected refusal: {err}");
    }

    #[tokio::test]
    async fn text_over_1_mib_is_cut_to_1_mib_and_flagged() {
        let mut reader = body_of(2 * MIB);
        let body = read_preview_body(&mut reader, "text/plain", &CancelFlag::default())
            .await
            .expect("read a 2 MiB text body");
        assert_eq!(body.bytes.len(), MIB as usize);
        assert!(body.truncated);
    }

    #[tokio::test]
    async fn text_exactly_1_mib_is_not_flagged() {
        let mut reader = body_of(MIB);
        let body = read_preview_body(&mut reader, "text/csv", &CancelFlag::default())
            .await
            .expect("read a 1 MiB text body");
        assert_eq!(body.bytes.len(), MIB as usize);
        assert!(!body.truncated);
    }

    #[tokio::test]
    async fn cancellation_during_a_pending_body_read_returns_no_bytes() {
        let cancel = CancelFlag::default();
        cancel.cancel();
        let err = read_preview_body(&mut PendingReader, "image/png", &cancel)
            .await
            .expect_err("a cancelled preview must not return bytes");
        assert_eq!(err, cancelled_error());
    }

    #[tokio::test]
    async fn reader_errors_surface_without_partial_bytes() {
        let err = read_preview_body(&mut FailingReader, "text/plain", &CancelFlag::default())
            .await
            .expect_err("a failed body read must not return bytes");
        assert!(err.contains("Failed to read preview body"), "{err}");
    }
}
