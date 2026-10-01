//! Prefix copy transactions and receipt-checked source deletion.

use super::*;
use std::future::Future;
use std::pin::Pin;

type PrefixCopyAfterItem =
    Box<dyn FnMut(usize) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + 'static>;

pub(super) async fn copy_prefix_objects(
    client: &Client,
    src_bucket: &str,
    src_prefix: &str,
    dst_bucket: &str,
    dst_prefix: &str,
    overwrite: bool,
    collect_receipts: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<Vec<CopyReceipt>, String> {
    copy_prefix_objects_inner(
        client,
        src_bucket,
        src_prefix,
        dst_bucket,
        dst_prefix,
        overwrite,
        collect_receipts,
        provider,
        cancel,
        None,
    )
    .await
}

async fn copy_prefix_objects_inner(
    client: &Client,
    src_bucket: &str,
    src_prefix: &str,
    dst_bucket: &str,
    dst_prefix: &str,
    overwrite: bool,
    collect_receipts: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
    mut after_item: Option<PrefixCopyAfterItem>,
) -> Result<Vec<CopyReceipt>, String> {
    ensure_no_orphaned_rollback_backups(client, dst_bucket, cancel).await?;
    let source_plan = preflight_prefix_copy_sources(
        client,
        src_bucket,
        src_prefix,
        dst_bucket,
        dst_prefix,
        collect_receipts,
        cancel,
    )
    .await?;

    preflight_prefix_overwrite_rollback(
        client,
        dst_bucket,
        &source_plan,
        overwrite,
        provider,
        cancel,
    )
    .await?;

    let namespace_guard = RollbackNamespaceGuard::new();
    let namespace = namespace_guard.namespace.clone();
    let mut created_destinations = Vec::new();
    let mut backups = Vec::new();
    let mut receipts = Vec::new();

    for (index, source) in source_plan.into_iter().enumerate() {
        let key = source.source_key;
        let new_key = source.destination_key;
        let source_version_id = source.immutable_version_id;
        if cancel.is_cancelled() {
            let failures = rollback_prefix_copy(
                client,
                dst_bucket,
                &created_destinations,
                &backups,
                provider,
            )
            .await;
            return Err(rollback_error(cancelled_error(), failures));
        }

        let destination_head_request = client.head_object().bucket(dst_bucket).key(&new_key).send();
        let destination_head = tokio::select! {
            _ = cancel.cancelled() => {
                let failures = rollback_prefix_copy(client, dst_bucket, &created_destinations, &backups, provider).await;
                return Err(rollback_error(cancelled_error(), failures));
            }
            result = destination_head_request => result,
        };

        let destination_was_absent = match destination_head {
            Ok(_) if !overwrite => {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(
                    format!(
                        "Destination '{}' now exists and overwrite was not authorized.",
                        new_key
                    ),
                    failures,
                ));
            }
            Ok(_) => {
                if !supports_conditional_delete(provider) {
                    if let Err(err) =
                        require_versioned_prefix_rollback(client, dst_bucket, &new_key, cancel)
                            .await
                    {
                        let failures = rollback_prefix_copy(
                            client,
                            dst_bucket,
                            &created_destinations,
                            &backups,
                            provider,
                        )
                        .await;
                        return Err(rollback_error(err, failures));
                    }
                }
                let destination_info =
                    match describe_source(client, dst_bucket, &new_key, cancel).await {
                        Ok(info) => info,
                        Err(err) => {
                            let failures = rollback_prefix_copy(
                                client,
                                dst_bucket,
                                &created_destinations,
                                &backups,
                                provider,
                            )
                            .await;
                            return Err(rollback_error(err, failures));
                        }
                    };
                let backup_key = format!("{}{}/{}", ROLLBACK_BACKUP_PREFIX, namespace, index);
                let backup_probe = client
                    .head_object()
                    .bucket(dst_bucket)
                    .key(&backup_key)
                    .send();
                let backup_probe_result = tokio::select! {
                    _ = cancel.cancelled() => {
                        let failures = rollback_prefix_copy(client, dst_bucket, &created_destinations, &backups, provider).await;
                        return Err(rollback_error(cancelled_error(), failures));
                    }
                    result = backup_probe => result,
                };
                match backup_probe_result {
                    Ok(_) => {
                        let failures = rollback_prefix_copy(
                            client,
                            dst_bucket,
                            &created_destinations,
                            &backups,
                            provider,
                        )
                        .await;
                        return Err(rollback_error(
                            format!("Rollback backup key '{}' already exists", backup_key),
                            failures,
                        ));
                    }
                    Err(err) if is_not_found(&err) => {}
                    Err(err) => {
                        let failures = rollback_prefix_copy(
                            client,
                            dst_bucket,
                            &created_destinations,
                            &backups,
                            provider,
                        )
                        .await;
                        return Err(rollback_error(
                            format!(
                                "Failed to reserve rollback backup '{}': {}",
                                backup_key, err
                            ),
                            failures,
                        ));
                    }
                }

                let backup_receipt = match copy_with_receipt(
                    client,
                    dst_bucket,
                    &new_key,
                    dst_bucket,
                    &backup_key,
                    Some(destination_info.clone()),
                    true,
                    provider,
                    cancel,
                )
                .await
                {
                    Ok(receipt) => receipt,
                    Err(err) => {
                        // The backup copy may already have committed. Without
                        // an operation-owned identity, deleting this key could
                        // remove the only recoverable copy or a concurrent
                        // writer, so retain it and report the ambiguity.
                        let failures = rollback_prefix_copy(
                            client,
                            dst_bucket,
                            &created_destinations,
                            &backups,
                            provider,
                        )
                        .await;
                        return Err(rollback_error(
                            format!("Failed to back up destination '{}': {}", new_key, err),
                            failures,
                        ));
                    }
                };
                let mut backup_info = destination_info.clone();
                backup_info.etag = Some(backup_receipt.destination_etag);
                backup_info.version_id = backup_receipt.destination_version_id;
                backups.push(DestinationBackup {
                    destination_key: new_key.clone(),
                    backup_key,
                    original_info: destination_info,
                    source_info: backup_info,
                    replacement: None,
                });
                if !supports_conditional_delete(provider)
                    && immutable_version_id(
                        backups
                            .last()
                            .and_then(|backup| backup.source_info.version_id.as_deref()),
                    )
                    .is_none()
                {
                    let failures = rollback_prefix_copy(
                        client,
                        dst_bucket,
                        &created_destinations,
                        &backups,
                        provider,
                    )
                    .await;
                    return Err(rollback_error(
                        format!(
                            "Provider did not return an immutable version ID for rollback backup of '{}'; the existing destination was not replaced.",
                            new_key
                        ),
                        failures,
                    ));
                }
                false
            }
            Err(err) if is_not_found(&err) => true,
            Err(err) => {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(
                    format!("Failed to check destination '{}': {}", new_key, err),
                    failures,
                ));
            }
        };

        let source_info_result = match source_version_id.as_deref() {
            Some(version_id) => {
                describe_object(client, src_bucket, &key, Some(version_id), cancel).await
            }
            None => describe_source(client, src_bucket, &key, cancel).await,
        };
        let source_info = match source_info_result {
            Ok(info) => info,
            Err(err) => {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(err, failures));
            }
        };
        if !destination_was_absent && !supports_conditional_delete(provider) {
            if let Err(err) =
                require_versioned_prefix_rollback(client, dst_bucket, &new_key, cancel).await
            {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(err, failures));
            }
        }
        match copy_with_receipt(
            client,
            src_bucket,
            &key,
            dst_bucket,
            &new_key,
            Some(source_info),
            overwrite,
            provider,
            cancel,
        )
        .await
        {
            Ok(receipt) => {
                if destination_was_absent {
                    created_destinations.push(receipt.clone());
                } else if let Some(backup) = backups.last_mut() {
                    if backup.destination_key == new_key {
                        backup.replacement = Some(receipt.clone());
                    }
                }
                if collect_receipts {
                    receipts.push(receipt);
                }
                if let Some(after_item) = after_item.as_mut() {
                    after_item(index).await;
                }
            }
            Err(err) => {
                let failures = rollback_prefix_copy(
                    client,
                    dst_bucket,
                    &created_destinations,
                    &backups,
                    provider,
                )
                .await;
                return Err(rollback_error(err, failures));
            }
        }
    }

    // Try every backup before reporting. Stopping at the first failure used to
    // leave the remaining backups in the bucket without ever naming them, so the
    // user could not tell which objects to clean up or restore from.
    let mut cleanup_failures = Vec::new();
    let mut retained_backups = Vec::new();
    for backup in &backups {
        if let Err(err) = remove_backup_object(client, dst_bucket, backup, provider).await {
            cleanup_failures.push(err);
            retained_backups.push(backup.backup_key.clone());
        }
    }
    if !cleanup_failures.is_empty() {
        return Err(format!(
            "Every copy completed and no source was touched, but {} rollback backup(s) could not \
             be removed: {}. Those objects are copies of destinations this operation successfully \
             replaced, so they are safe to delete, and doing so is required before retrying. ({})",
            retained_backups.len(),
            cleanup_failures.join("; "),
            retained_backups.join(", ")
        ));
    }

    Ok(receipts)
}

