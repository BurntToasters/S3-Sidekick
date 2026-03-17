use std::collections::HashMap;
use crate::validate_existing_path;

const MAX_LOCAL_SCAN_FILES: usize = 20_000;
const MAX_LOCAL_SCAN_DEPTH: usize = 64;

#[derive(serde::Serialize)]
pub(crate) struct LocalFileEntry {
    pub file_path: String,
    pub relative_path: String,
    pub size: u64,
}

pub(crate) fn normalize_slashes(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn absolute_path_string(path: &std::path::Path) -> String {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical.to_string_lossy().to_string();
    }
    if path.is_absolute() {
        return path.to_string_lossy().to_string();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path).to_string_lossy().to_string(),
        Err(_) => path.to_string_lossy().to_string(),
    }
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
    warnings: &mut Vec<String>,
) {
    let root_meta = match std::fs::metadata(root) {
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
            relative_path: normalize_slashes(std::path::Path::new(label)),
            size: root_meta.len(),
        });
        return;
    }
    if !root_meta.is_dir() {
        return;
    }

    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
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
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(err) => {
                    warnings.push(format!(
                        "Cannot inspect '{}': {}",
                        path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };

            if file_type.is_dir() {
                if depth >= MAX_LOCAL_SCAN_DEPTH {
                    warnings.push(format!(
                        "Skipping directory '{}' because maximum recursion depth ({}) was reached.",
                        path.to_string_lossy(),
                        MAX_LOCAL_SCAN_DEPTH
                    ));
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

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

            if entries.len() >= MAX_LOCAL_SCAN_FILES {
                warnings.push(format!(
                    "Stopped scanning after reaching file limit ({}).",
                    MAX_LOCAL_SCAN_FILES
                ));
                return;
            }
            entries.push(LocalFileEntry {
                file_path: absolute_path_string(&path),
                relative_path: normalize_slashes(&rel_with_root),
                size: meta.len(),
            });
        }
    }
}

#[tauri::command]
pub(crate) fn list_local_files_recursive(roots: Vec<String>) -> Result<Vec<LocalFileEntry>, String> {
    let mut normalized_roots = Vec::new();
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            continue;
        }
        normalized_roots.push(validate_existing_path(trimmed, "Selected root")?);
    }

    if normalized_roots.is_empty() {
        return Ok(Vec::new());
    }

    let mut base_counts: HashMap<String, usize> = HashMap::new();
    for root in &normalized_roots {
        let base = root_label(root);
        *base_counts.entry(base).or_insert(0) += 1;
    }

    let mut duplicate_positions: HashMap<String, usize> = HashMap::new();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for root in &normalized_roots {
        let base = root_label(root);
        let total = *base_counts.get(&base).unwrap_or(&1);
        let label = if total > 1 {
            let next = duplicate_positions.entry(base.clone()).or_insert(0);
            *next += 1;
            format!("{} ({})", base, next)
        } else {
            base
        };
        collect_local_files_from_root(root, &label, &mut entries, &mut warnings);
    }

    entries.sort_by(|a, b| {
        a.relative_path
            .cmp(&b.relative_path)
            .then(a.file_path.cmp(&b.file_path))
    });

    if !warnings.is_empty() {
        let sample = warnings.iter().take(3).cloned().collect::<Vec<_>>().join(" | ");
        eprintln!(
            "list_local_files_recursive skipped {} path(s). Sample: {}",
            warnings.len(),
            sample
        );
    }

    if entries.is_empty() && !warnings.is_empty() {
        return Err(format!(
            "No readable files were found. {} additional path error(s) occurred.",
            warnings.len()
        ));
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn normalize_slashes_converts_backslashes() {
        let path = Path::new("foo\\bar\\baz.txt");
        assert_eq!(normalize_slashes(path), "foo/bar/baz.txt");
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
}
