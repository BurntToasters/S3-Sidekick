//! Backend-issued grants for local filesystem paths.
//!
//! Failure modes this module closes, written before the implementation:
//! - A compromised webview names `/Users/<user>/.ssh/id_ed25519` as an upload
//!   source, a download destination, a reveal target, or an export target and
//!   the backend obeys because the path arrived as a string.
//! - A token is reused for a different purpose than the dialog that minted it.
//! - A token is guessed, or lives in localStorage and still works after a
//!   restart that the user did not consent to.
//! - A renderer-supplied child name (`../..`, an absolute path, a drive root)
//!   escapes the directory the user picked.
//! - A file selected as a plain file is swapped for a symbolic link between
//!   the picker and the read.
//!
//! The only minting surface is the native dialog commands in `main.rs` and the
//! native drag-drop event, which receives paths from the operating system
//! rather than from the webview. Grants live in process memory: a restart
//! invalidates every token, so recovery re-asks through a native dialog.

use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::RngCore;

/// 256 bits of entropy, hex encoded. Long enough that guessing is not a threat
/// and fixed length so a malformed token is rejected before any hashing.
const TOKEN_BYTES: usize = 32;
const TOKEN_HEX_LEN: usize = TOKEN_BYTES * 2;

/// Grants survive a long working session but not forever. Expiry is a second
/// line of defence; the process boundary is the primary one.
const GRANT_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// A single drag can carry a folder tree. The paths themselves are minted on
/// demand during the scan, so only the drop roots are queued here.
const MAX_PENDING_DROP_PATHS: usize = 256;

/// What a grant was minted for. Each purpose maps to the command families that
/// may spend it; see [`GrantPurpose::allows`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GrantPurpose {
    UploadFile,
    UploadRoot,
    DownloadDestination,
    ExportText,
    Reveal,
}

/// The capability a command asks for. Kept separate from purpose so one grant
/// can authorize a narrow set of related operations (for example a download
/// destination may be revealed in the file manager) without granting write
/// access to a file the user picked for upload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GrantUse {
    ReadUploadFile,
    ScanUploadRoot,
    WriteDownload,
    ExportText,
    QueryPath,
    Reveal,
}

impl GrantPurpose {
    pub(crate) fn allows(self, use_: GrantUse) -> bool {
        match use_ {
            // Existence and free-space probes reveal nothing beyond the path
            // the user already chose and never mutate it.
            GrantUse::QueryPath => true,
            GrantUse::Reveal => !matches!(self, GrantPurpose::ExportText),
            GrantUse::ReadUploadFile => self == GrantPurpose::UploadFile,
            GrantUse::ScanUploadRoot => self == GrantPurpose::UploadRoot,
            GrantUse::WriteDownload => self == GrantPurpose::DownloadDestination,
            GrantUse::ExportText => self == GrantPurpose::ExportText,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            GrantPurpose::UploadFile => "upload file",
            GrantPurpose::UploadRoot => "upload folder",
            GrantPurpose::DownloadDestination => "download destination",
            GrantPurpose::ExportText => "text export",
            GrantPurpose::Reveal => "reveal",
        }
    }
}

#[derive(Clone, Debug)]
struct Grant {
    path: PathBuf,
    purpose: GrantPurpose,
    is_dir: bool,
    expected_len: Option<u64>,
    /// Canonical identity at mint time, when the item already existed. A
    /// re-pointed parent directory changes it even though the path string is
    /// unchanged.
    canonical_identity: Option<PathBuf>,
    expires_at: Instant,
}

/// A resolved grant. The caller must still re-check the filesystem at use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GrantedPath {
    pub path: PathBuf,
    pub is_dir: bool,
    pub expected_len: Option<u64>,
    pub canonical_identity: Option<PathBuf>,
}

