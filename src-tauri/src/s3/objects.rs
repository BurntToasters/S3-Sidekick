//! Single-object commands: listing, metadata, ACLs, deletes, folders, URLs.

use super::*;

#[tauri::command]
pub(crate) async fn list_objects(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    prefix: String,
    delimiter: String,
    continuation_token: String,
) -> Result<ListObjectsResponse, String> {
    // Listing the bucket root with an empty prefix is legitimate, so this uses
    // the permissive validator rather than the mutating one.
    validate_bucket_name(&bucket)?;
    validate_list_prefix(&prefix, "Prefix")?;
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let mut req = client
        .list_objects_v2()
        .bucket(&bucket)
        .max_keys(1000)
        .encoding_type(EncodingType::Url);

    if !prefix.is_empty() {
        req = req.prefix(&prefix);
    }
    if !delimiter.is_empty() {
        req = req.delimiter(&delimiter);
    }
    if !continuation_token.is_empty() {
        req = req.continuation_token(&continuation_token);
    }

    let request = req.send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to list objects: {}", e))?;

    let encoding = listed_encoding(&output);
    let objects = output
        .contents()
        .iter()
        .map(|obj| {
            let key = encoding.decode(obj.key().unwrap_or_default());
            let is_folder = key.ends_with('/');
            ObjectInfo {
                key,
                size: obj.size().unwrap_or(0),
                last_modified: obj
                    .last_modified()
                    .map(|d| d.to_string())
                    .unwrap_or_default(),
                is_folder,
            }
        })
        .collect();

    let prefixes = output
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|prefix| encoding.decode(prefix)))
        .collect();

    let truncated = output.is_truncated().unwrap_or(false);
    let next_continuation_token = output.next_continuation_token().unwrap_or("").to_string();

    Ok(ListObjectsResponse {
        objects,
        prefixes,
        truncated,
        next_continuation_token,
    })
}

#[tauri::command]
pub(crate) async fn head_object(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<HeadObjectResponse, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let request = client.head_object().bucket(&bucket).key(&key).send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to get object info: {}", e))?;

    let metadata = output
        .metadata()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    Ok(HeadObjectResponse {
        content_type: output.content_type().unwrap_or("").to_string(),
        content_length: output.content_length().unwrap_or(0),
        last_modified: output
            .last_modified()
            .map(|d| d.to_string())
            .unwrap_or_default(),
        etag: output.e_tag().unwrap_or("").to_string(),
        storage_class: output
            .storage_class()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        cache_control: output.cache_control().unwrap_or("").to_string(),
        content_disposition: output.content_disposition().unwrap_or("").to_string(),
        content_encoding: output.content_encoding().unwrap_or("").to_string(),
        server_side_encryption: output
            .server_side_encryption()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        metadata,
    })
}

#[tauri::command]
pub(crate) async fn object_exists(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<bool, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let request = client.head_object().bucket(&bucket).key(&key).send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };
    match result {
        Ok(_) => Ok(true),
        Err(err) => {
            use aws_sdk_s3::error::SdkError;
            match err {
                SdkError::ServiceError(ctx) => {
                    let status = ctx.raw().status().as_u16();
                    if status == 404 {
                        Ok(false)
                    } else {
                        Err(format!(
                            "Failed to check object existence (HTTP {}): {}",
                            status,
                            String::from_utf8_lossy(ctx.raw().body().bytes().unwrap_or(&[]))
                        ))
                    }
                }
                other => Err(format!("Failed to check object existence: {:?}", other)),
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn update_metadata(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    content_type: String,
    metadata: HashMap<String, String>,
) -> Result<(), String> {
    // Resolve the client first so a disconnect cancels the storage-gate and
    // lease waits behind a long-running operation on the same key or prefix.
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_key(&key, "Object key")?;
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::key(&connection_id, &bucket, &key)],
        &client.token(),
    )
    .await?;
    let provider = client.provider();
    let cancel = client.token();

    // `MetadataDirective::Replace` discards every system header that is not
    // re-supplied on the request. Only content type and user metadata used to be
    // sent, so editing any metadata field silently stripped Cache-Control,
    // Content-Disposition, Content-Encoding, Content-Language, the website
    // redirect location, the storage class and the encryption settings. Read the
    // current state first and carry all of it forward.
    let mut existing = describe_source(&client, &bucket, &key, &cancel).await?;
    existing.content_type = Some(content_type.clone());
    existing.metadata = Some(metadata.clone());

    if existing.size >= MULTIPART_COPY_THRESHOLD {
        // S3's single CopyObject API is limited to 5 GiB, but an in-place
        // multipart upload may safely copy ranges from the old object until the
        // final completion atomically replaces it.
        return copy_object_multipart(
            &client, &bucket, &bucket, &key, &key, &existing, true, provider, &cancel,
        )
        .await
        .map(|_| ());
    }

    let source = encode_copy_source_with_version(&bucket, &key, existing.version_id.as_deref());
    let build_request = |include_acl: bool| {
        let mut req = client
            .copy_object()
            .bucket(&bucket)
            .key(&key)
            .copy_source(&source)
            .content_type(&content_type)
            .metadata_directive(MetadataDirective::Replace);

        if let Some(etag) = existing.etag.as_deref() {
            req = req.copy_source_if_match(etag);
        }

        if let Some(value) = existing.cache_control.as_deref() {
            req = req.cache_control(value);
        }
        if let Some(value) = existing.content_disposition.as_deref() {
            req = req.content_disposition(value);
        }
        if let Some(value) = existing.content_encoding.as_deref() {
            req = req.content_encoding(value);
        }
        if let Some(value) = existing.content_language.as_deref() {
            req = req.content_language(value);
        }
        if let Some(value) = existing.website_redirect_location.as_deref() {
            req = req.website_redirect_location(value);
        }
        if let Some(value) = existing.storage_class.as_ref() {
            req = req.storage_class(value.clone());
        }
        if let Some(value) = existing.server_side_encryption.as_ref() {
            req = req.server_side_encryption(value.clone());
        }
        if let Some(value) = existing.ssekms_key_id.as_deref() {
            req = req.ssekms_key_id(value);
        }
        if let Some(value) = existing.bucket_key_enabled {
            req = req.bucket_key_enabled(value);
        }
        if include_acl {
            if let Some(acl) = existing.acl.as_ref() {
                req = req.acl(acl.clone());
            }
        }

        for (k, v) in &metadata {
            req = req.metadata(k, v);
        }
        req
    };

    let mut include_acl = existing.acl.is_some();
    loop {
        let request = build_request(include_acl).send();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = request => result,
        };
        match result {
            Ok(_) => return Ok(()),
            Err(err) => {
                let detail = format!("{:?}", err);
                if include_acl && acls_are_unavailable(&detail) {
                    include_acl = false;
                    continue;
                }
                return Err(format!("Failed to update metadata: {}", err));
            }
        }
    }
}

