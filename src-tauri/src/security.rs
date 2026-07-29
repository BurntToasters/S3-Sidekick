use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    atomic_write, bookmarks_backup_path, bookmarks_path, collect_transfer_checkpoint_scratch_paths,
    connection_path, fsync_parent, lock_storage_ops, purge_transfer_checkpoints,
    security_journal_path, security_path, transfer_manifest_path,
};

#[cfg(not(test))]
pub(crate) const PBKDF2_ITERATIONS: u32 = 600_000;
/// Reduced work factor for tests only.
///
/// The suite performs dozens of derivations and an unoptimised PBKDF2 at the
/// production count costs seconds each, which would push the test run into
/// minutes. Still above `MIN_PBKDF2_ITERATIONS` so the validation paths under
/// test behave exactly as they do in production.
#[cfg(test)]
pub(crate) const PBKDF2_ITERATIONS: u32 = 120_000;
const MIN_PBKDF2_ITERATIONS: u32 = 100_000;
/// Upper bound on the stored iteration count.
///
/// PBKDF2 runs before the vault can be opened, so an absurd value in
/// `security.json` would otherwise hang unlock indefinitely with no way to
/// recover short of editing the file by hand.
const MAX_PBKDF2_ITERATIONS: u32 = 10_000_000;
pub(crate) const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// Bytes of the key verifier embedded in each payload as a key-check value.
const KEY_CHECK_LEN: usize = 8;

struct KeyState {
    key: Option<[u8; KEY_LEN]>,
    last_activity: Option<Instant>,
    lock_timeout_secs: u64,
}

impl Drop for KeyState {
    fn drop(&mut self) {
        if let Some(ref mut k) = self.key {
            k.zeroize();
        }
    }
}

static KEY_STATE: OnceLock<Mutex<KeyState>> = OnceLock::new();
static MIGRATION_RECOVERY_FAILURE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn migration_recovery_failure() -> &'static Mutex<Option<String>> {
    MIGRATION_RECOVERY_FAILURE.get_or_init(|| Mutex::new(None))
}

fn set_migration_recovery_failure(error: Option<String>) {
    if let Ok(mut failure) = migration_recovery_failure().lock() {
        *failure = error;
    }
}

pub(crate) fn ensure_migration_recovered() -> Result<(), String> {
    let failure = migration_recovery_failure()
        .lock()
        .map_err(|_| "Migration recovery state is unavailable".to_string())?;
    if let Some(error) = failure.as_deref() {
        return Err(format!(
            "Protected storage is unavailable until vault migration recovery succeeds: {}",
            error
        ));
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(crate) struct SecurityConfig {
    pub initialized: bool,
    pub encryption_enabled: bool,
    pub salt: String,
    pub verifier: String,
    #[serde(default)]
    pub lock_timeout_minutes: u16,
    #[serde(default = "default_pbkdf2_iterations")]
    pub pbkdf2_iterations: u32,
    #[serde(default)]
    pub biometric_enrolled: bool,
    /// True once every file an earlier release may have left in plaintext has
    /// been adopted into this vault.
    ///
    /// Absent in configurations written before this release, which is exactly
    /// the population that can still hold legacy plaintext. Once the sweep
    /// completes, plaintext in a protected file is treated as tampering again.
    #[serde(default)]
    pub legacy_plaintext_adopted: bool,
    /// Keyed proof that the one-time plaintext adoption sweep completed.
    ///
    /// The compatibility boolean above is unauthenticated and is consulted only
    /// for configurations written before this field existed. Once present, this
    /// proof is authoritative and a local edit to the boolean cannot re-arm the
    /// migration.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub legacy_plaintext_adoption_proof: String,
}

/// Whether a protected file may legitimately still be plaintext.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyPlaintext {
    /// The file was written unprotected by an earlier release, so plaintext is
    /// expected until the one-time adoption sweep has run.
    Adopt,
    /// The file has always been encrypted when the vault is on, so plaintext
    /// means it was replaced and must not be trusted.
    Reject,
}

fn default_pbkdf2_iterations() -> u32 {
    PBKDF2_ITERATIONS
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct SecurityStatus {
    initialized: bool,
    encryption_enabled: bool,
    unlocked: bool,
    lock_timeout_minutes: u16,
    biometric_available: bool,
    biometric_enrolled: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct EncryptedPayload {
    v: u8,
    nonce: String,
    ciphertext: String,
    /// Truncated key verifier identifying which key produced this payload.
    ///
    /// Lets migration recovery tell an old-key payload from a new-key payload
    /// without possessing either key. Defaulted so payloads written before this
    /// field existed still decrypt.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    kv: String,
}

/// True when `raw` is shaped like an encrypted payload.
///
/// Used to detect ciphertext sitting behind a config that claims encryption is
/// off, which is the signature of a lost or reset `security.json`.
pub(crate) fn looks_encrypted(raw: &str) -> bool {
    let trimmed = raw.trim();
    if !trimmed.starts_with('{') {
        return false;
    }
    serde_json::from_str::<EncryptedPayload>(trimmed)
        .map(|payload| !payload.nonce.is_empty() && !payload.ciphertext.is_empty())
        .unwrap_or(false)
}

/// Key-check value for a key: the first bytes of its verifier, base64 encoded.
fn key_check_value(key: &[u8; KEY_LEN]) -> String {
    let verifier = key_verifier(key);
    B64.encode(&verifier[..KEY_CHECK_LEN])
}

/// Read the key-check value out of a payload without decrypting it.
fn payload_key_check(raw: &str) -> Option<String> {
    serde_json::from_str::<EncryptedPayload>(raw.trim())
        .ok()
        .map(|payload| payload.kv)
        .filter(|kv| !kv.is_empty())
}

/// The key-check value implied by a configuration's stored verifier.
///
/// `verifier` is the full `key_verifier(key)` and the key-check value is its
/// first bytes, so a configuration alone is enough to recognise payloads
/// belonging to its key — no password required. That is what lets migration
/// recovery validate staged files at startup.
fn config_key_check(config: &SecurityConfig) -> Option<String> {
    if !config.encryption_enabled {
        return None;
    }
    let verifier = B64.decode(&config.verifier).ok()?;
    if verifier.len() < KEY_CHECK_LEN {
        return None;
    }
    Some(B64.encode(&verifier[..KEY_CHECK_LEN]))
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).into()
}

fn key_state() -> &'static Mutex<KeyState> {
    KEY_STATE.get_or_init(|| {
        Mutex::new(KeyState {
            key: None,
            last_activity: None,
            lock_timeout_secs: 0,
        })
    })
}

/// Whether protected payloads can be read right now.
///
/// Distinguishes "this data is unusable" from "the vault happens to be locked",
/// which callers must never confuse: the second is temporary and says nothing
/// about the payload.
pub(crate) fn vault_is_readable(security: &SecurityConfig) -> bool {
    !security.encryption_enabled || is_unlocked()
}

fn is_unlocked() -> bool {
    let mut guard = match key_state().lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if guard.key.is_none() {
        return false;
    }
    if guard.lock_timeout_secs > 0 {
        if let Some(last) = guard.last_activity {
            if last.elapsed() >= Duration::from_secs(guard.lock_timeout_secs) {
                if let Some(ref mut k) = guard.key {
                    k.zeroize();
                }
                guard.key = None;
                guard.last_activity = None;
                return false;
            }
        }
    }
    true
}

pub(crate) fn set_unlocked_key(
    key: Option<[u8; KEY_LEN]>,
    lock_timeout_secs: u64,
) -> Result<(), String> {
    let mut guard = key_state()
        .lock()
        .map_err(|_| "Internal key state error".to_string())?;
    if let Some(ref mut old_key) = guard.key {
        old_key.zeroize();
    }
    guard.last_activity = if key.is_some() {
        Some(Instant::now())
    } else {
        None
    };
    guard.key = key;
    guard.lock_timeout_secs = lock_timeout_secs;
    Ok(())
}

/// Hand out the unlocked master key wrapped so callers cannot leak it.
///
/// Returning a bare `[u8; KEY_LEN]` used to place an unprotected copy of the
/// AES key on every caller's stack, outside the zeroizing discipline that
/// `KeyState` itself maintains.
pub(crate) fn require_unlocked_key() -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let mut guard = key_state()
        .lock()
        .map_err(|_| "Internal key state error".to_string())?;
    if guard.lock_timeout_secs > 0 {
        if let Some(last) = guard.last_activity {
            if last.elapsed() >= Duration::from_secs(guard.lock_timeout_secs) {
                if let Some(ref mut k) = guard.key {
                    k.zeroize();
                }
                guard.key = None;
                guard.last_activity = None;
            }
        }
    }
    let key = guard
        .key
        .ok_or_else(|| "Encrypted storage is locked. Unlock with your password.".to_string())?;
    guard.last_activity = Some(Instant::now());
    Ok(Zeroizing::new(key))
}

fn default_security_config() -> SecurityConfig {
    SecurityConfig {
        initialized: false,
        encryption_enabled: false,
        salt: String::new(),
        verifier: String::new(),
        lock_timeout_minutes: 0,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
        biometric_enrolled: false,
        // A configuration created now has no history, so there is nothing to
        // adopt and plaintext never has a legitimate explanation. Unencrypted
        // configurations have no key with which to create an adoption proof.
        legacy_plaintext_adopted: true,
        legacy_plaintext_adoption_proof: String::new(),
    }
}

pub(crate) fn load_security_config<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<SecurityConfig, String> {
    let path = security_path(app)?;
    if !path.exists() {
        return Ok(default_security_config());
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<SecurityConfig>(&raw) {
        Ok(config) => Ok(config),
        Err(e) => {
            let backup = path.with_extension("json.corrupt");
            let _ = std::fs::rename(&path, &backup);
            Err(format!(
                "Security config was corrupted and has been backed up to '{}'. Please restart the app. ({})",
                backup.display(),
                e
            ))
        }
    }
}

pub(crate) fn save_security_config<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    config: &SecurityConfig,
) -> Result<(), String> {
    let path = security_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

/// Validate the key-derivation parameters read from disk before using them.
fn validate_kdf_params(config: &SecurityConfig) -> Result<Vec<u8>, String> {
    if config.pbkdf2_iterations < MIN_PBKDF2_ITERATIONS {
        return Err(
            "Security configuration appears corrupted (iteration count too low). Please reset security.".to_string(),
        );
    }
    if config.pbkdf2_iterations > MAX_PBKDF2_ITERATIONS {
        return Err(format!(
            "Security configuration appears corrupted (iteration count above the {} maximum). Please reset security.",
            MAX_PBKDF2_ITERATIONS
        ));
    }
    let salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    if salt.len() != SALT_LEN {
        return Err(
            "Security configuration appears corrupted (unexpected salt length). Please reset security."
                .to_string(),
        );
    }
    Ok(salt)
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut *key);
    key
}

pub(crate) fn key_verifier(key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"s3-sidekick-vault-verifier");
    let digest = hasher.finalize();
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&digest[..KEY_LEN]);
    out
}

fn legacy_plaintext_adoption_proof(key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"s3-sidekick-legacy-plaintext-adopted-v1");
    let digest = hasher.finalize();
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&digest[..KEY_LEN]);
    out
}

/// Return the authenticated adoption state for an already-verified vault key.
///
/// Configurations from earlier releases have no proof and bootstrap from the
/// old boolean exactly once. A present proof is authoritative: changing or
/// clearing only the boolean cannot re-enable plaintext adoption.
fn legacy_plaintext_adoption_completed(
    config: &SecurityConfig,
    key: &[u8; KEY_LEN],
) -> Result<bool, String> {
    if !config.encryption_enabled {
        return Ok(true);
    }
    if config.legacy_plaintext_adoption_proof.is_empty() {
        return Ok(config.legacy_plaintext_adopted);
    }

    let stored = B64
        .decode(&config.legacy_plaintext_adoption_proof)
        .map_err(|_| {
            "Security configuration has an invalid legacy-adoption proof; plaintext migration was refused."
                .to_string()
        })?;
    let mut expected = legacy_plaintext_adoption_proof(key);
    let valid = constant_time_eq(&stored, &expected);
    expected.zeroize();
    if !valid {
        return Err(
            "Security configuration has an invalid legacy-adoption proof; plaintext migration was refused."
                .to_string(),
        );
    }
    Ok(true)
}

fn adoption_proof_string(key: &[u8; KEY_LEN]) -> String {
    let mut proof = legacy_plaintext_adoption_proof(key);
    let encoded = B64.encode(proof);
    proof.zeroize();
    encoded
}

pub(crate) fn encrypt_text(plain: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let payload = EncryptedPayload {
        v: 1,
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
        kv: key_check_value(key),
    };
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

pub(crate) fn decrypt_text(encoded: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
    let payload: EncryptedPayload =
        serde_json::from_str(encoded).map_err(|e| format!("Invalid encrypted payload: {}", e))?;
    if payload.v != 1 {
        return Err("Unsupported encrypted payload version".to_string());
    }

    let nonce_bytes = B64
        .decode(payload.nonce)
        .map_err(|e| format!("Invalid nonce encoding: {}", e))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("Invalid nonce length".to_string());
    }
    let ciphertext = B64
        .decode(payload.ciphertext)
        .map_err(|e| format!("Invalid ciphertext encoding: {}", e))?;

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plain = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Invalid password or corrupted encrypted data".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("Decrypted data is not valid UTF-8: {}", e))
}

