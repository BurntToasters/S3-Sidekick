//! Rollback backups and prefix-copy rollback.

use super::*;

/// Copy every object under `src_prefix` to `dst_prefix` as one rollback-safe
/// transaction and return the exact source/destination identities copied.
pub(super) struct DestinationBackup {
    pub(super) destination_key: String,
    pub(super) backup_key: String,
    /// Identity and metadata of the original destination before replacement.
    pub(super) original_info: SourceObjectInfo,
    /// Identity of the separately copied rollback object.
    pub(super) source_info: SourceObjectInfo,
    /// Response-owned identity of the replacement written by this transaction.
    pub(super) replacement: Option<CopyReceipt>,
}

pub(super) const ROLLBACK_BACKUP_PREFIX: &str = ".s3-sidekick-rollback/";

/// Rollback namespaces belonging to prefix operations running right now.
///
/// Transfers run several workers concurrently, so a peer operation's backups are
/// expected to be present and must not be mistaken for abandoned ones.
pub(super) fn active_rollback_namespaces() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Registers a namespace for the lifetime of one prefix operation.
pub(super) struct RollbackNamespaceGuard {
    pub(super) namespace: String,
}

impl RollbackNamespaceGuard {
    pub(super) fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = ROLLBACK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let namespace = format!("{}-{}-{}", std::process::id(), timestamp, sequence);
        if let Ok(mut active) = active_rollback_namespaces().lock() {
            active.insert(namespace.clone());
        }
        Self { namespace }
    }
}

impl Drop for RollbackNamespaceGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = active_rollback_namespaces().lock() {
            active.remove(&self.namespace);
        }
    }
}

pub(super) fn namespace_of_backup_key(key: &str) -> Option<&str> {
    key.strip_prefix(ROLLBACK_BACKUP_PREFIX)
        .and_then(|rest| rest.split('/').next())
        .filter(|namespace| !namespace.is_empty())
}

/// Refuse to start a prefix copy while backups from an abandoned attempt survive.
///
/// The backup set only exists in memory for the duration of a call, so a crash
/// leaves the originals reachable solely through their backup objects. Starting
/// again would back up the already-overwritten copies and make the surviving
/// originals unreachable, so an interrupted attempt has to be resolved first.
/// Backups belonging to an operation still running in this process are skipped:
/// they are not abandoned, and reporting them would invite a user to delete data
/// a live operation is depending on.
pub(super) async fn ensure_no_orphaned_rollback_backups(
    client: &Client,
    bucket: &str,
    cancel: &CancelToken,
) -> Result<(), String> {
    let before_listing = active_rollback_namespaces()
        .lock()
        .map_err(|_| "Internal rollback namespace state error".to_string())?
        .clone();
    let existing =
        list_all_keys_under_prefix(client, bucket, ROLLBACK_BACKUP_PREFIX, cancel).await?;
    if existing.is_empty() {
        return Ok(());
    }

    // Union the membership seen before and after the listing. A peer operation
    // that started or finished while the LIST was in flight would otherwise look
    // abandoned, aborting this operation over keys that are either still in use
    // or already gone.
    let mut active = before_listing;
    active.extend(
        active_rollback_namespaces()
            .lock()
            .map_err(|_| "Internal rollback namespace state error".to_string())?
            .iter()
            .cloned(),
    );
    let abandoned: Vec<&String> = existing
        .iter()
        .filter(|key| {
            namespace_of_backup_key(key)
                .map(|namespace| !active.contains(namespace))
                .unwrap_or(true)
        })
        .collect();
    if abandoned.is_empty() {
        return Ok(());
    }

    let sample: Vec<&str> = abandoned.iter().take(3).map(|key| key.as_str()).collect();
    Err(format!(
        "Bucket '{}' still holds {} rollback backup object(s) from an interrupted copy or move. \
         They may hold the only copy of data that was overwritten. Check them under '{}' and \
         restore or remove them before retrying, and only while no other transfer is running. ({})",
        bucket,
        abandoned.len(),
        ROLLBACK_BACKUP_PREFIX,
        sample.join(", ")
    ))
}

pub(super) fn rollback_error(original: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        original
    } else {
        format!(
            "{}. Rollback also encountered: {}. Backup objects were retained where restoration could not be confirmed.",
            original,
            failures.join("; ")
        )
    }
}

pub(super) async fn remove_backup_object(
    client: &Client,
    bucket: &str,
    backup: &DestinationBackup,
) -> Result<(), String> {
    let mut request = client
        .delete_object()
        .bucket(bucket)
        .key(&backup.backup_key);
    if let Some(version_id) = backup.source_info.version_id.as_deref() {
        request = request.version_id(version_id);
    } else if let Some(etag) = backup
        .source_info
        .etag
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.if_match(etag);
    }
    request
        .send()
        .await
        .map_err(|err| format!("failed to remove backup '{}': {}", backup.backup_key, err))?;
    Ok(())
}

