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
            return "flatpak";
        }
        if std::env::var("APPIMAGE").is_err() {
            return "manual";
        }
    }
    "native"
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
}