pub(crate) fn read_protected_file(
    path: &std::path::Path,
    default_value: &str,
    security: &SecurityConfig,
) -> Result<String, String> {
    read_protected_file_with_legacy(path, default_value, security, LegacyPlaintext::Reject)
}

pub(crate) fn read_protected_file_with_legacy(
    path: &std::path::Path,
    default_value: &str,
    security: &SecurityConfig,
    legacy: LegacyPlaintext,
) -> Result<String, String> {
    ensure_migration_recovered()?;
    let raw = match std::fs::read_to_string(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default_value.to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    if !security.encryption_enabled {
        // Fail closed. Ciphertext behind a config that says encryption is off
        // means the key material was lost (reset, corrupted, or restored from a
        // partial backup). Returning the raw payload would let the frontend
        // parse it as garbage, fall back to defaults, and then overwrite the
        // only copy of the data on the next save.
        if looks_encrypted(&raw) {
            return Err(format!(
                "'{}' is still encrypted but the current configuration has no key material. \
                 This happens when 'security.json' was reset or replaced, or when disabling \
                 encryption was interrupted. Restore the matching 'security.json' (or \
                 'security.json.corrupt') to recover it, or delete this file to start fresh.",
                path.display()
            ));
        }
        return Ok(raw);
    }

    // Require the key before anything is returned, so a locked vault never
    // serves protected content — legacy or not.
    let key = require_unlocked_key()?;

    // Accept a plaintext payload only where an upgrade can explain it: a file an
    // earlier release wrote in the clear, and only until the one-time adoption
    // sweep has completed. The keyed proof, when present, is authoritative over
    // the legacy plaintext boolean in security.json.
    let adoption_completed = legacy_plaintext_adoption_completed(security, &key)?;
    if !looks_encrypted(&raw) && legacy == LegacyPlaintext::Adopt && !adoption_completed {
        return Ok(raw);
    }

    decrypt_text(&raw, &key)
}

/// Bring files an earlier version left in plaintext under the active vault.
///
/// Runs once per unlock, before any migration, so that rekeying, enabling or
/// disabling encryption, factory reset, checkpoint GC and download resume all
/// see a consistently encrypted vault. Every write is atomic and idempotent, so
/// an interruption simply leaves the remaining files for the next unlock.
pub(crate) fn adopt_legacy_plaintext_files<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    config: &mut SecurityConfig,
) -> Result<(), String> {
    if !config.encryption_enabled {
        return Ok(());
    }

    let key = require_unlocked_key()?;
    if legacy_plaintext_adoption_completed(config, &key)? {
        // Bootstrap old completed configurations into authenticated state. If
        // only the old boolean was tampered after a proof was written, the valid
        // proof wins and no plaintext sweep is re-opened.
        if config.legacy_plaintext_adoption_proof.is_empty() {
            let _ = mark_legacy_plaintext_adopted(app, config, &key);
        } else {
            config.legacy_plaintext_adopted = true;
        }
        return Ok(());
    }

    // Only files an earlier release wrote unprotected can be legacy plaintext,
    // and all of them hold recreatable state. No failure here may block unlock:
    // a file that cannot be adopted stays plaintext, where the tolerated read
    // path still handles it, and the sweep is not recorded as complete so the
    // next unlock tries again. Refusing to unlock instead would turn one
    // read-only file into the loss of the entire vault.
    let mut pending = false;
    let mut paths = Vec::new();
    for id in LEGACY_PLAINTEXT_CAPABLE_FILES {
        match managed_data_file(app, *id) {
            Ok((path, _)) => paths.push(path),
            Err(_) => pending = true,
        }
    }
    match crate::transfer_checkpoint_files(app) {
        Ok(checkpoints) => paths.extend(checkpoints),
        Err(_) => pending = true,
    }

    for path in paths {
        match plaintext_needing_adoption(&path) {
            Ok(None) => {}
            Ok(Some(raw)) => {
                if write_protected_file(&path, &raw, config).is_err() {
                    pending = true;
                }
            }
            Err(_) => pending = true,
        }
    }

    if !pending {
        // The sweep itself succeeded. If only bookkeeping fails, leave the old
        // pending state in memory and on disk so the idempotent sweep retries.
        let _ = mark_legacy_plaintext_adopted(app, config, &key);
    }
    Ok(())
}

/// Record, with a proof derived from the unlocked vault key, that no file can
/// still be legitimately plaintext.
fn mark_legacy_plaintext_adopted<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    config: &mut SecurityConfig,
    key: &[u8; KEY_LEN],
) -> Result<(), String> {
    let mut updated = config.clone();
    updated.legacy_plaintext_adopted = true;
    updated.legacy_plaintext_adoption_proof = adoption_proof_string(key);
    save_security_config(app, &updated)?;
    *config = updated;
    Ok(())
}

/// Files that an earlier release wrote without encryption.
const LEGACY_PLAINTEXT_CAPABLE_FILES: &[ManagedDataId] = &[ManagedDataId::TransferManifest];

fn plaintext_needing_adoption(path: &std::path::Path) -> Result<Option<String>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(format!(
                "Failed to inspect '{}' while upgrading vault storage: {}",
                path.display(),
                err
            ))
        }
    };
    if raw.trim().is_empty() || looks_encrypted(&raw) {
        return Ok(None);
    }
    Ok(Some(raw))
}

pub(crate) fn write_protected_file(
    path: &std::path::Path,
    json: &str,
    security: &SecurityConfig,
) -> Result<(), String> {
    ensure_migration_recovered()?;
    let output = if security.encryption_enabled {
        let key = require_unlocked_key()?;
        encrypt_text(json, &key)?
    } else {
        json.to_string()
    };

    atomic_write(path, &output)
}

struct MigrationPlan {
    id: ManagedDataId,
    path: std::path::PathBuf,
    staged: std::path::PathBuf,
    transformed: String,
}

/// Identity of a vault configuration, used to decide whether an interrupted
/// migration had reached its commit point.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct ConfigFingerprint {
    encryption_enabled: bool,
    salt: String,
    verifier: String,
}

fn fingerprint(config: &SecurityConfig) -> ConfigFingerprint {
    ConfigFingerprint {
        encryption_enabled: config.encryption_enabled,
        salt: config.salt.clone(),
        verifier: config.verifier.clone(),
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ManagedDataId {
    Bookmarks,
    Connection,
    BookmarksBackup,
    TransferManifest,
}

impl ManagedDataId {
    /// Whether losing this file costs the user data they cannot recreate.
    ///
    /// The transfer manifest only describes queued and resumable transfers, so
    /// discarding it restarts those transfers. Bookmarks, saved connections and
    /// the bookmarks backup are user data and must never be discarded silently.
    fn is_disposable(self) -> bool {
        matches!(self, Self::TransferManifest)
    }

    fn stage_name(self) -> &'static str {
        match self {
            Self::Bookmarks => ".security-migration-bookmarks.stage",
            Self::Connection => ".security-migration-connection.stage",
            Self::BookmarksBackup => ".security-migration-bookmarks-backup.stage",
            Self::TransferManifest => ".security-migration-transfer-manifest.stage",
        }
    }
}

/// Write-ahead record of an in-flight vault migration.
///
/// Holds no key material and no plaintext: recovery only needs to know which
/// staged files belong to which destinations, and whether the configuration on
/// disk is still the pre-migration one.
#[derive(serde::Serialize, serde::Deserialize)]
struct MigrationJournal {
    v: u8,
    previous: ConfigFingerprint,
    target: SecurityConfig,
    entries: Vec<ManagedDataId>,
    #[serde(default)]
    checkpoint_scratch_paths: Vec<String>,
}

/// Durable intent record for a factory reset.
///
/// Once this file reaches disk, recovery always finishes the reset. This makes
/// deletion, the security/settings commits, checkpoint cleanup, and biometric
/// key removal one retryable transaction instead of a sequence that can stop in
/// an irreversibly mixed state.
#[derive(serde::Serialize, serde::Deserialize)]
struct FactoryResetJournal {
    v: u8,
    settings_json: String,
    entries: Vec<ManagedDataId>,
    checkpoint_scratch_paths: Vec<String>,
}

fn factory_reset_journal_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let migration_journal = security_journal_path(app)?;
    let parent = migration_journal
        .parent()
        .ok_or_else(|| "Security journal has no parent directory".to_string())?;
    Ok(parent.join("factory-reset.journal"))
}

/// Every file whose contents follow the vault's encryption state.
///
/// Any path that is read or written through `read_protected_file` /
/// `write_protected_file` must appear here, otherwise enabling, disabling, or
/// rekeying the vault leaves it encrypted under a key that no longer exists.
/// `migration_invariant_covers_all_protected_files` guards this.
fn managed_data_file<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    id: ManagedDataId,
) -> Result<(std::path::PathBuf, &'static str), String> {
    match id {
        ManagedDataId::Bookmarks => Ok((bookmarks_path(app)?, "[]")),
        ManagedDataId::Connection => Ok((connection_path(app)?, "")),
        ManagedDataId::BookmarksBackup => Ok((bookmarks_backup_path(app)?, "[]")),
        ManagedDataId::TransferManifest => Ok((transfer_manifest_path(app)?, "")),
    }
}

fn migration_stage_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    id: ManagedDataId,
) -> Result<std::path::PathBuf, String> {
    let journal = security_journal_path(app)?;
    let parent = journal
        .parent()
        .ok_or_else(|| "Security journal has no parent directory".to_string())?;
    Ok(parent.join(id.stage_name()))
}

fn managed_data_files<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<Vec<(ManagedDataId, std::path::PathBuf, &'static str)>, String> {
    [
        ManagedDataId::Bookmarks,
        ManagedDataId::Connection,
        ManagedDataId::BookmarksBackup,
        ManagedDataId::TransferManifest,
    ]
    .into_iter()
    .map(|id| {
        let (path, default_value) = managed_data_file(app, id)?;
        Ok((id, path, default_value))
    })
    .collect()
}

