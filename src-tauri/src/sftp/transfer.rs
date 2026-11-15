//! SFTP upload and download commands. The bodies are stubs until the transfer
//! piece lands.
//!
//! The webview names an upload source and a download destination only by the
//! grant tokens the native dialogs issue. It never names a local path.

use crate::AppState;

/// Upload a granted local file to a remote path and return the bytes written.
#[tauri::command(async)]
pub(crate) fn sftp_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    upload_token: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: bool,
    bandwidth_limit_mbps: Option<u32>,
) -> impl std::future::Future<Output = Result<u64, String>> + Send + use<'_> {
    Box::pin(sftp_upload_inner(
        app,
        state,
        connection_id,
        path,
        upload_token,
        transfer_id,
        attempt,
        overwrite,
        bandwidth_limit_mbps,
    ))
}

async fn sftp_upload_inner(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    upload_token: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: bool,
    bandwidth_limit_mbps: Option<u32>,
) -> Result<u64, String> {
    let _ = (
        app,
        state,
        connection_id,
        path,
        upload_token,
        transfer_id,
        attempt,
        overwrite,
        bandwidth_limit_mbps,
    );
    Err("SFTP upload is not implemented yet".to_string())
}

/// Upload base64-encoded bytes to a remote path. The bytes are not a local path.
#[tauri::command(async)]
pub(crate) fn sftp_upload_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    bytes_base64: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
) -> impl std::future::Future<Output = Result<(), String>> + Send + use<'_> {
    Box::pin(sftp_upload_bytes_inner(
        app,
        state,
        connection_id,
        path,
        bytes_base64,
        transfer_id,
        attempt,
        overwrite,
    ))
}

async fn sftp_upload_bytes_inner(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    bytes_base64: String,
    transfer_id: u32,
    attempt: Option<u32>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let _ = (
        app,
        state,
        connection_id,
        path,
        bytes_base64,
        transfer_id,
        attempt,
        overwrite,
    );
    Err("SFTP byte upload is not implemented yet".to_string())
}

/// Download a remote file to a granted local destination and return the bytes
/// written. `checkpoint_id` and `enable_resume` control resumable downloads.
#[tauri::command(async)]
pub(crate) fn sftp_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    destination_token: String,
    destination_name: Option<String>,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checkpoint_id: Option<String>,
    enable_resume: Option<bool>,
    bandwidth_limit_mbps: Option<u32>,
) -> impl std::future::Future<Output = Result<u64, String>> + Send + use<'_> {
    Box::pin(sftp_download_inner(
        app,
        state,
        connection_id,
        path,
        destination_token,
        destination_name,
        transfer_id,
        overwrite,
        attempt,
        checkpoint_id,
        enable_resume,
        bandwidth_limit_mbps,
    ))
}

async fn sftp_download_inner(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    destination_token: String,
    destination_name: Option<String>,
    transfer_id: u32,
    overwrite: bool,
    attempt: Option<u32>,
    checkpoint_id: Option<String>,
    enable_resume: Option<bool>,
    bandwidth_limit_mbps: Option<u32>,
) -> Result<u64, String> {
    let _ = (
        app,
        state,
        connection_id,
        path,
        destination_token,
        destination_name,
        transfer_id,
        overwrite,
        attempt,
        checkpoint_id,
        enable_resume,
        bandwidth_limit_mbps,
    );
    Err("SFTP download is not implemented yet".to_string())
}
