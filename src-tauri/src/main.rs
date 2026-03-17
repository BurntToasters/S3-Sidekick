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
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const PBKDF2_ITERATIONS: u32 = 210_000;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

static UNLOCKED_KEY: OnceLock<Mutex<Option<[u8; KEY_LEN]>>> = OnceLock::new();

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
}

#[derive(serde::Serialize)]
struct SecurityStatus {
    initialized: bool,
    encryption_enabled: bool,
    unlocked: bool,
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

fn unlocked_key_store() -> &'static Mutex<Option<[u8; KEY_LEN]>> {
    UNLOCKED_KEY.get_or_init(|| Mutex::new(None))
}

fn is_unlocked() -> bool {
    unlocked_key_store()
        .lock()
        .map(|k| k.is_some())
        .unwrap_or(false)
}

fn set_unlocked_key(key: Option<[u8; KEY_LEN]>) -> Result<(), String> {
    let mut guard = unlocked_key_store().lock().map_err(|e| e.to_string())?;
    *guard = key;
    Ok(())
}

fn require_unlocked_key() -> Result<[u8; KEY_LEN], String> {
    let guard = unlocked_key_store().lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .copied()
        .ok_or_else(|| "Encrypted storage is locked. Unlock with your password.".to_string())
}

fn default_security_config() -> SecurityConfig {
    SecurityConfig {
        initialized: false,
        encryption_enabled: false,
        salt: String::new(),
        verifier: String::new(),
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
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
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

    std::fs::write(path, output).map_err(|e| e.to_string())
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
        std::fs::write(&plan.path, &plan.original).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn apply_migration(plans: &[MigrationPlan]) -> Result<(), String> {
    for (idx, plan) in plans.iter().enumerate() {
        if let Err(err) = std::fs::write(&plan.path, &plan.transformed) {
            let _ = rollback_migration(plans, idx);
            return Err(err.to_string());
        }
    }
    Ok(())
}

fn security_status(config: &SecurityConfig) -> SecurityStatus {
    SecurityStatus {
        initialized: config.initialized,
        encryption_enabled: config.encryption_enabled,
        unlocked: is_unlocked(),
    }
}

use tauri::Manager;

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
        };
        set_unlocked_key(None)?;
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
    let key = derive_key(&pw, &salt);
    let verifier = key_verifier(&key);

    let plans = build_migration_plans(&app, true, &key)?;
    apply_migration(&plans)?;

    let config = SecurityConfig {
        initialized: true,
        encryption_enabled: true,
        salt: B64.encode(salt),
        verifier: B64.encode(verifier),
    };
    if let Err(err) = save_security_config(&app, &config) {
        let _ = rollback_migration(&plans, plans.len());
        return Err(err);
    }
    set_unlocked_key(Some(key))?;
    Ok(security_status(&config))
}

#[tauri::command]
fn unlock_security(app: tauri::AppHandle, password: String) -> Result<SecurityStatus, String> {
    let config = load_security_config(&app)?;
    if !config.initialized || !config.encryption_enabled {
        set_unlocked_key(None)?;
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

    let key = derive_key(&password, &salt);
    let verifier = key_verifier(&key);
    if verifier.as_slice() != expected_verifier.as_slice() {
        return Err("Invalid password".to_string());
    }

    set_unlocked_key(Some(key))?;
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
        let key = derive_key(&pw, &salt);
        let verifier = key_verifier(&key);

        let plans = build_migration_plans(&app, true, &key)?;
        apply_migration(&plans)?;
        config.encryption_enabled = true;
        config.salt = B64.encode(salt);
        config.verifier = B64.encode(verifier);
        if let Err(err) = save_security_config(&app, &config) {
            let _ = rollback_migration(&plans, plans.len());
            return Err(err);
        }
        set_unlocked_key(Some(key))?;
        return Ok(security_status(&config));
    }

    let current_password = current_password
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Current password is required".to_string())?;
    let salt = B64
        .decode(&config.salt)
        .map_err(|e| format!("Invalid security salt: {}", e))?;
    let key = derive_key(&current_password, &salt);
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
    set_unlocked_key(None)?;
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
    let old_key = derive_key(&current_password, &old_salt);
    let old_verifier = key_verifier(&old_key);
    let expected_verifier = B64
        .decode(&config.verifier)
        .map_err(|e| format!("Invalid security verifier: {}", e))?;
    if old_verifier.as_slice() != expected_verifier.as_slice() {
        return Err("Invalid password".to_string());
    }

    let mut new_salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut new_salt);
    let new_key = derive_key(&new_password, &new_salt);
    let new_verifier = key_verifier(&new_key);

    let plans = build_rekey_plans(&app, &old_key, &new_key)?;
    apply_migration(&plans)?;

    config.salt = B64.encode(new_salt);
    config.verifier = B64.encode(new_verifier);
    if let Err(err) = save_security_config(&app, &config) {
        let _ = rollback_migration(&plans, plans.len());
        return Err(err);
    }
    set_unlocked_key(Some(new_key))?;

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

    let source = format!("{}/{}", &bucket, &key);
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
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    file_path: String,
    content_type: String,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

    let body = aws_sdk_s3::primitives::ByteStream::from_path(std::path::Path::new(&file_path))
        .await
        .map_err(|e| format!("Failed to open file stream: {}", e))?;

    let mut req = client.put_object().bucket(&bucket).key(&key).body(body);

    if !content_type.is_empty() {
        req = req.content_type(&content_type);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to upload: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn upload_object_bytes(
    state: tauri::State<'_, AppState>,
    bucket: String,
    key: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<(), String> {
    let client = {
        let s3 = state.0.lock().map_err(|e| e.to_string())?;
        s3.client.clone().ok_or("Not connected")?
    };

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
    let mut file =
        std::fs::File::create(&destination).map_err(|e| format!("Failed to create file: {}", e))?;
    let mut written = 0u64;
    let mut buf = [0u8; 64 * 1024];

    loop {
        let count = tokio::io::AsyncReadExt::read(&mut reader, &mut buf)
            .await
            .map_err(|e| format!("Failed to read body: {}", e))?;
        if count == 0 {
            break;
        }

        file.write_all(&buf[..count])
            .map_err(|e| format!("Failed to write file: {}", e))?;
        written += count as u64;
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

    let source = format!("{}/{}", &bucket, &old_key);
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
        std::env::set_var("GDK_BACKEND", "x11");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
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
            get_platform_info,
            updater_supported,
            updater_support_info,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
