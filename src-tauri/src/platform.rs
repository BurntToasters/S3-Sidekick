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
/// Resolve the path handed to the OS launcher.
///
/// The grant already checked its canonical identity at use time, but an
/// ancestor swapped for a symlink between that check and the spawn can still
/// redirect the launcher. Re-resolve immediately before building argv and
/// launch the canonical path, which has no symlink components at this point
/// (M9). A final-component symlink is refused rather than resolved.
fn resolve_launch_target(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|err| format!("Failed to resolve local path '{}': {}", path.display(), err))?;
    if canonical
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Refusing to launch a symbolic link: {}",
            canonical.display()
        ));
    }
    #[cfg(windows)]
    let canonical = std::path::PathBuf::from(crate::strip_extended_windows_prefix(
        &canonical.to_string_lossy(),
    ));
    Ok(canonical)
}

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
    // Resolve ancestors at the last moment and launch the canonical path.
    let parsed = resolve_launch_target(&parsed)?;
    if !parsed.is_dir() {
        return Err(format!(
            "Only folders can be opened, not individual files: {}",
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
    let target = resolve_launch_target(&target)?;

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

/// Polls of `kill -0` on the old PID before the helper gives up (600 x 0.1 s).
#[cfg(target_os = "macos")]
const RELAUNCH_MAX_POLLS: &str = "600";

/// Positional args: `$1` old PID, `$2` bundle, `$3` launcher, `$4` poll limit.
/// Nothing is interpolated into this text.
#[cfg(any(target_os = "macos", test))]
const RELAUNCH_HELPER_SCRIPT: &str = r#"
i=0
while kill -0 "$1" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt "$4" ]; then
    exit 1
  fi
  /bin/sleep 0.1
done
exec "$3" "$2"
"#;

/// Returns `<X>.app` for an executable at `<X>.app/Contents/MacOS/<bin>`.
/// Dev builds and other layouts return `None`, so they use the plain restart.
#[cfg(any(target_os = "macos", test))]
fn bundle_root_for_exe(exe: &std::path::Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Starts the detached helper. It waits for `pid` to exit, then opens the
/// bundle without `-n`, so the Dock tile binds to the new instance.
#[cfg(target_os = "macos")]
fn spawn_relaunch_helper(
    pid: u32,
    bundle: &std::path::Path,
    launcher: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    // Own process group, so the helper is not killed with the old process.
    Command::new("/bin/sh")
        .arg("-c")
        .arg(RELAUNCH_HELPER_SCRIPT)
        .arg("sh")
        .arg(pid.to_string())
        .arg(bundle)
        .arg(launcher)
        .arg(RELAUNCH_MAX_POLLS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}

/// Starts the helper and exits. Returns false when the caller must fall back.
#[cfg(target_os = "macos")]
fn relaunch_through_helper(app: &tauri::AppHandle) -> bool {
    let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_root_for_exe(&exe))
    else {
        return false;
    };
    let launcher = match unix_launcher("open") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Relaunch helper unavailable: {error}");
            return false;
        }
    };
    match spawn_relaunch_helper(std::process::id(), &bundle, &launcher) {
        Ok(()) => {
            // Exit now; the helper opens the bundle once this PID is gone.
            app.exit(0);
            true
        }
        Err(error) => {
            eprintln!("Failed to start relaunch helper: {error}");
            false
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn relaunch_through_helper(_app: &tauri::AppHandle) -> bool {
    false
}

/// Restart the app. On macOS the old process exits before the new copy is
/// opened, so a pinned Dock tile does not keep pointing at the old instance.
#[tauri::command]
pub(crate) fn relaunch_app(app: tauri::AppHandle) {
    if !relaunch_through_helper(&app) {
        app.request_restart();
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
        let expected = resolve_launch_target(&file).unwrap();
        let result = reveal_plan(RevealPlatform::MacOs, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file is revealable on macOS");
        assert_eq!(plan.program, "open");
        assert_eq!(
            plan.args,
            vec![std::ffi::OsString::from("-R"), expected.into_os_string()]
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
        let expected = resolve_launch_target(&file).unwrap();
        let result = reveal_plan(RevealPlatform::Windows, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file is revealable on Windows");
        assert_eq!(plan.program, "explorer");
        assert_eq!(
            plan.args,
            vec![std::ffi::OsString::from(format!(
                "/select,{}",
                expected.display()
            ))]
        );
    }

    #[test]
    fn reveal_local_plan_linux_opens_the_parent_folder_never_the_file() {
        let dir = reveal_scratch("linux-parent");
        let file = reveal_file(&dir, "report.csv");
        let expected = resolve_launch_target(&dir).unwrap();
        let result = reveal_plan(RevealPlatform::Linux, &file.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let plan = result.expect("a file's parent folder is revealable on Linux");
        assert_eq!(plan.program, "xdg-open");
        assert_eq!(plan.args, vec![expected.into_os_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn reveal_local_plan_linux_opens_the_resolved_parent_for_a_symlinked_ancestor() {
        // A symlinked ancestor is resolved to the canonical folder the grant
        // already pinned. Launching the canonical path cannot be redirected by
        // swapping the link name afterwards (M9).
        let dir = reveal_scratch("linux-symlink-parent");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).expect("create real folder");
        reveal_file(&real, "report.csv");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("create folder symlink");
        let expected = resolve_launch_target(&real).unwrap();
        let plan = reveal_plan(
            RevealPlatform::Linux,
            &link.join("report.csv").to_string_lossy(),
        )
        .expect("a symlinked ancestor resolves to the real folder");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(plan.program, "xdg-open");
        assert_eq!(plan.args, vec![expected.into_os_string()]);
    }

    // ---- Relaunch helper: restart without a second Dock tile (macOS) ----

    #[test]
    fn relaunch_bundle_root_found_for_installed_executable() {
        assert_eq!(
            bundle_root_for_exe(std::path::Path::new(
                "/Applications/S3 Sidekick.app/Contents/MacOS/s3-sidekick"
            )),
            Some(PathBuf::from("/Applications/S3 Sidekick.app"))
        );
    }

    #[test]
    fn relaunch_bundle_root_keeps_spaces_quotes_and_dollars_in_path() {
        let exe = std::path::Path::new(
            "/Users/me/My \"Apps\" $HOME/S3 Sidekick.app/Contents/MacOS/s3-sidekick",
        );
        assert_eq!(
            bundle_root_for_exe(exe),
            Some(PathBuf::from("/Users/me/My \"Apps\" $HOME/S3 Sidekick.app"))
        );
    }

    #[test]
    fn relaunch_bundle_root_rejects_dev_build_paths() {
        assert_eq!(
            bundle_root_for_exe(std::path::Path::new(
                "/repo/src-tauri/target/debug/s3-sidekick"
            )),
            None
        );
    }

    #[test]
    fn relaunch_bundle_root_rejects_wrong_layouts() {
        for exe in [
            "/Applications/S3 Sidekick.app/Contents/Resources/s3-sidekick",
            "/Applications/S3 Sidekick.app/MacOS/s3-sidekick",
            "/Applications/S3 Sidekick/Contents/MacOS/s3-sidekick",
            "/Applications/.app/Contents/MacOS/s3-sidekick",
            "/Contents/MacOS/s3-sidekick",
            "s3-sidekick",
        ] {
            assert_eq!(
                bundle_root_for_exe(std::path::Path::new(exe)),
                None,
                "{exe}"
            );
        }
    }

    #[test]
    fn relaunch_script_takes_pid_bundle_launcher_and_limit_positionally() {
        assert!(RELAUNCH_HELPER_SCRIPT.contains("kill -0 \"$1\""));
        assert!(RELAUNCH_HELPER_SCRIPT.contains("-gt \"$4\""));
        assert!(RELAUNCH_HELPER_SCRIPT.contains("exec \"$3\" \"$2\""));
        assert!(!RELAUNCH_HELPER_SCRIPT.contains("/usr/bin/open"));
    }

    #[test]
    fn relaunch_script_never_passes_dash_n_to_the_launcher() {
        assert!(!RELAUNCH_HELPER_SCRIPT
            .split_whitespace()
            .any(|token| token == "-n"));
    }

    #[test]
    fn relaunch_script_timeout_exit_comes_before_exec() {
        let exit_at = RELAUNCH_HELPER_SCRIPT.find("exit 1").expect("timeout exit");
        let exec_at = RELAUNCH_HELPER_SCRIPT.find("exec ").expect("exec line");
        assert!(exit_at < exec_at);
    }

    /// Scratch directory removed on drop, so a failing assert leaves nothing.
    #[cfg(unix)]
    struct RelaunchScratch(PathBuf);

    #[cfg(unix)]
    impl RelaunchScratch {
        fn new(name: &str) -> Self {
            let mut dir = std::env::temp_dir();
            dir.push(format!(
                "s3-sidekick-relaunch-{}-{}",
                name,
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create relaunch scratch dir");
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    #[cfg(unix)]
    impl Drop for RelaunchScratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Stub launcher that writes its argv, one argument per line, to `marker`.
    #[cfg(unix)]
    fn write_stub_launcher(dir: &std::path::Path, marker: &std::path::Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let stub = dir.join("stub-open");
        let body = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            marker.display()
        );
        std::fs::write(&stub, body).expect("write stub launcher");
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755))
            .expect("chmod stub launcher");
        stub
    }

    #[cfg(unix)]
    fn spawn_helper(
        pid: u32,
        bundle: &std::path::Path,
        stub: &std::path::Path,
        limit: &str,
    ) -> std::process::Child {
        use std::process::Stdio;
        Command::new("/bin/sh")
            .arg("-c")
            .arg(RELAUNCH_HELPER_SCRIPT)
            .arg("sh")
            .arg(pid.to_string())
            .arg(bundle)
            .arg(stub)
            .arg(limit)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn relaunch helper")
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_helper_opens_bundle_only_after_old_pid_has_exited() {
        let scratch = RelaunchScratch::new("waits");
        let marker = scratch.path("opened.txt");
        let stub = write_stub_launcher(&scratch.0, &marker);
        let bundle = std::path::Path::new("/Applications/S3 Sidekick.app");

        let mut old = Command::new("/bin/sleep")
            .arg("1")
            .spawn()
            .expect("spawn old process");
        let started = std::time::Instant::now();
        let mut helper = spawn_helper(old.id(), bundle, &stub, "600");
        // A zombie still answers `kill -0`, so the helper cannot pass this
        // point until the old process has exited and been reaped here.
        old.wait().expect("reap old process");
        let status = helper.wait().expect("wait for helper");

        assert!(status.success(), "helper failed: {status}");
        assert!(started.elapsed() >= std::time::Duration::from_millis(900));
        let opened = std::fs::read_to_string(&marker).expect("stub launcher ran");
        assert_eq!(
            opened.lines().collect::<Vec<_>>(),
            vec![bundle.to_str().unwrap()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_helper_gives_up_on_a_live_pid_without_opening() {
        let scratch = RelaunchScratch::new("timeout");
        let marker = scratch.path("opened.txt");
        let stub = write_stub_launcher(&scratch.0, &marker);
        let bundle = std::path::Path::new("/Applications/S3 Sidekick.app");

        let mut live = Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .expect("spawn live process");
        let started = std::time::Instant::now();
        let status = spawn_helper(live.id(), bundle, &stub, "3")
            .wait()
            .expect("wait for helper");
        let elapsed = started.elapsed();
        let _ = live.kill();
        let _ = live.wait();

        assert!(!status.success(), "helper must fail on timeout");
        assert!(elapsed < std::time::Duration::from_secs(2), "{elapsed:?}");
        assert!(!marker.exists(), "launcher must not run on timeout");
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_helper_passes_awkward_bundle_path_verbatim() {
        let scratch = RelaunchScratch::new("verbatim");
        let marker = scratch.path("opened.txt");
        let stub = write_stub_launcher(&scratch.0, &marker);
        let bundle_text = "/Users/me/My \"Apps\" $HOME/S3 Sidekick.app";

        // An exited and reaped child gives a PID that `kill -0` rejects.
        let mut gone = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn short-lived process");
        let pid = gone.id();
        gone.wait().expect("reap short-lived process");

        let status = spawn_helper(pid, std::path::Path::new(bundle_text), &stub, "600")
            .wait()
            .expect("wait for helper");

        assert!(status.success(), "helper failed: {status}");
        let opened = std::fs::read_to_string(&marker).expect("stub launcher ran");
        assert_eq!(opened.lines().collect::<Vec<_>>(), vec![bundle_text]);
    }
}