pub(super) const MAX_DELETE_ERROR_DETAILS: usize = 20;

#[derive(Debug, Default, serde::Serialize)]
pub(crate) struct DeleteResult {
    pub(super) deleted: u32,
    pub(super) failed: u32,
    pub(super) incomplete: bool,
    pub(super) errors: Vec<String>,
}

pub(super) fn record_delete_error(result: &mut DeleteResult, detail: String) {
    if result.errors.len() < MAX_DELETE_ERROR_DETAILS {
        result.errors.push(detail);
    }
}

#[tauri::command]
pub(crate) async fn delete_objects(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    keys: Vec<String>,
) -> Result<DeleteResult, String> {
    // Resolve the client first so a disconnect cancels the storage-gate and
    // lease waits behind a long-running operation on the same key or prefix.
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    // This command used to pass its keys straight to `DeleteObjects` with no
    // validation at all, so a caller could delete anything the credentials
    // reached, including live rollback backups.
    for key in &keys {
        validate_deletable_key(key, "Object key")?;
    }
    if keys.is_empty() {
        return Ok(DeleteResult::default());
    }
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        keys.iter()
            .map(|key| crate::S3MutationScope::key(&connection_id, &bucket, key))
            .collect(),
        &client.token(),
    )
    .await?;
    let cancel = client.token();

    let mut result = DeleteResult::default();
    for chunk in keys.chunks(1000) {
        let objects = chunk
            .iter()
            .map(|k| {
                ObjectIdentifier::builder()
                    .key(k)
                    .build()
                    .map_err(|e| format!("Invalid key after deleting {}: {}", result.deleted, e))
            })
            .collect::<Result<Vec<ObjectIdentifier>, _>>();
        let objects = match objects {
            Ok(objects) => objects,
            Err(err) => {
                result.incomplete = true;
                record_delete_error(&mut result, err);
                break;
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
                break;
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
                break;
            }
            result = delete_request => result,
        };
        let output = match delete_result {
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
                break;
            }
        };

        let errors = output.errors();
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

    Ok(result)
}

#[tauri::command]
pub(crate) async fn get_object_acl(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<AclResponse, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let request = client.get_object_acl().bucket(&bucket).key(&key).send();
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to get ACL: {}", e))?;

    let owner = output
        .owner()
        .and_then(|o| o.display_name())
        .unwrap_or("")
        .to_string();

    let grants = output
        .grants()
        .iter()
        .map(|g| {
            let grantee = g
                .grantee()
                .map(|gr| {
                    gr.display_name()
                        .or(gr.uri())
                        .or(gr.id())
                        .unwrap_or("Unknown")
                        .to_string()
                })
                .unwrap_or_default();
            let permission = g
                .permission()
                .map(|p| p.as_str().to_string())
                .unwrap_or_default();
            AclGrant {
                grantee,
                permission,
            }
        })
        .collect();

    Ok(AclResponse { owner, grants })
}

