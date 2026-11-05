#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod biometric;
#[cfg(test)]
mod e2e_minio;
mod files;
#[cfg(test)]
mod ipc_acl;
#[cfg(test)]
mod ipc_contract;
mod lock_order;
mod path_authority;
mod platform;
mod s3;
mod security;

use aws_sdk_s3::Client;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::Manager;

use security::{load_security_config, read_protected_file, write_protected_file};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
static STORAGE_OP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static STORAGE_ACTIVITY: OnceLock<StorageActivity> = OnceLock::new();
static S3_MUTATION_LEASES: OnceLock<S3MutationLeases> = OnceLock::new();
static S3_MUTATION_LEASE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static OWNED_DOWNLOAD_TEMPS: OnceLock<Mutex<std::collections::HashMap<PathBuf, PathBuf>>> =
    OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct S3MutationScope {
    connection_id: String,
    bucket: String,
    path: String,
    prefix: bool,
}

impl S3MutationScope {
    pub(crate) fn key(connection_id: &str, bucket: &str, key: &str) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            bucket: bucket.to_string(),
            path: key.to_string(),
            prefix: false,
        }
    }

    pub(crate) fn prefix(connection_id: &str, bucket: &str, prefix: &str) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            bucket: bucket.to_string(),
            path: prefix.to_string(),
            prefix: true,
        }
    }
}

fn s3_mutation_scopes_overlap(left: &S3MutationScope, right: &S3MutationScope) -> bool {
    if left.connection_id != right.connection_id || left.bucket != right.bucket {
        return false;
    }
    match (left.prefix, right.prefix) {
        (false, false) => left.path == right.path,
        (true, false) => right.path.starts_with(&left.path),
        (false, true) => left.path.starts_with(&right.path),
        (true, true) => left.path.starts_with(&right.path) || right.path.starts_with(&left.path),
    }
}

struct S3MutationLeases {
    active: Mutex<Vec<(u64, S3MutationScope)>>,
    changed: tokio::sync::Notify,
}

fn s3_mutation_leases() -> &'static S3MutationLeases {
    S3_MUTATION_LEASES.get_or_init(|| S3MutationLeases {
        active: Mutex::new(Vec::new()),
        changed: tokio::sync::Notify::new(),
    })
}

pub(crate) struct S3MutationGuard {
    id: u64,
    leases: &'static S3MutationLeases,
}

impl Drop for S3MutationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.leases.active.lock() {
            active.retain(|(id, _)| *id != self.id);
        }
        self.leases.changed.notify_waiters();
    }
}

async fn acquire_s3_mutation_inner(
    mut scopes: Vec<S3MutationScope>,
    cancel: Option<&s3::CancelToken>,
) -> Result<S3MutationGuard, String> {
    scopes.sort_by(|left, right| {
        (&left.connection_id, &left.bucket, &left.path, left.prefix).cmp(&(
            &right.connection_id,
            &right.bucket,
            &right.path,
            right.prefix,
        ))
    });
    scopes.dedup();
    if scopes.is_empty() {
        return Err("S3 mutation requires at least one key or prefix scope.".to_string());
    }
    let leases = s3_mutation_leases();
    loop {
        if cancel.is_some_and(|token| token.is_cancelled()) {
            return Err("Transfer cancelled".to_string());
        }
        // Register interest before checking so a release between the check and
        // await cannot be missed.
        let changed = leases.changed.notified();
        {
            let mut active = leases
                .active
                .lock()
                .map_err(|_| "S3 mutation lease state is unavailable".to_string())?;
            let conflicts = scopes.iter().any(|requested| {
                active
                    .iter()
                    .any(|(_, held)| s3_mutation_scopes_overlap(requested, held))
            });
            if !conflicts {
                if cancel.is_some_and(|token| token.is_cancelled()) {
                    return Err("Transfer cancelled".to_string());
                }
                let id = S3_MUTATION_LEASE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                active.extend(scopes.iter().cloned().map(|scope| (id, scope)));
                return Ok(S3MutationGuard { id, leases });
            }
        }
        if let Some(token) = cancel {
            tokio::select! {
                _ = changed => {}
                _ = token.cancelled() => return Err("Transfer cancelled".to_string()),
            }
        } else {
            changed.await;
        }
    }
}

// Commands take leases with their client token so disconnect can cancel the
// wait; the uncancellable form remains for lease-ordering tests.
#[cfg(test)]
pub(crate) async fn acquire_s3_mutation(
    scopes: Vec<S3MutationScope>,
) -> Result<S3MutationGuard, String> {
    acquire_s3_mutation_inner(scopes, None).await
}

pub(crate) async fn acquire_s3_mutation_cancellable(
    scopes: Vec<S3MutationScope>,
    cancel: &s3::CancelToken,
) -> Result<S3MutationGuard, String> {
    acquire_s3_mutation_inner(scopes, Some(cancel)).await
}

struct StorageActivityState {
    active_transfers: usize,
    exclusive: bool,
    exclusive_waiters: usize,
}

struct StorageActivity {
    state: Mutex<StorageActivityState>,
    condvar: Condvar,
}

fn storage_activity() -> &'static StorageActivity {
    STORAGE_ACTIVITY.get_or_init(|| StorageActivity {
        state: Mutex::new(StorageActivityState {
            active_transfers: 0,
            exclusive: false,
            exclusive_waiters: 0,
        }),
        condvar: Condvar::new(),
    })
}

pub(crate) struct StorageTransferGuard {
    activity: &'static StorageActivity,
}

impl Drop for StorageTransferGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.activity.state.lock() {
            state.active_transfers = state.active_transfers.saturating_sub(1);
            self.activity.condvar.notify_all();
        }
    }
}

struct StorageExclusiveGuard {
    activity: &'static StorageActivity,
}

impl Drop for StorageExclusiveGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.activity.state.lock() {
            state.exclusive = false;
            self.activity.condvar.notify_all();
        }
    }
}

fn acquire_storage_transfer() -> Result<StorageTransferGuard, String> {
    let activity = storage_activity();
    let mut state = activity
        .state
        .lock()
        .map_err(|err| format!("Storage activity state unavailable: {}", err))?;
    while state.exclusive || state.exclusive_waiters > 0 {
        state = activity
            .condvar
            .wait(state)
            .map_err(|err| format!("Storage activity state unavailable: {}", err))?;
    }
    state.active_transfers += 1;
    Ok(StorageTransferGuard { activity })
}

fn acquire_storage_exclusive() -> Result<StorageExclusiveGuard, String> {
    let activity = storage_activity();
    let mut state = activity
        .state
        .lock()
        .map_err(|err| format!("Storage activity state unavailable: {}", err))?;
    state.exclusive_waiters += 1;
    while state.exclusive || state.active_transfers > 0 {
        state = activity
            .condvar
            .wait(state)
            .map_err(|err| format!("Storage activity state unavailable: {}", err))?;
    }
    state.exclusive_waiters = state.exclusive_waiters.saturating_sub(1);
    state.exclusive = true;
    Ok(StorageExclusiveGuard { activity })
}

fn try_acquire_storage_exclusive() -> Result<Option<StorageExclusiveGuard>, String> {
    let activity = storage_activity();
    let mut state = activity
        .state
        .lock()
        .map_err(|err| format!("Storage activity state unavailable: {}", err))?;
    if state.exclusive || state.active_transfers > 0 || state.exclusive_waiters > 0 {
        return Ok(None);
    }
    state.exclusive = true;
    Ok(Some(StorageExclusiveGuard { activity }))
}

pub(crate) async fn acquire_transfer_storage() -> Result<StorageTransferGuard, String> {
    tokio::task::spawn_blocking(acquire_storage_transfer)
        .await
        .map_err(|err| format!("Storage transfer gate failed: {}", err))?
}

pub(crate) struct StorageMetaGuard {
    _lock: lock_order::OrderedGuard<'static, ()>,
}

/// Fields drop in order: the storage gate, then the mutex, then the rank.
pub(crate) struct StorageOpsGuard {
    _exclusive: StorageExclusiveGuard,
    _lock: std::sync::MutexGuard<'static, ()>,
    _order: lock_order::LockOrderToken,
}

pub(crate) struct S3State {
    pub client: Option<Client>,
    pub endpoint: String,
    pub region: String,
    pub bucket_hint: Option<String>,
    pub connection_generation: u64,
    pub connection_id: Option<String>,
    pub connection_identity: Option<String>,
    pub storage_provider: StorageProviderKind,
}

/// Detected S3-compatible backend for provider-specific API behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum StorageProviderKind {
    #[default]
    Generic,
    Aws,
    CloudflareR2,
    Minio,
    Wasabi,
    Backblaze,
    DigitalOcean,
}

pub(crate) struct AppState(pub Mutex<S3State>);

pub(crate) fn lock_s3_state<'a>(
    state: &'a tauri::State<'a, AppState>,
) -> Result<lock_order::OrderedGuard<'a, S3State>, String> {
    match lock_order::OrderedGuard::lock(&state.0, lock_order::LockRank::S3State) {
        Ok(guard) => Ok(guard),
        Err(err) => Err(format!("Mutex poisoned: {}", err)),
    }
}

/// Serialize metadata reads/writes without waiting for in-flight transfers.
///
/// Settings, bookmarks, manifests, and checkpoints must not sit behind a
/// multi-hour upload. Rekey and factory reset still take [`lock_storage_ops`],
/// which waits for transfers and then the same mutex.
pub(crate) fn lock_storage_meta() -> Result<StorageMetaGuard, String> {
    let lock = lock_order::OrderedGuard::lock(
        STORAGE_OP_LOCK.get_or_init(|| Mutex::new(())),
        lock_order::LockRank::Storage,
    )
    .map_err(|err| err.to_string())?;
    Ok(StorageMetaGuard { _lock: lock })
}

pub(crate) fn lock_storage_ops() -> Result<StorageOpsGuard, String> {
    // One rank covers the gate and the mutex: both are the storage lock.
    let order = lock_order::LockOrderToken::acquire(lock_order::LockRank::Storage);
    let exclusive = acquire_storage_exclusive()?;
    let lock = STORAGE_OP_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|err| err.to_string())?;
    let guard = StorageOpsGuard {
        _exclusive: exclusive,
        _lock: lock,
        _order: order,
    };
    Ok(guard)
}

/// Take exclusive storage access only when it is immediately available.
/// Security UI actions use this after an OS prompt so a transfer that started
/// meanwhile produces a useful busy error instead of an unbounded wait.
pub(crate) fn try_lock_storage_ops() -> Result<StorageOpsGuard, String> {
    let order = lock_order::LockOrderToken::acquire(lock_order::LockRank::Storage);
    let exclusive = try_acquire_storage_exclusive()?.ok_or_else(|| {
        "Wait for active transfers to finish (or pause them) before changing security settings."
            .to_string()
    })?;
    let lock = STORAGE_OP_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|err| err.to_string())?;
    Ok(StorageOpsGuard {
        _exclusive: exclusive,
        _lock: lock,
        _order: order,
    })
}

/// Create an application-owned directory with owner-only permissions.
///
/// The app data directory holds credentials and transfer state. Unix creation
/// uses 0700 so the files inside are not exposed by the directory's mode even
/// before each file is written with 0600. An existing writable directory is
/// tightened best-effort; deliberately read-only directories are left alone so
/// failure-path tests can still make writes fail.
pub(crate) fn ensure_private_dir(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::fs::PermissionsExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path).map_err(|err| err.to_string())?;
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            let permissions = metadata.permissions();
            if metadata.file_type().is_dir()
                && permissions.mode() & 0o200 != 0
                && permissions.mode() & 0o077 != 0
            {
                let mut tightened = permissions;
                tightened.set_mode(0o700);
                let _ = std::fs::set_permissions(path, tightened);
            }
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path).map_err(|err| err.to_string())
    }
}

/// Resolve the app data directory, honouring the test-only override.
///
/// On Windows, Tauri uses the Known Folder API for `app_data_dir()`, which
/// ignores `APPDATA`. Tests therefore set `S3_SIDEKICK_TEST_APP_DATA` so they
/// never touch the real roaming profile (and so `tauri::test::mock_app`, which
/// can resolve to the roaming root itself, cannot pollute it).
pub(crate) fn resolved_app_data_dir<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    #[cfg(test)]
    if let Some(dir) = std::env::var_os("S3_SIDEKICK_TEST_APP_DATA") {
        let path = std::path::PathBuf::from(dir);
        ensure_private_dir(&path)?;
        return Ok(path);
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn settings_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("settings.json"))
}

fn connection_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("connection.json"))
}

fn bookmarks_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("bookmarks.json"))
}

fn bookmarks_backup_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("bookmarks.json.bak"))
}

fn security_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("security.json"))
}

pub(crate) fn transfer_manifest_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("transfer-manifest.json"))
}

pub(crate) fn transfer_legacy_import_tombstone_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("transfer-legacy-import-v1.closed"))
}

fn transfer_legacy_import_allowed_unchecked<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<bool, String> {
    let path = transfer_legacy_import_tombstone_path(app)?;
    match std::fs::metadata(&path) {
        Ok(_) => Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(err) => Err(format!(
            "Could not inspect legacy transfer-import fence '{}': {}",
            path.display(),
            err
        )),
    }
}

pub(crate) fn close_transfer_legacy_import_unchecked<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    atomic_write(&transfer_legacy_import_tombstone_path(app)?, "closed\n")
}

fn transfer_recovery_session_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("transfer-recovery-session"))
}

const TRANSFER_RECOVERY_SESSION_LEN: usize = 64;
const STALE_TRANSFER_RECOVERY_SESSION: &str =
    "Transfer recovery session is stale or missing; reload the application.";

fn valid_transfer_recovery_session(value: &str) -> bool {
    value.len() == TRANSFER_RECOVERY_SESSION_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn mint_transfer_recovery_session() -> String {
    let mut bytes = [0u8; TRANSFER_RECOVERY_SESSION_LEN / 2];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

pub(crate) fn set_transfer_recovery_session_unchecked<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    recovery_session: &str,
) -> Result<(), String> {
    if !valid_transfer_recovery_session(recovery_session) {
        return Err(STALE_TRANSFER_RECOVERY_SESSION.to_string());
    }
    atomic_write(&transfer_recovery_session_path(app)?, recovery_session)
}

fn read_transfer_recovery_session_unchecked<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<String, String> {
    let path = transfer_recovery_session_path(app)?;
    let value = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(STALE_TRANSFER_RECOVERY_SESSION.to_string())
        }
        Err(err) => {
            return Err(format!(
                "Transfer recovery session could not be read; reload the application: {}",
                err
            ))
        }
    };
    if !valid_transfer_recovery_session(&value) {
        return Err(STALE_TRANSFER_RECOVERY_SESSION.to_string());
    }
    Ok(value)
}

pub(crate) fn load_or_create_transfer_recovery_session_unchecked<
    R: tauri::Runtime,
    M: tauri::Manager<R>,
>(
    app: &M,
) -> Result<String, String> {
    match read_transfer_recovery_session_unchecked(app) {
        Ok(value) => Ok(value),
        Err(err)
            if err == STALE_TRANSFER_RECOVERY_SESSION
                && !transfer_recovery_session_path(app)?.exists() =>
        {
            let value = mint_transfer_recovery_session();
            set_transfer_recovery_session_unchecked(app, &value)?;
            Ok(value)
        }
        Err(err) => Err(err),
    }
}

pub(crate) fn require_transfer_recovery_session_unchecked<
    R: tauri::Runtime,
    M: tauri::Manager<R>,
>(
    app: &M,
    supplied: &str,
) -> Result<(), String> {
    if !valid_transfer_recovery_session(supplied) {
        return Err(STALE_TRANSFER_RECOVERY_SESSION.to_string());
    }
    let current = read_transfer_recovery_session_unchecked(app)?;
    if current != supplied {
        return Err(STALE_TRANSFER_RECOVERY_SESSION.to_string());
    }
    Ok(())
}

