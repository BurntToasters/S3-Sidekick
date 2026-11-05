//! Transfer registration, cooperative cancellation and the pending-cancel bridge.

use super::*;

/// Cooperative cancellation signal shared by a transfer and its workers.
///
/// Running registrations carry their own token. A bounded, short-lived pending
/// map also bridges the IPC race where `cancel_transfer` reaches Rust just
/// before the corresponding command registers. Frontend IDs persist across
/// reloads, and expiry prevents an abandoned cancel from latching forever.
#[derive(Default)]
pub(crate) struct CancelFlag {
    pub(super) cancelled: std::sync::atomic::AtomicBool,
    pub(super) notify: tokio::sync::Notify,
}

impl CancelFlag {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.notify.notify_waiters();
        }
    }

    /// Resolve immediately when cancellation has already happened, or register
    /// a race-free waiter for the next cancellation signal.
    pub(crate) async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }

        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    /// Sleep, waking immediately if cancellation arrives.
    pub(super) async fn sleep_unless_cancelled(&self, total: Duration) -> bool {
        tokio::select! {
            _ = self.cancelled() => false,
            _ = tokio::time::sleep(total) => true,
        }
    }
}

pub(crate) type CancelToken = Arc<CancelFlag>;

pub(super) struct ActiveTransfer {
    pub(super) connection_id: Option<String>,
    pub(super) transfer_id: Option<u32>,
    pub(super) token: CancelToken,
}

#[derive(Default)]
pub(super) struct TransferRegistryState {
    /// Owner of the closed gate. Only the close that installed this token may
    /// reopen it, so a concurrent disconnect/lock/reset cannot reopen a gate
    /// another operation is still draining.
    pub(super) gate_owner: Option<u64>,
    pub(super) next_gate_owner: u64,
    pub(super) next_registration_id: u64,
    pub(super) registrations: HashMap<u64, ActiveTransfer>,
    /// Keyed by (connection id, transfer id): a reloaded webview reuses IDs, so
    /// a pending cancel must never reach the same ID in a newer session.
    pub(super) pending_cancels: HashMap<(String, u32), Instant>,
    /// Sessions being replaced by a successful connect, with the number of
    /// armed fences. New registrations for these IDs fail so the old client
    /// cannot escape the drain. Refcounting keeps a failed newer connect from
    /// unfencing a session another attempt is still retiring.
    pub(super) retiring_connections: HashMap<String, usize>,
}

pub(super) static TRANSFER_REGISTRY: OnceLock<Mutex<TransferRegistryState>> = OnceLock::new();
pub(super) static ROLLBACK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(super) fn transfer_registry() -> &'static Mutex<TransferRegistryState> {
    TRANSFER_REGISTRY.get_or_init(|| Mutex::new(TransferRegistryState::default()))
}

pub(super) fn lock_transfer_registry(
) -> Result<std::sync::MutexGuard<'static, TransferRegistryState>, String> {
    transfer_registry()
        .lock()
        .map_err(|_| "Transfer registry is unavailable".to_string())
}

/// Registers running S3 activity and deregisters it on drop.
///
/// The frontend ID is only a cancellation label. Every operation receives a
/// unique backend registration so a reloaded webview or failed localStorage
/// write cannot displace an older operation that happens to reuse the same ID.
pub(super) struct TransferGuard {
    pub(super) registration_id: u64,
    pub(super) token: CancelToken,
}

impl TransferGuard {
    #[cfg(test)]
    pub(super) fn register(transfer_id: u32) -> Result<Self, String> {
        Self::register_optional(Some("test-connection"), Some(transfer_id))
    }

    pub(super) fn register_optional(
        connection_id: Option<&str>,
        transfer_id: Option<u32>,
    ) -> Result<Self, String> {
        let token: CancelToken = Arc::new(CancelFlag::default());
        let mut registry = lock_transfer_registry()?;
        if registry.gate_owner.is_some() {
            return Err(cancelled_error());
        }
        if connection_id.is_some_and(|id| registry.retiring_connections.contains_key(id)) {
            return Err("Connection changed".to_string());
        }
        let now = Instant::now();
        registry
            .pending_cancels
            .retain(|_, created| now.duration_since(*created) <= PENDING_CANCEL_TTL);
        let cancelled_before_registration = connection_id
            .zip(transfer_id)
            .and_then(|(connection_id, transfer_id)| {
                registry
                    .pending_cancels
                    .remove(&(connection_id.to_string(), transfer_id))
            })
            .is_some();
        if cancelled_before_registration {
            token.cancel();
        }
        let start = registry.next_registration_id;
        let mut candidate = start;
        let registration_id = loop {
            candidate = candidate.wrapping_add(1);
            if !registry.registrations.contains_key(&candidate) {
                registry.next_registration_id = candidate;
                break candidate;
            }
            if candidate == start {
                return Err("Transfer registry is full".to_string());
            }
        };
        registry.registrations.insert(
            registration_id,
            ActiveTransfer {
                connection_id: connection_id.map(str::to_string),
                transfer_id,
                token: Arc::clone(&token),
            },
        );
        Ok(Self {
            registration_id,
            token,
        })
    }