fn build_migration_plans<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    enable_encryption: bool,
    key: &[u8; KEY_LEN],
) -> Result<Vec<MigrationPlan>, String> {
    let mut plans = Vec::new();

    for (id, path, default_value) in managed_data_files(app)? {
        if !path.exists() {
            continue;
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let already_encrypted = looks_encrypted(&raw);
        let next = if enable_encryption {
            if already_encrypted && id.is_disposable() {
                // Recovery state, not user data. A stale encrypted copy left by
                // an interrupted disable would otherwise block enabling
                // encryption at all, so discard it and start from the default.
                encrypt_text(default_value, key)?
            } else if already_encrypted {
                return Err(format!(
                    "Refusing to enable encryption because '{}' still holds ciphertext from a \
                     previous vault whose key is gone (the current configuration says encryption \
                     is off). Restore the matching 'security.json', or reset security and confirm \
                     deleting that file, then enable encryption again.",
                    path.display()
                ));
            } else {
                encrypt_text(&raw, key)?
            }
        } else if raw.trim().is_empty() {
            default_value.to_string()
        } else if !already_encrypted {
            // Already plaintext. Skip instead of attempting to decrypt it,
            // which would fail and wedge the whole operation.
            continue;
        } else {
            decrypt_text(&raw, key)?
        };

        plans.push(MigrationPlan {
            id,
            staged: migration_stage_path(app, id)?,
            path,
            transformed: next,
        });
    }

    Ok(plans)
}

fn build_rekey_plans<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    old_key: &[u8; KEY_LEN],
    new_key: &[u8; KEY_LEN],
    legacy_plaintext_allowed: bool,
) -> Result<Vec<MigrationPlan>, String> {
    let mut plans = Vec::new();

    for (id, path, _) in managed_data_files(app)? {
        if !path.exists() {
            continue;
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let plain = if raw.trim().is_empty() {
            String::new()
        } else if looks_encrypted(&raw) {
            decrypt_text(&raw, old_key)?
        } else if legacy_plaintext_allowed && LEGACY_PLAINTEXT_CAPABLE_FILES.contains(&id) {
            // A managed file can legitimately be plaintext inside an encrypted
            // vault: upgrades add files to the managed set that earlier versions
            // wrote unencrypted (the transfer manifest is one). Attempting to
            // decrypt those used to fail and made rekeying impossible, so adopt
            // them into the vault under the new key instead. The same scope and
            // one-shot marker as the read path apply, so this cannot be used to
            // launder plaintext that a read would reject.
            raw.clone()
        } else {
            return Err(format!(
                "'{}' holds unencrypted data inside an encrypted vault, so it cannot be \
                 re-keyed. Restore the file from a backup, or delete it to start fresh.",
                path.display()
            ));
        };
        let next = encrypt_text(&plain, new_key)?;

        plans.push(MigrationPlan {
            id,
            staged: migration_stage_path(app, id)?,
            path,
            transformed: next,
        });
    }

    Ok(plans)
}

/// Write every transformed payload to its staging file and flush it to disk.
fn stage_migration(plans: &[MigrationPlan]) -> Result<(), String> {
    for plan in plans {
        atomic_write(&plan.staged, &plan.transformed)?;
    }
    Ok(())
}

fn discard_staged(plans: &[MigrationPlan]) {
    for plan in plans {
        let _ = std::fs::remove_file(&plan.staged);
    }
}

/// Move staged payloads over their destinations.
fn commit_staged(plans: &[MigrationPlan]) -> Result<(), String> {
    for plan in plans {
        if !plan.staged.exists() {
            continue;
        }
        std::fs::rename(&plan.staged, &plan.path).map_err(|e| {
            format!(
                "Failed to publish migrated file '{}': {}",
                plan.path.display(),
                e
            )
        })?;
        fsync_parent(&plan.path)?;
    }
    Ok(())
}

fn migrated_payload_matches(
    path: &std::path::Path,
    target: &SecurityConfig,
) -> Result<bool, String> {
    let raw = std::fs::read_to_string(path).map_err(|err| {
        format!(
            "Failed to inspect migrated file '{}': {}",
            path.display(),
            err
        )
    })?;
    if target.encryption_enabled {
        let Some(expected) = config_key_check(target) else {
            return Err("Target security configuration has no valid key check".to_string());
        };
        Ok(payload_key_check(&raw).as_deref() == Some(expected.as_str()))
    } else {
        Ok(!looks_encrypted(&raw))
    }
}

/// Perform a vault migration so that no crash can lose data.
fn run_migration<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    plans: &[MigrationPlan],
    previous: &SecurityConfig,
    target: &SecurityConfig,
) -> Result<(), String> {
    let journal_path = security_journal_path(app)?;
    let checkpoint_scratch_paths = collect_transfer_checkpoint_scratch_paths(app, previous)?;

    if let Err(err) = stage_migration(plans) {
        discard_staged(plans);
        return Err(err);
    }

    let journal = MigrationJournal {
        v: 2,
        previous: fingerprint(previous),
        target: target.clone(),
        entries: plans.iter().map(|plan| plan.id).collect(),
        checkpoint_scratch_paths,
    };
    let journal_json = match serde_json::to_string_pretty(&journal) {
        Ok(json) => json,
        Err(err) => {
            discard_staged(plans);
            return Err(err.to_string());
        }
    };
    if let Err(err) = atomic_write(&journal_path, &journal_json) {
        discard_staged(plans);
        return Err(err);
    }

    // Commit point. `atomic_write` renames before syncing the parent directory,
    // so an error does not necessarily mean the target config was not written.
    // Only discard recovery evidence when the on-disk config is provably still
    // the previous one; otherwise leave the journal/stages intact and fail
    // closed so startup can decide which side survived the crash.
    if let Err(err) = save_security_config(app, target) {
        match load_security_config(app) {
            Ok(current) if fingerprint(&current) == fingerprint(previous) => {
                discard_staged(plans);
                if let Err(cleanup_error) = remove_file_if_present(&journal_path) {
                    set_migration_recovery_failure(Some(cleanup_error.clone()));
                    return Err(format!(
                        "{}. The old vault configuration is intact, but its uncommitted journal could not be removed: {}",
                        err, cleanup_error
                    ));
                }
                return Err(err);
            }
            Ok(current) if fingerprint(&current) == fingerprint(target) => {
                let recovery_error = format!(
                    "Vault configuration may have committed but its directory sync failed: {}. Migration journal and staging were retained for recovery",
                    err
                );
                set_migration_recovery_failure(Some(recovery_error.clone()));
                let _ = set_unlocked_key(None, 0);
                return Err(recovery_error);
            }
            Ok(_) => {
                let recovery_error = format!(
                    "Vault configuration is neither the previous nor target state after a failed commit: {}. Migration journal and staging were retained",
                    err
                );
                set_migration_recovery_failure(Some(recovery_error.clone()));
                let _ = set_unlocked_key(None, 0);
                return Err(recovery_error);
            }
            Err(inspect_error) => {
                let recovery_error = format!(
                    "Vault configuration commit failed and its on-disk state could not be verified: {} (inspection failed: {}). Migration journal and staging were retained",
                    err, inspect_error
                );
                set_migration_recovery_failure(Some(recovery_error.clone()));
                let _ = set_unlocked_key(None, 0);
                return Err(recovery_error);
            }
        }
    }

    if let Err(publish_error) = commit_staged(plans) {
        // Try to complete immediately while the old key is still available for
        // any remaining cleanup. If that also fails, recovery remains journaled
        // and all protected I/O is blocked; never continue with a target config
        // and a stale in-memory key.
        if let Err(recovery_error) = recover_interrupted_migration(app) {
            let _ = set_unlocked_key(None, 0);
            return Err(format!(
                "{}. Immediate vault recovery also failed: {}",
                publish_error, recovery_error
            ));
        }
        return Ok(());
    }

    if let Err(cleanup_error) = purge_transfer_checkpoints(app, &journal.checkpoint_scratch_paths) {
        set_migration_recovery_failure(Some(cleanup_error.clone()));
        let _ = set_unlocked_key(None, 0);
        return Err(format!(
            "Vault data was migrated, but checkpoint cleanup failed and protected I/O has been blocked: {}",
            cleanup_error
        ));
    }

    if let Err(err) = std::fs::remove_file(&journal_path).map_err(|err| err.to_string()) {
        set_migration_recovery_failure(Some(err.clone()));
        let _ = set_unlocked_key(None, 0);
        return Err(format!(
            "Vault migration committed, but its recovery journal could not be removed: {}",
            err
        ));
    }
    if let Err(err) = fsync_parent(&journal_path) {
        set_migration_recovery_failure(Some(err.clone()));
        let _ = set_unlocked_key(None, 0);
        return Err(format!(
            "Vault migration committed, but journal cleanup was not durable: {}",
            err
        ));
    }
    set_migration_recovery_failure(None);
    Ok(())
}

fn run_biometric_invalidating_migration<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    plans: &[MigrationPlan],
    previous: &SecurityConfig,
    target: &SecurityConfig,
) -> Result<(), String> {
    // A failed migration restores `biometric_enrolled = true`, and in that case
    // the retained credential is still the one the committed config describes.
    crate::biometric::journal_cleanup_unless_enrolled(app)?;
    let migration_result = run_migration(app, plans, previous, target);

    if let Err(migration_error) = migration_result {
        let journal_pending = security_journal_path(app)
            .map(|path| path.exists())
            .map_err(|path_error| {
                format!(
                    "{}. Biometric cleanup intent was retained because migration state could not be inspected: {}",
                    migration_error, path_error
                )
            })?;
        if journal_pending {
            return Err(migration_error);
        }

        return match recover_interrupted_migration(app) {
            Ok(()) => Err(migration_error),
            Err(cleanup_error) => {
                let _ = set_unlocked_key(None, 0);
                Err(format!(
                    "{}. Biometric cleanup recovery also failed: {}",
                    migration_error, cleanup_error
                ))
            }
        };
    }

    if let Err(cleanup_error) = recover_interrupted_migration(app) {
        let _ = set_unlocked_key(None, 0);
        return Err(format!(
            "Vault migration committed, but biometric cleanup failed: {}",
            cleanup_error
        ));
    }
    Ok(())
}

fn recover_interrupted_migration_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    let journal_path = security_journal_path(app)?;
    if !journal_path.exists() {
        return Ok(());
    }

    let raw = std::fs::read_to_string(&journal_path).map_err(|err| err.to_string())?;
    let journal: MigrationJournal = serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Vault migration journal '{}' is unreadable; it and all staging files were retained: {}",
            journal_path.display(),
            err
        )
    })?;
    if journal.v != 2 {
        return Err(format!(
            "Unsupported vault migration journal version {}; journal retained",
            journal.v
        ));
    }

    let current = load_security_config(app)?;
    let current_fingerprint = fingerprint(&current);
    let committed = current_fingerprint == fingerprint(&journal.target);
    let uncommitted = current_fingerprint == journal.previous;
    if !committed && !uncommitted {
        return Err(
            "Security configuration matches neither side of the pending vault migration; journal retained"
                .to_string(),
        );
    }

    if committed {
        for id in &journal.entries {
            let (path, _) = managed_data_file(app, *id)?;
            let staged = migration_stage_path(app, *id)?;
            if staged.is_file() {
                if !migrated_payload_matches(&staged, &journal.target)? {
                    return Err(format!(
                        "Refusing to publish '{}': staged payload does not match the committed vault configuration",
                        path.display()
                    ));
                }
                std::fs::rename(&staged, &path).map_err(|err| {
                    format!(
                        "Failed to complete vault migration for '{}': {}",
                        path.display(),
                        err
                    )
                })?;
                fsync_parent(&path)?;
            } else if !path.is_file() || !migrated_payload_matches(&path, &journal.target)? {
                return Err(format!(
                    "Vault migration staging for '{}' is missing and the destination is not in the committed state",
                    path.display()
                ));
            }
        }
        purge_transfer_checkpoints(app, &journal.checkpoint_scratch_paths)?;
    } else {
        // The commit point was never reached, so originals must stay intact.
        for id in &journal.entries {
            let staged = migration_stage_path(app, *id)?;
            match std::fs::remove_file(&staged) {
                Ok(()) => fsync_parent(&staged)?,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!(
                        "Failed to discard uncommitted migration stage '{}': {}",
                        staged.display(),
                        err
                    ));
                }
            }
        }
    }

    std::fs::remove_file(&journal_path).map_err(|err| err.to_string())?;
    fsync_parent(&journal_path)?;
    Ok(())
}

/// Finish or unwind a migration interrupted by a crash or power loss, then
/// finish any factory reset whose durable intent was recorded. Any failure
/// remains latched and blocks protected reads/writes until a later retry
/// succeeds.
pub(crate) fn recover_interrupted_migration<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    // Credential cleanup has no ordering dependency on file recovery, so it must
    // not be skipped when an unrelated replay fails. It still runs last, because
    // migration replay is what decides whether the committed configuration still
    // claims enrollment, and it can only ever remove a key the config says is
    // unwanted. Errors are aggregated so no attempt masks another.
    let mut errors = Vec::new();
    let file_recovery = recover_interrupted_migration_inner(app)
        .and_then(|()| recover_interrupted_factory_reset_inner(app));
    if let Err(error) = file_recovery {
        errors.push(error);
    }
    if let Err(error) = crate::biometric::recover_pending_biometric_cleanup(app) {
        errors.push(error);
    }
    let result = if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    };
    match &result {
        Ok(()) => set_migration_recovery_failure(None),
        Err(error) => set_migration_recovery_failure(Some(error.clone())),
    }
    result
}

pub(crate) fn security_status(config: &SecurityConfig) -> SecurityStatus {
    SecurityStatus {
        initialized: config.initialized,
        encryption_enabled: config.encryption_enabled,
        unlocked: is_unlocked(),
        lock_timeout_minutes: config.lock_timeout_minutes,
        biometric_available: crate::biometric::is_available(),
        biometric_enrolled: config.biometric_enrolled,
    }
}

/// Run a vault operation off the async executor.
///
/// Every one of these commands performs a PBKDF2 derivation (600,000 HMAC
/// rounds by default) and holds the blocking storage mutex. Doing that directly
/// inside an async command body stalls a Tokio worker for the duration; moving
/// the whole body onto the blocking pool keeps the runtime responsive and keeps
/// the `MutexGuard` from ever crossing an await point.
async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(err) => Err(format!("Security task failed: {}", err)),
    }
}

#[tauri::command]
pub(crate) async fn get_security_status(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    run_blocking(move || {
        let _storage_guard = lock_storage_ops()?;
        let config = load_security_config(&app)?;
        Ok(security_status(&config))
    })
    .await
}

#[tauri::command]
pub(crate) async fn initialize_security(
    app: tauri::AppHandle,
    enable_encryption: bool,
    password: Option<String>,
) -> Result<SecurityStatus, String> {
    run_blocking(move || initialize_security_inner(&app, enable_encryption, password)).await
}

fn initialize_security_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    enable_encryption: bool,
    password: Option<String>,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    let current = load_security_config(app)?;
    if current.initialized {
        return Ok(security_status(&current));
    }

    if !enable_encryption {
        let config = SecurityConfig {
            initialized: true,
            encryption_enabled: false,
            salt: String::new(),
            verifier: String::new(),
            lock_timeout_minutes: 0,
            pbkdf2_iterations: 0,
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: String::new(),
        };
        set_unlocked_key(None, 0)?;
        save_security_config(app, &config)?;
        return Ok(security_status(&config));
    }

    let mut pw = password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Password is required to enable encryption".to_string())?;
    if let Err(err) = validate_password_length(&pw) {
        pw.zeroize();
        return Err(err);
    }
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
    pw.zeroize();
    let mut verifier = key_verifier(&key);

    let config = SecurityConfig {
        initialized: true,
        encryption_enabled: true,
        salt: B64.encode(salt),
        verifier: B64.encode(verifier),
        lock_timeout_minutes: 0,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
        biometric_enrolled: false,
        // A vault created now has no unprotected history to adopt.
        legacy_plaintext_adopted: true,
        legacy_plaintext_adoption_proof: adoption_proof_string(&key),
    };
    verifier.zeroize();

    let plans = build_migration_plans(app, true, &key)?;
    run_migration(app, &plans, &current, &config)?;

    set_unlocked_key(Some(*key), 0)?;
    Ok(security_status(&config))
}

