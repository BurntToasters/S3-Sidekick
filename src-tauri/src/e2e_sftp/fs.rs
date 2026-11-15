//! Filesystem checks against the OpenSSH fleet: listing, stat, existence, create,
//! rename, delete (files and folder trees), bounded preview, and the session
//! guards. Each test records named checks listed in `tests/sftp/expected-checks/fs.json`.
//!
//! Failure modes, enumerated before `sftp/fs.rs`:
//! - A symlink is followed, or "." and ".." are listed, by list, stat or delete.
//!   Guarded by the symlink and listing checks.
//! - A lossy name addresses another entry. Guarded by the lossy-name check, which
//!   proves the byte-named file survives every refused operation.
//! - Truncation past 5,000 entries, or path validation after a session lookup.
//!   Guarded by the listing-limit and path checks.
//! - Create or rename replaces an existing path, or exists reads a denied lookup
//!   as false. Guarded by the create, rename and exists checks.
//! - A folder delete follows a link, removes home or `/`, reports success for a
//!   partly removed folder, or exceeds the bound after removing entries. Guarded
//!   by the delete_dir checks.
//! - Cancellation is ignored, or a FIFO is opened and blocks. Guarded by the
//!   cancellation and preview checks.
//! - A stale connection ID or a dead transport goes unnoticed. Guarded by the
//!   session guard checks.
//!
//! Every observed value is read from the server with `docker exec`, never copied
//! from the code under test.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::Manager;

use super::*;
use crate::s3::{cancel_transfer_in_registry, cancelled_error, MAX_PREFIX_TRANSACTION_OBJECTS};
use crate::sftp::path::{normalize_remote_path, split_parent};
use crate::sftp::session::{require_session, SFTP_CONNECTION_LOST};
use crate::sftp::types::{SftpEntry, SftpEntryKind};
use serde_json::json;

const PASSWORD_METHOD: &str = "password";
/// A connection ID the backend never minted. Commands must reject it before
/// they look at the path, so a validation message proves validation came first.
const BOGUS_CONNECTION_ID: &str = "00112233445566778899aabbccddeeff";
const TRANSFER_ID: u32 = 4242;
const MIB: usize = 1_048_576;
/// A 1x1 PNG, base64-encoded. The preview returns the bytes unchanged.
const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/// Paths that must be refused by every command before any server call.
const BAD_PATHS: [&str; 9] = [
    "",
    "relative/path",
    "~/x",
    "/a/",
    "//",
    "/a//b",
    "/a/../b",
    "/a/./b",
    "/a\0b",
];
/// Reports the server's own view of a path: a symlink is checked first, so a
/// link to a folder is never reported as a folder.
const KIND_SCRIPT: &str = "if [ -L \"$P\" ]; then echo link; elif [ -d \"$P\" ]; then echo dir; elif [ -e \"$P\" ]; then echo file; else echo missing; fi";

const CHECK_LIST: &str =
    "listing returns each entry once with its kind, size and mtime, and never '.' or '..'";
const CHECK_SYMLINK: &str =
    "a symlink is listed as a symlink with the link's own size and is not followed";
const CHECK_SYMLINK_LIST: &str = "listing a symlink to a directory is refused instead of followed";
const CHECK_ROUND_TRIP: &str =
    "names with spaces, '+' and unicode keep their path and round-trip through stat";
const CHECK_STAT_MISSING: &str = "stat of a missing path fails with 'not found'";
const CHECK_PATHS: &str = "every command refuses bad paths before any session or server call";
const CHECK_CREATE: &str =
    "create_dir makes one directory and a second create reports 'already exists'";
const CHECK_CREATE_PARENT: &str = "create_dir under a missing parent fails and creates nothing";
const CHECK_EXISTS: &str =
    "exists is true for files, folders and dangling symlinks and false for a missing path";
const CHECK_EXISTS_ERR: &str = "exists under an unreadable folder is an error, not false";
const CHECK_RENAME_NO_OVERWRITE: &str =
    "rename without overwrite refuses an existing target and leaves both files intact";
const CHECK_RENAME_OVERWRITE: &str =
    "rename with overwrite replaces a file target and removes the source name";
const CHECK_RENAME_REFUSALS: &str =
    "rename refuses identical paths, a folder into its own descendant, and a missing source";
const CHECK_RENAME_FOLDER_TARGETS: &str =
    "rename with overwrite refuses to replace a folder, or to replace a file with a folder";
const CHECK_RENAME_BACKUP: &str = "overwrite rename leaves no backup file behind on success";
const CHECK_RENAME_RESTORE: &str =
    "overwrite rename whose final step fails restores the original target";
const CHECK_DELETE_FILES: &str =
    "delete removes a file and a symlink and never the symlink's target";
const CHECK_DELETE_PER_PATH: &str =
    "delete refuses folders per path and reports missing paths as failed";
const CHECK_DELETE_BATCH: &str =
    "delete refuses a batch over MAX_PREFIX_TRANSACTION_OBJECTS or with a bad path before deleting anything";
const CHECK_DELETE_DIR_TREE: &str =
    "delete_dir removes a nested tree and reports the folder as deleted";
const CHECK_DELETE_DIR_SYMLINK: &str =
    "delete_dir removes a symlink-to-directory child as a link and keeps the target's files";
const CHECK_DELETE_DIR_PROTECTED: &str =
    "delete_dir refuses '/', the home directory, its ancestors, files and symlinks";
const CHECK_DELETE_DIR_LIMIT: &str =
    "delete_dir refuses a tree over MAX_PREFIX_TRANSACTION_OBJECTS entries before deleting anything";
const CHECK_DELETE_DIR_CANCEL: &str =
    "delete_dir cancelled mid-walk stops, leaves the folder in place and never claims success";
const CHECK_LIST_TRUNCATED: &str =
    "listing 5,001 entries returns 5,000 sorted entries with truncated true";
const CHECK_LOSSY: &str =
    "a non-UTF-8 name is listed with name_lossy, its lossy path is refused, and the file survives";
const CHECK_PREVIEW_TEXT: &str =
    "preview of a 2 MiB text file returns the first 1 MiB flagged as truncated";
