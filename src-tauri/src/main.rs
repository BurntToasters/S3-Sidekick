#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use aws_sdk_s3::types::MetadataDirective;
use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use zeroize::Zeroize;

const PBKDF2_ITERATIONS: u32 = 210_000;
const MIN_PBKDF2_ITERATIONS: u32 = 100_000;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

struct KeyState {
    key: Option<[u8; KEY_LEN]>,
    last_activity: Option<Instant>,
    lock_timeout_secs: u64,
}

static KEY_STATE: OnceLock<Mutex<KeyState>> = OnceLock::new();
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

struct S3State {
    client: Option<Client>,
    endpoint: String,
    region: String,
}

struct AppState(Mutex<S3State>);

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SecurityConfig {
    initialized: bool,
    encryption_enabled: bool,
    salt: String,
    verifier: String,
    #[serde(default)]
    lock_timeout_minutes: u16,
    #[serde(default = "default_pbkdf2_iterations")]
    pbkdf2_iterations: u32,
}

fn default_pbkdf2_iterations() -> u32 {
    PBKDF2_ITERATIONS
}

#[derive(serde::Serialize)]
struct SecurityStatus {
    initialized: bool,
    encryption_enabled: bool,
    unlocked: bool,
    lock_timeout_minutes: u16,
}

#[derive(serde::Serialize)]
struct UpdaterSupportInfo {
    mode: String,
    release_url: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct EncryptedPayload {
    v: u8,
    nonce: String,
    ciphertext: String,
}

#[derive(serde::Serialize)]
struct BucketInfo {
    name: String,
    creation_date: String,
}

#[derive(serde::Serialize)]
struct ObjectInfo {
    key: String,
    size: i64,
    last_modified: String,
    is_folder: bool,
}

#[derive(serde::Serialize)]
struct ListObjectsResponse {
    objects: Vec<ObjectInfo>,
    prefixes: Vec<String>,
    truncated: bool,
    next_continuation_token: String,
}

#[derive(serde::Serialize)]
struct LocalFileEntry {
    file_path: String,
    relative_path: String,
    size: u64,
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn connection_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connection.json"))
}

fn bookmarks_backup_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bookmarks.json.bak"))
}

fn security_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("security.json"))
}

fn parse_user_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{} path is required", label));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{} path must be absolute: {}", label, trimmed));
    }
    Ok(path)
}

fn validate_existing_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = parse_user_path(raw, label)?;
    if !path.exists() {
        return Err(format!("{} path does not exist: {}", label, path.display()));
    }
    Ok(path)
}

fn validate_destination_path(raw: &str) -> Result<PathBuf, String> {
    let destination = parse_user_path(raw, "Destination")?;
    if destination.exists() {
        return Err(format!(
            "Destination already exists: {}",
            destination.display()
        ));
    }
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
    Ok(destination)
}

fn make_temp_path(path: &Path, purpose: &str) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let suffix = format!("{}.{}.{}.tmp", purpose, pid, counter);
    let extension = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", ext, suffix),
        _ => suffix,
    };
    path.with_extension(extension)
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
    let mut guard = key_state().lock().unwrap_or_else(|e| e.into_inner());
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

fn set_unlocked_key(key: Option<[u8; KEY_LEN]>, lock_timeout_secs: u64) -> Result<(), String> {
    let mut guard = key_state().lock().unwrap_or_else(|e| e.into_inner());
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

fn require_unlocked_key() -> Result<[u8; KEY_LEN], String> {
    let mut guard = key_state().lock().unwrap_or_else(|e| e.into_inner());
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
    }
}

fn load_security_config(app: &tauri::AppHandle) -> Result<SecurityConfig, String> {
    let path = security_path(app)?;
    if !path.exists() {
        return Ok(default_security_config());
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<SecurityConfig>(&raw)
        .map_err(|e| format!("Invalid security config: {}", e))
}

fn save_security_config(app: &tauri::AppHandle, config: &SecurityConfig) -> Result<(), String> {
    let path = security_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    let tmp_path = make_temp_path(path, "atomic");
    let mut tmp_file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp_path)
        .map_err(|e| e.to_string())?;
    tmp_file
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp_file.sync_all().map_err(|e| e.to_string())?;
    drop(tmp_file);
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.to_string());
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