async fn preflight_prefix_overwrite_rollback(
    client: &Client,
    dst_bucket: &str,
    source_plan: &[PrefixCopySource],
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<(), String> {
    if !overwrite || supports_conditional_delete(provider) {
        return Ok(());
    }

    let mut has_existing_destination = false;
    for source in source_plan {
        let destination_head = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = client.head_object().bucket(dst_bucket).key(&source.destination_key).send() => result,
        };
        match destination_head {
            Ok(_) => has_existing_destination = true,
            Err(err) if is_not_found(&err) => {}
            Err(err) => {
                return Err(format!(
                    "Refusing prefix overwrite before mutation because destination '{}' could not be classified: {}",
                    source.destination_key, err
                ));
            }
        }
    }

    if has_existing_destination {
        require_versioned_prefix_rollback(client, dst_bucket, "prefix destination", cancel)
            .await
            .map_err(|err| format!("Refusing prefix overwrite before mutation: {}", err))?;
    }
    Ok(())
}

async fn require_versioned_prefix_rollback(
    client: &Client,
    dst_bucket: &str,
    key: &str,
    cancel: &CancelToken,
) -> Result<(), String> {
    let versioning = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = client.get_bucket_versioning().bucket(dst_bucket).send() => result.map_err(|err| {
            format!("Could not verify bucket versioning for rollback of '{}': {}", key, err)
        })?,
    };
    if versioning.status() == Some(&aws_sdk_s3::types::BucketVersioningStatus::Enabled) {
        Ok(())
    } else {
        Err(format!(
            "Prefix overwrite rollback for '{}' requires an enabled versioned bucket (bucket versioning Enabled) because this provider cannot enforce conditional DELETE; no unsafe rollback will be attempted.",
            key
        ))
    }
}