#[tauri::command]
pub(crate) async fn set_object_acl(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    visibility: String,
) -> Result<(), String> {
    // Resolve the client first so a disconnect cancels the storage-gate and
    // lease waits behind a long-running operation on the same key or prefix.
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_key(&key, "Object key")?;
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::key(&connection_id, &bucket, &key)],
        &client.token(),
    )
    .await?;
    let cancel = client.token();

    let acl = match visibility.trim().to_ascii_lowercase().as_str() {
        "private" => ObjectCannedAcl::Private,
        "public-read" => ObjectCannedAcl::PublicRead,
        other => return Err(format!("Unsupported ACL visibility: {}", other)),
    };

    let request = client
        .put_object_acl()
        .bucket(&bucket)
        .key(&key)
        .acl(acl)
        .send();
    tokio::select! {
        _ = cancel.cancelled() => Err(cancelled_error()),
        result = request => result
            .map(|_| ())
            .map_err(|e| format!("Failed to update ACL: {}", e)),
    }
}

#[tauri::command]
pub(crate) async fn create_folder(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    // Resolve the client first so a disconnect cancels the storage-gate and
    // lease waits behind a long-running operation on the same key or prefix.
    let client = require_client(&state, &connection_id, None)?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_key(&key, "Object key")?;
    if key.contains("//") {
        return Err("Object key must not contain consecutive slashes".to_string());
    }

    let folder_key = if key.ends_with('/') {
        key
    } else {
        format!("{}/", key)
    };
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::key(
            &connection_id,
            &bucket,
            &folder_key,
        )],
        &client.token(),
    )
    .await?;
    let provider = client.provider();
    let cancel = client.token();
    let overwrite = overwrite.unwrap_or(false);

    // A folder marker is a zero-byte PutObject like any other write, so it
    // goes through the same absent-probe plus atomic create-only guard as
    // uploads: without this an unconditional write silently claimed an
    // existing key. Providers without create-only support fail closed here and
    // require an explicit overwrite retry, exactly like Put/Multipart/Copy.
    if !overwrite && destination_object_exists(&client, &bucket, &folder_key, &cancel).await? {
        return Err(format!(
            "Destination '{}' already exists. Choose overwrite to replace it.",
            folder_key
        ));
    }
    if !overwrite {
        require_put_create_only_support(provider, &folder_key)?;
    }

    let mut request = client
        .put_object()
        .bucket(&bucket)
        .key(&folder_key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b""));
    if !overwrite {
        request = apply_put_create_only_guard(request, provider, &folder_key)?;
    }
    let send = request.send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = send => result,
    };
    let err = match result {
        Ok(_) => return Ok(()),
        Err(err) => err,
    };
    if !overwrite && is_destination_occupied(&err) {
        // A folder marker carries no data: if a retried request hit a
        // zero-byte marker (ours or another client's), the folder exists as
        // requested and nothing was replaced.
        let head = client.head_object().bucket(&bucket).key(&folder_key).send();
        let marker_exists = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = head => matches!(result, Ok(ref head) if head.content_length() == Some(0)),
        };
        if marker_exists {
            return Ok(());
        }
    }
    if !overwrite && (is_destination_occupied(&err) || is_concurrent_write_conflict(&err)) {
        return Err(map_create_only_write_error(
            &folder_key,
            &err,
            overwrite,
            "create folder",
        ));
    }
    Err(format!("Failed to create folder: {}", err))
}

#[tauri::command]
pub(crate) fn build_object_url(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<String, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    if key_has_unsafe_url_segments(&key) {
        return Err(
            "Object keys containing '.' or '..' path segments cannot be copied as browser URLs. \
             Use Download or Preview in S3 Sidekick instead."
                .to_string(),
        );
    }
    let endpoint = require_endpoint(&state, &connection_id)?;
    let base = endpoint.trim_end_matches('/');
    let encoded_bucket = urlencoding::encode(&bucket);
    let encoded_key = key
        .split('/')
        .map(encode_object_url_segment)
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{}/{}/{}", base, encoded_bucket, encoded_key))
}

#[tauri::command]
pub(crate) async fn generate_presigned_url(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    expires_in_secs: u64,
) -> Result<String, String> {
    validate_bucket_name(&bucket)?;
    validate_readable_key(&key, "Object key")?;
    if key_has_unsafe_url_segments(&key) {
        return Err(
            "Object keys containing '.' or '..' path segments cannot be shared as presigned URLs \
             because browsers normalize those path segments and break the signature. \
             Use Download or Preview in S3 Sidekick instead."
                .to_string(),
        );
    }
    if !(60..=604800).contains(&expires_in_secs) {
        return Err("Expiration must be between 60 and 604800 seconds".to_string());
    }
    let client = require_client(&state, &connection_id, None)?;
    let cancel = client.token();

    let presigning_config =
        aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(expires_in_secs))
            .map_err(|e| format!("Invalid expiration: {}", e))?;

    let request = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .presigned(presigning_config);
    let presigned = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    }
    .map_err(|e| format!("Failed to generate presigned URL: {}", e))?;

    Ok(presigned.uri().to_string())
}