fn key_verifier(key: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"s3-sidekick-vault-verifier");
    let digest = hasher.finalize();
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&digest[..KEY_LEN]);
    out
}

fn encrypt_text(plain: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
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

fn decrypt_text(encoded: &str, key: &[u8; KEY_LEN]) -> Result<String, String> {
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

fn read_protected_file(
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

fn write_protected_file(
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
            let _ = rollback_migration(plans, idx);
            return Err(err);
        }
    }
    Ok(())
}

fn security_status(config: &SecurityConfig) -> SecurityStatus {
    SecurityStatus {
        initialized: config.initialized,
        encryption_enabled: config.encryption_enabled,
        unlocked: is_unlocked(),
        lock_timeout_minutes: config.lock_timeout_minutes,
    }
}

use tauri::{Emitter, Manager};

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "{}", &security)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn load_connection(app: tauri::AppHandle) -> Result<String, String> {
    let path = connection_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "", &security)
}

#[tauri::command]
fn save_connection(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = connection_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn load_bookmarks_backup(app: tauri::AppHandle) -> Result<String, String> {
    let path = bookmarks_backup_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "[]", &security)
}

#[tauri::command]
fn save_bookmarks_backup(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = bookmarks_backup_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn get_security_status(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let config = load_security_config(&app)?;
    Ok(security_status(&config))
}

#[tauri::command]
fn initialize_security(
    app: tauri::AppHandle,
    enable_encryption: bool,
    password: Option<String>,
) -> Result<SecurityStatus, String> {
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
    let key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
    let verifier = key_verifier(&key);

    let plans = build_migration_plans(&app, true, &key)?;
    apply_migration(&plans)?;

    let config = SecurityConfig {
        initialized: true,
        encryption_enabled: true,
        salt: B64.encode(salt),
        verifier: B64.encode(verifier),
        lock_timeout_minutes: 0,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
    };
    if let Err(err) = save_security_config(&app, &config) {
        let _ = rollback_migration(&plans, plans.len());
        return Err(err);
    }
    set_unlocked_key(Some(key), 0)?;
    Ok(security_status(&config))
}

#[tauri::command]
fn unlock_security(app: tauri::AppHandle, password: String) -> Result<SecurityStatus, String> {
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

    let key = derive_key(&password, &salt, config.pbkdf2_iterations);
    let verifier = key_verifier(&key);
    if verifier.as_slice() != expected_verifier.as_slice() {
        return Err("Invalid password".to_string());
    }

    let timeout_secs = config.lock_timeout_minutes as u64 * 60;
    set_unlocked_key(Some(key), timeout_secs)?;

    if config.pbkdf2_iterations < PBKDF2_ITERATIONS {
        let mut new_salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(&password, &new_salt, PBKDF2_ITERATIONS);
        let new_verifier = key_verifier(&new_key);

        let plans = build_rekey_plans(&app, &key, &new_key)?;
        apply_migration(&plans)?;

        config.salt = B64.encode(new_salt);
        config.verifier = B64.encode(new_verifier);
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        if let Err(err) = save_security_config(&app, &config) {
            let _ = rollback_migration(&plans, plans.len());
            return Err(err);
        }
        set_unlocked_key(Some(new_key), timeout_secs)?;
    }

    Ok(security_status(&config))
}

#[tauri::command]
fn set_security_encryption(
    app: tauri::AppHandle,
    enable_encryption: bool,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<SecurityStatus, String> {
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
        let key = derive_key(&pw, &salt, PBKDF2_ITERATIONS);
        let verifier = key_verifier(&key);

        let plans = build_migration_plans(&app, true, &key)?;
        apply_migration(&plans)?;
        config.encryption_enabled = true;
        config.salt = B64.encode(salt);
        config.verifier = B64.encode(verifier);
        config.pbkdf2_iterations = PBKDF2_ITERATIONS;
        if let Err(err) = save_security_config(&app, &config) {
            let _ = rollback_migration(&plans, plans.len());
            return Err(err);
        }
        set_unlocked_key(Some(key), config.lock_timeout_minutes as u64 * 60)?;
        return Ok(security_status(&config));
    }

    let current_password = current_password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Current password is required".to_string())?;
    let salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    let key = derive_key(&current_password, &salt, config.pbkdf2_iterations);
    let verifier = key_verifier(&key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if verifier.as_slice() != expected_verifier.as_slice() {
        return Err("Invalid password".to_string());
    }

    let plans = build_migration_plans(&app, false, &key)?;
    apply_migration(&plans)?;
    config.encryption_enabled = false;
    config.salt.clear();
    config.verifier.clear();
    if let Err(err) = save_security_config(&app, &config) {
        let _ = rollback_migration(&plans, plans.len());
        return Err(err);
    }
    set_unlocked_key(None, 0)?;
    Ok(security_status(&config))
}

#[tauri::command]
fn change_security_password(
    app: tauri::AppHandle,
    current_password: String,
    new_password: String,
) -> Result<SecurityStatus, String> {
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
    let old_key = derive_key(&current_password, &old_salt, config.pbkdf2_iterations);
    let old_verifier = key_verifier(&old_key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if old_verifier.as_slice() != expected_verifier.as_slice() {
        return Err("Invalid password".to_string());
    }

    let mut new_salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut new_salt);
    let new_key = derive_key(&new_password, &new_salt, PBKDF2_ITERATIONS);
    let new_verifier = key_verifier(&new_key);

    let plans = build_rekey_plans(&app, &old_key, &new_key)?;
    apply_migration(&plans)?;

    config.salt = B64.encode(new_salt);
    config.verifier = B64.encode(new_verifier);
    config.pbkdf2_iterations = PBKDF2_ITERATIONS;
    if let Err(err) = save_security_config(&app, &config) {
        let _ = rollback_migration(&plans, plans.len());
        return Err(err);
    }
    set_unlocked_key(Some(new_key), config.lock_timeout_minutes as u64 * 60)?;

    Ok(security_status(&config))
}

#[tauri::command]
fn lock_security(app: tauri::AppHandle) -> Result<SecurityStatus, String> {
    let config = load_security_config(&app)?;
    if config.encryption_enabled {
        set_unlocked_key(None, 0)?;
    }
    Ok(security_status(&config))
}

#[tauri::command]
fn set_lock_timeout(app: tauri::AppHandle, minutes: u16) -> Result<SecurityStatus, String> {
    let mut config = load_security_config(&app)?;
    config.lock_timeout_minutes = minutes;
    save_security_config(&app, &config)?;
    if let Ok(mut guard) = key_state().lock() {
        guard.lock_timeout_secs = minutes as u64 * 60;
    }
    Ok(security_status(&config))
}

#[tauri::command]
async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    let creds =
        aws_sdk_s3::config::Credentials::new(&access_key, &secret_key, None, None, "s3-sidekick");

    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(&endpoint)
        .region(aws_sdk_s3::config::Region::new(region.clone()))
        .credentials_provider(creds)
        .force_path_style(true)
        .behavior_version_latest()
        .build();

    let client = Client::from_conf(config);

    client
        .list_buckets()
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    let mut s3 = state.0.lock().map_err(|e| e.to_string())?;
    s3.client = Some(client);
    s3.endpoint = endpoint;
    s3.region = region;

    Ok(())
}

#[tauri::command]
fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut s3 = state.0.lock().map_err(|e| e.to_string())?;
    s3.client = None;
    s3.endpoint.clear();
    s3.region.clear();
    Ok(())
}

