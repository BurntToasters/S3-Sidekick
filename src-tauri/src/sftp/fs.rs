//! Remote filesystem commands: list, stat, create, rename, delete, and preview.
//!
//! Commands that take `tauri::State` return a boxed future, as S3 commands do.
//!
//! Failure modes, enumerated before the bodies:
//! - A path reaches the server unvalidated, or a lossy (U+FFFD) name addresses
//!   another entry. Every command validates first. A lossy path is refused, and a
//!   folder holding a lossy entry is refused before anything in it is deleted.
//! - A symlink is followed by list, stat, delete, or the walk. Metadata is lstat,
//!   and a link is unlinked, never opened. Preview resolves a link once.
//! - A listing is unbounded or unsorted. It is sorted by name and cut at 5,000.
//! - A rename replaces an existing target, a folder target, or removes the target
//!   before a failing rename. The target is checked first.
//! - A recursive delete removes home, `/`, or an ancestor of home, or reports
//!   success for a folder that still holds entries. The canonical path is checked,
//!   the tree is counted before any removal, and a failed child blocks its parents.
//! - A cancelled or dead transport reports success or a generic error. Each call
//!   races the cancel token, and a dead transport carries the lost-connection prefix.
//! - A preview opens a FIFO or device and blocks, or reads without a cap. Only
//!   regular files are opened, and reads go through `read_preview_body`.
//! - An unknown-type file is shown as text only when `looks_like_text` accepts its
//!   bytes. Known binary extensions are never read this way.
//! - Two mutations of one path interleave. Renames and folder deletes take prefix
//!   leases; other mutations take key leases through the S3 lease registry.

use std::collections::HashSet;
use std::future::Future;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};

use super::path::{join_remote, normalize_remote_path, split_parent};
use super::session::{map_sftp_error, require_session, SftpHandle, SFTP_CONNECTION_LOST};
use super::types::{
    SftpDeleteFailure, SftpDeleteResult, SftpEntry, SftpEntryKind, SftpListResponse,
    SftpRenameOutcome,
};
use crate::s3::{
    cancelled_error, is_text_content_type, plan_preview, read_preview_body, CancelToken,
    PreviewPlan, PreviewResponse, MAX_PREFIX_TRANSACTION_OBJECTS,
};
use crate::{AppState, S3MutationScope};

/// Most entries one listing returns. A larger folder is listed as truncated.
const MAX_LIST_ENTRIES: usize = 5_000;

/// The replacement character russh-sftp writes for a name that is not UTF-8.
const REPLACEMENT_CHAR: char = '\u{FFFD}';

/// S3 bucket names are never empty, so an SFTP lease scope cannot overlap an
/// S3 scope even when the two share a connection ID.
pub(super) const LEASE_NAMESPACE: &str = "";

/// Longest file name most filesystems accept, in bytes.
pub(super) const MAX_NAME_BYTES: usize = 255;

/// Random backup names tried before an overwrite is refused.
const BACKUP_NAME_ATTEMPTS: usize = 8;

const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFREG: u32 = 0o100_000;
const S_IFLNK: u32 = 0o120_000;

const UNDECODABLE_PATH: &str =
    "Remote path contains a name that could not be decoded as UTF-8 and cannot be addressed safely";
const UNDECODABLE_ENTRY: &str =
    "Folder contains an entry whose name could not be decoded as UTF-8; nothing was deleted";
