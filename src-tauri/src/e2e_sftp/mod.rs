//! End-to-end checks of the SFTP connect flow against a real OpenSSH server.
//!
//! Run with `npm run test:e2e:sftp`, which builds the OpenSSH container in
//! `tests/sftp`, starts five sshd instances on 127.0.0.1, runs these ignored
//! tests, and writes a JSON report to `test-results/sftp-e2e/`.
//!
//! The `connect`, `fs`, and `transfer` suites all run in this one pass. Each
//! check name is listed in `tests/sftp/expected-checks/`, and the runner fails
//! on a missing, renamed, repeated, or unlisted check.

// Ways these checks could pass without proving anything, and each guard:
// - Server unreachable: the runner waits for each sshd banner, and every connect
//   result is asserted, so an error is a failure rather than a skipped step.
// - Fingerprint compared to the code under test: the expected fingerprint is
//   computed by `ssh-keygen -lf` on the server's public key file in the runner.
// - Host key accepted by default: the unknown-key checks assert that no session
//   is installed before trust, and the mismatch check pins another server's key.
// - Password or key accepted for the wrong user: the username is explicit and
//   the server's process table is read for that user.
// - A session installed without a working channel: trust checks canonicalize
//   the home directory through the installed SFTP handle.

// - A disconnect that leaves the SSH session open: the server's process table
//   is counted before connect, after connect, and after disconnect.
// - A stale-ID check that never had a live session: the lifecycle check first
//   installs a session, then replaces it, then tests the retired ID.
// - Observed values copied from the expectation: observed values are read from
//   the connect result, the installed state, or the server process table.

// - A failed step later passing on stale state: every attempt uses a new app,
//   and a connect always replaces or cancels the previous pending attempt.
// - A skipped or renamed check looks like a pass: the runner requires every
//   expected check name to appear exactly once.
// - A map_sftp_error branch that is never exercised: the lost-connection branch
//   is reached by killing the server-side SSH session, and the open-connection
//   branch is checked on the live handle.

mod connect;
mod fs;
mod transfer;

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::security::SecurityConfig;
use crate::{AppState, S3State, StorageProviderKind};

/// Environment the runner provides. Each field is required.
pub(crate) struct Env {
    pub(crate) host: String,
    pub(crate) port_main: u16,
    pub(crate) port_rsa: u16,
    pub(crate) port_alt: u16,
    pub(crate) port_partial: u16,
    pub(crate) port_nolink: u16,
    pub(crate) user: String,
    pub(crate) password: String,
    pub(crate) passphrase: String,
    pub(crate) key_dir: PathBuf,
    pub(crate) main_host_key: String,
    pub(crate) main_fingerprint: String,
    pub(crate) container: String,
}

pub(crate) fn env() -> Env {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{} must be set by the E2E runner", name))
    };
    let port = |name: &str| {
        var(name)
            .parse::<u16>()
            .unwrap_or_else(|_| panic!("{} must be a port number", name))
    };
    Env {
        host: var("S3_SIDEKICK_E2E_SFTP_HOST"),
        port_main: port("S3_SIDEKICK_E2E_SFTP_PORT_MAIN"),
        port_rsa: port("S3_SIDEKICK_E2E_SFTP_PORT_RSA"),
        port_alt: port("S3_SIDEKICK_E2E_SFTP_PORT_ALT"),
        port_partial: port("S3_SIDEKICK_E2E_SFTP_PORT_PARTIAL"),
        port_nolink: port("S3_SIDEKICK_E2E_SFTP_PORT_NOLINK"),
        user: var("S3_SIDEKICK_E2E_SFTP_USER"),
        password: var("S3_SIDEKICK_E2E_SFTP_PASSWORD"),
        passphrase: var("S3_SIDEKICK_E2E_SFTP_PASSPHRASE"),
        key_dir: PathBuf::from(var("S3_SIDEKICK_E2E_SFTP_KEY_DIR")),
        main_host_key: var("S3_SIDEKICK_E2E_SFTP_MAIN_HOST_KEY"),
        main_fingerprint: var("S3_SIDEKICK_E2E_SFTP_MAIN_FINGERPRINT"),
        container: var("S3_SIDEKICK_E2E_SFTP_CONTAINER"),
    }
}

