use crate::{detect_case_fold_collision, path_authority, strip_extended_windows_prefix};
use std::collections::HashMap;

const MAX_LOCAL_SCAN_FILES: usize = 20_000;
const MAX_LOCAL_SCAN_DEPTH: usize = 64;
const MAX_LOCAL_SCAN_ENTRIES: usize = 100_000;
const MAX_LOCAL_SCAN_WARNING_SAMPLES: usize = 50;

#[derive(Default)]
struct ScanWarnings {
    total: usize,
    samples: Vec<String>,
}

impl ScanWarnings {
    fn push(&mut self, warning: String) {
        self.total = self.total.saturating_add(1);
        if self.samples.len() < MAX_LOCAL_SCAN_WARNING_SAMPLES {
            self.samples.push(warning);
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct LocalFileEntry {
    pub file_path: String,
    pub relative_path: String,
    pub size: u64,
    /// Backend-issued `upload-file` grant for this exact file. The webview
    /// never names an upload source path again.
    pub file_token: String,
}

/// Result of a folder scan. Warnings cover paths the scan had to skip, so the
/// webview can tell the user a folder upload is partial instead of silently
/// treating the partial list as complete.
#[derive(Debug, serde::Serialize)]
pub(crate) struct LocalFolderScanResult {
    pub entries: Vec<LocalFileEntry>,
    pub warnings: Vec<String>,
    pub warning_count: usize,
}

pub(crate) fn normalize_slashes(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    // Backslashes are separators only on Windows. On Unix a backslash is a
    // legal filename character and must survive into the object key.
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// Unicode NFC normalization for upload keys.
///
/// APFS treats NFC and NFD spellings as one file. Normalizing before deriving
/// an object key keeps the S3 name stable across volumes, and lets the
/// collision check reject two names that differ only by normalization.
/// `unicode-normalization` 0.1.25 implements Unicode 17.0; it replaced embedded
/// tables after an exhaustive equivalence run
/// (`test-results/nfc-equivalence/report.json`).
pub(crate) fn normalize_nfc(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    value.nfc().collect()
}

fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Identity of a directory the scan has found but not yet opened.
///
/// Captured when the parent enumerates the child and re-verified with a
/// no-follow open when the child is popped from the stack, closing the
/// window where a subdirectory can be swapped for a symlink or a different
/// real directory after the parent rejected it as a link. The canonical path
/// catches the symlink swap; the device/inode pair catches a different real
/// directory mounted at the same path on Unix. Windows stable directory ids
/// need a separate handle query and remain the documented residual.
#[derive(Clone, Debug)]
struct ScannedDirIdentity {
    canonical: std::path::PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn scanned_dir_identity(path: &std::path::Path) -> Result<ScannedDirIdentity, String> {
    let canonical = std::fs::canonicalize(path).map_err(|err| {
        format!(
            "Failed to resolve scanned directory '{}': {}",
            path.display(),
            err
        )
    })?;
    let metadata = std::fs::metadata(&canonical).map_err(|err| {
        format!(
            "Failed to inspect scanned directory '{}': {}",
            canonical.display(),
            err
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Scanned path is not a directory: {}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(ScannedDirIdentity {
            canonical,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(ScannedDirIdentity { canonical })
    }
}

/// Open a directory without following a final-component symlink, then confirm
/// it is still the directory the parent enumerated.
#[cfg(unix)]
fn open_scanned_dir(
    path: &std::path::Path,
    expected: &ScannedDirIdentity,
) -> Result<std::fs::File, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NOFOLLOW: i32 = 0o400000;
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x0100;
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    const O_NOFOLLOW: i32 = 0;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
        .map_err(|err| {
            format!(
                "Failed to open scanned directory '{}' without following links: {}",
                path.display(),
                err
            )
        })?;
    let handle = file.metadata().map_err(|err| {
        format!(
            "Failed to inspect opened scanned directory '{}': {}",
            path.display(),
            err
        )
    })?;
    if !handle.is_dir() {
        return Err(format!(
            "Scanned path is not a directory: {}",
            path.display()
        ));
    }
    if handle.dev() != expected.device
        || handle.ino() != expected.inode
        || std::fs::canonicalize(path).map_err(|err| err.to_string())? != expected.canonical
    {
        return Err(format!(
            "Scanned directory changed while the folder scan was running; skipping it: {}",
            path.display()
        ));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_scanned_dir(path: &std::path::Path, expected: &ScannedDirIdentity) -> Result<(), String> {
    // No O_NOFOLLOW on this platform; the symlink check plus canonical
    // identity match below is the available fence. Windows directory file-id
    // verification remains the documented residual.
    let meta = std::fs::symlink_metadata(path).map_err(|err| {
        format!(
            "Failed to inspect scanned directory '{}': {}",
            path.display(),
            err
        )
    })?;
    if metadata_is_link_or_reparse(&meta) {
        return Err(format!(
            "Scanned directory is a symbolic link or reparse point: {}",
            path.display()
        ));
    }
    if std::fs::canonicalize(path).map_err(|err| err.to_string())? != expected.canonical {
        return Err(format!(
            "Scanned directory changed while the folder scan was running; skipping it: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn absolute_path_string(path: &std::path::Path) -> String {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return strip_extended_windows_prefix(&canonical.to_string_lossy());
    }
    if path.is_absolute() {
        return strip_extended_windows_prefix(&path.to_string_lossy());
    }
    match std::env::current_dir() {
        Ok(cwd) => strip_extended_windows_prefix(&cwd.join(path).to_string_lossy()),
        Err(_) => strip_extended_windows_prefix(&path.to_string_lossy()),
    }
}

/// Absolute display path that never resolves a symbolic link.
///
/// `absolute_path_string` canonicalizes, which is right for labels but wrong
/// for grants: canonicalizing a selected link would silently grant its target
/// instead of the link the user picked.
pub(crate) fn absolute_path_string_no_follow(path: &std::path::Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    strip_extended_windows_prefix(&absolute.to_string_lossy())
}

pub(crate) fn root_label(root: &std::path::Path) -> String {
    if let Some(name) = root.file_name().and_then(|n| n.to_str()) {
        if !name.is_empty() {
            return name.to_string();
        }
    }

    let normalized = normalize_slashes(root);
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("root")
        .to_string()
}

fn collect_local_files_from_root(
    root: &std::path::Path,
    label: &str,
    entries: &mut Vec<LocalFileEntry>,
    warnings: &mut ScanWarnings,
    visited_entries: &mut usize,
) {
    let root_meta = match std::fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(err) => {
            warnings.push(format!(
                "Cannot access selected path '{}': {}",
                root.to_string_lossy(),
                err
            ));
            return;
        }
    };
    if metadata_is_link_or_reparse(&root_meta) {
        warnings.push(format!(
            "Skipping selected root '{}' because it is a symbolic link or reparse point.",
            root.to_string_lossy()
        ));
        return;
    }

    if root_meta.is_file() {
        if entries.len() >= MAX_LOCAL_SCAN_FILES {
            warnings.push(format!(
                "Stopped scanning after reaching file limit ({}).",
                MAX_LOCAL_SCAN_FILES
            ));
            return;
        }
        entries.push(LocalFileEntry {
            file_path: absolute_path_string(root),
            relative_path: normalize_nfc(&normalize_slashes(std::path::Path::new(label))),
            size: root_meta.len(),
            file_token: String::new(),
        });
        return;
    }
    if !root_meta.is_dir() {
        return;
    }

    let mut stack = Vec::new();
    match scanned_dir_identity(root) {
        Ok(identity) => stack.push((root.to_path_buf(), 0usize, identity)),
        Err(err) => {
            warnings.push(err);
            return;
        }
    }
    while let Some((dir, depth, identity)) = stack.pop() {
        // Re-verify the directory identity at use time, not only at enqueue
        // time: anything swapped between the parent `read_dir` and this read
        // must be skipped, never enumerated.
        if let Err(err) = open_scanned_dir(&dir, &identity) {
            warnings.push(err);
            continue;
        }
        let iter = match std::fs::read_dir(&dir) {
            Ok(iter) => iter,
            Err(err) => {
                warnings.push(format!(
                    "Cannot read directory '{}': {}",
                    dir.to_string_lossy(),
                    err
                ));
                continue;
            }
        };

        for entry_result in iter {
            if *visited_entries >= MAX_LOCAL_SCAN_ENTRIES {
                warnings.push(format!(
                    "Stopped scanning after visiting {} directory entries.",
                    MAX_LOCAL_SCAN_ENTRIES
                ));
                return;
            }
            *visited_entries += 1;

            let entry = match entry_result {
                Ok(entry) => entry,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot read directory entry in '{}': {}",
                        dir.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };
            let path = entry.path();
            // `DirEntry::metadata` does not traverse symlinks. Use it for the
            // type check as well so a Windows reparse point cannot masquerade
            // as a directory or file we are willing to read.
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot read metadata for '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };
            if metadata_is_link_or_reparse(&meta) {
                warnings.push(format!(
                    "Skipping '{}' because it is a symbolic link or reparse point.",
                    path.to_string_lossy()
                ));
                continue;
            }
            let file_type = meta.file_type();

            if file_type.is_dir() {
                if depth >= MAX_LOCAL_SCAN_DEPTH {
                    warnings.push(format!(
                        "Skipping directory '{}' because maximum recursion depth ({}) was reached.",
                        path.to_string_lossy(),
                        MAX_LOCAL_SCAN_DEPTH
                    ));
                    continue;
                }
                match scanned_dir_identity(&path) {
                    Ok(child_identity) => stack.push((path, depth + 1, child_identity)),
                    Err(err) => warnings.push(err),
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let rel_under_root = match path.strip_prefix(root) {
                Ok(rel) => rel,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot build relative path for '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };
            let rel_with_root = std::path::Path::new(label).join(rel_under_root);

            // Rust paths are byte strings; every S3 key is UTF-8. Carrying a
            // lossy U+FFFD name to the frontend would mint the wrong key and
            // can collapse distinct files, so skip and say so instead.
            if path.to_str().is_none() || rel_with_root.to_str().is_none() {
                warnings.push(format!(
                    "Skipping '{}' because its name is not valid UTF-8.",
                    path.to_string_lossy()
                ));
                continue;
            }

            if entries.len() >= MAX_LOCAL_SCAN_FILES {
                warnings.push(format!(
                    "Stopped scanning after reaching file limit ({}).",
                    MAX_LOCAL_SCAN_FILES
                ));
                return;
            }
            entries.push(LocalFileEntry {
                file_path: absolute_path_string(&path),
                relative_path: normalize_nfc(&normalize_slashes(&rel_with_root)),
                size: meta.len(),
                file_token: String::new(),
            });
        }
    }
}

fn list_local_files_recursive_inner(
    roots: Vec<path_authority::GrantedPath>,
) -> Result<LocalFolderScanResult, String> {
    let mut normalized_roots = Vec::new();
    for root in roots {
        if !root.path.is_absolute() {
            return Err(format!(
                "Selected root must be absolute: {}",
                root.path.display()
            ));
        }
        // Re-verify after crossing into the blocking task: the picker's grant
        // identity is only useful if it is checked at the point of use.
        root.reject_symlink()?;
        root.verify_identity()?;
        if !root.path.exists() {
            return Err(format!(
                "Selected root does not exist: {}",
                root.path.display()
            ));
        }
        normalized_roots.push(root);
    }

    if normalized_roots.is_empty() {
        return Ok(LocalFolderScanResult {
            entries: Vec::new(),
            warnings: Vec::new(),
            warning_count: 0,
        });
    }

    let mut base_counts: HashMap<String, usize> = HashMap::new();
    for root in &normalized_roots {
        let base = normalize_nfc(&root_label(&root.path));
        *base_counts.entry(base).or_insert(0) += 1;
    }

    let mut duplicate_positions: HashMap<String, usize> = HashMap::new();
    let mut entries = Vec::new();
    let mut warnings = ScanWarnings::default();
    let mut visited_entries = 0usize;

    for root in &normalized_roots {
        if visited_entries >= MAX_LOCAL_SCAN_ENTRIES {
            break;
        }
        let base = normalize_nfc(&root_label(&root.path));
        let total = *base_counts.get(&base).unwrap_or(&1);
        let label = if total > 1 {
            let next = duplicate_positions.entry(base.clone()).or_insert(0);
            *next += 1;
            format!("{} ({})", base, next)
        } else {
            base
        };
        collect_local_files_from_root(
            &root.path,
            &label,
            &mut entries,
            &mut warnings,
            &mut visited_entries,
        );
        // A root swapped while its tree was being read must not yield a
        // partial upload from outside the directory the user picked.
        root.verify_identity()?;
    }

    entries.sort_by(|a, b| {
        a.relative_path
            .cmp(&b.relative_path)
            .then(a.file_path.cmp(&b.file_path))
    });

    // Distinct local files differing only by case or Unicode normalization
    // would upload as distinct S3 keys but collide on APFS/NTFS download
    // volumes. Fail closed.
    detect_case_fold_collision(
        entries
            .iter()
            .map(|entry| (entry.relative_path.clone(), entry.file_path.clone())),
        "upload paths",
    )?;

    // Bind every enumerated file to its own upload grant. The webview can
    // only upload files this scan found under the user-selected roots.
    for entry in &mut entries {
        entry.file_token = path_authority::mint(
            path_authority::GrantPurpose::UploadFile,
            std::path::Path::new(&entry.file_path),
            false,
            Some(entry.size),
        );
    }

    if entries.is_empty() && warnings.total > 0 {
        return Err(format!(
            "No readable files were found. {} additional path error(s) occurred.",
            warnings.total
        ));
    }

    Ok(LocalFolderScanResult {
        entries,
        warnings: warnings.samples,
        warning_count: warnings.total,
    })
}

/// Enumerate every file under the granted upload roots.
///
/// Each root must be spent from an `upload-root` grant minted by the native
/// folder picker or a native drop. The renderer cannot widen the scan past the
/// roots the user chose.
#[tauri::command]
pub(crate) async fn list_local_files_recursive(
    root_tokens: Vec<String>,
) -> Result<LocalFolderScanResult, String> {
    let mut roots = Vec::new();
    for token in root_tokens {
        let granted = path_authority::authorize(&token, path_authority::GrantUse::ScanUploadRoot)?;
        if !granted.is_dir {
            return Err(format!(
                "Selected root must be a folder: {}",
                granted.path.display()
            ));
        }
        granted.reject_symlink()?;
        roots.push(granted);
    }
    tokio::task::spawn_blocking(move || list_local_files_recursive_inner(roots))
        .await
        .map_err(|err| format!("Local file scan task failed: {}", err))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn normalize_slashes_converts_backslashes_only_on_windows() {
        let path = Path::new("foo\\bar\\baz.txt");
        let normalized = normalize_slashes(path);
        if cfg!(windows) {
            assert_eq!(normalized, "foo/bar/baz.txt");
        } else {
            // On Unix a backslash is a legal filename character and must stay
            // part of the object key.
            assert_eq!(normalized, "foo\\bar\\baz.txt");
        }
    }

    #[test]
    fn normalize_slashes_preserves_forward_slashes() {
        let path = Path::new("foo/bar/baz.txt");
        assert_eq!(normalize_slashes(path), "foo/bar/baz.txt");
    }

    #[test]
    fn root_label_uses_file_name() {
        let path = Path::new("/home/user/Documents");
        assert_eq!(root_label(path), "Documents");
    }

    #[test]
    fn root_label_handles_trailing_slash() {
        let path = Path::new("/home/user/Documents/");
        let label = root_label(path);
        assert_eq!(label, "Documents");
    }

    #[test]
    fn root_label_returns_root_for_bare_slash() {
        let path = Path::new("/");
        let label = root_label(path);
        assert!(!label.is_empty());
    }

    fn scan_scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "s3-sidekick-scan-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn scan_rejects_a_raw_path_without_a_grant() {
        let err = list_local_files_recursive(vec!["/tmp".to_string()])
            .await
            .expect_err("a raw root path must not authorize a scan");
        assert!(err.contains("grant"), "unexpected error: {}", err);
    }

    #[tokio::test]
    async fn scan_rejects_a_file_grant() {
        let dir = scan_scratch("file-grant");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        let token = path_authority::mint(
            path_authority::GrantPurpose::UploadFile,
            &file,
            false,
            Some(1),
        );
        let err = list_local_files_recursive(vec![token])
            .await
            .expect_err("an upload-file grant must not widen into a folder scan");
        assert!(err.contains("cannot be used"), "unexpected error: {}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn scan_mints_upload_file_tokens_under_the_granted_root() {
        let dir = scan_scratch("root-grant");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let root = path_authority::mint(path_authority::GrantPurpose::UploadRoot, &dir, true, None);
        let scan = list_local_files_recursive(vec![root]).await.unwrap();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.warning_count, 0);
        assert!(scan.warnings.is_empty());
        assert_eq!(scan.entries[0].size, 5);
        let granted = path_authority::authorize(
            &scan.entries[0].file_token,
            path_authority::GrantUse::ReadUploadFile,
        )
        .expect("the scan must mint a file grant");
        assert_eq!(granted.path, Path::new(&scan.entries[0].file_path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_nfc_folds_precomposed_and_decomposed_names() {
        assert_eq!(normalize_nfc("cafe\u{301}.txt"), "caf\u{e9}.txt");
        assert_eq!(normalize_nfc("\u{1100}\u{1161}\u{11A8}"), "\u{AC01}");
        assert_eq!(normalize_nfc("plain.txt"), "plain.txt");
    }

    /// Cases where a hand-written or outdated NFC goes wrong: composition
    /// exclusions, singletons, blocked marks, canonical reordering, and a
    /// Unicode 17.0 combining mark (U+1ACF, class 230).
    #[test]
    fn normalize_nfc_handles_exclusions_reordering_and_unicode_17_marks() {
        // Composition exclusion: U+0958 decomposes and never recomposes.
        assert_eq!(normalize_nfc("\u{958}"), "\u{915}\u{93C}");
        // Singleton: the Angstrom sign becomes A with ring, never back.
        assert_eq!(normalize_nfc("\u{212B}"), "\u{C5}");
        // Marks are reordered by combining class, then composed: no
        // a-with-cedilla exists, and the cedilla (class 202) does not block
        // the acute (230), so the acute composes past it.
        assert_eq!(normalize_nfc("a\u{301}\u{327}"), "\u{E1}\u{327}");
        assert_eq!(normalize_nfc("c\u{301}\u{327}"), "\u{1E09}");
        // A blocked mark (same class after another) does not compose.
        assert_eq!(normalize_nfc("a\u{301}\u{301}"), "\u{E1}\u{301}");
        // LV syllable plus trailing jamo composes to LVT.
        assert_eq!(normalize_nfc("\u{AC00}\u{11A8}"), "\u{AC01}");
        // Unicode 17.0 mark (class 230) sorts after U+0327 (class 202).
        assert_eq!(normalize_nfc("a\u{1ACF}\u{327}"), "a\u{327}\u{1ACF}");
    }

    #[tokio::test]
    async fn scan_emits_nfc_relative_paths() {
        let dir = scan_scratch("nfc");
        let file = dir.join("cafe\u{301}.txt");
        std::fs::write(&file, b"x").unwrap();
        let root = path_authority::mint(path_authority::GrantPurpose::UploadRoot, &dir, true, None);
        let scan = list_local_files_recursive(vec![root]).await.unwrap();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(
            scan.entries[0].relative_path,
            format!("{}/caf\u{e9}.txt", root_label(&dir))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn scanned_dir_identity_refuses_a_swapped_subdirectory() {
        let dir = scan_scratch("identity-swap");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let expected = scanned_dir_identity(&sub).unwrap();
        open_scanned_dir(&sub, &expected).expect("unchanged directory must verify");

        // Swap the subdirectory for a symlink to a different directory.
        let other = scan_scratch("identity-swap-target");
        std::fs::remove_dir_all(&sub).unwrap();
        std::os::unix::fs::symlink(&other, &sub).unwrap();
        let err = open_scanned_dir(&sub, &expected).expect_err("a symlink swap must be refused");
        assert!(
            err.contains("without following links") || err.contains("changed"),
            "{err}"
        );

        // A different real directory at the same path is also refused. The
        // replacement is created (and its inode allocated) while the original
        // still exists, so a Linux filesystem cannot hand the freed inode back.
        let replacement = scan_scratch("identity-swap-replacement");
        let _ = std::fs::remove_file(&sub);
        std::fs::rename(&replacement, &sub).unwrap();
        let err = open_scanned_dir(&sub, &expected)
            .expect_err("a replaced real directory must be refused");
        assert!(err.contains("changed"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scan_rejects_a_root_whose_parent_was_swapped_for_a_symlink() {
        let base = scan_scratch("swapped-root");
        let root = base.join("picked");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("inside.txt"), b"inside").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let token =
            path_authority::mint(path_authority::GrantPurpose::UploadRoot, &root, true, None);

        std::fs::rename(&root, base.join("picked-old")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();

        let err = list_local_files_recursive(vec![token])
            .await
            .expect_err("a swapped parent must invalidate the root grant");
        assert!(
            err.contains("resolves elsewhere") || err.contains("symbolic link"),
            "unexpected error: {}",
            err
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
