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

#[derive(serde::Serialize)]
pub(crate) struct RollbackBackupInfo {
    pub(super) namespace: String,
    pub(super) keys: Vec<String>,
    pub(super) active: bool,
}

#[allow(dead_code)] // expose to the Tauri handler; registration lives in main.rs
fn valid_rollback_namespace(namespace: &str) -> bool {
    !namespace.is_empty()
        && !namespace.contains('/')
        && !namespace.contains('\\')
        && namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// List every rollback namespace in a bucket so the user can resolve one left
/// behind by an interrupted copy or move. Namespaces belonging to an operation
/// running in this process are marked active and cannot be deleted.
#[allow(dead_code)] // expose to the Tauri handler; registration lives in main.rs
#[tauri::command]
pub(crate) async fn list_rollback_backups(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
) -> Result<Vec<RollbackBackupInfo>, String> {
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    let cancel = client.token();
    let keys =
        list_all_keys_under_prefix(&client, &bucket, ROLLBACK_BACKUP_PREFIX, &cancel).await?;
    let active = active_rollback_namespaces()
        .lock()
        .map_err(|_| "Internal rollback namespace state error".to_string())?
        .clone();
    let mut namespaces: Vec<RollbackBackupInfo> = Vec::new();
    for key in keys {
        let Some(namespace) = namespace_of_backup_key(&key).map(str::to_string) else {
            continue;
        };
        let existing = namespaces
            .iter()
            .position(|entry| entry.namespace == namespace);
        match existing {
            Some(index) => namespaces[index].keys.push(key),
            None => {
                let active_entry = active.contains(&namespace);
                namespaces.push(RollbackBackupInfo {
                    namespace,
                    keys: vec![key],
                    active: active_entry,
                });
            }
        }
    }
    namespaces.sort_by(|first, second| first.namespace.cmp(&second.namespace));
    Ok(namespaces)
}

/// Delete named orphaned rollback namespaces after a native confirmation.
///
/// The backups may hold the only copy of an overwritten destination, so this
/// never runs from the renderer silently. Active namespaces and keys outside
/// the requested namespace are refused.
#[allow(dead_code)] // expose to the Tauri handler; registration lives in main.rs
#[tauri::command]
pub(crate) async fn delete_rollback_backups(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    namespaces: Vec<String>,
) -> Result<u32, String> {
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    if namespaces.is_empty() {
        return Ok(0);
    }
    let cancel = client.token();
    let active = active_rollback_namespaces()
        .lock()
        .map_err(|_| "Internal rollback namespace state error".to_string())?
        .clone();

    let mut keys = Vec::new();
    for namespace in &namespaces {
        if !valid_rollback_namespace(namespace) {
            return Err(format!(
                "'{}' is not a valid rollback backup namespace.",
                namespace
            ));
        }
        if active.contains(namespace) {
            return Err(format!(
                "Rollback namespace '{}' belongs to a running operation and cannot be deleted.",
                namespace
            ));
        }
        let prefix = format!("{}{}/", ROLLBACK_BACKUP_PREFIX, namespace);
        for key in list_all_keys_under_prefix(&client, &bucket, &prefix, &cancel).await? {
            if namespace_of_backup_key(&key) != Some(namespace.as_str()) {
                return Err(format!(
                    "Refusing to delete '{}' because it is outside rollback namespace '{}'.",
                    key, namespace
                ));
            }
            keys.push(key);
        }
    }
    if keys.is_empty() {
        return Ok(0);
    }

    let confirmation_app = app.clone();
    let message = format!(
        "Permanently delete {} rollback backup object(s) in bucket '{}'? These may be the only \
         copy of data overwritten by an interrupted operation. Restore anything you need before \
         confirming.",
        keys.len(),
        bucket
    );
    let confirmed = tokio::task::spawn_blocking(move || {
        crate::security::confirm_security_state_change(
            &confirmation_app,
            "Delete rollback backups?",
            &message,
            "Delete backups",
        )
    })
    .await
    .map_err(|err| format!("Rollback confirmation task failed: {}", err))?;
    if !confirmed {
        return Err(crate::security::SECURITY_CONFIRMATION_CANCELLED.to_string());
    }

    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        namespaces
            .iter()
            .map(|namespace| {
                crate::S3MutationScope::prefix(
                    &connection_id,
                    &bucket,
                    &format!("{}{}/", ROLLBACK_BACKUP_PREFIX, namespace),
                )
            })
            .collect(),
        &cancel,
    )
    .await?;

    let mut deleted = 0u32;
    for chunk in keys.chunks(1000) {
        let objects = chunk
            .iter()
            .map(|key| {
                ObjectIdentifier::builder()
                    .key(key)
                    .build()
                    .map_err(|err| format!("Invalid rollback backup key '{}': {}", key, err))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(|err| format!("Rollback backup delete build failed: {}", err))?;
        let request = client
            .delete_objects()
            .bucket(&bucket)
            .delete(delete)
            .send();
        let output = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result.map_err(|err| format!(
                "Rollback backup deletion stopped after {} confirmed deletion(s): {}",
                deleted, err
            ))?,
        };
        if !output.errors().is_empty() {
            let details = output
                .errors()
                .iter()
                .take(MAX_DELETE_ERROR_DETAILS)
                .map(|err| {
                    format!(
                        "{}: {}",
                        err.key().unwrap_or("?"),
                        err.message().unwrap_or("unknown error")
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "Rollback backup deletion did not finish: {} deleted, {} failed ({}).",
                deleted,
                output.errors().len(),
                details
            ));
        }
        deleted = deleted.saturating_add(chunk.len() as u32);
    }

    Ok(deleted)
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
    provider: StorageProviderKind,
) -> Result<(), String> {
    let mut request = client
        .delete_object()
        .bucket(bucket)
        .key(&backup.backup_key);
    if let Some(version_id) = rollback_version_id(backup.source_info.version_id.as_deref()) {
        request = request.version_id(version_id);
    } else {
        require_conditional_delete_support(provider, &backup.backup_key)?;
        let etag = backup
            .source_info
            .etag
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "cannot safely remove backup '{}' without an ETag; it was retained",
                    backup.backup_key
                )
            })?;
        request = request.if_match(etag);
    }
    request
        .send()
        .await
        .map_err(|err| format!("failed to remove backup '{}': {}", backup.backup_key, err))?;
    Ok(())
}