pub(crate) fn validate_transfer_recovery_session<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    supplied: &str,
) -> Result<(), String> {
    let _storage_guard = lock_storage_meta()?;
    require_transfer_recovery_session_unchecked(app, supplied)
}

pub(crate) fn security_journal_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    Ok(resolved_app_data_dir(app)?.join("security-migration.journal"))
}

fn transfer_checkpoint_dir<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<PathBuf, String> {
    let checkpoints = resolved_app_data_dir(app)?.join("transfer-checkpoints");
    ensure_private_dir(&checkpoints)?;
    Ok(checkpoints)
}

fn checkpoint_file_name(checkpoint_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(checkpoint_id.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn transfer_checkpoint_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    checkpoint_id: &str,
) -> Result<PathBuf, String> {
    if checkpoint_id.trim().is_empty() {
        return Err("Checkpoint ID is required".to_string());
    }
    let dir = transfer_checkpoint_dir(app)?;
    Ok(dir.join(format!("{}.json", checkpoint_file_name(checkpoint_id))))
}

/// Read a checkpoint without acquiring or validating the recovery-session lock.
///
/// Trusted migration/reset callers use this only while storage is exclusive.
/// Normal transfer callers must use [`load_transfer_checkpoint_json`].
pub(crate) fn load_transfer_checkpoint_json_unchecked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
) -> Result<Option<String>, String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let security = load_security_config(app)?;
    let json = read_checkpoint_json(&path, &security)?;
    if json.trim().is_empty() {
        Err(format!(
            "Transfer checkpoint '{}' exists but is empty; it was retained as corrupt resumable state",
            path.display()
        ))
    } else {
        Ok(Some(json))
    }
}

pub(crate) fn load_transfer_checkpoint_json<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
    recovery_session: &str,
) -> Result<Option<String>, String> {
    let _storage_guard = lock_storage_meta()?;
    require_transfer_recovery_session_unchecked(app, recovery_session)?;
    load_transfer_checkpoint_json_unchecked(app, checkpoint_id)
}

pub(crate) fn save_transfer_checkpoint_json_unchecked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
    json: &str,
) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    let security = load_security_config(app)?;
    write_protected_file(&path, json, &security)
}

pub(crate) fn save_transfer_checkpoint_json<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
    json: &str,
    recovery_session: &str,
) -> Result<(), String> {
    let _storage_guard = lock_storage_meta()?;
    require_transfer_recovery_session_unchecked(app, recovery_session)?;
    save_transfer_checkpoint_json_unchecked(app, checkpoint_id, json)
}

pub(crate) fn remove_transfer_checkpoint_unchecked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => fsync_parent(&path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub(crate) fn remove_transfer_checkpoint<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
    recovery_session: &str,
) -> Result<(), String> {
    let _storage_guard = lock_storage_meta()?;
    require_transfer_recovery_session_unchecked(app, recovery_session)?;
    remove_transfer_checkpoint_unchecked(app, checkpoint_id)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointScratchPath {
    pub destination: String,
    pub temp_path: String,
}

fn checkpoint_scratch_path(json: &str) -> Result<Option<CheckpointScratchPath>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|err| format!("Invalid checkpoint JSON: {}", err))?;
    let Some(temp) = value.get("temp_path").and_then(|value| value.as_str()) else {
        return Ok(None);
    };
    let Some(destination) = value.get("destination").and_then(|value| value.as_str()) else {
        return Err(format!(
            "Checkpoint scratch path has no bound destination and was retained: {}",
            temp
        ));
    };
    let destination_path = parse_user_path(destination, "Checkpoint destination")?;
    let temp_path = parse_user_path(temp, "Checkpoint scratch")?;
    if temp_path != download_temp_path(&destination_path) {
        return Err(format!(
            "Checkpoint scratch path is not derived from its destination and was retained: {}",
            temp_path.display()
        ));
    }
    Ok(Some(CheckpointScratchPath {
        destination: destination_path.to_string_lossy().to_string(),
        temp_path: temp_path.to_string_lossy().to_string(),
    }))
}

/// Read one checkpoint payload.
///
/// Releases before this one wrote checkpoints unprotected, so plaintext is
/// tolerated until the vault adoption sweep has run.
fn read_checkpoint_json(
    path: &std::path::Path,
    security: &security::SecurityConfig,
) -> Result<String, String> {
    security::read_protected_file_with_legacy(path, "", security, security::LegacyPlaintext::Adopt)
}

/// Every checkpoint file currently on disk.
pub(crate) fn transfer_checkpoint_files<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<Vec<PathBuf>, String> {
    let dir = transfer_checkpoint_dir(app)?;
    let iter = match std::fs::read_dir(&dir) {
        Ok(iter) => iter,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut files = Vec::new();
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        files.push(path);
    }
    files.sort();
    Ok(files)
}

/// Read every checkpoint while the current vault key is still usable and retain
/// the scratch paths needed after a key/configuration commit.
pub(crate) fn collect_transfer_checkpoint_scratch_paths<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    security: &security::SecurityConfig,
) -> Result<Vec<CheckpointScratchPath>, String> {
    let mut scratch_paths = Vec::new();
    for path in transfer_checkpoint_files(app)? {
        let json = match read_checkpoint_json(&path, security) {
            Ok(json) => json,
            Err(err) => {
                // Only discard a record that is provably unusable: the key is
                // available and the payload still cannot be read, which means it
                // belongs to a vault whose key is gone. A locked vault fails
                // every read, so discarding then would destroy live resumable
                // state; surface that as the error it is instead.
                if !security::vault_is_readable(security) {
                    return Err(format!(
                        "Cannot prepare checkpoint '{}' for this operation: {}",
                        path.display(),
                        err
                    ));
                }
                // The key is available and the payload still cannot be read, so
                // this record contributes no scratch path. Skip it rather than
                // deleting it: every caller that reaches its commit point purges
                // the checkpoint directory anyway, and deleting here would
                // destroy a live record whenever the cause was a transient I/O
                // error. The trade-off is that its partial download file cannot
                // be named, so that file is left behind.
                continue;
            }
        };
        if let Some(temp_path) = checkpoint_scratch_path(&json)? {
            scratch_paths.push(temp_path);
        }
    }
    scratch_paths.sort_by(|left, right| left.temp_path.cmp(&right.temp_path));
    scratch_paths.dedup_by(|left, right| left.temp_path == right.temp_path);
    Ok(scratch_paths)
}

/// Remove checkpoint scratch data and then the checkpoint records themselves.
/// The caller retains its migration/reset journal until this succeeds, so an
/// interrupted cleanup can safely be retried.
pub(crate) fn purge_transfer_checkpoints<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    scratch_paths: &[CheckpointScratchPath],
) -> Result<(), String> {
    for scratch in scratch_paths {
        let destination = parse_user_path(&scratch.destination, "Checkpoint destination")?;
        let path = parse_user_path(&scratch.temp_path, "Checkpoint scratch")?;
        if path != download_temp_path(&destination) {
            return Err(format!(
                "Refusing to remove checkpoint scratch path not derived from its destination: {}",
                path.display()
            ));
        }
        match std::fs::remove_file(&path) {
            Ok(()) => fsync_parent(&path)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to remove checkpoint scratch file '{}': {}",
                    path.display(),
                    err
                ));
            }
        }
    }

    let dir = transfer_checkpoint_dir(app)?;
    let iter = match std::fs::read_dir(&dir) {
        Ok(iter) => iter,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return purge_download_leases(app);
        }
        Err(e) => return Err(e.to_string()),
    };
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to remove transfer checkpoint '{}': {}",
                    path.display(),
                    err
                ));
            }
        }
    }
    fsync_parent(&dir.join("checkpoint-cleanup"))?;
    purge_download_leases(app)
}

fn parse_user_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{} path is required", label));
    }
    if trimmed.contains('\0') {
        return Err(format!("{} path must not contain NUL bytes", label));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{} path must be absolute: {}", label, trimmed));
    }
    // Keys are untrusted data; `..` must never climb out of the directory the
    // user selected. Native dialogs never return `..`, so rejecting it
    // everywhere costs nothing and closes the whole traversal class.
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!(
            "{} path must not contain '..' components: {}",
            label, trimmed
        ));
    }
    validate_windows_file_name(&path)?;
    Ok(path)
}

/// Reject Windows-unsafe file names at the trust boundary.
///
/// Reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9 with any extension),
/// trailing spaces/dots (silently stripped by Win32), and colons (ADS
/// `file:stream` syntax outside the drive prefix) all name a different file
/// than the user sees. Enforced only on Windows so Linux/macOS keep their
/// native naming rules.
pub(crate) fn validate_windows_file_name(path: &Path) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }
    for component in path.components() {
        let name = match component {
            std::path::Component::Normal(os) => os.to_string_lossy().to_string(),
            _ => continue,
        };
        validate_portable_component(&name, path)?;
    }
    Ok(())
}

/// Windows-portable rules for a renderer-supplied child name.
///
/// A name saved on macOS/Linux must still be openable if the folder is later
/// used from Windows, so download child names enforce these rules on every
/// host. The full user path check above stays Windows-only: `:` and a trailing
/// dot are legitimate on other platforms and the user explicitly picked that
/// path (M10).
pub(crate) fn validate_portable_child_name(name: &str) -> Result<(), String> {
    validate_portable_component(name, Path::new(name))
}

fn validate_portable_component(name: &str, display: &Path) -> Result<(), String> {
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(format!(
            "Path must not end a file or directory name with a space or dot: {}",
            display.display()
        ));
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(format!(
            "Path contains characters Windows does not allow: {}",
            display.display()
        ));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        return Err(format!(
            "Path uses a Windows reserved device name: {}",
            display.display()
        ));
    }
    // Check every path segment, not just the file name: a colon in a parent
    // directory (`dir:stream\file.txt`) is the same ADS syntax. The drive
    // prefix (`C:`) is a Prefix component, not Normal, so it is unaffected.
    if name.contains(':') {
        return Err(format!(
            "Path must not contain ':' (Alternate Data Stream syntax): {}",
            display.display()
        ));
    }
    Ok(())
}

/// Prepend the Win32 extended-length prefix so long absolute paths work with
/// CreateFileW. No-op on other platforms and when already prefixed.
#[cfg(target_os = "windows")]
pub(crate) fn to_extended_windows_path(path: &Path) -> PathBuf {
    if !cfg!(target_os = "windows") {
        return path.to_path_buf();
    }
    let text = path.to_string_lossy();
    if text.starts_with(r"\\?\") {
        return path.to_path_buf();
    }
    if let Some(rest) = text.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{}", rest));
    }
    PathBuf::from(format!(r"\\?\{}", text))
}

/// Strip the Win32 extended-length prefix before returning paths to the UI.
///
/// `std::fs::canonicalize` on Windows returns `\\?\C:\...`, which leaks
/// into dialogs and breaks string prefix comparisons in the frontend.
pub(crate) fn strip_extended_windows_prefix(text: &str) -> String {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text.to_string()
}

/// Fail when distinct paths fold to the same key on case-insensitive volumes.
///
/// S3 keys are case-sensitive but NTFS/APFS default volumes are not: two
/// keys differing only by case would overwrite one target. Over-serialization
/// in `download_path_identity` already folds temp ownership; this helper is
/// for batch mappings (upload `relative_path` sets, multi-key downloads).
pub(crate) fn detect_case_fold_collision(
    pairs: impl IntoIterator<Item = (String, String)>,
    what: &str,
) -> Result<(), String> {
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (fold_key, original) in pairs {
        // APFS also treats NFC/NFD spellings as the same file. Normalizing
        // before case folding catches both collision classes.
        let folded = files::normalize_nfc(&fold_key).to_lowercase();
        if let Some(first) = seen.get(&folded) {
            if first != &original {
                return Err(format!(
                    "Case-insensitive or normalization-equivalent volume collision in {}: '{}' and '{}' map to the same file",
                    what, first, original
                ));
            }
        } else {
            seen.insert(folded, original);
        }
    }
    Ok(())
}

/// Cross-process vault mutation guard.
///
/// `STORAGE_OP_LOCK` is in-process only; a second app instance (or a stale
/// updater copy) could interleave vault writes. Hold an OS-exclusive lock on
/// `security.json.lock` around mutations. Windows DACL hardening is deferred:
/// per-user AppData already ACLs to the owner, and explicit deny-ACEs risk
/// locking users out after domain migration; revisit with a migration-safe
/// SDDL if threat review requires it.
pub(crate) struct VaultFileGuard {
    _file: std::fs::File,
    _order: lock_order::LockOrderToken,
}

pub(crate) fn lock_vault_file(app_data_dir: &Path) -> Result<VaultFileGuard, String> {
    use fs2::FileExt;
    let order = lock_order::LockOrderToken::acquire(lock_order::LockRank::VaultFile);
    let lock_path = app_data_dir.join("security.json.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(VaultFileGuard {
        _file: file,
        _order: order,
    })
}

/// Fail closed when link metadata cannot be read.
fn path_is_link_or_reparse(path: &Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(format!("Cannot inspect path '{}': {}", path.display(), err));
        }
    };
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn validate_existing_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = parse_user_path(raw, label)?;
    if !path.exists() {
        return Err(format!("{} path does not exist: {}", label, path.display()));
    }
    Ok(path)
}

/// Validate a file the app will read and upload.
///
/// Uploads must name the file itself, not a symbolic link that redirects the
/// read outside the path the user selected.
pub(crate) fn validate_upload_source_path(raw: &str) -> Result<PathBuf, String> {
    let path = validate_existing_path(raw, "Upload file")?;
    if path_is_link_or_reparse(&path)? {
        return Err(format!(
            "Upload file is a symbolic link or reparse point: {}",
            path.display()
        ));
    }
    if !path.is_file() {
        return Err(format!("Upload path is not a file: {}", path.display()));
    }
    Ok(path)
}

pub(crate) fn validate_destination_path_parsed(destination: &Path) -> Result<(), String> {
    validate_destination_parent(destination)?;
    if destination.exists() {
        return Err(format!(
            "Destination already exists: {}",
            destination.display()
        ));
    }
    Ok(())
}

fn validate_destination_parent(destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Destination must include a parent directory: {}",
            destination.display()
        )
    })?;
    if !parent.exists() {
        return Err(format!(
            "Destination directory does not exist: {}",
            parent.display()
        ));
    }
    if !parent.is_dir() {
        return Err(format!(
            "Destination parent is not a directory: {}",
            parent.display()
        ));
    }
    if path_is_link_or_reparse(parent)? {
        return Err(format!(
            "Destination parent is a symbolic link or reparse point: {}",
            parent.display()
        ));
    }
    Ok(())
}

pub(crate) fn validate_destination_path_allow_overwrite(raw: &str) -> Result<PathBuf, String> {
    let destination = parse_user_path(raw, "Destination")?;
    validate_destination_path_allow_overwrite_parsed(&destination)?;
    Ok(destination)
}

pub(crate) fn validate_destination_path_allow_overwrite_parsed(
    destination: &Path,
) -> Result<(), String> {
    validate_destination_parent(destination)?;
    if path_is_link_or_reparse(destination)? {
        return Err(format!(
            "Destination is a symbolic link or reparse point: {}",
            destination.display()
        ));
    }
    if destination.exists() && !destination.is_file() {
        return Err(format!(
            "Destination is not a file: {}",
            destination.display()
        ));
    }
    Ok(())
}

/// Existence probe for a granted local path.
///
/// The webview no longer names a path; it spends a token minted by the picker
/// that chose the path. The answer is a boolean only, so an arbitrary path
/// cannot be probed for disclosure.
///
/// A child name is not a general query capability. Only a download-destination
/// directory, resolved through the write capability that owns child joins, may
/// bind one validated component; every other grant answers for its exact path
/// only. This keeps an upload-folder or reveal grant from becoming an
/// existence oracle for sibling names.
#[tauri::command(async)]
fn path_exists(token: String, name: Option<String>) -> Result<bool, String> {
    let child = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let granted = match child {
        Some(child) => {
            path_authority::resolve(&token, path_authority::GrantUse::WriteDownload, Some(child))?
        }
        None => path_authority::authorize(&token, path_authority::GrantUse::QueryPath)?,
    };
    Ok(granted.path.exists())
}