#[tauri::command]
async fn list_buckets(state: tauri::State<'_, AppState>) -> Result<Vec<BucketInfo>, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .list_buckets()
        .send()
        .await
        .map_err(|e| format!("Failed to list buckets: {}", e))?;

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

#[tauri::command]
async fn list_objects(
    state: tauri::State<'_, AppState>,
    bucket: String,
    prefix: String,
    delimiter: String,
    continuation_token: String,
) -> Result<ListObjectsResponse, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let mut req = client.list_objects_v2().bucket(&bucket).max_keys(1000);

    if !prefix.is_empty() {
        req = req.prefix(&prefix);
    }
    if !delimiter.is_empty() {
        req = req.delimiter(&delimiter);
    }
    if !continuation_token.is_empty() {
        req = req.continuation_token(&continuation_token);
    }

    let output = req
        .send()
        .await
        .map_err(|e| format!("Failed to list objects: {}", e))?;

    let objects = output
        .contents()
        .iter()
        .map(|obj| {
            let key = obj.key().unwrap_or_default().to_string();
            let is_folder = key.ends_with('/');
            ObjectInfo {
                key,
                size: obj.size().unwrap_or(0),
                last_modified: obj
                    .last_modified()
                    .map(|d| d.to_string())
                    .unwrap_or_default(),
                is_folder,
            }
        })
        .collect();

    let prefixes = output
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|s| s.to_string()))
        .collect();

    let truncated = output.is_truncated().unwrap_or(false);
    let next_continuation_token = output.next_continuation_token().unwrap_or("").to_string();

    Ok(ListObjectsResponse {
        objects,
        prefixes,
        truncated,
        next_continuation_token,
    })
}

