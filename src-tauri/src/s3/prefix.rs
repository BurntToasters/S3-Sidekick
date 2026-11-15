//! Prefix listing, source preflight and prefix delete.

use super::*;

pub(super) fn next_page_token(
    truncated: bool,
    token: Option<&str>,
    seen: &mut HashSet<String>,
) -> Result<Option<String>, String> {
    if !truncated {
        return Ok(None);
    }
    let token = token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "S3 listing was truncated without a continuation token".to_string())?
        .to_string();
    if !seen.insert(token.clone()) {
        return Err(
            "S3 listing repeated a continuation token; refusing to loop indefinitely".to_string(),
        );
    }
    Ok(Some(token))
}

pub(super) struct PrefixCopySource {
    pub(super) source_key: String,
    pub(super) destination_key: String,
    pub(super) immutable_version_id: Option<String>,
}

pub(super) async fn preflight_prefix_copy_sources(
    client: &Client,
    src_bucket: &str,
    src_prefix: &str,
    dst_bucket: &str,
    dst_prefix: &str,
    require_immutable_versions: bool,
    cancel: &CancelToken,
) -> Result<Vec<PrefixCopySource>, String> {
    // A destination prefix without a trailing slash would concatenate the
    // suffix onto the last segment (`archive` + `a.jpg` -> `archivea.jpg`).
    // Normalize at the boundary so direct IPC and resumed transfers cannot
    // create surprising keys.
    let normalized_destination;
    let dst_prefix = if dst_prefix.is_empty() || dst_prefix.ends_with('/') {
        dst_prefix
    } else {
        normalized_destination = format!("{}/", dst_prefix);
        &normalized_destination
    };
    let mut sources = Vec::new();
    let mut continuation_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();
    let mut seen_keys = HashSet::new();

    loop {
        let mut request = client
            .list_objects_v2()
            .bucket(src_bucket)
            .prefix(src_prefix)
            .encoding_type(EncodingType::Url);
        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token);
        }
        let output = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request.send() => result.map_err(|err| {
                format!("Failed to preflight prefix sources: {}", err)
            })?,
        };

        let encoding = listed_encoding_for(src_bucket, &output);
        let page_start = sources.len();
        let mut page_plans: Vec<(String, String)> = Vec::new();
        for object in output.contents() {
            let Some(raw_key) = object.key() else {
                continue;
            };
            let key = encoding.decode(raw_key);
            if page_start + page_plans.len() >= MAX_PREFIX_TRANSACTION_OBJECTS {
                return Err(format!(
                    "Prefix operation exceeds the {}-object transaction limit; no destination was changed",
                    MAX_PREFIX_TRANSACTION_OBJECTS
                ));
            }
            if !seen_keys.insert(key.clone()) {
                return Err(format!(
                    "S3 listing repeated source key '{}'; no destination was changed",
                    key
                ));
            }
            let suffix = key.strip_prefix(src_prefix).ok_or_else(|| {
                format!("Key '{}' does not start with prefix '{}'", key, src_prefix)
            })?;
            let destination_key = format!("{}{}", dst_prefix, suffix);
            validate_key(&destination_key, "Destination key")?;
            if src_bucket == dst_bucket && destination_key == key {
                return Err(format!(
                    "Source and destination resolve to the same object ('{}'). Refusing to copy a prefix onto itself.",
                    key
                ));
            }
            page_plans.push((key, destination_key));
        }

        // Move plans bind immutable versions; truly unversioned sources
        // record `None` and may use the provider-gated ETag fallback.
        // A suspended bucket's mutable `null` version is a hard refusal.
        // One HEAD per object used to run serially under the transfer gate,
        // so a large move blocked rekey/reset for hours (M5). Run bounded
        // batches while preserving listing order.
        let versions = if require_immutable_versions {
            preflight_move_versions(client, src_bucket, &page_plans, cancel).await?
        } else {
            vec![None; page_plans.len()]
        };
        for ((source_key, destination_key), immutable_version_id) in
            page_plans.into_iter().zip(versions)
        {
            sources.push(PrefixCopySource {
                source_key,
                destination_key,
                immutable_version_id,
            });
        }

        match next_page_token(
            output.is_truncated().unwrap_or(false),
            output.next_continuation_token(),
            &mut seen_tokens,
        )? {
            Some(token) => continuation_token = Some(token),
            None => break,
        }
    }

    Ok(sources)
}

/// Bounded concurrency for the per-object immutable-version preflight.
///
/// The transfer gate is held for the whole preflight, so serial HEADs made a
/// large prefix move block unrelated storage operations for hours. Eight
/// concurrent HEADs per batch is enough to cut wall time without hammering a
/// provider's request rate.
pub(super) const MOVE_VERSION_PREFLIGHT_CONCURRENCY: usize = 8;

/// Contiguous index ranges, in listing order, for bounded-concurrency work.
fn preflight_chunk_ranges(len: usize, size: usize) -> Vec<std::ops::Range<usize>> {
    let size = size.max(1);
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + size).min(len);
        ranges.push(start..end);
        start = end;
    }
    ranges
}