/// Resolve a download destination grant into the exact file path.
fn resolve_download_destination(token: &str, name: Option<&str>) -> Result<PathBuf, String> {
    let granted = path_authority::resolve(token, path_authority::GrantUse::WriteDownload, name)?;
    if granted.is_dir {
        return Err(
            "Download destination must include a file name; choose the file again.".to_string(),
        );
    }
    Ok(granted.path)
}

/// Suffix that marks a file as an in-progress download owned by this app.
pub(crate) const DOWNLOAD_TEMP_SUFFIX: &str = ".s3-sidekick.download.tmp";

/// Derive the temp path for a download from its destination.
///
/// The temp path is computed in the backend rather than accepted from the
/// caller: it is a path the backend will truncate and overwrite, so letting the
/// webview name it would hand any script in the webview an arbitrary-file
/// destruction primitive.
pub(crate) fn download_temp_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(DOWNLOAD_TEMP_SUFFIX);
    PathBuf::from(name)
}

fn download_path_identity(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Download path must include a parent directory: {}",
            path.display()
        )
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Download path must include a file name: {}", path.display()))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|err| {
        format!(
            "Failed to resolve download parent '{}': {}",
            parent.display(),
            err
        )
    })?;
    // Case folding may serialize distinct case-sensitive paths, but it prevents
    // a second owner on case-insensitive volumes. Over-serialization is safer
    // than allowing two writers to target one physical scratch file.
    // Deferred: to_string_lossy collapses non-UTF8 names the same way. Lease
    // comparison additionally pins temp_path/destination strings, so a
    // collision only over-serializes; fix by hashing raw bytes if ever hit.
    Ok(PathBuf::from(
        canonical_parent
            .join(file_name)
            .to_string_lossy()
            .to_lowercase(),
    ))
}

fn owned_download_temps() -> &'static Mutex<std::collections::HashMap<PathBuf, PathBuf>> {
    OWNED_DOWNLOAD_TEMPS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[derive(Debug)]
pub(crate) struct DownloadTempGuard {
    temp_path: PathBuf,
    /// Destination-parent identity pinned by the claim. Publication calls
    /// [`DownloadTempGuard::verify_parent_unchanged`] immediately before the
    /// rename so a parent swapped for a symlink cannot redirect the write.
    parent_identity: DestinationParentIdentity,
    // Dropping this handle releases the OS lock. The lock file itself stays
    // behind (zero bytes) because unlinking it could race a new owner.
    _lock_file: std::fs::File,
}

impl DownloadTempGuard {
    /// Destination-parent identity pinned at claim time, for publication.
    pub(crate) fn parent_identity(&self) -> DestinationParentIdentity {
        self.parent_identity.clone()
    }
}

impl Drop for DownloadTempGuard {
    fn drop(&mut self) {
        if let Ok(mut owned) = owned_download_temps().lock() {
            owned.remove(&self.temp_path);
        }
    }
}

/// Lock file derived from an already-validated scratch path.
///
/// The caller never supplies this path: `claim_download_temp` rejects any
/// `temp_path` that is not `download_temp_path(destination)`, so the lock
/// always sits beside a backend-derived scratch file.
fn download_temp_lock_path(temp_path: &Path) -> PathBuf {
    let mut lock = temp_path.as_os_str().to_os_string();
    lock.push(".lock");
    PathBuf::from(lock)
}

pub(crate) fn claim_download_temp(
    temp_path: &Path,
    destination: &Path,
) -> Result<DownloadTempGuard, String> {
    if temp_path != download_temp_path(destination) {
        return Err(format!(
            "Download scratch path is not derived from its destination: {}",
            temp_path.display()
        ));
    }
    let temp_identity = download_path_identity(temp_path)?;
    let destination_identity = download_path_identity(destination)?;
    let lock_path = download_temp_lock_path(temp_path);
    let mut owned = owned_download_temps()
        .lock()
        .map_err(|_| "Download scratch ownership state is unavailable".to_string())?;
    // Fast path: this process already owns the scratch. Also avoids opening
    // the OS lock twice for one guard.
    if owned.contains_key(&temp_identity) {
        return Err(format!(
            "Download scratch path is already in use: {}",
            temp_path.display()
        ));
    }
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|err| {
            format!(
                "Failed to open download scratch lock '{}': {}",
                lock_path.display(),
                err
            )
        })?;
    match fs2::FileExt::try_lock_exclusive(&lock_file) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(format!(
                "Download scratch already in use: {}",
                temp_path.display()
            ));
        }
        Err(err) => {
            return Err(format!(
                "Failed to lock download scratch '{}': {}",
                lock_path.display(),
                err
            ));
        }
    }
    let parent_identity = destination_parent_identity(destination)?;
    owned.insert(temp_identity.clone(), destination_identity);
    Ok(DownloadTempGuard {
        temp_path: temp_identity,
        parent_identity,
        _lock_file: lock_file,
    })
}

fn is_claimed_download_temp(temp_path: &Path, destination: &Path) -> bool {
    let Ok(temp_identity) = download_path_identity(temp_path) else {
        return false;
    };
    let Ok(destination_identity) = download_path_identity(destination) else {
        return false;
    };
    owned_download_temps()
        .lock()
        .ok()
        .and_then(|owned| owned.get(&temp_identity).cloned())
        .map(|claimed_destination| claimed_destination == destination_identity)
        .unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DownloadScratchLease {
    destination: String,
    temp_path: String,
    nonce: String,
}

fn download_lease_dir<R: tauri::Runtime, M: tauri::Manager<R>>(app: &M) -> Result<PathBuf, String> {
    let dir = resolved_app_data_dir(app)?.join("download-leases");
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn download_lease_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    destination: &Path,
) -> Result<PathBuf, String> {
    let destination_identity = download_path_identity(destination)?;
    Ok(download_lease_dir(app)?.join(format!(
        "{}.json",
        checkpoint_file_name(&destination_identity.to_string_lossy())
    )))
}

fn mint_scratch_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Record durable ownership of a derived download scratch before the file exists.
///
/// The lease lives in plaintext app data, independent of the vault, so a
/// compromised webview cannot authorize deletion of an arbitrary
/// `*.s3-sidekick.download.tmp` path and password changes cannot leave the
/// file unreadable. After a crash the runtime claim is gone; recovery still
/// uses this lease. Vault migration, factory reset, and GC delete the lease
/// directory so leftover scratch files do not linger.
pub(crate) fn issue_download_scratch_lease<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    destination: &Path,
    temp_path: &Path,
) -> Result<String, String> {
    if temp_path != download_temp_path(destination) {
        return Err(format!(
            "Download scratch path is not derived from its destination: {}",
            temp_path.display()
        ));
    }
    let nonce = mint_scratch_nonce();
    let lease = DownloadScratchLease {
        destination: destination.to_string_lossy().into_owned(),
        temp_path: temp_path.to_string_lossy().into_owned(),
        nonce: nonce.clone(),
    };
    let json = serde_json::to_string(&lease).map_err(|err| err.to_string())?;
    let path = download_lease_path(app, destination)?;
    atomic_write(&path, &json)?;
    Ok(nonce)
}

pub(crate) fn release_download_scratch_lease<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    destination: &Path,
    nonce: &str,
) {
    let Ok(path) = download_lease_path(app, destination) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(lease) = serde_json::from_str::<DownloadScratchLease>(&raw) else {
        return;
    };
    let expected_temp_path = download_temp_path(destination);
    if lease.nonce != nonce
        || lease.destination.as_str() != destination.to_string_lossy().as_ref()
        || lease.temp_path.as_str() != expected_temp_path.to_string_lossy().as_ref()
    {
        return;
    }
    let _ = std::fs::remove_file(path);
}

fn read_download_lease_json<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<String, String> {
    let raw = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    if serde_json::from_str::<DownloadScratchLease>(&raw).is_ok() {
        return Ok(raw);
    }
    let security = load_security_config(app)?;
    read_protected_file(path, "", &security)
}

/// Remove every download lease and any derived scratch file it names.
///
/// Leases are stored as plaintext app-data, independent of the vault, so
/// password changes cannot leave them unreadable. Reset and vault commit still
/// have to delete them so leftover full-size scratch files do not linger.
pub(crate) fn purge_download_leases<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    let app_handle = app.app_handle();
    let dir = resolved_app_data_dir(app)?.join("download-leases");
    let iter = match std::fs::read_dir(&dir) {
        Ok(iter) => iter,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let json = std::fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read download lease '{}': {}",
                path.display(),
                err
            )
        })?;
        let lease = match serde_json::from_str::<DownloadScratchLease>(&json) {
            Ok(lease) => lease,
            Err(_) => {
                let legacy_json = read_download_lease_json(app_handle, &path)?;
                serde_json::from_str(&legacy_json).map_err(|err| {
                    format!(
                        "Failed to parse download lease '{}': {}",
                        path.display(),
                        err
                    )
                })?
            }
        };
        if let (Ok(destination), Ok(temp_path)) = (
            parse_user_path(&lease.destination, "Lease destination"),
            parse_user_path(&lease.temp_path, "Lease scratch"),
        ) {
            if temp_path == download_temp_path(&destination) && temp_path.exists() {
                clear_unusable_download_scratch(&temp_path)?;
            }
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to remove download lease '{}': {}",
                    path.display(),
                    err
                ));
            }
        }
    }
    fsync_parent(&dir.join("lease-cleanup"))
}

pub(crate) fn clear_unusable_download_scratch(temp_path: &Path) -> Result<(), String> {
    if !temp_path.exists() {
        return Ok(());
    }
    if !temp_path.is_file() {
        return Err(format!(
            "Refusing to remove a non-file path: {}",
            temp_path.display()
        ));
    }
    if path_is_link_or_reparse(temp_path)? {
        return Err(format!(
            "Refusing to remove a symbolic link or reparse point: {}",
            temp_path.display()
        ));
    }
    std::fs::remove_file(temp_path).map_err(|err| err.to_string())?;
    fsync_parent(temp_path)
}

fn discard_download_scratch_for_destination<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    destination: &Path,
) -> Result<(), String> {
    let temp_path = download_temp_path(destination);
    let lease_path = match download_lease_path(app, destination) {
        Ok(path) => path,
        // The destination folder is gone (unplugged drive, deleted folder), so
        // no scratch file can exist beside it. Any orphaned lease is reclaimed
        // by the recovery sweep; failing here would block transfer recovery.
        Err(_) if !temp_path.exists() => return Ok(()),
        Err(err) => return Err(err),
    };
    if !temp_path.exists() && !lease_path.exists() {
        return Ok(());
    }
    // A running download owns this scratch and its lease. Removing them would
    // fail that download (and its resume state); its own completion or
    // cancellation path cleans up instead.
    if is_claimed_download_temp(&temp_path, destination) {
        return Ok(());
    }
    let lease_authorizes = if lease_path.exists() {
        match read_download_lease_json(app, &lease_path) {
            Ok(json) => match serde_json::from_str::<DownloadScratchLease>(&json) {
                Ok(lease) => {
                    Path::new(&lease.temp_path) == temp_path
                        && Path::new(&lease.destination) == destination
                }
                Err(_) => false,
            },
            Err(_) => false,
        }
    } else {
        false
    };
    if !lease_authorizes {
        return Err(format!(
            "Refusing to remove an unregistered download scratch path: {}",
            temp_path.display()
        ));
    }
    clear_unusable_download_scratch(&temp_path)?;
    if lease_path.exists() {
        std::fs::remove_file(&lease_path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn discard_download_scratch_blocking(
    app: tauri::AppHandle,
    destination_token: String,
    destination_name: Option<String>,
) -> Result<(), String> {
    // Resolve before taking the storage lock: a bad token is not a storage
    // operation and must fail closed without touching any file.
    let destination =
        resolve_download_destination(&destination_token, destination_name.as_deref())?;
    let _storage_guard = lock_storage_meta()?;
    discard_download_scratch_for_destination(&app, &destination)
}

// Runs on the blocking pool: plain sync commands run on the main thread,
// where waiting for the storage lock (held through PBKDF2 during a password
// change) or disk I/O would freeze the window.
#[tauri::command]
async fn discard_download_scratch(
    app: tauri::AppHandle,
    destination_token: String,
    destination_name: Option<String>,
) -> Result<(), String> {
    security::run_blocking(move || {
        discard_download_scratch_blocking(app, destination_token, destination_name)
    })
    .await
}

/// Extensions a backend-issued text export grant is permitted to produce.
///
/// The command exists to export the activity log and saved connections.
/// Restricting the extension keeps it from being used to drop a shell profile,
/// a launch agent, or a script onto disk if the webview is ever compromised.
const WRITABLE_TEXT_EXTENSIONS: &[&str] = &["txt", "log", "json", "csv", "md"];

/// File names the vault, settings, saved connection and recovery state use.
/// Even a granted export may not overwrite them.
const RESERVED_APP_FILE_NAMES: &[&str] = &[
    "settings.json",
    "settings.json.bak",
    "bookmarks.json",
    "bookmarks-backup.json",
    "connection.json",
    "security.json",
    "security.json.lock",
    "security-migration.journal",
    "transfer-manifest.json",
];

/// The path a native dialog handed back, plus the grant that authorizes later
/// commands to spend it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedPath {
    token: String,
    path: String,
    name: String,
    is_dir: bool,
    /// Size recorded when the grant was minted, when known. Recovery uses it
    /// to reject a re-selected upload that only shares a name.
    size: Option<u64>,
    /// Reveal grant for the containing directory, so "Open download folder"
    /// keeps working after a single-file save.
    directory_token: Option<String>,
    directory_path: Option<String>,
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| files::root_label(path))
}

fn pick_view(
    purpose: path_authority::GrantPurpose,
    path: &Path,
    is_dir: bool,
    expected_len: Option<u64>,
    with_directory: bool,
) -> Result<PickedPath, String> {
    // The dialog should only ever return absolute paths, but never trust the
    // platform bridge blindly.
    let path = parse_user_path(&path.to_string_lossy(), "Selected path")?;
    let (directory_token, directory_path) = if with_directory && !is_dir {
        match path.parent() {
            Some(parent) if parent.is_dir() => {
                let parent_text = files::absolute_path_string_no_follow(parent);
                let token = path_authority::mint(
                    path_authority::GrantPurpose::Reveal,
                    Path::new(&parent_text),
                    true,
                    None,
                );
                (Some(token), Some(parent_text))
            }
            _ => (None, None),
        }
    } else {
        (None, None)
    };
    let token = path_authority::mint(purpose, &path, is_dir, expected_len);
    Ok(PickedPath {
        token,
        path: files::absolute_path_string_no_follow(&path),
        name: display_name(&path),
        is_dir,
        size: expected_len,
        directory_token,
        directory_path,
    })
}

fn suggested_file_name(name: Option<String>) -> Option<String> {
    name.map(|value| value.trim().to_string())
        .filter(|value| path_authority::is_valid_child_name(value))
}

fn picker_paths(files: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<PathBuf> {
    files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect()
}

/// Turn a renderer hint into a dialog starting directory.
///
/// The hint is presentation only: it never mints a grant, and an invalid or
/// non-directory hint simply leaves the dialog at its platform default.
fn picker_default_directory(default_path: Option<String>) -> Option<PathBuf> {
    let parsed = parse_user_path(default_path.as_deref()?, "Picker default").ok()?;
    let directory = if parsed.is_dir() {
        parsed
    } else {
        parsed.parent()?.to_path_buf()
    };
    directory.is_dir().then_some(directory)
}

/// Native picker for one or more upload files. The only minting path for
/// `upload-file` grants; the renderer supplies no paths.
#[tauri::command]
async fn pick_upload_files(
    app: tauri::AppHandle,
    default_path: Option<String>,
) -> Result<Vec<PickedPath>, String> {
    use tauri_plugin_dialog::DialogExt;
    let default_directory = picker_default_directory(default_path);
    let paths = security::run_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Select files to upload");
        if let Some(directory) = default_directory {
            dialog = dialog.set_directory(directory);
        }
        Ok(picker_paths(dialog.blocking_pick_files()))
    })
    .await?;
    let mut picked = Vec::new();
    for path in paths {
        let validated = validate_upload_source_path(&path.to_string_lossy())?;
        let len = validated
            .metadata()
            .map_err(|err| format!("Cannot read file metadata: {}", err))?
            .len();
        picked.push(pick_view(
            path_authority::GrantPurpose::UploadFile,
            &validated,
            false,
            Some(len),
            false,
        )?);
    }
    Ok(picked)
}

