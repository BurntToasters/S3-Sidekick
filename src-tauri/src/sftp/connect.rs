//! SFTP connect flow: transport, host key trust, authentication, and session
//! install. The command bodies are stubs until the connect piece lands.

use super::types::SftpConnectStep;
use crate::AppState;

/// Client-side SSH handler for SFTP sessions.
///
/// It rejects every server key for now, so no connection can succeed until host
/// key trust is implemented. The connect piece replaces this with a handler that
/// checks the pinned key and asks the user to trust an unknown one.
pub(crate) struct ClientHandler;

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    /// Placeholder: refuse every server key until host key trust lands.
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(false)
    }
}

/// Start an SFTP connection and return the first step of the connect flow.
///
/// `auth_method` selects how `password`, `private_key`, and `passphrase` are
/// used. `pinned_host_key` is the OpenSSH key line the user already trusts, if
/// any. Returns a `connected` step only once the session is installed.
#[tauri::command(async)]
pub(crate) fn sftp_connect(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    pinned_host_key: Option<String>,
) -> impl std::future::Future<Output = Result<SftpConnectStep, String>> + Send + use<'_> {
    Box::pin(sftp_connect_inner(
        state,
        host,
        port,
        username,
        auth_method,
        password,
        private_key,
        passphrase,
        pinned_host_key,
    ))
}

async fn sftp_connect_inner(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    pinned_host_key: Option<String>,
) -> Result<SftpConnectStep, String> {
    let _ = (
        state,
        host,
        port,
        username,
        auth_method,
        password,
        private_key,
        passphrase,
        pinned_host_key,
    );
    Err("SFTP connect is not implemented yet".to_string())
}

/// Advance a pending connect attempt with the user's answer.
///
/// `trust_host_key` answers a `host_key_unknown` step. `responses` answers a
/// `prompt` step, in prompt order.
#[tauri::command(async)]
pub(crate) fn sftp_connect_continue(
    state: tauri::State<'_, AppState>,
    attempt_id: String,
    trust_host_key: Option<bool>,
    responses: Option<Vec<String>>,
) -> impl std::future::Future<Output = Result<SftpConnectStep, String>> + Send + use<'_> {
    Box::pin(sftp_connect_continue_inner(
        state,
        attempt_id,
        trust_host_key,
        responses,
    ))
}

async fn sftp_connect_continue_inner(
    state: tauri::State<'_, AppState>,
    attempt_id: String,
    trust_host_key: Option<bool>,
    responses: Option<Vec<String>>,
) -> Result<SftpConnectStep, String> {
    let _ = (state, attempt_id, trust_host_key, responses);
    Err("SFTP connect continue is not implemented yet".to_string())
}

/// Cancel a pending connect attempt. It has no effect on a live session.
#[tauri::command]
pub(crate) async fn sftp_connect_cancel(attempt_id: String) -> Result<(), String> {
    let _ = attempt_id;
    Err("SFTP connect cancel is not implemented yet".to_string())
}
