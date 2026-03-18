use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

use crate::{atomic_write, bookmarks_backup_path, connection_path, lock_storage_ops, settings_path, security_path};

pub(crate) const PBKDF2_ITERATIONS: u32 = 210_000;
const MIN_PBKDF2_ITERATIONS: u32 = 100_000;
pub(crate) const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

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
}

fn default_pbkdf2_iterations() -> u32 {
    PBKDF2_ITERATIONS
}

#[derive(serde::Serialize)]
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

pub(crate) fn set_unlocked_key(key: Option<[u8; KEY_LEN]>, lock_timeout_secs: u64) -> Result<(), String> {
    let mut guard = key_state().lock().map_err(|_| "Internal key state error".to_string())?;
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

pub(crate) fn require_unlocked_key() -> Result<[u8; KEY_LEN], String> {
    let mut guard = key_state().lock().map_err(|_| "Internal key state error".to_string())?;
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
    Ok(key)
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
    }
}

pub(crate) fn load_security_config(app: &tauri::AppHandle) -> Result<SecurityConfig, String> {
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

pub(crate) fn save_security_config(app: &tauri::AppHandle, config: &SecurityConfig) -> Result<(), String> {
    let path = security_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
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
    if !path.exists() {
        return Ok(default_value.to_string());
    }

    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !security.encryption_enabled {
        return Ok(raw);
    }

    let key = require_unlocked_key()?;
    decrypt_text(&raw, &key)
}

pub(crate) fn write_protected_file(
    path: &std::path::Path,
    json: &str,
    security: &SecurityConfig,
) -> Result<(), String> {
    let output = if security.encryption_enabled {
        let key = require_unlocked_key()?;
        encrypt_text(json, &key)?
    } else {
        json.to_string()
    };

    atomic_write(path, &output)
}

struct MigrationPlan {
    path: std::path::PathBuf,
    original: String,
    transformed: String,
}

fn managed_data_files(
    app: &tauri::AppHandle,
) -> Result<Vec<(std::path::PathBuf, &'static str)>, String> {
    let settings = settings_path(app)?;
    let connection = connection_path(app)?;
    let bookmarks_backup = bookmarks_backup_path(app)?;
    Ok(vec![
        (settings, "{}"),
        (connection, ""),
        (bookmarks_backup, "[]"),
    ])
}

fn build_migration_plans(
    app: &tauri::AppHandle,
    enable_encryption: bool,
    key: &[u8; KEY_LEN],
) -> Result<Vec<MigrationPlan>, String> {
    let mut plans = Vec::new();

    for (path, default_value) in managed_data_files(app)? {
        if !path.exists() {
            continue;
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let next = if enable_encryption {
            encrypt_text(&raw, key)?
        } else {
            if raw.trim().is_empty() {
                default_value.to_string()
            } else {
                decrypt_text(&raw, key)?
            }
        };

        plans.push(MigrationPlan {
            path,
            original: raw,
            transformed: next,
        });
    }

    Ok(plans)
}

fn build_rekey_plans(
    app: &tauri::AppHandle,
    old_key: &[u8; KEY_LEN],
    new_key: &[u8; KEY_LEN],
) -> Result<Vec<MigrationPlan>, String> {
    let mut plans = Vec::new();

    for (path, _) in managed_data_files(app)? {
        if !path.exists() {
            continue;
        }

        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let plain = if raw.trim().is_empty() {
            String::new()
        } else {
            decrypt_text(&raw, old_key)?
        };
        let next = encrypt_text(&plain, new_key)?;

        plans.push(MigrationPlan {
            path,
            original: raw,
            transformed: next,
        });
    }

    Ok(plans)
}

fn rollback_migration(plans: &[MigrationPlan], upto: usize) -> Result<(), String> {
    for plan in plans.iter().take(upto).rev() {
        atomic_write(&plan.path, &plan.original)?;
    }
    Ok(())
}

fn apply_migration(plans: &[MigrationPlan]) -> Result<(), String> {
    for (idx, plan) in plans.iter().enumerate() {
        if let Err(err) = atomic_write(&plan.path, &plan.transformed) {
            if let Err(rb_err) = rollback_migration(plans, idx) {
                return Err(format!(
                    "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                    err, rb_err
                ));
            }
            return Err(err);
        }
    }
    Ok(())
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

#[tauri::command]
pub(crate) async fn get_security_status(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let config = load_security_config(&app)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn initialize_security(
    app: tauri::AppHandle,
    enable_encryption: bool,
    password: Option<String>,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let current = load_security_config(&app)?;
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
        };
        set_unlocked_key(None, 0)?;
        save_security_config(&app, &config)?;
        return Ok(security_status(&config));
    }

    let pw = password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Password is required to enable encryption".to_string())?;
    if pw.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
    let mut verifier = key_verifier(&key);

    let plans = build_migration_plans(&app, true, &key)?;
    apply_migration(&plans)?;

    let config = SecurityConfig {
        initialized: true,
        encryption_enabled: true,
        salt: B64.encode(salt),
        verifier: B64.encode(verifier),
        lock_timeout_minutes: 0,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
        biometric_enrolled: false,
    };
    verifier.zeroize();
    if let Err(err) = save_security_config(&app, &config) {
        key.zeroize();
        if let Err(rb_err) = rollback_migration(&plans, plans.len()) {
            return Err(format!(
                "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                err, rb_err
            ));
        }
        return Err(err);
    }
    set_unlocked_key(Some(key), 0)?;
    key.zeroize();
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn unlock_security(app: tauri::AppHandle, password: String) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.initialized || !config.encryption_enabled {
        set_unlocked_key(None, 0)?;
        return Ok(security_status(&config));
    }

    let salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if expected_verifier.len() != KEY_LEN {
        return Err("Invalid security verifier length".to_string());
    }

    if config.pbkdf2_iterations < MIN_PBKDF2_ITERATIONS {
        return Err(
            "Security configuration appears corrupted (iteration count too low). Please reset security.".to_string(),
        );
    }

    let mut key = derive_key(&password, &salt, config.pbkdf2_iterations);
    let mut verifier = key_verifier(&key);
    if !constant_time_eq(verifier.as_slice(), expected_verifier.as_slice()) {
        key.zeroize();
        verifier.zeroize();
        return Err("Invalid password".to_string());
    }
    verifier.zeroize();

    let timeout_secs = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(key), timeout_secs)?;

    if config.pbkdf2_iterations < PBKDF2_ITERATIONS {
        let mut new_salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut new_salt);
        let mut new_key = derive_key(&password, &new_salt, PBKDF2_ITERATIONS);
        let mut new_verifier = key_verifier(&new_key);

        let plans = build_rekey_plans(&app, &key, &new_key)?;
        apply_migration(&plans)?;

        config.salt = B64.encode(new_salt);
        config.verifier = B64.encode(new_verifier);
        new_verifier.zeroize();
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        if let Err(err) = save_security_config(&app, &config) {
            new_key.zeroize();
            if let Err(rb_err) = rollback_migration(&plans, plans.len()) {
                return Err(format!(
                    "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                    err, rb_err
                ));
            }
            return Err(err);
        }
        set_unlocked_key(Some(new_key), timeout_secs)?;
        new_key.zeroize();
    }
    key.zeroize();

    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn set_security_encryption(
    app: tauri::AppHandle,
    enable_encryption: bool,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.initialized {
        return Err("Security is not initialized".to_string());
    }
    if config.encryption_enabled == enable_encryption {
        return Ok(security_status(&config));
    }

    if enable_encryption {
        let pw = new_password
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "New password is required".to_string())?;
        if pw.len() < 8 {
            return Err("Password must be at least 8 characters".to_string());
        }
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let mut key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
        let mut verifier = key_verifier(&key);

        let plans = build_migration_plans(&app, true, &key)?;
        apply_migration(&plans)?;
        config.encryption_enabled = true;
        config.salt = B64.encode(salt);
        config.verifier = B64.encode(verifier);
        verifier.zeroize();
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        if let Err(err) = save_security_config(&app, &config) {
            key.zeroize();
            if let Err(rb_err) = rollback_migration(&plans, plans.len()) {
                return Err(format!(
                    "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                    err, rb_err
                ));
            }
            return Err(err);
        }
        set_unlocked_key(Some(key), config.lock_timeout_minutes as u64 * 60)?;
        key.zeroize();
        return Ok(security_status(&config));
    }

    let current_password = current_password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Current password is required".to_string())?;
    let salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    let mut key = derive_key(&current_password, &salt, config.pbkdf2_iterations);
    let mut verifier = key_verifier(&key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if !constant_time_eq(verifier.as_slice(), expected_verifier.as_slice()) {
        key.zeroize();
        verifier.zeroize();
        return Err("Invalid password".to_string());
    }
    verifier.zeroize();

    let plans = build_migration_plans(&app, false, &key)?;
    apply_migration(&plans)?;
    key.zeroize();

    if config.biometric_enrolled {
        crate::biometric::clear_stored_key();
        config.biometric_enrolled = false;
    }

    config.encryption_enabled = false;
    config.salt.clear();
    config.verifier.clear();
    if let Err(err) = save_security_config(&app, &config) {
        if let Err(rb_err) = rollback_migration(&plans, plans.len()) {
            return Err(format!(
                "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                err, rb_err
            ));
        }
        return Err(err);
    }
    set_unlocked_key(None, 0)?;
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn change_security_password(
    app: tauri::AppHandle,
    current_password: String,
    new_password: String,
) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    if !config.initialized || !config.encryption_enabled {
        return Err("Encryption is not enabled".to_string());
    }
    if new_password.is_empty() {
        return Err("New password cannot be empty".to_string());
    }
    if new_password.len() < 8 {
        return Err("New password must be at least 8 characters".to_string());
    }

    let old_salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    let mut old_key = derive_key(&current_password, &old_salt, config.pbkdf2_iterations);
    let mut old_verifier = key_verifier(&old_key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if !constant_time_eq(old_verifier.as_slice(), expected_verifier.as_slice()) {
        old_key.zeroize();
        old_verifier.zeroize();
        return Err("Invalid password".to_string());
    }
    old_verifier.zeroize();

    let mut new_salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut new_salt);
    let mut new_key = derive_key(&new_password, &new_salt, PBKDF2_ITERATIONS);
    let mut new_verifier = key_verifier(&new_key);

    let plans = build_rekey_plans(&app, &old_key, &new_key)?;
    apply_migration(&plans)?;
    old_key.zeroize();

    if config.biometric_enrolled {
        crate::biometric::clear_stored_key();
        config.biometric_enrolled = false;
    }

    config.salt = B64.encode(new_salt);
    config.verifier = B64.encode(new_verifier);
    new_verifier.zeroize();
    config.pbkdf2_iterations = PBKDF2_ITERATIONS;
    if let Err(err) = save_security_config(&app, &config) {
        new_key.zeroize();
        if let Err(rb_err) = rollback_migration(&plans, plans.len()) {
            return Err(format!(
                "{}. CRITICAL: Rollback also failed: {}. Manual recovery may be needed.",
                err, rb_err
            ));
        }
        return Err(err);
    }
    set_unlocked_key(Some(new_key), config.lock_timeout_minutes as u64 * 60)?;
    new_key.zeroize();

    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn lock_security(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let config = load_security_config(&app)?;
    if config.encryption_enabled {
        set_unlocked_key(None, 0)?;
    }
    Ok(security_status(&config))
}

#[tauri::command]
pub(crate) async fn set_lock_timeout(app: tauri::AppHandle, minutes: u16) -> Result<SecurityStatus, String> {
    let _storage_guard = lock_storage_ops()?;
    let mut config = load_security_config(&app)?;
    config.lock_timeout_minutes = minutes;
    save_security_config(&app, &config)?;
    let mut guard = key_state().lock().map_err(|_| "Internal key state error".to_string())?;
    guard.lock_timeout_secs = minutes as u64 * 60;
    drop(guard);
    Ok(security_status(&config))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