/// Native picker for one or more upload folders. Each folder becomes an
/// `upload-root` grant; the recursive scan may never leave these roots.
#[tauri::command]
async fn pick_upload_folder(
    app: tauri::AppHandle,
    default_path: Option<String>,
) -> Result<Vec<PickedPath>, String> {
    use tauri_plugin_dialog::DialogExt;
    let default_directory = picker_default_directory(default_path);
    let paths = security::run_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Select folder(s) to upload");
        if let Some(directory) = default_directory {
            dialog = dialog.set_directory(directory);
        }
        Ok(picker_paths(dialog.blocking_pick_folders()))
    })
    .await?;
    let mut picked = Vec::new();
    for path in paths {
        let validated = parse_user_path(&path.to_string_lossy(), "Selected folder")?;
        if !validated.is_dir() {
            return Err(format!(
                "Selected path is not a folder: {}",
                validated.display()
            ));
        }
        let granted = path_authority::GrantedPath {
            path: validated.clone(),
            is_dir: true,
            expected_len: None,
            canonical_identity: std::fs::canonicalize(&validated).ok(),
            identity_path: validated.clone(),
        };
        granted.reject_symlink()?;
        picked.push(pick_view(
            path_authority::GrantPurpose::UploadRoot,
            &validated,
            true,
            None,
            false,
        )?);
    }
    Ok(picked)
}

/// Native save dialog for a single download destination.
#[tauri::command]
async fn pick_download_file(
    app: tauri::AppHandle,
    file_name: Option<String>,
    title: Option<String>,
    default_directory: Option<String>,
) -> Result<Option<PickedPath>, String> {
    use tauri_plugin_dialog::DialogExt;
    let suggested = suggested_file_name(file_name);
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Save download".to_string());
    let default_directory = picker_default_directory(default_directory);
    let path = security::run_blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        if let Some(directory) = default_directory {
            dialog = dialog.set_directory(directory);
        }
        if let Some(name) = suggested {
            dialog = dialog.set_file_name(name);
        }
        Ok(dialog
            .blocking_save_file()
            .and_then(|file| file.into_path().ok()))
    })
    .await?;
    match path {
        Some(path) => {
            let validated = validate_destination_path_allow_overwrite(&path.to_string_lossy())?;
            Ok(Some(pick_view(
                path_authority::GrantPurpose::DownloadDestination,
                &validated,
                false,
                None,
                true,
            )?))
        }
        None => Ok(None),
    }
}

/// Native folder picker for a multi-object download destination (or for
/// re-opening the remembered download folder).
#[tauri::command]
async fn pick_download_directory(
    app: tauri::AppHandle,
    title: Option<String>,
    default_directory: Option<String>,
) -> Result<Option<PickedPath>, String> {
    use tauri_plugin_dialog::DialogExt;
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Select destination folder".to_string());
    let default_directory = picker_default_directory(default_directory);
    let path = security::run_blocking(move || {
        let mut dialog = app.dialog().file().set_title(title);
        if let Some(directory) = default_directory {
            dialog = dialog.set_directory(directory);
        }
        Ok(dialog
            .blocking_pick_folder()
            .and_then(|file| file.into_path().ok()))
    })
    .await?;
    match path {
        Some(path) => {
            let validated = parse_user_path(&path.to_string_lossy(), "Selected folder")?;
            if !validated.is_dir() {
                return Err(format!(
                    "Selected path is not a folder: {}",
                    validated.display()
                ));
            }
            path_authority::GrantedPath {
                path: validated.clone(),
                is_dir: true,
                expected_len: None,
                canonical_identity: std::fs::canonicalize(&validated).ok(),
                identity_path: validated.clone(),
            }
            .reject_symlink()?;
            Ok(Some(pick_view(
                path_authority::GrantPurpose::DownloadDestination,
                &validated,
                true,
                None,
                false,
            )?))
        }
        None => Ok(None),
    }
}

/// Native save dialog for a text export. The grant it returns is the only way
/// `export_text_file` can name a destination.
#[tauri::command]
async fn pick_text_export(
    app: tauri::AppHandle,
    file_name: Option<String>,
    title: Option<String>,
    default_directory: Option<String>,
) -> Result<Option<PickedPath>, String> {
    use tauri_plugin_dialog::DialogExt;
    let suggested = suggested_file_name(file_name);
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Export text".to_string());
    let default_directory = picker_default_directory(default_directory);
    let dialog_app = app.clone();
    let path = security::run_blocking(move || {
        let mut dialog = dialog_app
            .dialog()
            .file()
            .set_title(title)
            .add_filter("Text", WRITABLE_TEXT_EXTENSIONS);
        if let Some(directory) = default_directory {
            dialog = dialog.set_directory(directory);
        }
        Ok(dialog
            .set_file_name(suggested.unwrap_or_else(|| "export.txt".to_string()))
            .blocking_save_file()
            .and_then(|file| file.into_path().ok()))
    })
    .await?;
    match path {
        Some(path) => {
            // Validate the extension and final path while the picker context
            // is still fresh; never mint a grant the export command will
            // reject after the user has already dismissed the dialog.
            let app_data = resolved_app_data_dir(&app).ok();
            validate_export_target(&path, app_data.as_deref())?;
            Ok(Some(pick_view(
                path_authority::GrantPurpose::ExportText,
                &path,
                false,
                None,
                false,
            )?))
        }
        None => Ok(None),
    }
}

/// Hand the webview the grants for the most recent native drag-drop.
///
/// The paths come from `WindowEvent::DragDrop` in this process, not from the
/// renderer, so a compromised webview cannot use this command to authorize an
/// arbitrary path.
#[tauri::command]
async fn take_dropped_upload_grants() -> Result<Vec<path_authority::DroppedPathGrant>, String> {
    Ok(path_authority::take_native_drop_grants())
}

/// Guard a backend write that a granted path authorized.
///
/// A dialog grant is user consent for one item, not for the vault, settings,
/// or the recovery manifest inside the app's private data directory.
pub(crate) fn validate_user_write_target<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    path: &Path,
) -> Result<(), String> {
    if let Ok(app_data) = resolved_app_data_dir(app) {
        if path_is_within_app_data(path, &app_data) {
            return Err(
                "Refusing to write into the application's private data directory.".to_string(),
            );
        }
    }
    Ok(())
}

/// Compare a write target with the app data directory after resolving both.
///
/// The final component may not exist yet, so resolve its parent and append the
/// file name. macOS and Windows compare case-insensitively, matching the
/// default volume behavior there.
fn path_is_within_app_data(path: &Path, app_data: &Path) -> bool {
    fn resolved(path: &Path) -> Option<PathBuf> {
        if let Ok(canonical) = std::fs::canonicalize(path) {
            return Some(canonical);
        }
        let parent = path.parent()?;
        let name = path.file_name()?;
        Some(std::fs::canonicalize(parent).ok()?.join(name))
    }

    let (Some(path), Some(app_data)) = (resolved(path), resolved(app_data)) else {
        // If either side cannot be resolved, keep the old lexical guard rather
        // than silently treating the target as outside app data.
        return path.starts_with(app_data);
    };
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        let path = path.to_string_lossy().to_lowercase();
        let app_data = app_data.to_string_lossy().to_lowercase();
        path == app_data
            || path
                .strip_prefix(&app_data)
                .is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
    } else {
        path.starts_with(app_data)
    }
}

fn validate_export_target(path: &Path, app_data: Option<&Path>) -> Result<(), String> {
    let parsed = parse_user_path(&path.to_string_lossy(), "Export destination")?;
    if let Some(parent) = parsed.parent() {
        if !parent.exists() || !parent.is_dir() {
            return Err(format!(
                "Export folder does not exist: {}",
                parent.display()
            ));
        }
        let parent_metadata = parent.symlink_metadata().map_err(|err| {
            format!(
                "Cannot inspect export folder '{}': {}",
                parent.display(),
                err
            )
        })?;
        if parent_metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to write inside a symbolic link: {}",
                parent.display()
            ));
        }
    }
    match parsed.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to write through a symbolic link: {}",
                parsed.display()
            ));
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "Cannot inspect export destination '{}': {}",
                parsed.display(),
                err
            ));
        }
    }
    if parsed.exists() && !parsed.is_file() {
        return Err(format!(
            "Export destination is not a file: {}",
            parsed.display()
        ));
    }
    let extension = parsed
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if !WRITABLE_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Text export must use one of these extensions: {}",
            WRITABLE_TEXT_EXTENSIONS.join(", ")
        ));
    }
    // Reserved state names only matter inside app data. A user exporting
    // `~/Documents/settings.json` is not touching the vault and must not be
    // blocked just because the file name matches.
    if let Some(app_data) = app_data {
        if path_is_within_app_data(&parsed, app_data) {
            let file_name = parsed
                .file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if RESERVED_APP_FILE_NAMES.contains(&file_name.as_str()) {
                return Err(format!(
                    "Refusing to export over application state: {}",
                    parsed.display()
                ));
            }
            return Err(
                "Refusing to export into the application's private data directory.".to_string(),
            );
        }
    }
    validate_windows_file_name(&parsed)?;
    Ok(())
}

fn write_export_text(path: &Path, text: &str, app_data: Option<&Path>) -> Result<(), String> {
    validate_export_target(path, app_data)?;
    atomic_write_with_overwrite(path, text, true)
}

/// Write exported text to a granted destination.
///
/// The save dialog already asked about replacing an existing file, so a grant
/// carries that consent; the renderer cannot nominate a path or bypass the
/// extension/reserved-name guards.
#[tauri::command(async)]
fn export_text_file(app: tauri::AppHandle, token: String, text: String) -> Result<(), String> {
    let granted = path_authority::authorize(&token, path_authority::GrantUse::ExportText)?;
    if granted.is_dir {
        return Err("Export destination must be a file, not a folder.".to_string());
    }
    let app_data = resolved_app_data_dir(&app).ok();
    write_export_text(&granted.path, &text, app_data.as_deref())
}

#[cfg(test)]
fn remove_owned_download_temp(
    path: &str,
    destination: &str,
    checkpoint_authorized: bool,
) -> Result<(), String> {
    let parsed = parse_user_path(path, "Path")?;
    let destination = parse_user_path(destination, "Destination")?;
    if parsed != download_temp_path(&destination)
        || (!checkpoint_authorized && !is_claimed_download_temp(&parsed, &destination))
    {
        return Err(format!(
            "Refusing to remove an unregistered download scratch path: {}",
            parsed.display()
        ));
    }
    if !parsed.exists() {
        return Ok(());
    }
    if !parsed.is_file() {
        return Err(format!(
            "Refusing to remove a non-file path: {}",
            parsed.display()
        ));
    }
    if path_is_link_or_reparse(&parsed)? {
        return Err(format!(
            "Refusing to remove a symbolic link or reparse point: {}",
            parsed.display()
        ));
    }
    std::fs::remove_file(&parsed).map_err(|e| e.to_string())
}

fn transfer_checkpoint_remove_blocking(
    app: tauri::AppHandle,
    checkpoint_id: String,
    recovery_session: String,
) -> Result<(), String> {
    {
        let _storage_guard = lock_storage_meta()?;
        require_transfer_recovery_session_unchecked(&app, &recovery_session)?;
        // Checkpoint IDs derive from bucket/key/destination, so a stale queue
        // row can name the checkpoint of a download running right now. That
        // download owns it; removing it would discard live resume state.
        if let Ok(Some(json)) = load_transfer_checkpoint_json_unchecked(&app, &checkpoint_id) {
            if let Ok(Some(scratch)) = checkpoint_scratch_path(&json) {
                if is_claimed_download_temp(
                    Path::new(&scratch.temp_path),
                    Path::new(&scratch.destination),
                ) {
                    return Ok(());
                }
            }
        }
    }
    remove_transfer_checkpoint(&app, &checkpoint_id, &recovery_session)
}

// Runs on the blocking pool: plain sync commands run on the main thread,
// where waiting for the storage lock (held through PBKDF2 during a password
// change) or disk I/O would freeze the window.
#[tauri::command]
async fn transfer_checkpoint_remove(
    app: tauri::AppHandle,
    checkpoint_id: String,
    recovery_session: String,
) -> Result<(), String> {
    security::run_blocking(move || {
        transfer_checkpoint_remove_blocking(app, checkpoint_id, recovery_session)
    })
    .await
}

/// Reclaim expired checkpoints and the scratch files they reference.
///
/// `keep_checkpoint_ids` holds the checkpoint ids the caller's transfer manifest
/// still references. Anything in that set survives regardless of age, so the GC
/// can no longer strand a queued transfer's resume state. Expiring a checkpoint
/// also deletes the temp file recorded inside it, because once the checkpoint is
/// gone nothing else can map back to that path — the scratch file is sized to the
/// full object, so it would otherwise leak permanently.
fn transfer_checkpoint_gc_blocking(
    app: tauri::AppHandle,
    ttl_hours: u32,
    keep_checkpoint_ids: Option<Vec<String>>,
    recovery_session: String,
) -> Result<u32, String> {
    let _storage_guard = lock_storage_meta()?;
    require_transfer_recovery_session_unchecked(&app, &recovery_session)?;
    let dir = transfer_checkpoint_dir(&app)?;
    let ttl_secs = (ttl_hours.max(1) as u64) * 3600;
    let now = std::time::SystemTime::now();
    // Hash here rather than asking the caller to: the on-disk name is an
    // implementation detail of this module.
    let keep: std::collections::HashSet<String> = keep_checkpoint_ids
        .unwrap_or_default()
        .iter()
        .filter(|id| !id.trim().is_empty())
        .map(|id| checkpoint_file_name(id))
        .collect();
    let security = load_security_config(&app)?;
    let mut removed = 0u32;
    // Destinations bound to surviving checkpoints: their scratch leases must
    // survive too, so crash-resumable downloads stay recoverable.
    let mut kept_destinations: std::collections::HashSet<String> = std::collections::HashSet::new();

    let iter = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
        if ext != "json" {
            continue;
        }
        let id_hash = path
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_string();
        if keep.contains(&id_hash) {
            if let Ok(json) = read_checkpoint_json(&path, &security) {
                if let Ok(Some(scratch)) = checkpoint_scratch_path(&json) {
                    kept_destinations.insert(scratch.destination);
                }
            }
            continue;
        }
        let modified = match entry.metadata().ok().and_then(|m| m.modified().ok()) {
            Some(value) => value,
            None => continue,
        };
        let age = now.duration_since(modified).unwrap_or_default().as_secs();
        if age < ttl_secs {
            continue;
        }

        // Reclaim the scratch file before dropping the only reference to it.
        // An unreadable record is retained, because deleting it would orphan a
        // full-size temp file. Skip it and keep going so one bad record cannot
        // stop every other reclamation.
        let json = match read_checkpoint_json(&path, &security) {
            Ok(json) => json,
            Err(_) => continue,
        };
        match checkpoint_scratch_path(&json) {
            Ok(Some(scratch)) => {
                let temp_path = PathBuf::from(scratch.temp_path);
                // The webview can reload while the backend keeps downloading;
                // a live download's scratch is not garbage however old its
                // checkpoint looks.
                if is_claimed_download_temp(&temp_path, Path::new(&scratch.destination)) {
                    kept_destinations.insert(scratch.destination);
                    continue;
                }
                match std::fs::remove_file(&temp_path) {
                    Ok(()) => {
                        let _ = fsync_parent(&temp_path);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    // A locked or unremovable scratch file keeps its record for
                    // the next sweep. One stuck file must not fail recovery
                    // and block every transfer.
                    Err(_) => continue,
                }
            }
            Ok(None) => {}
            Err(_) => continue,
        }

        match std::fs::remove_file(&path) {
            Ok(()) => {
                let _ = fsync_parent(&path);
                removed += 1;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
    }

    sweep_unreferenced_download_leases(&app, &kept_destinations)?;

    Ok(removed)
}

/// Hard ceiling for a checkpoint-less download lease, independent of the
/// caller-configured checkpoint retention. A lease with no surviving
/// checkpoint is orphaned scratch; the user-facing TTL can be raised to 30
/// days, so the startup sweep uses the larger of the two. The checkpoint GC
/// path passes the user TTL; the startup path uses this constant.
pub(crate) const DOWNLOAD_LEASE_STARTUP_MAX_AGE_SECS: u64 = 30 * 24 * 3600;

fn download_lease_age_exceeds(
    modified: std::time::SystemTime,
    now: std::time::SystemTime,
    max_age: std::time::Duration,
) -> bool {
    now.duration_since(modified).is_ok_and(|age| age > max_age)
}

/// Startup reaping of lease-tracked download scratch.
///
/// Runs once at launch (not on every webview navigation): the same
/// [`sweep_unreferenced_download_leases`] the checkpoint GC uses, with the
/// keep-set built from every checkpoint still on disk. A lease whose scratch
/// another live process holds survives the sweep via the OS lock check.
/// Leases older than [`DOWNLOAD_LEASE_STARTUP_MAX_AGE_SECS`] are reaped even
/// when a checkpoint of unknown age happens to reference them — no resumable
/// download is kept that long. Locked vaults keep every lease: checkpoint
/// payloads cannot be read without the key, so the reference set is unknown
/// and deleting on a guess could orphan a resumable download.
pub(crate) fn sweep_orphaned_download_leases_at_startup<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) {
    let app_handle = app.app_handle();
    let Ok(security) = load_security_config(app_handle) else {
        return;
    };
    if security.encryption_enabled && crate::security::require_unlocked_key().is_err() {
        return;
    }
    let mut kept_destinations: std::collections::HashSet<String> = std::collections::HashSet::new();
    let now = std::time::SystemTime::now();
    let max_age = std::time::Duration::from_secs(DOWNLOAD_LEASE_STARTUP_MAX_AGE_SECS);
    // Collect surviving checkpoints first; the sweep below needs only their
    // destinations, and a fresh checkpoint protects its lease regardless of
    // the lease file's own age.
    if let Ok(paths) = transfer_checkpoint_files(app_handle) {
        for path in paths {
            let modified = path
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());
            let expired =
                modified.is_some_and(|time| download_lease_age_exceeds(time, now, max_age));
            if expired {
                continue;
            }
            if let Ok(json) = read_checkpoint_json(&path, &security) {
                if let Ok(Some(scratch)) = checkpoint_scratch_path(&json) {
                    kept_destinations.insert(scratch.destination);
                }
            }
        }
    }
    let _ = sweep_unreferenced_download_leases(app, &kept_destinations);
}