#[derive(serde::Serialize)]
struct HeadObjectResponse {
    content_type: String,
    content_length: i64,
    last_modified: String,
    etag: String,
    storage_class: String,
    cache_control: String,
    content_disposition: String,
    content_encoding: String,
    server_side_encryption: String,
    metadata: HashMap<String, String>,
}

#[derive(serde::Serialize)]
struct AclGrant {
    grantee: String,
    permission: String,
}

#[derive(serde::Serialize)]
struct AclResponse {
    owner: String,
    grants: Vec<AclGrant>,
}

#[derive(serde::Serialize, Clone)]
struct UploadProgress {
    transfer_id: u32,
    bytes_sent: u64,
    total_bytes: u64,
}

#[derive(serde::Serialize)]
struct PreviewResponse {
    content_type: String,
    data: String,
    is_text: bool,
    truncated: bool,
    total_size: i64,
}

fn is_text_content_type(ct: &str) -> bool {
    ct.starts_with("text/")
        || ct == "application/json"
        || ct == "application/xml"
        || ct == "application/javascript"
        || ct == "image/svg+xml"
        || ct == "application/x-yaml"
        || ct == "application/toml"
}

const MULTIPART_THRESHOLD: u64 = 50 * 1024 * 1024;
const PART_SIZE: usize = 10 * 1024 * 1024;

#[tauri::command]
async fn head_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<HeadObjectResponse, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let metadata = output
        .metadata()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    Ok(HeadObjectResponse {
        content_type: output.content_type().unwrap_or("").to_string(),
        content_length: output.content_length().unwrap_or(0),
        last_modified: output
            .last_modified()
            .map(|d| d.to_string())
            .unwrap_or_default(),
        etag: output.e_tag().unwrap_or("").to_string(),
        storage_class: output
            .storage_class()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        cache_control: output.cache_control().unwrap_or("").to_string(),
        content_disposition: output.content_disposition().unwrap_or("").to_string(),
        content_encoding: output.content_encoding().unwrap_or("").to_string(),
        server_side_encryption: output
            .server_side_encryption()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        metadata,
    })
}

#[tauri::command]
async fn update_metadata(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    content_type: String,
    metadata: HashMap<String, String>,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let source = encode_copy_source(&bucket, &key);
    let mut req = client
        .copy_object()
        .bucket(&bucket)
        .key(&key)
        .copy_source(&source)
        .content_type(&content_type)
        .metadata_directive(MetadataDirective::Replace);

    for (k, v) in &metadata {
        req = req.metadata(k, v);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to update metadata: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn delete_objects(
    state: tauri::State<'_, AppState>,
    bucket: String,
    keys: Vec<String>,
) -> Result<u32, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let mut deleted = 0u32;
    for key in &keys {
        client
            .delete_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to delete {}: {}", key, e))?;
        deleted += 1;
    }

    Ok(deleted)
}

#[tauri::command]
async fn upload_object(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
    transfer_id: u32,
) -> Result<(), String> {
    let upload_path = validate_existing_path(&file_path, "Upload file")?;

    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let file_size = tokio::fs::metadata(&upload_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: 0,
            total_bytes: file_size,
        },
    );

    if file_size >= MULTIPART_THRESHOLD {
        upload_multipart(
            &app,
            &client,
            &bucket,
            &key,
            &upload_path,
            &content_type,
            transfer_id,
            file_size,
        )
        .await?;
    } else {
        let body = aws_sdk_s3::primitives::ByteStream::from_path(upload_path.as_path())
            .await
            .map_err(|e| format!("Failed to open file stream: {}", e))?;

        let mut req = client.put_object().bucket(&bucket).key(&key).body(body);

        if !content_type.is_empty() {
            req = req.content_type(&content_type);
        }

        req.send()
            .await
            .map_err(|e| format!("Failed to upload: {}", e))?;
    }

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: file_size,
            total_bytes: file_size,
        },
    );

    Ok(())
}