/// The version ID a rollback may delete by version. A literal `"null"` remains
/// readable, but it can be replaced in place and cannot authorize a versioned
/// delete; it takes the conditional unversioned path instead.
pub(super) fn rollback_version_id(version_id: Option<&str>) -> Option<&str> {
    immutable_version_id(version_id)
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
                if let Err(err) = remove_backup_object(client, bucket, backup, provider).await {
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
            if let Err(err) = require_conditional_delete_support(provider, &backup.destination_key)
            {
                failures.push(format!(
                    "could not safely restore unversioned destination '{}': {}; retained backup '{}'",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
            // Stage the restore before deleting the replacement: prove the
            // backup object is still readable and unchanged, so the delete is
            // never followed by a restore that cannot find its source.
            let backup_etag = backup
                .source_info
                .etag
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let backup_ready = {
                let mut request = client.head_object().bucket(bucket).key(&backup.backup_key);
                if let Some(version_id) = backup.source_info.version_id.as_deref() {
                    request = request.version_id(version_id);
                }
                let result = tokio::select! {
                    _ = rollback_cancel.cancelled() => None,
                    result = request.send() => result.ok(),
                };
                result.is_some_and(|head| {
                    let size_matches = head.content_length() == Some(backup.source_info.size);
                    let etag_matches = backup_etag.is_none_or(|expected| {
                        head.e_tag()
                            .is_some_and(|actual| actual.trim() == expected.trim())
                    });
                    size_matches && etag_matches
                })
            };
            if !backup_ready {
                failures.push(format!(
                    "did not replace '{}' because its retained backup '{}' could not be verified as restorable",
                    backup.destination_key, backup.backup_key
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
                    "could not recreate '{}' without overwriting a concurrent writer: {}; the destination is currently missing and retained backup '{}' is its only copy",
                    backup.destination_key, err, backup.backup_key
                ));
                continue;
            }
        }

        if let Err(err) = remove_backup_object(client, bucket, backup, provider).await {
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
        let version_id = rollback_version_id(receipt.destination_version_id.as_deref());
        if version_id.is_none() {
            if let Err(err) = require_conditional_delete_support(provider, &receipt.destination_key)
            {
                failures.push(format!(
                    "kept destination '{}': {}; the unversioned rollback delete was refused",
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
        if let Some(version_id) = version_id {
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

/// Bound automatic rollback per request, never with a deadline that can strike
/// between removing a replacement and restoring its backup.
///
/// The previous implementation wrapped the whole rollback in one 180 second
/// timeout. When it fired after the conditional delete but before the restore,
/// the destination was missing and only an opaque backup remained. Individual
/// SDK attempts already carry their own timeout, so the delete/restore pair is
/// now allowed to finish and every failure names the destination/backup pair.
pub(super) async fn rollback_prefix_copy(
    client: &Client,
    bucket: &str,
    created_destinations: &[CopyReceipt],
    backups: &[DestinationBackup],
    provider: StorageProviderKind,
) -> Vec<String> {
    rollback_prefix_copy_unbounded(client, bucket, created_destinations, backups, provider).await
}
