//! Single-part and multipart uploads.

use super::*;

#[tauri::command]
pub(crate) async fn upload_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
    part_size_mb: Option<u32>,
    part_concurrency: Option<u32>,
    bandwidth_limit_mbps: Option<u32>,
    checksum_verification: Option<bool>,
) -> Result<u64, String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, Some(transfer_id))?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_key(&key, "Object key")?;
    let upload_path = validate_existing_path(&file_path, "Upload file")?;
    let provider = client.provider();
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::key(&connection_id, &bucket, &key)],
        &cancel,
    )
    .await?;

    let file_size = tokio::fs::metadata(&upload_path)
        .await
        .map_err(|e| format!("File no longer accessible: {}", e))?
        .len();

    let attempt = normalize_attempt(attempt);
    let overwrite = overwrite.unwrap_or(false);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);
    // Multipart safety always needs a baseline digest, even when remote checksum
    // headers are disabled for provider compatibility. This extra local read is
    // what detects same-size rewrites before CompleteMultipartUpload publishes.
    // Create-only writes also carry the digest as an ownership marker so a
    // retried request that hits 412 can recognise its own committed object.
    let expected_checksum = if checksum_enabled || file_size >= MULTIPART_THRESHOLD || !overwrite {
        let digest = sha256_file(&upload_path, &cancel).await?;
        Some(sha256_checksum_from_digest(&digest))
    } else {
        None
    };
    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        0,
        file_size,
        attempt,
        "running",
        started_at,
        None,
        None,
        None,
        None,
    );

    if file_size >= MULTIPART_THRESHOLD {
        let part_size_bytes = choose_upload_part_size_bytes(file_size, part_size_mb)?;
        let requested_workers = clamp_transfer_concurrency(part_concurrency);
        let part_workers = clamp_concurrency_for_budget(
            requested_workers,
            part_size_bytes,
            MAX_UPLOAD_INFLIGHT_BYTES,
        );
        let bandwidth_limit_bps = clamp_bandwidth_limit_bps(bandwidth_limit_mbps);
        let baseline_checksum = expected_checksum
            .as_ref()
            .ok_or_else(|| "Multipart upload baseline checksum is unavailable".to_string())?;
        upload_multipart(
            &app,
            &client,
            &bucket,
            &key,
            &upload_path,
            &content_type,
            transfer_id,
            attempt,
            file_size,
            part_size_bytes,
            part_workers,
            bandwidth_limit_bps,
            started_at,
            baseline_checksum,
            checksum_enabled,
            overwrite,
            provider,
            &cancel,
        )
        .await?;
    } else {
        if client.is_cancelled() {
            return Err(cancelled_error());
        }
        if !overwrite {
            require_put_create_only_support(provider, &key)?;
        }

        let body = aws_sdk_s3::primitives::ByteStream::from_path(upload_path.as_path())
            .await
            .map_err(|e| format!("Failed to open file stream: {}", e))?;

        let mut req = client.put_object().bucket(&bucket).key(&key).body(body);

        if !content_type.is_empty() {
            req = req.content_type(&content_type);
        }
        if let Some(checksum) = expected_checksum.as_ref() {
            req = req.metadata(CHECKSUM_METADATA_KEY, &checksum.hex);
            if checksum_enabled {
                req = req
                    .checksum_algorithm(ChecksumAlgorithm::Sha256)
                    .checksum_sha256(&checksum.base64);
            }
        }
        if !overwrite {
            req = apply_put_create_only_guard(req, provider, &key)?;
        }

        // A single PutObject cannot be interrupted mid-flight, so race the send
        // against the cancel signal instead of only checking before it starts.
        // Without this, cancelling a sub-threshold upload had no effect at all
        // until the whole body had been transmitted.
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = req
                .customize()
                .config_override(body_attempt_timeout_override(file_size))
                .send() => result,
        };
        match result {
            Ok(output) => {
                if let (true, Some(checksum)) = (checksum_enabled, expected_checksum.as_ref()) {
                    verify_upload_checksum_response(output.checksum_sha256(), checksum, "Upload")?;
                }
            }
            Err(e) => {
                let own_write = match expected_checksum.as_ref() {
                    Some(checksum) if !overwrite && is_destination_occupied(&e) => {
                        destination_is_own_write(
                            &client,
                            &bucket,
                            &key,
                            &checksum.hex,
                            file_size,
                            &cancel,
                        )
                        .await
                    }
                    _ => false,
                };
                if !own_write {
                    if !overwrite
                        && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e))
                    {
                        return Err(map_create_only_write_error(&key, &e, overwrite, "upload"));
                    }
                    return Err(structured_transfer_sdk_error(
                        "Failed to upload",
                        &e,
                        "upload",
                        true,
                    ));
                }
            }
        }
    }

    if client.is_cancelled() {
        return Err(cancelled_error());
    }

    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        file_size,
        file_size,
        attempt,
        "verifying",
        started_at,
        None,
        None,
        None,
        None,
    );

    // Report the stat'ed size so the frontend can verify against a known
    // expectation instead of trusting progress events.
    Ok(file_size)
}