/// Real-provider fault injection for rollback after one completed prefix item.
/// The second source is removed only after the first replacement and its
/// rollback backup have been recorded by the production transaction path.
#[cfg(test)]
pub(crate) async fn e2e_copy_prefix_with_failure_after_first(
    client: &Client,
    bucket: &str,
    cancel: &CancelToken,
    provider: StorageProviderKind,
) -> Result<(), String> {
    let fault_client = client.clone();
    let fault_bucket = bucket.to_string();
    let hook: PrefixCopyAfterItem = Box::new(move |index| {
        let client = fault_client.clone();
        let bucket = fault_bucket.clone();
        Box::pin(async move {
            if index == 0 {
                let _ = client
                    .delete_object()
                    .bucket(bucket)
                    .key("src/b.txt")
                    .send()
                    .await;
            }
        })
    });
    copy_prefix_objects_inner(
        client,
        bucket,
        "src/",
        bucket,
        "dst/",
        true,
        false,
        provider,
        cancel,
        Some(hook),
    )
    .await
    .map(|_| ())
}

/// Exercise the unversioned transaction path against a populated provider
/// fixture. Tests pass only when the function refuses before any DELETE.
#[cfg(test)]
pub(crate) async fn e2e_delete_move_receipts_checked(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    receipts: &[CopyReceipt],
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<u32, String> {
    delete_move_receipts_checked(client, src_bucket, dst_bucket, receipts, provider, cancel).await
}

pub(super) async fn current_identity_matches(
    client: &Client,
    bucket: &str,
    key: &str,
    expected_etag: &str,
    request_version_id: Option<&str>,
    expected_version_id: Option<&str>,
    expected_fingerprint: Option<&str>,
    cancel: &CancelToken,
) -> Result<Option<bool>, String> {
    let mut request = client.head_object().bucket(bucket).key(key);
    if let Some(version_id) = request_version_id {
        request = request.version_id(version_id);
    }
    let request = request.send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };

    match result {
        Ok(head) => {
            let etag_matches = head.e_tag() == Some(expected_etag);
            let version_matches = expected_version_id
                .map(|expected| head.version_id() == Some(expected))
                .unwrap_or(true);
            let fingerprint_matches = expected_fingerprint
                .map(|expected| head_generation_fingerprint(&head) == expected)
                .unwrap_or(true);
            Ok(Some(etag_matches && version_matches && fingerprint_matches))
        }
        Err(err) if is_not_found(&err) => Ok(None),
        Err(err) => Err(format!("Failed to verify '{}': {}", key, err)),
    }
}

