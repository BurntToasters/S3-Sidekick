//! SFTP connect flow: transport, host key trust, authentication, and session
//! install.
//!
//! A connect is a backend state machine, because an SSH handshake cannot be
//! replayed. `sftp_connect` starts a task that owns the handshake and the
//! authentication. The task reports each step it needs (an unknown host key,
//! a keyboard-interactive prompt) through a bounded channel, and the commands
//! answer through a reply channel. Only the command that holds the pending
//! attempt's ID can reach that attempt, so a reply never lands in another one.

use std::borrow::Cow;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex as AsyncMutex, Notify};
use zeroize::{Zeroize, Zeroizing};

use super::keyfile::inspect_private_key;
use super::path::{format_sftp_endpoint, join_remote, validate_sftp_host};
use super::session::SftpHandle;
use super::types::{SftpConnectStep, SftpPrompt};
use crate::s3::{
    begin_connect_attempt, blocked_ip_kind, connection_identity, install_connection,
    is_blocked_metadata_host, is_non_canonical_ipv4, mint_connection_id, CancelFlag, CancelToken,
    ConnectAttempt,
};
use crate::{AppState, S3State, StorageProviderKind};

/// Refusal for a server that offers only RSA host keys.
pub(crate) const RSA_HOST_KEY_MESSAGE: &str = "This server only offers RSA host keys. RSA is not supported in this beta; use an Ed25519 or ECDSA host key.";
/// Refusal for a presented host key that does not match the saved pin.
pub(crate) const HOST_KEY_CHANGED_NOTE: &str =
    "Reset the saved host key only if the change is expected.";
/// Message for a connect that was cancelled by the user or by a newer attempt.
pub(crate) const CONNECT_CANCELLED: &str = "SFTP connect cancelled";
/// Message for an attempt ID that is unknown, stale, or belongs to another attempt.
pub(crate) const ATTEMPT_EXPIRED: &str = "Connection attempt expired";
/// Message for an authentication method the server rejects with no detail.
pub(crate) const AUTH_FAILED: &str = "Authentication failed.";
/// Message for a key whose passphrase does not decrypt it.
pub(crate) const PASSPHRASE_INCORRECT: &str = "The private key passphrase is incorrect.";

/// Bound on the SSH handshake (banner and key exchange). Time spent waiting for the user's
/// host key decision does not count against it.
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Prefix of the message for a handshake that did not finish in time.
pub(crate) const HANDSHAKE_TIMED_OUT: &str = "Timed out during the SSH handshake";

/// How long a host key or prompt answer may take before the attempt is refused.
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
/// Bound on TCP connect, so a black-holed address cannot hold the attempt.
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on each channel, subsystem, SFTP init, and home lookup step.
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound on each authentication request.
const AUTH_TIMEOUT: Duration = Duration::from_secs(60);
/// Time limit on each SFTP request once the session is open. The crate default
/// (10 s) fails a large upload whose final fsync takes longer on a slow disk.
/// It stays below the 60 s download idle limit, so a dead link is reported as
/// lost (see `map_sftp_error`) and not as a stall.
pub(crate) const SFTP_REQUEST_TIMEOUT_SECS: u64 = 45;
/// Keepalive probes start after this much idle time on an authenticated session.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// Unanswered keepalives before the connection is closed.
const KEEPALIVE_MAX: usize = 3;
/// Idle limit for the transport. It outlasts a reply wait, so an answer given
/// at the 120 s limit is not lost to the transport timing out first.
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(180);
/// Keyboard-interactive rounds accepted before the attempt is refused.
const MAX_KEYBOARD_INTERACTIVE_ROUNDS: usize = 10;
/// Prompts accepted in one keyboard-interactive round. Real servers send one or two.
const MAX_KEYBOARD_INTERACTIVE_PROMPTS: usize = 16;
/// Longest accepted prompt text or round name, in bytes.
const MAX_PROMPT_TEXT_BYTES: usize = 1024;
/// Longest accepted round instructions, in bytes. Some servers put a banner here.
const MAX_PROMPT_INSTRUCTIONS_BYTES: usize = 4096;
/// Bytes buffered between the TCP socket and the SSH transport.
const TRANSPORT_BUFFER_BYTES: usize = 64 * 1024;
/// Longest accepted SSH username, in bytes.
const MAX_USERNAME_BYTES: usize = 256;

// Failure modes, written before the implementation:
// - A metadata hostname or a DNS answer naming a metadata address is dialled.
// - A hostname with a second DNS answer at connect time bypasses the check.
// - An IPv4 spelling such as `127.1` resolves past the canonical-form check.
// - An unreachable or black-holed server holds the attempt forever.
// - A host key is accepted without a pin and without the user's trust.
// - A pinned key is compared as text, so a comment or spacing change forks it.
// - A changed pinned key is accepted, or refused with a message that leaks
//   the saved key or hides the new fingerprint.
// - An unanswered trust prompt keeps the handshake open indefinitely.

// - A reply meant for one attempt (or a stale ID) is delivered to another.
// - A reply of the wrong kind is treated as an answer instead of a failure.
// - A prompt with a different number of answers is sent to the server.
// - A keyboard-interactive server that loops forever is never refused.
// - An RSA-only server fails with an opaque negotiation error.
// - An RSA host key negotiates, then fails signature verification with no
//   explanation, because the crate's RSA verification is compiled out.
// - Partial authentication is reported as a plain failure, or as success.

// - A failed password echoes the password or the server's raw text.
// - An encrypted key with no passphrase, or a wrong one, fails opaquely.
// - A cancelled attempt leaves its TCP connection open.
// - A cancelled attempt installs a session anyway.
// - A session installed for an endpoint keeps the S3 client or endpoint.
// - Secrets live in plain strings that are never wiped on an error path.

/// The authentication method chosen by the webview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuthMethod {
    Password,
    Key,
    KeyboardInteractive,
}

/// Secrets handed to `sftp_connect`. Zeroized on every exit path, including
/// validation errors, so no early return can leave them in memory.
#[derive(Default)]
pub(crate) struct SftpSecrets {
    pub(crate) password: Option<String>,
    pub(crate) private_key: Option<String>,
    pub(crate) passphrase: Option<String>,
}

impl Drop for SftpSecrets {
    fn drop(&mut self) {
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
        if let Some(key) = self.private_key.as_mut() {
            key.zeroize();
        }
        if let Some(passphrase) = self.passphrase.as_mut() {
            passphrase.zeroize();
        }
    }
}

/// A connect request after validation. Holds no secrets.
pub(crate) struct ConnectRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) endpoint: String,
    pub(crate) username: String,
    pub(crate) method: AuthMethod,
    pub(crate) pin: Option<PublicKey>,
}

/// One message from the attempt task to the command awaiting its next step.
pub(crate) enum AttemptEvent {
    HostKeyUnknown {
        key_type: String,
        fingerprint_sha256: String,
        host_key: String,
    },
    Prompt {
        name: String,
        instructions: String,
        prompts: Vec<SftpPrompt>,
    },
    Connected(Box<ConnectedSession>),
    Failed(String),
}

/// The answer a command forwards to the attempt task.
pub(crate) enum AttemptReply {
    TrustHostKey(bool),
    Responses(Vec<String>),
    /// Neither or both fields were given. Always a failure.
    Invalid,
}

impl Drop for AttemptReply {
    /// Prompt answers can be one-time codes or passwords. A reply that is
    /// dropped unread (cancel, wrong kind, mismatch) wipes them.
    fn drop(&mut self) {
        if let AttemptReply::Responses(answers) = self {
            answers.zeroize();
        }
    }
}

/// A session that is authenticated and ready to install.
pub(crate) struct ConnectedSession {
    pub(crate) sftp: russh_sftp::client::SftpSession,
    pub(crate) ssh: russh::client::Handle<ClientHandler>,
    pub(crate) endpoint: String,
    pub(crate) username: String,
    pub(crate) home: String,
    pub(crate) hardlink_supported: bool,
    pub(crate) host_key: String,
    pub(crate) host_key_fingerprint: String,
    pub(crate) shutdown: CancelToken,
}