impl GrantedPath {
    /// Reject a symbolic link at the granted path. Dialog picks resolve to the
    /// selected item; a link that replaced it afterwards is not the item the
    /// user chose.
    pub(crate) fn reject_symlink(&self) -> Result<(), String> {
        if self
            .path
            .symlink_metadata()
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(format!(
                "Refusing to use a symbolic link for the granted path: {}",
                self.path.display()
            ));
        }
        Ok(())
    }
}

fn grants() -> &'static Mutex<HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_drops() -> &'static Mutex<VecDeque<PathBuf>> {
    static DROPS: OnceLock<Mutex<VecDeque<PathBuf>>> = OnceLock::new();
    DROPS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn mint_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn insert_grant(
    purpose: GrantPurpose,
    path: &Path,
    is_dir: bool,
    expected_len: Option<u64>,
    ttl: Duration,
) -> String {
    let token = mint_token();
    // Normalize once at mint so later equality checks do not trip over
    // Windows extended prefixes or a relative form the callback returned.
    let normalized = PathBuf::from(crate::files::absolute_path_string_no_follow(path));
    let canonical_identity = std::fs::canonicalize(path).ok();
    let grant = Grant {
        path: normalized,
        purpose,
        is_dir,
        expected_len,
        canonical_identity,
        expires_at: Instant::now() + ttl,
    };
    if let Ok(mut table) = grants().lock() {
        table.insert(token.clone(), grant);
        // Expired entries are never spendable, but drop them opportunistically
        // so a long session does not grow the table without bound.
        let now = Instant::now();
        table.retain(|_, entry| entry.expires_at > now);
    }
    token
}

/// Mint a grant for a path the user chose in a native dialog.
pub(crate) fn mint(
    purpose: GrantPurpose,
    path: &Path,
    is_dir: bool,
    expected_len: Option<u64>,
) -> String {
    insert_grant(purpose, path, is_dir, expected_len, GRANT_TTL)
}

fn validate_token_shape(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.len() != TOKEN_HEX_LEN || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("A local path grant is required; choose the path again.".to_string());
    }
    Ok(token)
}

/// True when a renderer-supplied file name is a single safe path component.
pub(crate) fn is_valid_child_name(name: &str) -> bool {
    validate_child_name(name).is_ok()
}

/// Spend a grant for one operation. The token is reusable for further uses of
/// the same capability until it expires or the process exits.
pub(crate) fn authorize(token: &str, use_: GrantUse) -> Result<GrantedPath, String> {
    let token = validate_token_shape(token)?;
    let mut table = grants()
        .lock()
        .map_err(|_| "Local path grants are unavailable".to_string())?;
    let Some(grant) = table.get(token).cloned() else {
        return Err("That local path grant is no longer valid; choose the path again.".to_string());
    };
    if Instant::now() >= grant.expires_at {
        table.remove(token);
        return Err("That local path grant expired; choose the path again.".to_string());
    }
    if !grant.purpose.allows(use_) {
        return Err(format!(
            "A {} grant cannot be used for this operation; choose the path again.",
            grant.purpose.label()
        ));
    }
    Ok(GrantedPath {
        path: grant.path,
        is_dir: grant.is_dir,
        expected_len: grant.expected_len,
        canonical_identity: grant.canonical_identity,
    })
}

/// Reject a renderer-supplied child name.
///
/// The webview computes download file names from S3 keys, but a compromised
/// webview can send anything. Only a single normal path component is allowed,
/// so the result always stays directly inside the granted directory.
fn validate_child_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A file name is required for this grant.".to_string());
    }
    if trimmed.contains('\0') || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!(
            "File name must not contain path separators: {}",
            trimmed
        ));
    }
    if matches!(trimmed, "." | "..") {
        return Err(format!("File name is not allowed: {}", trimmed));
    }
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {
            // Reuse the platform name rules so a download name cannot become a
            // Windows device name, trailing-dot alias, or ADS path.
            crate::validate_windows_file_name(Path::new(trimmed))?;
            Ok(trimmed)
        }
        _ => Err(format!(
            "File name must be a single relative component: {}",
            trimmed
        )),
    }
}