// Runs on the blocking pool: plain sync commands run on the main thread,
// where waiting for the storage lock (held through PBKDF2 during a password
// change) or disk I/O would freeze the window.
#[tauri::command]
async fn transfer_checkpoint_gc(
    app: tauri::AppHandle,
    ttl_hours: u32,
    keep_checkpoint_ids: Option<Vec<String>>,
    recovery_session: String,
) -> Result<u32, String> {
    security::run_blocking(move || {
        transfer_checkpoint_gc_blocking(app, ttl_hours, keep_checkpoint_ids, recovery_session)
    })
    .await
}

/// Validate a lease into the only scratch path it may delete.
///
/// A lease is not authority to name a file: the scratch must be derived from
/// its own destination, and that destination must still pass the same checks
/// a live download would apply.
fn lease_scratch_target(lease: &DownloadScratchLease) -> Option<(PathBuf, PathBuf)> {
    let destination = parse_user_path(&lease.destination, "Lease destination").ok()?;
    let temp_path = parse_user_path(&lease.temp_path, "Lease scratch").ok()?;
    if temp_path != download_temp_path(&destination) {
        return None;
    }
    if validate_destination_path_allow_overwrite_parsed(&destination).is_err() {
        return None;
    }
    Some((destination, temp_path))
}

/// Remove download leases (and their derived scratch) that no surviving
/// checkpoint references.
///
/// A crash between scratch preallocation and the first checkpoint write leaves
/// a full-size scratch file with no record outside its lease; nothing else
/// walks that directory, so reclaim it at recovery time.
fn sweep_unreferenced_download_leases<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    keep_destinations: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let app_handle = app.app_handle();
    let dir = resolved_app_data_dir(app)?.join("download-leases");
    let iter = match std::fs::read_dir(&dir) {
        Ok(iter) => iter,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let json = match read_download_lease_json(app_handle, &path) {
            Ok(json) => json,
            Err(_) => continue,
        };
        let lease = match serde_json::from_str::<DownloadScratchLease>(&json) {
            Ok(lease) => lease,
            Err(_) => continue,
        };
        if keep_destinations.contains(&lease.destination) {
            continue;
        }
        // A lease is only authority to delete the scratch path derived from
        // its own validated destination. Anything else is retained, not
        // treated as an arbitrary deletion request.
        let Some((destination, temp_path)) = lease_scratch_target(&lease) else {
            continue;
        };
        // Acquire the same OS lock a live download holds. If another owner
        // has it (possibly from another process), the lease is live and must
        // survive this sweep.
        let Ok(_scratch_guard) = claim_download_temp(&temp_path, &destination) else {
            continue;
        };
        // Per-entry failures keep the lease for the next sweep instead of
        // failing recovery.
        if temp_path.exists() && clear_unusable_download_scratch(&temp_path).is_err() {
            continue;
        }
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

#[tauri::command(async)]
fn get_available_disk_bytes(token: String) -> Result<u64, String> {
    // Free space is only reported for a path the user already granted; the
    // command cannot be used to probe arbitrary volumes. The grant is spent
    // exactly as issued: there is no child-name argument here.
    let parsed = path_authority::authorize(&token, path_authority::GrantUse::QueryPath)?.path;
    // A file or a not-yet-created destination reports the free space of its
    // containing directory; a directory reports its own volume.
    let target = if parsed.is_dir() {
        parsed
    } else {
        parsed
            .parent()
            .ok_or_else(|| format!("Path has no parent directory: {}", parsed.display()))?
            .to_path_buf()
    };

    if !target.exists() || !target.is_dir() {
        return Err(format!(
            "Directory for disk space check does not exist: {}",
            target.display()
        ));
    }

    fs2::available_space(&target).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    // Small-file fs behind the storage lock runs on the blocking pool, never
    // on an async worker. Same pattern as `security::run_blocking`.
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = settings_path(&app)?;
        if !path.exists() {
            return Ok("{}".to_string());
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // Backup corrupt settings instead of silently returning defaults and
        // letting the next save overwrite the evidence.
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&raw);
        match parsed {
            Ok(value) if value.is_object() => Ok(raw),
            _ => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|value| value.as_nanos())
                    .unwrap_or_default();
                let backup = path.with_file_name(format!(
                    "settings.json.corrupt.{}.{}",
                    std::process::id(),
                    stamp
                ));
                std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
                let _ = fsync_parent(&backup);
                Ok("{}".to_string())
            }
        }
    })
    .await
}

#[tauri::command]
async fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = settings_path(&app)?;
        atomic_write(&path, &json)
    })
    .await
}

#[derive(serde::Serialize)]
struct BookmarkFileState {
    present: bool,
    contents: String,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct BookmarksState {
    primary: BookmarkFileState,
    backup: BookmarkFileState,
}

fn read_bookmark_state(
    path: &std::path::Path,
    security: &security::SecurityConfig,
) -> BookmarkFileState {
    match std::fs::metadata(path) {
        Ok(_) => match security::read_protected_file(path, "", security) {
            Ok(contents) => BookmarkFileState {
                present: true,
                contents,
                error: None,
            },
            Err(error) => BookmarkFileState {
                present: true,
                contents: String::new(),
                error: Some(error),
            },
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => BookmarkFileState {
            present: false,
            contents: String::new(),
            error: None,
        },
        Err(err) => BookmarkFileState {
            present: true,
            contents: String::new(),
            error: Some(format!("Could not inspect '{}': {}", path.display(), err)),
        },
    }
}

#[tauri::command]
async fn load_bookmarks_state(app: tauri::AppHandle) -> Result<BookmarksState, String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let security = load_security_config(&app)?;
        Ok(BookmarksState {
            primary: read_bookmark_state(&bookmarks_path(&app)?, &security),
            backup: read_bookmark_state(&bookmarks_backup_path(&app)?, &security),
        })
    })
    .await
}

#[tauri::command]
async fn load_bookmarks(app: tauri::AppHandle) -> Result<String, String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = bookmarks_path(&app)?;
        let security = load_security_config(&app)?;
        read_protected_file(&path, "[]", &security)
    })
    .await
}

#[tauri::command]
async fn save_bookmarks(app: tauri::AppHandle, json: String) -> Result<(), String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = bookmarks_path(&app)?;
        let security = load_security_config(&app)?;
        write_protected_file(&path, &json, &security)
    })
    .await
}

#[tauri::command]
async fn load_connection(app: tauri::AppHandle) -> Result<String, String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = connection_path(&app)?;
        let security = load_security_config(&app)?;
        read_protected_file(&path, "", &security)
    })
    .await
}

fn save_connection_blocking(
    app: tauri::AppHandle,
    connection_id: String,
    json: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    // Global lock order is storage -> S3: the storage guard is always acquired
    // first, so credential persistence can never deadlock against vault paths
    // that take the storage lock and then inspect the session. The session
    // lock is still held through persistence, so an older workflow can never
    // write credentials after the session it belongs to has been superseded.
    // Runs on the blocking pool (see the `save_connection` command), with
    // `State` resolved from the app handle there.
    let _storage_guard = lock_storage_meta()?;
    let s3 = lock_s3_state(&state)?;
    s3::require_connection_session(&s3, &connection_id)?;
    let persisted_identity = s3::persisted_connection_identity(&json)?;
    if s3.connection_identity.as_deref() != Some(persisted_identity.as_str()) {
        return Err("Saved connection does not match the active session".to_string());
    }
    let path = connection_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

// Runs on the blocking pool: plain sync commands run on the main thread,
// where waiting for the storage lock (held through PBKDF2 during a password
// change) or disk I/O would freeze the window.
#[tauri::command]
async fn save_connection(
    app: tauri::AppHandle,
    connection_id: String,
    json: String,
) -> Result<(), String> {
    security::run_blocking(move || save_connection_blocking(app, connection_id, json)).await
}

/// A reset may proceed when no live session exists; when one does, the caller
/// must name it exactly. A stale or missing id is a distinct refusal so the UI
/// can tell the user to disconnect and retry instead of showing a generic
/// failure.
fn require_reset_session(expected: Option<&str>, current: Option<&str>) -> Result<(), String> {
    match current {
        Some(current) if expected != Some(current) => Err(s3::STALE_CONNECTION_SESSION.to_string()),
        _ => Ok(()),
    }
}

fn clear_saved_connection_file(
    app: tauri::AppHandle,
    expected_connection_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    // Same global order as `save_connection` (storage -> S3). Serializing
    // against credential saves and invalidating the session after the write
    // guarantees an older in-flight connect workflow cannot restore the
    // credentials that this reset removed.
    let _storage_guard = lock_storage_meta()?;
    let mut s3 = lock_s3_state(&state)?;
    require_reset_session(
        expected_connection_id.as_deref(),
        s3.connection_id.as_deref(),
    )?;
    let path = connection_path(&app)?;
    // Delete rather than write an empty (encrypted) payload: removal needs no
    // vault key, so "Reset settings" works while storage is locked instead of
    // failing halfway with the credentials still on disk.
    security::remove_file_if_present(&path)?;
    s3::invalidate_connection_session(&mut s3);
    Ok(())
}

// Runs on the blocking pool: plain sync commands run on the main thread,
// where waiting for the storage lock (held through PBKDF2 during a password
// change) or disk I/O would freeze the window.
//
// A reset can run with no active session (after a disconnect, a failed
// connect, or while locked). In that case there is no newer session to
// protect, so credentials are still removed even when no connection id is
// supplied; a supplied id is only compared while a session exists.
#[tauri::command]
async fn clear_saved_connection(
    app: tauri::AppHandle,
    connection_id: Option<String>,
) -> Result<(), String> {
    let requested = connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let (mut gate, tokens) = s3::close_transfer_registry()?;
    let current = {
        let state = app.state::<AppState>();
        let current = match lock_s3_state(&state) {
            Ok(s3) => s3.connection_id.clone(),
            Err(err) => {
                gate.reopen();
                return Err(err);
            }
        };
        current
    };
    if let Err(err) = require_reset_session(requested.as_deref(), current.as_deref()) {
        gate.reopen();
        return Err(err);
    }
    s3::cancel_tokens(tokens);
    if let Err(err) = s3::cancel_all_registered_transfers("saved connection reset").await {
        // Nothing has been removed yet, so a timeout leaves the session and
        // settings intact and the user can retry the reset.
        gate.reopen();
        return Err(err);
    }

    let expected = current.clone();
    let result = security::run_blocking(move || clear_saved_connection_file(app, expected)).await;
    gate.reopen();
    result?;
    Ok(())
}

#[tauri::command]
async fn load_bookmarks_backup(app: tauri::AppHandle) -> Result<String, String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = bookmarks_backup_path(&app)?;
        let security = load_security_config(&app)?;
        read_protected_file(&path, "[]", &security)
    })
    .await
}

#[tauri::command]
async fn save_bookmarks_backup(app: tauri::AppHandle, json: String) -> Result<(), String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let path = bookmarks_backup_path(&app)?;
        let security = load_security_config(&app)?;
        write_protected_file(&path, &json, &security)
    })
    .await
}

#[derive(serde::Serialize)]
struct TransferManifestHydration {
    recovery_session: String,
    manifest_json: String,
    legacy_import_allowed: bool,
}

#[tauri::command]
async fn load_transfer_manifest(
    app: tauri::AppHandle,
) -> Result<TransferManifestHydration, String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        let recovery_session = load_or_create_transfer_recovery_session_unchecked(&app)?;
        let path = transfer_manifest_path(&app)?;
        let security = load_security_config(&app)?;
        // Releases before this one wrote the manifest unprotected, so plaintext is
        // tolerated here until the adoption sweep has run.
        let manifest_json = security::read_protected_file_with_legacy(
            &path,
            "",
            &security,
            security::LegacyPlaintext::Adopt,
        )?;
        let legacy_import_allowed = if manifest_json.trim().is_empty() {
            transfer_legacy_import_allowed_unchecked(&app)?
        } else {
            // Existing native recovery state proves that ownership already moved out
            // of browser storage. Persist that fact before exposing the hydration so
            // a later empty/cleared manifest cannot resurrect stale localStorage.
            close_transfer_legacy_import_unchecked(&app)?;
            false
        };
        Ok(TransferManifestHydration {
            recovery_session,
            manifest_json,
            legacy_import_allowed,
        })
    })
    .await
}

#[tauri::command]
async fn save_transfer_manifest(
    app: tauri::AppHandle,
    json: String,
    recovery_session: String,
    legacy_import: Option<bool>,
) -> Result<(), String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        require_transfer_recovery_session_unchecked(&app, &recovery_session)?;
        if legacy_import.unwrap_or(false) && !transfer_legacy_import_allowed_unchecked(&app)? {
            return Err(
                "Legacy transfer import is closed; stale browser recovery state was not imported."
                    .to_string(),
            );
        }
        let path = transfer_manifest_path(&app)?;
        let security = load_security_config(&app)?;
        write_protected_file(&path, &json, &security)?;
        // Every successful native save, including the one permitted legacy import,
        // permanently transfers ownership away from browser storage.
        close_transfer_legacy_import_unchecked(&app)
    })
    .await
}

