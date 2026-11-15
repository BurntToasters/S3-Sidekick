//! Private key selection for SFTP key authentication.
//!
//! The native dialog grants the path, and the renderer never names one. The
//! command body is a stub until the key piece lands.

use super::types::SshPrivateKeyInfo;

/// Show the native dialog for a private key file and return its metadata.
///
/// Returns `None` when the user cancels the dialog.
#[tauri::command]
pub(crate) async fn pick_ssh_private_key(
    app: tauri::AppHandle,
) -> Result<Option<SshPrivateKeyInfo>, String> {
    let _ = app;
    Err("SFTP private key selection is not implemented yet".to_string())
}