/// Resolve a grant, optionally joining one renderer-supplied child name.
///
/// Naming a child is only valid when the grant is a directory; a file grant is
/// spent exactly on the file the user picked.
pub(crate) fn resolve(
    token: &str,
    use_: GrantUse,
    name: Option<&str>,
) -> Result<GrantedPath, String> {
    let granted = authorize(token, use_)?;
    let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(granted);
    };
    if !granted.is_dir {
        return Err(
            "The granted path is a file, so it cannot take a child name; choose the path again."
                .to_string(),
        );
    }
    let child = validate_child_name(name)?;
    Ok(GrantedPath {
        path: granted.path.join(child),
        is_dir: false,
        expected_len: None,
        canonical_identity: None,
    })
}

/// Re-check an `upload-file` grant immediately before the bytes are read.
///
/// The picker resolved the file once; this second look catches a file that was
/// replaced by a symbolic link, became unreadable, or changed size while the
/// transfer sat in the queue.
pub(crate) fn revalidate_upload_source(token: &str) -> Result<PathBuf, String> {
    let granted = authorize(token, GrantUse::ReadUploadFile)?;
    granted.reject_symlink()?;
    let metadata = std::fs::metadata(&granted.path).map_err(|err| {
        format!(
            "Local file is no longer accessible: {} ({})",
            granted.path.display(),
            err
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Granted upload path is not a file: {}",
            granted.path.display()
        ));
    }
    if let Some(expected) = granted.expected_len {
        if metadata.len() != expected {
            return Err(format!(
                "Local file changed since it was selected (expected {} bytes, found {}); re-select the file.",
                expected,
                metadata.len()
            ));
        }
    }
    let current = crate::files::absolute_path_string_no_follow(&granted.path);
    if current != granted.path.to_string_lossy() {
        return Err(format!(
            "Granted upload path now resolves elsewhere: {}",
            granted.path.display()
        ));
    }
    if let Some(identity) = &granted.canonical_identity {
        let now = std::fs::canonicalize(&granted.path).map_err(|err| {
            format!(
                "Local file is no longer accessible: {} ({})",
                granted.path.display(),
                err
            )
        })?;
        if &now != identity {
            return Err(format!(
                "Granted upload path now resolves elsewhere: {}",
                granted.path.display()
            ));
        }
    }
    std::fs::File::open(&granted.path).map_err(|err| {
        format!(
            "Local file is no longer readable: {} ({})",
            granted.path.display(),
            err
        )
    })?;
    Ok(granted.path)
}