fn validate_password_length(password: &str) -> Result<(), String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    if password.len() > 256 {
        return Err("Password must be at most 256 characters".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn unlock_security(
    app: tauri::AppHandle,
    password: String,
) -> Result<SecurityStatus, String> {
    run_blocking(move || unlock_security_inner(&app, password)).await
}

fn unlock_security_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    mut password: String,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let mut config = load_security_config(app)?;
    if !config.initialized || !config.encryption_enabled {
        password.zeroize();
        set_unlocked_key(None, 0)?;
        return Ok(security_status(&config));
    }

    let salt = match validate_kdf_params(&config) {
        Ok(salt) => salt,
        Err(err) => {
            password.zeroize();
            return Err(err);
        }
    };
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if expected_verifier.len() != KEY_LEN {
        password.zeroize();
        return Err("Invalid security verifier length".to_string());
    }

    let key = derive_key(&password, &salt, config.pbkdf2_iterations);
    let mut verifier = key_verifier(&key);
    if !constant_time_eq(verifier.as_slice(), expected_verifier.as_slice()) {
        verifier.zeroize();
        password.zeroize();
        return Err("Invalid password".to_string());
    }
    verifier.zeroize();

    let timeout_secs = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(*key), timeout_secs)?;
    if let Err(err) = recover_interrupted_migration(app) {
        let _ = set_unlocked_key(None, 0);
        password.zeroize();
        return Err(err);
    }

    // Must precede the rekey below: a migration reads every managed file and
    // checkpoint, so any file an earlier version left in plaintext has to be
    // adopted before that read happens.
    if let Err(err) = adopt_legacy_plaintext_files(app, &mut config) {
        let _ = set_unlocked_key(None, 0);
        password.zeroize();
        return Err(err);
    }

    if config.pbkdf2_iterations < PBKDF2_ITERATIONS {
        let previous = config.clone();
        let mut new_salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(&password, &new_salt, PBKDF2_ITERATIONS);
        let mut new_verifier = key_verifier(&new_key);

        let legacy_plaintext_allowed = match legacy_plaintext_adoption_completed(&config, &key) {
            Ok(completed) => !completed,
            Err(err) => {
                new_verifier.zeroize();
                password.zeroize();
                return Err(err);
            }
        };
        let plans = match build_rekey_plans(app, &key, &new_key, legacy_plaintext_allowed) {
            Ok(plans) => plans,
            Err(err) => {
                new_verifier.zeroize();
                password.zeroize();
                return Err(err);
            }
        };

        config.salt = B64.encode(new_salt);
        config.verifier = B64.encode(new_verifier);
        new_verifier.zeroize();
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        config.biometric_enrolled = false;
        // Every managed file is rewritten and every checkpoint purged by the
        // migration below, so nothing can still be legitimately plaintext.
        config.legacy_plaintext_adopted = true;
        config.legacy_plaintext_adoption_proof = adoption_proof_string(&new_key);

        if let Err(err) = run_biometric_invalidating_migration(app, &plans, &previous, &config) {
            password.zeroize();
            return Err(err);
        }

        set_unlocked_key(Some(*new_key), timeout_secs)?;
    }
    password.zeroize();

    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn set_security_encryption(
    app: tauri::AppHandle,
    enable_encryption: bool,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<SecurityStatus, String> {
    run_blocking(move || {
        set_security_encryption_inner(&app, enable_encryption, current_password, new_password)
    })
    .await
}

fn set_security_encryption_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    enable_encryption: bool,
    mut current_password: Option<String>,
    mut new_password: Option<String>,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    let mut config = load_security_config(app)?;
    if !config.initialized {
        return Err("Security is not initialized".to_string());
    }
    if config.encryption_enabled == enable_encryption {
        return Ok(security_status(&config));
    }
    let previous = config.clone();

    if enable_encryption {
        let mut pw = new_password
            .take()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "New password is required".to_string())?;
        if let Err(err) = validate_password_length(&pw) {
            pw.zeroize();
            return Err(err);
        }
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
        pw.zeroize();
        let mut verifier = key_verifier(&key);

        let plans = build_migration_plans(app, true, &key)?;
        config.encryption_enabled = true;
        config.salt = B64.encode(salt);
        config.verifier = B64.encode(verifier);
        verifier.zeroize();
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        config.legacy_plaintext_adopted = true;
        config.legacy_plaintext_adoption_proof = adoption_proof_string(&key);

        run_migration(app, &plans, &previous, &config)?;

        set_unlocked_key(Some(*key), config.lock_timeout_minutes as u64 * 60)?;
        return Ok(security_status(&config));
    }

    let mut current_password = current_password
        .take()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Current password is required".to_string())?;
    let salt = match validate_kdf_params(&config) {
        Ok(salt) => salt,
        Err(err) => {
            current_password.zeroize();
            return Err(err);
        }
    };
    let key = derive_key(&current_password, &salt, config.pbkdf2_iterations);
    current_password.zeroize();
    let mut verifier = key_verifier(&key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if !constant_time_eq(verifier.as_slice(), expected_verifier.as_slice()) {
        verifier.zeroize();
        return Err("Invalid password".to_string());
    }
    verifier.zeroize();

    let plans = build_migration_plans(app, false, &key)?;
    drop(key);

    config.encryption_enabled = false;
    config.salt.clear();
    config.verifier.clear();
    config.biometric_enrolled = false;
    config.legacy_plaintext_adopted = true;
    config.legacy_plaintext_adoption_proof.clear();

    run_biometric_invalidating_migration(app, &plans, &previous, &config)?;

    set_unlocked_key(None, 0)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn change_security_password(
    app: tauri::AppHandle,
    current_password: String,
    new_password: String,
) -> Result<SecurityStatus, String> {
    run_blocking(move || change_security_password_inner(&app, current_password, new_password)).await
}

fn change_security_password_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    mut current_password: String,
    mut new_password: String,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    let mut config = load_security_config(app)?;
    if !config.initialized || !config.encryption_enabled {
        current_password.zeroize();
        new_password.zeroize();
        return Err("Encryption is not enabled".to_string());
    }
    if let Err(err) = validate_password_length(&new_password) {
        current_password.zeroize();
        new_password.zeroize();
        return Err(err);
    }
    let previous = config.clone();

    let old_salt = match validate_kdf_params(&config) {
        Ok(salt) => salt,
        Err(err) => {
            current_password.zeroize();
            new_password.zeroize();
            return Err(err);
        }
    };
    let old_key = derive_key(&current_password, &old_salt, config.pbkdf2_iterations);
    current_password.zeroize();
    let mut old_verifier = key_verifier(&old_key);
    let expected_verifier = match B64.decode(&config.verifier) {
        Ok(value) => value,
        Err(e) => {
            old_verifier.zeroize();
            new_password.zeroize();
            return Err(format!("Invalid security verifier: {}", e));
        }
    };
    if !constant_time_eq(old_verifier.as_slice(), expected_verifier.as_slice()) {
        old_verifier.zeroize();
        new_password.zeroize();
        return Err("Invalid password".to_string());
    }
    old_verifier.zeroize();

    let mut new_salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut new_salt);
    let new_key = derive_key(&new_password, &new_salt, PBKDF2_ITERATIONS);
    new_password.zeroize();
    let mut new_verifier = key_verifier(&new_key);

    let legacy_plaintext_allowed = match legacy_plaintext_adoption_completed(&config, &old_key) {
        Ok(completed) => !completed,
        Err(err) => {
            new_verifier.zeroize();
            return Err(err);
        }
    };
    let plans = match build_rekey_plans(app, &old_key, &new_key, legacy_plaintext_allowed) {
        Ok(plans) => plans,
        Err(err) => {
            new_verifier.zeroize();
            return Err(err);
        }
    };
    drop(old_key);

    config.salt = B64.encode(new_salt);
    config.verifier = B64.encode(new_verifier);
    new_verifier.zeroize();
    config.pbkdf2_iterations = PBKDF2_ITERATIONS;
    config.biometric_enrolled = false;
    config.legacy_plaintext_adopted = true;
    config.legacy_plaintext_adoption_proof = adoption_proof_string(&new_key);

    run_biometric_invalidating_migration(app, &plans, &previous, &config)?;

    set_unlocked_key(Some(*new_key), config.lock_timeout_minutes as u64 * 60)?;

    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn lock_security(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    run_blocking(move || {
        let _storage_guard = lock_storage_ops()?;
        let config = load_security_config(&app)?;
        if config.encryption_enabled {
            set_unlocked_key(None, 0)?;
        }
        Ok(security_status(&config))
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_lock_timeout(
    app: tauri::AppHandle,
    minutes: u16,
) -> Result<SecurityStatus, String> {
    if minutes == 0 || minutes > 1440 {
        return Err("Lock timeout must be between 1 and 1440 minutes".to_string());
    }
    run_blocking(move || {
        let _storage_guard = lock_storage_ops()?;
        let mut config = load_security_config(&app)?;
        config.lock_timeout_minutes = minutes;
        save_security_config(&app, &config)?;
        let mut guard = key_state()
            .lock()
            .map_err(|_| "Internal key state error".to_string())?;
        guard.lock_timeout_secs = minutes as u64 * 60;
        drop(guard);
        Ok(security_status(&config))
    })
    .await
}

pub(crate) fn remove_file_if_present(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => fsync_parent(path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to remove '{}': {}", path.display(), err)),
    }
}

fn validate_factory_settings(settings_json: &str) -> Result<(), String> {
    let settings_value: serde_json::Value = serde_json::from_str(settings_json)
        .map_err(|err| format!("Invalid factory settings JSON: {}", err))?;
    if !settings_value.is_object() {
        return Err("Factory settings payload must be a JSON object".to_string());
    }
    Ok(())
}

/// Complete a factory reset after its intent journal is durable.
///
/// Every step is idempotent and the journal is removed last, so a crash after
/// any individual write/delete resumes toward the same fully reset state.
fn recover_interrupted_factory_reset_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<(), String> {
    let journal_path = factory_reset_journal_path(app)?;
    if !journal_path.exists() {
        return Ok(());
    }

    let raw = std::fs::read_to_string(&journal_path).map_err(|err| {
        format!(
            "Factory-reset journal '{}' is unreadable and was retained: {}",
            journal_path.display(),
            err
        )
    })?;
    let journal: FactoryResetJournal = serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Factory-reset journal '{}' is invalid and was retained: {}",
            journal_path.display(),
            err
        )
    })?;
    if journal.v != 1 {
        return Err(format!(
            "Unsupported factory-reset journal version {}; journal retained",
            journal.v
        ));
    }
    validate_factory_settings(&journal.settings_json)?;

    // Security and settings are both replayed from the durable journal. If a
    // crash lands between them, protected I/O stays latched until this function
    // writes the missing half on the next startup.
    let default = default_security_config();
    save_security_config(app, &default)?;
    atomic_write(&crate::settings_path(app)?, &journal.settings_json)?;

    for id in &journal.entries {
        let (path, _) = managed_data_file(app, *id)?;
        remove_file_if_present(&path)?;
    }
    purge_transfer_checkpoints(app, &journal.checkpoint_scratch_paths)?;

    // Always remove and verify the credential. A previous disable attempt writes
    // `biometric_enrolled = false` before deletion, so the config bit cannot
    // prove that no orphaned credential remains.
    crate::biometric::clear_stored_key_verified()?;
    set_unlocked_key(None, 0)?;

    std::fs::remove_file(&journal_path).map_err(|err| {
        format!(
            "Factory reset completed, but its recovery journal could not be removed: {}",
            err
        )
    })?;
    fsync_parent(&journal_path)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn factory_reset(
    app: tauri::AppHandle,
    settings_json: String,
) -> Result<SecurityStatus, String> {
    if let Err(err) = crate::s3::stop_all_transfers_for_reset().await {
        crate::s3::resume_transfers_after_failed_reset();
        return Err(err);
    }

    let reset_app = app.clone();
    let result = run_blocking(move || factory_reset_inner(&reset_app, &settings_json)).await;
    if result.is_err() {
        // Before the journal is durable, the reset has not begun and transfers
        // may safely resume. After that commit point, keep them disabled until
        // journal recovery finishes rather than writing into a partial reset.
        let reset_pending = factory_reset_journal_path(&app)
            .map(|path| path.exists())
            .unwrap_or(true);
        if !reset_pending {
            crate::s3::resume_transfers_after_failed_reset();
        }
    }
    result
}

fn factory_reset_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    settings_json: &str,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    validate_factory_settings(settings_json)?;

    let config = load_security_config(app)?;
    let managed = managed_data_files(app)?;
    // Complete every fallible read before recording reset intent, so a broken
    // filesystem is reported before anything is destroyed. A factory reset
    // deletes this data by definition, so being able to *decrypt* it is not a
    // precondition: when the vault is locked, check readability at the I/O level
    // only. Requiring the key here would make "Delete Everything" impossible for
    // exactly the users most likely to need it.
    let vault_open = vault_is_readable(&config);
    for (id, path, default_value) in &managed {
        if !path.exists() {
            continue;
        }
        let result = if vault_open {
            // A file an interrupted upgrade sweep left plaintext must not block
            // the reset that would clean it up anyway.
            let legacy = if LEGACY_PLAINTEXT_CAPABLE_FILES.contains(id) {
                LegacyPlaintext::Adopt
            } else {
                LegacyPlaintext::Reject
            };
            read_protected_file_with_legacy(path, default_value, &config, legacy).map(|_| ())
        } else {
            std::fs::read_to_string(path)
                .map(|_| ())
                .map_err(|err| err.to_string())
        };
        result.map_err(|err| {
            format!(
                "Factory reset preflight failed for '{}': {}",
                path.display(),
                err
            )
        })?;
    }
    // Without the key the checkpoints cannot name their partial download files.
    // Those files are then left on disk: the reset removes the records that point
    // at them, so nothing can reclaim them automatically afterwards. Blocking the
    // reset instead would trap a user who cannot unlock, so the leak is the
    // deliberate cost of keeping the escape hatch open.
    let checkpoint_scratch_paths = if vault_open {
        collect_transfer_checkpoint_scratch_paths(app, &config)?
    } else {
        Vec::new()
    };

    let journal = FactoryResetJournal {
        v: 1,
        settings_json: settings_json.to_string(),
        entries: managed.iter().map(|(id, _, _)| *id).collect(),
        checkpoint_scratch_paths,
    };
    let journal_json = serde_json::to_string_pretty(&journal).map_err(|err| err.to_string())?;
    let journal_path = factory_reset_journal_path(app)?;
    atomic_write(&journal_path, &journal_json)?;

    let result = recover_interrupted_factory_reset_inner(app);
    match &result {
        Ok(()) => set_migration_recovery_failure(None),
        Err(error) => set_migration_recovery_failure(Some(error.clone())),
    }
    result?;

    let default = default_security_config();
    Ok(security_status(&default))
}

/// Discard the vault configuration.
///
/// `destroy_encrypted_data` decides what happens to data that is still
/// encrypted. Without it, resetting the configuration used to leave ciphertext
/// on disk with no key: the next read handed that ciphertext to the frontend as
/// though it were plaintext, and the next save overwrote it with defaults. The
/// reset now either refuses, or removes the unreadable files deliberately.
#[tauri::command]
pub(crate) async fn reset_security(
    app: tauri::AppHandle,
    destroy_encrypted_data: Option<bool>,
) -> Result<SecurityStatus, String> {
    run_blocking(move || reset_security_inner(&app, destroy_encrypted_data.unwrap_or(false))).await
}

fn reset_security_inner<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    destroy_encrypted_data: bool,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    ensure_migration_recovered()?;
    let config = load_security_config(app)?;
    // Scratch paths can only be read while the vault is open. When the caller has
    // already accepted the loss of encrypted data, a locked vault must not block
    // the reset: the checkpoints are removed either way, and the only cost is
    // that their partial download files cannot be identified for cleanup.
    let checkpoint_scratch_paths = match collect_transfer_checkpoint_scratch_paths(app, &config) {
        Ok(paths) => paths,
        Err(err) if destroy_encrypted_data => {
            let _ = err;
            Vec::new()
        }
        Err(err) => return Err(err),
    };

    // Find files that would become unreadable once the key material is gone.
    // Every read is a preflight check: any I/O failure aborts before key,
    // biometric, file, or configuration state is changed.
    let mut stranded: Vec<std::path::PathBuf> = Vec::new();
    for (_, path, _) in managed_data_files(app)? {
        if !path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to inspect protected file '{}': {}",
                path.display(),
                err
            )
        })?;
        if looks_encrypted(&raw) {
            stranded.push(path);
        }
    }

    if !stranded.is_empty() && !destroy_encrypted_data {
        let names = stranded
            .iter()
            .map(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.display().to_string())
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Resetting security would leave {} permanently unreadable because the \
             encryption key is being discarded. Unlock and disable encryption to keep \
             this data, or confirm the reset to delete it. ({})",
            if stranded.len() == 1 {
                "1 file"
            } else {
                "these files"
            },
            names
        ));
    }

    // Record credential-removal intent before the commit point. Because the
    // configuration is committed before anything is destroyed, an interruption
    // before that commit means the reset never happened, and a surviving
    // `biometric_enrolled = true` still describes the credential that is still
    // wanted. After the commit the flag is false and recovery removes the key.
    crate::biometric::journal_cleanup_unless_enrolled(app)?;

    // Commit the configuration before destroying anything. The reset has one
    // commit point, and the deletions after it are idempotent, so an interruption
    // can only leave unreadable files behind while the configuration already says
    // encryption is off. `read_protected_file` refuses ciphertext without a key,
    // so those files fail closed and a repeated reset finishes removing them.
    // Deleting first would instead leave the data gone while the configuration
    // still claimed an enabled vault.
    let default = default_security_config();
    save_security_config(app, &default)?;
    let _ = set_unlocked_key(None, 0);

    // Retire the credential immediately after the commit, before any fallible
    // deletion. Doing it last meant a failed file removal returned early and left
    // the old vault key in the OS credential store until the next startup.
    crate::biometric::recover_pending_biometric_cleanup(app).map_err(|err| {
        format!(
            "Security was reset, but the stored biometric key could not be removed: {}",
            err
        )
    })?;

    // Failures after the commit point are reported but deliberately do not latch
    // protected I/O. The configuration is already consistent, and any file left
    // behind is ciphertext that `read_protected_file` refuses on its own, so
    // latching would block unrelated plaintext storage for the rest of the
    // session with no way to clear it short of a restart. Re-running the reset
    // retries these deletions.
    for path in &stranded {
        std::fs::remove_file(path).map_err(|e| {
            format!(
                "Security was reset, but the unreadable file '{}' could not be removed: {}. \
                 Reset again to retry.",
                path.display(),
                e
            )
        })?;
    }
    if let Err(cleanup_error) = purge_transfer_checkpoints(app, &checkpoint_scratch_paths) {
        return Err(format!(
            "Security was reset, but checkpoint cleanup failed: {}. Reset again to retry.",
            cleanup_error
        ));
    }
    Ok(security_status(&default))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn unique_test_suffix(label: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{label}-{}-{nanos}", std::process::id())
    }

    fn test_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    /// Take the environment lock without propagating poisoning.
    ///
    /// These tests share process-wide environment variables, so one failing
    /// assertion used to poison the mutex and turn a single real failure into a
    /// cascade of unrelated panics that hid it.
    fn lock_test_env() -> MutexGuard<'static, ()> {
        test_env_lock()
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    fn restore_env_var(key: &str, value: &Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    struct TestEnvGuard {
        _lock: MutexGuard<'static, ()>,
        root: std::path::PathBuf,
        home: Option<OsString>,
        appdata: Option<OsString>,
        localappdata: Option<OsString>,
        xdg_data_home: Option<OsString>,
        test_app_data: Option<OsString>,
    }

    impl TestEnvGuard {
        fn new(label: &str) -> Self {
            let lock = lock_test_env();
            let root = std::env::temp_dir().join(format!(
                "s3-sidekick-security-test-{}",
                unique_test_suffix(label)
            ));
            let home = root.join("home");
            let appdata = root.join("appdata");
            let localappdata = root.join("localappdata");
            let xdg_data_home = root.join("xdg-data-home");
            // Dedicated override: Windows Known Folders ignore APPDATA, and
            // tauri::test::mock_app can resolve app_data_dir to the roaming root.
            let test_app_data = root.join("app-data");

            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&appdata).unwrap();
            std::fs::create_dir_all(&localappdata).unwrap();
            std::fs::create_dir_all(&xdg_data_home).unwrap();
            std::fs::create_dir_all(&test_app_data).unwrap();

            let prior_home = std::env::var_os("HOME");
            let prior_appdata = std::env::var_os("APPDATA");
            let prior_localappdata = std::env::var_os("LOCALAPPDATA");
            let prior_xdg_data_home = std::env::var_os("XDG_DATA_HOME");
            let prior_test_app_data = std::env::var_os("S3_SIDEKICK_TEST_APP_DATA");

            std::env::set_var("HOME", &home);
            std::env::set_var("APPDATA", &appdata);
            std::env::set_var("LOCALAPPDATA", &localappdata);
            std::env::set_var("XDG_DATA_HOME", &xdg_data_home);
            std::env::set_var("S3_SIDEKICK_TEST_APP_DATA", &test_app_data);

            Self {
                _lock: lock,
                root,
                home: prior_home,
                appdata: prior_appdata,
                localappdata: prior_localappdata,
                xdg_data_home: prior_xdg_data_home,
                test_app_data: prior_test_app_data,
            }
        }
    }

    impl Drop for TestEnvGuard {
        fn drop(&mut self) {
            restore_env_var("HOME", &self.home);
            restore_env_var("APPDATA", &self.appdata);
            restore_env_var("LOCALAPPDATA", &self.localappdata);
            restore_env_var("XDG_DATA_HOME", &self.xdg_data_home);
            restore_env_var("S3_SIDEKICK_TEST_APP_DATA", &self.test_app_data);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn make_test_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_app()
    }

    struct TestAppDataGuard {
        path: std::path::PathBuf,
    }

    impl TestAppDataGuard {
        fn new<R: tauri::Runtime, M: tauri::Manager<R>>(app: &M) -> Self {
            let path = crate::resolved_app_data_dir(app).unwrap();
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestAppDataGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn constant_time_eq_equal_slices() {
        assert!(constant_time_eq(b"hello", b"hello"));
    }

    #[test]
    fn constant_time_eq_different_slices() {
        assert!(!constant_time_eq(b"hello", b"world"));
    }

    #[test]
    fn constant_time_eq_different_lengths() {
        assert!(!constant_time_eq(b"hi", b"hello"));
    }

    #[test]
    fn constant_time_eq_empty_slices() {
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn derive_key_produces_correct_length() {
        let key = derive_key("testpassword", b"testsalt12345678", 1000);
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn derive_key_deterministic() {
        let k1 = derive_key("password", b"salt1234salt1234", 1000);
        let k2 = derive_key("password", b"salt1234salt1234", 1000);
        assert_eq!(k1, k2);
    }

    #[test]
    fn derive_key_different_passwords_differ() {
        let k1 = derive_key("password1", b"salt1234salt1234", 1000);
        let k2 = derive_key("password2", b"salt1234salt1234", 1000);
        assert_ne!(k1, k2);
    }

    #[test]
    fn key_verifier_deterministic() {
        let key = derive_key("password", b"salt1234salt1234", 1000);
        let v1 = key_verifier(&key);
        let v2 = key_verifier(&key);
        assert_eq!(v1, v2);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = derive_key("my-password", b"test-salt-16byte", 1000);
        let original = "{\"endpoint\":\"https://example.com\"}";
        let encrypted = encrypt_text(original, &key).unwrap();
        assert_ne!(encrypted, original);
        let decrypted = decrypt_text(&encrypted, &key).unwrap();
        assert_eq!(decrypted, original);
    }

    #[test]
    fn encrypted_payload_is_tagged_with_its_key() {
        let key1 = derive_key("password-one", b"salt1234salt1234", 1000);
        let key2 = derive_key("password-two", b"salt5678salt5678", 1000);
        let payload = encrypt_text("secret", &key1).unwrap();

        // The key-check value identifies which key produced a payload without
        // needing to decrypt it, which is what makes migration state auditable.
        assert_eq!(payload_key_check(&payload), Some(key_check_value(&key1)));
        assert_ne!(payload_key_check(&payload), Some(key_check_value(&key2)));
    }

    #[test]
    fn payload_key_check_ignores_untagged_payloads() {
        // Payloads written before the field existed have no key-check value and
        // must still be readable.
        let legacy = "{\"v\":1,\"nonce\":\"abc\",\"ciphertext\":\"def\"}";
        assert_eq!(payload_key_check(legacy), None);
        assert!(looks_encrypted(legacy));
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let key1 = derive_key("password-one", b"salt1234salt1234", 1000);
        let key2 = derive_key("password-two", b"salt5678salt5678", 1000);
        let encrypted = encrypt_text("secret", &key1).unwrap();
        assert!(decrypt_text(&encrypted, &key2).is_err());
    }

    #[test]
    fn default_security_config_is_uninitialized() {
        let config = default_security_config();
        assert!(!config.initialized);
        assert!(!config.encryption_enabled);
        assert_eq!(config.pbkdf2_iterations, PBKDF2_ITERATIONS);
    }

    #[tokio::test]
    async fn unlock_security_migrates_legacy_pbkdf2_vault() {
        let _env = TestEnvGuard::new("pbkdf2-migration");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let app_handle = app.handle().clone();

        set_unlocked_key(None, 0).unwrap();

        let legacy_password = "correct horse battery staple";
        // Must sit between the floor and the current count so the rekey path fires.
        let legacy_iterations = MIN_PBKDF2_ITERATIONS + 5_000;
        let legacy_salt = *b"legacy-salt-1234";
        let legacy_key = derive_key(legacy_password, &legacy_salt, legacy_iterations);
        let legacy_verifier = key_verifier(&legacy_key);

        let connection_plain =
            "{\"endpoint\":\"https://example.com\",\"region\":\"us-east-1\",\"access_key\":\"abc\",\"secret_key\":\"def\"}";
        let bookmarks_plain =
            "[{\"name\":\"prod\",\"endpoint\":\"https://example.com\",\"region\":\"us-east-1\",\"access_key\":\"abc\",\"secret_key\":\"def\"}]";
        let bookmarks_backup_plain = bookmarks_plain;

        let connection_path = crate::connection_path(&app_handle).unwrap();
        let bookmarks_path = crate::bookmarks_path(&app_handle).unwrap();
        let bookmarks_backup_path = crate::bookmarks_backup_path(&app_handle).unwrap();
        let security_path = crate::security_path(&app_handle).unwrap();

        let legacy_connection_cipher = encrypt_text(connection_plain, &legacy_key).unwrap();
        let legacy_bookmarks_cipher = encrypt_text(bookmarks_plain, &legacy_key).unwrap();
        let legacy_bookmarks_backup_cipher =
            encrypt_text(bookmarks_backup_plain, &legacy_key).unwrap();

        std::fs::write(&connection_path, &legacy_connection_cipher).unwrap();
        std::fs::write(&bookmarks_path, &legacy_bookmarks_cipher).unwrap();
        std::fs::write(&bookmarks_backup_path, &legacy_bookmarks_backup_cipher).unwrap();

        let legacy_config = SecurityConfig {
            initialized: true,
            encryption_enabled: true,
            salt: B64.encode(legacy_salt),
            verifier: B64.encode(legacy_verifier),
            lock_timeout_minutes: 15,
            pbkdf2_iterations: legacy_iterations,
            biometric_enrolled: false,
            legacy_plaintext_adopted: false,
            legacy_plaintext_adoption_proof: String::new(),
        };
        save_security_config(&app_handle, &legacy_config).unwrap();

        let status = unlock_security_inner(&app_handle, legacy_password.to_string()).unwrap();
        assert!(status.unlocked);
        assert_eq!(status.lock_timeout_minutes, 15);

        let migrated_config = load_security_config(&app_handle).unwrap();
        assert_eq!(migrated_config.pbkdf2_iterations, PBKDF2_ITERATIONS);
        assert_ne!(migrated_config.salt, legacy_config.salt);
        assert_ne!(migrated_config.verifier, legacy_config.verifier);

        let migrated_connection_cipher = std::fs::read_to_string(&connection_path).unwrap();
        let migrated_bookmarks_cipher = std::fs::read_to_string(&bookmarks_path).unwrap();
        let migrated_bookmarks_backup_cipher =
            std::fs::read_to_string(&bookmarks_backup_path).unwrap();
        assert_ne!(migrated_connection_cipher, legacy_connection_cipher);
        assert_ne!(migrated_bookmarks_cipher, legacy_bookmarks_cipher);
        assert_ne!(
            migrated_bookmarks_backup_cipher,
            legacy_bookmarks_backup_cipher
        );

        let connection_roundtrip =
            read_protected_file(&connection_path, "", &migrated_config).unwrap();
        let bookmarks_roundtrip =
            read_protected_file(&bookmarks_path, "[]", &migrated_config).unwrap();
        let bookmarks_backup_roundtrip =
            read_protected_file(&bookmarks_backup_path, "[]", &migrated_config).unwrap();
        assert_eq!(connection_roundtrip, connection_plain);
        assert_eq!(bookmarks_roundtrip, bookmarks_plain);
        assert_eq!(bookmarks_backup_roundtrip, bookmarks_backup_plain);

        let security_json = std::fs::read_to_string(security_path).unwrap();
        assert!(security_json.contains(&format!("\"pbkdf2_iterations\": {}", PBKDF2_ITERATIONS)));

        set_unlocked_key(None, 0).unwrap();
    }

    // -----------------------------------------------------------------------
    // Migration invariants and crash-window recovery
    // -----------------------------------------------------------------------

    /// Write every managed data file with recognisable plaintext.
    fn seed_managed_files<R: tauri::Runtime, M: tauri::Manager<R>>(
        app: &M,
    ) -> Vec<(std::path::PathBuf, String)> {
        let mut seeded = Vec::new();
        for (index, (_, path, _)) in managed_data_files(app).unwrap().into_iter().enumerate() {
            let contents = format!("{{\"managed_file\":{}}}", index);
            std::fs::write(&path, &contents).unwrap();
            seeded.push((path, contents));
        }
        seeded
    }

    /// T1: every file reached through `read_protected_file` /
    /// `write_protected_file` must be covered by the migration set.
    ///
    /// This is the regression guard for the transfer manifest having been left
    /// out: enabling encryption used to encrypt it (because the command routed
    /// through `write_protected_file`) while the migration set did not know about
    /// it, so disabling encryption again left it undecryptable forever.
    #[test]
    fn migration_covers_every_protected_file() {
        let _env = TestEnvGuard::new("migration-coverage");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let seeded = seed_managed_files(&handle);
        assert_eq!(
            seeded.len(),
            4,
            "expected bookmarks, bookmarks backup, connection and transfer manifest"
        );

        // Turn encryption on.
        initialize_security_inner(&handle, false, None).unwrap();
        set_security_encryption_inner(&handle, true, None, Some("correct horse".to_string()))
            .unwrap();

        let encrypted_config = load_security_config(&handle).unwrap();
        assert!(encrypted_config.encryption_enabled);
        for (path, _) in &seeded {
            let raw = std::fs::read_to_string(path).unwrap();
            assert!(
                looks_encrypted(&raw),
                "{} was not encrypted by the migration",
                path.display()
            );
        }

        // Turn it back off; everything must come back byte for byte.
        set_security_encryption_inner(&handle, false, Some("correct horse".to_string()), None)
            .unwrap();
        let plain_config = load_security_config(&handle).unwrap();
        assert!(!plain_config.encryption_enabled);
        for (path, original) in &seeded {
            let raw = std::fs::read_to_string(path).unwrap();
            assert_eq!(&raw, original, "{} did not round-trip", path.display());
        }

        set_unlocked_key(None, 0).unwrap();
    }

    /// A full password change must leave every managed file readable with the
    /// new password.
    #[test]
    fn change_password_rekeys_every_managed_file() {
        let _env = TestEnvGuard::new("rekey-roundtrip");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let seeded = seed_managed_files(&handle);
        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        change_security_password_inner(
            &handle,
            "first password".to_string(),
            "second password".to_string(),
        )
        .unwrap();

        // The old password must no longer unlock, the new one must.
        set_unlocked_key(None, 0).unwrap();
        assert!(unlock_security_inner(&handle, "first password".to_string()).is_err());
        unlock_security_inner(&handle, "second password".to_string()).unwrap();

        let config = load_security_config(&handle).unwrap();
        for (path, original) in &seeded {
            let value = read_protected_file(path, "", &config).unwrap();
            assert_eq!(&value, original, "{} lost its contents", path.display());
        }

        set_unlocked_key(None, 0).unwrap();
    }

    /// The full v0.11.0-beta.2 upgrade shape: an encrypted vault whose transfer
    /// manifest and download checkpoints were written in the clear by the older
    /// build. Unlocking must adopt them, after which every vault operation that
    /// reads them works.
    #[test]
    fn unlocking_adopts_plaintext_files_left_by_an_earlier_version() {
        let _env = TestEnvGuard::new("adopt-legacy-plaintext");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        set_unlocked_key(None, 0).unwrap();

        // A configuration written by the older release has no adoption marker,
        // which is what makes its plaintext files explainable.
        let mut upgraded = load_security_config(&handle).unwrap();
        upgraded.legacy_plaintext_adopted = false;
        upgraded.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &upgraded).unwrap();

        let manifest = crate::transfer_manifest_path(&handle).unwrap();
        let manifest_json = "{\"v\":3,\"items\":[]}";
        std::fs::write(&manifest, manifest_json).unwrap();

        let checkpoint = crate::transfer_checkpoint_dir(&handle)
            .unwrap()
            .join(format!("{}.json", crate::checkpoint_file_name("legacy")));
        let checkpoint_json = "{\"completedParts\":[1]}";
        std::fs::write(&checkpoint, checkpoint_json).unwrap();

        unlock_security_inner(&handle, "first password".to_string())
            .expect("unlock must tolerate legacy plaintext files");

        for (path, original) in [(&manifest, manifest_json), (&checkpoint, checkpoint_json)] {
            let raw = std::fs::read_to_string(path).unwrap();
            assert!(
                looks_encrypted(&raw),
                "{} was not adopted into the vault",
                path.display()
            );
            let config = load_security_config(&handle).unwrap();
            assert_eq!(read_protected_file(path, "", &config).unwrap(), original);
        }

        // The tolerance is one-shot: once the sweep completes, plaintext in a
        // protected file is treated as tampering again.
        let adopted = load_security_config(&handle).unwrap();
        assert!(adopted.legacy_plaintext_adopted);
        std::fs::write(&manifest, manifest_json).unwrap();
        assert!(
            read_protected_file_with_legacy(&manifest, "", &adopted, LegacyPlaintext::Adopt)
                .is_err(),
            "plaintext must be refused once the upgrade sweep has completed"
        );
        write_protected_file(&manifest, manifest_json, &adopted).unwrap();

        // The operation that used to wedge on a plaintext checkpoint.
        change_security_password_inner(
            &handle,
            "first password".to_string(),
            "second password".to_string(),
        )
        .expect("password change must work after an upgrade");

        set_unlocked_key(None, 0).unwrap();
    }

    /// Once a keyed completion proof exists, editing or removing the legacy
    /// boolean cannot re-arm plaintext adoption and launder replacement data.
    #[test]
    fn authenticated_adoption_proof_prevents_rearming_the_sweep() {
        let _env = TestEnvGuard::new("adoption-proof-rearm");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();

        // Simulate an older encrypted config and complete its one-time sweep.
        let mut old = load_security_config(&handle).unwrap();
        old.legacy_plaintext_adopted = false;
        old.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &old).unwrap();
        set_unlocked_key(None, 0).unwrap();
        unlock_security_inner(&handle, "first password".to_string()).unwrap();
        let adopted = load_security_config(&handle).unwrap();
        assert!(!adopted.legacy_plaintext_adoption_proof.is_empty());

        // Remove only the unauthenticated compatibility marker while retaining
        // the keyed proof, then replace a legacy-capable file with plaintext.
        let security_file = security_path(&handle).unwrap();
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&security_file).unwrap()).unwrap();
        raw.as_object_mut()
            .unwrap()
            .remove("legacy_plaintext_adopted");
        atomic_write(&security_file, &serde_json::to_string_pretty(&raw).unwrap()).unwrap();

        let manifest = crate::transfer_manifest_path(&handle).unwrap();
        let replacement = "{\"items\":[{\"untrusted\":true}]}";
        std::fs::write(&manifest, replacement).unwrap();
        set_unlocked_key(None, 0).unwrap();
        unlock_security_inner(&handle, "first password".to_string())
            .expect("the valid proof should allow unlocking without re-running adoption");

        assert_eq!(std::fs::read_to_string(&manifest).unwrap(), replacement);
        let tampered = load_security_config(&handle).unwrap();
        assert!(
            read_protected_file_with_legacy(&manifest, "", &tampered, LegacyPlaintext::Adopt,)
                .is_err(),
            "a valid completion proof must keep replacement plaintext untrusted"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    /// The tolerance must not become a way to read protected data while locked,
    /// and it must not extend to files that were always encrypted.
    #[test]
    fn legacy_tolerance_is_scoped_to_unlocked_vaults_and_legacy_files() {
        let _env = TestEnvGuard::new("legacy-tolerance-scope");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        let mut config = load_security_config(&handle).unwrap();
        config.legacy_plaintext_adopted = false;
        config.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &config).unwrap();

        let manifest = crate::transfer_manifest_path(&handle).unwrap();
        std::fs::write(&manifest, "{\"items\":[]}").unwrap();
        let bookmarks = crate::bookmarks_path(&handle).unwrap();
        std::fs::write(&bookmarks, "[]").unwrap();

        // Locked: even a legacy-capable file must not be served.
        set_unlocked_key(None, 0).unwrap();
        assert!(
            read_protected_file_with_legacy(&manifest, "", &config, LegacyPlaintext::Adopt)
                .is_err(),
            "a locked vault must not serve protected content"
        );

        unlock_security_inner(&handle, "first password".to_string()).unwrap();

        // Bookmarks were always encrypted, so plaintext there is not legacy.
        std::fs::write(&bookmarks, "[]").unwrap();
        assert!(
            read_protected_file(&bookmarks, "[]", &config).is_err(),
            "plaintext must stay untrusted for files that were never legacy"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    /// The destructive escape hatches must stay reachable while locked, which is
    /// the state a user who has lost their password is in.
    #[test]
    fn destructive_resets_work_on_a_locked_vault() {
        let _env = TestEnvGuard::new("locked-destructive-reset");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        let config = load_security_config(&handle).unwrap();
        let bookmarks = crate::bookmarks_path(&handle).unwrap();
        write_protected_file(&bookmarks, "[{\"name\":\"prod\"}]", &config).unwrap();
        // An encrypted checkpoint makes scratch-path collection need the key too.
        let checkpoint = crate::transfer_checkpoint_dir(&handle)
            .unwrap()
            .join(format!("{}.json", crate::checkpoint_file_name("live")));
        write_protected_file(&checkpoint, "{\"completedParts\":[1]}", &config).unwrap();
        set_unlocked_key(None, 0).unwrap();

        // Confirmed destruction must not require the key.
        reset_security_inner(&handle, true)
            .expect("a confirmed reset must not require unlocking first");
        assert!(!bookmarks.exists());
        assert!(!checkpoint.exists(), "the reset must clear checkpoints");
        assert!(!load_security_config(&handle).unwrap().encryption_enabled);

        // And the same for a full factory reset, again with protected state that
        // cannot be decrypted while locked.
        set_unlocked_key(None, 0).unwrap();
        initialize_security_inner(&handle, true, Some("second password".to_string())).unwrap();
        let config = load_security_config(&handle).unwrap();
        write_protected_file(&bookmarks, "[{\"name\":\"prod\"}]", &config).unwrap();
        write_protected_file(&checkpoint, "{\"completedParts\":[1]}", &config).unwrap();
        set_unlocked_key(None, 0).unwrap();

        factory_reset_inner(&handle, "{}").expect("factory reset must work while locked");
        assert!(!bookmarks.exists());
        assert!(
            !checkpoint.exists(),
            "the factory reset must clear checkpoints it could not read"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    /// A locked vault fails every protected read, which must never be mistaken
    /// for "this data is unusable". A refused reset has to leave live resumable
    /// state exactly where it was.
    #[test]
    fn a_locked_vault_does_not_lose_live_checkpoints() {
        let _env = TestEnvGuard::new("locked-keeps-checkpoints");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        let config = load_security_config(&handle).unwrap();

        let checkpoint = crate::transfer_checkpoint_dir(&handle)
            .unwrap()
            .join(format!("{}.json", crate::checkpoint_file_name("live")));
        write_protected_file(&checkpoint, "{\"completedParts\":[1]}", &config).unwrap();

        // Lock the vault, then ask for something that inspects checkpoints.
        set_unlocked_key(None, 0).unwrap();
        assert!(
            reset_security_inner(&handle, false).is_err(),
            "a locked vault cannot classify protected data"
        );
        assert!(
            checkpoint.exists(),
            "a locked vault must not discard resumable state"
        );
    }

    /// A checkpoint that cannot be adopted must not block unlock, and must leave
    /// the sweep incomplete so a later unlock retries it.
    #[cfg(unix)]
    #[test]
    fn an_unwritable_checkpoint_leaves_the_sweep_pending_without_blocking_unlock() {
        use std::os::unix::fs::PermissionsExt;

        let _env = TestEnvGuard::new("legacy-unwritable-checkpoint");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        let mut upgraded = load_security_config(&handle).unwrap();
        upgraded.legacy_plaintext_adopted = false;
        upgraded.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &upgraded).unwrap();
        set_unlocked_key(None, 0).unwrap();

        let dir = crate::transfer_checkpoint_dir(&handle).unwrap();
        let checkpoint = dir.join(format!("{}.json", crate::checkpoint_file_name("legacy")));
        std::fs::write(&checkpoint, "{\"completedParts\":[1]}").unwrap();
        // Adoption writes atomically, so a read-only directory is what makes the
        // rewrite fail while the file itself stays readable.
        let original = std::fs::metadata(&dir).unwrap().permissions();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let unlocked = unlock_security_inner(&handle, "first password".to_string());
        std::fs::set_permissions(&dir, original).unwrap();
        unlocked.expect("an unwritable checkpoint must not block unlock");

        assert!(
            !load_security_config(&handle)
                .unwrap()
                .legacy_plaintext_adopted,
            "an incomplete sweep must stay pending so a later unlock retries it"
        );
        assert_eq!(
            std::fs::read_to_string(&checkpoint).unwrap(),
            "{\"completedParts\":[1]}",
            "the checkpoint must be left intact for the retry"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    /// Ciphertext from a vault whose key is gone is neither adoptable nor
    /// resumable. It must not block unlock, and the migration path discards it as
    /// unusable recovery state rather than wedging later vault operations.
    #[test]
    fn a_stale_checkpoint_does_not_block_unlock() {
        let _env = TestEnvGuard::new("legacy-stale-checkpoint");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();
        let mut upgraded = load_security_config(&handle).unwrap();
        upgraded.legacy_plaintext_adopted = false;
        upgraded.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &upgraded).unwrap();
        set_unlocked_key(None, 0).unwrap();

        // Ciphertext from a vault whose key is gone: unreadable and unadoptable.
        let lost_key = derive_key("gone", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let checkpoint = crate::transfer_checkpoint_dir(&handle)
            .unwrap()
            .join(format!("{}.json", crate::checkpoint_file_name("stale")));
        std::fs::write(&checkpoint, encrypt_text("{}", &lost_key).unwrap()).unwrap();

        unlock_security_inner(&handle, "first password".to_string())
            .expect("an unadoptable checkpoint must never block unlock");

        // Enabling/changing the vault must not be wedged by it either; the
        // migration path discards unreadable recovery state.
        change_security_password_inner(
            &handle,
            "first password".to_string(),
            "second password".to_string(),
        )
        .expect("stale recovery state must not wedge a password change");
        assert!(
            !checkpoint.exists(),
            "unreadable checkpoint must be discarded"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    /// Upgrading from a build with a smaller managed set leaves newly managed
    /// files plaintext inside an encrypted vault. Rekeying must adopt them
    /// instead of trying to decrypt them, which used to make changing the
    /// password impossible after upgrading.
    #[test]
    fn rekeying_adopts_files_left_plaintext_by_an_earlier_version() {
        let _env = TestEnvGuard::new("rekey-plaintext-upgrade");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        initialize_security_inner(&handle, true, Some("first password".to_string())).unwrap();

        // The state an upgrade produces: encryption on, no adoption marker, and
        // this file written by a version that did not manage it.
        let mut upgraded = load_security_config(&handle).unwrap();
        upgraded.legacy_plaintext_adopted = false;
        upgraded.legacy_plaintext_adoption_proof.clear();
        save_security_config(&handle, &upgraded).unwrap();

        let manifest = crate::transfer_manifest_path(&handle).unwrap();
        let legacy = "{\"items\":[]}";
        std::fs::write(&manifest, legacy).unwrap();
        assert!(!looks_encrypted(
            &std::fs::read_to_string(&manifest).unwrap()
        ));

        change_security_password_inner(
            &handle,
            "first password".to_string(),
            "second password".to_string(),
        )
        .expect("rekeying must tolerate a plaintext managed file");

        let raw = std::fs::read_to_string(&manifest).unwrap();
        assert!(
            looks_encrypted(&raw),
            "the adopted file must end up encrypted"
        );
        let config = load_security_config(&handle).unwrap();
        assert_eq!(read_protected_file(&manifest, "", &config).unwrap(), legacy);

        set_unlocked_key(None, 0).unwrap();
    }

    /// T2: a crash before the commit point must leave the originals untouched.
    #[test]
    fn interrupted_migration_before_commit_restores_originals() {
        let _env = TestEnvGuard::new("journal-precommit");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let seeded = seed_managed_files(&handle);
        let previous = default_security_config();
        save_security_config(&handle, &previous).unwrap();

        // Simulate reaching step 2 (staged + journal written) and then dying.
        let key = derive_key("pw", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let plans = build_migration_plans(&handle, true, &key).unwrap();
        assert_eq!(plans.len(), seeded.len());
        stage_migration(&plans).unwrap();
        let target = SecurityConfig {
            initialized: true,
            encryption_enabled: true,
            salt: B64.encode(b"salt1234salt1234"),
            verifier: B64.encode(key_verifier(&key)),
            lock_timeout_minutes: 0,
            pbkdf2_iterations: MIN_PBKDF2_ITERATIONS,
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: adoption_proof_string(&key),
        };
        let journal_path = crate::security_journal_path(&handle).unwrap();
        let journal = MigrationJournal {
            v: 2,
            previous: fingerprint(&previous),
            target,
            entries: plans.iter().map(|plan| plan.id).collect(),
            checkpoint_scratch_paths: Vec::new(),
        };
        atomic_write(
            &journal_path,
            &serde_json::to_string_pretty(&journal).unwrap(),
        )
        .unwrap();

        // Startup recovery.
        recover_interrupted_migration(&handle).unwrap();

        assert!(!journal_path.exists(), "journal should be cleared");
        for plan in &plans {
            assert!(
                !plan.staged.exists(),
                "staging file {} should be discarded",
                plan.staged.display()
            );
        }
        for (path, original) in &seeded {
            assert_eq!(
                &std::fs::read_to_string(path).unwrap(),
                original,
                "{} must be untouched before the commit point",
                path.display()
            );
        }

        set_unlocked_key(None, 0).unwrap();
    }

    /// T2: a crash after the commit point must be completed, not rolled back.
    #[test]
    fn interrupted_migration_after_commit_is_completed() {
        let _env = TestEnvGuard::new("journal-postcommit");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let seeded = seed_managed_files(&handle);
        let previous = default_security_config();
        save_security_config(&handle, &previous).unwrap();

        let salt = *b"salt1234salt1234";
        let key = derive_key("pw", &salt, MIN_PBKDF2_ITERATIONS);
        let plans = build_migration_plans(&handle, true, &key).unwrap();
        stage_migration(&plans).unwrap();

        let target = SecurityConfig {
            initialized: true,
            encryption_enabled: true,
            salt: B64.encode(salt),
            verifier: B64.encode(key_verifier(&key)),
            lock_timeout_minutes: 0,
            pbkdf2_iterations: MIN_PBKDF2_ITERATIONS,
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: adoption_proof_string(&key),
        };
        let journal_path = crate::security_journal_path(&handle).unwrap();
        let journal = MigrationJournal {
            v: 2,
            previous: fingerprint(&previous),
            target: target.clone(),
            entries: plans.iter().map(|plan| plan.id).collect(),
            checkpoint_scratch_paths: Vec::new(),
        };
        atomic_write(
            &journal_path,
            &serde_json::to_string_pretty(&journal).unwrap(),
        )
        .unwrap();
        // Commit the configuration, then "die" before publishing the renames.
        save_security_config(&handle, &target).unwrap();

        recover_interrupted_migration(&handle).unwrap();

        assert!(!journal_path.exists(), "journal should be cleared");
        let config = load_security_config(&handle).unwrap();
        assert!(config.encryption_enabled);
        for (path, original) in &seeded {
            let raw = std::fs::read_to_string(path).unwrap();
            assert!(
                looks_encrypted(&raw),
                "{} should have been published as ciphertext",
                path.display()
            );
            assert_eq!(&decrypt_text(&raw, &key).unwrap(), original);
        }

        set_unlocked_key(None, 0).unwrap();
    }

    #[test]
    fn enabling_encryption_rejects_unowned_existing_ciphertext() {
        let _env = TestEnvGuard::new("enable-over-ciphertext");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();
        save_security_config(&handle, &default_security_config()).unwrap();

        let old_key = derive_key("lost-password", b"salt1234salt1234", 1000);
        let target_key = derive_key("new-password", b"salt5678salt5678", 1000);
        let path = crate::bookmarks_path(&handle).unwrap();
        let ciphertext = encrypt_text("[]", &old_key).unwrap();
        std::fs::write(&path, &ciphertext).unwrap();

        let Err(err) = build_migration_plans(&handle, true, &target_key) else {
            panic!("foreign ciphertext must not be stranded behind a new key");
        };
        assert!(
            err.contains("still holds ciphertext"),
            "unexpected error: {err}"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), ciphertext);
    }

    /// Stale ciphertext in disposable recovery state must not block the vault.
    ///
    /// An interrupted disable can leave the transfer manifest encrypted under a
    /// key that no longer exists. Refusing to enable encryption over it would
    /// trap the user, so it is discarded rather than treated as user data.
    #[test]
    fn enabling_encryption_discards_stale_ciphertext_in_disposable_state() {
        let _env = TestEnvGuard::new("enable-over-stale-manifest");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let lost_key = derive_key("gone", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let manifest = crate::transfer_manifest_path(&handle).unwrap();
        std::fs::write(
            &manifest,
            encrypt_text("{\"items\":[{\"id\":1}]}", &lost_key).unwrap(),
        )
        .unwrap();

        let new_key = derive_key("new", b"salt5678salt5678", MIN_PBKDF2_ITERATIONS);
        let plans = build_migration_plans(&handle, true, &new_key)
            .expect("stale recovery state must not block enabling encryption");
        let plan = plans
            .iter()
            .find(|plan| plan.path == manifest)
            .expect("the manifest must still be migrated");
        let (_, default_value) =
            managed_data_file(&handle, ManagedDataId::TransferManifest).unwrap();
        assert_eq!(
            decrypt_text(&plan.transformed, &new_key).unwrap(),
            default_value,
            "unreadable recovery state must be replaced by its default"
        );
    }

    /// H2: ciphertext with no key material must be reported, never handed back
    /// as if it were plaintext.
    #[test]
    fn read_protected_file_refuses_ciphertext_without_key() {
        let _env = TestEnvGuard::new("fail-closed");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();

        let key = derive_key("pw", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let path = crate::bookmarks_path(&handle).unwrap();
        std::fs::write(&path, encrypt_text("[{\"name\":\"prod\"}]", &key).unwrap()).unwrap();

        // Config says encryption is off, which is what a lost or reset
        // security.json looks like.
        let config = default_security_config();
        let err = read_protected_file(&path, "[]", &config)
            .expect_err("must not return ciphertext as plaintext");
        assert!(err.contains("still encrypted"), "unexpected error: {}", err);
    }

    /// H2: resetting must not silently orphan data it cannot read.
    #[test]
    fn reset_security_requires_confirmation_to_destroy_encrypted_data() {
        let _env = TestEnvGuard::new("reset-guard");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let key = derive_key("pw", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let path = crate::bookmarks_path(&handle).unwrap();
        std::fs::write(&path, encrypt_text("[]", &key).unwrap()).unwrap();

        let err = reset_security_inner(&handle, false)
            .expect_err("reset must refuse while readable data would be stranded");
        assert!(err.contains("unreadable"), "unexpected error: {}", err);
        assert!(path.exists(), "nothing should have been deleted yet");

        reset_security_inner(&handle, true).unwrap();
        assert!(
            !path.exists(),
            "confirmed reset should remove the unreadable file"
        );

        set_unlocked_key(None, 0).unwrap();
    }

    fn biometric_cleanup_journal<R: tauri::Runtime, M: tauri::Manager<R>>(
        handle: &M,
    ) -> std::path::PathBuf {
        crate::security_journal_path(handle)
            .unwrap()
            .parent()
            .unwrap()
            .join("biometric-cleanup.journal")
    }

    fn enrolled_config() -> SecurityConfig {
        SecurityConfig {
            initialized: true,
            encryption_enabled: true,
            salt: B64.encode([7u8; SALT_LEN]),
            verifier: B64.encode([9u8; KEY_LEN]),
            lock_timeout_minutes: 15,
            pbkdf2_iterations: PBKDF2_ITERATIONS,
            biometric_enrolled: true,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: String::new(),
        }
    }

    /// A rolled-back transition leaves `biometric_enrolled = true`, which is
    /// genuine evidence that the credential is still the right one.
    #[test]
    fn rollback_style_biometric_cleanup_keeps_a_still_enrolled_credential() {
        let _env = TestEnvGuard::new("biometric-rollback-keep");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        save_security_config(&handle, &enrolled_config()).unwrap();
        crate::biometric::journal_cleanup_unless_enrolled(&handle).unwrap();
        let journal = biometric_cleanup_journal(&handle);
        assert!(journal.exists(), "cleanup intent must be durable");

        crate::biometric::recover_pending_biometric_cleanup(&handle).unwrap();

        assert!(
            !journal.exists(),
            "completed cleanup must clear its journal"
        );
        assert!(
            load_security_config(&handle).unwrap().biometric_enrolled,
            "a rolled-back transition must not silently unenroll"
        );
    }

    /// A committed transition leaves `biometric_enrolled = false`, so the old
    /// credential must go.
    #[test]
    fn rollback_style_biometric_cleanup_clears_an_unenrolled_credential() {
        let _env = TestEnvGuard::new("biometric-rollback-clear");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let mut config = enrolled_config();
        config.biometric_enrolled = false;
        save_security_config(&handle, &config).unwrap();
        crate::biometric::journal_cleanup_unless_enrolled(&handle).unwrap();

        crate::biometric::recover_pending_biometric_cleanup(&handle).unwrap();

        let journal = biometric_cleanup_journal(&handle);
        assert!(
            !journal.exists(),
            "completed cleanup must clear its journal"
        );
        assert!(!load_security_config(&handle).unwrap().biometric_enrolled);
    }

    /// `disable_biometric` and factory reset commit their intent before the
    /// configuration is known to be rewritten, so recovery must remove the
    /// credential even while the config still claims enrollment.
    #[test]
    fn unconditional_cleanup_clears_a_credential_despite_a_stale_enrolled_flag() {
        let _env = TestEnvGuard::new("biometric-reset-clear");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        save_security_config(&handle, &enrolled_config()).unwrap();
        crate::biometric::journal_unconditional_cleanup(&handle).unwrap();

        crate::biometric::recover_pending_biometric_cleanup(&handle).unwrap();

        let journal = biometric_cleanup_journal(&handle);
        assert!(
            !journal.exists(),
            "completed cleanup must clear its journal"
        );
        assert!(
            !load_security_config(&handle).unwrap().biometric_enrolled,
            "an interrupted reset must not leave the config claiming enrollment"
        );
    }

    /// The reset commits its configuration before deleting anything and clears
    /// both the credential and its journal on the way out.
    #[test]
    fn security_reset_journals_credential_removal_before_destroying_data() {
        let _env = TestEnvGuard::new("biometric-reset-order");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let key = derive_key("pw", b"salt1234salt1234", MIN_PBKDF2_ITERATIONS);
        let bookmarks = crate::bookmarks_path(&handle).unwrap();
        std::fs::write(&bookmarks, encrypt_text("[]", &key).unwrap()).unwrap();
        save_security_config(&handle, &enrolled_config()).unwrap();

        reset_security_inner(&handle, true).unwrap();

        assert!(
            !bookmarks.exists(),
            "confirmed reset must remove ciphertext"
        );
        assert!(
            !biometric_cleanup_journal(&handle).exists(),
            "a successful reset must complete and clear its cleanup journal"
        );
        let config = load_security_config(&handle).unwrap();
        assert!(!config.biometric_enrolled);
        assert!(!config.encryption_enabled);

        set_unlocked_key(None, 0).unwrap();
    }

    #[test]
    fn failed_journal_recovery_blocks_protected_io_and_retains_evidence() {
        let _env = TestEnvGuard::new("journal-fail-closed");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();

        let bookmarks = crate::bookmarks_path(&handle).unwrap();
        std::fs::write(&bookmarks, "[]").unwrap();
        let journal = crate::security_journal_path(&handle).unwrap();
        std::fs::write(&journal, "{not-valid-json").unwrap();

        assert!(recover_interrupted_migration(&handle).is_err());
        assert!(journal.exists(), "failed recovery must retain the journal");
        let err = read_protected_file(&bookmarks, "[]", &default_security_config())
            .expect_err("protected I/O must remain blocked");
        assert!(
            err.contains("migration recovery"),
            "unexpected error: {err}"
        );

        std::fs::remove_file(&journal).unwrap();
        recover_interrupted_migration(&handle).unwrap();
        assert_eq!(
            read_protected_file(&bookmarks, "[]", &default_security_config()).unwrap(),
            "[]"
        );
    }

    #[test]
    fn empty_existing_checkpoint_is_corruption_not_absence() {
        let _env = TestEnvGuard::new("empty-checkpoint");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();
        initialize_security_inner(&handle, false, None).unwrap();

        crate::save_transfer_checkpoint_json(&handle, "empty-checkpoint", "").unwrap();
        let err = crate::load_transfer_checkpoint_json(&handle, "empty-checkpoint")
            .expect_err("an existing empty checkpoint must fail closed");
        assert!(
            err.contains("exists but is empty"),
            "unexpected error: {err}"
        );
        assert!(
            crate::transfer_checkpoint_path(&handle, "empty-checkpoint")
                .unwrap()
                .exists(),
            "corrupt checkpoint evidence must be retained"
        );
    }

    #[test]
    fn factory_reset_removes_manifest_checkpoints_and_owned_scratch() {
        let _env = TestEnvGuard::new("factory-reset-transaction");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();
        initialize_security_inner(&handle, false, None).unwrap();
        let seeded = seed_managed_files(&handle);

        let destination = crate::resolved_app_data_dir(&handle)
            .unwrap()
            .join("download.bin");
        let scratch = crate::download_temp_path(&destination);
        std::fs::write(&scratch, b"partial").unwrap();
        let checkpoint = serde_json::json!({
            "temp_path": scratch.to_string_lossy(),
            "updated_at_ms": 1
        })
        .to_string();
        crate::save_transfer_checkpoint_json(&handle, "factory-reset", &checkpoint).unwrap();

        let status = factory_reset_inner(&handle, "{\"theme\":\"system\"}").unwrap();
        assert!(!status.initialized);
        assert!(!status.encryption_enabled);
        assert!(!scratch.exists(), "owned scratch file should be removed");
        for (path, _) in seeded {
            assert!(!path.exists(), "managed data survived: {}", path.display());
        }
        assert_eq!(
            std::fs::read_to_string(crate::settings_path(&handle).unwrap()).unwrap(),
            "{\"theme\":\"system\"}"
        );
        assert!(
            crate::load_transfer_checkpoint_json(&handle, "factory-reset")
                .unwrap()
                .is_none()
        );
        assert!(!factory_reset_journal_path(&handle).unwrap().exists());
    }

    #[test]
    fn interrupted_factory_reset_replays_partial_commit() {
        let _env = TestEnvGuard::new("factory-reset-recovery");
        let app = make_test_app();
        let _guard = TestAppDataGuard::new(&app);
        let handle = app.handle().clone();
        set_unlocked_key(None, 0).unwrap();
        initialize_security_inner(&handle, false, None).unwrap();
        let seeded = seed_managed_files(&handle);
        atomic_write(
            &crate::settings_path(&handle).unwrap(),
            "{\"theme\":\"dark\"}",
        )
        .unwrap();

        let journal = FactoryResetJournal {
            v: 1,
            settings_json: "{\"theme\":\"system\"}".to_string(),
            entries: managed_data_files(&handle)
                .unwrap()
                .iter()
                .map(|(id, _, _)| *id)
                .collect(),
            checkpoint_scratch_paths: Vec::new(),
        };
        let journal_path = factory_reset_journal_path(&handle).unwrap();
        atomic_write(
            &journal_path,
            &serde_json::to_string_pretty(&journal).unwrap(),
        )
        .unwrap();

        // Simulate a crash after only one side of the config/settings commit and
        // one destructive cleanup step reached disk.
        save_security_config(&handle, &default_security_config()).unwrap();
        remove_file_if_present(&seeded[0].0).unwrap();

        recover_interrupted_migration(&handle).unwrap();

        assert!(
            !journal_path.exists(),
            "recovery must clear the reset journal"
        );
        assert_eq!(
            std::fs::read_to_string(crate::settings_path(&handle).unwrap()).unwrap(),
            "{\"theme\":\"system\"}"
        );
        let config = load_security_config(&handle).unwrap();
        assert!(!config.initialized);
        assert!(!config.encryption_enabled);
        for (path, _) in seeded {
            assert!(
                !path.exists(),
                "managed data survived recovery: {}",
                path.display()
            );
        }
    }

    /// M11: key-derivation parameters read from disk are bounded.
    #[test]
    fn kdf_params_are_validated() {
        let mut config = SecurityConfig {
            initialized: true,
            encryption_enabled: true,
            salt: B64.encode(b"salt1234salt1234"),
            verifier: String::new(),
            lock_timeout_minutes: 0,
            pbkdf2_iterations: PBKDF2_ITERATIONS,
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: String::new(),
        };
        assert!(validate_kdf_params(&config).is_ok());

        config.pbkdf2_iterations = MIN_PBKDF2_ITERATIONS - 1;
        assert!(validate_kdf_params(&config).is_err(), "floor not enforced");

        config.pbkdf2_iterations = MAX_PBKDF2_ITERATIONS + 1;
        assert!(
            validate_kdf_params(&config).is_err(),
            "ceiling not enforced; a huge count would hang unlock"
        );

        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        config.salt = B64.encode(b"short");
        assert!(
            validate_kdf_params(&config).is_err(),
            "salt length not enforced"
        );
    }

    #[test]
    fn looks_encrypted_distinguishes_plaintext_from_payloads() {
        let key = derive_key("pw", b"salt1234salt1234", 1000);
        assert!(looks_encrypted(&encrypt_text("[]", &key).unwrap()));
        assert!(!looks_encrypted("[]"));
        assert!(!looks_encrypted("{\"name\":\"prod\"}"));
        assert!(!looks_encrypted(""));
        assert!(!looks_encrypted("   "));
    }
}
