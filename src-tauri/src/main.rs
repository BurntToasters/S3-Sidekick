#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use aws_sdk_s3::Client;
use aws_sdk_s3::types::MetadataDirective;

struct S3State {
    client: Option<Client>,
    endpoint: String,
    region: String,
}

struct AppState(Mutex<S3State>);

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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn connection_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connection.json"))
}

use tauri::Manager;

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
    Ok(contents)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_connection(app: tauri::AppHandle) -> Result<String, String> {
    let path = connection_path(&app)?;
    if !path.exists() {
        return Ok("".to_string());
    }
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
    Ok(contents)
}

#[tauri::command]
fn save_connection(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = connection_path(&app)?;
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn connect(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    region: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    let creds = aws_sdk_s3::config::Credentials::new(
        &access_key,
        &secret_key,
        None,
        None,
        "s3-sidekick",
    );

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
            creation_date: b
                .creation_date()
                .map(|d| d.to_string())
                .unwrap_or_default(),
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

    let mut req = client
        .list_objects_v2()
        .bucket(&bucket)
        .max_keys(1000);

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
    let next_continuation_token = output
        .next_continuation_token()
        .unwrap_or("")
        .to_string();

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

    let data = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let body = aws_sdk_s3::primitives::ByteStream::from(data);

    let mut req = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(body);

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
            AclGrant { grantee, permission }
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

    let data = output
        .body
        .collect()
        .await
        .map_err(|e| format!("Failed to read body: {}", e))?
        .into_bytes();

    let size = data.len() as u64;
    std::fs::write(&destination, &data)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(size)
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
    Ok(format!("{}/{}/{}", base, bucket, key))
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
    #[cfg(target_os = "linux")]
    {
        if std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists() {
            return false;
        }
        if std::env::var("APPIMAGE").is_err() {
            return false;
        }
    }
    true
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
            get_object_acl,
            download_object,
            create_folder,
            rename_object,
            build_object_url,
            load_settings,
            save_settings,
            load_connection,
            save_connection,
            get_platform_info,
            updater_supported,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
