//! Connection sessions and the connect/disconnect/list-buckets commands.

use super::*;

#[derive(serde::Serialize)]
pub(crate) struct ConnectResult {
    pub region: String,
    pub connection_id: String,
    pub connection_identity: String,
    pub create_only_capabilities: CreateOnlyCapabilityInfo,
    /// Whether the provider verifies `DeleteObject If-Match`, the only basis for
    /// automatic move source retirement. The webview treats a missing field as
    /// unsupported.
    pub conditional_delete_supported: bool,
}

fn build_connect_result(
    region: String,
    connection_id: String,
    connection_identity: String,
    storage_provider: StorageProviderKind,
) -> ConnectResult {
    ConnectResult {
        region,
        connection_id,
        connection_identity,
        create_only_capabilities: CreateOnlyCapabilityInfo::from_provider(storage_provider),
        conditional_delete_supported: supports_conditional_delete(storage_provider),
    }
}

pub(crate) fn mint_connection_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub(crate) fn connection_identity(endpoint: &str, access_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update([0u8]);
    hasher.update(access_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Owns the plaintext credentials handed to `connect` and zeroizes them on
/// every exit path, including the early endpoint/region errors that return
/// before the AWS credentials object is built.
struct ConnectSecrets {
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

impl Drop for ConnectSecrets {
    fn drop(&mut self) {
        self.access_key.zeroize();
        self.secret_key.zeroize();
        if let Some(token) = self.session_token.as_mut() {
            token.zeroize();
        }
    }
}

/// Identity of a credential payload the webview is about to persist.
///
/// The persisted endpoint is normalized the same way `connect` normalizes it,
/// so a valid save cannot be rejected merely for spelling the endpoint with a
/// trailing slash while a payload for a different endpoint or access key is.
///
/// An absent or `"s3"` protocol takes the S3 path. An `"sftp"` payload uses the
/// strict SFTP endpoint parser, and its `access_key` field holds the SSH
/// username. Any other protocol is refused.
pub(crate) fn persisted_connection_identity(json: &str) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct PersistedConnection {
        #[serde(default)]
        protocol: Option<String>,
        endpoint: String,
        access_key: String,
    }

    let persisted: PersistedConnection = serde_json::from_str(json)
        .map_err(|err| format!("Saved connection payload is invalid: {}", err))?;
    match persisted.protocol.as_deref() {
        None | Some("s3") => {
            let (normalized, _) = super::endpoint::normalize_endpoint(&persisted.endpoint)?;
            Ok(connection_identity(&normalized, &persisted.access_key))
        }
        Some("sftp") => {
            let (host, port) = crate::sftp::path::parse_sftp_endpoint(&persisted.endpoint)?;
            let normalized = crate::sftp::path::format_sftp_endpoint(&host, port)?;
            Ok(connection_identity(&normalized, &persisted.access_key))
        }
        Some(other) => Err(format!(
            "Saved connection protocol '{}' is not supported",
            other
        )),
    }
}

/// Refusal for a reset whose caller still holds an older connection id.
///
/// The webview maps this to "your session changed; disconnect and retry"
/// instead of presenting it as a generic backend failure.
pub(crate) const STALE_CONNECTION_SESSION: &str =
    "Connection session changed; disconnect and retry.";

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

/// Read the backend's current connection id.
///
/// The id is not authority: every S3 command still validates it against the
/// live session. A reloaded webview uses this to recover the active id before
/// asking to disconnect or clear the saved connection, rather than passing a
/// blank id and being refused as stale.
#[tauri::command(async)]
pub(crate) fn get_connection_id(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let s3 = lock_s3_state(&state)?;
    Ok(s3.connection_id.clone())
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
    s3.sftp = None;
    super::clear_listed_encoding_cache();
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
    let guard = TransferGuard::register_optional(Some(connection_id), transfer_id)?;
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
    let guard = TransferGuard::register_optional(Some(connection_id), transfer_id)?;
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

/// A pending connection attempt, registered before any credential is handled.
///
/// The attempt holds an anonymous transfer registration, so disconnect and reset
/// can cancel it, and the generation and previous session ID captured when it
/// began. A newer connect or a disconnect advances the generation, which makes
/// this attempt's install fail as superseded. Shared by the S3 and SFTP connects.
pub(crate) struct ConnectAttempt {
    guard: TransferGuard,
    connection_generation: u64,
    previous_connection_id: Option<String>,
}

/// Start a connect attempt: register it as anonymous session activity, refuse
/// when the vault or a retiring session forbids a new connection, and advance
/// the generation so any older attempt is superseded.
pub(crate) fn begin_connect_attempt(
    state: &tauri::State<'_, AppState>,
) -> Result<ConnectAttempt, String> {
    // Register before touching credentials or S3State so disconnect/reset can
    // cancel and drain the attempt without leaving a credential-bearing client
    // behind.
    let guard = TransferGuard::register_optional(None, None)?;
    let (connection_generation, previous_connection_id) = {
        let mut s3 = lock_s3_state(state)?;
        if guard.is_cancelled() {
            return Err(cancelled_error());
        }
        crate::security::prepare_s3_connect(s3.connection_id.is_some())?;
        s3.connection_generation = s3.connection_generation.wrapping_add(1);
        (s3.connection_generation, s3.connection_id.clone())
    };
    Ok(ConnectAttempt {
        guard,
        connection_generation,
        previous_connection_id,
    })
}

impl ConnectAttempt {
    /// Cancellation token for the attempt's network work.
    pub(crate) fn token(&self) -> CancelToken {
        self.guard.token()
    }

    /// True once disconnect, reset, or a newer connect has cancelled the attempt.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.guard.is_cancelled()
    }
}

/// Install a verified session as the live one and return its minted ID.
///
/// The previous session is retired first: its transfers are cancelled and
/// drained behind a fence. The ID is then minted, and `install` runs under the
/// registry gate and the S3State lock. `install` sets the protocol-specific
/// fields and must replace every field the previous session set, because this
/// helper clears none of them. `install` must finish all its checks before it
/// changes a field: the ID is only written after it returns Ok, so a failure
/// after a partial change would keep the previous ID over new fields.
pub(crate) async fn install_connection(
    state: &tauri::State<'_, AppState>,
    attempt: &ConnectAttempt,
    install: impl FnOnce(&mut crate::S3State) -> Result<(), String> + Send,
) -> Result<String, String> {
    // Replacing a live session must retire its registered clients before the
    // new credentials are installed. The previous session ID is pinned before
    // the network work: a connect that has since been superseded returns here
    // without touching the newer session's registrations.
    let mut retirement_fence = None;
    if let Some(previous_id) = attempt.previous_connection_id.as_deref() {
        {
            let s3 = lock_s3_state(state)?;
            if s3.connection_generation != attempt.connection_generation
                || s3.connection_id.as_deref() != Some(previous_id)
            {
                return Err("Connection attempt superseded".to_string());
            }
        }
        // On a drain timeout this returns Err and drops the fence, leaving the
        // still current session able to register transfers again.
        let fence = retire_connection_transfers(previous_id, "connection replacement").await?;
        if attempt.is_cancelled() {
            return Err(cancelled_error());
        }
        retirement_fence = Some(fence);
    }

    let connection_id = mint_connection_id();
    let install_result = attempt.guard.with_open_registration(|| {
        let mut s3 = lock_s3_state(state)?;
        if s3.connection_generation != attempt.connection_generation {
            return Err("Connection attempt superseded".to_string());
        }
        crate::security::require_s3_access()?;
        install(&mut s3)?;
        s3.connection_id = Some(connection_id.clone());
        Ok(())
    });
    if let Err(err) = install_result {
        // A failed replacement must not leave the still-active previous session
        // permanently unable to register new work. The fence is refcounted, so
        // dropping this attempt's hold leaves the entry armed for any newer
        // attempt that is still retiring the same session.
        drop(retirement_fence);
        return Err(err);
    }
    // The replacement is installed, so the retired session can never become
    // current again. Dropping the fence removes its retirement entry.
    drop(retirement_fence);
    // A different endpoint may reuse the same bucket names with a different
    // URL-encoding style; learned styles must not cross sessions.
    clear_listed_encoding_cache();

    Ok(connection_id)
}

#[tauri::command]
pub(crate) async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
) -> Result<ConnectResult, String> {
    // Own the plaintext credentials before the first validation step so every
    // error path below zeroizes them.
    let secrets = ConnectSecrets {
        access_key,
        secret_key,
        session_token,
    };
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("Endpoint is required".to_string());
    }

    // Pending connection attempts are anonymous session activity. The attempt
    // registers before touching credentials or S3State so disconnect/reset can
    // cancel and drain it without leaving a credential-bearing client behind.
    let attempt = begin_connect_attempt(&state)?;
    let cancel = attempt.token();
    let resolved_region = resolve_region(&endpoint, &region)?;
    let (normalized, bucket_hint) = normalize_endpoint(&endpoint)?;
    // Normalisation only classifies an IP literal. A hostname can still resolve
    // to a cloud metadata address, so resolve it now and reject if any answer
    // names one.
    validate_endpoint_resolution(&normalized).await?;
    if attempt.is_cancelled() {
        return Err(cancelled_error());
    }
    let identity = connection_identity(&normalized, &secrets.access_key);

    // Temporary STS credentials (SSO, AssumeRole) carry a session token that
    // must be signed with every request; without it those keys fail closed.
    let session = secrets
        .session_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let creds = aws_sdk_s3::config::Credentials::new(
        &secrets.access_key,
        &secrets.secret_key,
        session,
        None,
        "s3-sidekick",
    );

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

    let storage_provider = detect_storage_provider(&normalized);
    let connection_id = install_connection(&state, &attempt, |s3| {
        s3.client = Some(client);
        s3.endpoint = normalized;
        s3.region = resolved_region.clone();
        s3.bucket_hint = bucket_hint;
        s3.connection_identity = Some(identity.clone());
        s3.storage_provider = storage_provider;
        // An S3 session never carries an SFTP session alongside it.
        s3.sftp = None;
        Ok(())
    })
    .await?;

    Ok(build_connect_result(
        resolved_region,
        connection_id,
        identity,
        storage_provider,
    ))
}