pub(super) async fn current_source_identity_matches(
    client: &Client,
    bucket: &str,
    key: &str,
    expected_etag: &str,
    request_version_id: Option<&str>,
    expected_version_id: Option<&str>,
    expected_head_fingerprint: &str,
    expected_acl_fingerprint: &str,
    expected_tag_fingerprint: &str,
    cancel: &CancelToken,
) -> Result<Option<bool>, String> {
    let mut request = client.head_object().bucket(bucket).key(key);
    if let Some(version_id) = request_version_id {
        request = request.version_id(version_id);
    }
    let request = request.send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };

    let head = match result {
        Ok(head) => head,
        Err(err) if is_not_found(&err) => return Ok(None),
        Err(err) => return Err(format!("Failed to verify '{}': {}", key, err)),
    };
    let head_matches = head.e_tag() == Some(expected_etag)
        && expected_version_id
            .map(|expected| head.version_id() == Some(expected))
            .unwrap_or(true)
        && head_generation_fingerprint(&head) == expected_head_fingerprint;
    if !head_matches {
        return Ok(Some(false));
    }

    // Pin attribute reads to the generation returned by HEAD whenever the
    // provider exposes one. On unversioned buckets these reads remain protected
    // from app-local mutations by the caller's mutation lease.
    let attribute_version_id = request_version_id
        .map(str::to_string)
        .or_else(|| head.version_id().map(str::to_string));
    let attributes = async {
        tokio::join!(
            acl_fingerprint_for_object(client, bucket, key, attribute_version_id.as_deref()),
            source_tag_state_for_object(client, bucket, key, attribute_version_id.as_deref())
        )
    };
    let (acl_fingerprint, tag_state) = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = attributes => result,
    };
    Ok(Some(
        acl_fingerprint? == expected_acl_fingerprint
            && tag_state?.fingerprint == expected_tag_fingerprint,
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SourceDeleteDecision {
    AlreadyDeleted,
    Delete,
    Changed,
}

/// Decide what a resumed versioned move should do with one recorded source.
///
/// `exact_version` is the HEAD of the exact version that was copied, and
/// `current_version` is the HEAD of the key without a version, i.e. whatever is
/// current now. `None` means the request answered 404.
///
/// A versioned source is retired by writing a delete marker over the key rather
/// than by permanently erasing the copied version (see
/// `delete_receipts_checked`), so the copied version still exists after a
/// successful move and the *absence of a current object* is what proves the
/// deletion already happened. Both "the copied version is gone" and "the copied
/// version is still there but nothing is current" are therefore completed work,
/// while any other object being current means the key moved on and the move must
/// fail closed instead of destroying an unrelated write.
pub(super) fn classify_versioned_source_for_delete(
    exact_version: Option<bool>,
    current_version: Option<bool>,
) -> SourceDeleteDecision {
    match (exact_version, current_version) {
        (None, _) => SourceDeleteDecision::AlreadyDeleted,
        (Some(false), _) => SourceDeleteDecision::Changed,
        (Some(true), Some(true)) => SourceDeleteDecision::Delete,
        (Some(true), None) => SourceDeleteDecision::AlreadyDeleted,
        (Some(true), Some(false)) => SourceDeleteDecision::Changed,
    }
}

pub(super) async fn classify_receipt_source_for_delete(
    client: &Client,
    bucket: &str,
    receipt: &CopyReceipt,
    cancel: &CancelToken,
) -> Result<SourceDeleteDecision, String> {
    let version_id =
        immutable_version_id(receipt.source_version_id.as_deref()).ok_or_else(|| {
            format!(
                "Source '{}' has no immutable version ID; source deletion was refused.",
                receipt.source_key
            )
        })?;
    let exact = current_source_identity_matches(
        client,
        bucket,
        &receipt.source_key,
        &receipt.source_etag,
        Some(version_id),
        Some(version_id),
        &receipt.source_fingerprint,
        &receipt.source_acl_fingerprint,
        &receipt.source_tag_fingerprint,
        cancel,
    )
    .await?;
    let current = if exact == Some(true) {
        current_source_identity_matches(
            client,
            bucket,
            &receipt.source_key,
            &receipt.source_etag,
            None,
            Some(version_id),
            &receipt.source_fingerprint,
            &receipt.source_acl_fingerprint,
            &receipt.source_tag_fingerprint,
            cancel,
        )
        .await?
    } else {
        None
    };
    Ok(classify_versioned_source_for_delete(exact, current))
}

pub(super) async fn delete_receipts_checked(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    receipts: &[CopyReceipt],
    cancel: &CancelToken,
) -> Result<u32, String> {
    // This runs only after the caller has acquired the full source/destination
    // mutation lease. Legacy or malformed receipts must not authorize even the
    // first remote identity read, much less a source deletion.
    validate_receipt_fingerprints(receipts)?;

    // Validate every destination before deleting any source. A stale manifest
    // or a destination replaced after the copy must fail closed.
    for receipt in receipts {
        match current_source_identity_matches(
            client,
            dst_bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            None,
            receipt.destination_version_id.as_deref(),
            &receipt.destination_fingerprint,
            &receipt.destination_acl_fingerprint,
            &receipt.destination_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Destination '{}' no longer matches the copy receipt; source deletion was refused.",
                    receipt.destination_key
                ));
            }
            None => {
                return Err(format!(
                    "Destination '{}' no longer exists; source deletion was refused.",
                    receipt.destination_key
                ));
            }
        }
    }

    // Check the complete receipt set before the first deletion so a conflict
    // cannot leave a preventable partial move. Every receipt must bind an exact
    // non-null immutable source version; mutable null-version and unversioned
    // receipts use the separate, provider-gated ETag path or fail closed.
    let mut present = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        match classify_receipt_source_for_delete(client, src_bucket, receipt, cancel).await? {
            SourceDeleteDecision::AlreadyDeleted => present.push(false),
            SourceDeleteDecision::Delete => present.push(true),
            SourceDeleteDecision::Changed => {
                return Err(format!(
                    "Source '{}' changed after it was copied; deletion was refused.",
                    receipt.source_key
                ));
            }
        }
    }

    let mut deleted = 0u32;
    for (receipt, exists) in receipts.iter().zip(present) {
        if !exists {
            continue;
        }
        // Revalidate the paired destination at the last possible point. The
        // app-owned keyspace lease prevents another local writer from changing
        // it after this check; an external change observed here fails closed.
        match current_source_identity_matches(
            client,
            dst_bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            None,
            receipt.destination_version_id.as_deref(),
            &receipt.destination_fingerprint,
            &receipt.destination_acl_fingerprint,
            &receipt.destination_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Destination '{}' changed before source deletion; deletion was refused.",
                    receipt.destination_key
                ));
            }
            None => {
                return Err(format!(
                    "Destination '{}' disappeared before source deletion; deletion was refused.",
                    receipt.destination_key
                ));
            }
        }
        match classify_receipt_source_for_delete(client, src_bucket, receipt, cancel).await? {
            SourceDeleteDecision::Delete => {}
            SourceDeleteDecision::AlreadyDeleted => continue,
            SourceDeleteDecision::Changed => {
                return Err(format!(
                    "Source '{}' changed immediately before deletion; deletion was refused.",
                    receipt.source_key
                ));
            }
        }
        // Delete the key, not the copied version ID. Version-targeted deletion is
        // permanent, while deleting the key creates a recoverable delete marker.
        // The exact immutable version and current-key state were both rechecked
        // immediately above; unversioned receipts never reach this point.
        let request = client
            .delete_object()
            .bucket(src_bucket)
            .key(&receipt.source_key)
            .if_match(&receipt.source_etag)
            .send();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result,
        };
        result.map_err(|err| {
            format!(
                "Copied successfully but conditional deletion of source '{}' failed: {}",
                receipt.source_key, err
            )
        })?;
        deleted += 1;
    }

    Ok(deleted)
}