const NOT_REMOVED_BLOCKED: &str = "Not removed: an entry inside it could not be deleted";

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
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let context = format!("list {}", path);
    // lstat the folder first: opendir would follow a symlink to a folder.
    let attrs = call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(path.clone()),
    )
    .await
    .map_err(|err| err.into_message(&path))?;
    if is_symlink(&attrs) {
        return Err(format!(
            "Remote path is a symbolic link and is not followed: {}",
            path
        ));
    }
    if !is_dir(&attrs) {
        return Err(format!("Remote path is not a folder: {}", path));
    }
    let listing = call(handle, &token, &context, handle.sftp.read_dir(path.clone()))
        .await
        .map_err(|err| err.into_message(&path))?;
    let mut rows: Vec<(String, String, FileAttributes)> = Vec::new();
    for entry in listing {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = join_remote(&path, &name).map_err(|err| {
            format!(
                "Folder listing refused: an entry name is not a single path segment ({})",
                err
            )
        })?;
        rows.push((name, child, entry.metadata()));
    }
    rows.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let truncated = rows.len() > MAX_LIST_ENTRIES;
    rows.truncate(MAX_LIST_ENTRIES);
    let entries = rows
        .into_iter()
        .map(|(name, child, attrs)| entry_from(name, child, &attrs))
        .collect();
    Ok(SftpListResponse {
        path,
        entries,
        truncated,
    })
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
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let context = format!("stat {}", path);
    let attrs = call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(path.clone()),
    )
    .await
    .map_err(|err| err.into_message(&path))?;
    Ok(entry_from(leaf_name(&path), path, &attrs))
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
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let context = format!("exists {}", path);
    // lstat, so a dangling symlink exists and a link is never followed.
    match call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(path.clone()),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(CallError::NotFound) => Ok(false),
        Err(err) => Err(err.into_message(&path)),
    }
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
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let _lease = crate::acquire_s3_mutation_cancellable(
        vec![S3MutationScope::key(&connection_id, LEASE_NAMESPACE, &path)],
        &token,
    )
    .await?;
    let context = format!("create folder {}", path);
    match call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(path.clone()),
    )
    .await
    {
        Ok(_) => return Err(already_exists(&path)),
        Err(CallError::NotFound) => {}
        Err(err) => return Err(err.into_message(&path)),
    }
    match call(
        handle,
        &token,
        &context,
        handle.sftp.create_dir(path.clone()),
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(CallError::NotFound) => Err(format!("Parent folder not found for {}", path)),
        Err(err @ (CallError::Cancelled | CallError::Lost(_))) => Err(err.into_message(&path)),
        Err(err) => {
            // OpenSSH reports an existing path as a generic failure, so look again
            // before reporting one.
            if call(
                handle,
                &token,
                &context,
                handle.sftp.symlink_metadata(path.clone()),
            )
            .await
            .is_ok()
            {
                return Err(already_exists(&path));
            }
            Err(err.into_message(&path))
        }
    }
}

/// Rename a remote path. `overwrite` must be true to replace an existing target.
#[tauri::command(async)]
pub(crate) fn sftp_rename(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    from_path: String,
    to_path: String,
    overwrite: bool,
) -> impl std::future::Future<Output = Result<SftpRenameOutcome, String>> + Send + use<'_> {
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
) -> Result<SftpRenameOutcome, String> {
    let from = validated_path(&from_path)?;
    let to = validated_path(&to_path)?;
    if from == "/" {
        return Err("The root folder cannot be renamed".to_string());
    }
    if from == to {
        return Err("Source and destination are the same path".to_string());
    }
    if to.starts_with(&format!("{}/", from)) {
        return Err("A folder cannot be moved into itself or one of its descendants".to_string());
    }
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    // Prefix leases cover a whole subtree, so a rename of an ancestor waits for
    // a delete below it, and the reverse.
    let _lease = crate::acquire_s3_mutation_cancellable(
        vec![
            S3MutationScope::prefix(&connection_id, LEASE_NAMESPACE, &from),
            S3MutationScope::prefix(&connection_id, LEASE_NAMESPACE, &to),
        ],
        &token,
    )
    .await?;
    let context = format!("rename {}", from);
    let source = call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(from.clone()),
    )
    .await
    .map_err(|err| match err {
        CallError::NotFound => format!("Source not found: {}", from),
        other => other.into_message(&from),
    })?;
    let existing = match call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(to.clone()),
    )
    .await
    {
        Ok(attrs) => Some(attrs),
        Err(CallError::NotFound) => None,
        Err(err) => return Err(err.into_message(&to)),
    };
    // Overwrite is a backup swap. The existing target is renamed aside, so the
    // original stays reachable until the source is in place. russh-sftp 3.0.1
    // sends a plain SSH_FXP_RENAME, which cannot replace a target in one step (no
    // posix-rename extension). Remaining non-atomic window: between the two renames
    // the target name is absent, so a reader or writer in that window sees no target.
    let mut backup: Option<String> = None;
    if let Some(target) = &existing {
        if !overwrite {
            return Err(already_exists(&to));
        }
        if is_dir(target) {
            return Err(format!("Refusing to replace the folder {}", to));
        }
        if is_dir(&source) {
            return Err(format!("Refusing to replace the file {} with a folder", to));
        }
        let backup_path = free_backup_path(handle, &token, &context, &to).await?;
        call(
            handle,
            &token,
            &context,
            handle.sftp.rename(to.clone(), backup_path.clone()),
        )
        .await
        .map_err(|err| err.into_message(&to))?;
        backup = Some(backup_path);
    }
    let outcome = call(
        handle,
        &token,
        &context,
        handle.sftp.rename(from.clone(), to.clone()),
    )
    .await;
    let err = match outcome {
        Ok(()) => {
            let mut warning = None;
            if let Some(backup) = backup {
                // The new target is in place, so a failed removal leaves only the
                // hidden backup behind. The user is told, because it still holds
                // the replaced content.
                if handle.sftp.remove_file(backup.clone()).await.is_err() {
                    warning = Some(leftover_backup_warning(&to, &backup));
                }
            }
            return Ok(SftpRenameOutcome { warning });
        }
        Err(err) => err,
    };
    let message = match err {
        CallError::NotFound => format!("Destination folder not found for {}", to),
        other => other.into_message(&from),
    };
    if let Some(backup) = backup {
        // A plain await, so a cancel or disconnect cannot skip putting the original back.
        return Err(match handle.sftp.rename(backup.clone(), to.clone()).await {
            Ok(()) => message,
            Err(restore) => format!(
                "{}; the original destination could not be restored and is kept at {} ({})",
                message, backup, restore
            ),
        });
    }
    // Nothing was replaced. OpenSSH refuses an existing regular-file target with a
    // generic failure, so look again before reporting the failure as-is.
    if !overwrite
        && call(
            handle,
            &token,
            &context,
            handle.sftp.symlink_metadata(to.clone()),
        )
        .await
        .is_ok()
    {
        return Err(already_exists(&to));
    }
    Err(message)
}

