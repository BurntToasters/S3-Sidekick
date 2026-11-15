//! Serialized response types shared with the webview.
//!
//! Field names stay snake_case, like the S3 response types, so the hand-written
//! webview interfaces read them the same way.

/// One step of the SFTP connect flow. The webview drives the flow by calling
/// `sftp_connect` and `sftp_connect_continue` until a `connected` step arrives.
#[derive(serde::Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub(crate) enum SftpConnectStep {
    /// The session is live. `host_key` and `host_key_fingerprint` identify the
    /// trusted server key so the webview can offer it for pinning.
    Connected {
        connection_id: String,
        connection_identity: String,
        endpoint: String,
        home_path: String,
        /// OpenSSH public key line for the trusted server key.
        host_key: String,
        /// SHA-256 fingerprint of the trusted key, in `SHA256:...` form.
        host_key_fingerprint: String,
        create_only_supported: bool,
    },
    /// The server key is not pinned or trusted yet. The user must confirm the
    /// fingerprint before the attempt continues.
    HostKeyUnknown {
        attempt_id: String,
        key_type: String,
        fingerprint_sha256: String,
        /// OpenSSH public key line for the presented server key.
        host_key: String,
    },
    /// The server asks the user for input, such as a password or a
    /// keyboard-interactive challenge.
    Prompt {
        attempt_id: String,
        name: String,
        instructions: String,
        prompts: Vec<SftpPrompt>,
    },
}

/// One keyboard-interactive prompt. `echo` says whether the answer may be shown.
#[derive(serde::Serialize)]
pub(crate) struct SftpPrompt {
    pub(crate) text: String,
    pub(crate) echo: bool,
}

/// Kind of a remote directory entry, from its file type bits.
#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SftpEntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// One remote directory entry or a stat result.
#[derive(serde::Serialize)]
pub(crate) struct SftpEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) kind: SftpEntryKind,
    pub(crate) size: Option<u64>,
    /// Modification time in seconds since the Unix epoch.
    pub(crate) mtime: Option<u64>,
    pub(crate) permissions: Option<u32>,
    pub(crate) uid: Option<u32>,
    pub(crate) gid: Option<u32>,
    pub(crate) owner: Option<String>,
    pub(crate) group: Option<String>,
    /// True when the remote name was not valid UTF-8 and `name` is a lossy form.
    pub(crate) name_lossy: bool,
}

/// One page of a directory listing.
#[derive(serde::Serialize)]
pub(crate) struct SftpListResponse {
    pub(crate) path: String,
    pub(crate) entries: Vec<SftpEntry>,
    pub(crate) truncated: bool,
}

/// A path that could not be deleted, with the reason.
#[derive(serde::Serialize)]
pub(crate) struct SftpDeleteFailure {
    pub(crate) path: String,
    pub(crate) error: String,
}

/// Outcome of a delete. Each path is either deleted or reported as failed.
#[derive(serde::Serialize)]
pub(crate) struct SftpDeleteResult {
    pub(crate) deleted: Vec<String>,
    pub(crate) failed: Vec<SftpDeleteFailure>,
}

/// Metadata of a private key file chosen through the native dialog.
///
/// The key text is held so the connect command can use it without a second
/// file read. It is not `Debug`, so it cannot reach a log by accident.
#[derive(serde::Serialize)]
pub(crate) struct SshPrivateKeyInfo {
    pub(crate) key_text: String,
    pub(crate) algorithm: String,
    pub(crate) encrypted: bool,
    pub(crate) file_name: String,
}