pub(super) fn validate_unversioned_receipt_fingerprints(
    receipts: &[CopyReceipt],
) -> Result<(), String> {
    for receipt in receipts {
        if readable_version_id(receipt.source_version_id.as_deref())
            .is_some_and(|version_id| version_id.eq_ignore_ascii_case("null"))
        {
            return Err(format!(
                "Source '{}' has a mutable null version ID; source deletion was refused.",
                receipt.source_key
            ));
        }
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
        if receipt.source_etag.trim().is_empty() || receipt.destination_etag.trim().is_empty() {
            return Err(format!(
                "Copy receipt for source '{}' is missing source or destination ETags; source deletion was refused.",
                receipt.source_key
            ));
        }
    }
    Ok(())
}

/// Delete move sources on buckets without immutable versioning.
///
/// The versioned path binds deletion authority to an immutable version ID.
/// Here the ETag plus the full HEAD/ACL/tag fingerprint is the identity. The
/// complete source set is classified before the first DELETE, then each source
/// is rechecked immediately before deletion. A verified provider must enforce
/// the final ETag `If-Match`; the app-local mutation lease cannot block external
/// writers.
pub(super) async fn delete_unversioned_receipts_checked(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    receipts: &[CopyReceipt],
    cancel: &CancelToken,
) -> Result<u32, String> {
    validate_unversioned_receipt_fingerprints(receipts)?;

    for receipt in receipts {
        match current_source_identity_matches(
            client,
            dst_bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            None,
            None,
            &receipt.destination_fingerprint,
            &receipt.destination_acl_fingerprint,
            &receipt.destination_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Destination '{}' no longer matches the copy receipt; source deletion was refused.",
                    receipt.destination_key
                ));
            }
            None => {
                return Err(format!(
                    "Destination '{}' no longer exists; source deletion was refused.",
                    receipt.destination_key
                ));
            }
        }
    }

    // Classify every source before the first DELETE. This prevents a conflict
    // already visible on a later receipt from leaving an avoidable partial move.
    let mut source_present = Vec::with_capacity(receipts.len());
    for receipt in receipts {
        match current_source_identity_matches(
            client,
            src_bucket,
            &receipt.source_key,
            &receipt.source_etag,
            None,
            None,
            &receipt.source_fingerprint,
            &receipt.source_acl_fingerprint,
            &receipt.source_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => source_present.push(true),
            Some(false) => {
                return Err(format!(
                    "Source '{}' changed after it was copied; deletion was refused.",
                    receipt.source_key
                ));
            }
            None => source_present.push(false),
        }
    }

    let mut deleted = 0u32;
    for (receipt, present) in receipts.iter().zip(source_present) {
        if !present {
            continue;
        }
        // Revalidate the source at the last possible point, like the versioned
        // path does. `None` means someone else already deleted it, which
        // completes the move; `Some(false)` is a concurrent change and fails
        // closed.
        match current_source_identity_matches(
            client,
            src_bucket,
            &receipt.source_key,
            &receipt.source_etag,
            None,
            None,
            &receipt.source_fingerprint,
            &receipt.source_acl_fingerprint,
            &receipt.source_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Source '{}' changed after it was copied; deletion was refused.",
                    receipt.source_key
                ));
            }
            None => continue,
        }
        // Revalidate the paired destination again under the same lease before
        // each deletion, so a conflict cannot leave a partial move.
        match current_source_identity_matches(
            client,
            dst_bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            None,
            None,
            &receipt.destination_fingerprint,
            &receipt.destination_acl_fingerprint,
            &receipt.destination_tag_fingerprint,
            cancel,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => {
                return Err(format!(
                    "Destination '{}' changed before source deletion; deletion was refused.",
                    receipt.destination_key
                ));
            }
            None => {
                return Err(format!(
                    "Destination '{}' disappeared before source deletion; deletion was refused.",
                    receipt.destination_key
                ));
            }
        }
        let request = client
            .delete_object()
            .bucket(src_bucket)
            .key(&receipt.source_key)
            .if_match(&receipt.source_etag)
            .send();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result,
        };
        match result {
            Ok(_) => deleted += 1,
            Err(err) if is_not_found(&err) => {
                // Lost a race with an external deleter after the checks above;
                // the source is gone, so the move is complete.
            }
            Err(err) => {
                use aws_sdk_s3::error::SdkError;
                let precondition_failed = matches!(&err, SdkError::ServiceError(ctx)
                    if ctx.raw().status().as_u16() == 412);
                if precondition_failed {
                    return Err(format!(
                        "Source '{}' changed immediately before deletion; deletion was refused.",
                        receipt.source_key
                    ));
                }
                return Err(format!(
                    "Copied successfully but conditional deletion of source '{}' failed: {}",
                    receipt.source_key, err
                ));
            }
        }
    }

    Ok(deleted)
}

/// Route move-source deletion by receipt kind: the exact-version path when
/// every receipt binds an immutable version, the ETag-pinned path when none
/// does. A mixed set fails closed — it indicates receipts from different
/// bucket generations that must not authorize each other's deletions.
pub(super) async fn delete_move_receipts_checked(
    client: &Client,
    src_bucket: &str,
    dst_bucket: &str,
    receipts: &[CopyReceipt],
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<u32, String> {
    if receipts.is_empty() {
        return Ok(0);
    }
    require_conditional_delete_support(provider, &receipts[0].source_key)?;

    let versioned = receipts
        .iter()
        .filter(|receipt| immutable_version_id(receipt.source_version_id.as_deref()).is_some())
        .count();
    if versioned == receipts.len() {
        delete_receipts_checked(client, src_bucket, dst_bucket, receipts, cancel).await
    } else if versioned == 0 {
        delete_unversioned_receipts_checked(client, src_bucket, dst_bucket, receipts, cancel).await
    } else {
        Err(
            "Move receipts mix versioned and unversioned sources; source deletion was refused."
                .to_string(),
        )
    }
}