/// A free hidden sibling of `target` to hold its backup during an overwrite. The
/// name carries 16 random hex digits, and lstat confirms nothing has that name, so
/// no existing entry is renamed over.
pub(super) async fn free_backup_path(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    target: &str,
) -> Result<String, String> {
    let (parent, leaf) = split_parent(target)?;
    for _ in 0..BACKUP_NAME_ATTEMPTS {
        let Some(backup_leaf) = backup_leaf(&leaf, rand::random::<u64>()) else {
            return Err(format!(
                "Cannot overwrite {}: its name is too long for a backup name",
                target
            ));
        };
        let candidate = join_remote(&parent, &backup_leaf)?;
        match call(
            handle,
            token,
            context,
            handle.sftp.symlink_metadata(candidate.clone()),
        )
        .await
        {
            Err(CallError::NotFound) => return Ok(candidate),
            Ok(_) => continue,
            Err(err) => return Err(err.into_message(&candidate)),
        }
    }
    Err(format!(
        "Cannot overwrite {}: no free backup name was found",
        target
    ))
}

/// The hidden backup name for `leaf`: `.<leaf>.s3sk-bak-<16 hex digits>`. `None`
/// when that name would exceed the file-name limit.
fn backup_leaf(leaf: &str, nonce: u64) -> Option<String> {
    let name = format!(".{}.s3sk-bak-{:016x}", leaf, nonce);
    (name.len() <= MAX_NAME_BYTES).then_some(name)
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
    if paths.len() > MAX_PREFIX_TRANSACTION_OBJECTS {
        return Err(format!(
            "Delete request exceeds the {}-path limit; nothing was deleted",
            MAX_PREFIX_TRANSACTION_OBJECTS
        ));
    }
    // Every path is validated before anything is deleted, so one bad path refuses the batch.
    let mut targets: Vec<String> = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for path in &paths {
        let path = validated_path(path)?;
        if seen.insert(path.clone()) {
            targets.push(path);
        }
    }
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let scopes = targets
        .iter()
        .map(|path| S3MutationScope::key(&connection_id, LEASE_NAMESPACE, path))
        .collect();
    let _lease = crate::acquire_s3_mutation_cancellable(scopes, &token).await?;
    let mut result = SftpDeleteResult {
        deleted: Vec::new(),
        failed: Vec::new(),
    };
    for path in targets {
        let context = format!("delete {}", path);
        let attrs = match call(
            handle,
            &token,
            &context,
            handle.sftp.symlink_metadata(path.clone()),
        )
        .await
        {
            Ok(attrs) => attrs,
            Err(err @ (CallError::Cancelled | CallError::Lost(_))) => {
                return Err(abort_message(err, result.deleted.len()))
            }
            Err(err) => {
                let error = err.into_message(&path);
                result.failed.push(SftpDeleteFailure { path, error });
                continue;
            }
        };
        if is_dir(&attrs) {
            result.failed.push(SftpDeleteFailure {
                path,
                error: "Remote path is a folder; delete it with the folder delete command"
                    .to_string(),
            });
            continue;
        }
        // remove_file unlinks a symlink itself, so a link is never followed.
        match call(
            handle,
            &token,
            &context,
            handle.sftp.remove_file(path.clone()),
        )
        .await
        {
            Ok(()) => result.deleted.push(path),
            Err(err @ (CallError::Cancelled | CallError::Lost(_))) => {
                return Err(abort_message(err, result.deleted.len()))
            }
            Err(err) => {
                let error = err.into_message(&path);
                result.failed.push(SftpDeleteFailure { path, error });
            }
        }
    }
    Ok(result)
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

/// One entry of a folder tree: its path, whether it is a folder, and the index
/// of the folder that holds it. Entries are appended after their folder, so
/// walking the list backwards removes every entry before its folder.
struct WalkNode {
    path: String,
    is_dir: bool,
    parent: Option<usize>,
}

async fn sftp_delete_dir_inner(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    path: String,
    transfer_id: Option<u32>,
) -> Result<SftpDeleteResult, String> {
    let root = validated_path(&path)?;
    if root == "/" {
        return Err("The root folder cannot be deleted".to_string());
    }
    let registered = require_session(&state, &connection_id, transfer_id)?;
    let token = registered.token();
    let handle = &registered.handle;
    let _lease = crate::acquire_s3_mutation_cancellable(
        vec![S3MutationScope::prefix(
            &connection_id,
            LEASE_NAMESPACE,
            &root,
        )],
        &token,
    )
    .await?;
    let context = format!("delete folder {}", root);
    let attrs = call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(root.clone()),
    )
    .await
    .map_err(|err| match err {
        CallError::NotFound => format!("Folder not found: {}", root),
        other => other.into_message(&root),
    })?;
    if is_symlink(&attrs) {
        return Err(format!(
            "Remote path is a symbolic link and is not followed; delete it as a file: {}",
            root
        ));
    }
    if !is_dir(&attrs) {
        return Err(format!("Remote path is not a folder: {}", root));
    }
    // Resolve intermediate symlinks before the protected-folder check, so an
    // alias of home is refused the same way home is.
    let canonical = call(
        handle,
        &token,
        &context,
        handle.sftp.canonicalize(root.clone()),
    )
    .await
    .map_err(|err| err.into_message(&root))?;
    refuse_protected_folder(&canonical, &handle.home)?;

    // Walk the whole tree before deleting anything, so an over-limit tree is
    // refused with nothing removed.
    let mut nodes = vec![WalkNode {
        path: root.clone(),
        is_dir: true,
        parent: None,
    }];
    let mut cursor = 0usize;
    while let Some((folder, folder_is_dir)) = nodes
        .get(cursor)
        .map(|node| (node.path.clone(), node.is_dir))
    {
        if folder_is_dir {
            let listing = call(
                handle,
                &token,
                &context,
                handle.sftp.read_dir(folder.clone()),
            )
            .await
            .map_err(|err| err.into_message(&folder))?;
            let mut names = Vec::new();
            for entry in listing {
                let name = entry.file_name();
                if name != "." && name != ".." {
                    // READDIR attributes are lstat results on OpenSSH, but the
                    // protocol does not promise that. Only "not a folder" is
                    // trusted from them: a link reported as a folder is checked
                    // again below, so the walk never descends through a link.
                    let surely_not_dir = entry
                        .metadata()
                        .permissions
                        .is_some_and(|mode| !matches!(kind_of(Some(mode)), SftpEntryKind::Dir));
                    names.push((name, surely_not_dir));
                }
            }
            if nodes.len() + names.len() > MAX_PREFIX_TRANSACTION_OBJECTS {
                return Err(format!(
                    "Folder holds more than {} entries; nothing was deleted",
                    MAX_PREFIX_TRANSACTION_OBJECTS
                ));
            }
            for (name, surely_not_dir) in names {
                if name.contains(REPLACEMENT_CHAR) {
                    return Err(UNDECODABLE_ENTRY.to_string());
                }
                let child = join_remote(&folder, &name).map_err(|err| {
                    format!(
                        "Folder contains an entry whose name is not a single path segment; nothing was deleted ({})",
                        err
                    )
                })?;
                let child_is_dir = if surely_not_dir {
                    false
                } else {
                    let child_attrs = call(
                        handle,
                        &token,
                        &context,
                        handle.sftp.symlink_metadata(child.clone()),
                    )
                    .await
                    .map_err(|err| match err {
                        CallError::NotFound => format!(
                            "Entry changed during the walk; nothing was deleted: {}",
                            child
                        ),
                        other => other.into_message(&child),
                    })?;
                    is_dir(&child_attrs)
                };
                nodes.push(WalkNode {
                    is_dir: child_is_dir,
                    path: child,
                    parent: Some(cursor),
                });
            }
        }
        cursor += 1;
    }

    // Children before folders. A child that could not be removed blocks each
    // ancestor, so a folder is reported as removed only when it is gone.
    let total = nodes.len();
    let mut blocked = vec![false; total];
    let mut failed = Vec::new();
    let mut removed = 0usize;
    let mut interrupted = None;
    for (index, node) in nodes.iter().enumerate().rev() {
        if blocked.get(index).copied().unwrap_or(false) {
            failed.push(SftpDeleteFailure {
                path: node.path.clone(),
                error: NOT_REMOVED_BLOCKED.to_string(),
            });
            block_parent(&mut blocked, node.parent);
            continue;
        }
        let outcome = if node.is_dir {
            call(
                handle,
                &token,
                &context,
                handle.sftp.remove_dir(node.path.clone()),
            )
            .await
        } else {
            call(
                handle,
                &token,
                &context,
                handle.sftp.remove_file(node.path.clone()),
            )
            .await
        };
        match outcome {
            Ok(()) => removed += 1,
            Err(CallError::Cancelled) => {
                interrupted = Some(cancelled_error());
                break;
            }
            Err(err @ CallError::Lost(_)) => return Err(abort_message(err, removed)),
            Err(err) => {
                failed.push(SftpDeleteFailure {
                    path: node.path.clone(),
                    error: err.into_message(&node.path),
                });
                block_parent(&mut blocked, node.parent);
            }
        }
    }
    if let Some(reason) = interrupted {
        // The root is processed last, so an interrupted walk always leaves it in place.
        failed.push(SftpDeleteFailure {
            path: root,
            error: format!(
                "{}; {} of {} entries were deleted and the folder still exists",
                reason, removed, total
            ),
        });
        return Ok(SftpDeleteResult {
            deleted: Vec::new(),
            failed,
        });
    }
    if failed.is_empty() {
        return Ok(SftpDeleteResult {
            deleted: vec![root],
            failed,
        });
    }
    Ok(SftpDeleteResult {
        deleted: Vec::new(),
        failed,
    })
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
    let path = validated_path(&path)?;
    let registered = require_session(&state, &connection_id, None)?;
    let token = registered.token();
    let handle = &registered.handle;
    let context = format!("preview {}", path);
    let link = call(
        handle,
        &token,
        &context,
        handle.sftp.symlink_metadata(path.clone()),
    )
    .await
    .map_err(|err| err.into_message(&path))?;
    // A symlink is resolved once, so its target's kind decides what is read.
    let attrs = if is_symlink(&link) {
        call(handle, &token, &context, handle.sftp.metadata(path.clone()))
            .await
            .map_err(|err| err.into_message(&path))?
    } else {
        link
    };
    match kind_of(attrs.permissions) {
        SftpEntryKind::File => {}
        SftpEntryKind::Dir => return Err(format!("Remote path is a folder, not a file: {}", path)),
        // Opening a FIFO or device would block the server, so only regular files are read.
        SftpEntryKind::Symlink | SftpEntryKind::Other => {
            return Err(format!("Remote path is not a regular file: {}", path))
        }
    }
    let total_size = attrs.size.ok_or_else(|| {
        format!(
            "Preview is unavailable because the size of {} is unknown",
            path
        )
    })?;
    let total = i64::try_from(total_size).unwrap_or(i64::MAX);
    let name = leaf_name(&path);
    let guessed = guess_content_type(&name);
    // A file of unknown type is read as text, and answered as text only when its
    // bytes look like text. A known binary extension is never read this way.
    let probe = guessed == "application/octet-stream" && !is_known_binary_name(&name);
    let read_type = if probe { "text/plain" } else { guessed };
    if plan_preview(read_type, total) != PreviewPlan::Read {
        return Ok(unsupported_preview(guessed, total));
    }
    let mut file = call(handle, &token, &context, handle.sftp.open(path.clone()))
        .await
        .map_err(|err| err.into_message(&path))?;
    // The file handle closes when `file` drops. read_preview_body enforces the
    // per-type cap and honours the cancel token.
    let body = read_preview_body(&mut file, read_type, &token)
        .await
        .map_err(|message| {
            if message == cancelled_error() || !handle.is_lost() {
                message
            } else {
                format!("{}: preview {}", SFTP_CONNECTION_LOST, path)
            }
        })?;
    if probe && !looks_like_text(&body.bytes, body.truncated) {
        return Ok(unsupported_preview(guessed, total));
    }
    let content_type = read_type.to_string();
    let is_text = is_text_content_type(&content_type);
    let data = if is_text {
        String::from_utf8_lossy(&body.bytes).into_owned()
    } else {
        B64.encode(&body.bytes)
    };
    Ok(PreviewResponse {
        content_type,
        data,
        is_text,
        truncated: body.truncated,
        total_size: total,
    })
}