/// What the handshake observed about the server key, for error reporting.
#[derive(Default)]
pub(crate) struct HandshakeRecord {
    pub(crate) presented: Option<PresentedHostKey>,
    pub(crate) refusal: Option<String>,
}

/// A server key in the forms the webview and the error messages need.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PresentedHostKey {
    pub(crate) key_type: String,
    pub(crate) fingerprint: String,
    pub(crate) host_key: String,
}

/// Client-side SSH handler for SFTP sessions.
///
/// `check_server_key` runs inside the handshake. A pinned key is accepted only
/// when its key data equals the pin. An unpinned key is handed to the caller
/// as a `HostKeyUnknown` step, and the handshake waits for the answer.
pub(crate) struct ClientHandler {
    endpoint: String,
    pin: Option<PublicKey>,
    events: mpsc::Sender<AttemptEvent>,
    replies: Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
    cancel: CancelToken,
    record: Arc<Mutex<HandshakeRecord>>,
    reply_timeout: Duration,
    clock: Arc<HandshakeClock>,
}

impl ClientHandler {
    fn refuse(&self, message: impl Into<String>) -> bool {
        let message = message.into();
        if let Ok(mut record) = self.record.lock() {
            record.refusal = Some(message);
        }
        false
    }
}

/// The handshake's time budget. It runs while bytes are expected from the
/// server and pauses while the user decides whether to trust the host key, so
/// a slow decision is bounded by `REPLY_TIMEOUT` alone.
pub(crate) struct HandshakeClock {
    state: Mutex<ClockState>,
    changed: Notify,
    /// Least budget the clock restarts with after a trust decision.
    floor: Duration,
}

#[derive(Clone, Copy, Debug)]
struct ClockState {
    /// Budget left when the clock last stopped or started.
    left: Duration,
    /// Set while the clock runs.
    running_since: Option<Instant>,
}

impl ClockState {
    fn remaining(&self, now: Instant) -> Option<Duration> {
        self.running_since.map(|since| {
            self.left
                .saturating_sub(now.saturating_duration_since(since))
        })
    }

    fn pause(&mut self, now: Instant) {
        if let Some(left) = self.remaining(now) {
            self.left = left;
            self.running_since = None;
        }
    }

    /// Restart the clock with at least `floor` left, so the key exchange that
    /// follows a trust decision always has room to finish.
    fn resume(&mut self, now: Instant, floor: Duration) {
        if self.running_since.is_none() {
            self.left = self.left.max(floor);
            self.running_since = Some(now);
        }
    }
}

impl HandshakeClock {
    pub(crate) fn start(budget: Duration, floor: Duration) -> Self {
        Self {
            state: Mutex::new(ClockState {
                left: budget,
                running_since: Some(Instant::now()),
            }),
            changed: Notify::new(),
            floor,
        }
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut ClockState) -> T) -> Option<T> {
        self.state.lock().ok().map(|mut state| f(&mut state))
    }

    fn pause(&self) {
        self.with_state(|state| state.pause(Instant::now()));
        self.changed.notify_one();
    }

    fn resume(&self) {
        let floor = self.floor;
        self.with_state(|state| state.resume(Instant::now(), floor));
        self.changed.notify_one();
    }

    /// Resolve once the budget is spent. A poisoned lock counts as spent.
    async fn expired(&self) {
        loop {
            let notified = self.changed.notified();
            match self.with_state(|state| state.remaining(Instant::now())) {
                None => return,
                Some(Some(left)) if left.is_zero() => return,
                Some(Some(left)) => {
                    tokio::select! {
                        _ = tokio::time::sleep(left) => {}
                        _ = notified => {}
                    }
                }
                // Paused: wait until the trust wait ends.
                Some(None) => notified.await,
            }
        }
    }
}

/// What the trust wait returned, before it is turned into a decision.
enum TrustWait {
    Reply(AttemptReply),
    TimedOut,
    Cancelled,
    Closed,
}

impl PresentedHostKey {
    fn from_key(key: &PublicKey) -> Result<Self, String> {
        let line = key
            .to_openssh()
            .map_err(|_| "The server host key could not be encoded.".to_string())?;
        // The wire key carries no comment; keep only the type and the key data.
        let host_key = line
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        Ok(Self {
            key_type: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            host_key,
        })
    }
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    /// Check the server key against the pin, or ask the user to trust it.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                return Ok(self.refuse(
                    "The server presented an OpenSSH host certificate, which is not supported in this beta.",
                ));
            }
        };
        let presented = match PresentedHostKey::from_key(key) {
            Ok(presented) => presented,
            Err(message) => return Ok(self.refuse(message)),
        };
        if let Ok(mut record) = self.record.lock() {
            record.presented = Some(presented.clone());
        }

        if let Some(pin) = self.pin.as_ref() {
            // Compare key data, not text, so a comment or spacing change is not a change of key.
            if pin.key_data() == key.key_data() {
                return Ok(true);
            }
            return Ok(self.refuse(changed_host_key_message(
                &self.endpoint,
                &presented.fingerprint,
            )));
        }

        let offered = AttemptEvent::HostKeyUnknown {
            key_type: presented.key_type.clone(),
            fingerprint_sha256: presented.fingerprint.clone(),
            host_key: presented.host_key.clone(),
        };
        if self.events.send(offered).await.is_err() {
            return Ok(self.refuse(CONNECT_CANCELLED));
        }
        // The user's decision time does not count against the handshake budget.
        self.clock.pause();
        let wait = {
            let mut replies = self.replies.lock().await;
            tokio::select! {
                _ = self.cancel.cancelled() => TrustWait::Cancelled,
                outcome = tokio::time::timeout(self.reply_timeout, replies.recv()) => match outcome {
                    Err(_) => TrustWait::TimedOut,
                    Ok(Some(reply)) => TrustWait::Reply(reply),
                    Ok(None) => TrustWait::Closed,
                },
            }
        };
        self.clock.resume();
        match wait {
            TrustWait::Reply(AttemptReply::TrustHostKey(true)) => Ok(true),
            TrustWait::Reply(AttemptReply::TrustHostKey(false)) => {
                Ok(self.refuse("The host key was not trusted, so the connection was closed."))
            }
            TrustWait::Reply(_) => Ok(self.refuse(
                "The host key step received an answer of the wrong kind. The connection was closed.",
            )),
            TrustWait::TimedOut => Ok(self.refuse(
                "Host key trust was not confirmed in time. The connection was closed.",
            )),
            TrustWait::Cancelled | TrustWait::Closed => Ok(self.refuse(CONNECT_CANCELLED)),
        }
    }
}

/// Pure check of a validated SFTP request, before any network work.
pub(crate) fn validate_connect_request(
    host: &str,
    port: u16,
    username: &str,
    auth_method: &str,
    secrets: &SftpSecrets,
    pinned_host_key: Option<&str>,
) -> Result<ConnectRequest, String> {
    let canonical_host = validate_sftp_host(host)?;
    let endpoint = format_sftp_endpoint(host, port)?;
    let username = username.to_string();
    if username.is_empty() {
        return Err("SFTP username is required.".to_string());
    }
    if username.len() > MAX_USERNAME_BYTES {
        return Err(format!(
            "SFTP username must be at most {} bytes.",
            MAX_USERNAME_BYTES
        ));
    }
    if username.chars().any(char::is_control) {
        return Err("SFTP username must not contain control characters.".to_string());
    }
    let method = match auth_method {
        "password" => AuthMethod::Password,
        "key" => AuthMethod::Key,
        "keyboard-interactive" => AuthMethod::KeyboardInteractive,
        _ => return Err("Unsupported SFTP authentication method.".to_string()),
    };
    let has_password = secrets
        .password
        .as_deref()
        .is_some_and(|password| !password.is_empty());
    if method == AuthMethod::Password && !has_password {
        return Err("A password is required for password authentication.".to_string());
    }
    let has_key = secrets
        .private_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty());
    if method == AuthMethod::Key && !has_key {
        return Err("A private key is required for key authentication.".to_string());
    }
    let pin = match pinned_host_key
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        Some(line) => Some(
            PublicKey::from_openssh(line)
                .map_err(|_| "The saved host key is not a valid OpenSSH public key.".to_string())?,
        ),
        None => None,
    };
    Ok(ConnectRequest {
        host: canonical_host,
        port,
        endpoint,
        username,
        method,
        pin,
    })
}

