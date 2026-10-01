//! Connection sessions and the connect/disconnect/list-buckets commands.

use super::*;

#[derive(serde::Serialize)]
pub(crate) struct ConnectResult {
    pub region: String,
    pub connection_id: String,
    pub connection_identity: String,
    pub create_only_capabilities: CreateOnlyCapabilityInfo,
}

pub(super) fn mint_connection_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub(super) fn connection_identity(endpoint: &str, access_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update([0u8]);
    hasher.update(access_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(crate) fn require_connection_session(
    s3: &crate::S3State,
    connection_id: &str,
) -> Result<(), String> {
    if connection_id.trim().is_empty() {
        return Err("Connection id is required".to_string());
    }
    match s3.connection_id.as_deref() {
        Some(current) if current == connection_id => Ok(()),
        Some(_) => Err("Connection changed".to_string()),
        None => Err("Not connected".to_string()),
    }
}

pub(crate) fn invalidate_connection_session(s3: &mut crate::S3State) {
    s3.connection_generation = s3.connection_generation.wrapping_add(1);
    s3.client = None;
    s3.bucket_hint = None;
    s3.endpoint.clear();
    s3.region.clear();
    s3.connection_id = None;
    s3.connection_identity = None;
    s3.storage_provider = StorageProviderKind::default();
}

pub(super) fn require_connected_client(
    s3: &crate::S3State,
    connection_id: &str,
) -> Result<Client, String> {
    require_connection_session(s3, connection_id)?;
    s3.client.clone().ok_or_else(|| "Not connected".to_string())
}

/// Keeps a stored AWS client clone registered until the clone is dropped.
///
/// The fields are owned (not `Option`) so every accessor is infallible: with
/// panic = "abort" any `expect` here would kill the app, so the type makes an
/// absent client unrepresentable instead. Declaration order is the drop order,
/// so the credential-bearing client is destroyed before its registry entry —
/// otherwise a drain could observe an empty registry while a clone from the
/// old session was still alive.
pub(super) struct RegisteredClient {
    pub(super) client: Client,
    pub(super) provider: StorageProviderKind,
    pub(super) guard: TransferGuard,
}

impl RegisteredClient {
    pub(super) fn new(client: Client, provider: StorageProviderKind, guard: TransferGuard) -> Self {
        Self {
            client,
            provider,
            guard,
        }
    }

    pub(super) fn provider(&self) -> StorageProviderKind {
        self.provider
    }

    pub(super) fn token(&self) -> CancelToken {
        self.guard.token()
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.guard.is_cancelled()
    }
}

impl std::ops::Deref for RegisteredClient {
    type Target = Client;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

/// Register before taking `S3State` so closing the registry gate cannot race a
/// client clone into existence without a corresponding drain entry.
pub(super) fn require_client(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
    transfer_id: Option<u32>,
) -> Result<RegisteredClient, String> {
    crate::security::require_s3_access()?;
    let guard = TransferGuard::register_optional(transfer_id)?;
    if guard.is_cancelled() {
        return Err(cancelled_error());
    }
    let (client, provider) = {
        let s3 = lock_s3_state(state)?;
        crate::security::require_s3_access()?;
        if guard.is_cancelled() {
            return Err(cancelled_error());
        }
        (
            require_connected_client(&s3, connection_id)?,
            s3.storage_provider,
        )
    };
    let registered = RegisteredClient::new(client, provider, guard);
    if registered.is_cancelled() {
        return Err(cancelled_error());
    }
    crate::security::require_s3_access()?;
    Ok(registered)
}

pub(super) fn require_client_and_bucket_hint(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
    transfer_id: Option<u32>,
) -> Result<(RegisteredClient, Option<String>), String> {
    crate::security::require_s3_access()?;
    let guard = TransferGuard::register_optional(transfer_id)?;
    if guard.is_cancelled() {
        return Err(cancelled_error());
    }
    let (client, provider, bucket_hint) = {
        let s3 = lock_s3_state(state)?;
        crate::security::require_s3_access()?;
        if guard.is_cancelled() {
            return Err(cancelled_error());
        }
        (
            require_connected_client(&s3, connection_id)?,
            s3.storage_provider,
            s3.bucket_hint.clone(),
        )
    };
    let registered = RegisteredClient::new(client, provider, guard);
    if registered.is_cancelled() {
        return Err(cancelled_error());
    }
    crate::security::require_s3_access()?;
    Ok((registered, bucket_hint))
}

pub(super) fn require_endpoint(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
) -> Result<String, String> {
    crate::security::require_s3_access()?;
    let s3 = lock_s3_state(state)?;
    crate::security::require_s3_access()?;
    if connection_id.trim().is_empty() {
        return Err("Connection id is required".to_string());
    }
    match s3.connection_id.as_deref() {
        Some(current) if current == connection_id => {
            if s3.endpoint.is_empty() {
                Err("Not connected".to_string())
            } else {
                Ok(s3.endpoint.clone())
            }
        }
        Some(_) => Err("Connection changed".to_string()),
        None => Err("Not connected".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    mut access_key: String,
    mut secret_key: String,
    mut session_token: Option<String>,
) -> Result<ConnectResult, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("Endpoint is required".to_string());
    }

    // Pending connection attempts are anonymous session activity. Register
    // before touching credentials or S3State so disconnect/reset can cancel and
    // drain the attempt without leaving a credential-bearing client behind.
    let connect_guard = TransferGuard::register_optional(None)?;
    let cancel = connect_guard.token();
    let connection_generation = {
        let mut s3 = lock_s3_state(&state)?;
        if connect_guard.is_cancelled() {
            return Err(cancelled_error());
        }
        crate::security::prepare_s3_connect(s3.connection_id.is_some())?;
        s3.connection_generation = s3.connection_generation.wrapping_add(1);
        s3.connection_generation
    };
    let resolved_region = resolve_region(&endpoint, &region)?;
    let (normalized, bucket_hint) = normalize_endpoint(&endpoint)?;
    let identity = connection_identity(&normalized, &access_key);

    // Temporary STS credentials (SSO, AssumeRole) carry a session token that
    // must be signed with every request; without it those keys fail closed.
    let session = session_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let creds = aws_sdk_s3::config::Credentials::new(
        &access_key,
        &secret_key,
        session,
        None,
        "s3-sidekick",
    );

    // Zeroize the plaintext credential strings now that they've been consumed
    access_key.zeroize();
    secret_key.zeroize();
    if let Some(token) = session_token.as_mut() {
        token.zeroize();
    }

    // Bound hung connections: without timeouts a stalled TCP connect or an
    // idle response body blocks forever, since the cancel token only fires on
    // explicit user cancellation. Per-attempt (not total-operation) timeouts
    // are used so large multipart transfers are not cut off mid-stream; each
    // individual request still races the cancel token at every call site.
    let timeout_config = aws_sdk_s3::config::timeout::TimeoutConfig::builder()
        .connect_timeout(Duration::from_secs(8))
        .operation_attempt_timeout(Duration::from_secs(45))
        .build();
    let retry_config = aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(3);

    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(&normalized)
        .region(aws_sdk_s3::config::Region::new(resolved_region.clone()))
        .credentials_provider(creds)
        .timeout_config(timeout_config)
        .retry_config(retry_config)
        .force_path_style(true)
        .behavior_version_latest()
        .build();

    let client = Client::from_conf(config);

    // Verify connectivity. Try list_buckets first; if that gets AccessDenied
    // (common with scoped keys on DO Spaces), fall back to head_bucket using
    // the bucket extracted from the endpoint URL.
    let list_request = client.list_buckets().send();
    let list_result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = list_request => result,
    };
    if let Err(list_err) = &list_result {
        let is_access_denied = {
            use aws_sdk_s3::error::SdkError;
            matches!(list_err, SdkError::ServiceError(ctx)
                if ctx.raw().status().as_u16() == 403)
        };
        if is_access_denied {
            if let Some(ref bucket) = bucket_hint {
                // Fall back: verify we can at least reach this specific bucket.
                let head_request = client.head_bucket().bucket(bucket).send();
                tokio::select! {
                    _ = cancel.cancelled() => return Err(cancelled_error()),
                    result = head_request => result
                        .map(|_| ())
                        .map_err(|e| format_sdk_error("Connection failed", &e))?,
                }
            } else {
                // No bucket hint to fall back on — report the 403.
                return Err(format_sdk_error("Connection failed", list_err));
            }
        } else {
            return Err(format_sdk_error("Connection failed", list_err));
        }
    }

    let connection_id = mint_connection_id();
    let storage_provider = detect_storage_provider(&normalized);
    connect_guard.with_open_registration(|| {
        let mut s3 = lock_s3_state(&state)?;
        if s3.connection_generation != connection_generation {
            return Err("Connection attempt superseded".to_string());
        }
        crate::security::require_s3_access()?;
        s3.client = Some(client);
        s3.endpoint = normalized;
        s3.region = resolved_region.clone();
        s3.bucket_hint = bucket_hint;
        s3.connection_id = Some(connection_id.clone());
        s3.connection_identity = Some(identity.clone());
        s3.storage_provider = storage_provider;
        Ok(())
    })?;

    Ok(ConnectResult {
        region: resolved_region,
        connection_id,
        connection_identity: identity,
        create_only_capabilities: CreateOnlyCapabilityInfo::from_provider(storage_provider),
    })
}

#[tauri::command]
pub(crate) async fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    // Close registration before checking S3State. Every command registers before
    // it takes that state lock, so once this succeeds no untracked client clone
    // from the session can appear behind the drain.
    let tokens = close_transfer_registry()?;
    let should_invalidate = match lock_s3_state(&state) {
        Ok(s3) => match s3.connection_id.as_deref() {
            Some(current) if current == connection_id => true,
            Some(_) => {
                let _ = reopen_transfer_registry();
                return Err("Connection changed".to_string());
            }
            None => false,
        },
        Err(err) => {
            let _ = reopen_transfer_registry();
            return Err(err);
        }
    };

    cancel_tokens(tokens);
    if let Err(err) = cancel_all_registered_transfers("disconnect").await {
        // No backend state was committed yet, so a timeout leaves the UI and
        // backend consistently connected and allows the user to retry.
        let _ = reopen_transfer_registry();
        return Err(err);
    }

    let invalidation = if should_invalidate {
        lock_s3_state(&state).and_then(|mut s3| {
            if s3.connection_id.as_deref() != Some(connection_id.as_str()) {
                return Err("Connection changed".to_string());
            }
            invalidate_connection_session(&mut s3);
            Ok(())
        })
    } else {
        Ok(())
    };
    let reopening = reopen_transfer_registry();
    invalidation?;
    reopening?;
    crate::security::clear_s3_retirement_required();
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_buckets(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<BucketInfo>, String> {
    let (client, bucket_hint) = require_client_and_bucket_hint(&state, &connection_id, None)?;
    let cancel = client.token();
    let request = client.list_buckets().send();
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled_error()),
        result = request => result,
    };

    match result {
        Ok(output) => {
            let buckets = output
                .buckets()
                .iter()
                .map(|b| BucketInfo {
                    name: b.name().unwrap_or_default().to_string(),
                    creation_date: b.creation_date().map(|d| d.to_string()).unwrap_or_default(),
                })
                .collect();
            Ok(buckets)
        }
        Err(err) => {
            // If list_buckets is denied (scoped key), return the bucket hint.
            use aws_sdk_s3::error::SdkError;
            let is_access_denied = matches!(&err, SdkError::ServiceError(ctx)
                if ctx.raw().status().as_u16() == 403);
            if is_access_denied {
                if let Some(name) = bucket_hint {
                    return Ok(vec![BucketInfo {
                        name,
                        creation_date: String::new(),
                    }]);
                }
            }
            Err(format_sdk_error("Failed to list buckets", &err))
        }
    }
}