/// Why one SFTP call did not produce its value.
pub(super) enum CallError {
    /// The transfer was cancelled or the session was disconnected mid-call.
    Cancelled,
    /// The server reported that the path does not exist.
    NotFound,
    /// The SSH transport closed. The message starts with `SFTP connection lost`.
    Lost(String),
    /// Any other failure, with its context.
    Failed(String),
}

impl CallError {
    /// The message the webview shows when this failure ends the command.
    pub(super) fn into_message(self, path: &str) -> String {
        match self {
            CallError::Cancelled => cancelled_error(),
            CallError::NotFound => format!("Remote path not found: {}", path),
            CallError::Lost(message) | CallError::Failed(message) => message,
        }
    }
}

/// Run one SFTP call, racing it against the cancel token and classifying a failure.
pub(super) async fn call<T, F>(
    handle: &SftpHandle,
    token: &CancelToken,
    context: &str,
    future: F,
) -> Result<T, CallError>
where
    F: Future<Output = Result<T, SftpError>>,
{
    let outcome = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(CallError::Cancelled),
        outcome = future => outcome,
    };
    outcome.map_err(|err| classify(handle, context, &err))
}

pub(super) fn classify(handle: &SftpHandle, context: &str, err: &SftpError) -> CallError {
    let message = map_sftp_error(handle, context, err);
    if handle.is_lost() {
        CallError::Lost(message)
    } else if matches!(err, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
    {
        CallError::NotFound
    } else {
        CallError::Failed(message)
    }
}

/// The message for a command that stopped on a cancelled or lost call. The
/// lost-connection message keeps its prefix and reports how far the batch got.
fn abort_message(err: CallError, confirmed: usize) -> String {
    match err {
        CallError::Lost(message) => format!(
            "{} ({} path(s) deleted before the connection closed)",
            message, confirmed
        ),
        CallError::Cancelled => cancelled_error(),
        CallError::NotFound => format!("Remote path not found; {} path(s) deleted", confirmed),
        CallError::Failed(message) => message,
    }
}

/// Warning for a replaced file whose backup could not be removed.
pub(super) fn leftover_backup_warning(path: &str, backup: &str) -> String {
    format!(
        "{} was replaced, but the previous version could not be removed and is still on the server at {}. Delete it once it is no longer needed.",
        path, backup
    )
}

/// Refusal for a target that already exists. The webview treats only errors that
/// start with this text as a conflict (`SFTP_ALREADY_EXISTS` in `src/sftp.ts`).
pub(super) const ALREADY_EXISTS_PREFIX: &str = "Remote path already exists: ";

pub(super) fn already_exists(path: &str) -> String {
    format!("{}{}", ALREADY_EXISTS_PREFIX, path)
}

/// Validate a remote path, then refuse one whose name the decoder replaced.
pub(super) fn validated_path(path: &str) -> Result<String, String> {
    let path = normalize_remote_path(path)?;
    if path.contains(REPLACEMENT_CHAR) {
        return Err(UNDECODABLE_PATH.to_string());
    }
    Ok(path)
}

/// The file type of a mode word, from its type bits. A mode without a known
/// type is `Other`, and so is a missing mode.
pub(super) fn kind_of(mode: Option<u32>) -> SftpEntryKind {
    match mode.map(|mode| mode & S_IFMT) {
        Some(S_IFDIR) => SftpEntryKind::Dir,
        Some(S_IFREG) => SftpEntryKind::File,
        Some(S_IFLNK) => SftpEntryKind::Symlink,
        _ => SftpEntryKind::Other,
    }
}

pub(super) fn is_dir(attrs: &FileAttributes) -> bool {
    matches!(kind_of(attrs.permissions), SftpEntryKind::Dir)
}

pub(super) fn is_symlink(attrs: &FileAttributes) -> bool {
    matches!(kind_of(attrs.permissions), SftpEntryKind::Symlink)
}

/// Build one entry. The permission bits are the mode without its type bits,
/// which `kind` already reports.
fn entry_from(name: String, path: String, attrs: &FileAttributes) -> SftpEntry {
    let name_lossy = name.contains(REPLACEMENT_CHAR);
    SftpEntry {
        kind: kind_of(attrs.permissions),
        size: attrs.size,
        mtime: attrs.mtime.map(u64::from),
        permissions: attrs.permissions.map(|mode| mode & 0o7777),
        uid: attrs.uid,
        gid: attrs.gid,
        owner: attrs.user.clone(),
        group: attrs.group.clone(),
        name_lossy,
        name,
        path,
    }
}

/// The last segment of a validated path. The root is named `/`.
fn leaf_name(path: &str) -> String {
    match split_parent(path) {
        Ok((_, leaf)) => leaf,
        Err(_) => "/".to_string(),
    }
}

/// Refuse a recursive delete of `/`, of the home directory, or of any folder
/// that contains home. `canonical` is the resolved path and `home` the canonical
/// home directory of the session.
fn refuse_protected_folder(canonical: &str, home: &str) -> Result<(), String> {
    if canonical == "/" {
        return Err("The root folder cannot be deleted".to_string());
    }
    if canonical == home {
        return Err("The home directory cannot be deleted".to_string());
    }
    if home.starts_with(&format!("{}/", canonical)) {
        return Err("A folder that contains the home directory cannot be deleted".to_string());
    }
    Ok(())
}

fn block_parent(blocked: &mut [bool], parent: Option<usize>) {
    if let Some(flag) = parent.and_then(|index| blocked.get_mut(index)) {
        *flag = true;
    }
}

/// The content type a preview gives a file, from its name. It starts from the
/// webview's upload table in `guessContentType` (`src/transfers.ts`) and adds
/// text extensions for preview. SFTP stores no content type, so the two tables
/// can differ for the text extensions added here.
fn guess_content_type(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "tsv" => "text/tab-separated-values",
        // Source, config, and log files. Each is plain text, so a text/* type
        // lets the preview read it.
        "log" | "yaml" | "yml" | "toml" | "ini" | "conf" | "cfg" | "env" | "properties" | "sh"
        | "bash" | "zsh" | "py" | "rb" | "pl" | "php" | "rs" | "go" | "c" | "h" | "cpp" | "hpp"
        | "java" | "kt" | "swift" | "ts" | "tsx" | "jsx" | "mjs" | "cjs" | "sql" | "diff"
        | "patch" | "rst" | "tex" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

/// Extensions whose files are binary by convention. A name with one of these is
/// never read as a possible text file, even when its bytes happen to be text.
const KNOWN_BINARY_EXTENSIONS: &[&str] = &[
    "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "exe", "dll", "so", "dylib", "bin", "iso",
    "img", "dmg", "deb", "rpm", "jar", "class", "o", "a", "pyc", "mp3", "mp4", "mov", "avi", "mkv",
    "wav", "flac", "ogg", "woff", "woff2", "ttf", "otf", "sqlite", "sqlite3", "db", "pdf", "png",
    "jpg", "jpeg", "gif", "webp", "ico", "webm", "bmp", "tif", "tiff", "heic", "avif", "wasm",
];

/// Whether a name's extension is one of the known binary extensions.
fn is_known_binary_name(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .is_some_and(|extension| KNOWN_BINARY_EXTENSIONS.contains(&extension.as_str()))
}

/// Whether bytes read from a file of unknown type are text. A NUL byte means
/// binary. The bytes must be valid UTF-8, except that when `truncated` is true
/// the read stopped at the preview cap, so an incomplete character at the very
/// end is allowed. An empty file is text.
fn looks_like_text(bytes: &[u8], truncated: bool) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // `error_len() == None` means the input ended inside a character.
        Err(err) => truncated && err.error_len().is_none(),
    }
}