    pub(super) fn token(&self) -> CancelToken {
        Arc::clone(&self.token)
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Run a short commit while registration remains open. Holding the registry
    /// lock makes the final connect install atomic with respect to gate closure.
    pub(super) fn with_open_registration<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let registry = lock_transfer_registry()?;
        if registry.gate_owner.is_some()
            || self.is_cancelled()
            || !registry.registrations.contains_key(&self.registration_id)
        {
            return Err(cancelled_error());
        }
        action()
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = transfer_registry().lock() {
            registry.registrations.remove(&self.registration_id);
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_transfer(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    transfer_id: u32,
) -> Result<(), String> {
    {
        let s3 = crate::lock_s3_state(&state)?;
        require_connection_session(&s3, &connection_id)?;
    }
    cancel_transfer_in_registry(&connection_id, transfer_id);
    Ok(())
}

/// Cancel only registrations owned by the named connection.
///
/// The pending-cancel bridge is session-scoped too: a stale webview cannot
/// cancel a new transfer that happens to reuse the same numeric ID.
pub(crate) fn cancel_transfer_in_registry(connection_id: &str, transfer_id: u32) {
    let tokens = transfer_registry()
        .lock()
        .map(|mut registry| {
            let tokens = registry
                .registrations
                .values()
                .filter(|active| {
                    active.connection_id.as_deref() == Some(connection_id)
                        && active.transfer_id == Some(transfer_id)
                })
                .map(|active| Arc::clone(&active.token))
                .collect::<Vec<_>>();
            if tokens.is_empty() {
                let now = Instant::now();
                registry
                    .pending_cancels
                    .retain(|_, created| now.duration_since(*created) <= PENDING_CANCEL_TTL);
                if registry.pending_cancels.len() >= MAX_PENDING_CANCELS {
                    if let Some(oldest) = registry
                        .pending_cancels
                        .iter()
                        .min_by_key(|(_, created)| *created)
                        .map(|(key, _)| key.clone())
                    {
                        registry.pending_cancels.remove(&oldest);
                    }
                }
                registry
                    .pending_cancels
                    .insert((connection_id.to_string(), transfer_id), now);
            }
            tokens
        })
        .unwrap_or_default();
    for token in tokens {
        token.cancel();
    }
}

fn connection_tokens(registry: &TransferRegistryState, connection_id: &str) -> Vec<CancelToken> {
    registry
        .registrations
        .values()
        .filter(|active| active.connection_id.as_deref() == Some(connection_id))
        .map(|active| Arc::clone(&active.token))
        .collect()
}

/// A retirement fence that removes itself on every unsuccessful exit path.
///
/// Registering the fence used to leak it whenever the drain timed out or the
/// caller was cancelled before installing the replacement, leaving the still
/// current session unable to register any new transfer. Dropping this guard
/// unfences the session; a successful replacement calls `release()` so the
/// fence survives until the new session is installed (or is deliberately kept
/// when a newer connect has already taken over).
pub(super) struct RetirementFence {
    connection_id: String,
    armed: bool,
}

impl RetirementFence {
    fn arm(connection_id: &str) -> Result<Self, String> {
        let mut registry = lock_transfer_registry()?;
        *registry
            .retiring_connections
            .entry(connection_id.to_string())
            .or_insert(0) += 1;
        Ok(Self {
            connection_id: connection_id.to_string(),
            armed: true,
        })
    }
}

impl Drop for RetirementFence {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut registry) = transfer_registry().lock() {
            if let Some(count) = registry.retiring_connections.get_mut(&self.connection_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    registry.retiring_connections.remove(&self.connection_id);
                }
            }
        }
    }
}

