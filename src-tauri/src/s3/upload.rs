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

pub(super) async fn upload_multipart<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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
    // Local ownership detection is required to recover a committed completion
    // whose response was lost, independently of remote checksum verification.
    create_req = create_req.metadata(CHECKSUM_METADATA_KEY, &baseline_checksum.hex);
    if checksum_verification {
        create_req = create_req
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

#[cfg(test)]
mod e2e_multipart_recovery {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};

    #[derive(Clone, Copy)]
    enum CommitMode {
        ThisClient,
        CompetingWriter,
    }

    #[derive(Default)]
    struct Observed {
        marker_at_create: Option<String>,
        checksum_algorithm_at_create: Option<String>,
        checksum_type_at_create: Option<String>,
        part_bytes: Vec<u8>,
        completion_attempts: u32,
        stored_marker: Option<String>,
        stored_bytes: Vec<u8>,
    }

    struct FaultServer {
        endpoint: String,
        observed: Arc<Mutex<Observed>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl FaultServer {
        fn start(mode: CommitMode, expected_size: usize) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind local HTTP fixture");
            listener
                .set_nonblocking(true)
                .expect("set nonblocking listener");
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let observed = Arc::new(Mutex::new(Observed::default()));
            let thread_observed = Arc::clone(&observed);
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let thread = thread::spawn(move || {
                while !thread_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if let Err(error) =
                                handle_request(stream, mode, expected_size, &thread_observed)
                            {
                                eprintln!("multipart fault fixture request failed: {}", error);
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(std::time::Duration::from_millis(2));
                        }
                        Err(error) => {
                            eprintln!("multipart fault fixture accept failed: {}", error);
                            break;
                        }
                    }
                }
            });
            Self {
                endpoint,
                observed,
                stop,
                thread: Some(thread),
            }
        }

        fn snapshot(&self) -> Observed {
            let observed = self.observed.lock().expect("fixture observation lock");
            Observed {
                marker_at_create: observed.marker_at_create.clone(),
                checksum_algorithm_at_create: observed.checksum_algorithm_at_create.clone(),
                checksum_type_at_create: observed.checksum_type_at_create.clone(),
                part_bytes: observed.part_bytes.clone(),
                completion_attempts: observed.completion_attempts,
                stored_marker: observed.stored_marker.clone(),
                stored_bytes: observed.stored_bytes.clone(),
            }
        }
    }

    impl Drop for FaultServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    struct Request {
        method: String,
        target: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut first_line = String::new();
        reader.read_line(&mut first_line)?;
        if first_line.is_empty() {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        let mut request_parts = first_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default().to_string();
        let target = request_parts.next().unwrap_or_default().to_string();
        let mut headers = HashMap::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line)?;
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        if headers
            .get("expect")
            .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
        {
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        }
        let mut body = Vec::new();
        if headers
            .get("transfer-encoding")
            .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
        {
            loop {
                let mut length = String::new();
                reader.read_line(&mut length)?;
                let size =
                    usize::from_str_radix(length.trim().split(';').next().unwrap_or("0"), 16)
                        .unwrap_or(0);
                if size == 0 {
                    loop {
                        let mut trailer = String::new();
                        reader.read_line(&mut trailer)?;
                        if trailer == "\r\n" || trailer.is_empty() {
                            break;
                        }
                    }
                    break;
                }
                let start = body.len();
                body.resize(start + size, 0);
                reader.read_exact(&mut body[start..])?;
                let mut crlf = [0; 2];
                reader.read_exact(&mut crlf)?;
            }
        } else if let Some(length) = headers.get("content-length") {
            let length = length.parse::<usize>().unwrap_or(0);
            body.resize(length, 0);
            reader.read_exact(&mut body)?;
        }
        Ok(Request {
            method,
            target,
            headers,
            body,
        })
    }

    fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
        let fallback_content_length = body.len().to_string();
        let content_length = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("Content-Length"))
            .map(|(_, value)| value.as_str())
            .unwrap_or(&fallback_content_length);
        let _ = write!(
            stream,
            "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
            status, content_length
        );
        for (name, value) in headers {
            if !name.eq_ignore_ascii_case("Content-Length") {
                let _ = write!(stream, "{}: {}\r\n", name, value);
            }
        }
        let _ = stream.write_all(b"\r\n");
        let _ = stream.write_all(body);
        let _ = stream.flush();
    }

    fn handle_request(
        mut stream: TcpStream,
        mode: CommitMode,
        expected_size: usize,
        observed: &Arc<Mutex<Observed>>,
    ) -> std::io::Result<()> {
        stream.set_nonblocking(false)?;
        let request = read_request(&mut stream)?;
        let path = request.target.split('?').next().unwrap_or_default();
        let query = request
            .target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        if request.method == "POST" && query.contains("uploads") {
            let mut observed = observed.lock().unwrap();
            observed.marker_at_create = request
                .headers
                .get("x-amz-meta-s3-sidekick-sha256")
                .cloned();
            observed.checksum_algorithm_at_create =
                request.headers.get("x-amz-checksum-algorithm").cloned();
            observed.checksum_type_at_create = request.headers.get("x-amz-checksum-type").cloned();
            respond(
                &mut stream,
                "200 OK",
                &[("Content-Type", "application/xml".to_string())],
                b"<InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>object.bin</Key><UploadId>lost-response-e2e</UploadId></InitiateMultipartUploadResult>",
            );
            return Ok(());
        }
        if request.method == "PUT" && query.contains("uploadId=") {
            let mut observed = observed.lock().unwrap();
            observed.part_bytes = request.body;
            let checksum = request
                .headers
                .get("x-amz-checksum-sha256")
                .cloned()
                .map(|value| ("x-amz-checksum-sha256", value));
            let mut headers = vec![("ETag", "\"part-e2e\"".to_string())];
            if let Some(checksum) = checksum {
                headers.push(checksum);
            }
            respond(&mut stream, "200 OK", &headers, b"");
            return Ok(());
        }
        if request.method == "POST" && query.contains("uploadId=") {
            let mut observed = observed.lock().unwrap();
            observed.completion_attempts += 1;
            if observed.completion_attempts == 1 {
                match mode {
                    CommitMode::ThisClient => {
                        observed.stored_marker = observed.marker_at_create.clone();
                        observed.stored_bytes = observed.part_bytes.clone();
                    }
                    CommitMode::CompetingWriter => {
                        observed.stored_marker = Some("external-writer-marker".to_string());
                        observed.stored_bytes = vec![0x42; expected_size];
                    }
                }
                // Simulate the server committing the request but losing its
                // response before the client can read it.
                return Ok(());
            }
            respond(
                &mut stream,
                "412 Precondition Failed",
                &[("Content-Type", "application/xml".to_string())],
                b"<Error><Code>PreconditionFailed</Code><Message>Object already exists</Message><Resource>/bucket/object.bin</Resource><RequestId>e2e</RequestId></Error>",
            );
            return Ok(());
        }
        if request.method == "HEAD" {
            let observed = observed.lock().unwrap();
            let mut headers = vec![
                ("Content-Length", observed.stored_bytes.len().to_string()),
                ("ETag", "\"committed-e2e\"".to_string()),
            ];
            if let Some(marker) = observed.stored_marker.as_ref() {
                headers.push(("x-amz-meta-s3-sidekick-sha256", marker.clone()));
            }
            respond(&mut stream, "200 OK", &headers, b"");
            return Ok(());
        }
        if request.method == "DELETE" && query.contains("uploadId=") {
            respond(&mut stream, "204 No Content", &[], b"");
            return Ok(());
        }
        eprintln!(
            "unexpected request {} {} ({})",
            request.method, request.target, path
        );
        respond(
            &mut stream,
            "404 Not Found",
            &[("Content-Type", "application/xml".to_string())],
            b"<Error><Code>NoSuchKey</Code><Message>unexpected request</Message></Error>",
        );
        Ok(())
    }

    fn make_mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app")
    }

    async fn exercise(
        mode: CommitMode,
        checksum_verification: bool,
    ) -> (Result<(), String>, Observed, String) {
        static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);
        let bytes = vec![0x5a; 1024 * 1024];
        let checksum = sha256_checksum_bytes(&bytes);
        let suffix = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "s3-sidekick-multipart-recovery-{}-{}",
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("payload.bin");
        std::fs::write(&path, &bytes).unwrap();
        let server = FaultServer::start(mode, bytes.len());
        let credentials = aws_sdk_s3::config::Credentials::new(
            "e2e-access",
            "e2e-secret",
            None,
            None,
            "multipart-e2e",
        );
        let sdk_config = aws_sdk_s3::config::Builder::new()
            .endpoint_url(&server.endpoint)
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .credentials_provider(credentials)
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::disabled())
            .force_path_style(true)
            .behavior_version_latest()
            .build();
        let client = Client::from_conf(sdk_config);
        let app = make_mock_app();
        let cancel: CancelToken = Arc::new(CancelFlag::default());
        let result = upload_multipart(
            app.handle(),
            &client,
            "bucket",
            "object.bin",
            &path,
            "application/octet-stream",
            17,
            1,
            bytes.len() as u64,
            8 * 1024 * 1024,
            1,
            0,
            Instant::now(),
            &checksum,
            checksum_verification,
            false,
            StorageProviderKind::Aws,
            &cancel,
        )
        .await;
        let observed = server.snapshot();
        let observed_json = serde_json::json!({
            "result": format!("{:?}", result),
            "marker_at_create": observed.marker_at_create,
            "checksum_algorithm_at_create": observed.checksum_algorithm_at_create,
            "checksum_type_at_create": observed.checksum_type_at_create,
            "part_size": observed.part_bytes.len(),
            "completion_attempts": observed.completion_attempts,
            "stored_marker": observed.stored_marker,
            "stored_size": observed.stored_bytes.len(),
            "stored_body_matches": observed.stored_bytes == bytes,
        })
        .to_string();
        let _ = std::fs::remove_dir_all(dir);
        (result, observed, observed_json)
    }

    fn record(name: &str, passed: bool, observed: &str) {
        if let Ok(path) = std::env::var("S3_SIDEKICK_MULTIPART_E2E_REPORT") {
            use std::io::Write;
            let row = serde_json::json!({ "name": name, "passed": passed, "observed": observed });
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("open multipart E2E report");
            writeln!(file, "{}", row).expect("write multipart E2E report");
        }
        eprintln!("{} {}", if passed { "PASS" } else { "FAIL" }, name);
    }

    #[tokio::test]
    #[ignore = "runs a local S3 HTTP fault fixture through the real SDK and multipart code"]
    async fn e2e_multipart_lost_response_uses_ownership_marker_independent_of_checksum_mode() {
        let (default_result, default_observed, default_json) =
            exercise(CommitMode::ThisClient, false).await;
        let default_ok = default_result.is_ok()
            && default_observed.marker_at_create.is_some()
            && default_observed.marker_at_create == default_observed.stored_marker
            && default_observed.checksum_algorithm_at_create.is_none()
            && default_observed.checksum_type_at_create.is_none()
            && default_observed.completion_attempts == 2
            && default_observed.stored_bytes == vec![0x5a; 1024 * 1024];
        record(
            "default checksum-off multipart completion recovers the committed own write",
            default_ok,
            &default_json,
        );

        let (verified_result, verified_observed, verified_json) =
            exercise(CommitMode::ThisClient, true).await;
        let verified_ok = verified_result.is_ok()
            && verified_observed.marker_at_create.is_some()
            && verified_observed.marker_at_create == verified_observed.stored_marker
            && verified_observed.checksum_algorithm_at_create.as_deref() == Some("SHA256")
            && verified_observed.checksum_type_at_create.as_deref() == Some("COMPOSITE")
            && verified_observed.part_bytes == vec![0x5a; 1024 * 1024]
            && verified_observed.completion_attempts == 2
            && verified_observed.stored_bytes == vec![0x5a; 1024 * 1024];
        record(
            "checksum-on multipart recovery keeps remote checksum verification enabled",
            verified_ok,
            &verified_json,
        );

        let (competing_result, competing_observed, competing_json) =
            exercise(CommitMode::CompetingWriter, false).await;
        let competing_ok = competing_result.is_err()
            && competing_observed.completion_attempts == 2
            && competing_observed.stored_marker.as_deref() == Some("external-writer-marker")
            && competing_observed.stored_bytes != vec![0x5a; 1024 * 1024];
        record(
            "a competing same-size object remains a create-only conflict",
            competing_ok,
            &competing_json,
        );

        assert!(
            default_ok && verified_ok && competing_ok,
            "multipart recovery E2E failed"
        );
    }
}
