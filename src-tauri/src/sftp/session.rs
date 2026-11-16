//! The live SFTP session and the registered access that SFTP commands take.

use std::sync::Arc;

use super::connect::ClientHandler;
use crate::s3::{cancelled_error, require_connection_session, CancelToken, TransferGuard};
use crate::{lock_s3_state, AppState};

/// A live SFTP session, stored in `S3State::sftp` while it is the current one.
pub(crate) struct SftpHandle {
    /// SFTP subsystem channel on the SSH connection.
    pub(crate) sftp: russh_sftp::client::SftpSession,
    /// The SSH transport. Dropping it alone does not end the connection: the
    /// SFTP channel still holds a sender into it, so `Drop` below closes the
    /// socket through `shutdown`.
    pub(crate) ssh: russh::client::Handle<ClientHandler>,
    /// Normalized `sftp://host:port` endpoint.
    pub(crate) endpoint: String,
    /// The login name. With the endpoint it names whose files a path refers to:
    /// a server that chroots each user gives one path a different file per user.
    pub(crate) username: String,
    /// Canonical home directory of the login, absolute.
    pub(crate) home: String,
    /// Whether the server advertises the hardlink extension.
    pub(crate) hardlink_supported: bool,
    /// Closes the TCP socket when cancelled. Cancelled on drop.
    pub(crate) shutdown: CancelToken,
}

impl Drop for SftpHandle {
    /// Close the socket, so the server ends the SSH session and its SFTP
    /// subsystem, even while the SFTP channel still holds the transport open.
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// Message for an SFTP operation that failed because the SSH connection closed.
pub(crate) const SFTP_CONNECTION_LOST: &str = "SFTP connection lost";

/// An error an SFTP call can fail with, and whether it was the request timeout.
pub(crate) trait SftpFailure: std::fmt::Display {
    fn timed_out(&self) -> bool {
        false
    }
}

impl SftpFailure for russh_sftp::client::error::Error {
    fn timed_out(&self) -> bool {
        matches!(self, russh_sftp::client::error::Error::Timeout)
    }
}

impl SftpFailure for std::io::Error {
    fn timed_out(&self) -> bool {
        self.kind() == std::io::ErrorKind::TimedOut
    }
}

impl SftpFailure for str {}
impl SftpFailure for String {}

impl<T: SftpFailure + ?Sized> SftpFailure for &T {
    fn timed_out(&self) -> bool {
        (**self).timed_out()
    }
}

impl SftpHandle {
    /// True once the connection is gone, or was declared gone after a request
    /// went unanswered.
    pub(crate) fn is_lost(&self) -> bool {
        self.ssh.is_closed() || self.shutdown.is_cancelled()
    }
}

/// Map a failed SFTP operation to the message the webview shows.
///
/// A closed SSH transport is reported as a lost connection, so the webview can
/// offer a reconnect instead of a generic failure. A request that timed out is
/// treated the same way: the server stopped answering, so the socket is closed
/// and every later call on this session reports the loss at once. Any other
/// failure keeps the operation's context and the underlying error.
pub(crate) fn map_sftp_error(handle: &SftpHandle, context: &str, err: impl SftpFailure) -> String {
    if err.timed_out() {
        handle.shutdown.cancel();
    }
    if handle.is_lost() {
        format!("{}: {}", SFTP_CONNECTION_LOST, context)
    } else {
        format!("{}: {}", context, err)
    }
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

#[cfg(test)]
mod tests {
    use super::SftpFailure;
    use russh_sftp::client::error::Error as SftpError;

    #[test]
    fn only_request_timeouts_count_as_timed_out() {
        assert!(SftpError::Timeout.timed_out());
        assert!(std::io::Error::from(SftpError::Timeout).timed_out());
        assert!(std::io::Error::new(std::io::ErrorKind::TimedOut, "slow").timed_out());
        let by_reference: &SftpError = &SftpError::Timeout;
        assert!(SftpFailure::timed_out(&by_reference));
        assert!(!SftpError::IO("broken pipe".to_string()).timed_out());
        assert!(!SftpError::UnexpectedPacket.timed_out());
        assert!(!std::io::Error::other("eof").timed_out());
        assert!(!"boom".timed_out());
        assert!(!"Timeout".to_string().timed_out());
    }
}