/// Refuse resolved addresses that name a cloud metadata service.
///
/// `host` is the validated host name. Every resolved address is classified, so
/// one unsafe answer among safe ones refuses the whole connect.
pub(crate) fn check_resolved_addresses(host: &str, addrs: &[SocketAddr]) -> Result<(), String> {
    if is_blocked_metadata_host(host) {
        return Err(format!(
            "SFTP host {} names a cloud metadata service, which is not allowed.",
            host
        ));
    }
    if is_non_canonical_ipv4(host) {
        return Err(format!(
            "SFTP host {} is a non-canonical IPv4 literal; use the dotted-quad form.",
            host
        ));
    }
    if addrs.is_empty() {
        return Err(format!(
            "SFTP host {} did not resolve to any address.",
            host
        ));
    }
    for address in addrs {
        if let Some(kind) = blocked_ip_kind(address.ip()) {
            return Err(format!(
                "SFTP host {} resolves to an unsafe {} address ({}), which is not allowed.",
                host,
                kind,
                address.ip()
            ));
        }
    }
    Ok(())
}

/// Message for a server key that does not match the saved pin.
pub(crate) fn changed_host_key_message(endpoint: &str, fingerprint: &str) -> String {
    format!(
        "The SSH host key for {} changed. The server presented {}, which does not match the saved host key. {}",
        endpoint, fingerprint, HOST_KEY_CHANGED_NOTE
    )
}

/// Message for a failed authentication, given the methods the server reports.
///
/// A partial success names the methods still required, which this client does
/// not offer after the first one. Any other failure keeps the fixed message, so
/// no server text or secret reaches the webview.
pub(crate) fn auth_failure_message(partial_success: bool, remaining: &[String]) -> String {
    if partial_success && !remaining.is_empty() {
        return format!(
            "The server requires another authentication method ({}) after this one. Multi-step authentication is not supported in this beta.",
            remaining.join(", ")
        );
    }
    AUTH_FAILED.to_string()
}

/// The RSA-only refusal, when the handshake failed for that reason alone.
pub(crate) fn host_key_failure_message(err: &russh::Error) -> Option<String> {
    match err {
        russh::Error::NoCommonAlgo {
            kind: russh::AlgorithmKind::Key,
            theirs,
            ..
        } => {
            let offers_rsa = theirs.iter().any(|name| name.contains("rsa"));
            let offers_supported = theirs
                .iter()
                .any(|name| name.starts_with("ssh-ed25519") || name.starts_with("ecdsa-"));
            if offers_rsa && !offers_supported {
                Some(RSA_HOST_KEY_MESSAGE.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Start an SFTP connection and return the first step of the connect flow.
///
/// `auth_method` selects how `password`, `private_key`, and `passphrase` are
/// used. `pinned_host_key` is the OpenSSH key line the user already trusts, if
/// any. Returns a `connected` step only once the session is installed.
#[tauri::command(async)]
pub(crate) fn sftp_connect(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    pinned_host_key: Option<String>,
) -> impl std::future::Future<Output = Result<SftpConnectStep, String>> + Send + use<'_> {
    Box::pin(sftp_connect_inner(
        state,
        host,
        port,
        username,
        auth_method,
        password,
        private_key,
        passphrase,
        pinned_host_key,
    ))
}

async fn sftp_connect_inner(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    pinned_host_key: Option<String>,
) -> Result<SftpConnectStep, String> {
    let epoch = CANCEL_EPOCH.load(Ordering::SeqCst);
    // Own the secrets before any check, so every early return wipes them.
    let secrets = SftpSecrets {
        password,
        private_key,
        passphrase,
    };
    let request = validate_connect_request(
        &host,
        port,
        &username,
        &auth_method,
        &secrets,
        pinned_host_key.as_deref(),
    )?;
    let attempt = Arc::new(begin_connect_attempt(&state)?);
    let attempt_id = mint_connection_id();
    let (reply_tx, reply_rx) = mpsc::channel(1);
    let (event_tx, event_rx) = mpsc::channel(4);
    let replies = Arc::new(AsyncMutex::new(reply_rx));
    let events = Arc::new(AsyncMutex::new(event_rx));

    // One pending attempt at a time: this one replaces, and cancels, any older one.
    let superseded = {
        let mut slot = lock_pending()?;
        slot.replace(PendingAttempt {
            attempt_id: attempt_id.clone(),
            attempt: Arc::clone(&attempt),
            replies: reply_tx,
            events: Arc::clone(&events),
        })
    };
    if let Some(older) = superseded {
        older.attempt.token().cancel();
    }
    // A cancel that arrived while this connect was starting was meant for it.
    if CANCEL_EPOCH.load(Ordering::SeqCst) != epoch {
        clear_pending(&attempt_id);
        attempt.token().cancel();
        return Err(CONNECT_CANCELLED.to_string());
    }

    let task = AttemptTask {
        attempt_id: attempt_id.clone(),
        request,
        secrets,
        cancel: attempt.token(),
        events: event_tx,
        replies,
    };
    tauri::async_runtime::spawn(run_attempt(task));
    next_step(&state, &attempt_id, &attempt, &events).await
}

/// The pending attempt the commands can reach: its ID, its state, and the
/// channels to its task. Only the ID that matches can receive an answer.
struct PendingAttempt {
    attempt_id: String,
    attempt: Arc<ConnectAttempt>,
    replies: mpsc::Sender<AttemptReply>,
    events: Arc<AsyncMutex<mpsc::Receiver<AttemptEvent>>>,
}

/// The one slot holding the pending attempt. Never held across an await, and
/// never taken while the S3State lock is held.
static PENDING: Mutex<Option<PendingAttempt>> = Mutex::new(None);

/// Bumped by every `sftp_connect_cancel_pending`. A connect that sees it change
/// between entering and taking the slot cancels itself.
static CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);

fn lock_pending() -> Result<std::sync::MutexGuard<'static, Option<PendingAttempt>>, String> {
    PENDING
        .lock()
        .map_err(|_| "SFTP connect state is unavailable".to_string())
}

/// Clear the pending slot, but only when it still holds this attempt.
fn clear_pending(attempt_id: &str) {
    if let Ok(mut slot) = PENDING.lock() {
        if slot
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id)
        {
            *slot = None;
        }
    }
}

/// True while a connect attempt is pending. Test-only probe for the E2E checks.
#[cfg(test)]
pub(crate) fn has_pending_attempt() -> bool {
    lock_pending().map(|slot| slot.is_some()).unwrap_or(false)
}

/// Wait for the attempt's next step and turn it into the command's result.
async fn next_step(
    state: &tauri::State<'_, AppState>,
    attempt_id: &str,
    attempt: &Arc<ConnectAttempt>,
    events: &Arc<AsyncMutex<mpsc::Receiver<AttemptEvent>>>,
) -> Result<SftpConnectStep, String> {
    let event = events.lock().await.recv().await;
    match event {
        Some(AttemptEvent::HostKeyUnknown {
            key_type,
            fingerprint_sha256,
            host_key,
        }) => Ok(SftpConnectStep::HostKeyUnknown {
            attempt_id: attempt_id.to_string(),
            key_type,
            fingerprint_sha256,
            host_key,
        }),
        Some(AttemptEvent::Prompt {
            name,
            instructions,
            prompts,
        }) => Ok(SftpConnectStep::Prompt {
            attempt_id: attempt_id.to_string(),
            name,
            instructions,
            prompts,
        }),
        Some(AttemptEvent::Connected(session)) => {
            finish_connect(state, attempt_id, attempt, *session).await
        }
        Some(AttemptEvent::Failed(message)) => {
            clear_pending(attempt_id);
            Err(message)
        }
        None => {
            clear_pending(attempt_id);
            Err(if attempt.is_cancelled() {
                CONNECT_CANCELLED.to_string()
            } else {
                ATTEMPT_EXPIRED.to_string()
            })
        }
    }
}

/// Install an authenticated session as the live one, replacing every S3 field.
async fn finish_connect(
    state: &tauri::State<'_, AppState>,
    attempt_id: &str,
    attempt: &Arc<ConnectAttempt>,
    session: ConnectedSession,
) -> Result<SftpConnectStep, String> {
    let endpoint = session.endpoint.clone();
    let username = session.username.clone();
    let identity = connection_identity(&endpoint, &username);
    let home = session.home.clone();
    let host_key = session.host_key.clone();
    let fingerprint = session.host_key_fingerprint.clone();
    let hardlink_supported = session.hardlink_supported;
    let handle = Arc::new(SftpHandle {
        sftp: session.sftp,
        ssh: session.ssh,
        endpoint: endpoint.clone(),
        username: username.clone(),
        home: home.clone(),
        hardlink_supported,
        shutdown: session.shutdown,
    });
    let install_identity = identity.clone();
    let installed = install_connection(state, attempt, move |s3: &mut S3State| {
        s3.client = None;
        s3.endpoint.clear();
        s3.region.clear();
        s3.bucket_hint = None;
        s3.storage_provider = StorageProviderKind::default();
        s3.connection_identity = Some(install_identity);
        s3.sftp = Some(handle);
        Ok(())
    })
    .await;
    clear_pending(attempt_id);
    let connection_id = installed?;
    Ok(SftpConnectStep::Connected {
        connection_id,
        connection_identity: identity,
        endpoint,
        home_path: home,
        host_key,
        host_key_fingerprint: fingerprint,
        create_only_supported: hardlink_supported,
    })
}

/// Advance a pending connect attempt with the user's answer.
///
/// `trust_host_key` answers a `host_key_unknown` step. `responses` answers a
/// `prompt` step, in prompt order.
#[tauri::command(async)]
pub(crate) fn sftp_connect_continue(
    state: tauri::State<'_, AppState>,
    attempt_id: String,
    trust_host_key: Option<bool>,
    responses: Option<Vec<String>>,
) -> impl std::future::Future<Output = Result<SftpConnectStep, String>> + Send + use<'_> {
    Box::pin(sftp_connect_continue_inner(
        state,
        attempt_id,
        trust_host_key,
        responses,
    ))
}

