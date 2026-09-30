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

        let encoding = listed_encoding(&output);
        for object in output.contents() {
            let Some(raw_key) = object.key() else {
                continue;
            };
            let key = encoding.decode(raw_key);
            if sources.len() >= MAX_PREFIX_TRANSACTION_OBJECTS {
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
            // Best-effort: versioned sources bind their immutable version,
            // unversioned ones record `None` and rely on the ETag-pinned
            // fallback at deletion time. Only genuine failures abort here.
            let immutable_version_id = if require_immutable_versions {
                preflight_optional_move_version(client, src_bucket, &key, cancel).await?
            } else {
                None
            };
            sources.push(PrefixCopySource {
                source_key: key,
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

        let encoding = listed_encoding(&output);
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
    validate_mutating_prefix(&prefix, "Prefix")?;
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

        let encoding = listed_encoding(&output);
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
            result.failed = result.failed.saturating_add(errors.len() as u32);
            result.deleted = result
                .deleted
                .saturating_add(chunk.len().saturating_sub(errors.len()) as u32);
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

    Ok(result)
}
