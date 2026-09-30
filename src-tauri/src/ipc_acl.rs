//! Checks the real capability set (tauri.conf.json + capabilities/) against
//! the registered commands, through Tauri's own IPC access check.
//!
// Failure modes, written before the app manifest existed:
// - No app manifest: every custom command is callable from any window, so
//   a compromised or future secondary webview reaches the whole backend.
// - A command registered in `generate_handler!` is missing from the
//   build.rs manifest; it gets no permission and fails at runtime.
// - A manifest command is not granted to the main window; same failure.
// - A second window label or an unknown command is allowed anyway.

use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};

fn request(cmd: &str) -> tauri::webview::InvokeRequest {
    tauri::webview::InvokeRequest {
        cmd: cmd.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("local IPC origin"),
        body: tauri::ipc::InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn build_manifest_commands() -> Vec<String> {
    let source = include_str!("../build.rs");
    let start = source
        .find("const COMMANDS: &[&str] = &[")
        .expect("build.rs declares the COMMANDS manifest");
    let body = &source[start..];
    let end = body.find("];").expect("COMMANDS list is closed");
    let mut names: Vec<String> = body[..end]
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

#[test]
fn build_manifest_lists_exactly_the_registered_commands() {
    let registered = crate::ipc_contract::registered_commands(include_str!("main.rs"));
    assert_eq!(
        build_manifest_commands(),
        registered,
        "build.rs COMMANDS must match generate_handler! in main.rs"
    );
}

#[test]
fn capabilities_grant_the_main_window_only_registered_commands() {
    // A stub handler answers every command, so any error below comes from
    // the access check, never from the command itself.
    let app = mock_builder()
        .invoke_handler(|invoke| {
            invoke.resolver.resolve(());
            true
        })
        .build(tauri::generate_context!(test = true))
        .expect("build app with the real capabilities");
    let main = match tauri::Manager::get_webview_window(&app, "main") {
        Some(window) => window,
        None => tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("main window"),
    };

    let registered = crate::ipc_contract::registered_commands(include_str!("main.rs"));
    let denied: Vec<&String> = registered
        .iter()
        .filter(|cmd| get_ipc_response(&main, request(cmd)).is_err())
        .collect();
    assert!(
        denied.is_empty(),
        "main window is denied registered commands: {:?}",
        denied
    );

    assert!(
        get_ipc_response(&main, request("not_a_registered_command")).is_err(),
        "an unknown command must be rejected by the access check"
    );

    let other = tauri::WebviewWindowBuilder::new(&app, "secondary", Default::default())
        .build()
        .expect("secondary window");
    assert!(
        get_ipc_response(&other, request("list_buckets")).is_err(),
        "a window outside the capability must not reach backend commands"
    );
}