#[tauri::command]
async fn clear_transfer_manifest(
    app: tauri::AppHandle,
    recovery_session: String,
) -> Result<(), String> {
    security::run_blocking(move || {
        let _storage_guard = lock_storage_meta()?;
        require_transfer_recovery_session_unchecked(&app, &recovery_session)?;
        // Close first: a crash between these operations may leave an old native
        // manifest, but can never leave an empty backend with legacy import rearmed.
        close_transfer_legacy_import_unchecked(&app)?;
        let path = transfer_manifest_path(&app)?;
        match std::fs::remove_file(&path) {
            Ok(()) => fsync_parent(&path),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    })
    .await
}
pub(crate) fn make_temp_path(path: &Path, purpose: &str) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let suffix = format!("{}.{}.{}.tmp", purpose, pid, counter);
    let extension = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", ext, suffix),
        _ => suffix,
    };
    path.with_extension(extension)
}

/// Filesystems that do not implement directory fsync report one of these.
#[cfg(unix)]
fn directory_sync_failure_is_unsupported(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput
    )
}

/// Flush directory metadata after creating, replacing, or removing an entry.
///
/// This is the strict form used for vault, checkpoint, and journal
/// publication: a directory entry that cannot be flushed is not durable, and
/// reporting success would lose the vault after a power failure on vFAT,
/// exFAT, FUSE, or SMB. Only the download path may downgrade this to a
/// warning.
#[cfg(unix)]
fn fsync_directory(dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(dir).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

/// Download-only variant: an unsupported directory fsync must not turn a
/// successfully published file into a reported failure.
#[cfg(unix)]
fn fsync_directory_best_effort(dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(dir).map_err(|e| e.to_string())?;
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(err) if directory_sync_failure_is_unsupported(&err) => {
            eprintln!(
                "Directory '{}' does not support fsync; the published download may not survive a power loss: {}",
                dir.display(),
                err
            );
            Ok(())
        }
        Err(err) => {
            eprintln!(
                "Directory '{}' could not be flushed after publishing a download; the file is visible but may not survive a power loss: {}",
                dir.display(),
                err
            );
            Ok(())
        }
    }
}

#[cfg(windows)]
fn fsync_directory(dir: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = to_extended_windows_path(dir)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map_err(|e| e.to_string())?;
        let flush = FlushFileBuffers(handle);
        let _ = CloseHandle(handle);
        flush.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Flush the directory entry created or replaced by a rename.
///
/// `File::sync_all` on the temp file only commits its contents. The rename
/// itself is a directory metadata operation, so without this the rename can be
/// lost on power failure even though the data was durable — leaving either the
/// previous version or, on some filesystems, a zero-length file.
pub(crate) fn fsync_parent(path: &std::path::Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        fsync_directory(parent)
    }

    #[cfg(windows)]
    {
        // Windows cannot open a directory as a regular file handle. Syncing the
        // renamed file after the rename flushes the containing volume's
        // metadata for that entry, which is the closest available equivalent.
        //
        // After deletion the path is gone; flush the parent directory so the
        // removal survives power loss instead of treating NotFound as success.
        //
        // FlushFileBuffers requires GENERIC_WRITE; opening read-only fails with
        // ERROR_ACCESS_DENIED on Windows.
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            Ok(file) => file.sync_all().map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fsync_directory(parent),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Download-destination variant of [`fsync_parent`].
///
/// The file is already published; an unsupported or failing directory flush
/// must not be reported as a failed download. It is logged so a power-loss
/// risk remains visible.
pub(crate) fn fsync_parent_best_effort(path: &std::path::Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        fsync_directory_best_effort(parent)
    }

    #[cfg(windows)]
    {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            Ok(file) => {
                if let Err(err) = file.sync_all() {
                    eprintln!(
                        "Published download '{}' could not be flushed; it may not survive a power loss: {}",
                        path.display(),
                        err
                    );
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Err(err) = fsync_directory(parent) {
                    eprintln!(
                        "Download directory '{}' could not be flushed; the removal may not survive a power loss: {}",
                        parent.display(),
                        err
                    );
                }
                Ok(())
            }
            Err(e) => {
                eprintln!(
                    "Published download '{}' could not be opened for flushing; it may not survive a power loss: {}",
                    path.display(),
                    e
                );
                Ok(())
            }
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = parent;
        Ok(())
    }
}

/// Identity of the directory that will receive a published download.
///
/// Captured when the download claims its scratch file and re-checked
/// immediately before publication. The canonical path catches a parent
/// swapped for a symlink; the device/inode pair catches a different real
/// directory mounted at the same path on Unix. Windows stable directory ids
/// need a separate handle query and remain the documented residual.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DestinationParentIdentity {
    canonical: PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

pub(crate) fn destination_parent_identity(
    destination: &std::path::Path,
) -> Result<DestinationParentIdentity, String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Destination must include a parent directory: {}",
            destination.display()
        )
    })?;
    let canonical = std::fs::canonicalize(parent).map_err(|err| {
        format!(
            "Failed to resolve destination parent '{}': {}",
            parent.display(),
            err
        )
    })?;
    let metadata = std::fs::metadata(&canonical).map_err(|err| {
        format!(
            "Failed to inspect destination parent '{}': {}",
            canonical.display(),
            err
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Destination parent is not a directory: {}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(DestinationParentIdentity {
            canonical,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(DestinationParentIdentity { canonical })
    }
}

/// Re-check the destination parent immediately before a rename.
pub(crate) fn verify_destination_parent_identity(
    destination: &std::path::Path,
    expected: &DestinationParentIdentity,
) -> Result<(), String> {
    let current = destination_parent_identity(destination)?;
    if &current != expected {
        return Err(format!(
            "Destination parent directory changed while the download was running; publication was \
             refused: {}",
            destination.display()
        ));
    }
    Ok(())
}

/// Create-only move for Windows volumes where hard links are unavailable.
///
/// `MoveFileW` fails with `ERROR_ALREADY_EXISTS` when the destination exists;
/// unlike `MoveFileExW` it never replaces, so the name stays reserved.
#[cfg(windows)]
fn move_file_noreplace(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::MoveFileW;

    let source_wide: Vec<u16> = to_extended_windows_path(source)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = to_extended_windows_path(destination)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MoveFileW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
        )
    }
    .map_err(|e| e.to_string())
}

/// Last-resort create-only publish for filesystems without hard links or
/// exclusive renames (FAT/exFAT USB drives, some SMB/FUSE mounts).
///
/// The destination is reserved with `create_new` before any bytes are written,
/// so an existing file is never replaced. A crash or copy error after
/// reservation can leave a partial destination; cleanup by pathname could
/// remove a concurrent replacement, so failures retain and report that state.
fn copy_file_exclusive(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut destination_file = options.open(destination).map_err(|e| e.to_string())?;
    let copy_result = std::fs::File::open(source).and_then(|mut source_file| {
        std::io::copy(&mut source_file, &mut destination_file)?;
        destination_file.sync_all()
    });
    drop(destination_file);
    match copy_result {
        Ok(()) => Ok(()),
        Err(err) => Err(format!(
            "Create-only copy failed after reserving the destination; failure cleanup left the destination path untouched to avoid deleting a concurrent replacement: {}",
            err
        )),
    }
}

/// Publish a fully synced temp file without replacing an existing destination.
///
/// Prefers an atomic hard link (same directory), then the Windows exclusive
/// move, then a reservation-and-copy fallback so downloads work on filesystems
/// that support neither.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TempPublication {
    Retained,
    Consumed,
}