/// Remember paths delivered by the operating system's drag-drop event.
///
/// The renderer never supplies these paths: the window event carries the OS
/// payload, and the webview can only ask to spend whatever the last native
/// drop handed over.
pub(crate) fn record_native_drop(paths: Vec<PathBuf>) {
    let Ok(mut queue) = pending_drops().lock() else {
        return;
    };
    for path in paths {
        if queue.len() >= MAX_PENDING_DROP_PATHS {
            break;
        }
        if !path.is_absolute() {
            continue;
        }
        queue.push_back(path);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DroppedPathGrant {
    pub token: String,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Take the paths of the most recent native drop as freshly minted grants.
pub(crate) fn take_native_drop_grants() -> Vec<DroppedPathGrant> {
    let mut queue = match pending_drops().lock() {
        Ok(queue) => queue,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    while let Some(path) = queue.pop_front() {
        let Ok(metadata) = path.symlink_metadata() else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let is_dir = metadata.is_dir();
        if !is_dir && !metadata.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let purpose = if is_dir {
            GrantPurpose::UploadRoot
        } else {
            GrantPurpose::UploadFile
        };
        let expected_len = if is_dir { None } else { Some(metadata.len()) };
        let token = mint(purpose, &path, is_dir, expected_len);
        out.push(DroppedPathGrant {
            token,
            path: crate::files::absolute_path_string_no_follow(&path),
            name,
            is_dir,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "s3-sidekick-path-authority-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tokens_are_unguessable_and_not_reused() {
        let dir = scratch_dir("tokens");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        let first = mint(GrantPurpose::UploadFile, &file, false, Some(1));
        let second = mint(GrantPurpose::UploadFile, &file, false, Some(1));
        assert_eq!(first.len(), TOKEN_HEX_LEN);
        assert_ne!(first, second);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_grant_is_spendable_only_for_its_purpose() {
        let dir = scratch_dir("purpose");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        let token = mint(GrantPurpose::UploadFile, &file, false, Some(1));
        assert!(authorize(&token, GrantUse::ReadUploadFile).is_ok());
        assert!(authorize(&token, GrantUse::QueryPath).is_ok());
        assert!(authorize(&token, GrantUse::Reveal).is_ok());
        for denied in [
            GrantUse::ScanUploadRoot,
            GrantUse::WriteDownload,
            GrantUse::ExportText,
        ] {
            let err = authorize(&token, denied).expect_err("purpose must bind the grant");
            assert!(err.contains("cannot be used"), "unexpected error: {}", err);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_or_malformed_token_is_rejected() {
        for token in ["", "abc", &"z".repeat(TOKEN_HEX_LEN)] {
            assert!(authorize(token, GrantUse::QueryPath).is_err());
        }
        assert!(authorize(&"0".repeat(TOKEN_HEX_LEN), GrantUse::QueryPath)
            .expect_err("random token must not authorize")
            .contains("no longer valid"));
    }

    #[test]
    fn an_expired_grant_is_rejected_and_forgotten() {
        let dir = scratch_dir("expiry");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        let token = insert_grant(
            GrantPurpose::UploadFile,
            &file,
            false,
            Some(1),
            Duration::from_millis(1),
        );
        std::thread::sleep(Duration::from_millis(5));
        // Another test's mint may sweep the expired entry between the sleep
        // and this call, so both "expired" and "no longer valid" are correct
        // refusals; what matters is that it cannot authorize.
        let err = authorize(&token, GrantUse::ReadUploadFile)
            .expect_err("expired grant must not authorize");
        assert!(err.contains("grant"), "unexpected error: {}", err);
        assert!(!grants().lock().unwrap().contains_key(&token));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_names_cannot_escape_the_granted_directory() {
        for name in ["../escape", "/etc/passwd", "a/b", "a\\b", "..", ".", ""] {
            assert!(
                validate_child_name(name).is_err(),
                "name must be rejected: {:?}",
                name
            );
        }
        assert_eq!(validate_child_name("photo 1.png").unwrap(), "photo 1.png");
    }

    #[test]
    fn a_directory_grant_joins_one_child_but_a_file_grant_does_not() {
        let dir = scratch_dir("join");
        let dir_token = mint(GrantPurpose::DownloadDestination, &dir, true, None);
        let resolved = resolve(&dir_token, GrantUse::WriteDownload, Some("out.bin")).unwrap();
        assert_eq!(resolved.path, dir.join("out.bin"));
        assert!(!resolved.is_dir);

        let file = dir.join("picked.bin");
        let file_token = mint(GrantPurpose::DownloadDestination, &file, false, None);
        assert!(resolve(&file_token, GrantUse::WriteDownload, Some("other.bin")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn native_drop_grants_are_minted_once_per_path() {
        let dir = scratch_dir("drop");
        let file = dir.join("dropped.txt");
        let mut handle = std::fs::File::create(&file).unwrap();
        handle.write_all(b"drop").unwrap();
        drop(handle);
        record_native_drop(vec![file.clone()]);
        let first = take_native_drop_grants();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].name, "dropped.txt");
        assert!(!first[0].is_dir);
        assert!(authorize(&first[0].token, GrantUse::ReadUploadFile).is_ok());
        assert!(take_native_drop_grants().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