/// Read one file from the runner's temporary key directory.
pub(crate) fn key_file(env: &Env, name: &str) -> String {
    std::fs::read_to_string(env.key_dir.join(name))
        .unwrap_or_else(|err| panic!("read key fixture {}: {}", name, err))
}

/// Append one check to the JSON-lines report the runner turns into the
/// artifact. Panics (fails the test) when the check did not hold.
pub(crate) fn record(test: &str, check: &str, passed: bool, observed: serde_json::Value) {
    if let Ok(path) = std::env::var("S3_SIDEKICK_E2E_REPORT") {
        use std::io::Write;
        let line = serde_json::json!({
            "test": test,
            "check": check,
            "passed": passed,
            "observed": observed,
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open E2E report");
        writeln!(file, "{}", line).expect("write E2E report");
    }
    assert!(passed, "{}: {} (observed {})", test, check, observed);
}

/// A mock app that clears its session when the test drops it.
///
/// The mock runtime keeps the app's managed state alive after the app is
/// dropped, so a session would otherwise stay open on the server until the test
/// process exits. Dropping this clears the session the way a disconnect does,
/// which closes the SSH connection and lets the server count reach its baseline.
pub(crate) struct TestApp(tauri::App<tauri::test::MockRuntime>);

impl std::ops::Deref for TestApp {
    type Target = tauri::App<tauri::test::MockRuntime>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let state = self.0.state::<AppState>();
        let locked = crate::lock_s3_state(&state);
        if let Ok(mut s3) = locked {
            crate::s3::invalidate_connection_session(&mut s3);
        }
    }
}

pub(crate) fn make_app() -> TestApp {
    TestApp(
        tauri::test::mock_builder()
            .manage(AppState(Mutex::new(S3State {
                client: None,
                endpoint: String::new(),
                region: String::new(),
                bucket_hint: None,
                connection_generation: 0,
                connection_id: None,
                connection_identity: None,
                storage_provider: StorageProviderKind::default(),
                sftp: None,
            })))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app"),
    )
}

pub(crate) fn save_plaintext_e2e_security_config(app: &tauri::App<tauri::test::MockRuntime>) {
    assert!(
        std::env::var_os("S3_SIDEKICK_TEST_APP_DATA").is_some(),
        "SFTP E2E must use isolated app data before saving security config"
    );
    crate::security::save_security_config(
        app,
        &SecurityConfig {
            initialized: true,
            encryption_enabled: false,
            salt: String::new(),
            verifier: String::new(),
            lock_timeout_minutes: 0,
            pbkdf2_iterations: 0,
            kdf: crate::security::KdfAlgorithm::Pbkdf2,
            argon2_memory_kib: 0,
            argon2_iterations: 1,
            argon2_parallelism: 1,
            policy_schema: 2,
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: String::new(),
            policy_mac: String::new(),
        },
    )
    .expect("save explicit plaintext test security configuration");
}

/// Options for one `sftp_connect` call. Every field is optional except the
/// port, the username, and the method.
#[derive(Default)]
pub(crate) struct ConnectOptions<'a> {
    pub(crate) host: Option<&'a str>,
    pub(crate) password: Option<&'a str>,
    pub(crate) private_key: Option<&'a str>,
    pub(crate) passphrase: Option<&'a str>,
    pub(crate) pinned_host_key: Option<&'a str>,
}

/// Start a connect and return the step as JSON, the shape the webview reads.
pub(crate) async fn connect(
    app: &tauri::App<tauri::test::MockRuntime>,
    env: &Env,
    port: u16,
    user: &str,
    method: &str,
    options: ConnectOptions<'_>,
) -> Result<serde_json::Value, String> {
    save_plaintext_e2e_security_config(app);
    let step = crate::sftp::sftp_connect(
        app.state::<AppState>(),
        options.host.unwrap_or(&env.host).to_string(),
        port,
        user.to_string(),
        method.to_string(),
        options.password.map(str::to_string),
        options.private_key.map(str::to_string),
        options.passphrase.map(str::to_string),
        options.pinned_host_key.map(str::to_string),
    )
    .await?;
    serde_json::to_value(&step).map_err(|err| err.to_string())
}