pub(super) async fn upload_part_with_retry(
    client: Client,
    bucket: String,
    key: String,
    upload_id: String,
    part_number: i32,
    data: bytes::Bytes,
    checksum_enabled: bool,
    cancel: CancelToken,
) -> Result<UploadedPart, String> {
    let bytes = data.len();
    let checksum = checksum_enabled.then(|| sha256_checksum_bytes(&data));
    let mut last_error = String::new();
    for attempt in 1..=UPLOAD_PART_RETRY_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let body = aws_sdk_s3::primitives::ByteStream::from(data.clone());
        let mut request = client
            .upload_part()
            .bucket(&bucket)
            .key(&key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(body);
        if let Some(checksum) = checksum.as_ref() {
            request = request.checksum_sha256(&checksum.base64);
        }
        let send = request
            .customize()
            .config_override(body_attempt_timeout_override(bytes as u64))
            .send();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled_error()),
            result = send => result,
        };
        match result {
            Ok(output) => {
                if let Some(checksum) = checksum.as_ref() {
                    verify_upload_checksum_response(
                        output.checksum_sha256(),
                        checksum,
                        &format!("Upload part {}", part_number),
                    )?;
                }
                let etag = output.e_tag().unwrap_or_default().to_string();
                return Ok((part_number, bytes, etag, checksum));
            }
            Err(err) => {
                last_error = structured_transfer_sdk_error(
                    &format!("Failed to upload part {}", part_number),
                    &err,
                    "upload_part",
                    true,
                );
                if !upload_part_error_is_retryable(&err) {
                    return Err(last_error);
                }
                if attempt < UPLOAD_PART_RETRY_ATTEMPTS {
                    let delay = Duration::from_millis(250 * (2u64.pow(attempt - 1)));
                    // Observe cancellation during backoff rather than sleeping
                    // through it.
                    if !cancel.sleep_unless_cancelled(delay).await {
                        return Err(cancelled_error());
                    }
                }
            }
        }
    }
    Err(last_error)
}