async fn upload_multipart(
    app: &tauri::AppHandle,
    client: &Client,
    bucket: &str,
    key: &str,
    file_path: &Path,
    content_type: &str,
    transfer_id: u32,
    file_size: u64,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let mut create_req = client.create_multipart_upload().bucket(bucket).key(key);
    if !content_type.is_empty() {
        create_req = create_req.content_type(content_type);
    }

    let create_output = create_req
        .send()
        .await
        .map_err(|e| format!("Failed to create multipart upload: {}", e))?;

    let upload_id = create_output
        .upload_id()
        .ok_or("No upload ID returned")?
        .to_string();

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut completed_parts = Vec::new();
    let mut part_number = 1i32;
    let mut bytes_sent = 0u64;

    loop {
        let mut buf = vec![0u8; PART_SIZE];
        let mut read = 0;
        while read < PART_SIZE {
            let n = file
                .read(&mut buf[read..])
                .await
                .map_err(|e| format!("Failed to read file: {}", e))?;
            if n == 0 {
                break;
            }
            read += n;
        }
        if read == 0 {
            break;
        }
        buf.truncate(read);

        let body = aws_sdk_s3::primitives::ByteStream::from(buf);
        let part_output = client
            .upload_part()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(body)
            .send()
            .await;

        match part_output {
            Ok(output) => {
                let etag = output.e_tag().unwrap_or_default().to_string();
                completed_parts.push(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .part_number(part_number)
                        .e_tag(etag)
                        .build(),
                );
                bytes_sent += read as u64;
                let _ = app.emit(
                    "upload-progress",
                    UploadProgress {
                        transfer_id,
                        bytes_sent,
                        total_bytes: file_size,
                    },
                );
                part_number += 1;
            }
            Err(e) => {
                let _ = client
                    .abort_multipart_upload()
                    .bucket(bucket)
                    .key(key)
                    .upload_id(&upload_id)
                    .send()
                    .await;
                return Err(format!("Failed to upload part {}: {}", part_number, e));
            }
        }
    }

    let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();

    client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(completed_upload)
        .send()
        .await
        .map_err(|e| format!("Failed to complete multipart upload: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn upload_object_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    bytes: Vec<u8>,
    content_type: String,
    transfer_id: u32,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let total = bytes.len() as u64;
    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: 0,
            total_bytes: total,
        },
    );

    let mut req = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(bytes));

    if !content_type.is_empty() {
        req = req.content_type(&content_type);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to upload: {}", e))?;

    let _ = app.emit(
        "upload-progress",
        UploadProgress {
            transfer_id,
            bytes_sent: total,
            total_bytes: total,
        },
    );

    Ok(())
}

#[tauri::command]
async fn get_object_acl(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<AclResponse, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .get_object_acl()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get ACL: {}", e))?;

    let owner = output
        .owner()
        .and_then(|o| o.display_name())
        .unwrap_or("")
        .to_string();

    let grants = output
        .grants()
        .iter()
        .map(|g| {
            let grantee = g
                .grantee()
                .map(|gr| {
                    gr.display_name()
                        .or(gr.uri())
                        .or(gr.id())
                        .unwrap_or("Unknown")
                        .to_string()
                })
                .unwrap_or_default();
            let permission = g
                .permission()
                .map(|p| p.as_str().to_string())
                .unwrap_or_default();
            AclGrant {
                grantee,
                permission,
            }
        })
        .collect();

    Ok(AclResponse { owner, grants })
}

#[tauri::command]
async fn download_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    destination: String,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let destination_path = validate_destination_path(&destination)?;
    let temp_path = make_temp_path(&destination_path, "download");

    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let output = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    let mut reader = output.body.into_async_read();
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    let mut written = 0u64;
    let mut buf = [0u8; 64 * 1024];

    loop {
        let count = reader
            .read(&mut buf)
            .await
            .map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                format!("Failed to read body: {}", e)
            })?;
        if count == 0 {
            break;
        }

        file.write_all(&buf[..count]).await.map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to write temp file: {}", e)
        })?;
        written += count as u64;
    }

    file.flush().await.map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to flush temp file: {}", e)
    })?;
    file.sync_all().await.map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to sync temp file: {}", e)
    })?;
    drop(file);

    if let Err(e) = std::fs::rename(&temp_path, &destination_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to finalize download: {}", e));
    }

    Ok(written)
}

