#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod biometric;
mod files;
mod platform;
mod s3;
mod security;

use aws_sdk_s3::Client;
use sha2::{Digest, Sha256};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

use security::{load_security_config, read_protected_file, write_protected_file};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
static STORAGE_OP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) struct S3State {
    pub client: Option<Client>,
    pub endpoint: String,
    pub region: String,
    pub bucket_hint: Option<String>,
}

pub(crate) struct AppState(pub Mutex<S3State>);

pub(crate) fn lock_s3_state<'a>(
    state: &'a tauri::State<'a, AppState>,
) -> Result<std::sync::MutexGuard<'a, S3State>, String> {
    match state.0.lock() {
        Ok(guard) => Ok(guard),
        Err(err) => Err(format!("Mutex poisoned: {}", err)),
    }
}

pub(crate) fn lock_storage_ops() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORAGE_OP_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|err| err.to_string())
}

fn settings_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn connection_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connection.json"))
}

fn bookmarks_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bookmarks.json"))
}

fn bookmarks_backup_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bookmarks.json.bak"))
}

fn security_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("security.json"))
}

pub(crate) fn transfer_manifest_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("transfer-manifest.json"))
}

pub(crate) fn security_journal_path<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("security-migration.journal"))
}

fn transfer_checkpoint_dir<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?;
    let checkpoints = dir.join("transfer-checkpoints");
    std::fs::create_dir_all(&checkpoints).map_err(|e| e.to_string())?;
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

/// Read a checkpoint, transparently decrypting it when the vault is enabled.
///
/// Only a genuinely missing file is reported as absent. Locked, corrupt, or
/// otherwise unreadable checkpoints are retained and surfaced as errors so a
/// recovery/GC pass cannot silently discard resumable state.
pub(crate) fn load_transfer_checkpoint_json<R: tauri::Runtime>(
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

pub(crate) fn save_transfer_checkpoint_json<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    checkpoint_id: &str,
    json: &str,
) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    let security = load_security_config(app)?;
    write_protected_file(&path, json, &security)
}

pub(crate) fn remove_transfer_checkpoint(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn checkpoint_scratch_path(json: &str) -> Result<Option<PathBuf>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|err| format!("Invalid checkpoint JSON: {}", err))?;
    let Some(temp) = value.get("temp_path").and_then(|value| value.as_str()) else {
        return Ok(None);
    };
    let temp_path = PathBuf::from(temp);
    if !is_owned_download_temp(&temp_path) {
        return Err(format!(
            "Checkpoint references a scratch path this application does not own: {}",
            temp_path.display()
        ));
    }
    Ok(Some(temp_path))
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
) -> Result<Vec<String>, String> {
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
            scratch_paths.push(
                temp_path
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Checkpoint scratch path is not valid UTF-8".to_string())?,
            );
        }
    }
    scratch_paths.sort();
    scratch_paths.dedup();
    Ok(scratch_paths)
}