const CHECK_PREVIEW_PNG: &str =
    "preview of a small PNG returns the whole file base64-encoded as image/png";
const CHECK_PREVIEW_REFUSED: &str =
    "preview refuses folders, symlinks to folders and FIFOs without reading them";
const CHECK_PREVIEW_LARGE: &str =
    "preview of an image above 16 MiB or an unsupported type returns no data without reading the body";
const CHECK_STALE: &str =
    "every command refuses a stale connection id and changes nothing on the server";
const CHECK_LOST: &str =
    "every command after the server dropped the SSH session fails with 'SFTP connection lost'";

/// Run `sh -c script` inside the container as the test user, with `vars` set.
fn remote_sh(
    container: &str,
    user: &str,
    vars: &[(&str, &str)],
    script: &str,
) -> Result<String, String> {
    let mut command = Command::new("docker");
    command.args(["exec", "-u", user]);
    for (name, value) in vars {
        command.arg("-e").arg(format!("{}={}", name, value));
    }
    command.args([container, "sh", "-c", script]);
    let output = command
        .output()
        .map_err(|err| format!("docker exec failed: {}", err))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "remote command failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// A folder under the test user's home that the test creates and removes.
struct Fixture {
    container: String,
    user: String,
    root: String,
}

impl Fixture {
    fn new(env: &Env, home: &str, name: &str) -> Self {
        assert!(
            home.starts_with('/') && !home.contains(['"', '\'', '$', '\\', '\n']),
            "unsafe home path {home:?}"
        );
        let fixture = Self {
            container: env.container.clone(),
            user: env.user.clone(),
            root: format!("{}/{}", home, name),
        };
        fixture
            .sh("rm -rf -- \"$ROOT\" && mkdir -- \"$ROOT\"")
            .expect("create fixture folder");
        fixture
    }

    fn path(&self, name: &str) -> String {
        format!("{}/{}", self.root, name)
    }

    fn sh(&self, script: &str) -> Result<String, String> {
        remote_sh(
            &self.container,
            &self.user,
            &[("ROOT", self.root.as_str())],
            script,
        )
    }

    /// The server's own view of `path`: `link`, `dir`, `file`, or `missing`.
    fn kind(&self, path: &str) -> String {
        remote_sh(&self.container, &self.user, &[("P", path)], KIND_SCRIPT)
            .map(|out| out.trim().to_string())
            .unwrap_or_else(|err| format!("error: {}", err))
    }

    /// The bytes of a file as the server holds them.
    fn read(&self, path: &str) -> String {
        remote_sh(&self.container, &self.user, &[("P", path)], "cat -- \"$P\"")
            .unwrap_or_else(|err| format!("error: {}", err))
    }

    /// Entries under `path`, including `path` itself.
    fn count(&self, path: &str) -> usize {
        remote_entry_count(&self.container, &self.user, path)
    }

    /// Regular files under `path`.
    fn file_count(&self, path: &str) -> usize {
        remote_sh(
            &self.container,
            &self.user,
            &[("P", path)],
            "find \"$P\" -type f | wc -l",
        )
        .ok()
        .and_then(|out| out.trim().parse().ok())
        .unwrap_or(usize::MAX)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Restore owner access first, so a check that locked a folder still cleans up.
        let _ = self.sh("chmod -R u+rwX -- \"$ROOT\" 2>/dev/null; rm -rf -- \"$ROOT\"");
    }
}

fn state(app: &tauri::App<tauri::test::MockRuntime>) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn kind_str(kind: &SftpEntryKind) -> &'static str {
    match kind {
        SftpEntryKind::File => "file",
        SftpEntryKind::Dir => "dir",
        SftpEntryKind::Symlink => "symlink",
        SftpEntryKind::Other => "other",
    }
}

