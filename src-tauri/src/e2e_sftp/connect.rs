//! Connect-flow checks against the OpenSSH fleet. Each test records named
//! checks; the names are listed in `tests/sftp/expected-checks/connect.json`.
//!
//! Every test builds its own app and state. Tests run one at a time, so the
//! backend's single pending-attempt slot is always the one the test started.

use std::time::Duration;

use tauri::Manager;

use super::*;
use crate::sftp::connect::{
    has_pending_attempt, ATTEMPT_EXPIRED, AUTH_FAILED, CONNECT_CANCELLED, HANDSHAKE_TIMED_OUT,
    HANDSHAKE_TIMEOUT, HOST_KEY_CHANGED_NOTE, PASSPHRASE_INCORRECT, RSA_HOST_KEY_MESSAGE,
};
use crate::sftp::keyfile::{
    inspect_private_key, read_private_key_file, PPK_MESSAGE, RSA_KEY_MESSAGE,
};
use crate::sftp::session::{map_sftp_error, require_session};

const PASSWORD: &str = "password";
const KEY: &str = "key";
const KEYBOARD: &str = "keyboard-interactive";

fn pinned<'a>(env: &'a Env) -> ConnectOptions<'a> {
    ConnectOptions {
        password: Some(&env.password),
        pinned_host_key: Some(&env.main_host_key),
        ..ConnectOptions::default()
    }
}

fn unpinned_password<'a>(env: &'a Env) -> ConnectOptions<'a> {
    ConnectOptions {
        password: Some(&env.password),
        ..ConnectOptions::default()
    }
}

/// Connect with a pinned main-port key and a password, and insist on success.
async fn connect_pinned_password(
    app: &tauri::App<tauri::test::MockRuntime>,
    env: &Env,
) -> serde_json::Value {
    connect(app, env, env.port_main, &env.user, PASSWORD, pinned(env))
        .await
        .expect("pinned password connect succeeds")
}

