//! Remote filesystem commands: listing, metadata, create, rename, delete, and
//! bounded preview. The bodies are stubs until the filesystem piece lands.
//!
//! Each command that takes `tauri::State` returns a boxed future, as the S3
//! commands do, so the future is not held inline on the Windows main thread.

use super::types::{SftpDeleteResult, SftpEntry, SftpListResponse};
use crate::s3::PreviewResponse;
use crate::AppState;

/// List one directory of the live SFTP session.
#[tauri::command(async)]
pub(crate) fn sftp_list_dir(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> impl std::future::Future<Output = Result<SftpListResponse, String>> + Send + use<'_> {
    Box::pin(sftp_list_dir_inner(state, connection_id, path))
}

async fn sftp_list_dir_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<SftpListResponse, String> {
    let _ = (state, connection_id, path);
    Err("SFTP list is not implemented yet".to_string())
}

/// Return the metadata of one remote path, without following a final symlink.
#[tauri::command(async)]
pub(crate) fn sftp_stat(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> impl std::future::Future<Output = Result<SftpEntry, String>> + Send + use<'_> {
    Box::pin(sftp_stat_inner(state, connection_id, path))
}

async fn sftp_stat_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<SftpEntry, String> {
    let _ = (state, connection_id, path);
    Err("SFTP stat is not implemented yet".to_string())
}

/// Report whether a remote path exists.
#[tauri::command(async)]
pub(crate) fn sftp_exists(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> impl std::future::Future<Output = Result<bool, String>> + Send + use<'_> {
    Box::pin(sftp_exists_inner(state, connection_id, path))
}

async fn sftp_exists_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<bool, String> {
    let _ = (state, connection_id, path);
    Err("SFTP exists is not implemented yet".to_string())
}

/// Create one remote directory. The parent must already exist.
#[tauri::command(async)]
pub(crate) fn sftp_create_dir(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> impl std::future::Future<Output = Result<(), String>> + Send + use<'_> {
    Box::pin(sftp_create_dir_inner(state, connection_id, path))
}

async fn sftp_create_dir_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    let _ = (state, connection_id, path);
    Err("SFTP create folder is not implemented yet".to_string())
}

/// Rename a remote path. `overwrite` must be true to replace an existing target.
#[tauri::command(async)]
pub(crate) fn sftp_rename(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    from_path: String,
    to_path: String,
    overwrite: bool,
) -> impl std::future::Future<Output = Result<(), String>> + Send + use<'_> {
    Box::pin(sftp_rename_inner(
        state,
        connection_id,
        from_path,
        to_path,
        overwrite,
    ))
}

async fn sftp_rename_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    from_path: String,
    to_path: String,
    overwrite: bool,
) -> Result<(), String> {
    let _ = (state, connection_id, from_path, to_path, overwrite);
    Err("SFTP rename is not implemented yet".to_string())
}

/// Delete a batch of remote files. Each path is reported as deleted or failed.
#[tauri::command(async)]
pub(crate) fn sftp_delete(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> impl std::future::Future<Output = Result<SftpDeleteResult, String>> + Send + use<'_> {
    Box::pin(sftp_delete_inner(state, connection_id, paths))
}

async fn sftp_delete_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> Result<SftpDeleteResult, String> {
    let _ = (state, connection_id, paths);
    Err("SFTP delete is not implemented yet".to_string())
}

/// Delete a remote directory tree. The transfer ID makes it cancellable.
#[tauri::command(async)]
pub(crate) fn sftp_delete_dir(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    transfer_id: Option<u32>,
) -> impl std::future::Future<Output = Result<SftpDeleteResult, String>> + Send + use<'_> {
    Box::pin(sftp_delete_dir_inner(
        state,
        connection_id,
        path,
        transfer_id,
    ))
}

async fn sftp_delete_dir_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    transfer_id: Option<u32>,
) -> Result<SftpDeleteResult, String> {
    let _ = (state, connection_id, path, transfer_id);
    Err("SFTP delete folder is not implemented yet".to_string())
}

/// Return a bounded preview of one remote file, planned like an S3 preview.
#[tauri::command(async)]
pub(crate) fn sftp_preview(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> impl std::future::Future<Output = Result<PreviewResponse, String>> + Send + use<'_> {
    Box::pin(sftp_preview_inner(state, connection_id, path))
}

async fn sftp_preview_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<PreviewResponse, String> {
    let _ = (state, connection_id, path);
    Err("SFTP preview is not implemented yet".to_string())
}