fn publish_exclusive_with(
    temp_path: &std::path::Path,
    destination_path: &std::path::Path,
    mut hard_link: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    mut move_file: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    copy_file: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<TempPublication, String> {
    if hard_link(temp_path, destination_path).is_ok() {
        return Ok(TempPublication::Retained);
    }
    if move_file(temp_path, destination_path).is_ok() {
        return Ok(TempPublication::Consumed);
    }

    copy_file(temp_path, destination_path)
        .map(|()| TempPublication::Retained)
        .map_err(|err| format!("Destination was not published without overwrite: {}", err))
}

/// Publish a temp path while keeping the Windows move fallback observable to
/// the caller. Checkpointed downloads avoid the consuming fallback so their
/// complete bytes remain available if the destination sync fails.
fn publish_exclusive(
    temp_path: &std::path::Path,
    destination_path: &std::path::Path,
    allow_consuming_move: bool,
) -> Result<TempPublication, String> {
    publish_exclusive_with(
        temp_path,
        destination_path,
        |source: &Path, destination: &Path| std::fs::hard_link(source, destination),
        |source, destination| {
            #[cfg(windows)]
            {
                if allow_consuming_move {
                    move_file_noreplace(source, destination).map_err(std::io::Error::other)
                } else {
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (source, destination, allow_consuming_move);
                Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
            }
        },
        copy_file_exclusive,
    )
}

fn publish_temp_file_create_only_with(
    temp_path: &Path,
    destination_path: &Path,
    keep_temp_on_failure: bool,
    publish: impl FnOnce(&Path, &Path, bool) -> Result<TempPublication, String>,
    mut sync_parent: impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let publication = match publish(temp_path, destination_path, !keep_temp_on_failure) {
        Ok(publication) => publication,
        Err(error) => {
            return Err(format!(
                "{}; temporary scratch path was left untouched at '{}'",
                error,
                temp_path.display()
            ));
        }
    };

    if let Err(error) = sync_parent(destination_path) {
        return Err(format!(
            "Destination publication completed, but its parent directory sync failed; neither destination nor temporary scratch path was rolled back: {}",
            error
        ));
    }

    if publication == TempPublication::Retained {
        if let Err(error) = std::fs::remove_file(temp_path) {
            return Err(format!(
                "Destination publication completed, but temporary-file cleanup failed; the destination path was left in place: {}",
                error
            ));
        }
        if let Err(error) = sync_parent(destination_path) {
            // The first parent sync succeeded before scratch removal, so the
            // destination is already committed. A failed cleanup sync can only
            // leave the scratch removal uncertain after a crash; reporting this
            // as a failed publication would make a create-only retry collide
            // with the completed destination.
            eprintln!(
                "Destination '{}' was published and synced, but syncing temporary scratch cleanup failed; cleanup may be repeated after a crash: {}",
                destination_path.display(),
                error
            );
        }
        return Ok(());
    }

    sync_parent(destination_path).map_err(|error| {
        format!(
            "Destination publication completed, but its final parent directory sync failed; the destination path was left in place: {}",
            error
        )
    })
}

/// `keep_temp_on_failure` disables the consuming Windows move fallback for a
/// checkpointed download. Ambiguous create-only publication failures retain the
/// scratch regardless, because deleting its pathname cannot be made ownership-safe.
/// Download publication: same rename, but the destination parent was pinned
/// at scratch-claim time and the directory flush is best-effort.
///
/// `fsync_parent` is strict because vault/checkpoint callers must not lose a
/// published file silently. A download destination the user picked can live on
/// vFAT, FUSE, or SMB, and a failed directory flush there must not turn a
/// completed file into a reported failure. Callers verify the destination
/// parent identity immediately before invoking this.
pub(crate) fn publish_download_temp_file(
    temp_path: &std::path::Path,
    destination_path: &std::path::Path,
    overwrite: bool,
    keep_temp_on_failure: bool,
) -> Result<(), String> {
    let discard_temp = || {
        if !keep_temp_on_failure {
            let _ = std::fs::remove_file(temp_path);
        }
    };
    if overwrite {
        let mut last_err = String::new();
        for attempt in 0..3 {
            match std::fs::rename(temp_path, destination_path) {
                Ok(()) => return fsync_parent_best_effort(destination_path),
                Err(err) => {
                    last_err = err.to_string();
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
        discard_temp();
        return Err(last_err);
    }

    publish_temp_file_create_only_with(
        temp_path,
        destination_path,
        keep_temp_on_failure,
        publish_exclusive,
        fsync_parent_best_effort,
    )
}

pub(crate) fn publish_temp_file(
    temp_path: &std::path::Path,
    destination_path: &std::path::Path,
    overwrite: bool,
    keep_temp_on_failure: bool,
) -> Result<(), String> {
    let discard_temp = || {
        if !keep_temp_on_failure {
            let _ = std::fs::remove_file(temp_path);
        }
    };
    if overwrite {
        // Windows AV/indexer briefly opens the temp file after close, making
        // the rename fail with PermissionDenied. Retry twice before giving up.
        let mut last_err = String::new();
        for attempt in 0..3 {
            match std::fs::rename(temp_path, destination_path) {
                Ok(()) => return fsync_parent(destination_path),
                Err(err) => {
                    last_err = err.to_string();
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
        discard_temp();
        return Err(last_err);
    }

    publish_temp_file_create_only_with(
        temp_path,
        destination_path,
        keep_temp_on_failure,
        publish_exclusive,
        fsync_parent,
    )
}

fn atomic_write_with_overwrite(
    path: &std::path::Path,
    data: &str,
    overwrite: bool,
) -> Result<(), String> {
    let tmp_path = make_temp_path(path, "atomic");
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut tmp_file = options.open(&tmp_path).map_err(|e| e.to_string())?;
    let write_result = tmp_file
        .write_all(data.as_bytes())
        .and_then(|()| tmp_file.sync_all());
    drop(tmp_file);
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err.to_string());
    }
    publish_temp_file(&tmp_path, path, overwrite, false)
}

pub(crate) fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    atomic_write_with_overwrite(path, data, true)
}

fn is_owned_atomic_temp(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let parts: Vec<&str> = name.rsplitn(4, '.').collect();
    parts.len() == 4
        && parts[3].ends_with("atomic")
        && parts[2].parse::<u32>().is_ok()
        && parts[1].parse::<u64>().is_ok()
        && parts[0] == "tmp"
}

fn e2e_startup_trace_enabled() -> bool {
    std::env::var("S3_SIDEKICK_E2E_STARTUP_TRACE").as_deref() == Ok("1")
}

fn e2e_startup_trace(message: &str) {
    if e2e_startup_trace_enabled() {
        eprintln!("[s3-sidekick-e2e-startup] {}", message);
    }
}

fn e2e_inspector_server_trace_value() -> String {
    match std::env::var("WEBKIT_INSPECTOR_SERVER") {
        Ok(value) => match value.parse::<std::net::SocketAddr>() {
            Ok(address) if address.ip().is_loopback() && address.port() != 0 => address.to_string(),
            _ => "<invalid-or-non-loopback>".to_string(),
        },
        Err(std::env::VarError::NotPresent) => "<unset>".to_string(),
        Err(std::env::VarError::NotUnicode(_)) => "<invalid-or-non-loopback>".to_string(),
    }
}

fn e2e_startup_entry_trace() {
    if !e2e_startup_trace_enabled() {
        return;
    }
    let value = |name| {
        std::env::var_os(name)
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "<unset>".to_string())
    };
    eprintln!(
        "[s3-sidekick-e2e-startup] main-entry TAURI_WEBVIEW_AUTOMATION={} WEBKIT_INSPECTOR_SERVER={} DISPLAY={} XDG_DATA_HOME={} XDG_CONFIG_HOME={} XDG_CACHE_HOME={} XDG_STATE_HOME={}",
        value("TAURI_WEBVIEW_AUTOMATION"),
        e2e_inspector_server_trace_value(),
        value("DISPLAY"),
        value("XDG_DATA_HOME"),
        value("XDG_CONFIG_HOME"),
        value("XDG_CACHE_HOME"),
        value("XDG_STATE_HOME"),
    );
}

fn main() {
    e2e_startup_entry_trace();

    #[cfg(target_os = "linux")]
    {
        // Forced X11: see run.rosie.s3-sidekick.yml finish-args. Re-evaluate
        // native Wayland once WebKitGTK/Tauri stabilize; keep env override
        // escape hatch (user-set GDK_BACKEND is respected).
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            let dominated_by_nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
            if !dominated_by_nvidia {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
    }

    let builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            e2e_startup_trace("setup-entered-configured-windows-constructed");

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }

            // Finish or reverse a vault migration before any protected command
            // runs. A failure is latched by the security module so protected I/O
            // fails closed, and journal-owned staging is deliberately retained.
            e2e_startup_trace("storage-recovery-started");
            let migration_recovered = match lock_storage_ops()
                .and_then(|_storage_guard| security::recover_interrupted_migration(app.handle()))
            {
                Ok(()) => true,
                Err(err) => {
                    eprintln!("Vault migration recovery failed: {}", err);
                    false
                }
            };
            e2e_startup_trace(if migration_recovered {
                "storage-recovery-finished success=true"
            } else {
                "storage-recovery-finished success=false"
            });

            // Atomic-write leftovers are safe to sweep only when no migration
            // journal exists. Never infer ownership from the `.tmp` extension
            // while recovery is pending or failed.
            if migration_recovered
                && security_journal_path(app.handle())
                    .map(|path| !path.exists())
                    .unwrap_or(false)
            {
                if let Ok(dir) = resolved_app_data_dir(app.handle()) {
                    if let Ok(entries) = std::fs::read_dir(&dir) {
                        for entry in entries.flatten() {
                            if entry
                                .file_type()
                                .map(|kind| kind.is_file())
                                .unwrap_or(false)
                                && is_owned_atomic_temp(&entry.path())
                            {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
                // Reap lease-tracked download scratch with no surviving
                // checkpoint. Lease files live beside the user destination;
                // without this sweep a crashed or abandoned download leaks a
                // full-size scratch file forever.
                sweep_orphaned_download_leases_at_startup(app.handle());
            }
            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // The operating system, not the webview, supplies dragged paths. Mint
    // upload grants here so `take_dropped_upload_grants` can only hand back
    // what the user actually dropped.
    let builder = builder.on_window_event(|_window, event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            path_authority::record_native_drop(paths.clone());
        }
    });

    e2e_startup_trace("before-builder-run");
    if let Err(err) = builder
        .manage(AppState(Mutex::new(S3State {
            client: None,
            endpoint: String::new(),
            region: String::new(),
            bucket_hint: None,
            connection_generation: 0,
            connection_id: None,
            connection_identity: None,
            storage_provider: StorageProviderKind::default(),
        })))
        .invoke_handler(tauri::generate_handler![
            s3::connect,
            s3::disconnect,
            s3::get_connection_id,
            s3::list_buckets,
            s3::list_objects,
            s3::head_object,
            s3::update_metadata,
            s3::delete_objects,
            s3::upload_object,
            s3::upload_object_bytes,
            s3::get_object_acl,
            s3::set_object_acl,
            s3::download_object,
            s3::download_object_parallel,
            s3::cancel_transfer,
            s3::create_folder,
            s3::rename_object,
            s3::delete_prefix,
            s3::rename_prefix,
            s3::copy_object_to,
            s3::copy_prefix_to,
            s3::delete_copied_objects,
            s3::list_rollback_backups,
            s3::delete_rollback_backups,
            s3::object_exists,
            s3::build_object_url,
            s3::generate_presigned_url,
            s3::preview_object,
            files::list_local_files_recursive,
            pick_upload_files,
            pick_upload_folder,
            pick_download_file,
            pick_download_directory,
            pick_text_export,
            take_dropped_upload_grants,
            export_text_file,
            path_exists,
            discard_download_scratch,
            transfer_checkpoint_remove,
            transfer_checkpoint_gc,
            get_available_disk_bytes,
            load_settings,
            save_settings,
            load_bookmarks,
            load_bookmarks_state,
            save_bookmarks,
            load_connection,
            save_connection,
            clear_saved_connection,
            load_bookmarks_backup,
            save_bookmarks_backup,
            load_transfer_manifest,
            save_transfer_manifest,
            clear_transfer_manifest,
            security::get_security_status,
            security::initialize_security,
            security::unlock_security,
            security::set_security_encryption,
            security::change_security_password,
            security::lock_security,
            security::touch_security_activity,
            security::set_lock_timeout,
            security::factory_reset,
            biometric::enable_biometric,
            biometric::disable_biometric,
            biometric::unlock_biometric,
            platform::get_platform_info,
            platform::is_app_translocated,
            platform::updater_supported,
            platform::updater_support_info,
            platform::open_external_url,
            platform::open_local_path,
            platform::reveal_local_path,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Application error: {}", err);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn s3_mutation_scopes_conflict_only_for_overlapping_keyspaces() {
        let key = S3MutationScope::key("connection", "bucket", "photos/2026/a.jpg");
        let same_key = S3MutationScope::key("connection", "bucket", "photos/2026/a.jpg");
        let parent = S3MutationScope::prefix("connection", "bucket", "photos/");
        let child = S3MutationScope::prefix("connection", "bucket", "photos/2026/");
        let sibling = S3MutationScope::prefix("connection", "bucket", "documents/");
        let other_bucket = S3MutationScope::prefix("connection", "other-bucket", "photos/");
        let other_connection = S3MutationScope::prefix("other-connection", "bucket", "photos/");

        assert!(s3_mutation_scopes_overlap(&key, &same_key));
        assert!(s3_mutation_scopes_overlap(&key, &parent));
        assert!(s3_mutation_scopes_overlap(&parent, &child));
        assert!(!s3_mutation_scopes_overlap(&key, &sibling));
        assert!(!s3_mutation_scopes_overlap(&key, &other_bucket));
        assert!(!s3_mutation_scopes_overlap(&key, &other_connection));
    }

    #[tokio::test]
    async fn queued_s3_mutation_lease_observes_cancellation() {
        let scope = S3MutationScope::key(
            "cancellation-test-connection",
            "cancellation-test-bucket",
            "cancellation-test-key",
        );
        let held = acquire_s3_mutation(vec![scope.clone()])
            .await
            .expect("first lease should acquire");
        let token: s3::CancelToken = std::sync::Arc::new(s3::CancelFlag::default());
        let waiter_token = std::sync::Arc::clone(&token);
        let waiter_scope = scope.clone();
        let waiter = tokio::spawn(async move {
            acquire_s3_mutation_cancellable(vec![waiter_scope], &waiter_token).await
        });
        tokio::task::yield_now().await;
        token.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("cancelled waiter should wake")
            .expect("waiter task should not panic");
        let error = match result {
            Ok(_) => panic!("cancelled waiter must not acquire"),
            Err(error) => error,
        };
        assert_eq!(error, "Transfer cancelled");
        drop(held);
        acquire_s3_mutation(vec![scope])
            .await
            .expect("cancelled waiter must not retain the lease");
    }

    #[test]
    fn make_temp_path_includes_purpose() {
        let base = Path::new("/tmp/test.json");
        let temp = make_temp_path(base, "download");
        let name = temp.file_name().unwrap().to_str().unwrap();
        assert!(
            name.contains("download"),
            "temp path should contain purpose: {}",
            name
        );
        assert!(
            name.ends_with(".tmp"),
            "temp path should end in .tmp: {}",
            name
        );
    }

    #[test]
    fn make_temp_path_unique() {
        let base = Path::new("/tmp/test.json");
        let t1 = make_temp_path(base, "test");
        let t2 = make_temp_path(base, "test");
        assert_ne!(t1, t2);
    }

    #[test]
    fn picker_default_directory_resolves_directories_and_files() {
        let dir = scratch_dir("picker-default");
        let file = dir.join("report.txt");
        std::fs::write(&file, b"data").unwrap();

        assert_eq!(
            picker_default_directory(Some(dir.to_string_lossy().into_owned())),
            Some(dir.clone())
        );
        assert_eq!(
            picker_default_directory(Some(file.to_string_lossy().into_owned())),
            Some(dir.clone())
        );
        assert_eq!(
            picker_default_directory(Some(
                dir.join("not-created-yet.txt")
                    .to_string_lossy()
                    .into_owned()
            )),
            Some(dir.clone())
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn picker_default_directory_ignores_invalid_hints() {
        assert_eq!(picker_default_directory(None), None);
        assert_eq!(picker_default_directory(Some(String::new())), None);
        assert_eq!(
            picker_default_directory(Some("relative/path".to_string())),
            None
        );
        assert_eq!(
            picker_default_directory(Some("/tmp/../etc/passwd".to_string())),
            None
        );
        assert_eq!(
            picker_default_directory(Some(
                "/definitely/not/a/real/path/abc123/file.txt".to_string()
            )),
            None
        );
    }

    #[test]
    fn parse_user_path_rejects_empty() {
        assert!(parse_user_path("", "Test").is_err());
        assert!(parse_user_path("   ", "Test").is_err());
    }

    #[test]
    fn parse_user_path_rejects_relative() {
        assert!(parse_user_path("relative/path", "Test").is_err());
    }

    #[test]
    fn validate_existing_path_rejects_nonexistent() {
        let result = validate_existing_path("/definitely/not/a/real/path/abc123", "Test");
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_destination_rejects_symlink_to_regular_file() {
        use std::os::unix::fs::symlink;

        let dir = scratch_dir("overwrite-symlink");
        let target = dir.join("target.bin");
        std::fs::write(&target, b"keep").unwrap();
        let link = dir.join("destination.bin");
        symlink(&target, &link).unwrap();

        let error = validate_destination_path_allow_overwrite(link.to_str().unwrap())
            .expect_err("overwrite into a symlink must be refused");
        assert!(error.contains("symbolic link"), "{error}");
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn upload_source_rejects_symlink_to_regular_file() {
        use std::os::unix::fs::symlink;

        let dir = scratch_dir("upload-symlink");
        let target = dir.join("target.bin");
        std::fs::write(&target, b"secret").unwrap();
        let link = dir.join("upload.bin");
        symlink(&target, &link).unwrap();

        let error = validate_upload_source_path(link.to_str().unwrap())
            .expect_err("upload from a symlink must be refused");
        assert!(error.contains("symbolic link"), "{error}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "s3-sidekick-main-test-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // -----------------------------------------------------------------------
    // Download scratch-path ownership (M5)
    // -----------------------------------------------------------------------

    #[test]
    fn download_temp_path_is_derived_and_recognisable() {
        let dest = Path::new("/tmp/report.pdf");
        let temp = download_temp_path(dest);
        assert_eq!(
            temp,
            PathBuf::from("/tmp/report.pdf.s3-sidekick.download.tmp")
        );
        assert_ne!(temp, dest.to_path_buf());
    }

    #[test]
    fn download_temp_path_is_stable_across_calls() {
        // Resume depends on the scratch path being reproducible between sessions.
        let dest = Path::new("/tmp/archive.zip");
        assert_eq!(download_temp_path(dest), download_temp_path(dest));
    }

    #[test]
    fn startup_cleanup_only_accepts_atomic_temp_names() {
        assert!(is_owned_atomic_temp(Path::new(
            "/tmp/security.json.atomic.123.4.tmp"
        )));
        assert!(!is_owned_atomic_temp(Path::new(
            "/tmp/foreign.s3-sidekick.download.tmp"
        )));
        assert!(!is_owned_atomic_temp(Path::new("/tmp/foreign.tmp")));
    }

    #[test]
    fn remove_path_if_exists_refuses_paths_we_do_not_own() {
        let dir = scratch_dir("remove-guard");
        let victim = dir.join("important.txt");
        std::fs::write(&victim, b"precious").unwrap();

        let err =
            remove_owned_download_temp(&victim.to_string_lossy(), &victim.to_string_lossy(), false)
                .expect_err("an arbitrary file must not be removable");
        assert!(err.contains("unregistered"), "unexpected error: {}", err);
        assert!(victim.exists(), "the file must still be there");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_lease_only_authorizes_its_derived_scratch() {
        let dir = scratch_dir("lease-derived");
        let destination = dir.join("movie.mkv");
        let derived = download_temp_path(&destination);
        let lease = DownloadScratchLease {
            destination: destination.to_string_lossy().into_owned(),
            temp_path: derived.to_string_lossy().into_owned(),
            nonce: "n".to_string(),
        };
        assert_eq!(
            lease_scratch_target(&lease),
            Some((destination.clone(), derived))
        );

        let arbitrary = dir.join("important.txt");
        std::fs::write(&arbitrary, b"keep me").unwrap();
        let malicious = DownloadScratchLease {
            destination: destination.to_string_lossy().into_owned(),
            temp_path: arbitrary.to_string_lossy().into_owned(),
            nonce: "n".to_string(),
        };
        assert!(lease_scratch_target(&malicious).is_none());
        assert!(
            arbitrary.exists(),
            "an arbitrary path must never be deleted"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claiming_the_same_scratch_twice_fails_until_the_guard_drops() {
        let dir = scratch_dir("claim-twice");
        let dest = dir.join("file.bin");
        let temp = download_temp_path(&dest);
        let lock_path = download_temp_lock_path(&temp);
        let first = claim_download_temp(&temp, &dest).unwrap();
        assert!(lock_path.exists(), "the OS lock file must be created");
        let err = claim_download_temp(&temp, &dest).expect_err("second claim must fail");
        assert!(err.contains("already in use"), "unexpected error: {}", err);
        drop(first);
        // A new guard re-locks the same persistent lock file, proving the OS
        // lock was released on drop.
        let _second = claim_download_temp(&temp, &dest).unwrap();
        assert!(lock_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claim_rejects_a_scratch_locked_by_another_owner() {
        use fs2::FileExt;

        // fs2 locks are OS-level, so a second open handle in this test behaves
        // like another process: the second exclusive lock is refused. This
        // documents the cross-process guarantee without spawning a child.
        let dir = scratch_dir("claim-os-lock");
        let dest = dir.join("file.bin");
        let temp = download_temp_path(&dest);
        let lock_path = download_temp_lock_path(&temp);
        let held = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        held.try_lock_exclusive().unwrap();

        let err = claim_download_temp(&temp, &dest).expect_err("foreign lock must block claim");
        assert!(err.contains("already in use"), "unexpected error: {}", err);
        assert!(
            !is_claimed_download_temp(&temp, &dest),
            "a rejected claim must not register in-memory ownership"
        );

        drop(held);
        let guard = claim_download_temp(&temp, &dest).unwrap();
        assert!(is_claimed_download_temp(&temp, &dest));
        drop(guard);
        assert!(!is_claimed_download_temp(&temp, &dest));
        assert!(lock_path.exists(), "the lock file must not be deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_unusable_download_scratch_removes_leftover_files() {
        let dir = scratch_dir("clear-scratch");
        let temp = download_temp_path(&dir.join("movie.mkv"));
        std::fs::write(&temp, b"partial").unwrap();
        clear_unusable_download_scratch(&temp).unwrap();
        assert!(!temp.exists());
        clear_unusable_download_scratch(&temp).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fsync_parent_after_delete_syncs_parent_directory() {
        let dir = scratch_dir("fsync-after-delete");
        let temp = dir.join("scratch.tmp");
        std::fs::write(&temp, b"x").unwrap();
        std::fs::remove_file(&temp).unwrap();
        fsync_parent(&temp).unwrap();
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn only_unsupported_directory_sync_errors_are_downgraded() {
        // Vault and checkpoint publication must fail closed. Only the two
        // error kinds filesystems use to say "directory fsync is not
        // implemented" may be treated as success, and only on the
        // best-effort download path.
        for kind in [
            std::io::ErrorKind::Unsupported,
            std::io::ErrorKind::InvalidInput,
        ] {
            assert!(
                directory_sync_failure_is_unsupported(&std::io::Error::from(kind)),
                "{kind:?} must be recognised as an unsupported filesystem"
            );
        }
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::NotFound,
            std::io::ErrorKind::Other,
        ] {
            assert!(
                !directory_sync_failure_is_unsupported(&std::io::Error::from(kind)),
                "{kind:?} must not be downgraded to success"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn destination_parent_identity_refuses_a_swapped_parent() {
        let dir = scratch_dir("parent-swap");
        let destination = dir.join("out.bin");
        let expected = destination_parent_identity(&destination).unwrap();
        verify_destination_parent_identity(&destination, &expected)
            .expect("an unchanged parent must verify");

        // Replace the validated parent with a symlink to another directory.
        let moved = dir.with_extension("moved");
        std::fs::rename(&dir, &moved).unwrap();
        let other = scratch_dir("parent-swap-target");
        std::os::unix::fs::symlink(&other, &dir).unwrap();
        let err = verify_destination_parent_identity(&destination, &expected)
            .expect_err("a parent swapped for a symlink must be refused");
        assert!(err.contains("changed"), "unexpected error: {err}");

        let _ = std::fs::remove_file(&dir);
        let _ = std::fs::remove_dir_all(&moved);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn startup_lease_sweep_age_is_bounded_by_max_retention() {
        let now = std::time::SystemTime::now();
        let max_age = std::time::Duration::from_secs(DOWNLOAD_LEASE_STARTUP_MAX_AGE_SECS);
        let fresh = now - std::time::Duration::from_secs(24 * 3600);
        let stale = now - (max_age + std::time::Duration::from_secs(1));
        assert!(!download_lease_age_exceeds(fresh, now, max_age));
        assert!(download_lease_age_exceeds(stale, now, max_age));
        // A clock that moved backwards must retain the lease, not reap it.
        assert!(!download_lease_age_exceeds(now, fresh, max_age));
    }

    #[cfg(unix)]
    #[test]
    fn app_data_directories_are_created_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("private-app-data").join("nested");
        ensure_private_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);

        let existing = scratch_dir("private-existing");
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&existing).unwrap();
        let mode = std::fs::metadata(&existing).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);

        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        let _ = std::fs::remove_dir_all(&existing);
    }

    #[test]
    fn remove_path_if_exists_removes_our_own_scratch_file() {
        let dir = scratch_dir("remove-owned");
        let temp = download_temp_path(&dir.join("movie.mkv"));
        std::fs::write(&temp, b"partial").unwrap();
        let _claim = claim_download_temp(&temp, &dir.join("movie.mkv")).unwrap();

        remove_owned_download_temp(
            &temp.to_string_lossy(),
            &dir.join("movie.mkv").to_string_lossy(),
            false,
        )
        .unwrap();
        assert!(!temp.exists());

        // Absent is not an error.
        remove_owned_download_temp(
            &temp.to_string_lossy(),
            &dir.join("movie.mkv").to_string_lossy(),
            false,
        )
        .unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_export_text_rejects_non_text_extensions() {
        let dir = scratch_dir("write-guard");
        for name in ["payload.sh", "agent.plist", "profile", "thing.exe"] {
            let target = dir.join(name);
            let token = path_authority::mint(
                path_authority::GrantPurpose::ExportText,
                &target,
                false,
                None,
            );
            // A grant exists, so the refusal must come from the extension
            // allowlist rather than from the missing authority.
            assert!(
                path_authority::authorize(&token, path_authority::GrantUse::ExportText).is_ok()
            );
            let err = write_export_text(&target, "#!/bin/sh\n", None)
                .expect_err("only text exports are allowed");
            assert!(err.contains("extensions"), "unexpected error: {}", err);
            assert!(!target.exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_destination_requires_a_grant() {
        // The old signature accepted an absolute destination string. Passing
        // one now must fail before any file is touched.
        let err = resolve_download_destination("C:\\tmp\\picked.bin", None)
            .expect_err("a raw destination must not authorize a download");
        assert!(err.contains("grant"), "unexpected error: {}", err);
    }

    #[test]
    fn path_exists_requires_a_grant() {
        let err = path_exists("C:\\tmp\\probe.txt".to_string(), None)
            .expect_err("a raw path must not be probeable");
        assert!(err.contains("grant"), "unexpected error: {}", err);
    }

    #[test]
    fn path_exists_child_queries_bind_only_to_a_download_destination() {
        let dir = scratch_dir("query-child");
        let child = dir.join("probe.txt");
        std::fs::write(&child, b"x").unwrap();

        let upload_root =
            path_authority::mint(path_authority::GrantPurpose::UploadRoot, &dir, true, None);
        // An upload grant is not a free-space or child-existence oracle (M8).
        let err = path_exists(upload_root.clone(), None)
            .expect_err("an upload-root grant must not answer a path query");
        assert!(err.contains("cannot be used"), "unexpected error: {}", err);
        let err = path_exists(upload_root, Some("probe.txt".to_string()))
            .expect_err("an upload-root grant must not become a child oracle");
        assert!(err.contains("cannot be used"), "unexpected error: {}", err);

        let download_dir = path_authority::mint(
            path_authority::GrantPurpose::DownloadDestination,
            &dir,
            true,
            None,
        );
        assert!(path_exists(download_dir.clone(), Some("probe.txt".to_string())).unwrap());
        assert!(!path_exists(download_dir.clone(), Some("missing.txt".to_string())).unwrap());
        assert!(
            path_exists(download_dir, Some("../escape".to_string())).is_err(),
            "a download destination must still reject path traversal"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_saved_connection_reset_names_the_user_action() {
        assert_eq!(
            require_reset_session(Some("old-session"), Some("new-session"))
                .expect_err("a stale reset must be refused"),
            s3::STALE_CONNECTION_SESSION
        );
        assert!(
            require_reset_session(None, Some("new-session")).is_err(),
            "a reset with no id must not silently clear a live session"
        );
        assert!(require_reset_session(Some("new-session"), Some("new-session")).is_ok());
        assert!(
            require_reset_session(Some("old-session"), None).is_ok(),
            "a disconnected reset still clears saved credentials"
        );
        assert!(require_reset_session(None, None).is_ok());
    }

    #[test]
    fn export_command_requires_a_grant() {
        // The old command took a raw path. It must now fail before touching
        // the filesystem, whatever the path is.
        assert!(path_authority::authorize(
            "/tmp/not-a-grant.txt",
            path_authority::GrantUse::ExportText
        )
        .is_err());
    }

    #[test]
    fn write_export_text_refuses_reserved_app_state_names_inside_app_data() {
        let dir = scratch_dir("write-reserved");
        for name in ["settings.json", "bookmarks.json", "security.json"] {
            let target = dir.join(name);
            let err = write_export_text(&target, "{}", Some(&dir))
                .expect_err("application state must not be overwritten");
            assert!(
                err.contains("application state"),
                "unexpected error: {}",
                err
            );
            assert!(!target.exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_export_text_allows_reserved_names_outside_app_data() {
        let app_data = scratch_dir("write-reserved-app");
        let documents = scratch_dir("write-reserved-documents");
        let target = documents.join("settings.json");
        write_export_text(&target, "{}", Some(&app_data)).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&documents);
    }

    #[test]
    fn case_fold_collision_detection_folds_nfc_equivalents() {
        let err = detect_case_fold_collision(
            [
                (
                    "cafe\u{301}.txt".to_string(),
                    "/a/cafe\u{301}.txt".to_string(),
                ),
                ("caf\u{e9}.txt".to_string(), "/b/caf\u{e9}.txt".to_string()),
            ],
            "upload paths",
        )
        .expect_err("normalization-equivalent names must collide");
        assert!(err.contains("collision"), "unexpected error: {}", err);
    }

    #[test]
    fn write_export_text_refuses_the_app_data_directory() {
        let dir = scratch_dir("write-app-data");
        let target = dir.join("activity.txt");
        let err = write_export_text(&target, "hello", Some(&dir))
            .expect_err("app data must stay private");
        assert!(
            err.contains("private data directory"),
            "unexpected error: {}",
            err
        );
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_export_text_allows_log_exports() {
        let dir = scratch_dir("write-allow");
        let target = dir.join("activity.txt");
        write_export_text(&target, "hello", None).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");

        // The save dialog owns overwrite consent, so a second export replaces
        // the previous file.
        write_export_text(&target, "again", None).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "again");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // Durability (M2)
    // -----------------------------------------------------------------------

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = scratch_dir("atomic-write");
        let target = dir.join("config.json");

        atomic_write(&target, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":1}");

        atomic_write(&target, "{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":2}");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic_write left temp files behind: {:?}",
            leftovers
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fsync_parent_is_ok_for_existing_and_missing_paths() {
        let dir = scratch_dir("fsync-parent");
        let target = dir.join("file.txt");
        std::fs::write(&target, b"x").unwrap();
        fsync_parent(&target).unwrap();
        // A path that does not exist yet still has a syncable parent.
        fsync_parent(&dir.join("absent.txt")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // Checkpoint naming
    // -----------------------------------------------------------------------

    #[test]
    fn checkpoint_file_name_is_a_stable_hex_digest() {
        let a = checkpoint_file_name("download:bucket:key:/tmp/out");
        let b = checkpoint_file_name("download:bucket:key:/tmp/out");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, checkpoint_file_name("download:bucket:key:/tmp/other"));
    }

    #[test]
    fn checkpoint_scratch_path_accepts_only_owned_download_temps() {
        let destination = std::env::temp_dir()
            .join("s3-sidekick-checkpoint-test")
            .join("file.bin");
        let temp_path = download_temp_path(&destination);
        let destination = destination.to_string_lossy().to_string();
        let temp_path = temp_path.to_string_lossy().to_string();
        let owned = serde_json::json!({
            "destination": &destination,
            "temp_path": &temp_path
        })
        .to_string();
        assert_eq!(
            checkpoint_scratch_path(&owned).unwrap(),
            Some(CheckpointScratchPath {
                destination: destination.clone(),
                temp_path: temp_path.clone(),
            })
        );

        let foreign = serde_json::json!({ "temp_path": &destination }).to_string();
        assert!(checkpoint_scratch_path(&foreign).is_err());
        assert!(checkpoint_scratch_path("not-json").is_err());
        assert_eq!(checkpoint_scratch_path("{}").unwrap(), None);
    }

    // -----------------------------------------------------------------------
    // Create-only download publication (A05)
    // -----------------------------------------------------------------------

    fn publication_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let dir = scratch_dir(label);
        let temp = dir.join("download.tmp");
        let destination = dir.join("result.bin");
        std::fs::write(&temp, b"download payload").unwrap();
        (dir, temp, destination)
    }

    fn publication_move_for_test(source: &Path, destination: &Path) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            move_file_noreplace(source, destination).map_err(std::io::Error::other)
        }
        #[cfg(not(windows))]
        {
            std::fs::rename(source, destination)
        }
    }

    #[test]
    fn publish_move_consumed_temp_keeps_the_successful_destination() {
        let (dir, temp, destination) = publication_fixture("publish-move-consumed");
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
                |source, target| {
                    assert!(
                        allow_move,
                        "checkpoint publication must not consume its source"
                    );
                    publication_move_for_test(source, target)
                },
                copy_file_exclusive,
            )
        };

        publish_temp_file_create_only_with(&temp, &destination, false, publish, |_| Ok(()))
            .unwrap();

        assert!(
            !temp.exists(),
            "a successful move must consume the temp path"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_hard_link_path_retains_source_until_cleanup() {
        let (dir, temp, destination) = publication_fixture("publish-hard-link");
        let publish = |source: &Path, target: &Path, _allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |source: &Path, target: &Path| std::fs::hard_link(source, target),
                |_, _| panic!("move fallback must not run after hard-link success"),
                |_, _| panic!("copy fallback must not run after hard-link success"),
            )
        };

        publish_temp_file_create_only_with(&temp, &destination, false, publish, |_| Ok(()))
            .unwrap();

        assert!(
            !temp.exists(),
            "retained link source is removed after commit"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_copy_fallback_preserves_create_only_bytes() {
        let (dir, temp, destination) = publication_fixture("publish-copy-fallback");
        let publish = |source: &Path, target: &Path, _allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
                copy_file_exclusive,
            )
        };

        publish_temp_file_create_only_with(&temp, &destination, false, publish, |_| Ok(()))
            .unwrap();

        assert!(!temp.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_existing_destination_is_preserved_and_temp_is_retained_for_checkpoint() {
        let (dir, temp, destination) = publication_fixture("publish-occupied");
        std::fs::write(&destination, b"another writer").unwrap();
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |source: &Path, target: &Path| std::fs::hard_link(source, target),
                |_, _| {
                    assert!(!allow_move, "checkpoint publication must retain its source");
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                },
                copy_file_exclusive,
            )
        };

        assert!(
            publish_temp_file_create_only_with(&temp, &destination, true, publish, |_| Ok(()))
                .is_err()
        );

        assert_eq!(std::fs::read(&destination).unwrap(), b"another writer");
        assert_eq!(std::fs::read(&temp).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_copy_error_retains_partial_reservation_for_safe_recovery() {
        let (dir, temp, destination) = publication_fixture("publish-copy-error");
        std::fs::remove_file(&temp).unwrap();
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
                |_, _| {
                    assert!(!allow_move);
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                },
                copy_file_exclusive,
            )
        };

        assert!(
            publish_temp_file_create_only_with(&temp, &destination, true, publish, |_| Ok(()))
                .is_err()
        );

        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"",
            "a failed copy may retain its create-only reservation rather than risk deleting a replacement"
        );
        assert!(!temp.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_sync_error_retains_destination_and_checkpoint() {
        let (dir, temp, destination) = publication_fixture("publish-sync-error");
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
                |_, _| {
                    assert!(!allow_move);
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                },
                copy_file_exclusive,
            )
        };

        assert!(
            publish_temp_file_create_only_with(&temp, &destination, true, publish, |_| Err(
                "injected directory sync failure".to_string()
            ),)
            .is_err()
        );

        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"download payload",
            "the published file is retained when durability cannot be confirmed"
        );
        assert_eq!(std::fs::read(&temp).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_sync_error_preserves_an_unrelated_destination_replacement() {
        let (dir, temp, destination) = publication_fixture("publish-sync-replacement");
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |source: &Path, target: &Path| std::fs::hard_link(source, target),
                |_, _| {
                    assert!(!allow_move);
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                },
                copy_file_exclusive,
            )
        };

        let result =
            publish_temp_file_create_only_with(&temp, &destination, true, publish, |path| {
                std::fs::remove_file(path).unwrap();
                std::fs::write(path, b"unrelated replacement").unwrap();
                Err("injected directory sync failure".to_string())
            });

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"unrelated replacement"
        );
        assert_eq!(std::fs::read(&temp).unwrap(), b"download payload");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn retained_temp_cleanup_error_does_not_delete_destination_replacement() {
        let (dir, temp, destination) = publication_fixture("publish-cleanup-replacement");
        let publish = |source: &Path, target: &Path, _allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |source: &Path, target: &Path| std::fs::hard_link(source, target),
                |_, _| panic!("move fallback must not run after hard-link success"),
                |_, _| panic!("copy fallback must not run after hard-link success"),
            )
        };
        let mut syncs = 0;

        let result = publish_temp_file_create_only_with(&temp, &destination, true, publish, |_| {
            syncs += 1;
            if syncs == 1 {
                std::fs::remove_file(&destination).unwrap();
                std::fs::write(&destination, b"unrelated replacement").unwrap();
                std::fs::remove_file(&temp).unwrap();
                std::fs::create_dir(&temp).unwrap();
            }
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"unrelated replacement"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_final_cleanup_sync_error_keeps_durably_published_result_successful() {
        let (dir, temp, destination) = publication_fixture("publish-final-sync-error");
        let publish = |source: &Path, target: &Path, allow_move: bool| {
            publish_exclusive_with(
                source,
                target,
                |source: &Path, target: &Path| std::fs::hard_link(source, target),
                |_, _| {
                    assert!(!allow_move);
                    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
                },
                copy_file_exclusive,
            )
        };
        let mut syncs = 0;

        let result = publish_temp_file_create_only_with(&temp, &destination, true, publish, |_| {
            syncs += 1;
            if syncs == 2 {
                Err("injected scratch-removal directory sync failure".to_string())
            } else {
                Ok(())
            }
        });

        assert_eq!(
            syncs, 2,
            "both publication and cleanup syncs must be attempted"
        );
        assert!(
            result.is_ok(),
            "cleanup durability failure must not turn a committed destination into a failed transfer: {result:?}"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"download payload");
        assert!(!temp.exists(), "the retained scratch was already removed");
        let _ = std::fs::remove_dir_all(dir);
    }
}