/// Connect with the pinned main-port key and password. Returns the connection
/// ID and the canonical home path.
async fn open_session(app: &tauri::App<tauri::test::MockRuntime>, env: &Env) -> (String, String) {
    let step = connect(
        app,
        env,
        env.port_main,
        &env.user,
        PASSWORD_METHOD,
        ConnectOptions {
            password: Some(&env.password),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("password connect succeeds");
    assert_eq!(
        step_kind(&step),
        "connected",
        "connect did not reach connected: {step}"
    );
    let home = step["home_path"].as_str().unwrap_or_default().to_string();
    (connection_id(&step), home)
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_list_and_stat() {
    let test = "list_and_stat";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-list");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && mkdir sub && printf hello > plain.txt && : > empty.txt",
            " && printf x > sub/inner.txt && ln -s plain.txt link-file && ln -s sub link-dir",
            " && ln -s missing-target dangling && printf a > 'with space.txt'",
            " && printf b > 'plus+sign.txt' && printf u > 'ünï 名前.txt'"
        ))
        .expect("create listing fixture");

    let listing = crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.root.clone())
        .await
        .expect("list the fixture folder");
    let by_name: HashMap<&str, &SftpEntry> = listing
        .entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();
    // Name, expected kind, and the size to check when the size is defined.
    let expected: [(&str, &str, Option<u64>); 9] = [
        ("plain.txt", "file", Some(5)),
        ("empty.txt", "file", Some(0)),
        ("sub", "dir", None),
        ("link-file", "symlink", Some(9)),
        ("link-dir", "symlink", None),
        ("dangling", "symlink", None),
        ("with space.txt", "file", Some(1)),
        ("plus+sign.txt", "file", Some(1)),
        ("ünï 名前.txt", "file", Some(1)),
    ];
    let rows_ok = expected.iter().all(|(name, kind, size)| {
        by_name.get(name).is_some_and(|entry| {
            kind_str(&entry.kind) == *kind
                && match size {
                    Some(size) => entry.size == Some(*size),
                    None => true,
                }
                && entry.mtime.is_some()
                && entry.permissions.is_some()
        })
    });
    let no_dots = listing
        .entries
        .iter()
        .all(|entry| entry.name != "." && entry.name != "..");
    let count_ok = listing.entries.len() == expected.len();
    record(
        test,
        CHECK_LIST,
        rows_ok && no_dots && count_ok && !listing.truncated,
        serde_json::to_value(&listing).expect("serialize listing"),
    );

    // The symlink checks: a link keeps its own kind and size, and a link to a
    // folder is refused by list instead of followed.
    let stat_link =
        crate::sftp::sftp_stat(state(&app), id.clone(), fixture.path("link-file")).await;
    let link_ok = by_name
        .get("link-file")
        .is_some_and(|entry| kind_str(&entry.kind) == "symlink" && entry.size == Some(9));
    let dangling_ok = by_name
        .get("dangling")
        .is_some_and(|entry| kind_str(&entry.kind) == "symlink");
    let stat_ok = matches!(&stat_link, Ok(entry) if kind_str(&entry.kind) == "symlink" && entry.size == Some(9));
    record(
        test,
        CHECK_SYMLINK,
        link_ok && dangling_ok && stat_ok && fixture.kind(&fixture.path("link-dir")) == "link",
        json!({
            "listed_link_file": by_name.get("link-file").map(|e| kind_str(&e.kind)),
            "stat_link_file": stat_link.as_ref().ok().map(|e| kind_str(&e.kind)),
            "stat_link_file_size": stat_link.as_ref().ok().and_then(|e| e.size),
            "listed_dangling": by_name.get("dangling").map(|e| kind_str(&e.kind)),
            "server_link_dir": fixture.kind(&fixture.path("link-dir")),
        }),
    );
    let link_dir_list =
        crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.path("link-dir")).await;
    record(
        test,
        CHECK_SYMLINK_LIST,
        matches!(&link_dir_list, Err(message) if message.contains("symbolic link")),
        json!({ "list_link_dir": link_dir_list.as_ref().err() }),
    );

    // Each special name keeps its exact path, and stat returns the same path and name.
    let mut round_trip = Vec::new();
    for name in ["with space.txt", "plus+sign.txt", "ünï 名前.txt"] {
        let path = fixture.path(name);
        let listed_path = by_name.get(name).map(|entry| entry.path.clone());
        let stat = crate::sftp::sftp_stat(state(&app), id.clone(), path.clone()).await;
        let ok = listed_path.as_deref() == Some(path.as_str())
            && matches!(&stat, Ok(entry) if entry.name == name
                && entry.path == path
                && kind_str(&entry.kind) == "file"
                && entry.size == Some(1));
        round_trip.push((name.to_string(), ok, stat.as_ref().err().cloned()));
    }
    record(
        test,
        CHECK_ROUND_TRIP,
        round_trip.iter().all(|(_, ok, _)| *ok),
        json!(round_trip
            .iter()
            .map(|(name, ok, error)| json!({"name": name, "ok": ok, "stat_error": error}))
            .collect::<Vec<_>>()),
    );

    let missing = crate::sftp::sftp_stat(state(&app), id.clone(), fixture.path("missing")).await;
    record(
        test,
        CHECK_STAT_MISSING,
        matches!(&missing, Err(message) if message.contains("not found")),
        json!({ "stat_missing": missing.as_ref().err() }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_path_validation() {
    let test = "path_validation";
    let app = make_app();
    let mut checked = 0usize;
    let mut mismatches = Vec::new();
    for path in BAD_PATHS {
        let expected = normalize_remote_path(path).expect_err("bad path must be refused");
        let outcomes: Vec<(&str, Option<String>)> = vec![
            (
                "list_dir",
                crate::sftp::sftp_list_dir(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                )
                .await
                .err(),
            ),
            (
                "stat",
                crate::sftp::sftp_stat(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                )
                .await
                .err(),
            ),
            (
                "exists",
                crate::sftp::sftp_exists(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                )
                .await
                .err(),
            ),
            (
                "create_dir",
                crate::sftp::sftp_create_dir(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                )
                .await
                .err(),
            ),
            (
                "preview",
                crate::sftp::sftp_preview(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                )
                .await
                .err(),
            ),
            (
                "delete_dir",
                crate::sftp::sftp_delete_dir(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                    None,
                )
                .await
                .err(),
            ),
            (
                "delete",
                crate::sftp::sftp_delete(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    vec![path.to_string()],
                )
                .await
                .err(),
            ),
            (
                "rename_from",
                crate::sftp::sftp_rename(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    path.to_string(),
                    "/ok".to_string(),
                    false,
                )
                .await
                .err(),
            ),
            (
                "rename_to",
                crate::sftp::sftp_rename(
                    state(&app),
                    BOGUS_CONNECTION_ID.to_string(),
                    "/ok".to_string(),
                    path.to_string(),
                    false,
                )
                .await
                .err(),
            ),
        ];
        for (command, error) in outcomes {
            checked += 1;
            if error.as_deref() != Some(expected.as_str()) {
                mismatches.push(json!({
                    "command": command,
                    "path": path,
                    "expected": expected,
                    "observed": error,
                }));
            }
        }
    }
    record(
        test,
        CHECK_PATHS,
        mismatches.is_empty() && checked == BAD_PATHS.len() * 9,
        json!({ "checked": checked, "mismatches": mismatches }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_create_and_exists() {
    let test = "create_and_exists";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-create");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && printf x > file.txt && mkdir locked && : > locked/inner",
            " && chmod 000 locked && ln -s nowhere dangle"
        ))
        .expect("create fixture entries");

    let new = fixture.path("new");
    let created = crate::sftp::sftp_create_dir(state(&app), id.clone(), new.clone()).await;
    let server_kind = fixture.kind(&new);
    let exists = crate::sftp::sftp_exists(state(&app), id.clone(), new.clone()).await;
    let again = crate::sftp::sftp_create_dir(state(&app), id.clone(), new.clone()).await;
    record(
        test,
        CHECK_CREATE,
        created.is_ok()
            && server_kind == "dir"
            && matches!(exists, Ok(true))
            && matches!(&again, Err(message) if message.contains("already exists")),
        json!({
            "create": created.as_ref().err(),
            "server_kind": server_kind,
            "exists": exists.as_ref().ok(),
            "second_create": again.as_ref().err(),
        }),
    );

    let parentless = fixture.path("missing/child");
    let orphan = crate::sftp::sftp_create_dir(state(&app), id.clone(), parentless).await;
    record(
        test,
        CHECK_CREATE_PARENT,
        orphan.is_err() && fixture.kind(&fixture.path("missing")) == "missing",
        json!({
            "create": orphan.as_ref().err(),
            "server_missing_parent": fixture.kind(&fixture.path("missing")),
        }),
    );

    let present = crate::sftp::sftp_exists(state(&app), id.clone(), fixture.path("file.txt")).await;
    let folder = crate::sftp::sftp_exists(state(&app), id.clone(), new.clone()).await;
    let absent = crate::sftp::sftp_exists(state(&app), id.clone(), fixture.path("nope")).await;
    let dangling = crate::sftp::sftp_exists(state(&app), id.clone(), fixture.path("dangle")).await;
    record(
        test,
        CHECK_EXISTS,
        matches!(present, Ok(true))
            && matches!(folder, Ok(true))
            && matches!(absent, Ok(false))
            && matches!(dangling, Ok(true)),
        json!({
            "file": present.as_ref().ok(),
            "folder": folder.as_ref().ok(),
            "missing": absent.as_ref().ok(),
            "dangling_symlink": dangling.as_ref().ok(),
        }),
    );

    // The folder is mode 000, so the lookup inside it is denied. That is not
    // a missing path and must not read as false.
    let locked =
        crate::sftp::sftp_exists(state(&app), id.clone(), fixture.path("locked/inner")).await;
    record(
        test,
        CHECK_EXISTS_ERR,
        locked.is_err(),
        json!({ "exists_under_locked_folder": locked.as_ref().ok(), "error": locked.as_ref().err() }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_rename() {
    let test = "rename";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-rename");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && printf AAA > a.txt && printf BBB > b.txt && mkdir d",
            " && printf CCC > d/c.txt && mkdir dir2 && printf FFF > f.txt"
        ))
        .expect("create rename fixture");

    let refused = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("a.txt"),
        fixture.path("b.txt"),
        false,
    )
    .await;
    record(
        test,
        CHECK_RENAME_NO_OVERWRITE,
        matches!(&refused, Err(message) if message.contains("already exists"))
            && fixture.read(&fixture.path("a.txt")) == "AAA"
            && fixture.read(&fixture.path("b.txt")) == "BBB",
        json!({
            "rename": refused.as_ref().err(),
            "source_after": fixture.read(&fixture.path("a.txt")),
            "target_after": fixture.read(&fixture.path("b.txt")),
        }),
    );

    let replaced = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("a.txt"),
        fixture.path("b.txt"),
        true,
    )
    .await;
    record(
        test,
        CHECK_RENAME_OVERWRITE,
        replaced.is_ok()
            && fixture.read(&fixture.path("b.txt")) == "AAA"
            && fixture.kind(&fixture.path("a.txt")) == "missing",
        json!({
            "rename": replaced.as_ref().err(),
            "target_after": fixture.read(&fixture.path("b.txt")),
            "source_kind_after": fixture.kind(&fixture.path("a.txt")),
        }),
    );

    let same = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("b.txt"),
        fixture.path("b.txt"),
        false,
    )
    .await;
    let descendant = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("d"),
        fixture.path("d/inner"),
        false,
    )
    .await;
    let missing_source = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("nothing.txt"),
        fixture.path("other.txt"),
        false,
    )
    .await;
    record(
        test,
        CHECK_RENAME_REFUSALS,
        matches!(&same, Err(message) if message.contains("same path"))
            && matches!(&descendant, Err(message) if message.contains("itself"))
            && matches!(&missing_source, Err(message) if message.contains("not found"))
            && fixture.kind(&fixture.path("d")) == "dir"
            && fixture.kind(&fixture.path("other.txt")) == "missing",
        json!({
            "same": same.as_ref().err(),
            "descendant": descendant.as_ref().err(),
            "missing_source": missing_source.as_ref().err(),
        }),
    );

    let onto_folder = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("d"),
        fixture.path("dir2"),
        true,
    )
    .await;
    let onto_file = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("d"),
        fixture.path("f.txt"),
        true,
    )
    .await;
    record(
        test,
        CHECK_RENAME_FOLDER_TARGETS,
        matches!(&onto_folder, Err(message) if message.contains("folder"))
            && matches!(&onto_file, Err(message) if message.contains("folder"))
            && fixture.kind(&fixture.path("dir2")) == "dir"
            && fixture.read(&fixture.path("f.txt")) == "FFF"
            && fixture.read(&fixture.path("d/c.txt")) == "CCC",
        json!({
            "onto_folder": onto_folder.as_ref().err(),
            "onto_file": onto_file.as_ref().err(),
            "file_after": fixture.read(&fixture.path("f.txt")),
        }),
    );

    // Success: the new target holds the source, and no backup is left in the folder.
    fixture
        .sh("cd \"$ROOT\" && printf NEW > ok-src.txt && printf OLD > ok-dst.txt")
        .expect("create backup-swap fixture");
    let swapped = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("ok-src.txt"),
        fixture.path("ok-dst.txt"),
        true,
    )
    .await;
    let leftovers = fixture
        .sh("find \"$ROOT\" -maxdepth 1 -name '*.s3sk-bak-*' | wc -l")
        .map(|out| out.trim().to_string());
    record(
        test,
        CHECK_RENAME_BACKUP,
        swapped
            .as_ref()
            .is_ok_and(|outcome| outcome.warning.is_none())
            && fixture.read(&fixture.path("ok-dst.txt")) == "NEW"
            && fixture.kind(&fixture.path("ok-src.txt")) == "missing"
            && leftovers.as_deref() == Ok("0"),
        json!({
            "rename": swapped.as_ref().err(),
            "warning": swapped.as_ref().ok().and_then(|outcome| outcome.warning.clone()),
            "target_after": fixture.read(&fixture.path("ok-dst.txt")),
            "backup_files_left": leftovers.as_ref().ok(),
            "error": leftovers.as_ref().err(),
        }),
    );

    // Failure after the target is moved aside: the source sits in a folder the
    // test user can read but not write (mode 500). Its lstat succeeds, but the
    // server refuses the rename's unlink of the source, so the final step fails
    // after the original target was renamed to its backup. The restore must put
    // the original back, and the source must stay where it was.
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && printf ORIG > keep-target.txt && mkdir locked",
            " && printf NEW2 > locked/src.txt && chmod 500 locked"
        ))
        .expect("create restore fixture");
    let restored = crate::sftp::sftp_rename(
        state(&app),
        id.clone(),
        fixture.path("locked/src.txt"),
        fixture.path("keep-target.txt"),
        true,
    )
    .await;
    let backups_after_restore = fixture
        .sh("find \"$ROOT\" -maxdepth 1 -name '*.s3sk-bak-*' | wc -l")
        .map(|out| out.trim().to_string());
    record(
        test,
        CHECK_RENAME_RESTORE,
        matches!(&restored, Err(message) if message.contains("Permission denied")
            && !message.contains("could not be restored"))
            && fixture.read(&fixture.path("keep-target.txt")) == "ORIG"
            && fixture.read(&fixture.path("locked/src.txt")) == "NEW2"
            && backups_after_restore.as_deref() == Ok("0"),
        json!({
            "rename": restored.as_ref().err(),
            "target_after": fixture.read(&fixture.path("keep-target.txt")),
            "source_after": fixture.read(&fixture.path("locked/src.txt")),
            "backup_files_left": backups_after_restore.as_ref().ok(),
        }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_delete() {
    let test = "delete";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-delete");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && printf one > f1.txt && printf two > f2.txt",
            " && ln -s f2.txt link && mkdir d && printf x > d/x && printf keep > keep.txt"
        ))
        .expect("create delete fixture");

    let removed = crate::sftp::sftp_delete(
        state(&app),
        id.clone(),
        vec![fixture.path("f1.txt"), fixture.path("link")],
    )
    .await;
    let mut deleted = removed
        .as_ref()
        .map(|result| result.deleted.clone())
        .unwrap_or_default();
    deleted.sort();
    let mut expected = vec![fixture.path("f1.txt"), fixture.path("link")];
    expected.sort();
    record(
        test,
        CHECK_DELETE_FILES,
        removed
            .as_ref()
            .is_ok_and(|result| result.failed.is_empty())
            && deleted == expected
            && fixture.kind(&fixture.path("f1.txt")) == "missing"
            && fixture.kind(&fixture.path("link")) == "missing"
            && fixture.read(&fixture.path("f2.txt")) == "two",
        json!({
            "deleted": deleted,
            "failed": removed.as_ref().ok().map(|result| result.failed.len()),
            "error": removed.as_ref().err(),
            "target_after": fixture.read(&fixture.path("f2.txt")),
        }),
    );

    let mixed = crate::sftp::sftp_delete(
        state(&app),
        id.clone(),
        vec![
            fixture.path("d"),
            fixture.path("nothing.txt"),
            fixture.path("keep.txt"),
        ],
    )
    .await;
    let (folder_failure, missing_failure) = match &mixed {
        Ok(result) => (
            result
                .failed
                .iter()
                .find(|failure| failure.path == fixture.path("d"))
                .map(|failure| failure.error.clone()),
            result
                .failed
                .iter()
                .find(|failure| failure.path == fixture.path("nothing.txt"))
                .map(|failure| failure.error.clone()),
        ),
        Err(_) => (None, None),
    };
    record(
        test,
        CHECK_DELETE_PER_PATH,
        matches!(&mixed, Ok(result) if result.deleted == vec![fixture.path("keep.txt")])
            && folder_failure
                .as_deref()
                .is_some_and(|error| error.contains("folder"))
            && missing_failure
                .as_deref()
                .is_some_and(|error| error.contains("not found"))
            && fixture.kind(&fixture.path("d")) == "dir"
            && fixture.kind(&fixture.path("keep.txt")) == "missing",
        json!({
            "folder_failure": folder_failure,
            "missing_failure": missing_failure,
            "error": mixed.as_ref().err(),
        }),
    );

    // The batch is refused as a whole, so the file named in it stays in place.
    let survivor = fixture.path("survivor.txt");
    fixture
        .sh("printf s > \"$ROOT/survivor.txt\"")
        .expect("create survivor");
    let oversized = vec![survivor.clone(); MAX_PREFIX_TRANSACTION_OBJECTS + 1];
    let too_many = crate::sftp::sftp_delete(state(&app), id.clone(), oversized).await;
    let bad_in_batch = crate::sftp::sftp_delete(
        state(&app),
        id.clone(),
        vec![survivor.clone(), "relative".to_string()],
    )
    .await;
    record(
        test,
        CHECK_DELETE_BATCH,
        matches!(&too_many, Err(message) if message.contains("exceeds"))
            && matches!(&bad_in_batch, Err(message) if message.contains("absolute"))
            && fixture.kind(&survivor) == "file",
        json!({
            "over_limit": too_many.as_ref().err(),
            "bad_in_batch": bad_in_batch.as_ref().err(),
            "survivor": fixture.kind(&survivor),
        }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_delete_dir() {
    let test = "delete_dir";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-tree");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && mkdir -p t/a/b/c && printf x > t/a/b/c/leaf.txt",
            " && printf x > t/a/x.txt && printf y > t/y.txt && mkdir t/empty",
            " && mkdir -p ld/inner keep && printf k > keep/keep.txt",
            " && ln -s ../keep ld/link && printf i > ld/inner/i.txt",
            " && printf f > plain.txt && ln -s keep kl"
        ))
        .expect("create tree fixture");

    let tree = fixture.path("t");
    let removed = crate::sftp::sftp_delete_dir(state(&app), id.clone(), tree.clone(), None).await;
    record(
        test,
        CHECK_DELETE_DIR_TREE,
        matches!(&removed, Ok(result) if result.deleted == vec![tree.clone()] && result.failed.is_empty())
            && fixture.kind(&tree) == "missing",
        json!({
            "result": removed.as_ref().ok().map(|r| json!({"deleted": r.deleted, "failed": r.failed.len()})),
            "error": removed.as_ref().err(),
            "server_after": fixture.kind(&tree),
        }),
    );

    let linked = fixture.path("ld");
    let through_link =
        crate::sftp::sftp_delete_dir(state(&app), id.clone(), linked.clone(), None).await;
    record(
        test,
        CHECK_DELETE_DIR_SYMLINK,
        matches!(&through_link, Ok(result) if result.deleted == vec![linked.clone()] && result.failed.is_empty())
            && fixture.kind(&linked) == "missing"
            && fixture.read(&fixture.path("keep/keep.txt")) == "k",
        json!({
            "result": through_link.as_ref().ok().map(|r| json!({"deleted": r.deleted, "failed": r.failed.len()})),
            "error": through_link.as_ref().err(),
            "target_file_after": fixture.read(&fixture.path("keep/keep.txt")),
        }),
    );

    // Protected targets: root, home, the parent of home, a file, and a symlink.
    let parent_of_home = split_parent(&home)
        .map(|(parent, _)| parent)
        .unwrap_or_else(|_| "/".to_string());
    let attempts = [
        ("/".to_string(), "root"),
        (home.clone(), "home"),
        (parent_of_home, "ancestor of home"),
        (fixture.path("plain.txt"), "file"),
        (fixture.path("kl"), "symlink"),
    ];
    let mut refusals = Vec::new();
    for (path, label) in &attempts {
        let outcome =
            crate::sftp::sftp_delete_dir(state(&app), id.clone(), path.clone(), None).await;
        refusals.push((label.to_string(), outcome.is_err(), outcome.err()));
    }
    record(
        test,
        CHECK_DELETE_DIR_PROTECTED,
        refusals.iter().all(|(_, refused, _)| *refused)
            && fixture.kind(&home) == "dir"
            && fixture.kind(&fixture.path("plain.txt")) == "file"
            && fixture.kind(&fixture.path("keep")) == "dir"
            && fixture.kind(&fixture.path("kl")) == "link"
            && fixture.read(&fixture.path("keep/keep.txt")) == "k",
        json!({
            "refusals": refusals
                .iter()
                .map(|(label, refused, error)| json!({"target": label, "refused": refused, "error": error}))
                .collect::<Vec<_>>(),
        }),
    );

    // An over-limit tree is refused before anything is removed.
    let big = fixture.path("big");
    fixture
        .sh("mkdir -- \"$ROOT/big\" && cd \"$ROOT/big\" && seq -f 'f%g' 1 100001 | xargs touch")
        .expect("create 100,001 entries");
    let before = fixture.count(&big);
    let over = crate::sftp::sftp_delete_dir(state(&app), id.clone(), big.clone(), None).await;
    let after = fixture.count(&big);
    record(
        test,
        CHECK_DELETE_DIR_LIMIT,
        matches!(&over, Err(message) if message.contains("more than"))
            && before == 100_002
            && after == before,
        json!({
            "error": over.as_ref().err(),
            "entries_before": before,
            "entries_after": after,
        }),
    );

    cancel_check(&env, &app, &id, &fixture).await;
}

/// Cancel a folder delete once the server shows deletion has begun, so the
/// cancel lands in the deletion phase rather than the walk before it. The call
/// must not report full success, the folder must remain, some entries must be
/// gone, and the remaining count must stop changing once the call returns.
async fn cancel_check(
    env: &Env,
    app: &tauri::App<tauri::test::MockRuntime>,
    id: &str,
    parent: &Fixture,
) {
    let test = "delete_dir";
    let root = parent.path("cancel");
    parent
        .sh(concat!(
            "mkdir -- \"$ROOT/cancel\" && cd \"$ROOT/cancel\"",
            " && for d in $(seq 1 30); do mkdir d$d && seq -f \"d$d/f%g\" 1 1000 | xargs touch; done"
        ))
        .expect("create cancel tree");
    let total = parent.count(&root);
    let done = AtomicBool::new(false);
    let command = async {
        let outcome = crate::sftp::sftp_delete_dir(
            state(app),
            id.to_string(),
            root.clone(),
            Some(TRANSFER_ID),
        )
        .await;
        done.store(true, Ordering::SeqCst);
        outcome
    };
    // The watcher counts the server's entries without blocking the runtime, and
    // cancels on the first entry removed. Only deletion removes entries.
    let watcher = async {
        for _ in 0..1_200 {
            if done.load(Ordering::SeqCst) {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            let (container, user, probe) = (env.container.clone(), env.user.clone(), root.clone());
            let remaining =
                tokio::task::spawn_blocking(move || remote_entry_count(&container, &user, &probe))
                    .await
                    .unwrap_or(usize::MAX);
            if remaining < total {
                cancel_transfer_in_registry(id, TRANSFER_ID);
                return true;
            }
        }
        false
    };
    let (result, cancelled_mid_delete) = tokio::join!(command, watcher);
    let stopped = match &result {
        Err(message) => message == &cancelled_error(),
        Ok(outcome) => {
            outcome.deleted.is_empty()
                && outcome
                    .failed
                    .iter()
                    .any(|failure| failure.path == root && failure.error.contains("cancelled"))
        }
    };
    let folder_kept = parent.kind(&root) == "dir";
    let count_at_return = parent.count(&root);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let count_later = parent.count(&root);
    record(
        test,
        CHECK_DELETE_DIR_CANCEL,
        cancelled_mid_delete
            && stopped
            && folder_kept
            && count_at_return == count_later
            && count_later < total,
        json!({
            "cancelled_during_deletion": cancelled_mid_delete,
            "result": match &result {
                Ok(outcome) => json!({"deleted": outcome.deleted.len(), "failed": outcome.failed.len()}),
                Err(message) => json!({"error": message}),
            },
            "entries_before": total,
            "entries_at_return": count_at_return,
            "entries_one_second_later": count_later,
            "folder_kept": folder_kept,
        }),
    );
}

/// Entries under `path` on the server, counted from inside the container.
/// `usize::MAX` marks a failed count, so it never reads as progress.
fn remote_entry_count(container: &str, user: &str, path: &str) -> usize {
    remote_sh(container, user, &[("P", path)], "find \"$P\" | wc -l")
        .ok()
        .and_then(|out| out.trim().parse().ok())
        .unwrap_or(usize::MAX)
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_list_limits_and_names() {
    let test = "list_limits_and_names";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-names");
    fixture
        .sh(concat!(
            "cd \"$ROOT\" && mkdir many && cd many && seq -f 'f%g' 1 5001 | xargs touch && cd \"$ROOT\"",
            " && printf data > ok.txt && printf data > \"lossy-$(printf '\\377')\"",
            " && mkdir lossydir && printf d > lossydir/ok.txt",
            " && printf d > \"lossydir/lossy-$(printf '\\377')\""
        ))
        .expect("create names fixture");

    let many = crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.path("many")).await;
    let (count, truncated, sorted, unique) = match &many {
        Ok(listing) => {
            let names: Vec<&str> = listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect();
            (
                names.len(),
                listing.truncated,
                names.windows(2).all(|pair| pair[0] < pair[1]),
                names.iter().collect::<HashSet<_>>().len() == names.len(),
            )
        }
        Err(_) => (0, false, false, false),
    };
    record(
        test,
        CHECK_LIST_TRUNCATED,
        count == 5000 && truncated && sorted && unique,
        json!({
            "entries": count,
            "truncated": truncated,
            "sorted": sorted,
            "unique": unique,
            "error": many.as_ref().err(),
        }),
    );

    let root_listing = crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.root.clone())
        .await
        .expect("list the names folder");
    let lossy = root_listing.entries.iter().find(|entry| entry.name_lossy);
    let lossy_name = lossy.map(|entry| entry.name.clone()).unwrap_or_default();
    let lossy_path = lossy.map(|entry| entry.path.clone()).unwrap_or_default();
    let ok_entry = root_listing
        .entries
        .iter()
        .find(|entry| entry.name == "ok.txt");
    let listed = lossy_name.starts_with("lossy-") && lossy_name.contains('\u{FFFD}');
    let ok_not_lossy = ok_entry.is_some_and(|entry| !entry.name_lossy);
    let stat = crate::sftp::sftp_stat(state(&app), id.clone(), lossy_path.clone()).await;
    let deleted = crate::sftp::sftp_delete(state(&app), id.clone(), vec![lossy_path.clone()]).await;
    let root_lossy_files = fixture.sh("find \"$ROOT\" -maxdepth 1 -type f -name 'lossy-*' | wc -l");
    let folder =
        crate::sftp::sftp_delete_dir(state(&app), id.clone(), fixture.path("lossydir"), None).await;
    let folder_files = fixture.file_count(&fixture.path("lossydir"));
    let folder_listing =
        crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.path("lossydir")).await;
    let folder_lists_lossy = folder_listing
        .as_ref()
        .is_ok_and(|listing| listing.entries.iter().any(|entry| entry.name_lossy));
    record(
        test,
        CHECK_LOSSY,
        listed
            && ok_not_lossy
            && matches!(&stat, Err(message) if message.contains("could not be decoded"))
            && matches!(&deleted, Err(message) if message.contains("could not be decoded"))
            && root_lossy_files.as_deref().map(str::trim) == Ok("1")
            && matches!(&folder, Err(message) if message.contains("could not be decoded"))
            && folder_files == 2
            && folder_lists_lossy,
        json!({
            "lossy_name": lossy_name,
            "ok_not_lossy": ok_not_lossy,
            "stat_error": stat.as_ref().err(),
            "delete_error": deleted.as_ref().err(),
            "byte_named_files_left": root_lossy_files.ok(),
            "folder_error": folder.as_ref().err(),
            "folder_files_left": folder_files,
            "folder_lists_lossy": folder_lists_lossy,
        }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_preview() {
    let test = "preview";
    let env = env();
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-preview");
    fixture
        .sh(&format!(
            concat!(
                "cd \"$ROOT\" && head -c 2097152 /dev/zero | tr '\\0' a > big.txt",
                " && printf '%s' '{}' | base64 -d > pixel.png",
                " && head -c 16777217 /dev/zero > huge.png && printf xxxx > data.bin",
                " && mkdir sub && ln -s sub link-dir && mkfifo fifo"
            ),
            PNG_B64
        ))
        .expect("create preview fixture");

    let text = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("big.txt")).await;
    record(
        test,
        CHECK_PREVIEW_TEXT,
        matches!(&text, Ok(preview) if preview.content_type == "text/plain"
            && preview.is_text
            && preview.truncated
            && preview.total_size == 2_097_152
            && preview.data.len() == MIB),
        json!({
            "content_type": text.as_ref().ok().map(|p| p.content_type.clone()),
            "is_text": text.as_ref().ok().map(|p| p.is_text),
            "truncated": text.as_ref().ok().map(|p| p.truncated),
            "total_size": text.as_ref().ok().map(|p| p.total_size),
            "data_bytes": text.as_ref().ok().map(|p| p.data.len()),
            "error": text.as_ref().err(),
        }),
    );

    let png = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("pixel.png")).await;
    let expected_bytes = B64.decode(PNG_B64).expect("PNG constant is base64");
    let png_ok = matches!(&png, Ok(preview) if preview.content_type == "image/png"
        && !preview.is_text
        && !preview.truncated
        && preview.total_size == expected_bytes.len() as i64
        && B64.decode(&preview.data).ok().as_deref() == Some(expected_bytes.as_slice()));
    record(
        test,
        CHECK_PREVIEW_PNG,
        png_ok && expected_bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        json!({
            "content_type": png.as_ref().ok().map(|p| p.content_type.clone()),
            "truncated": png.as_ref().ok().map(|p| p.truncated),
            "total_size": png.as_ref().ok().map(|p| p.total_size),
            "error": png.as_ref().err(),
        }),
    );

    let folder = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("sub")).await;
    let link = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("link-dir")).await;
    // A FIFO must be refused without an open, which would block on the server.
    let fifo = tokio::time::timeout(
        Duration::from_secs(10),
        crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("fifo")),
    )
    .await;
    let fifo_refused = matches!(&fifo, Ok(Err(_)));
    record(
        test,
        CHECK_PREVIEW_REFUSED,
        folder.is_err() && link.is_err() && fifo_refused,
        json!({
            "folder": folder.as_ref().err(),
            "symlink_to_folder": link.as_ref().err(),
            "fifo_refused": fifo_refused,
            "fifo_timed_out": fifo.is_err(),
            "fifo_error": fifo.as_ref().ok().and_then(|result| result.as_ref().err()),
        }),
    );

    let huge = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("huge.png")).await;
    let binary = crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("data.bin")).await;
    record(
        test,
        CHECK_PREVIEW_LARGE,
        matches!(&huge, Ok(preview) if preview.content_type == "image/png"
            && preview.data.is_empty()
            && !preview.is_text
            && !preview.truncated
            && preview.total_size == 16_777_217)
            && matches!(&binary, Ok(preview) if preview.content_type == "application/octet-stream"
                && preview.data.is_empty()
                && !preview.is_text),
        json!({
            "huge_png": huge.as_ref().ok().map(|p| json!({"data_bytes": p.data.len(), "total_size": p.total_size})),
            "huge_png_error": huge.as_ref().err(),
            "binary": binary.as_ref().ok().map(|p| json!({"data_bytes": p.data.len(), "content_type": p.content_type})),
            "binary_error": binary.as_ref().err(),
        }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_session_guards() {
    let test = "session_guards";
    let env = env();

    // A stale connection ID: the second connect replaces the first session.
    let app = make_app();
    let (stale_id, home) = open_session(&app, &env).await;
    let (current_id, _) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-guard");
    fixture
        .sh("cd \"$ROOT\" && printf K > keep.txt && printf s > src.txt && mkdir victim && printf v > victim/v.txt")
        .expect("create guard fixture");
    let stale_create = fixture.path("stale-new");
    let stale_results = [
        (
            "list_dir",
            crate::sftp::sftp_list_dir(state(&app), stale_id.clone(), fixture.root.clone())
                .await
                .err(),
        ),
        (
            "stat",
            crate::sftp::sftp_stat(state(&app), stale_id.clone(), fixture.path("keep.txt"))
                .await
                .err(),
        ),
        (
            "exists",
            crate::sftp::sftp_exists(state(&app), stale_id.clone(), fixture.path("keep.txt"))
                .await
                .err(),
        ),
        (
            "create_dir",
            crate::sftp::sftp_create_dir(state(&app), stale_id.clone(), stale_create.clone())
                .await
                .err(),
        ),
        (
            "rename",
            crate::sftp::sftp_rename(
                state(&app),
                stale_id.clone(),
                fixture.path("src.txt"),
                fixture.path("renamed.txt"),
                false,
            )
            .await
            .err(),
        ),
        (
            "delete",
            crate::sftp::sftp_delete(
                state(&app),
                stale_id.clone(),
                vec![fixture.path("keep.txt")],
            )
            .await
            .err(),
        ),
        (
            "delete_dir",
            crate::sftp::sftp_delete_dir(
                state(&app),
                stale_id.clone(),
                fixture.path("victim"),
                None,
            )
            .await
            .err(),
        ),
        (
            "preview",
            crate::sftp::sftp_preview(state(&app), stale_id.clone(), fixture.path("keep.txt"))
                .await
                .err(),
        ),
    ];
    let all_refused = stale_results.iter().all(|(_, error)| error.is_some());
    let unchanged = fixture.kind(&stale_create) == "missing"
        && fixture.kind(&fixture.path("src.txt")) == "file"
        && fixture.kind(&fixture.path("renamed.txt")) == "missing"
        && fixture.read(&fixture.path("keep.txt")) == "K"
        && fixture.kind(&fixture.path("victim")) == "dir";
    record(
        test,
        CHECK_STALE,
        all_refused && unchanged && stale_id != current_id,
        json!({
            "refusals": stale_results
                .iter()
                .map(|(command, error)| json!({"command": command, "error": error}))
                .collect::<Vec<_>>(),
            "server_unchanged": unchanged,
        }),
    );
    drop(app);

    // A server-side drop: every command must report the lost connection.
    let app = make_app();
    let (id, home) = open_session(&app, &env).await;
    let fixture = Fixture::new(&env, &home, "fs-lost");
    fixture
        .sh("cd \"$ROOT\" && printf K > keep.txt && mkdir victim && printf v > victim/v.txt && printf p > p.png")
        .expect("create lost-connection fixture");
    let registered = require_session(&state(&app), &id, None).expect("live session");
    let killed = kill_server_sessions(&env.container, &env.user).unwrap_or(0);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut closed = false;
    while std::time::Instant::now() < deadline {
        if registered.handle.ssh.is_closed() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(registered);

    let lost_results = [
        (
            "list_dir",
            crate::sftp::sftp_list_dir(state(&app), id.clone(), fixture.root.clone())
                .await
                .err(),
        ),
        (
            "stat",
            crate::sftp::sftp_stat(state(&app), id.clone(), fixture.path("keep.txt"))
                .await
                .err(),
        ),
        (
            "exists",
            crate::sftp::sftp_exists(state(&app), id.clone(), fixture.path("keep.txt"))
                .await
                .err(),
        ),
        (
            "create_dir",
            crate::sftp::sftp_create_dir(state(&app), id.clone(), fixture.path("after-drop"))
                .await
                .err(),
        ),
        (
            "rename",
            crate::sftp::sftp_rename(
                state(&app),
                id.clone(),
                fixture.path("keep.txt"),
                fixture.path("moved.txt"),
                false,
            )
            .await
            .err(),
        ),
        (
            "delete",
            crate::sftp::sftp_delete(state(&app), id.clone(), vec![fixture.path("keep.txt")])
                .await
                .err(),
        ),
        (
            "delete_dir",
            crate::sftp::sftp_delete_dir(state(&app), id.clone(), fixture.path("victim"), None)
                .await
                .err(),
        ),
        (
            "preview",
            crate::sftp::sftp_preview(state(&app), id.clone(), fixture.path("p.png"))
                .await
                .err(),
        ),
    ];
    let all_lost = lost_results.iter().all(|(_, error)| {
        error
            .as_deref()
            .is_some_and(|message| message.starts_with(SFTP_CONNECTION_LOST))
    });
    record(
        test,
        CHECK_LOST,
        killed > 0 && closed && all_lost && fixture.kind(&fixture.path("after-drop")) == "missing",
        json!({
            "killed_server_sessions": killed,
            "handle_closed": closed,
            "results": lost_results
                .iter()
                .map(|(command, error)| json!({"command": command, "error": error}))
                .collect::<Vec<_>>(),
        }),
    );
}