async fn sftp_connect_continue_inner(
    state: tauri::State<'_, AppState>,
    attempt_id: String,
    trust_host_key: Option<bool>,
    responses: Option<Vec<String>>,
) -> Result<SftpConnectStep, String> {
    // Only the pending attempt with this exact ID may receive the answer.
    let (replies, attempt, events) = {
        let slot = lock_pending()?;
        match slot.as_ref() {
            Some(pending) if pending.attempt_id == attempt_id => (
                pending.replies.clone(),
                Arc::clone(&pending.attempt),
                Arc::clone(&pending.events),
            ),
            _ => return Err(ATTEMPT_EXPIRED.to_string()),
        }
    };
    let reply = match (trust_host_key, responses) {
        (Some(trust), None) => AttemptReply::TrustHostKey(trust),
        (None, Some(answers)) => AttemptReply::Responses(answers),
        _ => AttemptReply::Invalid,
    };
    if replies.send(reply).await.is_err() {
        clear_pending(&attempt_id);
        return Err(ATTEMPT_EXPIRED.to_string());
    }
    next_step(&state, &attempt_id, &attempt, &events).await
}

/// Cancel a pending connect attempt. It has no effect on a live session.
///
/// An unknown or stale ID is a no-op, so a late cancel from the webview is safe.
#[tauri::command]
pub(crate) async fn sftp_connect_cancel(attempt_id: String) -> Result<(), String> {
    let cancelled = {
        let mut slot = lock_pending()?;
        let matches = slot
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id);
        if matches {
            slot.take()
        } else {
            None
        }
    };
    if let Some(pending) = cancelled {
        pending.attempt.token().cancel();
    }
    Ok(())
}

/// Cancel whichever connect attempt is pending, including one that has not
/// reported a step yet and so has no ID the webview could name.
///
/// There is only one pending slot and one connect form, so cancelling whatever
/// it holds is always what the user asked for. It never touches a live session.
/// The cancel epoch also reaches a connect that has entered `sftp_connect` but
/// not yet taken the slot.
#[tauri::command]
pub(crate) async fn sftp_connect_cancel_pending() -> Result<(), String> {
    CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
    let cancelled = lock_pending()?.take();
    if let Some(pending) = cancelled {
        pending.attempt.token().cancel();
    }
    Ok(())
}

/// The inputs of one connect attempt's task, moved into it.
struct AttemptTask {
    attempt_id: String,
    request: ConnectRequest,
    secrets: SftpSecrets,
    cancel: CancelToken,
    events: mpsc::Sender<AttemptEvent>,
    replies: Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
}

/// Run one attempt to completion and report its outcome as the last event.
///
/// The attempt's cancel token aborts every step. Dropping the futures closes the
/// TCP connection, because the transport pump owns the socket and sees the
/// cancellation too.
async fn run_attempt(task: AttemptTask) {
    let AttemptTask {
        attempt_id,
        request,
        secrets,
        cancel,
        events,
        replies,
    } = task;
    let outcome = tokio::select! {
        _ = cancel.cancelled() => Err(CONNECT_CANCELLED.to_string()),
        result = establish(&request, &secrets, &cancel, &events, &replies) => result,
    };
    // A task that ends releases its slot, so an abandoned attempt (for example a
    // host key nobody answered) cannot keep its transfer registration open.
    clear_pending(&attempt_id);
    let event = match outcome {
        Ok(session) => AttemptEvent::Connected(Box::new(session)),
        Err(message) => AttemptEvent::Failed(message),
    };
    // A closed channel means the attempt was superseded or cancelled.
    let _ = events.send(event).await;
}

/// Resolve, connect, handshake, and authenticate, then open the SFTP subsystem.
///
/// A failure at any step cancels `shutdown`, so the socket closes even when the
/// SSH handle was never handed to a session.
async fn establish(
    request: &ConnectRequest,
    secrets: &SftpSecrets,
    cancel: &CancelToken,
    events: &mpsc::Sender<AttemptEvent>,
    replies: &Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
) -> Result<ConnectedSession, String> {
    // Stays with the installed session: cancelling it closes the socket.
    let shutdown: CancelToken = Arc::new(CancelFlag::default());
    let outcome = establish_session(request, secrets, cancel, events, replies, &shutdown).await;
    if outcome.is_err() {
        shutdown.cancel();
    }
    outcome
}

async fn establish_session(
    request: &ConnectRequest,
    secrets: &SftpSecrets,
    cancel: &CancelToken,
    events: &mpsc::Sender<AttemptEvent>,
    replies: &Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
    shutdown: &CancelToken,
) -> Result<ConnectedSession, String> {
    let addrs = resolve(request, cancel).await?;
    let tcp = connect_tcp(request, &addrs, cancel).await?;
    let transport = start_transport(tcp, cancel.clone(), shutdown.clone());

    let record = Arc::new(Mutex::new(HandshakeRecord::default()));
    let clock = Arc::new(HandshakeClock::start(HANDSHAKE_TIMEOUT, STEP_TIMEOUT));
    let handler = ClientHandler {
        endpoint: request.endpoint.clone(),
        pin: request.pin.clone(),
        events: events.clone(),
        replies: Arc::clone(replies),
        cancel: cancel.clone(),
        record: Arc::clone(&record),
        reply_timeout: REPLY_TIMEOUT,
        clock: Arc::clone(&clock),
    };
    // russh reads the server banner with no time limit of its own, so a server
    // that accepts TCP and never speaks is bounded here.
    let connecting = russh::client::connect_stream(Arc::new(client_config()), transport, handler);
    let mut ssh = tokio::select! {
        _ = cancel.cancelled() => return Err(CONNECT_CANCELLED.to_string()),
        _ = clock.expired() => return Err(format!(
            "{} with {}: the server did not complete the handshake within {} seconds.",
            HANDSHAKE_TIMED_OUT,
            request.endpoint,
            HANDSHAKE_TIMEOUT.as_secs()
        )),
        result = connecting => result.map_err(|err| handshake_error(&request.endpoint, &record, err))?,
    };

    authenticate(&mut ssh, request, secrets, cancel, events, replies).await?;
    let (sftp, home, hardlink_supported) = open_sftp(&ssh, cancel).await?;

    let presented = record
        .lock()
        .ok()
        .and_then(|record| record.presented.clone())
        .ok_or_else(|| "The server host key was not recorded.".to_string())?;
    Ok(ConnectedSession {
        sftp,
        ssh,
        endpoint: request.endpoint.clone(),
        username: request.username.clone(),
        home,
        hardlink_supported,
        host_key: presented.host_key,
        host_key_fingerprint: presented.fingerprint,
        shutdown: Arc::clone(shutdown),
    })
}