/// Answer a pending step through `sftp_connect_continue`.
pub(crate) async fn reply(
    app: &tauri::App<tauri::test::MockRuntime>,
    attempt_id: &str,
    trust_host_key: Option<bool>,
    responses: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let step = crate::sftp::sftp_connect_continue(
        app.state::<AppState>(),
        attempt_id.to_string(),
        trust_host_key,
        responses,
    )
    .await?;
    serde_json::to_value(&step).map_err(|err| err.to_string())
}

/// The `step` tag of a connect result.
pub(crate) fn step_kind(step: &serde_json::Value) -> String {
    step["step"].as_str().unwrap_or_default().to_string()
}

/// The attempt ID of a `host_key_unknown` or `prompt` step.
pub(crate) fn attempt_id(step: &serde_json::Value) -> String {
    step["attempt_id"].as_str().unwrap_or_default().to_string()
}

/// The connection ID of a `connected` step.
pub(crate) fn connection_id(step: &serde_json::Value) -> String {
    step["connection_id"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// True when the backend holds an SFTP session under this connection ID.
pub(crate) fn live_sftp_session(app: &tauri::App<tauri::test::MockRuntime>) -> bool {
    crate::lock_s3_state(&app.state::<AppState>())
        .map(|s3| s3.sftp.is_some())
        .unwrap_or(false)
}

/// Snapshot of the S3 session fields that an SFTP install must leave clean.
pub(crate) fn session_snapshot(app: &tauri::App<tauri::test::MockRuntime>) -> serde_json::Value {
    match crate::lock_s3_state(&app.state::<AppState>()) {
        Ok(s3) => serde_json::json!({
            "sftp_installed": s3.sftp.is_some(),
            "connection_id_set": s3.connection_id.is_some(),
            "s3_client_set": s3.client.is_some(),
            "s3_endpoint": s3.endpoint,
        }),
        Err(err) => serde_json::json!({ "error": err }),
    }
}

/// Processes the server runs for `user`: SSH session processes and SFTP
/// subsystem children, read from inside the container.
pub(crate) fn server_sessions(container: &str, user: &str) -> Result<Vec<(u32, String)>, String> {
    let output = Command::new("docker")
        .args(["exec", container, "ps", "-eo", "pid=,user=,args="])
        .output()
        .map_err(|err| format!("docker exec ps failed: {}", err))?;
    if !output.status.success() {
        return Err(format!("docker exec ps exited with {}", output.status));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut sessions = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if parts.next() != Some(user) {
            continue;
        }
        let args = parts.collect::<Vec<_>>().join(" ");
        if args.starts_with("sshd: ") || args.contains("sftp-server") {
            sessions.push((pid, args));
        }
    }
    Ok(sessions)
}

/// Hardlink probe files left in `home`, listed from inside the container so the
/// server's own directory view decides.
pub(crate) fn probe_leftovers(container: &str, home: &str) -> Result<Vec<String>, String> {
    let output = Command::new("docker")
        .args(["exec", container, "ls", "-A", home])
        .output()
        .map_err(|err| format!("docker exec ls failed: {}", err))?;
    if !output.status.success() {
        return Err(format!("docker exec ls exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|name| name.starts_with(".s3sk-probe-"))
        .map(str::to_string)
        .collect())
}

/// Poll the server's process table until `predicate` holds, or give up.
///
/// Returns the last observed count so a failed check can report it.
pub(crate) fn wait_for_server_sessions(
    container: &str,
    user: &str,
    limit: Duration,
    predicate: impl Fn(usize) -> bool,
) -> usize {
    let deadline = Instant::now() + limit;
    loop {
        let count = server_sessions(container, user)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if predicate(count) || Instant::now() >= deadline {
            return count;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Kill the server-side SSH session processes for `user`, as a network drop would.
pub(crate) fn kill_server_sessions(container: &str, user: &str) -> Result<usize, String> {
    let sessions = server_sessions(container, user)?;
    let mut killed = 0;
    for (pid, args) in sessions {
        if !args.starts_with("sshd: ") {
            continue;
        }
        let status = Command::new("docker")
            .args(["exec", container, "kill", "-9", &pid.to_string()])
            .status()
            .map_err(|err| format!("docker exec kill failed: {}", err))?;
        if status.success() {
            killed += 1;
        }
    }
    Ok(killed)
}