fn host_key_tokens(line: &str) -> Vec<String> {
    line.split_whitespace()
        .take(2)
        .map(str::to_string)
        .collect()
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_host_key_trust() {
    let test = "host_key_trust";
    let env = env();

    // Unknown key: the step is returned and nothing is installed yet.
    let app = make_app();
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await
    .expect("connect reaches the host key step");
    let snapshot = session_snapshot(&app);
    let fingerprint = step["fingerprint_sha256"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    record(
        test,
        "unknown host key returns host_key_unknown and installs no session until trusted",
        step_kind(&step) == "host_key_unknown"
            && fingerprint == env.main_fingerprint
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false,
        serde_json::json!({
            "step": step_kind(&step),
            "fingerprint_sha256": fingerprint,
            "session": snapshot,
        }),
    );

    // Trust installs the session; the id is accepted and the channel works.
    let attempt = attempt_id(&step);
    let connected = reply(&app, &attempt, Some(true), None)
        .await
        .expect("trust completes the connect");
    let id = connection_id(&connected);
    let home = connected["home_path"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let live = match require_session(&app.state::<AppState>(), &id, None) {
        Ok(registered) => registered.handle.sftp.canonicalize(".").await.ok(),
        Err(_) => None,
    };
    let accepted = require_session(&app.state::<AppState>(), &id, None).is_ok();
    record(
        test,
        "trusting the unknown host key installs a session that require_session accepts",
        step_kind(&connected) == "connected"
            && accepted
            && home.starts_with('/')
            && live.as_deref() == Some(home.as_str()),
        serde_json::json!({
            "step": step_kind(&connected),
            "require_session_accepts": accepted,
            "home_path": home,
            "live_canonical_path": live,
        }),
    );

    // The reported fingerprint and key line come from the server, and must
    // match what ssh-keygen reports for the server's own public key file.
    let reported_fp = connected["host_key_fingerprint"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let reported_line = connected["host_key"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    record(
        test,
        "reported SHA256 fingerprint and host key line equal ssh-keygen's values for the server key",
        reported_fp == env.main_fingerprint
            && host_key_tokens(&reported_line) == host_key_tokens(&env.main_host_key),
        serde_json::json!({
            "host_key_fingerprint": reported_fp,
            "expected_fingerprint": env.main_fingerprint,
            "host_key": reported_line,
        }),
    );

    // Declining trust installs nothing and retires the attempt.
    let app = make_app();
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await
    .expect("connect reaches the host key step");
    let attempt = attempt_id(&step);
    let declined = reply(&app, &attempt, Some(false), None).await;
    let snapshot = session_snapshot(&app);
    let pending = has_pending_attempt();
    record(
        test,
        "declining trust installs no session and fails the attempt",
        declined.is_err()
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false
            && !pending,
        serde_json::json!({
            "reply": declined.as_ref().err(),
            "session": snapshot,
            "pending_attempt": pending,
        }),
    );

    // A stale ID (the declined attempt) and a foreign ID are both refused.
    let stale = reply(&app, &attempt, Some(true), None).await;
    let foreign = reply(&app, "00112233445566778899aabbccddeeff", Some(true), None).await;
    let stale_refused = matches!(&stale, Err(message) if message == ATTEMPT_EXPIRED);
    let foreign_refused = matches!(&foreign, Err(message) if message == ATTEMPT_EXPIRED);
    record(
        test,
        "a stale or foreign attempt_id is refused with 'Connection attempt expired'",
        stale_refused && foreign_refused,
        serde_json::json!({
            "stale": stale.as_ref().err(),
            "foreign": foreign.as_ref().err(),
        }),
    );

    // Cancel during the host key wait installs nothing.
    let app = make_app();
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await
    .expect("connect reaches the host key step");
    let attempt = attempt_id(&step);
    let cancelled = crate::sftp::sftp_connect_cancel(attempt.clone()).await;
    let after_cancel = reply(&app, &attempt, Some(true), None).await;
    let snapshot = session_snapshot(&app);
    record(
        test,
        "cancel during the host key wait installs nothing",
        cancelled.is_ok()
            && matches!(&after_cancel, Err(message) if message == ATTEMPT_EXPIRED)
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false,
        serde_json::json!({
            "cancel": cancelled.as_ref().err(),
            "reply_after_cancel": after_cancel.as_ref().err(),
            "session": snapshot,
        }),
    );

    // Disconnect during the host key wait cancels the attempt, and its task
    // releases the pending slot on its own.
    let app = make_app();
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await
    .expect("connect reaches the host key step");
    let pending_before = has_pending_attempt();
    let disconnected = crate::s3::disconnect(app.state::<AppState>(), String::new()).await;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut released = false;
    while std::time::Instant::now() < deadline {
        if !has_pending_attempt() {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    record(
        test,
        "disconnect during the host key wait cancels the attempt and releases it",
        step_kind(&step) == "host_key_unknown"
            && pending_before
            && disconnected.is_ok()
            && released,
        serde_json::json!({
            "step": step_kind(&step),
            "pending_before_disconnect": pending_before,
            "disconnect": disconnected.as_ref().err(),
            "pending_released": released,
        }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_pinned_keys_and_rsa_refusal() {
    let test = "pinned_keys_and_rsa";
    let env = env();

    // A pin that matches connects without a trust step.
    let app = make_app();
    let step = connect_pinned_password(&app, &env).await;
    let id = connection_id(&step);
    let live = require_session(&app.state::<AppState>(), &id, None).is_ok();
    record(
        test,
        "a pinned key that matches connects without a trust step",
        step_kind(&step) == "connected" && live,
        serde_json::json!({ "step": step_kind(&step), "require_session_accepts": live }),
    );

    // A pin that does not match the alternate server is refused, and nothing installs.
    let app = make_app();
    let refused = connect(&app, &env, env.port_alt, &env.user, PASSWORD, pinned(&env)).await;
    let message = refused.as_ref().err().cloned().unwrap_or_default();
    let endpoint = format!("sftp://{}:{}", env.host, env.port_alt);
    let snapshot = session_snapshot(&app);
    record(
        test,
        "a pinned key mismatch is refused with the changed-key message and installs nothing",
        refused.is_err()
            && message.contains("changed")
            && message.contains(HOST_KEY_CHANGED_NOTE)
            && message.contains(&endpoint)
            && message.contains("SHA256:")
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false,
        serde_json::json!({ "message": message, "session": snapshot }),
    );

    // An RSA-only server fails during negotiation with the RSA message.
    let app = make_app();
    let rsa = connect(
        &app,
        &env,
        env.port_rsa,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await;
    record(
        test,
        "an RSA-only server fails with the RSA host key message",
        rsa.as_ref().err().map(String::as_str) == Some(RSA_HOST_KEY_MESSAGE),
        serde_json::json!({ "result": rsa.as_ref().err() }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_password_and_key_auth() {
    let test = "password_and_key_auth";
    let env = env();

    let app = make_app();
    let step = connect_pinned_password(&app, &env).await;
    let live = require_session(&app.state::<AppState>(), &connection_id(&step), None).is_ok();
    record(
        test,
        "password authentication succeeds and installs a session",
        step_kind(&step) == "connected" && live,
        serde_json::json!({ "step": step_kind(&step), "require_session_accepts": live }),
    );

    // The hardlink probe must see the extension, and must leave nothing behind.
    let create_only = step["create_only_supported"] == true;
    let home = step["home_path"].as_str().unwrap_or_default().to_string();
    let leftovers = probe_leftovers(&env.container, &home);
    record(
        test,
        "the OpenSSH server reports create_only_supported true (hardlink extension detected)",
        create_only && matches!(&leftovers, Ok(names) if names.is_empty()),
        serde_json::json!({
            "create_only_supported": step["create_only_supported"],
            "home_path": home,
            "probe_files_left": leftovers.as_ref().ok(),
            "listing_error": leftovers.as_ref().err(),
        }),
    );

    let app = make_app();
    let wrong = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        ConnectOptions {
            password: Some("not-the-password"),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await;
    let message = wrong.as_ref().err().cloned().unwrap_or_default();
    let snapshot = session_snapshot(&app);
    let pending = has_pending_attempt();
    record(
        test,
        "a wrong password fails with 'Authentication failed.' and leaves no session or pending attempt",
        message == AUTH_FAILED
            && !message.contains("not-the-password")
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false
            && !pending,
        serde_json::json!({
            "message": message,
            "session": snapshot,
            "pending_attempt": pending,
        }),
    );

    let ed25519 = key_file(&env, "id_ed25519");
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        KEY,
        ConnectOptions {
            private_key: Some(&ed25519),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("Ed25519 key connect");
    record(
        test,
        "Ed25519 key authentication succeeds",
        step_kind(&step) == "connected",
        serde_json::json!({ "step": step_kind(&step) }),
    );

    let ecdsa = key_file(&env, "id_ecdsa");
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        KEY,
        ConnectOptions {
            private_key: Some(&ecdsa),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("ECDSA key connect");
    record(
        test,
        "ECDSA key authentication succeeds",
        step_kind(&step) == "connected",
        serde_json::json!({ "step": step_kind(&step) }),
    );

    let encrypted = key_file(&env, "id_ed25519_enc");
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        KEY,
        ConnectOptions {
            private_key: Some(&encrypted),
            passphrase: Some(&env.passphrase),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("encrypted key connect");
    record(
        test,
        "encrypted Ed25519 key with the right passphrase succeeds",
        step_kind(&step) == "connected",
        serde_json::json!({ "step": step_kind(&step) }),
    );

    let wrong_passphrase = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        KEY,
        ConnectOptions {
            private_key: Some(&encrypted),
            passphrase: Some("wrong-passphrase"),
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await;
    record(
        test,
        "encrypted Ed25519 key with a wrong passphrase fails with the passphrase message",
        wrong_passphrase.as_ref().err().map(String::as_str) == Some(PASSPHRASE_INCORRECT),
        serde_json::json!({ "result": wrong_passphrase.as_ref().err() }),
    );

    // Key refusals are checked on the granted files, the same path the dialog uses.
    let rsa_text = key_file(&env, "id_rsa");
    let rsa_refusal = inspect_private_key(&rsa_text);
    let rsa_file = read_private_key_file(&env.key_dir.join("id_rsa"));
    record(
        test,
        "RSA key is refused by inspect_private_key with the RSA message",
        rsa_refusal.as_ref().err().map(String::as_str) == Some(RSA_KEY_MESSAGE)
            && rsa_file.as_ref().err().map(String::as_str) == Some(RSA_KEY_MESSAGE),
        serde_json::json!({
            "inspect": rsa_refusal.as_ref().err(),
            "granted_file": rsa_file.as_ref().err(),
        }),
    );

    let ppk_text = key_file(&env, "fake.ppk");
    let ppk_refusal = inspect_private_key(&ppk_text);
    record(
        test,
        "PuTTY .ppk file is refused by inspect_private_key with the PuTTY message",
        ppk_refusal.as_ref().err().map(String::as_str) == Some(PPK_MESSAGE),
        serde_json::json!({ "inspect": ppk_refusal.as_ref().err() }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_keyboard_interactive_and_partial_auth() {
    let test = "keyboard_interactive_and_partial_auth";
    let env = env();

    let app = make_app();
    let prompt = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        KEYBOARD,
        ConnectOptions {
            pinned_host_key: Some(&env.main_host_key),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("keyboard-interactive connect reaches a prompt");
    let prompt_count = prompt["prompts"].as_array().map(Vec::len).unwrap_or(0);
    let answered = if step_kind(&prompt) == "prompt" {
        reply(
            &app,
            &attempt_id(&prompt),
            None,
            Some(vec![env.password.clone()]),
        )
        .await
        .ok()
    } else {
        None
    };
    let kind = answered.as_ref().map(step_kind).unwrap_or_default();
    record(
        test,
        "keyboard-interactive returns a prompt step and succeeds with the right response",
        step_kind(&prompt) == "prompt" && prompt_count == 1 && kind == "connected",
        serde_json::json!({
            "prompt_step": step_kind(&prompt),
            "prompt_count": prompt_count,
            "prompt": prompt["prompts"],
            "after_response": kind,
        }),
    );

    // The partial-auth server accepts the key first and then needs a password,
    // which this client does not support. The refusal must name it.
    let app = make_app();
    let ed25519 = key_file(&env, "id_ed25519");
    let first = connect(
        &app,
        &env,
        env.port_partial,
        &env.user,
        KEY,
        ConnectOptions {
            private_key: Some(&ed25519),
            ..ConnectOptions::default()
        },
    )
    .await
    .expect("partial-auth connect reaches the host key step");
    let partial = if step_kind(&first) == "host_key_unknown" {
        reply(&app, &attempt_id(&first), Some(true), None).await
    } else {
        Ok(first.clone())
    };
    let message = partial.as_ref().err().cloned().unwrap_or_default();
    record(
        test,
        "partial-auth server fails with the required-methods message",
        message.contains("password")
            && message.contains("not supported in this beta")
            && !message.contains("SHA256:"),
        serde_json::json!({ "message": message }),
    );
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_session_lifecycle() {
    let test = "session_lifecycle";
    let env = env();

    // An S3 command on the SFTP session must fail closed.
    let app = make_app();
    let step = connect_pinned_password(&app, &env).await;
    let id = connection_id(&step);
    let s3_result = crate::s3::list_buckets(app.state::<AppState>(), id.clone()).await;
    let still_sftp = live_sftp_session(&app);
    record(
        test,
        "an S3 command on the SFTP session fails closed",
        s3_result.is_err() && still_sftp,
        serde_json::json!({
            "list_buckets": s3_result.as_ref().err(),
            "sftp_still_installed": still_sftp,
        }),
    );
    drop(app);

    // A second connect replaces the session and retires the first ID.
    let baseline_replace =
        wait_for_server_sessions(&env.container, &env.user, Duration::from_secs(15), |n| {
            n == 0
        });
    let app = make_app();
    let first = connect_pinned_password(&app, &env).await;
    let first_id = connection_id(&first);
    let second = connect_pinned_password(&app, &env).await;
    let second_id = connection_id(&second);
    let stale = require_session(&app.state::<AppState>(), &first_id, None).is_err();
    let current = require_session(&app.state::<AppState>(), &second_id, None).is_ok();
    record(
        test,
        "require_session refuses a stale connection id",
        stale && current,
        serde_json::json!({ "stale_id_refused": stale, "current_id_accepted": current }),
    );
    let ids_differ = !first_id.is_empty() && first_id != second_id;
    let sshd_sessions = wait_for_sshd_sessions(&env, 1, Duration::from_secs(15)).await;
    record(
        test,
        "a new connect replaces the session and retires the old connection id",
        ids_differ && stale && current && sshd_sessions == 1 && baseline_replace == 0,
        serde_json::json!({
            "baseline_server_processes": baseline_replace,
            "first_connection_id_set": !first_id.is_empty(),
            "ids_differ": ids_differ,
            "server_sshd_sessions_after_replace": sshd_sessions,
        }),
    );
    drop(app);

    // Disconnect clears the session and the server ends the SSH session.
    let app = make_app();
    let baseline =
        wait_for_server_sessions(&env.container, &env.user, Duration::from_secs(15), |n| {
            n == 0
        });
    let step = connect_pinned_password(&app, &env).await;
    let id = connection_id(&step);
    let during =
        wait_for_server_sessions(&env.container, &env.user, Duration::from_secs(10), |n| {
            n > 0
        });
    let disconnected = crate::s3::disconnect(app.state::<AppState>(), id.clone()).await;
    let snapshot = session_snapshot(&app);
    let after = wait_for_server_sessions(&env.container, &env.user, Duration::from_secs(15), |n| {
        n == 0
    });
    record(
        test,
        "disconnect clears the SFTP session and the server ends the SSH session",
        baseline == 0
            && during > 0
            && disconnected.is_ok()
            && snapshot["sftp_installed"] == false
            && snapshot["connection_id_set"] == false
            && after == 0,
        serde_json::json!({
            "baseline_server_processes": baseline,
            "during_server_processes": during,
            "disconnect": disconnected.as_ref().err(),
            "session": snapshot,
            "after_server_processes": after,
        }),
    );

    drop(app);

    // A server-side drop closes the handle, and map_sftp_error reports the loss.
    let app = make_app();
    let baseline =
        wait_for_server_sessions(&env.container, &env.user, Duration::from_secs(15), |n| {
            n == 0
        });
    let step = connect_pinned_password(&app, &env).await;
    let registered = require_session(&app.state::<AppState>(), &connection_id(&step), None)
        .unwrap_or_else(|err| panic!("require_session on a live session: {}", err));
    let before = map_sftp_error(&registered.handle, "list", "boom");
    let killed = kill_server_sessions(&env.container, &env.user).unwrap_or(0);
    let mut closed = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if registered.handle.ssh.is_closed() {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let after = map_sftp_error(&registered.handle, "list", "boom");
    record(
        test,
        "a server-side drop closes the handle and map_sftp_error reports the connection as lost",
        baseline == 0
            && before == "list: boom"
            && killed > 0
            && closed
            && after == "SFTP connection lost: list",
        serde_json::json!({
            "baseline_server_processes": baseline,
            "open_message": before,
            "killed_server_sessions": killed,
            "handle_closed": closed,
            "lost_message": after,
        }),
    );
}

/// Wait until the server runs exactly `expected` SSH session processes for the
/// test user (the subsystem children are not counted).
async fn wait_for_sshd_sessions(env: &Env, expected: usize, limit: Duration) -> usize {
    let deadline = std::time::Instant::now() + limit;
    loop {
        let count = server_sessions(&env.container, &env.user)
            .map(|sessions| {
                sessions
                    .iter()
                    .filter(|(_, args)| args.starts_with("sshd: "))
                    .count()
            })
            .unwrap_or(usize::MAX);
        if count == expected || std::time::Instant::now() >= deadline {
            return count;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A TCP listener on loopback that accepts connections and never writes a byte,
/// as a black-holed or wedged SSH server would. Accepted sockets stay open until
/// the test process exits.
fn silent_listener() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind silent listener");
    let port = listener
        .local_addr()
        .expect("silent listener address")
        .port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming().flatten() {
            held.push(stream);
        }
    });
    port
}

#[tokio::test]
#[ignore = "needs the SFTP E2E runner (npm run test:e2e:sftp)"]
async fn e2e_handshake_deadline_and_cancel() {
    let test = "handshake_deadline_and_cancel";
    let env = env();
    let silent_port = silent_listener();
    let loopback = ConnectOptions {
        host: Some("127.0.0.1"),
        password: Some(&env.password),
        ..ConnectOptions::default()
    };

    // A server that never sends its banner is refused at the handshake deadline.
    let app = make_app();
    let started = std::time::Instant::now();
    // The outer limit turns a missing deadline into a failed check instead of a hung run.
    let silent = tokio::time::timeout(
        HANDSHAKE_TIMEOUT + Duration::from_secs(20),
        connect(&app, &env, silent_port, &env.user, PASSWORD, loopback),
    )
    .await
    .unwrap_or_else(|_| Err("no answer within the outer test limit".to_string()));
    let elapsed = started.elapsed();
    let pending = has_pending_attempt();
    let snapshot = session_snapshot(&app);
    record(
        test,
        "a server that accepts TCP and never sends a banner fails at the handshake deadline and leaves no attempt or session",
        matches!(&silent, Err(message) if message.starts_with(HANDSHAKE_TIMED_OUT))
            && elapsed >= HANDSHAKE_TIMEOUT
            && elapsed < HANDSHAKE_TIMEOUT + Duration::from_secs(10)
            && !pending
            && snapshot["sftp_installed"] == false,
        serde_json::json!({
            "result": silent.as_ref().ok(),
            "error": silent.as_ref().err(),
            "elapsed_ms": elapsed.as_millis() as u64,
            "pending_attempt": pending,
            "session": snapshot,
        }),
    );
    drop(app);

    // Cancel reaches an attempt that has not reported its first step yet.
    let app = make_app();
    let started = std::time::Instant::now();
    let loopback = ConnectOptions {
        host: Some("127.0.0.1"),
        password: Some(&env.password),
        ..ConnectOptions::default()
    };
    let (cancelled, cancel_result) = tokio::join!(
        async {
            tokio::time::timeout(
                Duration::from_secs(10),
                connect(&app, &env, silent_port, &env.user, PASSWORD, loopback),
            )
            .await
            .unwrap_or_else(|_| Err("no answer within the outer test limit".to_string()))
        },
        async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            crate::sftp::connect::sftp_connect_cancel_pending().await
        }
    );
    let elapsed = started.elapsed();
    let pending = has_pending_attempt();
    record(
        test,
        "sftp_connect_cancel_pending ends a connect that has not reported a step yet, at once, and leaves no attempt",
        matches!(&cancelled, Err(message) if message == CONNECT_CANCELLED)
            && cancel_result.is_ok()
            && elapsed < Duration::from_secs(5)
            && !pending
            && !live_sftp_session(&app),
        serde_json::json!({
            "error": cancelled.as_ref().err(),
            "cancel": cancel_result.as_ref().err(),
            "elapsed_ms": elapsed.as_millis() as u64,
            "pending_attempt": pending,
        }),
    );
    drop(app);

    // Time the user spends on the trust prompt does not count against the deadline.
    let app = make_app();
    let step = connect(
        &app,
        &env,
        env.port_main,
        &env.user,
        PASSWORD,
        unpinned_password(&env),
    )
    .await
    .expect("connect reaches the host key step");
    tokio::time::sleep(HANDSHAKE_TIMEOUT + Duration::from_secs(2)).await;
    let trusted = if step_kind(&step) == "host_key_unknown" {
        reply(&app, &attempt_id(&step), Some(true), None).await
    } else {
        Err(format!("unexpected first step {}", step_kind(&step)))
    };
    record(
        test,
        "a host key trust wait longer than the handshake deadline still connects once trusted",
        trusted
            .as_ref()
            .is_ok_and(|step| step_kind(step) == "connected")
            && live_sftp_session(&app),
        serde_json::json!({
            "first_step": step_kind(&step),
            "trusted_step": trusted.as_ref().ok().map(step_kind),
            "error": trusted.as_ref().err(),
        }),
    );
    drop(app);
}