/// Bound one step by a time limit and by the attempt's cancel token.
async fn bounded<F: Future>(
    cancel: &CancelToken,
    limit: Duration,
    what: &str,
    work: F,
) -> Result<F::Output, String> {
    tokio::select! {
        _ = cancel.cancelled() => Err(CONNECT_CANCELLED.to_string()),
        outcome = tokio::time::timeout(limit, work) => {
            outcome.map_err(|_| format!("Timed out {}.", what))
        }
    }
}

async fn resolve(
    request: &ConnectRequest,
    cancel: &CancelToken,
) -> Result<Vec<SocketAddr>, String> {
    let host = request.host.clone();
    let port = request.port;
    let addrs = bounded(
        cancel,
        TCP_CONNECT_TIMEOUT,
        "resolving the host",
        async move {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map(|found| found.collect::<Vec<SocketAddr>>())
        },
    )
    .await?
    .map_err(|err| format!("Could not resolve {}: {}", request.endpoint, err))?;
    check_resolved_addresses(&request.host, &addrs)?;
    Ok(addrs)
}

/// Connect to the validated addresses only. No second lookup happens here, so
/// the addresses checked above are the addresses dialled.
async fn connect_tcp(
    request: &ConnectRequest,
    addrs: &[SocketAddr],
    cancel: &CancelToken,
) -> Result<TcpStream, String> {
    let stream = bounded(
        cancel,
        TCP_CONNECT_TIMEOUT,
        "connecting",
        TcpStream::connect(addrs),
    )
    .await?
    .map_err(|err| format!("Could not connect to {}: {}", request.endpoint, err))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Bridge the TCP socket to the SSH transport through an in-memory pipe.
///
/// The pump owns the socket. Cancelling the attempt, cancelling `shutdown` (the
/// installed session was dropped), or the SSH side going away ends the pump,
/// which drops the socket and closes the connection.
fn start_transport(
    tcp: TcpStream,
    cancel: CancelToken,
    shutdown: CancelToken,
) -> tokio::io::DuplexStream {
    let (ssh_side, mut pump_side) = tokio::io::duplex(TRANSPORT_BUFFER_BYTES);
    tauri::async_runtime::spawn(async move {
        let mut tcp = tcp;
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = shutdown.cancelled() => {}
            _ = tokio::io::copy_bidirectional(&mut tcp, &mut pump_side) => {}
        }
    });
    ssh_side
}

fn client_config() -> russh::client::Config {
    russh::client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        inactivity_timeout: Some(INACTIVITY_TIMEOUT),
        // Only host key algorithms this build can verify. The crate is built
        // without its RSA support, so an RSA key would negotiate and then fail
        // signature verification; leaving RSA out makes negotiation fail with
        // a no-common-algorithm error that names the RSA-only server.
        preferred: russh::Preferred {
            key: Cow::Owned(vec![
                russh::keys::Algorithm::Ed25519,
                russh::keys::Algorithm::Ecdsa {
                    curve: russh::keys::EcdsaCurve::NistP256,
                },
                russh::keys::Algorithm::Ecdsa {
                    curve: russh::keys::EcdsaCurve::NistP384,
                },
                russh::keys::Algorithm::Ecdsa {
                    curve: russh::keys::EcdsaCurve::NistP521,
                },
            ]),
            // Compression is never offered: the crate is built without flate2.
            compression: Cow::Borrowed(&[russh::compression::NONE]),
            ..russh::Preferred::default()
        },
        ..russh::client::Config::default()
    }
}

/// Map a failed handshake to the reason the user should see.
fn handshake_error(endpoint: &str, record: &Mutex<HandshakeRecord>, err: russh::Error) -> String {
    if let Some(refusal) = record.lock().ok().and_then(|record| record.refusal.clone()) {
        return refusal;
    }
    if let Some(message) = host_key_failure_message(&err) {
        return message;
    }
    format!("Could not connect to {}: {}", endpoint, err)
}

/// Turn an authentication result into success or the refusal message.
fn auth_outcome(result: AuthResult) -> Result<(), String> {
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => Err(failure_message(partial_success, &remaining_methods)),
    }
}

fn failure_message(partial_success: bool, remaining: &russh::MethodSet) -> String {
    let names: Vec<String> = remaining.iter().map(String::from).collect();
    auth_failure_message(partial_success, &names)
}

fn connection_lost(_: russh::Error) -> String {
    "The SSH connection closed during authentication.".to_string()
}

async fn authenticate(
    ssh: &mut russh::client::Handle<ClientHandler>,
    request: &ConnectRequest,
    secrets: &SftpSecrets,
    cancel: &CancelToken,
    events: &mpsc::Sender<AttemptEvent>,
    replies: &Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
) -> Result<(), String> {
    let user = request.username.clone();
    match request.method {
        AuthMethod::Password => {
            // The copy moves into russh, which owns it from here; no copy stays on this side.
            let password = secrets.password.clone().unwrap_or_default();
            let result = bounded(
                cancel,
                AUTH_TIMEOUT,
                "waiting for password authentication",
                ssh.authenticate_password(user, password),
            )
            .await?
            .map_err(connection_lost)?;
            auth_outcome(result)
        }
        AuthMethod::Key => {
            let key = decode_private_key(secrets)?;
            let result = bounded(
                cancel,
                AUTH_TIMEOUT,
                "waiting for key authentication",
                ssh.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), None)),
            )
            .await?
            .map_err(connection_lost)?;
            auth_outcome(result)
        }
        AuthMethod::KeyboardInteractive => {
            keyboard_interactive(ssh, &user, cancel, events, replies).await
        }
    }
}

/// Decode the private key with its passphrase, after the format checks.
fn decode_private_key(secrets: &SftpSecrets) -> Result<PrivateKey, String> {
    let text = secrets.private_key.as_deref().unwrap_or_default();
    let (algorithm, encrypted) = inspect_private_key(text)?;
    let passphrase = secrets
        .passphrase
        .as_deref()
        .filter(|passphrase| !passphrase.is_empty());
    if encrypted && passphrase.is_none() {
        return Err("The private key is encrypted. Enter its passphrase.".to_string());
    }
    russh::keys::decode_secret_key(text, passphrase).map_err(|_| {
        if !encrypted {
            "The private key could not be read.".to_string()
        } else if algorithm == "unknown" {
            "The private key could not be decrypted. Check the passphrase, or use an Ed25519 or ECDSA key.".to_string()
        } else {
            PASSPHRASE_INCORRECT.to_string()
        }
    })
}

