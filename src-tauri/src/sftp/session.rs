//! The live SFTP session and the registered access that SFTP commands take.

use std::sync::Arc;

use super::connect::ClientHandler;
use crate::s3::{cancelled_error, require_connection_session, CancelToken, TransferGuard};
use crate::{lock_s3_state, AppState};

/// A live SFTP session, stored in `S3State::sftp` while it is the current one.
pub(crate) struct SftpHandle {
    /// SFTP subsystem channel on the SSH connection.
    pub(crate) sftp: russh_sftp::client::SftpSession,
    /// The SSH transport. Dropping it closes the connection.
    pub(crate) ssh: russh::client::Handle<ClientHandler>,
    /// Normalized `sftp://host:port` endpoint.
    pub(crate) endpoint: String,
    /// Canonical home directory of the login, absolute.
    pub(crate) home: String,
    /// Whether the server advertises the hardlink extension.
    pub(crate) hardlink_supported: bool,
}

/// A session handle held together with the transfer registration that keeps
/// the session's work cancellable for as long as the command runs.
///
/// Declaration order is the drop order: the handle is released before its
/// registration is removed, so a drain never observes an empty registry while a
/// clone of the old session is still alive. This matches `RegisteredClient`.
pub(crate) struct RegisteredSftp {
    pub(crate) handle: Arc<SftpHandle>,
    pub(crate) guard: TransferGuard,
}

impl RegisteredSftp {
    /// Cancellation token for the command's work.
    pub(crate) fn token(&self) -> CancelToken {
        self.guard.token()
    }

    /// True once the transfer has been cancelled, paused, or drained.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.guard.is_cancelled()
    }
}

/// Take a registered, cancellable handle to the live SFTP session.
///
/// Mirrors `require_client` in the S3 layer: register the transfer before taking
/// `S3State`, verify the connection ID against the live session, and clone the
/// handle out so no lock is held across an await. An S3 session has no SFTP
/// handle, so this refuses it as not connected.
pub(crate) fn require_session(
    state: &tauri::State<'_, AppState>,
    connection_id: &str,
    transfer_id: Option<u32>,
) -> Result<RegisteredSftp, String> {
    crate::security::require_s3_access()?;
    let guard = TransferGuard::register_optional(Some(connection_id), transfer_id)?;
    if guard.is_cancelled() {
        return Err(cancelled_error());
    }
    let handle = {
        let s3 = lock_s3_state(state)?;
        crate::security::require_s3_access()?;
        if guard.is_cancelled() {
            return Err(cancelled_error());
        }
        require_connection_session(&s3, connection_id)?;
        s3.sftp.clone().ok_or_else(|| "Not connected".to_string())?
    };
    let registered = RegisteredSftp { handle, guard };
    if registered.is_cancelled() {
        return Err(cancelled_error());
    }
    crate::security::require_s3_access()?;
    Ok(registered)
}
