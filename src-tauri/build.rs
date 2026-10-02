// The app manifest turns on Tauri's access check for the app's own
// commands: each one gets an `allow-<command>` permission, and only the
// capabilities in capabilities/ grant them. Keep this list in step with
// `generate_handler!` in main.rs (src/ipc_acl.rs enforces it).
const COMMANDS: &[&str] = &[
    "build_object_url",
    "cancel_transfer",
    "change_security_password",
    "clear_saved_connection",
    "clear_transfer_manifest",
    "connect",
    "copy_object_to",
    "copy_prefix_to",
    "create_folder",
    "delete_copied_objects",
    "delete_objects",
    "delete_prefix",
    "disable_biometric",
    "discard_download_scratch",
    "disconnect",
    "download_object",
    "download_object_parallel",
    "enable_biometric",
    "factory_reset",
    "generate_presigned_url",
    "get_available_disk_bytes",
    "get_object_acl",
    "get_platform_info",
    "get_security_status",
    "head_object",
    "initialize_security",
    "is_app_translocated",
    "list_buckets",
    "list_local_files_recursive",
    "list_objects",
    "load_bookmarks",
    "load_bookmarks_backup",
    "load_connection",
    "load_settings",
    "load_transfer_manifest",
    "lock_security",
    "object_exists",
    "open_external_url",
    "open_local_path",
    "path_exists",
    "preview_object",
    "rename_object",
    "rename_prefix",
    "save_bookmarks",
    "save_bookmarks_backup",
    "save_connection",
    "save_settings",
    "save_transfer_manifest",
    "set_lock_timeout",
    "set_object_acl",
    "set_security_encryption",
    "touch_security_activity",
    "transfer_checkpoint_gc",
    "transfer_checkpoint_remove",
    "unlock_biometric",
    "unlock_security",
    "update_metadata",
    "updater_support_info",
    "updater_supported",
    "upload_object",
    "upload_object_bytes",
    "write_text_file",
];

// Windows gives the main thread a 1 MiB stack. Tauri runs the
// `generate_handler!` dispatcher on the main thread for every IPC call, and
// its release frame holds every async command's future inline (about 2.4 MiB
// in 0.11.1), so the first invoke overflowed with 0xC00000FD. Reserve 8 MiB,
// the Linux/macOS main-thread default. scripts/e2e-windows-startup.mjs
// checks the header and a real launch.
const WINDOWS_MAIN_STACK_BYTES: u32 = 8 * 1024 * 1024;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!(
                "cargo:rustc-link-arg-bins=/STACK:{}",
                WINDOWS_MAIN_STACK_BYTES
            ),
            Ok("gnu") => println!(
                "cargo:rustc-link-arg-bins=-Wl,--stack,{}",
                WINDOWS_MAIN_STACK_BYTES
            ),
            _ => {}
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
