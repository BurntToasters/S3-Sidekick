use std::path::PathBuf;
use std::process::Command;

#[derive(serde::Serialize)]
pub(crate) struct UpdaterSupportInfo {
    mode: String,
    release_url: String,
}

#[tauri::command]
pub(crate) fn get_platform_info() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    }
}

#[tauri::command]
pub(crate) fn updater_supported() -> bool {
    let mode = detect_update_mode();
    mode == "native"
}

pub(crate) fn detect_update_mode() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists() {
            "flatpak"
        } else if linux_native_updater_supported() {
            "native"
        } else {
            "manual"
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        "native"
    }
}

#[cfg(target_os = "linux")]
fn linux_native_updater_supported() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

#[tauri::command]
pub(crate) fn updater_support_info() -> UpdaterSupportInfo {
    UpdaterSupportInfo {
        mode: detect_update_mode().to_string(),
        release_url: "https://github.com/BurntToasters/S3-Sidekick/releases/latest".to_string(),
    }
}

#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https:// URLs are allowed".to_string());
    }
    // Reject anything a shell handler could interpret as more than one argument
    // or as an embedded newline. The scheme check alone does not cover these.
    if url.len() > 2048 {
        return Err("URL is too long".to_string());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("URL must not contain whitespace or control characters".to_string());
    }

    let status = if cfg!(target_os = "windows") {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .status()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).status()
    } else {
        Command::new("xdg-open").arg(&url).status()
    }
    .map_err(|e| format!("Failed to launch external URL: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "External URL launcher exited with status {}",
            status
        ))
    }
}

/// Reveal a folder in the system file manager.
///
/// Restricted to directories on purpose. Handing an arbitrary existing file to
/// `explorer` / `open` / `xdg-open` means the shell's default handler runs it,
/// which turned this command into a local code-execution primitive reachable
/// from the webview. The only caller ever needed to open a folder.
#[tauri::command]
pub(crate) fn open_local_path(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }
    let parsed = PathBuf::from(trimmed);
    if !parsed.is_absolute() {
        return Err(format!("Path must be absolute: {}", trimmed));
    }
    if !parsed.exists() {
        return Err(format!("Path does not exist: {}", parsed.display()));
    }
    if !parsed.is_dir() {
        return Err(format!(
            "Only folders can be opened, not individual files: {}",
            parsed.display()
        ));
    }
    if parsed
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Refusing to open a symbolic link: {}",
            parsed.display()
        ));
    }

    if cfg!(target_os = "windows") {
        // `explorer.exe` is widely observed to return a non-zero exit code even
        // when it opened the window successfully, so its status is not a usable
        // signal. Only a spawn failure is treated as an error here.
        Command::new("explorer")
            .arg(&parsed)
            .status()
            .map_err(|e| format!("Failed to open local path: {}", e))?;
        return Ok(());
    }

    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(&parsed).status()
    } else {
        Command::new("xdg-open").arg(&parsed).status()
    }
    .map_err(|e| format!("Failed to open local path: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Local path launcher exited with status {}", status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_info_is_known_value() {
        let info = get_platform_info();
        assert!(
            info == "windows" || info == "macos" || info == "linux",
            "unexpected platform: {}",
            info
        );
    }

    #[test]
    fn detect_update_mode_returns_valid_mode() {
        let mode = detect_update_mode();
        assert!(
            mode == "native" || mode == "flatpak" || mode == "manual",
            "unexpected update mode: {}",
            mode
        );
    }

    #[test]
    fn open_external_url_rejects_non_https() {
        let result = open_external_url("http://example.com".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("https://"));
    }

    #[test]
    fn open_local_path_rejects_relative() {
        let result = open_local_path("relative/path".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn open_external_url_rejects_whitespace_and_control_chars() {
        for candidate in [
            "https://example.com/a b",
            "https://example.com/\nrundll32",
            "https://example.com/\ttab",
        ] {
            let result = open_external_url(candidate.to_string());
            assert!(result.is_err(), "should reject {:?}", candidate);
        }
    }

    #[test]
    fn open_local_path_rejects_files() {
        // Only folders may be revealed; handing a file to the OS handler would
        // execute it.
        let mut file = std::env::temp_dir();
        file.push(format!("s3-sidekick-open-guard-{}.txt", std::process::id()));
        std::fs::write(&file, b"x").unwrap();

        let result = open_local_path(file.to_string_lossy().to_string());
        let _ = std::fs::remove_file(&file);

        let err = result.expect_err("a file must be rejected");
        assert!(err.contains("Only folders"), "unexpected error: {}", err);
    }

    #[test]
    fn open_local_path_rejects_nonexistent() {
        let mut missing = std::env::temp_dir();
        missing.push(format!("s3-sidekick-absent-{}", std::process::id()));
        let result = open_local_path(missing.to_string_lossy().to_string());
        assert!(result.is_err());
    }
}