/// Remove checkpoint scratch data and then the checkpoint records themselves.
/// The caller retains its migration/reset journal until this succeeds, so an
/// interrupted cleanup can safely be retried.
pub(crate) fn purge_transfer_checkpoints<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    scratch_paths: &[String],
) -> Result<(), String> {
    for raw in scratch_paths {
        let path = PathBuf::from(raw);
        if !is_owned_download_temp(&path) {
            return Err(format!(
                "Refusing to remove unowned checkpoint scratch path: {}",
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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
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
    fsync_parent(&dir.join("checkpoint-cleanup"))
}

#[derive(serde::Serialize)]
struct TransferCheckpointEntry {
    id_hash: String,
    updated_at_ms: i64,
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

pub(crate) fn validate_existing_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = parse_user_path(raw, label)?;
    if !path.exists() {
        return Err(format!("{} path does not exist: {}", label, path.display()));
    }
    Ok(path)
}

pub(crate) fn validate_destination_path(raw: &str) -> Result<PathBuf, String> {
    let destination = parse_user_path(raw, "Destination")?;
    validate_destination_parent(&destination)?;
    if destination.exists() {
        return Err(format!(
            "Destination already exists: {}",
            destination.display()
        ));
    }
    Ok(destination)
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
    if parent
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Destination parent is a symbolic link: {}",
            parent.display()
        ));
    }
    Ok(())
}

pub(crate) fn validate_destination_path_allow_overwrite(raw: &str) -> Result<PathBuf, String> {
    let destination = parse_user_path(raw, "Destination")?;
    validate_destination_parent(&destination)?;
    if destination.exists() && !destination.is_file() {
        return Err(format!(
            "Destination is not a file: {}",
            destination.display()
        ));
    }
    Ok(destination)
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    let parsed = parse_user_path(&path, "Path")?;
    Ok(parsed.exists())
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

/// True when `path` is a file this app created as download scratch space.
pub(crate) fn is_owned_download_temp(path: &Path) -> bool {
    path.to_str()
        .map(|value| value.ends_with(DOWNLOAD_TEMP_SUFFIX))
        .unwrap_or(false)
}

/// Extensions `write_text_file` is permitted to produce.
///
/// The command exists to export the activity log. Restricting the extension
/// keeps it from being used to drop a shell profile, a launch agent, or a
/// script onto disk if the webview is ever compromised.
const WRITABLE_TEXT_EXTENSIONS: &[&str] = &["txt", "log", "json", "csv", "md"];

#[tauri::command]
fn remove_path_if_exists(path: String) -> Result<(), String> {
    let parsed = parse_user_path(&path, "Path")?;
    if !is_owned_download_temp(&parsed) {
        return Err(format!(
            "Refusing to remove a path this app does not own: {}",
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
    if parsed
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Refusing to remove a symbolic link: {}",
            parsed.display()
        ));
    }
    std::fs::remove_file(&parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, text: String, overwrite: bool) -> Result<(), String> {
    let parsed = validate_destination_path_allow_overwrite(&path)?;
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
    if parsed
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Refusing to write through a symbolic link: {}",
            parsed.display()
        ));
    }
    if parsed.exists() && !overwrite {
        return Err(format!("Destination already exists: {}", parsed.display()));
    }
    atomic_write(&parsed, &text)
}

#[tauri::command]
fn transfer_checkpoint_save(
    app: tauri::AppHandle,
    checkpoint_id: String,
    json: String,
) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    save_transfer_checkpoint_json(&app, &checkpoint_id, &json)
}

#[tauri::command]
fn transfer_checkpoint_load(
    app: tauri::AppHandle,
    checkpoint_id: String,
) -> Result<Option<String>, String> {
    let _storage_guard = lock_storage_ops()?;
    load_transfer_checkpoint_json(&app, &checkpoint_id)
}

#[tauri::command]
fn transfer_checkpoint_remove(app: tauri::AppHandle, checkpoint_id: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    remove_transfer_checkpoint(&app, &checkpoint_id)
}

#[tauri::command]
fn transfer_checkpoint_list(app: tauri::AppHandle) -> Result<Vec<TransferCheckpointEntry>, String> {
    let _storage_guard = lock_storage_ops()?;
    let dir = transfer_checkpoint_dir(&app)?;
    let mut entries: Vec<TransferCheckpointEntry> = Vec::new();

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
        if id_hash.is_empty() {
            continue;
        }

        let updated_at_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        entries.push(TransferCheckpointEntry {
            id_hash,
            updated_at_ms,
        });
    }

    Ok(entries)
}

/// Reclaim expired checkpoints and the scratch files they reference.
///
/// `keep_checkpoint_ids` holds the checkpoint ids the caller's transfer manifest
/// still references. Anything in that set survives regardless of age, so the GC
/// can no longer strand a queued transfer's resume state. Expiring a checkpoint
/// also deletes the temp file recorded inside it, because once the checkpoint is
/// gone nothing else can map back to that path — the scratch file is sized to the
/// full object, so it would otherwise leak permanently.
#[tauri::command]
fn transfer_checkpoint_gc(
    app: tauri::AppHandle,
    ttl_hours: u32,
    keep_checkpoint_ids: Option<Vec<String>>,
) -> Result<u32, String> {
    let _storage_guard = lock_storage_ops()?;
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
        if let Some(temp_path) = checkpoint_scratch_path(&json)? {
            match std::fs::remove_file(&temp_path) {
                Ok(()) => fsync_parent(&temp_path)?,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!(
                        "Failed to remove checkpoint scratch file '{}': {}",
                        temp_path.display(),
                        err
                    ));
                }
            }
        }

        match std::fs::remove_file(&path) {
            Ok(()) => {
                fsync_parent(&path)?;
                removed += 1;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
    }

    Ok(removed)
}

