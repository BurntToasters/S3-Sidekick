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
    pub(super) transfer_id: Option<u32>,
    pub(super) token: CancelToken,
}

#[derive(Default)]
pub(super) struct TransferRegistryState {
    pub(super) disabled: bool,
    pub(super) next_registration_id: u64,
    pub(super) registrations: HashMap<u64, ActiveTransfer>,
    pub(super) pending_cancels: HashMap<u32, Instant>,
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
        Self::register_optional(Some(transfer_id))
    }

    pub(super) fn register_optional(transfer_id: Option<u32>) -> Result<Self, String> {
        let token: CancelToken = Arc::new(CancelFlag::default());
        let mut registry = lock_transfer_registry()?;
        if registry.disabled {
            return Err(cancelled_error());
        }
        let now = Instant::now();
        registry
            .pending_cancels
            .retain(|_, created| now.duration_since(*created) <= PENDING_CANCEL_TTL);
        let cancelled_before_registration = transfer_id
            .and_then(|id| registry.pending_cancels.remove(&id))
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
        if registry.disabled
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
pub(crate) fn cancel_transfer(transfer_id: u32) {
    let tokens = transfer_registry()
        .lock()
        .map(|mut registry| {
            let tokens = registry
                .registrations
                .values()
                .filter(|active| active.transfer_id == Some(transfer_id))
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
                        .map(|(id, _)| *id)
                    {
                        registry.pending_cancels.remove(&oldest);
                    }
                }
                registry.pending_cancels.insert(transfer_id, now);
            }
            tokens
        })
        .unwrap_or_default();
    for token in tokens {
        token.cancel();
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

pub(super) fn reopen_transfer_registry() -> Result<(), String> {
    lock_transfer_registry()?.disabled = false;
    Ok(())
}

pub(crate) fn resume_transfers_after_failed_reset() {
    // A poisoned registry remains closed: subsequent registrations also fail,
    // so credential-bearing work can never escape an unobservable drain state.
    let _ = reopen_transfer_registry();
}

pub(super) fn close_transfer_registry() -> Result<Vec<CancelToken>, String> {
    let mut registry = lock_transfer_registry()?;
    registry.disabled = true;
    Ok(registry
        .registrations
        .values()
        .map(|active| Arc::clone(&active.token))
        .collect())
}

pub(super) fn cancel_tokens(tokens: Vec<CancelToken>) {
    for token in tokens {
        token.cancel();
    }
}

pub(super) async fn cancel_all_registered_transfers(context: &str) -> Result<(), String> {
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

pub(crate) async fn stop_all_transfers_for_reset() -> Result<(), String> {
    let tokens = close_transfer_registry()?;
    cancel_tokens(tokens);
    cancel_all_registered_transfers("factory reset").await
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