#[tauri::command]
async fn create_folder(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let folder_key = if key.ends_with('/') {
        key
    } else {
        format!("{}/", key)
    };

    client
        .put_object()
        .bucket(&bucket)
        .key(&folder_key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn rename_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    old_key: String,
    new_key: String,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let source = encode_copy_source(&bucket, &old_key);
    client
        .copy_object()
        .bucket(&bucket)
        .key(&new_key)
        .copy_source(&source)
        .send()
        .await
        .map_err(|e| format!("Failed to copy: {}", e))?;

    client
        .delete_object()
        .bucket(&bucket)
        .key(&old_key)
        .send()
        .await
        .map_err(|e| format!("Failed to delete original: {}", e))?;

    Ok(())
}

fn encode_copy_source(bucket: &str, key: &str) -> String {
    let encoded_bucket = urlencoding::encode(bucket);
    let encoded_key = key
        .split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!("{}/{}", encoded_bucket, encoded_key)
}

#[tauri::command]
fn build_object_url(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<String, String> {
    let s3 = state.0.lock().map_err(|e| e.to_string())?;
    if s3.endpoint.is_empty() {
        return Err("Not connected".to_string());
    }
    let base = s3.endpoint.trim_end_matches('/');
    let encoded_bucket = urlencoding::encode(&bucket);
    let encoded_key = key
        .split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{}/{}/{}", base, encoded_bucket, encoded_key))
}

#[tauri::command]
async fn generate_presigned_url(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    expires_in_secs: u64,
) -> Result<String, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let presigning_config =
        aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(expires_in_secs))
            .map_err(|e| format!("Invalid expiration: {}", e))?;

    let presigned = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .presigned(presigning_config)
        .await
        .map_err(|e| format!("Failed to generate presigned URL: {}", e))?;

    Ok(presigned.uri().to_string())
}

#[tauri::command]
async fn preview_object(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<PreviewResponse, String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let head = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to get object info: {}", e))?;

    let total_size = head.content_length().unwrap_or(0);
    let content_type = head
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();

    const MAX_PREVIEW: i64 = 1_048_576;
    let truncated = total_size > MAX_PREVIEW;

    let mut req = client.get_object().bucket(&bucket).key(&key);
    if truncated {
        req = req.range(format!("bytes=0-{}", MAX_PREVIEW - 1));
    }

    let output = req
        .send()
        .await
        .map_err(|e| format!("Failed to download preview: {}", e))?;

    let bytes = output
        .body
        .collect()
        .await
        .map_err(|e| format!("Failed to read preview body: {}", e))?
        .into_bytes();

    let is_text = is_text_content_type(&content_type);

    let data = if is_text {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        B64.encode(&bytes)
    };

    Ok(PreviewResponse {
        content_type,
        data,
        is_text,
        truncated,
        total_size,
    })
}

