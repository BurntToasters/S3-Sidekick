use std::path::PathBuf;
use std::process::Command;

/// Resolve a Windows system executable from the OS directory, never from the
/// current directory or PATH. A malicious `rundll32.exe` beside the app must
/// not be able to intercept URL/path opening.
fn windows_system_exe(subdir: &str, name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    if subdir.is_empty() {
        root.join(name)
    } else {
        root.join(subdir).join(name)
    }
}

/// Resolve a Unix launcher to an absolute OS path.
///
/// `Command::new("open")` / `Command::new("xdg-open")` search `PATH`, so a
/// compromised environment can place a same-named binary earlier and intercept
/// every URL or folder open. Only the standard OS locations are accepted; a
/// missing launcher is an error rather than a silent PATH fallback.
fn unix_launcher(name: &str) -> Result<PathBuf, String> {
    let candidates: &[&str] = match name {
        "open" => &["/usr/bin/open", "/bin/open"],
        "xdg-open" => &[
            "/usr/bin/xdg-open",
            "/bin/xdg-open",
            "/usr/local/bin/xdg-open",
        ],
        _ => return Err(format!("Unknown system launcher '{}'", name)),
    };
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!(
        "Unable to find the system launcher '{}' in the standard OS locations",
        name
    ))
}

/// Build a launcher command from an absolute OS path. Windows launchers come
/// from `%SystemRoot%`; Unix launchers are resolved by `unix_launcher`.
fn launcher_command(program: &str) -> Result<Command, String> {
    if cfg!(target_os = "windows") {
        let exe = if program == "explorer" {
            windows_system_exe("", "explorer.exe")
        } else {
            windows_system_exe("System32", "rundll32.exe")
        };
        Ok(Command::new(exe))
    } else {
        Ok(Command::new(unix_launcher(program)?))
    }
}

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

/// True when macOS is running a translocated copy (launched from a mounted
/// DMG). The mounted copy is read-only, so the updater's rename-replace fails
/// with EROFS; the UI tells the user to move the app to /Applications.
#[tauri::command]
pub(crate) fn is_app_translocated() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::base::{CFTypeRef, TCFType};
        use core_foundation::url::CFURL;

        type Boolean = u8;
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SecTranslocateIsTranslocatedURL(
                url: CFTypeRef,
                is_translocated: *mut Boolean,
                error: *mut CFTypeRef,
            ) -> Boolean;
        }

        let executable = std::env::current_exe().map_err(|err| err.to_string())?;
        let url = CFURL::from_path(&executable, false)
            .ok_or_else(|| "Failed to build a URL for the app executable.".to_string())?;
        let mut translocated: Boolean = 0;
        let result = unsafe {
            SecTranslocateIsTranslocatedURL(
                url.as_CFTypeRef(),
                &mut translocated,
                std::ptr::null_mut(),
            )
        };
        Ok(result != 0 && translocated != 0)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
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
        launcher_command("rundll32")?
            .args(["url.dll,FileProtocolHandler", &url])
            .status()
    } else if cfg!(target_os = "macos") {
        launcher_command("open")?.arg(&url).status()
    } else {
        launcher_command("xdg-open")?.arg(&url).status()
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

/// Whether a directory is a macOS bundle that `open` would launch or install
/// rather than display.
fn is_macos_bundle(path: &std::path::Path) -> bool {
    const BUNDLE_EXTENSIONS: &[&str] = &[
        "app",
        "appex",
        "bundle",
        "framework",
        "plugin",
        "kext",
        "prefpane",
        "xpc",
        "qlgenerator",
        "mdimporter",
        "saver",
        "workflow",
        "action",
        "pkg",
        "mpkg",
    ];
    let extension_is_bundle = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| BUNDLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    // Any directory with a bundle Info.plist is treated as one, whatever its
    // name, since Launch Services decides by the bundle structure.
    extension_is_bundle || path.join("Contents").join("Info.plist").is_file()
}

/// Reveal a folder in the system file manager.
///
/// Restricted to directories on purpose. Handing an arbitrary existing file to
/// `explorer` / `open` / `xdg-open` means the shell's default handler runs it,
/// which turned this command into a local code-execution primitive reachable
/// from the webview. The only caller ever needed to open a folder.
#[tauri::command]
pub(crate) fn open_local_path(token: String) -> Result<(), String> {
    // Only a path the user chose in a native picker (or a completed download's
    // destination grant) may be opened. A raw renderer path has no grant and
    // fails closed.
    let granted =
        crate::path_authority::authorize(&token, crate::path_authority::GrantUse::Reveal)?;
    let parsed = granted.path;
    if !parsed.is_absolute() {
        return Err(format!("Path must be absolute: {}", parsed.display()));
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
        launcher_command("explorer")?
            .arg(&parsed)
            .status()
            .map_err(|e| format!("Failed to open local path: {}", e))?;
        return Ok(());
    }

    // On macOS a bundle (e.g. `Foo.app`) is a directory, and `open` launches
    // it instead of showing it. Refuse bundles so this cannot run code.
    if cfg!(target_os = "macos") && is_macos_bundle(&parsed) {
        return Err(format!(
            "Refusing to open an application or bundle: {}",
            parsed.display()
        ));
    }

    let status = if cfg!(target_os = "macos") {
        launcher_command("open")?.arg(&parsed).status()
    } else {
        launcher_command("xdg-open")?.arg(&parsed).status()
    }
    .map_err(|e| format!("Failed to open local path: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Local path launcher exited with status {}", status))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevealPlatform {
    MacOs,
    Windows,
    Linux,
}

#[derive(Debug, PartialEq)]
struct RevealPlan {
    program: &'static str,
    args: Vec<std::ffi::OsString>,
}

fn host_reveal_platform() -> RevealPlatform {
    if cfg!(target_os = "windows") {
        RevealPlatform::Windows
    } else if cfg!(target_os = "macos") {
        RevealPlatform::MacOs
    } else {
        RevealPlatform::Linux
    }
}

fn is_symlink(path: &std::path::Path) -> bool {
    path.symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Build the opener command that shows `raw` in the file manager, without
/// running it. Kept apart from the spawn so tests can check the argv on any
/// host. Every platform refuses relative, missing, and symlink targets first.
fn reveal_plan(platform: RevealPlatform, raw: &str) -> Result<RevealPlan, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Path is required".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err(format!("Path must be absolute: {}", trimmed));
    }
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }
    if is_symlink(&target) {
        return Err(format!(
            "Refusing to reveal a symbolic link: {}",
            target.display()
        ));
    }

    match platform {
        RevealPlatform::MacOs => {
            // `open -R` selects the item without launching it. A bundle
            // directory is still refused, so no bundle is ever handed to `open`.
            if target.is_dir() && is_macos_bundle(&target) {
                return Err(format!(
                    "Refusing to reveal an application or bundle: {}",
                    target.display()
                ));
            }
            Ok(RevealPlan {
                program: "open",
                args: vec![std::ffi::OsString::from("-R"), target.into_os_string()],
            })
        }
        RevealPlatform::Windows => {
            let mut select = std::ffi::OsString::from("/select,");
            select.push(target.as_os_str());
            Ok(RevealPlan {
                program: "explorer",
                args: vec![select],
            })
        }
        RevealPlatform::Linux => {
            // Linux file managers can only open folders, so pass the parent
            // folder. The file itself never reaches xdg-open.
            let parent = target
                .parent()
                .ok_or_else(|| format!("Path has no parent folder: {}", target.display()))?;
            if !parent.is_dir() {
                return Err(format!("Parent is not a folder: {}", parent.display()));
            }
            if is_symlink(parent) {
                return Err(format!(
                    "Refusing to open a symbolic link: {}",
                    parent.display()
                ));
            }
            Ok(RevealPlan {
                program: "xdg-open",
                args: vec![parent.as_os_str().to_os_string()],
            })
        }
    }
}