#[tauri::command]
pub(crate) async fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    // Validate the caller before closing the registry. A stale webview must not
    // disable the live session's registry even briefly. The check is repeated
    // after the close: every connect installs under the same S3State lock, so a
    // connection that landed between the two reads is caught here, while one
    // that lands after the close fails its own registry check.
    let current_connection = lock_s3_state(&state)?.connection_id.clone();
    let should_invalidate = match current_connection.as_deref() {
        Some(current) if current == connection_id => true,
        Some(_) => return Err("Connection changed".to_string()),
        None => false,
    };

    let (mut gate, tokens) = close_transfer_registry()?;
    if lock_s3_state(&state)?.connection_id != current_connection {
        gate.reopen();
        return Err("Connection changed".to_string());
    }

    cancel_tokens(tokens);
    if let Err(err) = cancel_all_registered_transfers("disconnect").await {
        // No backend state was committed yet, so a timeout leaves the UI and
        // backend consistently connected and allows the user to retry.
        gate.reopen();
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
    gate.reopen();
    invalidation?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_connection_identity_matches_normalized_endpoint() {
        let identity = persisted_connection_identity(
            r#"{"endpoint":"https://Example.COM/","region":"us-east-1","access_key":"AKIA","secret_key":"secret"}"#,
        )
        .expect("persisted payload should parse");
        assert_eq!(identity, connection_identity("https://example.com", "AKIA"));
    }

    // Failure modes for the protocol-aware identity, written before the change:
    // - an SFTP endpoint without a port is accepted by the S3 normalizer and
    //   gets an S3-shaped identity instead of being refused
    // - an SFTP endpoint with a trailing slash or path is normalized away by the
    //   S3 path and forks from the identity of the same server
    // - an SFTP spelling that differs only by case or IPv6 form forks the identity
    //   if the endpoint is not re-formatted
    // - an absent or explicit "s3" protocol drifts from the S3 identity
    // - an unknown or differently-cased protocol falls through to the S3 path
    #[test]
    fn persisted_identity_for_sftp_uses_the_normalized_endpoint() {
        let identity = persisted_connection_identity(
            r#"{"protocol":"sftp","endpoint":"sftp://Example.COM:22","access_key":"alice"}"#,
        )
        .expect("sftp payload should parse");
        assert_eq!(
            identity,
            connection_identity("sftp://example.com:22", "alice")
        );
    }

    #[test]
    fn persisted_identity_for_sftp_ipv6_matches_the_formatted_endpoint() {
        let identity = persisted_connection_identity(
            r#"{"protocol":"sftp","endpoint":"sftp://[2001:DB8::1]:2022","access_key":"bob"}"#,
        )
        .expect("bracketed ipv6 payload should parse");
        assert_eq!(
            identity,
            connection_identity("sftp://[2001:db8::1]:2022", "bob")
        );
    }

    #[test]
    fn persisted_identity_without_protocol_or_with_s3_is_the_s3_identity() {
        let absent = persisted_connection_identity(
            r#"{"endpoint":"https://example.com/","access_key":"AKIA"}"#,
        )
        .expect("legacy payload should parse");
        let explicit = persisted_connection_identity(
            r#"{"protocol":"s3","endpoint":"https://example.com/","access_key":"AKIA"}"#,
        )
        .expect("explicit s3 payload should parse");
        assert_eq!(absent, connection_identity("https://example.com", "AKIA"));
        assert_eq!(explicit, absent);
    }

    #[test]
    fn persisted_identity_rejects_unknown_protocols_and_malformed_sftp_endpoints() {
        for json in [
            r#"{"protocol":"ftp","endpoint":"ftp://example.com:21","access_key":"u"}"#,
            r#"{"protocol":"SFTP","endpoint":"sftp://example.com:22","access_key":"u"}"#,
            r#"{"protocol":"","endpoint":"https://example.com","access_key":"u"}"#,
            r#"{"protocol":"sftp","endpoint":"sftp://example.com","access_key":"u"}"#,
            r#"{"protocol":"sftp","endpoint":"sftp://example.com:22/","access_key":"u"}"#,
            r#"{"protocol":"sftp","endpoint":"https://example.com:22","access_key":"u"}"#,
        ] {
            assert!(
                persisted_connection_identity(json).is_err(),
                "payload must be refused: {json}"
            );
        }
    }

    #[test]
    fn connect_result_reports_conditional_delete_only_for_verified_providers() {
        let providers = [
            (StorageProviderKind::Aws, true),
            (StorageProviderKind::Wasabi, false),
            (StorageProviderKind::Minio, false),
            (StorageProviderKind::CloudflareR2, false),
            (StorageProviderKind::DigitalOcean, false),
            (StorageProviderKind::Backblaze, false),
            (StorageProviderKind::Generic, false),
        ];
        for (provider, expected) in providers {
            let result = build_connect_result(
                "us-east-1".to_string(),
                "connection-id".to_string(),
                "identity".to_string(),
                provider,
            );
            let json = serde_json::to_value(&result).expect("serialize connect result");
            assert_eq!(
                json["conditional_delete_supported"],
                serde_json::Value::Bool(expected),
                "conditional DELETE flag for {:?}",
                provider
            );
            assert!(
                json["create_only_capabilities"].is_object(),
                "create-only capabilities stay next to the delete flag"
            );
        }
    }
}