/// Answer keyboard-interactive rounds. Rounds with no prompts are answered
/// with an empty list; rounds with prompts go to the user.
async fn keyboard_interactive(
    ssh: &mut russh::client::Handle<ClientHandler>,
    user: &str,
    cancel: &CancelToken,
    events: &mpsc::Sender<AttemptEvent>,
    replies: &Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
) -> Result<(), String> {
    let mut response = bounded(
        cancel,
        AUTH_TIMEOUT,
        "waiting for keyboard-interactive authentication",
        ssh.authenticate_keyboard_interactive_start(user.to_string(), None::<String>),
    )
    .await?
    .map_err(connection_lost)?;
    for _ in 0..MAX_KEYBOARD_INTERACTIVE_ROUNDS {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => return Err(failure_message(partial_success, &remaining_methods)),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                check_prompt_limits(&name, &instructions, &prompts)?;
                let mut answers = if prompts.is_empty() {
                    Zeroizing::new(Vec::new())
                } else {
                    let offered = prompts
                        .iter()
                        .map(|prompt| SftpPrompt {
                            text: prompt.prompt.clone(),
                            echo: prompt.echo,
                        })
                        .collect();
                    events
                        .send(AttemptEvent::Prompt {
                            name,
                            instructions,
                            prompts: offered,
                        })
                        .await
                        .map_err(|_| CONNECT_CANCELLED.to_string())?;
                    let answers = Zeroizing::new(wait_for_responses(cancel, replies).await?);
                    if answers.len() != prompts.len() {
                        return Err(
                            "The number of answers does not match the number of prompts."
                                .to_string(),
                        );
                    }
                    answers
                };
                response = bounded(
                    cancel,
                    AUTH_TIMEOUT,
                    "waiting for the server",
                    // Moving the strings out copies no bytes; the emptied vector is wiped on drop.
                    ssh.authenticate_keyboard_interactive_respond(std::mem::take(&mut *answers)),
                )
                .await?
                .map_err(connection_lost)?;
            }
        }
    }
    Err("The server asked for too many keyboard-interactive rounds.".to_string())
}

/// Refuse a keyboard-interactive round that no real server sends, before any of
/// its text reaches the webview.
fn check_prompt_limits(
    name: &str,
    instructions: &str,
    prompts: &[russh::client::Prompt],
) -> Result<(), String> {
    if prompts.len() > MAX_KEYBOARD_INTERACTIVE_PROMPTS {
        return Err(format!(
            "The server sent {} sign-in prompts in one step; at most {} are accepted.",
            prompts.len(),
            MAX_KEYBOARD_INTERACTIVE_PROMPTS
        ));
    }
    if name.len() > MAX_PROMPT_TEXT_BYTES
        || instructions.len() > MAX_PROMPT_INSTRUCTIONS_BYTES
        || prompts
            .iter()
            .any(|prompt| prompt.prompt.len() > MAX_PROMPT_TEXT_BYTES)
    {
        return Err("The server sent sign-in text that is too long to show.".to_string());
    }
    Ok(())
}

/// Wait for the user's answers to a prompt step. Any other reply fails the attempt.
async fn wait_for_responses(
    cancel: &CancelToken,
    replies: &Arc<AsyncMutex<mpsc::Receiver<AttemptReply>>>,
) -> Result<Vec<String>, String> {
    let mut receiver = replies.lock().await;
    let reply = bounded(
        cancel,
        REPLY_TIMEOUT,
        "waiting for the prompt answer",
        receiver.recv(),
    )
    .await?;
    let Some(mut reply) = reply else {
        return Err(CONNECT_CANCELLED.to_string());
    };
    // The answers are taken out of the reply, which wipes whatever is left when it drops.
    match &mut reply {
        AttemptReply::Responses(answers) => Ok(std::mem::take(answers)),
        _ => Err(
            "The prompt step received an answer of the wrong kind. The connection was closed."
                .to_string(),
        ),
    }
}

/// Open the SFTP subsystem, read the home directory, and report the features.
async fn open_sftp(
    ssh: &russh::client::Handle<ClientHandler>,
    cancel: &CancelToken,
) -> Result<(SftpSession, String, bool), String> {
    let channel = bounded(
        cancel,
        STEP_TIMEOUT,
        "opening a session channel",
        ssh.channel_open_session(),
    )
    .await?
    .map_err(|_| "The server did not open a session channel.".to_string())?;
    bounded(
        cancel,
        STEP_TIMEOUT,
        "starting the SFTP subsystem",
        channel.request_subsystem(true, "sftp"),
    )
    .await?
    .map_err(|_| "The server refused the SFTP subsystem.".to_string())?;
    let stream = channel.into_stream();
    let sftp = bounded(
        cancel,
        STEP_TIMEOUT,
        "starting SFTP",
        SftpSession::new(stream),
    )
    .await?
    .map_err(|err| format!("SFTP setup failed: {}", err))?;
    sftp.set_timeout(SFTP_REQUEST_TIMEOUT_SECS);
    let home = bounded(
        cancel,
        STEP_TIMEOUT,
        "reading the home directory",
        sftp.canonicalize("."),
    )
    .await?
    .map_err(|err| format!("Could not read the home directory: {}", err))?;
    if !home.starts_with('/') {
        return Err("The server returned a relative home directory.".to_string());
    }
    let hardlink_supported = probe_hardlink(&sftp, &home, cancel).await?;
    Ok((sftp, home, hardlink_supported))
}