/// Show a completed download in the system file manager, selecting the file
/// where the platform supports it. The file is never run.
#[tauri::command]
pub(crate) fn reveal_local_path(token: String, name: Option<String>) -> Result<(), String> {
    let granted = crate::path_authority::resolve(
        &token,
        crate::path_authority::GrantUse::Reveal,
        name.as_deref(),
    )?;
    let platform = host_reveal_platform();
    let plan = reveal_plan(platform, &granted.path.to_string_lossy())?;
    let status = launcher_command(plan.program)?
        .args(&plan.args)
        .status()
        .map_err(|e| format!("Failed to reveal local path: {}", e))?;

    // Same as open_local_path: explorer.exe can exit non-zero after it has
    // opened the window, so only a spawn failure is an error on Windows.
    if platform == RevealPlatform::Windows {
        return Ok(());
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("Local path reveal exited with status {}", status))
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
    fn open_local_path_rejects_a_raw_path_without_a_grant() {
        // The pre-authority signature was `open_local_path(path)`. That form
        // must now fail even when the path exists and is a folder.
        let result = open_local_path("relative/path".to_string());
        let err = result.expect_err("a bare path must not authorize an open");
        assert!(err.contains("grant"), "unexpected error: {}", err);
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

        let token = crate::path_authority::mint(
            crate::path_authority::GrantPurpose::UploadFile,
            &file,
            false,
            Some(1),
        );
        let result = open_local_path(token);
        let _ = std::fs::remove_file(&file);

        let err = result.expect_err("a file must be rejected");
        assert!(err.contains("Only folders"), "unexpected error: {}", err);
    }

    #[test]
    fn open_local_path_rejects_nonexistent() {
        let mut missing = std::env::temp_dir();
        missing.push(format!("s3-sidekick-absent-{}", std::process::id()));
        let token = crate::path_authority::mint(
            crate::path_authority::GrantPurpose::Reveal,
            &missing,
            true,
            None,
        );
        let result = open_local_path(token);
        assert!(result.is_err());
    }

    /// Fresh scratch directory for one reveal test. Tests run in parallel, so
    /// the name carries the test name and the process ID.
    fn reveal_scratch(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "s3-sidekick-reveal-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn reveal_file(dir: &std::path::Path, name: &str) -> PathBuf {
        let file = dir.join(name);
        std::fs::write(&file, b"x").expect("write scratch file");
        file
    }

    #[test]
    fn reveal_local_path_rejects_a_raw_path_without_a_grant() {
        let err = reveal_local_path("downloads/report.csv".to_string(), None)
            .expect_err("a raw path must be rejected");
        assert!(err.contains("grant"), "unexpected error: {}", err);
    }

    #[test]
    fn reveal_local_path_rejects_missing_file() {
        let dir = reveal_scratch("missing");
        let missing = dir.join("never-written.csv");
        let token = crate::path_authority::mint(
            crate::path_authority::GrantPurpose::Reveal,
            &missing,
            false,
            None,
        );
        let result = reveal_local_path(token, None);
        let _ = std::fs::remove_dir_all(&dir);
        let err = result.expect_err("a missing file must be rejected");
        assert!(err.contains("does not exist"), "unexpected error: {}", err);
    }

    #[cfg(unix)]
    #[test]
    fn reveal_local_path_rejects_symlink() {
        // A link would reveal (or, on Linux, open the folder of) a target the
        // user never saw recorded, so the link itself is refused.
        let dir = reveal_scratch("symlink");
        let target = reveal_file(&dir, "real.csv");
        let link = dir.join("link.csv");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        let token = crate::path_authority::mint(
            crate::path_authority::GrantPurpose::Reveal,
            &link,
            false,
            None,
        );
        let result = reveal_local_path(token, None);
        let _ = std::fs::remove_dir_all(&dir);
        let err = result.expect_err("a symlink must be rejected");
        assert!(err.contains("symbolic link"), "unexpected error: {}", err);
    }

    #[test]
    fn reveal_local_plan_rejects_relative_on_every_platform() {
        for platform in [
            RevealPlatform::MacOs,
            RevealPlatform::Windows,
            RevealPlatform::Linux,
        ] {
            let result = reveal_plan(platform, "downloads/report.csv");
            assert!(result.is_err(), "{:?} accepted a relative path", platform);
        }
    }

    #[test]
    fn reveal_local_plan_macos_selects_the_file_with_open_r() {
        let dir = reveal_scratch("macos-file");
        let file = reveal_file(&dir, "report.csv");
        let result = reveal_plan(RevealPlatform::MacOs, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file is revealable on macOS");
        assert_eq!(plan.program, "open");
        assert_eq!(
            plan.args,
            vec![
                std::ffi::OsString::from("-R"),
                file.clone().into_os_string()
            ]
        );
    }

    #[test]
    fn reveal_local_plan_macos_refuses_bundle_directories() {
        let dir = reveal_scratch("macos-bundle");
        let bundle = dir.join("Demo.app");
        std::fs::create_dir_all(bundle.join("Contents")).expect("create bundle");
        let result = reveal_plan(RevealPlatform::MacOs, &bundle.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let err = result.expect_err("a bundle directory must be refused");
        assert!(err.contains("Refusing"), "unexpected error: {}", err);
    }

    #[test]
    fn reveal_local_plan_windows_uses_explorer_select() {
        let dir = reveal_scratch("windows-file");
        let file = reveal_file(&dir, "report.csv");
        let result = reveal_plan(RevealPlatform::Windows, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file is revealable on Windows");
        assert_eq!(plan.program, "explorer");
        assert_eq!(
            plan.args,
            vec![std::ffi::OsString::from(format!(
                "/select,{}",
                file.display()
            ))]
        );
    }

    #[test]
    fn reveal_local_plan_linux_opens_the_parent_folder_never_the_file() {
        let dir = reveal_scratch("linux-parent");
        let file = reveal_file(&dir, "report.csv");
        let result = reveal_plan(RevealPlatform::Linux, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file's parent folder is revealable on Linux");
        assert_eq!(plan.program, "xdg-open");
        assert_eq!(plan.args, vec![dir.clone().into_os_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn reveal_local_plan_linux_refuses_a_symlinked_parent() {
        let dir = reveal_scratch("linux-symlink-parent");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).expect("create real folder");
        reveal_file(&real, "report.csv");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("create folder symlink");
        let result = reveal_plan(
            RevealPlatform::Linux,
            &link.join("report.csv").to_string_lossy(),
        );
        let _ = std::fs::remove_dir_all(&dir);
        let err = result.expect_err("a symlinked parent folder must be refused");
        assert!(err.contains("symbolic link"), "unexpected error: {}", err);
    }
}