/// Stop new registrations for a session being replaced, then cancel everything
/// that is already registered for it.
///
/// The returned fence is disarmed on success so the caller can keep the session
/// closed while it installs the replacement. Any error (including the drain
/// timeout) drops the fence and unfences the session, because no replacement was
/// installed and that session is still current.
pub(super) async fn retire_connection_transfers(
    connection_id: &str,
    context: &str,
) -> Result<RetirementFence, String> {
    let fence = RetirementFence::arm(connection_id)?;
    let tokens = {
        let registry = lock_transfer_registry()?;
        connection_tokens(&registry, connection_id)
    };
    cancel_tokens(tokens);

    let started = Instant::now();
    loop {
        let tokens = {
            let guard = lock_transfer_registry()?;
            connection_tokens(&guard, connection_id)
        };
        if tokens.is_empty() {
            // Keep the same armed fence. Its refcount stays held until the
            // caller installing the replacement drops it (or a failed install
            // does), so another attempt retiring the same session cannot be
            // unfenced early.
            return Ok(fence);
        }
        cancel_tokens(tokens);
        if started.elapsed() >= Duration::from_secs(30) {
            return Err(format!(
                "Timed out while stopping active transfers for {}",
                context
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A closed transfer registry. The gate can only be reopened by the operation
/// that closed it; dropping the token reopens it unless `keep_closed` was
/// called (drain failure or factory reset in progress).
pub(crate) struct TransferRegistryGate {
    owner: Option<u64>,
}

impl TransferRegistryGate {
    /// Reopen only if this token still owns the gate. A superseded token must
    /// not clear a newer operation's closure.
    pub(crate) fn reopen(&mut self) {
        let Some(owner) = self.owner.take() else {
            return;
        };
        if let Ok(mut registry) = lock_transfer_registry() {
            if registry.gate_owner == Some(owner) {
                registry.gate_owner = None;
            }
        }
    }

    /// Leave the registry closed after this token is dropped. Used when a
    /// drain failed (security wins over cleanup) or a factory reset is in
    /// progress and the process may not get to reopen.
    pub(crate) fn keep_closed(&mut self) {
        self.owner = None;
    }
}

impl Drop for TransferRegistryGate {
    fn drop(&mut self) {
        self.reopen();
    }
}

pub(super) async fn acquire_transfer_storage_cancellable(
    cancel: &CancelToken,
) -> Result<crate::StorageTransferGuard, String> {
    tokio::select! {
        _ = cancel.cancelled() => Err(cancelled_error()),
        guard = crate::acquire_transfer_storage() => guard,
    }
}

/// Close the registry and return the owner token plus the tokens to cancel.
///
/// A second close while another operation owns the gate is refused instead of
/// stealing ownership: reopening is only legal for the closer, and a stolen
/// gate would let one operation reopen a drain another is still running.
pub(crate) fn close_transfer_registry() -> Result<(TransferRegistryGate, Vec<CancelToken>), String>
{
    let mut registry = lock_transfer_registry()?;
    if registry.gate_owner.is_some() {
        return Err("Transfer registry is already closed by another operation".to_string());
    }
    let owner = registry.next_gate_owner;
    registry.next_gate_owner = owner.wrapping_add(1);
    registry.gate_owner = Some(owner);
    let tokens = registry
        .registrations
        .values()
        .map(|active| Arc::clone(&active.token))
        .collect();
    Ok((TransferRegistryGate { owner: Some(owner) }, tokens))
}

pub(crate) fn cancel_tokens(tokens: Vec<CancelToken>) {
    for token in tokens {
        token.cancel();
    }
}

pub(crate) async fn cancel_all_registered_transfers(context: &str) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let tokens = lock_transfer_registry()?
            .registrations
            .values()
            .map(|active| Arc::clone(&active.token))
            .collect::<Vec<_>>();
        if tokens.is_empty() {
            return Ok(());
        }
        for token in tokens {
            token.cancel();
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err(format!(
                "Timed out while stopping active transfers for {}",
                context
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(crate) async fn stop_all_transfers_for_reset() -> Result<TransferRegistryGate, String> {
    let (gate, tokens) = close_transfer_registry()?;
    cancel_tokens(tokens);
    cancel_all_registered_transfers("factory reset").await?;
    Ok(gate)
}

/// Error returned when a transfer observes cancellation.
pub(super) fn cancelled_error() -> String {
    "Transfer cancelled".to_string()
}

pub(super) async fn cleanup_completes_within<F>(timeout: Duration, cleanup: F) -> bool
where
    F: std::future::Future<Output = ()>,
{
    tokio::time::timeout(timeout, cleanup).await.is_ok()
}

/// Abort an unfinished multipart operation without allowing a broken endpoint
/// to hold cancellation or factory reset forever.
pub(super) async fn abort_multipart_upload_bounded(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
) {
    let request = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .send();
    let _ = cleanup_completes_within(MULTIPART_ABORT_TIMEOUT, async move {
        let _ = request.await;
    })
    .await;
}

/// True only when the service explicitly answered 404.
///
/// Any other failure (403, 5xx, network) must not be read as "absent", otherwise
/// a transient error silently becomes permission to overwrite.
pub(super) fn is_not_found<E: std::fmt::Debug>(err: &aws_sdk_s3::error::SdkError<E>) -> bool {
    use aws_sdk_s3::error::SdkError;
    match err {
        SdkError::ServiceError(ctx) => ctx.raw().status().as_u16() == 404,
        _ => false,
    }
}
