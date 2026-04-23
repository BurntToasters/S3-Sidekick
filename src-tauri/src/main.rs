#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod biometric;
mod files;
mod platform;
mod s3;
mod security;

use aws_sdk_s3::Client;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
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

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn connection_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connection.json"))
}

fn bookmarks_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bookmarks.json"))
}

fn bookmarks_backup_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("bookmarks.json.bak"))
}

fn security_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("security.json"))
}

fn transfer_checkpoint_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?;
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

fn transfer_checkpoint_path(app: &tauri::AppHandle, checkpoint_id: &str) -> Result<PathBuf, String> {
    if checkpoint_id.trim().is_empty() {
        return Err("Checkpoint ID is required".to_string());
    }
    let dir = transfer_checkpoint_dir(app)?;
    Ok(dir.join(format!("{}.json", checkpoint_file_name(checkpoint_id))))
}

pub(crate) fn load_transfer_checkpoint_json(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
) -> Result<Option<String>, String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(json))
}

pub(crate) fn save_transfer_checkpoint_json(
    app: &tauri::AppHandle,
    checkpoint_id: &str,
    json: &str,
) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    atomic_write(&path, json)
}

pub(crate) fn remove_transfer_checkpoint(app: &tauri::AppHandle, checkpoint_id: &str) -> Result<(), String> {
    let path = transfer_checkpoint_path(app, checkpoint_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
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

#[tauri::command]
fn remove_path_if_exists(path: String) -> Result<(), String> {
    let parsed = parse_user_path(&path, "Path")?;
    if !parsed.exists() {
        return Ok(());
    }
    if parsed.is_dir() {
        return Err(format!(
            "Refusing to remove directory path: {}",
            parsed.display()
        ));
    }
    std::fs::remove_file(&parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, text: String, overwrite: bool) -> Result<(), String> {
    let parsed = validate_destination_path_allow_overwrite(&path)?;
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

#[tauri::command]
fn transfer_checkpoint_gc(app: tauri::AppHandle, ttl_hours: u32) -> Result<u32, String> {
    let _storage_guard = lock_storage_ops()?;
    let dir = transfer_checkpoint_dir(&app)?;
    let ttl_secs = (ttl_hours.max(1) as u64) * 3600;
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;

    let iter = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in iter {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
        if ext != "json" {
            continue;
        }
        let modified = match entry.metadata().ok().and_then(|m| m.modified().ok()) {
            Some(value) => value,
            None => continue,
        };
        let age = now.duration_since(modified).unwrap_or_default().as_secs();
        if age >= ttl_secs {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        if entry.path().extension().and_then(|e| e.to_str()) == Some("tmp") {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());

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
            s3::upload_object_resumable,
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
            security::get_security_status,
            security::initialize_security,
            security::unlock_security,
            security::set_security_encryption,
            security::change_security_password,
            security::lock_security,
            security::set_lock_timeout,
            security::reset_security,
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
        assert!(name.contains("download"), "temp path should contain purpose: {}", name);
        assert!(name.ends_with(".tmp"), "temp path should end in .tmp: {}", name);
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
}