fn normalize_slashes(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn absolute_path_string(path: &std::path::Path) -> String {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical.to_string_lossy().to_string();
    }
    if path.is_absolute() {
        return path.to_string_lossy().to_string();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path).to_string_lossy().to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

fn root_label(root: &std::path::Path) -> String {
    if let Some(name) = root.file_name().and_then(|n| n.to_str()) {
        if !name.is_empty() {
            return name.to_string();
        }
    }

    let normalized = normalize_slashes(root);
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("root")
        .to_string()
}

fn collect_local_files_from_root(
    root: &std::path::Path,
    label: &str,
    entries: &mut Vec<LocalFileEntry>,
    warnings: &mut Vec<String>,
) {
    let root_meta = match std::fs::metadata(root) {
        Ok(meta) => meta,
        Err(err) => {
            warnings.push(format!(
                "Cannot access selected path '{}': {}",
                root.to_string_lossy(),
                err
            ));
            return;
        }
    };

    if root_meta.is_file() {
        entries.push(LocalFileEntry {
            file_path: absolute_path_string(root),
            relative_path: normalize_slashes(std::path::Path::new(label)),
            size: root_meta.len(),
        });
        return;
    }
    if !root_meta.is_dir() {
        return;
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let iter = match std::fs::read_dir(&dir) {
            Ok(iter) => iter,
            Err(err) => {
                warnings.push(format!(
                    "Cannot read directory '{}': {}",
                    dir.to_string_lossy(),
                    err
                ));
                continue;
            }
        };

        for entry_result in iter {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot read directory entry in '{}': {}",
                        dir.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot inspect '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot read metadata for '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };

            let rel_under_root = match path.strip_prefix(root) {
                Ok(rel) => rel,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot build relative path for '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };
            let rel_with_root = std::path::Path::new(label).join(rel_under_root);

            entries.push(LocalFileEntry {
                file_path: absolute_path_string(&path),
                relative_path: normalize_slashes(&rel_with_root),
                size: meta.len(),
            });
        }
    }
}

#[tauri::command]
fn list_local_files_recursive(roots: Vec<String>) -> Result<Vec<LocalFileEntry>, String> {
    let mut normalized_roots = Vec::new();
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            continue;
        }
        normalized_roots.push(validate_existing_path(trimmed, "Selected root")?);
    }

    if normalized_roots.is_empty() {
        return Ok(Vec::new());
    }

    let mut base_counts: HashMap<String, usize> = HashMap::new();
    for root in &normalized_roots {
        let base = root_label(root);
        *base_counts.entry(base).or_insert(0) += 1;
    }

    let mut duplicate_positions: HashMap<String, usize> = HashMap::new();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for root in &normalized_roots {
        let base = root_label(root);
        let total = *base_counts.get(&base).unwrap_or(&1);
        let label = if total > 1 {
            let next = duplicate_positions.entry(base.clone()).or_insert(0);
            *next += 1;
            format!("{} ({})", base, next)
        } else {
            base
        };
        collect_local_files_from_root(root, &label, &mut entries, &mut warnings);
    }

    entries.sort_by(|a, b| {
        a.relative_path
            .cmp(&b.relative_path)
            .then(a.file_path.cmp(&b.file_path))
    });

    if !warnings.is_empty() {
        let sample = warnings.iter().take(3).cloned().collect::<Vec<_>>().join(" | ");
        eprintln!(
            "list_local_files_recursive skipped {} path(s). Sample: {}",
            warnings.len(),
            sample
        );
    }

    if entries.is_empty() && !warnings.is_empty() {
        return Err(format!(
            "No readable files were found. {} additional path error(s) occurred.",
            warnings.len()
        ));
    }

    Ok(entries)
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    let path = parse_user_path(&path, "Path")?;
    Ok(path.exists())
}

#[tauri::command]
fn get_platform_info() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    }
}

#[tauri::command]
fn updater_supported() -> bool {
    let mode = detect_update_mode();
    mode == "native"
}

fn detect_update_mode() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists() {
            return "flatpak";
        }
        if std::env::var("APPIMAGE").is_err() {
            return "manual";
        }
    }
    "native"
}

#[tauri::command]
fn updater_support_info() -> UpdaterSupportInfo {
    UpdaterSupportInfo {
        mode: detect_update_mode().to_string(),
        release_url: "https://github.com/BurntToasters/S3-Sidekick/releases/latest".to_string(),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }

    let status = if cfg!(target_os = "windows") {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .status()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).status()
    } else {
        Command::new("xdg-open").arg(&url).status()
    }
    .map_err(|e| format!("Failed to launch external URL: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "External URL launcher exited with status {}",
            status
        ))
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(AppState(Mutex::new(S3State {
            client: None,
            endpoint: String::new(),
            region: String::new(),
        })))
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            list_buckets,
            list_objects,
            head_object,
            update_metadata,
            delete_objects,
            upload_object,
            upload_object_bytes,
            get_object_acl,
            download_object,
            create_folder,
            rename_object,
            build_object_url,
            generate_presigned_url,
            preview_object,
            list_local_files_recursive,
            path_exists,
            load_settings,
            save_settings,
            load_connection,
            save_connection,
            load_bookmarks_backup,
            save_bookmarks_backup,
            get_security_status,
            initialize_security,
            unlock_security,
            set_security_encryption,
            change_security_password,
            lock_security,
            set_lock_timeout,
            get_platform_info,
            updater_supported,
            updater_support_info,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
