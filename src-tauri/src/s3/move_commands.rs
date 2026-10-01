//! Copy and move commands built on receipts.

use super::*;

#[tauri::command]
pub(crate) async fn delete_copied_objects(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    dst_bucket: String,
    receipts: Vec<CopyReceipt>,
    transfer_id: Option<u32>,
) -> Result<u32, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, transfer_id)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&src_bucket)?;
    validate_bucket_name(&dst_bucket)?;
    if receipts.is_empty() {
        return Ok(0);
    }
    let mut source_keys = BTreeSet::new();
    let mut destination_keys = BTreeSet::new();
    for receipt in &receipts {
        // Only the source is deleted here. It gets dot-tolerant deletable
        // validation (deletion never derives a local path), and the
        // destination gets read validation: both may legally contain dot
        // segments after a dot-tolerant copy, and refusing them here would
        // strand a completed copy as a half-move.
        validate_deletable_key(&receipt.source_key, "Source key")?;
        validate_readable_key(&receipt.destination_key, "Destination key")?;
        if receipt.source_etag.is_empty() || receipt.destination_etag.is_empty() {
            return Err("Copy receipts must contain non-empty ETags".to_string());
        }
        if !source_keys.insert(receipt.source_key.clone())
            || !destination_keys.insert(receipt.destination_key.clone())
        {
            return Err("Copy receipts contain duplicate keys".to_string());
        }
    }

    let provider = client.provider();
    if let Some(receipt) = receipts.first() {
        require_conditional_delete_support(provider, &receipt.source_key)?;
    }

    let mutation_scopes = receipts
        .iter()
        .flat_map(|receipt| {
            [
                crate::S3MutationScope::key(&connection_id, &src_bucket, &receipt.source_key),
                crate::S3MutationScope::key(&connection_id, &dst_bucket, &receipt.destination_key),
            ]
        })
        .collect();
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(mutation_scopes, &cancel).await?;
    delete_move_receipts_checked(
        &client,
        &src_bucket,
        &dst_bucket,
        &receipts,
        provider,
        &cancel,
    )
    .await
}

#[tauri::command]
pub(crate) async fn rename_prefix(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    old_prefix: String,
    new_prefix: String,
    overwrite: bool,
    transfer_id: Option<u32>,
) -> Result<u32, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, transfer_id)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_prefix(&old_prefix, "Source prefix")?;
    validate_mutating_prefix(&new_prefix, "Destination prefix")?;
    if prefixes_overlap(&old_prefix, &new_prefix) {
        return Err("Source and destination prefixes overlap; move was refused.".to_string());
    }
    let provider = client.provider();
    require_conditional_delete_support(provider, &old_prefix)?;
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![
            crate::S3MutationScope::prefix(&connection_id, &bucket, &old_prefix),
            crate::S3MutationScope::prefix(&connection_id, &bucket, &new_prefix),
        ],
        &cancel,
    )
    .await?;

    if !overwrite && prefix_has_content(&client, &bucket, &new_prefix, &cancel).await? {
        return Err(format!(
            "Destination prefix '{}' already exists. Rename with overwrite to replace it.",
            new_prefix
        ));
    }

    let receipts = copy_prefix_objects(
        &client,
        &bucket,
        &old_prefix,
        &bucket,
        &new_prefix,
        overwrite,
        true,
        provider,
        &cancel,
    )
    .await?;

    delete_move_receipts_checked(&client, &bucket, &bucket, &receipts, provider, &cancel).await
}

/// Copy a single object to a (possibly different) bucket/key without deleting the source.
#[tauri::command]
pub(crate) async fn copy_object_to(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    src_key: String,
    dst_bucket: String,
    dst_key: String,
    overwrite: Option<bool>,
    transfer_id: Option<u32>,
    require_immutable_source_version: Option<bool>,
    automatic_move: Option<bool>,
) -> Result<CopyReceipt, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, transfer_id)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&src_bucket)?;
    validate_bucket_name(&dst_bucket)?;
    validate_readable_key(&src_key, "Source key")?;
    // Copying out of the backup namespace is how a user restores data from an
    // interrupted operation, so only the destination is restricted.
    validate_mutating_key(&dst_key, "Destination key")?;
    let provider = client.provider();
    let require_immutable_source_version = require_immutable_source_version.unwrap_or(false);
    let automatic_move = automatic_move.unwrap_or(false);
    if require_immutable_source_version || automatic_move {
        require_conditional_delete_support(provider, &src_key)?;
    }
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![
            crate::S3MutationScope::key(&connection_id, &src_bucket, &src_key),
            crate::S3MutationScope::key(&connection_id, &dst_bucket, &dst_key),
        ],
        &cancel,
    )
    .await?;
    let overwrite = overwrite.unwrap_or(false);

    if !overwrite && destination_object_exists(&client, &dst_bucket, &dst_key, &cancel).await? {
        return Err(format!(
            "Destination '{}' now exists and overwrite was not authorized.",
            dst_key
        ));
    }

    let source_info = if require_immutable_source_version {
        Some(describe_immutable_move_source(&client, &src_bucket, &src_key, &cancel).await?)
    } else if automatic_move {
        let source_version =
            preflight_optional_move_version(&client, &src_bucket, &src_key, &cancel).await?;
        Some(
            describe_object(
                &client,
                &src_bucket,
                &src_key,
                source_version.as_deref(),
                &cancel,
            )
            .await?,
        )
    } else {
        None
    };
    copy_with_receipt(
        &client,
        &src_bucket,
        &src_key,
        &dst_bucket,
        &dst_key,
        source_info,
        overwrite,
        provider,
        &cancel,
    )
    .await
}

/// Copy all objects under a prefix to a new prefix (possibly in a different bucket)
/// without deleting the originals.
#[tauri::command]
pub(crate) async fn copy_prefix_to(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    src_bucket: String,
    src_prefix: String,
    dst_bucket: String,
    dst_prefix: String,
    overwrite: Option<bool>,
    transfer_id: Option<u32>,
    collect_receipts: Option<bool>,
) -> Result<Vec<CopyReceipt>, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, transfer_id)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&src_bucket)?;
    validate_bucket_name(&dst_bucket)?;
    validate_mutating_prefix(&src_prefix, "Source prefix")?;
    validate_mutating_prefix(&dst_prefix, "Destination prefix")?;
    if src_bucket == dst_bucket && prefixes_overlap(&src_prefix, &dst_prefix) {
        return Err("Source and destination prefixes overlap; copy was refused.".to_string());
    }
    let provider = client.provider();
    if collect_receipts.unwrap_or(false) {
        require_conditional_delete_support(provider, &src_prefix)?;
    }
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![
            crate::S3MutationScope::prefix(&connection_id, &src_bucket, &src_prefix),
            crate::S3MutationScope::prefix(&connection_id, &dst_bucket, &dst_prefix),
        ],
        &cancel,
    )
    .await?;
    let overwrite = overwrite.unwrap_or(false);

    copy_prefix_objects(
        &client,
        &src_bucket,
        &src_prefix,
        &dst_bucket,
        &dst_prefix,
        overwrite,
        collect_receipts.unwrap_or(false),
        provider,
        &cancel,
    )
    .await
}