pub(super) async fn upload_multipart(
    app: &tauri::AppHandle,
    client: &Client,
    bucket: &str,
    key: &str,
    file_path: &Path,
    content_type: &str,
    transfer_id: u32,
    attempt: u32,
    file_size: u64,
    part_size_bytes: usize,
    max_concurrent_parts: usize,
    bandwidth_limit_bps: u64,
    started_at: Instant,
    baseline_checksum: &Sha256Checksum,
    checksum_verification: bool,
    overwrite: bool,
    provider: StorageProviderKind,
    cancel: &CancelToken,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    use tokio::task::JoinSet;

    if !overwrite {
        // Reject before creating remote multipart state or transferring bytes.
        require_complete_multipart_create_only_support(provider, key)?;
    }

    let mut create_req = client.create_multipart_upload().bucket(bucket).key(key);
    if !content_type.is_empty() {
        create_req = create_req.content_type(content_type);
    }
    if checksum_verification {
        create_req = create_req
            .metadata(CHECKSUM_METADATA_KEY, &baseline_checksum.hex)
            .checksum_algorithm(ChecksumAlgorithm::Sha256)
            .checksum_type(ChecksumType::Composite);
    }

    let create_request = create_req.send();
    let create_output = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = create_request => result,
    }
    .map_err(|e| {
        structured_transfer_sdk_error("Failed to create multipart upload", &e, "upload_init", true)
    })?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned")?
        .to_string();

    let mut file = match tokio::fs::File::open(file_path).await {
        Ok(file) => file,
        Err(err) => {
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            return Err(format!("Failed to open file: {}", err));
        }
    };

    let total_parts = file_size.div_ceil(part_size_bytes as u64) as usize;
    let mut completed_parts: Vec<Option<aws_sdk_s3::types::CompletedPart>> =
        vec![None; total_parts];
    let mut part_checksums: Vec<Option<Sha256Checksum>> = vec![None; total_parts];
    let mut completed_count = 0u32;
    let mut part_number = 1i32;
    let mut bytes_sent = 0u64;
    let mut eof = false;
    let mut join_set: JoinSet<Result<UploadedPart, String>> = JoinSet::new();
    let mut uploaded_bytes_hasher = Sha256::new();

    loop {
        if cancel.is_cancelled() {
            join_set.abort_all();
            while join_set.join_next().await.is_some() {}
            abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
            return Err(cancelled_error());
        }

        while join_set.len() < max_concurrent_parts && !eof {
            let mut buf = vec![0u8; part_size_bytes];
            let mut read = 0;
            while read < part_size_bytes {
                let n = tokio::select! {
                    _ = cancel.cancelled() => {
                        join_set.abort_all();
                        while join_set.join_next().await.is_some() {}
                        abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                        return Err(cancelled_error());
                    }
                    result = file.read(&mut buf[read..]) => {
                        match result {
                            Ok(n) => n,
                            Err(err) => {
                                join_set.abort_all();
                                while join_set.join_next().await.is_some() {}
                                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                                return Err(format!("Failed to read file: {}", err));
                            }
                        }
                    }
                };
                if n == 0 {
                    break;
                }
                read += n;
            }
            if read == 0 {
                eof = true;
                break;
            }
            buf.truncate(read);
            uploaded_bytes_hasher.update(&buf);

            // Guard against the file growing after `file_size` was measured: a
            // part number beyond `total_parts` would index `completed_parts`
            // out of bounds. Abort the upload cleanly instead of panicking.
            if (part_number as usize) > total_parts {
                // Drain first, like every other abort path: an in-flight part
                // could otherwise land after AbortMultipartUpload and linger
                // as a billed orphan part.
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(
                    "File changed during upload (grew larger than expected). Upload aborted."
                        .to_string(),
                );
            }

            let client = client.clone();
            let bucket = bucket.to_string();
            let key = key.to_string();
            let uid = upload_id.clone();
            let pn = part_number;
            let part_cancel = Arc::clone(cancel);

            let checksum_enabled = checksum_verification;
            join_set.spawn(async move {
                let shared = bytes::Bytes::from(buf);
                upload_part_with_retry(
                    client,
                    bucket,
                    key,
                    uid,
                    pn,
                    shared,
                    checksum_enabled,
                    part_cancel,
                )
                .await
            });

            part_number += 1;
        }

        if join_set.is_empty() {
            break;
        }

        let joined = tokio::select! {
            _ = cancel.cancelled() => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(cancelled_error());
            }
            result = join_set.join_next() => result,
        };

        match joined {
            Some(Ok(Ok((pn, bytes_read, etag, part_checksum)))) => {
                let mut completed = aws_sdk_s3::types::CompletedPart::builder()
                    .part_number(pn)
                    .e_tag(etag);
                if let Some(part_checksum) = part_checksum {
                    completed = completed.checksum_sha256(part_checksum.base64.clone());
                    part_checksums[(pn - 1) as usize] = Some(part_checksum);
                }
                completed_parts[(pn - 1) as usize] = Some(completed.build());
                completed_count += 1;
                bytes_sent += bytes_read as u64;
                if bandwidth_limit_bps > 0 {
                    let elapsed = started_at.elapsed().as_secs_f64();
                    let target = bytes_sent as f64 / bandwidth_limit_bps as f64;
                    if target > elapsed
                        && !cancel
                            .sleep_unless_cancelled(Duration::from_secs_f64(target - elapsed))
                            .await
                    {
                        continue;
                    }
                }
                emit_transfer_progress(
                    app,
                    "upload-progress",
                    transfer_id,
                    bytes_sent,
                    file_size,
                    attempt,
                    "running",
                    started_at,
                    Some(completed_count),
                    Some(total_parts as u32),
                    None,
                    None,
                );
            }
            Some(Ok(Err(e))) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(e);
            }
            Some(Err(e)) => {
                join_set.abort_all();
                while join_set.join_next().await.is_some() {}
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(format!("Upload task failed: {}", e));
            }
            None => break,
        }
    }

    // Verify the upload is complete before committing it.
    //
    // `completed_parts` is sized from the file length measured before the read
    // loop started. If the file shrank in the meantime the loop hits EOF early
    // and leaves trailing `None` slots. Flattening those away (as this code used
    // to do unconditionally) would complete a multipart upload containing only
    // the parts that happened to be read, publishing a silently truncated object
    // and reporting success.
    let missing_parts = completed_parts.iter().filter(|part| part.is_none()).count();
    let current_size = tokio::fs::metadata(file_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(file_size);
    if missing_parts > 0 || bytes_sent != file_size || current_size != file_size {
        join_set.abort_all();
        while join_set.join_next().await.is_some() {}
        abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
        return Err(format!(
            "File changed during upload: expected {} bytes in {} part(s) but sent {} bytes in {} part(s) \
             (file is now {} bytes). Upload aborted to avoid publishing a truncated object.",
            file_size,
            total_parts,
            bytes_sent,
            total_parts - missing_parts,
            current_size
        ));
    }

    let actual_checksum = sha256_checksum_from_digest(&uploaded_bytes_hasher.finalize());
    if actual_checksum.hex != baseline_checksum.hex {
        abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
        return Err(
            "File contents changed during multipart upload. Upload aborted before publication."
                .to_string(),
        );
    }

    let composite_checksum = if checksum_verification {
        let checksums = part_checksums
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| "Multipart upload completed without every part checksum".to_string())?;
        Some(sha256_composite_checksum(&checksums)?)
    } else {
        None
    };
    let final_parts: Vec<aws_sdk_s3::types::CompletedPart> =
        completed_parts.into_iter().flatten().collect();

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(final_parts))
        .build();

    let mut complete_output = None;
    let mut last_complete_error = String::new();
    const COMPLETE_ATTEMPTS: u32 = 3;
    for attempt in 1..=COMPLETE_ATTEMPTS {
        let mut complete_request = client
            .complete_multipart_upload()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .multipart_upload(completed_upload.clone())
            .mpu_object_size(file_size as i64);
        if let Some((request_checksum, _)) = composite_checksum.as_ref() {
            complete_request = complete_request
                .checksum_sha256(request_checksum)
                .checksum_type(ChecksumType::Composite);
        }
        if !overwrite {
            complete_request =
                apply_complete_multipart_create_only_guard(complete_request, provider, key)?;
        }
        let complete_request = complete_request
            .customize()
            .config_override(body_attempt_timeout_override(file_size))
            .send();
        let complete_result = tokio::select! {
            _ = cancel.cancelled() => {
                abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                return Err(cancelled_error());
            }
            result = complete_request => result,
        };
        match complete_result {
            Ok(output) => {
                complete_output = Some(output);
                break;
            }
            Err(e) => {
                if !overwrite
                    && is_destination_occupied(&e)
                    && destination_is_own_write(
                        client,
                        bucket,
                        key,
                        &baseline_checksum.hex,
                        file_size,
                        cancel,
                    )
                    .await
                {
                    // An earlier completion attempt committed; this retry hit
                    // our own object. Completion is done.
                    return Ok(());
                }
                if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                    abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                    return Err(map_create_only_write_error(
                        key,
                        &e,
                        overwrite,
                        "complete upload",
                    ));
                }
                last_complete_error = structured_transfer_sdk_error(
                    "Failed to complete multipart upload",
                    &e,
                    "upload_complete",
                    true,
                );
                if !complete_upload_error_is_retryable(&e) || attempt == COMPLETE_ATTEMPTS {
                    abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                    return Err(last_complete_error);
                }
                let delay = Duration::from_millis(500 * 2u64.pow(attempt - 1));
                if !cancel.sleep_unless_cancelled(delay).await {
                    abort_multipart_upload_bounded(client, bucket, key, &upload_id).await;
                    return Err(cancelled_error());
                }
            }
        }
    }
    let complete_output = match complete_output {
        Some(output) => output,
        None => return Err(last_complete_error),
    };
    if let Some((_, response_checksum)) = composite_checksum.as_ref() {
        verify_upload_checksum_value(
            complete_output.checksum_sha256(),
            response_checksum,
            "Multipart upload",
        )?;
        if complete_output.checksum_type() != Some(&ChecksumType::Composite) {
            return Err(encode_transfer_error(
                "checksum_mismatch",
                false,
                None,
                "Multipart upload returned an unexpected checksum type.".to_string(),
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_object_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    bucket: String,
    key: String,
    bytes_base64: String,
    content_type: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
    checksum_verification: Option<bool>,
) -> Result<(), String> {
    // Register before waiting for the storage gate so a pause or cancel
    // sent during the wait reaches this transfer instead of being dropped.
    let client = require_client(&state, &connection_id, Some(transfer_id))?;
    let _storage_guard = acquire_transfer_storage_cancellable(&client.token()).await?;
    validate_bucket_name(&bucket)?;
    validate_mutating_key(&key, "Object key")?;
    // Base64 keeps the browser-file IPC payload near 1.4x instead of the 3-4x
    // of a JSON number array for the same bytes. Reject oversized payloads
    // before decoding so a compromised webview cannot force the allocation.
    let max_encoded_len = MAX_UPLOAD_OBJECT_BYTES / 3 * 4 + 4;
    if bytes_base64.trim().len() > max_encoded_len {
        return Err(format!(
            "Browser upload fallback is limited to {} MB.",
            MAX_UPLOAD_OBJECT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = B64
        .decode(bytes_base64.trim())
        .map_err(|e| format!("Invalid browser upload payload: {e}"))?;
    if bytes.len() > MAX_UPLOAD_OBJECT_BYTES {
        return Err(format!(
            "Browser upload fallback is limited to {} MB.",
            MAX_UPLOAD_OBJECT_BYTES / (1024 * 1024)
        ));
    }

    let provider = client.provider();
    let cancel = client.token();
    let _mutation_guard = crate::acquire_s3_mutation_cancellable(
        vec![crate::S3MutationScope::key(&connection_id, &bucket, &key)],
        &cancel,
    )
    .await?;

    let total = bytes.len() as u64;
    let attempt = normalize_attempt(attempt);
    let overwrite = overwrite.unwrap_or(false);
    let started_at = Instant::now();
    let checksum_enabled = checksum_verification.unwrap_or(false);
    let expected_checksum = (checksum_enabled || !overwrite).then(|| sha256_checksum_bytes(&bytes));
    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        0,
        total,
        attempt,
        "running",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    if client.is_cancelled() {
        return Err(cancelled_error());
    }
    if !overwrite {
        require_put_create_only_support(provider, &key)?;
    }

    let mut req = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(bytes));

    if !content_type.is_empty() {
        req = req.content_type(&content_type);
    }
    if let Some(checksum) = expected_checksum.as_ref() {
        req = req.metadata(CHECKSUM_METADATA_KEY, &checksum.hex);
        if checksum_enabled {
            req = req
                .checksum_algorithm(ChecksumAlgorithm::Sha256)
                .checksum_sha256(&checksum.base64);
        }
    }
    if !overwrite {
        req = apply_put_create_only_guard(req, provider, &key)?;
    }

    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = req
            .customize()
            .config_override(body_attempt_timeout_override(total))
            .send() => result,
    };
    let output = match result {
        Ok(output) => Some(output),
        Err(e) => {
            let own_write = match expected_checksum.as_ref() {
                Some(checksum) if !overwrite && is_destination_occupied(&e) => {
                    destination_is_own_write(&client, &bucket, &key, &checksum.hex, total, &cancel)
                        .await
                }
                _ => false,
            };
            if !own_write {
                if !overwrite && (is_destination_occupied(&e) || is_concurrent_write_conflict(&e)) {
                    return Err(map_create_only_write_error(&key, &e, overwrite, "upload"));
                }
                return Err(structured_transfer_sdk_error(
                    "Failed to upload",
                    &e,
                    "upload",
                    true,
                ));
            }
            None
        }
    };

    if client.is_cancelled() {
        return Err(cancelled_error());
    }

    if let (true, Some(output), Some(checksum)) = (
        checksum_enabled,
        output.as_ref(),
        expected_checksum.as_ref(),
    ) {
        verify_upload_checksum_response(output.checksum_sha256(), checksum, "Upload")?;
    }

    emit_transfer_progress(
        &app,
        "upload-progress",
        transfer_id,
        total,
        total,
        attempt,
        "verifying",
        started_at,
        None,
        None,
        None,
        Some(false),
    );

    Ok(())
}