/// The answer for a file the preview cannot show: no data and the type the name gives.
fn unsupported_preview(content_type: &str, total_size: i64) -> PreviewResponse {
    PreviewResponse {
        content_type: content_type.to_string(),
        data: String::new(),
        is_text: false,
        truncated: false,
        total_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_reads_the_file_type_bits_and_ignores_permissions() {
        assert!(matches!(kind_of(Some(0o040755)), SftpEntryKind::Dir));
        assert!(matches!(kind_of(Some(0o100644)), SftpEntryKind::File));
        assert!(matches!(kind_of(Some(0o120777)), SftpEntryKind::Symlink));
        assert!(matches!(kind_of(Some(0o010644)), SftpEntryKind::Other));
        assert!(matches!(kind_of(Some(0o140755)), SftpEntryKind::Other));
        assert!(matches!(kind_of(Some(0o000755)), SftpEntryKind::Other));
        assert!(matches!(kind_of(None), SftpEntryKind::Other));
    }

    #[test]
    fn content_type_follows_the_webview_table_and_ignores_case() {
        assert_eq!(guess_content_type("photo.PNG"), "image/png");
        assert_eq!(guess_content_type("a.b.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("notes.txt"), "text/plain");
        assert_eq!(guess_content_type("archive.tar.gz"), "application/gzip");
        assert_eq!(guess_content_type("README"), "application/octet-stream");
        assert_eq!(guess_content_type("bundle.bmp"), "application/octet-stream");
        assert_eq!(guess_content_type(".png"), "image/png");
    }

    #[test]
    fn text_extensions_are_typed_as_text_in_any_case() {
        assert_eq!(guess_content_type("NOTES.md"), "text/markdown");
        assert_eq!(guess_content_type("guide.Markdown"), "text/markdown");
        assert_eq!(guess_content_type("app.log"), "text/plain");
        assert_eq!(guess_content_type("ci.YAML"), "text/plain");
        assert_eq!(guess_content_type("deploy.sh"), "text/plain");
        assert_eq!(guess_content_type("main.rs"), "text/plain");
        assert_eq!(guess_content_type("Component.TSX"), "text/plain");
        assert_eq!(guess_content_type("patch.diff"), "text/plain");
        assert_eq!(
            guess_content_type("export.tsv"),
            "text/tab-separated-values"
        );
        assert_eq!(guess_content_type(".env"), "text/plain");
    }

    #[test]
    fn names_without_a_known_text_type_stay_octet_stream() {
        assert_eq!(guess_content_type("README"), "application/octet-stream");
        assert_eq!(guess_content_type(".bashrc"), "application/octet-stream");
        assert_eq!(
            guess_content_type("notes.weird"),
            "application/octet-stream"
        );
    }

    #[test]
    fn known_binary_names_are_never_probed_as_text() {
        assert!(is_known_binary_name("data.bin"));
        assert!(is_known_binary_name("backup.SQLITE"));
        assert!(is_known_binary_name("disk.iso"));
        assert!(is_known_binary_name("photo.bmp"));
        assert!(!is_known_binary_name("notes.weird"));
        assert!(!is_known_binary_name(".bashrc"));
        assert!(!is_known_binary_name("README"));
    }

    #[test]
    fn plain_ascii_and_utf8_multibyte_text_looks_like_text() {
        assert!(looks_like_text(b"hello world\n", false));
        assert!(looks_like_text("héllo 名前 🦀\n".as_bytes(), false));
        assert!(looks_like_text("héllo 名前 🦀\n".as_bytes(), true));
    }

    #[test]
    fn a_nul_byte_is_never_text() {
        assert!(!looks_like_text(b"abc\0def", false));
        assert!(!looks_like_text(b"\0", true));
    }

    #[test]
    fn invalid_utf8_is_not_text() {
        assert!(!looks_like_text(&[0x66, 0xff, 0x67], false));
        // A lead byte followed by a non-continuation byte is invalid, not incomplete.
        assert!(!looks_like_text(&[0xc3, 0x28], false));
        assert!(!looks_like_text(&[0xc3, 0x28], true));
    }

    #[test]
    fn a_character_cut_at_the_read_cap_is_text_only_when_truncated() {
        let cut = &"名".as_bytes()[..2];
        assert!(looks_like_text(cut, true));
        assert!(!looks_like_text(cut, false));
    }

    #[test]
    fn an_invalid_byte_before_the_cut_is_not_excused_by_truncation() {
        assert!(!looks_like_text(&[0x61, 0xff, 0xe5, 0x90], true));
    }

    #[test]
    fn empty_content_is_text() {
        assert!(looks_like_text(&[], false));
        assert!(looks_like_text(&[], true));
    }

    #[test]
    fn leaf_name_is_the_last_segment_and_the_root_is_slash() {
        assert_eq!(leaf_name("/a/b c.txt"), "b c.txt");
        assert_eq!(leaf_name("/x"), "x");
        assert_eq!(leaf_name("/"), "/");
    }

    #[test]
    fn a_path_with_the_replacement_character_is_refused_before_any_call() {
        assert_eq!(validated_path("/a/b").expect("plain path"), "/a/b");
        assert_eq!(
            validated_path("/a/lossy-\u{FFFD}").expect_err("lossy path"),
            UNDECODABLE_PATH
        );
        // Ordinary validation still runs first.
        assert_eq!(
            validated_path("relative\u{FFFD}").expect_err("relative"),
            "Remote path must be absolute"
        );
    }

    #[test]
    fn protected_folders_are_root_home_and_the_ancestors_of_home() {
        let home = "/home/u";
        assert!(refuse_protected_folder("/", home).is_err());
        assert!(refuse_protected_folder("/home/u", home).is_err());
        assert!(refuse_protected_folder("/home", home).is_err());
        assert!(refuse_protected_folder("/home/u/sub", home).is_ok());
        assert!(refuse_protected_folder("/home/u2", home).is_ok());
        assert!(refuse_protected_folder("/home/uu", home).is_ok());
        assert!(refuse_protected_folder("/srv", home).is_ok());
    }

    #[test]
    fn backup_names_are_hidden_siblings_with_sixteen_hex_digits() {
        let leaf = backup_leaf("report.txt", 0xabc).expect("short name");
        assert_eq!(leaf, ".report.txt.s3sk-bak-0000000000000abc");
        let hex = leaf.rsplit('-').next().unwrap_or_default();
        assert_eq!(hex.len(), 16);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn backup_names_refuse_a_leaf_that_would_exceed_the_name_limit() {
        assert!(backup_leaf(&"a".repeat(200), 1).is_some());
        assert!(backup_leaf(&"a".repeat(255), 1).is_none());
    }

    #[test]
    fn a_block_marks_only_its_parent_and_ignores_the_root() {
        let mut blocked = vec![false, false, false];
        block_parent(&mut blocked, Some(0));
        assert_eq!(blocked, vec![true, false, false]);
        block_parent(&mut blocked, None);
        block_parent(&mut blocked, Some(99));
        assert_eq!(blocked, vec![true, false, false]);
    }
}