/// The version ID a rollback may delete by version. `"null"` pins a read
/// (see `immutable_version_id`), but in a bucket with versioning suspended a
/// write replaces the null version in place, so a version-targeted delete of
/// `"null"` would destroy data instead of undoing one write. Those receipts
/// take the unversioned (conditional delete + recreate) restore path.
pub(super) fn rollback_version_id(version_id: Option<&str>) -> Option<&str> {
    immutable_version_id(version_id).filter(|value| *value != "null")
}

/// MinIO E2E entry points for the private copy and rollback internals.
#[cfg(test)]
pub(crate) async fn e2e_copy_with_receipt(
    client: &Client,
    bucket: &str,
    src_key: &str,
    dst_key: &str,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<CopyReceipt, String> {
    copy_with_receipt(
        client, bucket, src_key, bucket, dst_key, None, false, provider, cancel,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn e2e_rollback_created_destinations(
    client: &Client,
    bucket: &str,
    created_destinations: &[CopyReceipt],
    provider: StorageProviderKind,
) -> Vec<String> {
    rollback_prefix_copy_unbounded(client, bucket, created_destinations, &[], provider).await
}

pub(super) async fn rollback_prefix_copy_unbounded(
    client: &Client,
    bucket: &str,
    created_destinations: &[CopyReceipt],
    backups: &[DestinationBackup],
    provider: StorageProviderKind,
) -> Vec<String> {
    let rollback_cancel = Arc::new(CancelFlag::default());
    let mut failures = Vec::new();

    // Restore overwritten objects first. Automatic rollback is allowed only
    // when the destination still has the response-owned identity written by
    // this transaction. Ambiguous writes or concurrent replacements retain the
    // backup for manual recovery instead of overwriting somebody else's data.
    for backup in backups.iter().rev() {
        let Some(replacement) = backup.replacement.as_ref() else {
            // The replacement write failed or was cancelled. If the destination
            // is still exactly the original, nothing was replaced and the
            // backup is redundant; keeping it would block every later prefix
            // operation in this bucket.
            let original_unchanged = match backup
                .original_info
                .etag
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(original_etag) => matches!(
                    current_source_identity_matches(
                        client,
                        bucket,
                        &backup.destination_key,
                        original_etag,
                        None,
                        backup.original_info.version_id.as_deref(),
                        &source_generation_fingerprint(&backup.original_info),
                        &backup.original_info.acl_fingerprint,
                        &backup.original_info.tag_fingerprint,
                        &rollback_cancel,
                    )
                    .await,
                    Ok(Some(true))
                ),
                None => false,
            };
            if original_unchanged {
                if let Err(err) = remove_backup_object(client, bucket, backup).await {
                    failures.push(format!(
                        "'{}' was not replaced, but {}",
                        backup.destination_key, err
                    ));
                }
                continue;
            }
            failures.push(format!(
                "could not safely restore '{}' because the replacement write has no response-owned identity; retained backup '{}'",
                backup.destination_key, backup.backup_key
            ));
            continue;
        };
        match current_source_identity_matches(
            client,
            bucket,
            &backup.destination_key,
            &replacement.destination_etag,
            None,
            replacement.destination_version_id.as_deref(),
            &replacement.destination_fingerprint,
            &replacement.destination_acl_fingerprint,
            &replacement.destination_tag_fingerprint,
            &rollback_cancel,
        )
        .await
        {
            Ok(Some(true)) => {}
            Ok(_) => {
                failures.push(format!(
                    "did not restore '{}' because it was replaced concurrently; retained backup '{}'",
                    backup.destination_key, backup.backup_key
                ));
                continue;
            }
            Err(err) => {
                failures.push(format!(
                    "could not verify replacement '{}' before rollback: {}; retained backup '{}'",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
        }

        if let Some(version_id) = rollback_version_id(replacement.destination_version_id.as_deref())
        {
            let result = client
                .delete_object()
                .bucket(bucket)
                .key(&backup.destination_key)
                .version_id(version_id)
                .if_match(&replacement.destination_etag)
                .send()
                .await;
            if let Err(err) = result {
                failures.push(format!(
                    "could not remove transaction version '{}' of '{}': {}; retained backup '{}'",
                    version_id, backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
            let Some(original_etag) = backup
                .original_info
                .etag
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                failures.push(format!(
                    "removed transaction version of '{}', but the original identity was incomplete; retained backup '{}'",
                    backup.destination_key, backup.backup_key
                ));
                continue;
            };
            let original_fingerprint = source_generation_fingerprint(&backup.original_info);
            match current_source_identity_matches(
                client,
                bucket,
                &backup.destination_key,
                original_etag,
                None,
                backup.original_info.version_id.as_deref(),
                &original_fingerprint,
                &backup.original_info.acl_fingerprint,
                &backup.original_info.tag_fingerprint,
                &rollback_cancel,
            )
            .await
            {
                Ok(Some(true)) => {}
                Ok(_) => {
                    failures.push(format!(
                        "transaction version of '{}' was removed, but the original did not become current; retained backup '{}'",
                        backup.destination_key, backup.backup_key
                    ));
                    continue;
                }
                Err(err) => {
                    failures.push(format!(
                        "could not verify restored version of '{}': {}; retained backup '{}'",
                        backup.destination_key, err, backup.backup_key
                    ));
                    continue;
                }
            }
        } else {
            let create_only_supported = if backup.source_info.size >= MULTIPART_COPY_THRESHOLD {
                require_complete_multipart_create_only_support(provider, &backup.destination_key)
            } else {
                require_copy_create_only_strategy(provider, &backup.destination_key).map(|_| ())
            };
            if let Err(err) = create_only_supported {
                failures.push(format!(
                    "could not safely restore unversioned destination '{}': {}; retained backup '{}'",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
            let delete_result = client
                .delete_object()
                .bucket(bucket)
                .key(&backup.destination_key)
                .if_match(&replacement.destination_etag)
                .send()
                .await;
            if let Err(err) = delete_result {
                failures.push(format!(
                    "could not conditionally remove transaction replacement '{}': {}; retained backup '{}'",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
            if let Err(err) = copy_one(
                client,
                bucket,
                &backup.backup_key,
                bucket,
                &backup.destination_key,
                Some(backup.source_info.clone()),
                false,
                provider,
                &rollback_cancel,
            )
            .await
            {
                failures.push(format!(
                    "could not recreate '{}' without overwriting a concurrent writer: {}; retained backup '{}'",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
        }

        if let Err(err) = remove_backup_object(client, bucket, backup).await {
            failures.push(format!("restored '{}' but {}", backup.destination_key, err));
        }
    }

    // Remove only destinations whose successful copy identity is known. The
    // conditional delete protects unversioned buckets from overwrites between
    // the original absence check and rollback; a versioned delete removes only
    // the exact version created by this operation.
    for receipt in created_destinations.iter().rev() {
        if receipt.ownership_ambiguous {
            failures.push(format!(
                "kept destination '{}': a retried copy found an identical object there, so this operation cannot prove it created it",
                receipt.destination_key
            ));
            continue;
        }
        let request_version_id = receipt.destination_version_id.as_deref();
        match current_source_identity_matches(
            client,
            bucket,
            &receipt.destination_key,
            &receipt.destination_etag,
            request_version_id,
            request_version_id,
            &receipt.destination_fingerprint,
            &receipt.destination_acl_fingerprint,
            &receipt.destination_tag_fingerprint,
            &rollback_cancel,
        )
        .await
        {
            Ok(Some(true)) => {}
            Ok(_) => {
                failures.push(format!(
                    "did not remove newly created destination '{}' because its preservation state changed",
                    receipt.destination_key
                ));
                continue;
            }
            Err(err) => {
                failures.push(format!(
                    "could not verify newly created destination '{}' before rollback: {}",
                    receipt.destination_key, err
                ));
                continue;
            }
        }
        let mut request = client
            .delete_object()
            .bucket(bucket)
            .key(&receipt.destination_key)
            .if_match(&receipt.destination_etag);
        if let Some(version_id) = rollback_version_id(receipt.destination_version_id.as_deref()) {
            request = request.version_id(version_id);
        }
        if let Err(err) = request.send().await {
            failures.push(format!(
                "could not conditionally remove newly created destination '{}': {}",
                receipt.destination_key, err
            ));
        }
    }

    failures
}

pub(super) async fn rollback_prefix_copy(
    client: &Client,
    bucket: &str,
    created_destinations: &[CopyReceipt],
    backups: &[DestinationBackup],
    provider: StorageProviderKind,
) -> Vec<String> {
    // Rollback owns the only in-memory map from overwritten destinations to
    // their backups. Dropping it on a timer can strand a partially restored
    // transaction, so once rollback begins it must be awaited to completion.
    rollback_prefix_copy_unbounded(client, bucket, created_destinations, backups, provider).await
}