#[tauri::command]
fn get_available_disk_bytes(path: String) -> Result<u64, String> {
    let parsed = parse_user_path(&path, "Path")?;
    let target = if parsed.exists() {
        if parsed.is_dir() {
            parsed
        } else {
            parsed
                .parent()
                .ok_or_else(|| format!("Path has no parent directory: {}", parsed.display()))?
                .to_path_buf()
        }
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
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _storage_guard = lock_storage_ops()?;
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = settings_path(&app)?;
    atomic_write(&path, &json)
}

#[tauri::command]
fn load_bookmarks(app: tauri::AppHandle) -> Result<String, String> {
    let _storage_guard = lock_storage_ops()?;
    let path = bookmarks_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "[]", &security)
}

#[tauri::command]
fn save_bookmarks(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = bookmarks_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn load_connection(app: tauri::AppHandle) -> Result<String, String> {
    let _storage_guard = lock_storage_ops()?;
    let path = connection_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "", &security)
}

#[tauri::command]
fn save_connection(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = connection_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn load_bookmarks_backup(app: tauri::AppHandle) -> Result<String, String> {
    let _storage_guard = lock_storage_ops()?;
    let path = bookmarks_backup_path(&app)?;
    let security = load_security_config(&app)?;
    read_protected_file(&path, "[]", &security)
}

#[tauri::command]
fn save_bookmarks_backup(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = bookmarks_backup_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn load_transfer_manifest(app: tauri::AppHandle) -> Result<String, String> {
    let _storage_guard = lock_storage_ops()?;
    let path = transfer_manifest_path(&app)?;
    let security = load_security_config(&app)?;
    // Releases before this one wrote the manifest unprotected, so plaintext is
    // tolerated here until the adoption sweep has run.
    security::read_protected_file_with_legacy(
        &path,
        "",
        &security,
        security::LegacyPlaintext::Adopt,
    )
}

#[tauri::command]
fn save_transfer_manifest(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = transfer_manifest_path(&app)?;
    let security = load_security_config(&app)?;
    write_protected_file(&path, &json, &security)
}

#[tauri::command]
fn clear_transfer_manifest(app: tauri::AppHandle) -> Result<(), String> {
    let _storage_guard = lock_storage_ops()?;
    let path = transfer_manifest_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
        let dir = std::fs::File::open(parent).map_err(|e| e.to_string())?;
        dir.sync_all().map_err(|e| e.to_string())
    }

    #[cfg(not(unix))]
    {
        // Windows cannot open a directory as a regular file handle. Syncing the
        // renamed file after the rename flushes the containing volume's
        // metadata for that entry, which is the closest available equivalent.
        let _ = parent;
        match std::fs::OpenOptions::new().read(true).open(path) {
            Ok(file) => file.sync_all().map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub(crate) fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    let tmp_path = make_temp_path(path, "atomic");
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut tmp_file = options.open(&tmp_path).map_err(|e| e.to_string())?;
    tmp_file
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp_file.sync_all().map_err(|e| e.to_string())?;
    drop(tmp_file);
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.to_string());
    }
    fsync_parent(path)?;
    Ok(())
}

fn main() {
    #[cfg(target_os = "linux")]
    {
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
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }

            // Finish or reverse a vault migration before any protected command
            // runs. A failure is latched by the security module so protected I/O
            // fails closed, and journal-owned staging is deliberately retained.
            let migration_recovered = match security::recover_interrupted_migration(app.handle()) {
                Ok(()) => true,
                Err(err) => {
                    eprintln!("Vault migration recovery failed: {}", err);
                    false
                }
            };

            // Atomic-write leftovers are safe to sweep only when no migration
            // journal exists. Never infer ownership from the `.tmp` extension
            // while recovery is pending or failed.
            if migration_recovered
                && security_journal_path(app.handle())
                    .map(|path| !path.exists())
                    .unwrap_or(false)
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    if let Ok(entries) = std::fs::read_dir(&dir) {
                        for entry in entries.flatten() {
                            if entry.path().extension().and_then(|e| e.to_str()) == Some("tmp") {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    if let Err(err) = builder
        .manage(AppState(Mutex::new(S3State {
            client: None,
            endpoint: String::new(),
            region: String::new(),
            bucket_hint: None,
        })))
        .invoke_handler(tauri::generate_handler![
            s3::connect,
            s3::disconnect,
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
            s3::object_exists,
            s3::build_object_url,
            s3::generate_presigned_url,
            s3::preview_object,
            files::list_local_files_recursive,
            path_exists,
            remove_path_if_exists,
            write_text_file,
            transfer_checkpoint_save,
            transfer_checkpoint_load,
            transfer_checkpoint_remove,
            transfer_checkpoint_list,
            transfer_checkpoint_gc,
            get_available_disk_bytes,
            load_settings,
            save_settings,
            load_bookmarks,
            save_bookmarks,
            load_connection,
            save_connection,
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
            security::set_lock_timeout,
            security::reset_security,
            security::factory_reset,
            biometric::biometric_available,
            biometric::enable_biometric,
            biometric::disable_biometric,
            biometric::unlock_biometric,
            platform::get_platform_info,
            platform::updater_supported,
            platform::updater_support_info,
            platform::open_external_url,
            platform::open_local_path,
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
        assert!(is_owned_download_temp(&temp));
    }

    #[test]
    fn download_temp_path_is_stable_across_calls() {
        // Resume depends on the scratch path being reproducible between sessions.
        let dest = Path::new("/tmp/archive.zip");
        assert_eq!(download_temp_path(dest), download_temp_path(dest));
    }

    #[test]
    fn is_owned_download_temp_rejects_foreign_paths() {
        for candidate in [
            "/Users/someone/.ssh/id_ed25519",
            "/tmp/report.pdf",
            "/tmp/other.tmp",
            "/tmp/x.s3-sidekick.download.tmp.bak",
        ] {
            assert!(
                !is_owned_download_temp(Path::new(candidate)),
                "{} must not be treated as app-owned",
                candidate
            );
        }
    }

    #[test]
    fn remove_path_if_exists_refuses_paths_we_do_not_own() {
        let dir = scratch_dir("remove-guard");
        let victim = dir.join("important.txt");
        std::fs::write(&victim, b"precious").unwrap();

        let err = remove_path_if_exists(victim.to_string_lossy().to_string())
            .expect_err("an arbitrary file must not be removable");
        assert!(err.contains("does not own"), "unexpected error: {}", err);
        assert!(victim.exists(), "the file must still be there");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_path_if_exists_removes_our_own_scratch_file() {
        let dir = scratch_dir("remove-owned");
        let temp = download_temp_path(&dir.join("movie.mkv"));
        std::fs::write(&temp, b"partial").unwrap();

        remove_path_if_exists(temp.to_string_lossy().to_string()).unwrap();
        assert!(!temp.exists());

        // Absent is not an error.
        remove_path_if_exists(temp.to_string_lossy().to_string()).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_text_file_rejects_non_text_extensions() {
        let dir = scratch_dir("write-guard");
        for name in ["payload.sh", "agent.plist", "profile", "thing.exe"] {
            let target = dir.join(name);
            let err = write_text_file(
                target.to_string_lossy().to_string(),
                "#!/bin/sh\n".to_string(),
                true,
            )
            .expect_err("only text exports are allowed");
            assert!(err.contains("extensions"), "unexpected error: {}", err);
            assert!(!target.exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_text_file_allows_log_exports() {
        let dir = scratch_dir("write-allow");
        let target = dir.join("activity.txt");
        write_text_file(
            target.to_string_lossy().to_string(),
            "hello".to_string(),
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");

        // Without overwrite an existing file must be refused.
        assert!(write_text_file(
            target.to_string_lossy().to_string(),
            "again".to_string(),
            false
        )
        .is_err());

        write_text_file(
            target.to_string_lossy().to_string(),
            "again".to_string(),
            true,
        )
        .unwrap();
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
        let owned = serde_json::json!({
            "temp_path": "/tmp/file.bin.s3-sidekick.download.tmp"
        })
        .to_string();
        assert_eq!(
            checkpoint_scratch_path(&owned).unwrap(),
            Some(PathBuf::from("/tmp/file.bin.s3-sidekick.download.tmp"))
        );

        let foreign = serde_json::json!({ "temp_path": "/tmp/file.bin" }).to_string();
        assert!(checkpoint_scratch_path(&foreign).is_err());
        assert!(checkpoint_scratch_path("not-json").is_err());
        assert_eq!(checkpoint_scratch_path("{}").unwrap(), None);
    }
}