async fn preflight_move_versions(
    client: &Client,
    bucket: &str,
    plans: &[(String, String)],
    cancel: &CancelToken,
) -> Result<Vec<Option<String>>, String> {
    let mut versions = Vec::with_capacity(plans.len());
    for range in preflight_chunk_ranges(plans.len(), MOVE_VERSION_PREFLIGHT_CONCURRENCY) {
        let mut handles = Vec::with_capacity(range.len());
        for (key, _) in &plans[range.clone()] {
            let client = client.clone();
            let bucket = bucket.to_string();
            let key = key.clone();
            let cancel = cancel.clone();
            handles.push(tokio::spawn(async move {
                preflight_optional_move_version(&client, &bucket, &key, &cancel).await
            }));
        }
        // Await the whole batch before surfacing a failure: returning early
        // would detach sibling HEADs against a client the gate is about to
        // release. Order within the batch still matches the listing.
        let mut batch = Vec::with_capacity(handles.len());
        for handle in handles {
            batch.push(
                handle
                    .await
                    .map_err(|err| format!("Version preflight task failed: {}", err))?,
            );
        }
        for result in batch {
            versions.push(result?);
        }
    }
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::preflight_chunk_ranges;

    #[test]
    fn version_preflight_chunks_preserve_order_and_bound_concurrency() {
        assert!(preflight_chunk_ranges(0, 8).is_empty());
        assert_eq!(preflight_chunk_ranges(3, 8), vec![0..3]);
        assert_eq!(preflight_chunk_ranges(8, 8), vec![0..8]);
        assert_eq!(preflight_chunk_ranges(9, 8), vec![0..8, 8..9]);
        assert_eq!(
            preflight_chunk_ranges(5, 0),
            vec![0..1, 1..2, 2..3, 3..4, 4..5],
            "a zero batch size must still make progress"
        );

        let chunks = preflight_chunk_ranges(1000, 8);
        assert_eq!(chunks.len(), 125);
        assert_eq!(chunks.first().map(|range| range.start), Some(0));
        assert_eq!(chunks.last().map(|range| range.end), Some(1000));
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "chunks must not skip or repeat");
        }
        assert!(chunks.iter().all(|range| range.len() <= 8));
    }
}

/// List rollback keys defensively (no delimiter, recursive, paginated).
pub(super) async fn list_all_keys_under_prefix(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
    cancel: &CancelToken,
) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut continuation_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();

    loop {
        let mut req = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .encoding_type(EncodingType::Url);
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

        let encoding = listed_encoding_for(bucket, &output);
        for obj in output.contents() {
            if let Some(k) = obj.key() {
                if keys.len() >= MAX_PREFIX_TRANSACTION_OBJECTS {
                    return Err(format!(
                        "Rollback backup discovery exceeds the {}-object safety limit",
                        MAX_PREFIX_TRANSACTION_OBJECTS
                    ));
                }
                keys.push(encoding.decode(k));
            }
        }

        match next_page_token(
            output.is_truncated().unwrap_or(false),
            output.next_continuation_token(),
            &mut seen_tokens,
        )? {
            Some(token) => continuation_token = Some(token),
            None => break,
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
    // Resolve the client first so a disconnect cancels the storage-gate and
    // lease waits behind a long-running operation on the same key or prefix.
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_folder_prefix(&prefix, "Prefix")?;
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::prefix(
            &connection_id,
            &bucket,
            &prefix,
        )],
        &client.token(),
    )
    .await?;
    let cancel = client.token();

    let mut result = DeleteResult::default();
    let versioned = bucket_creates_delete_markers(&client, &bucket, &cancel).await;
    apply_versioning_warning(&mut result, versioned);
    let mut continuation_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();

    'pages: loop {
        let mut req = client
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .encoding_type(EncodingType::Url);
        if let Some(ref token) = continuation_token {
            req = req.continuation_token(token);
        }
        let list_request = req.send();
        let list_result = tokio::select! {
            _ = cancel.cancelled() => {
                result.incomplete = true;
                record_delete_error(&mut result, cancelled_error());
                break;
            }
            result = list_request => result,
        };
        let output = match list_result {
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

        let encoding = listed_encoding_for(&bucket, &output);
        let keys: Vec<String> = output
            .contents()
            .iter()
            .filter_map(|obj| obj.key().map(|key| encoding.decode(key)))
            .collect();
        let next_token = match next_page_token(
            output.is_truncated().unwrap_or(false),
            output.next_continuation_token(),
            &mut seen_tokens,
        ) {
            Ok(token) => token,
            Err(err) => {
                result.incomplete = true;
                record_delete_error(&mut result, err);
                break;
            }
        };

        if keys.is_empty() {
            if let Some(token) = next_token {
                continuation_token = Some(token);
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

            let delete_request = client
                .delete_objects()
                .bucket(&bucket)
                .delete(delete)
                .send();
            let delete_result = tokio::select! {
                _ = cancel.cancelled() => {
                    result.incomplete = true;
                    record_delete_error(&mut result, cancelled_error());
                    break 'pages;
                }
                result = delete_request => result,
            };
            let del_output = match delete_result {
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
            if !errors.is_empty() {
                // The batch transport succeeded, but individual keys did not
                // delete. Report a partial failure instead of an Ok receipt.
                result.incomplete = true;
            }
            result.failed = result.failed.saturating_add(errors.len() as u32);
            let accepted = chunk.len().saturating_sub(errors.len()) as u32;
            result.deleted = result.deleted.saturating_add(accepted);
            if versioned == Some(true) {
                result.delete_markers = result.delete_markers.saturating_add(accepted);
            }
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

        if let Some(token) = next_token {
            continuation_token = Some(token);
        } else {
            break;
        }
    }

    finish_delete_result(result, "Prefix delete")
}