/// Detect the hardlink extension without changing anything on the server.
///
/// russh-sftp returns `Ok(false)` without sending a request when the server did
/// not advertise `hardlink@openssh.com`. Otherwise the request goes out with a
/// source name that does not exist, so the server can only answer with an error
/// and creates no link. Only "no such file" proves the server tried to link: a
/// refusal, a transport error or a timeout reads as unsupported, which keeps
/// create-only copies off.
async fn probe_hardlink(
    sftp: &SftpSession,
    home: &str,
    cancel: &CancelToken,
) -> Result<bool, String> {
    let nonce = crate::s3::mint_connection_id();
    let source = join_remote(home, &format!(".s3sk-probe-{}", nonce))?;
    let link = join_remote(home, &format!(".s3sk-probe-{}-link", nonce))?;
    let probe = bounded(
        cancel,
        STEP_TIMEOUT,
        "probing hardlink support",
        sftp.hardlink(source, link.clone()),
    )
    .await;
    match probe {
        Ok(Ok(false)) => Ok(false),
        Ok(Ok(true)) => {
            // Impossible for a source that does not exist; remove any link left behind.
            let _ = bounded(
                cancel,
                STEP_TIMEOUT,
                "removing the probe link",
                sftp.remove_file(link),
            )
            .await;
            Ok(true)
        }
        Ok(Err(russh_sftp::client::error::Error::Status(status))) => {
            Ok(status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile)
        }
        Ok(Err(_)) => Ok(false),
        Err(_) if cancel.is_cancelled() => Err(CONNECT_CANCELLED.to_string()),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::Handler as _;
    use russh::AlgorithmKind;

    const ED25519_PUBLIC: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGTIFn3brTSt8TEEyTAWsMMXQEDGpccSBAoZiy3Fyq1";
    const OTHER_PUBLIC: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNRWKrW/Ix6DHre33Fm/QJfErUicXklFpXer+F++wta0GWPyFQWBrRQToygc8kcWVuMIbDc5PMG1iym1Ms840+Q=";

    fn parse(line: &str) -> PublicKey {
        PublicKey::from_openssh(line).expect("fixture public key parses")
    }

    fn secrets() -> SftpSecrets {
        SftpSecrets {
            password: Some("pw".to_string()),
            private_key: None,
            passphrase: None,
        }
    }

    // --- request validation -------------------------------------------------

    #[test]
    fn validation_accepts_a_password_request_and_builds_the_endpoint() {
        let request =
            validate_connect_request("Example.COM", 2222, "alice", "password", &secrets(), None)
                .expect("valid request");
        assert_eq!(request.host, "example.com");
        assert_eq!(request.port, 2222);
        assert_eq!(request.endpoint, "sftp://example.com:2222");
        assert_eq!(request.username, "alice");
        assert_eq!(request.method, AuthMethod::Password);
        assert!(request.pin.is_none());
    }

    #[test]
    fn validation_refuses_hosts_with_schemes_paths_or_ports() {
        for host in [
            "sftp://example.com",
            "example.com/path",
            "example.com:22",
            "",
        ] {
            assert!(
                validate_connect_request(host, 22, "alice", "password", &secrets(), None).is_err(),
                "host must be refused: {host}"
            );
        }
    }

    #[test]
    fn validation_refuses_port_zero() {
        let err = validate_connect_request("example.com", 0, "alice", "password", &secrets(), None)
            .err()
            .unwrap_or_default();
        assert!(err.contains("between 1 and 65535"), "unexpected: {err}");
    }

    #[test]
    fn validation_refuses_empty_long_and_control_character_usernames() {
        let long = "u".repeat(MAX_USERNAME_BYTES + 1);
        for username in ["", long.as_str(), "bad\nname", "bad\0name"] {
            assert!(
                validate_connect_request("example.com", 22, username, "password", &secrets(), None)
                    .is_err(),
                "username must be refused"
            );
        }
        let limit = "u".repeat(MAX_USERNAME_BYTES);
        assert!(
            validate_connect_request("example.com", 22, &limit, "password", &secrets(), None)
                .is_ok(),
            "a username at the byte limit is accepted"
        );
    }

    #[test]
    fn validation_refuses_unknown_auth_methods() {
        assert!(
            validate_connect_request("example.com", 22, "alice", "gssapi", &secrets(), None)
                .is_err()
        );
    }

    #[test]
    fn validation_requires_a_password_for_password_auth() {
        let missing = SftpSecrets::default();
        assert!(
            validate_connect_request("example.com", 22, "alice", "password", &missing, None)
                .is_err()
        );
        let mut empty = SftpSecrets::default();
        empty.password = Some(String::new());
        assert!(
            validate_connect_request("example.com", 22, "alice", "password", &empty, None).is_err()
        );
    }

    #[test]
    fn validation_requires_a_private_key_for_key_auth_and_no_password() {
        let mut key_request = SftpSecrets::default();
        key_request.private_key = Some("key-text".to_string());
        let request =
            validate_connect_request("example.com", 22, "alice", "key", &key_request, None)
                .expect("key request");
        assert_eq!(request.method, AuthMethod::Key);
        assert!(
            validate_connect_request("example.com", 22, "alice", "key", &secrets(), None).is_err(),
            "key auth without a key is refused"
        );
    }

    #[test]
    fn validation_needs_no_secret_for_keyboard_interactive() {
        let request = validate_connect_request(
            "example.com",
            22,
            "alice",
            "keyboard-interactive",
            &SftpSecrets::default(),
            None,
        )
        .expect("keyboard-interactive request");
        assert_eq!(request.method, AuthMethod::KeyboardInteractive);
    }

    #[test]
    fn validation_parses_a_pinned_host_key_and_refuses_a_malformed_one() {
        let request = validate_connect_request(
            "example.com",
            22,
            "alice",
            "password",
            &secrets(),
            Some(ED25519_PUBLIC),
        )
        .expect("valid pin");
        assert!(request.pin.is_some());
        assert!(validate_connect_request(
            "example.com",
            22,
            "alice",
            "password",
            &secrets(),
            Some("not a key"),
        )
        .is_err());
        let blank = validate_connect_request(
            "example.com",
            22,
            "alice",
            "password",
            &secrets(),
            Some("  "),
        )
        .expect("blank pin means no pin");
        assert!(blank.pin.is_none());
    }

    // --- host policy --------------------------------------------------------

    fn addr(text: &str) -> SocketAddr {
        SocketAddr::new(text.parse().expect("ip literal"), 22)
    }

    #[test]
    fn host_policy_refuses_metadata_host_names_before_resolution() {
        for host in ["metadata.google.internal", "instance-data.ec2.internal"] {
            assert!(
                check_resolved_addresses(host, &[addr("127.0.0.1")]).is_err(),
                "metadata host must be refused: {host}"
            );
        }
    }

    #[test]
    fn host_policy_refuses_any_metadata_address_among_safe_answers() {
        assert!(check_resolved_addresses("example.com", &[addr("169.254.169.254")]).is_err());
        assert!(check_resolved_addresses("example.com", &[addr("fd00:ec2::254")]).is_err());
        assert!(check_resolved_addresses(
            "example.com",
            &[addr("127.0.0.1"), addr("169.254.169.254")]
        )
        .is_err());
        assert!(
            check_resolved_addresses("example.com", &[addr("::ffff:169.254.169.254")]).is_err()
        );
    }

    #[test]
    fn host_policy_refuses_non_canonical_ipv4_spellings() {
        assert!(check_resolved_addresses("127.1", &[addr("127.0.0.1")]).is_err());
    }

    #[test]
    fn host_policy_refuses_an_empty_resolution() {
        assert!(check_resolved_addresses("example.com", &[]).is_err());
    }

    #[test]
    fn host_policy_accepts_loopback_private_and_public_answers() {
        for text in [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.20",
            "203.0.113.7",
            "2001:db8::1",
        ] {
            assert!(
                check_resolved_addresses("example.com", &[addr(text)]).is_ok(),
                "address must be accepted: {text}"
            );
        }
    }

    // --- messages -----------------------------------------------------------

    #[test]
    fn changed_key_message_names_the_endpoint_and_the_new_fingerprint() {
        let message = changed_host_key_message("sftp://example.com:22", "SHA256:abc");
        assert!(message.contains("sftp://example.com:22"), "{message}");
        assert!(message.contains("SHA256:abc"), "{message}");
        assert!(message.contains("changed"), "{message}");
        assert!(message.contains(HOST_KEY_CHANGED_NOTE), "{message}");
    }

    #[test]
    fn a_plain_authentication_failure_uses_the_fixed_message() {
        assert_eq!(
            auth_failure_message(false, &["password".to_string()]),
            AUTH_FAILED
        );
    }

    #[test]
    fn partial_authentication_names_the_required_methods_as_unsupported() {
        let message = auth_failure_message(true, &["password".to_string()]);
        assert!(message.contains("password"), "{message}");
        assert!(message.contains("not supported in this beta"), "{message}");
    }

    #[test]
    fn an_rsa_only_negotiation_failure_gets_the_rsa_message() {
        let err = russh::Error::NoCommonAlgo {
            kind: AlgorithmKind::Key,
            ours: vec!["ssh-ed25519".to_string()],
            theirs: vec![
                "rsa-sha2-512".to_string(),
                "rsa-sha2-256".to_string(),
                "ssh-rsa".to_string(),
            ],
        };
        assert_eq!(
            host_key_failure_message(&err),
            Some(RSA_HOST_KEY_MESSAGE.to_string())
        );
    }

    #[test]
    fn other_negotiation_failures_are_not_reported_as_rsa() {
        let kex = russh::Error::NoCommonAlgo {
            kind: AlgorithmKind::Kex,
            ours: vec!["curve25519-sha256".to_string()],
            theirs: vec!["rsa-sha2-512".to_string()],
        };
        assert_eq!(host_key_failure_message(&kex), None);
        let mixed = russh::Error::NoCommonAlgo {
            kind: AlgorithmKind::Key,
            ours: vec!["ssh-ed25519".to_string()],
            theirs: vec!["ssh-ed25519".to_string(), "ssh-rsa".to_string()],
        };
        assert_eq!(host_key_failure_message(&mixed), None);
    }

    // --- host key handler ---------------------------------------------------

    struct Harness {
        handler: ClientHandler,
        events: mpsc::Receiver<AttemptEvent>,
        replies: mpsc::Sender<AttemptReply>,
        record: Arc<Mutex<HandshakeRecord>>,
        cancel: CancelToken,
        clock: Arc<HandshakeClock>,
    }

    fn harness(pin: Option<PublicKey>, reply_timeout: Duration) -> Harness {
        let (event_tx, event_rx) = mpsc::channel(4);
        let (reply_tx, reply_rx) = mpsc::channel(4);
        let record = Arc::new(Mutex::new(HandshakeRecord::default()));
        let cancel: CancelToken = Arc::new(CancelFlag::default());
        let clock = Arc::new(HandshakeClock::start(HANDSHAKE_TIMEOUT, STEP_TIMEOUT));
        let handler = ClientHandler {
            endpoint: "sftp://example.com:22".to_string(),
            pin,
            events: event_tx,
            replies: Arc::new(AsyncMutex::new(reply_rx)),
            cancel: Arc::clone(&cancel),
            record: Arc::clone(&record),
            reply_timeout,
            clock: Arc::clone(&clock),
        };
        Harness {
            handler,
            events: event_rx,
            replies: reply_tx,
            record,
            cancel,
            clock,
        }
    }

    // --- keyboard-interactive limits -----------------------------------------

    fn prompt(text: &str) -> russh::client::Prompt {
        russh::client::Prompt {
            prompt: text.to_string(),
            echo: false,
        }
    }

    #[test]
    fn keyboard_interactive_rounds_are_bounded_in_count_and_length() {
        let one = vec![prompt("Password: ")];
        assert!(check_prompt_limits("", "", &one).is_ok());
        let most: Vec<_> = (0..MAX_KEYBOARD_INTERACTIVE_PROMPTS)
            .map(|_| prompt("Code: "))
            .collect();
        assert!(check_prompt_limits("Sign in", "Answer each.", &most).is_ok());

        let too_many: Vec<_> = (0..=MAX_KEYBOARD_INTERACTIVE_PROMPTS)
            .map(|_| prompt("Code: "))
            .collect();
        let refused = check_prompt_limits("", "", &too_many).unwrap_err();
        assert!(refused.contains("at most 16"), "{refused}");

        let long = "x".repeat(MAX_PROMPT_TEXT_BYTES + 1);
        assert!(check_prompt_limits("", "", &[prompt(&long)]).is_err());
        assert!(check_prompt_limits(&long, "", &one).is_err());
        let banner = "b".repeat(MAX_PROMPT_INSTRUCTIONS_BYTES);
        assert!(check_prompt_limits("", &banner, &one).is_ok());
        let too_long_banner = "b".repeat(MAX_PROMPT_INSTRUCTIONS_BYTES + 1);
        assert!(check_prompt_limits("", &too_long_banner, &one).is_err());
    }

    #[test]
    fn a_dropped_reply_wipes_its_answers_in_place() {
        let mut reply = AttemptReply::Responses(vec!["123456".to_string()]);
        if let AttemptReply::Responses(answers) = &mut reply {
            answers.zeroize();
            assert!(answers.is_empty(), "zeroize clears the vector");
        }
        // Dropping runs the same wipe; it must not panic on an emptied reply.
        drop(reply);
        drop(AttemptReply::TrustHostKey(true));
    }

    // --- handshake clock -------------------------------------------------------

    #[test]
    fn the_handshake_clock_counts_only_running_time() {
        let start = Instant::now();
        let mut clock = ClockState {
            left: Duration::from_secs(30),
            running_since: Some(start),
        };
        assert_eq!(
            clock.remaining(start + Duration::from_secs(10)),
            Some(Duration::from_secs(20))
        );
        clock.pause(start + Duration::from_secs(10));
        assert_eq!(clock.remaining(start + Duration::from_secs(500)), None);
        // A second pause changes nothing.
        clock.pause(start + Duration::from_secs(600));
        assert_eq!(clock.left, Duration::from_secs(20));
        clock.resume(start + Duration::from_secs(1000), Duration::from_secs(15));
        assert_eq!(
            clock.remaining(start + Duration::from_secs(1005)),
            Some(Duration::from_secs(15))
        );
        assert_eq!(
            clock.remaining(start + Duration::from_secs(2000)),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn resuming_the_handshake_clock_leaves_at_least_the_floor() {
        let start = Instant::now();
        let mut clock = ClockState {
            left: Duration::from_secs(2),
            running_since: None,
        };
        clock.resume(start, Duration::from_secs(15));
        assert_eq!(clock.remaining(start), Some(Duration::from_secs(15)));
        // Resuming a running clock does not refill it.
        clock.resume(start + Duration::from_secs(10), Duration::from_secs(15));
        assert_eq!(
            clock.remaining(start + Duration::from_secs(10)),
            Some(Duration::from_secs(5))
        );
    }

    #[tokio::test]
    async fn the_handshake_clock_expires_only_after_running_time_is_spent() {
        let clock = Arc::new(HandshakeClock::start(
            Duration::from_millis(100),
            Duration::from_millis(300),
        ));
        clock.pause();
        let waiter = tokio::spawn({
            let clock = Arc::clone(&clock);
            async move { clock.expired().await }
        });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!waiter.is_finished(), "a paused clock never expires");
        clock.resume();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !waiter.is_finished(),
            "the resumed budget is the floor, not the 100 ms left"
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(waiter.is_finished(), "the budget is spent");
    }

    #[tokio::test]
    async fn a_pinned_matching_key_is_accepted_without_a_trust_step() {
        let mut h = harness(Some(parse(ED25519_PUBLIC)), Duration::from_millis(200));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let accepted = h.handler.check_server_key(&key).await.expect("check runs");
        assert!(accepted, "matching pin must be accepted");
        assert!(
            h.events.try_recv().is_err(),
            "no trust step for a pinned key"
        );
        let record = h.record.lock().expect("record");
        assert!(record.presented.is_some(), "presented key is recorded");
    }

    #[tokio::test]
    async fn a_pinned_mismatch_is_refused_with_the_changed_key_message() {
        let mut h = harness(Some(parse(OTHER_PUBLIC)), Duration::from_millis(200));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let accepted = h.handler.check_server_key(&key).await.expect("check runs");
        assert!(!accepted, "mismatched pin must be refused");
        assert!(
            h.events.try_recv().is_err(),
            "a mismatch never asks for trust"
        );
        let refusal = h
            .record
            .lock()
            .expect("record")
            .refusal
            .clone()
            .unwrap_or_default();
        assert!(refusal.contains("changed"), "{refusal}");
        assert!(refusal.contains(HOST_KEY_CHANGED_NOTE), "{refusal}");
    }

    #[tokio::test]
    async fn trust_yes_accepts_and_trust_no_refuses() {
        for (answer, expected) in [(true, true), (false, false)] {
            let mut h = harness(None, Duration::from_secs(5));
            let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
            let replies = h.replies.clone();
            let task = tokio::spawn(async move { h.handler.check_server_key(&key).await });
            let event = h.events.recv().await;
            assert!(
                matches!(event, Some(AttemptEvent::HostKeyUnknown { .. })),
                "an unknown key must be offered for trust"
            );
            replies
                .send(AttemptReply::TrustHostKey(answer))
                .await
                .expect("reply sent");
            assert_eq!(task.await.expect("joins").ok(), Some(expected));
        }
    }

    #[tokio::test]
    async fn the_trust_wait_pauses_the_handshake_clock_and_the_answer_resumes_it() {
        let mut h = harness(None, Duration::from_secs(5));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let replies = h.replies.clone();
        let clock = Arc::clone(&h.clock);
        let task = tokio::spawn(async move { h.handler.check_server_key(&key).await });
        let _ = h.events.recv().await;
        let paused = || {
            clock
                .with_state(|state| state.remaining(Instant::now()).is_none())
                .unwrap_or(false)
        };
        let mut waited = 0;
        while !paused() && waited < 200 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            waited += 1;
        }
        assert!(paused(), "the clock must stop while the user decides");
        replies
            .send(AttemptReply::TrustHostKey(true))
            .await
            .expect("reply sent");
        assert_eq!(task.await.expect("joins").ok(), Some(true));
        assert!(!paused(), "the clock must run again after the decision");
    }

    #[tokio::test]
    async fn a_wrong_kind_reply_refuses_the_host_key() {
        let mut h = harness(None, Duration::from_secs(5));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let replies = h.replies.clone();
        let task = tokio::spawn(async move { h.handler.check_server_key(&key).await });
        let _ = h.events.recv().await;
        replies
            .send(AttemptReply::Responses(vec!["yes".to_string()]))
            .await
            .expect("reply sent");
        assert_eq!(task.await.expect("joins").ok(), Some(false));
    }

    #[tokio::test]
    async fn no_reply_within_the_limit_refuses_the_host_key() {
        let mut h = harness(None, Duration::from_millis(50));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let accepted = h.handler.check_server_key(&key).await.expect("check runs");
        assert!(
            !accepted,
            "an unanswered trust prompt must time out and refuse"
        );
        assert!(
            matches!(h.events.try_recv(), Ok(AttemptEvent::HostKeyUnknown { .. })),
            "the key was still offered before the wait"
        );
    }

    #[tokio::test]
    async fn cancelling_the_host_key_wait_refuses_the_key() {
        let mut h = harness(None, Duration::from_secs(5));
        let key = PublicKeyOrCertificate::from(parse(ED25519_PUBLIC));
        let cancel = Arc::clone(&h.cancel);
        let task = tokio::spawn(async move { h.handler.check_server_key(&key).await });
        cancel.cancel();
        assert_eq!(task.await.expect("joins").ok(), Some(false));
    }
}
