//! End-to-end checks of the S3 command layer against a real MinIO server.
//!
//! Run with `npm run test:e2e:minio`, which starts MinIO in Docker on
//! 127.0.0.1:9000 (detected as MinIO) and 127.0.0.1:19000 (the same server,
//! detected as a generic provider), runs these ignored tests, and writes a
//! JSON report to `test-results/minio-e2e/`.
//!
// Ways these checks could pass without proving anything, and each guard:
// - Server unreachable: assert connect and seed through an independent client.
// - Same decoding bug in setup: seed and verify through the raw SDK client.
// - Delete missing key reports success: re-read removed and surviving objects.
// - Provider claim alone is wrong: verify advertised capabilities and
//   resulting behavior, including explicit overwrite compatibility.
// - Tests share state: give every test its own bucket and connection.
// - Skipped assertion looks like pass: record every check and reject empty sets.
// - Pre-registration cancel still commits: confirm error and object absence.
// - A 412 matched to an identical destination looks like our own retried
//   copy; rollback must keep that destination (it may belong to another
//   client), so re-read it after rollback and require a retained notice.

use std::sync::Mutex;
use std::time::Duration;

use aws_sdk_s3::primitives::ByteStream;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::security::SecurityConfig;
use crate::{s3, AppState, S3State, StorageProviderKind};

struct Env {
    endpoint_minio: String,
    endpoint_generic: String,
    access_key: String,
    secret_key: String,
}

fn env() -> Env {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{} must be set by the E2E runner", name))
    };
    Env {
        endpoint_minio: var("S3_SIDEKICK_E2E_ENDPOINT"),
        endpoint_generic: var("S3_SIDEKICK_E2E_GENERIC_ENDPOINT"),
        access_key: var("S3_SIDEKICK_E2E_ACCESS_KEY"),
        secret_key: var("S3_SIDEKICK_E2E_SECRET_KEY"),
    }
}

/// Append one check to the JSON-lines report the runner turns into the
/// artifact. Panics (fails the test) when the check did not hold.
fn record(test: &str, check: &str, passed: bool, observed: serde_json::Value) {
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

fn raw_client(endpoint: &str, env: &Env) -> aws_sdk_s3::Client {
    let creds =
        aws_sdk_s3::config::Credentials::new(&env.access_key, &env.secret_key, None, None, "e2e");
    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(endpoint)
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(creds)
        .force_path_style(true)
        .behavior_version_latest()
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

fn make_app() -> tauri::App<tauri::test::MockRuntime> {
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
        })))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

fn save_plaintext_e2e_security_config(app: &tauri::App<tauri::test::MockRuntime>) {
    assert!(
        std::env::var_os("S3_SIDEKICK_TEST_APP_DATA").is_some(),
        "MinIO E2E must use isolated app data before saving security config"
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
            biometric_enrolled: false,
            legacy_plaintext_adopted: true,
            legacy_plaintext_adoption_proof: String::new(),
        },
    )
    .expect("save explicit plaintext test security configuration");
}

async fn connect(
    app: &tauri::App<tauri::test::MockRuntime>,
    endpoint: &str,
    env: &Env,
) -> s3::ConnectResult {
    save_plaintext_e2e_security_config(app);
    s3::connect(
        app.state::<AppState>(),
        endpoint.to_string(),
        "us-east-1".to_string(),
        env.access_key.clone(),
        env.secret_key.clone(),
        None,
    )
    .await
    .unwrap_or_else(|err| panic!("connect to {} failed: {}", endpoint, err))
}

async fn fresh_bucket(client: &aws_sdk_s3::Client, name: &str) -> String {
    let bucket = format!("s3sk-e2e-{}", name);
    let _ = client.create_bucket().bucket(&bucket).send().await;
    // Empty it in case a previous run left objects behind.
    let listed = client
        .list_objects_v2()
        .bucket(&bucket)
        .send()
        .await
        .expect("list bucket for cleanup");
    for object in listed.contents() {
        if let Some(key) = object.key() {
            let _ = client.delete_object().bucket(&bucket).key(key).send().await;
        }
    }
    bucket
}

async fn put(client: &aws_sdk_s3::Client, bucket: &str, key: &str, body: &str) {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body.as_bytes().to_vec()))
        .send()
        .await
        .unwrap_or_else(|err| panic!("seed {} failed: {:?}", key, err));
}

/// Body of an object, or None when it does not exist.
async fn read(client: &aws_sdk_s3::Client, bucket: &str, key: &str) -> Option<String> {
    let output = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .ok()?;
    let bytes = output.body.collect().await.ok()?.into_bytes();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn listed_keys(response: &s3::ListObjectsResponse) -> Vec<String> {
    let value = serde_json::to_value(response).expect("serialize listing");
    let mut keys: Vec<String> = value["objects"]
        .as_array()
        .map(|objects| {
            objects
                .iter()
                .filter_map(|object| object["key"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    keys.sort();
    keys
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_provider_detection_by_endpoint() {
    let test = "provider_detection";
    let env = env();
    let app = make_app();

    let minio = connect(&app, &env.endpoint_minio, &env).await;
    let minio_caps = serde_json::to_value(minio.create_only_capabilities).unwrap();
    record(
        test,
        "localhost:9000 is MinIO: create-only PUT, no CopyObject create-only, no multipart completion",
        minio_caps
            == serde_json::json!({"put_object": true, "complete_multipart": false, "copy_object": false}),
        minio_caps,
    );

    let app = make_app();
    let generic = connect(&app, &env.endpoint_generic, &env).await;
    let generic_caps = serde_json::to_value(generic.create_only_capabilities).unwrap();
    record(
        test,
        "another loopback port is a generic provider with no create-only guarantees",
        generic_caps
            == serde_json::json!({"put_object": false, "complete_multipart": false, "copy_object": false}),
        generic_caps,
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_keys_with_space_and_plus_stay_distinct() {
    let test = "listed_key_decoding";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "keys").await;
    put(&raw, &bucket, "docs/a b.txt", "space").await;
    put(&raw, &bucket, "docs/a+b.txt", "plus").await;
    put(&raw, &bucket, "tree/x y/1.txt", "space-folder").await;
    put(&raw, &bucket, "tree/x+y/2.txt", "plus-folder").await;

    let app = make_app();
    let session = connect(&app, &env.endpoint_minio, &env).await;
    let listing = s3::list_objects(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "docs/".to_string(),
        "/".to_string(),
        String::new(),
    )
    .await
    .expect("list docs/");
    let keys = listed_keys(&listing);
    record(
        test,
        "listing returns 'a b.txt' and 'a+b.txt' as two distinct keys",
        keys == vec!["docs/a b.txt".to_string(), "docs/a+b.txt".to_string()],
        serde_json::json!(keys),
    );

    let prefixes = serde_json::to_value(
        s3::list_objects(
            app.state::<AppState>(),
            session.connection_id.clone(),
            bucket.clone(),
            "tree/".to_string(),
            "/".to_string(),
            String::new(),
        )
        .await
        .expect("list tree/"),
    )
    .unwrap()["prefixes"]
        .clone();
    record(
        test,
        "folder prefixes 'x y/' and 'x+y/' are listed as written",
        prefixes == serde_json::json!(["tree/x y/", "tree/x+y/"]),
        prefixes,
    );

    // Deleting the listed "a b.txt" must remove exactly that object.
    let deleted = s3::delete_objects(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        vec!["docs/a b.txt".to_string()],
    )
    .await
    .expect("delete docs/a b.txt");
    let space_after = read(&raw, &bucket, "docs/a b.txt").await;
    let plus_after = read(&raw, &bucket, "docs/a+b.txt").await;
    record(
        test,
        "delete of 'a b.txt' removes it and leaves 'a+b.txt' untouched",
        space_after.is_none() && plus_after.as_deref() == Some("plus"),
        serde_json::json!({
            "result": serde_json::to_value(&deleted).unwrap(),
            "a b.txt": space_after,
            "a+b.txt": plus_after,
        }),
    );

    // Prefix delete lists keys itself; it must remove only the spaced folder.
    s3::delete_prefix(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "tree/x y/".to_string(),
    )
    .await
    .expect("delete_prefix tree/x y/");
    let spaced = read(&raw, &bucket, "tree/x y/1.txt").await;
    let plussed = read(&raw, &bucket, "tree/x+y/2.txt").await;
    record(
        test,
        "delete_prefix('x y/') removes that folder and keeps 'x+y/'",
        spaced.is_none() && plussed.as_deref() == Some("plus-folder"),
        serde_json::json!({"x y/1.txt": spaced, "x+y/2.txt": plussed}),
    );

    // Prefix copy lists source keys; copied names must keep their spaces.
    put(&raw, &bucket, "src/report final.txt", "copied").await;
    s3::copy_prefix_to(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "src/".to_string(),
        bucket.clone(),
        "dst/".to_string(),
        Some(true),
        None,
        None,
    )
    .await
    .expect("copy_prefix_to src/ -> dst/");
    let copied = read(&raw, &bucket, "dst/report final.txt").await;
    let mangled = read(&raw, &bucket, "dst/report+final.txt").await;
    record(
        test,
        "copy_prefix_to writes 'report final.txt', not 'report+final.txt'",
        copied.as_deref() == Some("copied") && mangled.is_none(),
        serde_json::json!({"dst/report final.txt": copied, "dst/report+final.txt": mangled}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_create_only_contract_matches_frontend() {
    let test = "create_only_contract";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "create-only").await;

    // MinIO guards single PUTs, so a folder marker needs no unconditional
    // write (the frontend now asks only when this is not the case).
    let app = make_app();
    let minio = connect(&app, &env.endpoint_minio, &env).await;
    let created = s3::create_folder(
        app.state::<AppState>(),
        minio.connection_id.clone(),
        bucket.clone(),
        "guarded".to_string(),
        Some(false),
    )
    .await;
    let marker = read(&raw, &bucket, "guarded/").await;
    record(
        test,
        "MinIO creates a folder with a create-only PUT",
        created.is_ok() && marker.as_deref() == Some(""),
        serde_json::json!({"result": format!("{:?}", created), "marker": marker}),
    );

    let again = s3::create_folder(
        app.state::<AppState>(),
        minio.connection_id.clone(),
        bucket.clone(),
        "guarded".to_string(),
        Some(false),
    )
    .await;
    record(
        test,
        "creating an existing folder create-only reports 'already exists'",
        again
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("already exists")),
        serde_json::json!(format!("{:?}", again)),
    );

    // A generic provider cannot guard the write. The backend must refuse with
    // the error the frontend matches (isCreateOnlyUnsupportedError) so it can
    // ask and retry, and must succeed once the write is authorized.
    let app = make_app();
    let generic = connect(&app, &env.endpoint_generic, &env).await;
    let refused = s3::create_folder(
        app.state::<AppState>(),
        generic.connection_id.clone(),
        bucket.clone(),
        "unguarded".to_string(),
        Some(false),
    )
    .await;
    record(
        test,
        "generic provider refuses a create-only folder with 'cannot enforce a create-only'",
        refused
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("cannot enforce a create-only")),
        serde_json::json!(format!("{:?}", refused)),
    );
    let authorized = s3::create_folder(
        app.state::<AppState>(),
        generic.connection_id.clone(),
        bucket.clone(),
        "unguarded".to_string(),
        Some(true),
    )
    .await;
    record(
        test,
        "the authorized (unconditional) retry creates the folder",
        authorized.is_ok() && read(&raw, &bucket, "unguarded/").await.as_deref() == Some(""),
        serde_json::json!(format!("{:?}", authorized)),
    );

    // Folder rename follows the same contract.
    put(&raw, &bucket, "old/file.txt", "rename-me").await;
    let copy_move_refused = s3::copy_prefix_to(
        app.state::<AppState>(),
        generic.connection_id.clone(),
        bucket.clone(),
        "old/".to_string(),
        bucket.clone(),
        "new-copy/".to_string(),
        Some(true),
        None,
        Some(true),
    )
    .await;
    let copy_move_destination = read(&raw, &bucket, "new-copy/file.txt").await;
    let copy_move_source = read(&raw, &bucket, "old/file.txt").await;
    record(
        test,
        "prefix move copy phase refuses before destination mutation without conditional DELETE",
        copy_move_refused
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && copy_move_destination.is_none()
            && copy_move_source.as_deref() == Some("rename-me"),
        serde_json::json!({"result": format!("{:?}", copy_move_refused), "destination": copy_move_destination, "source": copy_move_source}),
    );
    let rename_refused = s3::rename_prefix(
        app.state::<AppState>(),
        generic.connection_id.clone(),
        bucket.clone(),
        "old/".to_string(),
        "new/".to_string(),
        false,
        None,
    )
    .await;
    let source_kept = read(&raw, &bucket, "old/file.txt").await;
    record(
        test,
        "generic rename_prefix refuses an unsupported conditional move and leaves the source intact",
        rename_refused
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && source_kept.as_deref() == Some("rename-me"),
        serde_json::json!({"result": format!("{:?}", rename_refused), "source": source_kept}),
    );
    let renamed = s3::rename_prefix(
        app.state::<AppState>(),
        generic.connection_id.clone(),
        bucket.clone(),
        "old/".to_string(),
        "new/".to_string(),
        true,
        None,
    )
    .await;
    let moved = read(&raw, &bucket, "new/file.txt").await;
    let old_after_refusal = read(&raw, &bucket, "old/file.txt").await;
    record(
        test,
        "explicit overwrite does not authorize an unsafe automatic source delete",
        renamed
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && moved.is_none()
            && old_after_refusal.as_deref() == Some("rename-me"),
        serde_json::json!({"result": format!("{:?}", renamed), "destination": moved, "source": old_after_refusal}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_scratch_discard_tolerates_missing_destination_folder() {
    let test = "scratch_discard_missing_folder";
    let app = make_app();
    let missing = std::env::temp_dir()
        .join(format!("s3sk-e2e-unplugged-{}", std::process::id()))
        .join("download.bin");
    let result =
        crate::discard_download_scratch_for_destination(app.handle(), &missing.to_string_lossy());
    record(
        test,
        "discarding scratch for a destination whose folder is gone succeeds (recovery is not blocked)",
        result.is_ok(),
        serde_json::json!(format!("{:?}", result)),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_cancel_before_backend_registration_prevents_write() {
    let test = "cancel_before_registration";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "cancel-race").await;
    put(&raw, &bucket, "source.txt", "must not copy").await;
    let app = make_app();
    let session = connect(&app, &env.endpoint_minio, &env).await;
    let transfer_id = 4_200_001;
    let key = "must-not-exist.txt";

    // This ordering reproduces two IPC handlers being scheduled in the wrong
    // order: cancellation reaches Rust before the transfer command registers.
    s3::cancel_transfer(transfer_id);
    let result = s3::copy_object_to(
        app.state::<AppState>(),
        session.connection_id,
        bucket.clone(),
        "source.txt".to_string(),
        bucket.clone(),
        key.to_string(),
        Some(true),
        Some(transfer_id),
        Some(false),
        Some(false),
    )
    .await;
    let stored = read(&raw, &bucket, key).await;
    record(
        test,
        "a cancel arriving before registration rejects the transfer and commits no object",
        result
            .as_ref()
            .err()
            .is_some_and(|err| err.to_ascii_lowercase().contains("cancel"))
            && stored.is_none(),
        serde_json::json!({"result": format!("{:?}", result), "stored": stored}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_ambiguous_copy_conflict_is_refused_and_external_copy_survives() {
    let test = "ambiguous_copy_rollback";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "ambiguous-copy").await;
    let cancel: s3::CancelToken = Default::default();
    for (name, external_body) in [
        ("absent", None),
        ("different", Some("external bytes")),
        ("identical", Some("same bytes")),
    ] {
        let source_key = format!("src/{name}.txt");
        let destination_key = format!("dst/{name}.txt");
        put(&raw, &bucket, &source_key, "same bytes").await;
        if let Some(external_body) = external_body {
            put(&raw, &bucket, &destination_key, external_body).await;
        }
        let receipt = s3::e2e_copy_with_receipt(
            &raw,
            &bucket,
            &source_key,
            &destination_key,
            StorageProviderKind::Minio,
            &cancel,
        )
        .await;
        let stored = read(&raw, &bucket, &destination_key).await;
        record(
            test,
            &format!("MinIO refuses create-only CopyObject against an {name} destination before mutation"),
            receipt
                .as_ref()
                .err()
                .is_some_and(|err| err.contains("cannot enforce a create-only copy"))
                && stored.as_deref() == external_body,
            serde_json::json!({"result": format!("{:?}", receipt), "destination": stored}),
        );
    }

    // The failed create-only attempts produced no receipts, so no rollback is
    // authorized to remove either external destination.
    let different = read(&raw, &bucket, "dst/different.txt").await;
    let identical = read(&raw, &bucket, "dst/identical.txt").await;
    record(
        test,
        "no copy receipt exists that can authorize rollback of the external objects",
        read(&raw, &bucket, "dst/absent.txt").await.is_none()
            && different.as_deref() == Some("external bytes")
            && identical.as_deref() == Some("same bytes"),
        serde_json::json!({"absent": read(&raw, &bucket, "dst/absent.txt").await, "different": different, "identical": identical}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_minio_conditional_delete_is_unsupported_and_moves_refuse_early() {
    let test = "conditional_delete_provider_gate";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "conditional-delete").await;

    put(&raw, &bucket, "probe/source.txt", "copied old bytes").await;
    let old_head = raw
        .head_object()
        .bucket(&bucket)
        .key("probe/source.txt")
        .send()
        .await
        .expect("head old source");
    let old_etag = old_head.e_tag().expect("old source ETag").to_string();
    // Model an external writer replacing the source after the caller's final
    // identity read. A deliberately stale If-Match must not be trusted here.
    put(&raw, &bucket, "probe/source.txt", "external replacement").await;
    let stale_delete = raw
        .delete_object()
        .bucket(&bucket)
        .key("probe/source.txt")
        .if_match(old_etag)
        .send()
        .await;
    let after_stale_delete = read(&raw, &bucket, "probe/source.txt").await;
    record(
        test,
        "the pinned MinIO server ignores a stale If-Match DELETE after external replacement",
        stale_delete.is_ok() && after_stale_delete.is_none(),
        serde_json::json!({"delete": format!("{:?}", stale_delete), "source_after": after_stale_delete}),
    );

    put(&raw, &bucket, "move/automatic-source.txt", "move bytes").await;
    let app = make_app();
    let session = connect(&app, &env.endpoint_minio, &env).await;
    let object_move_copy = s3::copy_object_to(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "move/automatic-source.txt".to_string(),
        bucket.clone(),
        "move/automatic-destination.txt".to_string(),
        Some(true),
        None,
        Some(false),
        Some(true),
    )
    .await;
    let object_move_destination = read(&raw, &bucket, "move/automatic-destination.txt").await;
    let object_move_source = read(&raw, &bucket, "move/automatic-source.txt").await;
    record(
        test,
        "automatic object-move copy refuses before mutation when conditional DELETE is unverified",
        object_move_copy
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && object_move_destination.is_none()
            && object_move_source.as_deref() == Some("move bytes"),
        serde_json::json!({"result": format!("{:?}", object_move_copy), "destination": object_move_destination, "source": object_move_source}),
    );

    put(&raw, &bucket, "move/source.txt", "move bytes").await;
    let refused_move = s3::rename_object(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "move/source.txt".to_string(),
        "move/destination.txt".to_string(),
        true,
        None,
    )
    .await;
    let refused_destination = read(&raw, &bucket, "move/destination.txt").await;
    let source_after_refusal = read(&raw, &bucket, "move/source.txt").await;
    record(
        test,
        "rename_object refuses before destination mutation when conditional DELETE is unverified",
        refused_move
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && refused_destination.is_none()
            && source_after_refusal.as_deref() == Some("move bytes"),
        serde_json::json!({"result": format!("{:?}", refused_move), "destination": refused_destination, "source": source_after_refusal}),
    );

    // MinIO deliberately continues to allow a normal, explicitly authorized
    // single-object overwrite; only rollback-dependent prefix transactions
    // need verified delete authority when an existing destination is present.
    put(
        &raw,
        &bucket,
        "copy/explicit-overwrite.txt",
        "old destination",
    )
    .await;
    let receipt = s3::copy_object_to(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "move/source.txt".to_string(),
        bucket.clone(),
        "copy/explicit-overwrite.txt".to_string(),
        Some(true),
        None,
        Some(false),
        Some(false),
    )
    .await
    .expect("ordinary explicit overwrite copy remains available");
    let copied = read(&raw, &bucket, "copy/explicit-overwrite.txt").await;
    let source_after_copy = read(&raw, &bucket, "move/source.txt").await;
    record(
        test,
        "explicit overwrite copy replaces an existing destination without deleting its source",
        copied.as_deref() == Some("move bytes")
            && source_after_copy.as_deref() == Some("move bytes"),
        serde_json::json!({"destination": copied, "source": source_after_copy}),
    );

    let delete_refused = s3::delete_copied_objects(
        app.state::<AppState>(),
        session.connection_id,
        bucket.clone(),
        bucket.clone(),
        vec![receipt],
        None,
    )
    .await;
    let source_after_delete_refusal = read(&raw, &bucket, "move/source.txt").await;
    record(
        test,
        "receipt-backed source deletion is refused on MinIO and retains the source",
        delete_refused
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE"))
            && source_after_delete_refusal.as_deref() == Some("move bytes"),
        serde_json::json!({"result": format!("{:?}", delete_refused), "source": source_after_delete_refusal}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_suspended_null_version_is_copyable_but_not_move_authority() {
    let test = "suspended_null_version";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "null-version").await;
    let enabled = aws_sdk_s3::types::VersioningConfiguration::builder()
        .status(aws_sdk_s3::types::BucketVersioningStatus::Enabled)
        .build();
    raw.put_bucket_versioning()
        .bucket(&bucket)
        .versioning_configuration(enabled)
        .send()
        .await
        .expect("enable bucket versioning");
    put(&raw, &bucket, "source.txt", "enabled version").await;
    let suspended = aws_sdk_s3::types::VersioningConfiguration::builder()
        .status(aws_sdk_s3::types::BucketVersioningStatus::Suspended)
        .build();
    raw.put_bucket_versioning()
        .bucket(&bucket)
        .versioning_configuration(suspended)
        .send()
        .await
        .expect("suspend bucket versioning");
    let versioning = raw
        .get_bucket_versioning()
        .bucket(&bucket)
        .send()
        .await
        .expect("read suspended bucket versioning");
    put(&raw, &bucket, "source.txt", "current null version").await;
    let null_head = raw
        .head_object()
        .bucket(&bucket)
        .key("source.txt")
        .send()
        .await
        .expect("head null version");
    let null_version = null_head.version_id().map(str::to_string);
    let is_suspended_null_or_unreported = versioning.status()
        == Some(&aws_sdk_s3::types::BucketVersioningStatus::Suspended)
        && match null_version.as_deref() {
            None => true,
            Some(value) => value.eq_ignore_ascii_case("null"),
        };

    let app = make_app();
    let session = connect(&app, &env.endpoint_minio, &env).await;
    let refused_move = s3::rename_object(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "source.txt".to_string(),
        "moved.txt".to_string(),
        true,
        None,
    )
    .await;
    let source_after_refusal = read(&raw, &bucket, "source.txt").await;
    let moved_after_refusal = read(&raw, &bucket, "moved.txt").await;
    let refusal_matches_observation = match null_version.as_deref() {
        Some(value) if value.eq_ignore_ascii_case("null") => refused_move
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("mutable null version")),
        None => refused_move
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("conditional DELETE")),
        _ => false,
    };
    record(
        test,
        "MinIO suspended write is copyable and rename refuses safely with its reported version identity",
        is_suspended_null_or_unreported
            && refusal_matches_observation
            && source_after_refusal.as_deref() == Some("current null version")
            && moved_after_refusal.is_none(),
        serde_json::json!({"versioning_status": format!("{:?}", versioning.status()), "head_version_id": null_version, "result": format!("{:?}", refused_move), "source": source_after_refusal, "destination": moved_after_refusal}),
    );

    let copied = s3::copy_object_to(
        app.state::<AppState>(),
        session.connection_id.clone(),
        bucket.clone(),
        "source.txt".to_string(),
        bucket.clone(),
        "copy.txt".to_string(),
        Some(true),
        None,
        Some(false),
        Some(false),
    )
    .await;
    let copy_body = read(&raw, &bucket, "copy.txt").await;
    let source_body = read(&raw, &bucket, "source.txt").await;
    record(
        test,
        "ordinary copy can still read and copy the current null version",
        copied.is_ok()
            && copy_body.as_deref() == Some("current null version")
            && source_body.as_deref() == Some("current null version"),
        serde_json::json!({"result": format!("{:?}", copied), "copy": copy_body, "source": source_body}),
    );

    let null_receipt_delete = match copied.as_ref() {
        Ok(receipt) => {
            s3::delete_copied_objects(
                app.state::<AppState>(),
                session.connection_id,
                bucket.clone(),
                bucket.clone(),
                vec![receipt.clone()],
                None,
            )
            .await
        }
        Err(err) => Err(format!("ordinary copy did not yield a receipt: {}", err)),
    };
    let source_after_null_receipt_delete = read(&raw, &bucket, "source.txt").await;
    let copy_after_null_receipt_delete = read(&raw, &bucket, "copy.txt").await;
    record(
        test,
        "ordinary copy receipt cannot authorize source deletion on the actual MinIO provider route",
        is_suspended_null_or_unreported
            && null_receipt_delete
                .as_ref()
                .err()
                .is_some_and(|err| err.contains("conditional DELETE"))
            && source_after_null_receipt_delete.as_deref() == Some("current null version")
            && copy_after_null_receipt_delete.as_deref() == Some("current null version"),
        serde_json::json!({"head_version_id": null_version, "delete": format!("{:?}", null_receipt_delete), "source": source_after_null_receipt_delete, "copy": copy_after_null_receipt_delete}),
    );
}

#[tokio::test]
#[ignore = "needs the local HTTP E2E runner (npm run test:e2e:aws-null-version)"]
async fn e2e_aws_null_version_http_fixture_refuses_rename() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local S3 HTTP fixture");
    let endpoint = format!("http://{}", listener.local_addr().expect("fixture address"));
    let requests = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let server_requests = requests.clone();
    let server = tokio::spawn(async move {
        let mut first_request = true;
        loop {
            let wait = if first_request {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(200)
            };
            let Ok(Ok((mut stream, _))) = tokio::time::timeout(wait, listener.accept()).await
            else {
                break;
            };
            first_request = false;

            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = stream.read(&mut chunk).await.expect("read S3 request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request).into_owned();
            let request_line = request.lines().next().unwrap_or_default();
            let is_expected_head = request_line == "HEAD /e2e-null-version/source.txt HTTP/1.1";
            server_requests
                .lock()
                .expect("lock fixture request log")
                .push(request);

            let response = if is_expected_head {
                "HTTP/1.1 200 OK\r\nx-amz-version-id: null\r\nETag: \"fixture-etag\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                "HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write S3 fixture response");
        }
    });

    let creds =
        aws_sdk_s3::config::Credentials::new("e2e-access-key", "e2e-secret-key", None, None, "e2e");
    let config = aws_sdk_s3::config::Builder::new()
        .endpoint_url(&endpoint)
        .region(aws_sdk_s3::config::Region::new("us-east-1"))
        .credentials_provider(creds)
        .force_path_style(true)
        .behavior_version_latest()
        .build();
    let client = aws_sdk_s3::Client::from_conf(config);

    let app = make_app();
    save_plaintext_e2e_security_config(&app);
    let connection_id = "e2e-aws-null-version".to_string();
    {
        let state = app.state::<AppState>();
        let mut s3_state = state.0.lock().expect("lock mock S3 state");
        s3_state.client = Some(client);
        s3_state.endpoint = endpoint.clone();
        s3_state.region = "us-east-1".to_string();
        s3_state.connection_generation = 1;
        s3_state.connection_id = Some(connection_id.clone());
        s3_state.connection_identity = Some("local-http-fixture".to_string());
        s3_state.storage_provider = StorageProviderKind::Aws;
    }

    let result = s3::rename_object(
        app.state::<AppState>(),
        connection_id,
        "e2e-null-version".to_string(),
        "source.txt".to_string(),
        "moved.txt".to_string(),
        true,
        None,
    )
    .await;
    tokio::time::timeout(Duration::from_secs(6), server)
        .await
        .expect("local S3 fixture server timed out")
        .expect("local S3 fixture server panicked");

    let observed_requests = requests.lock().expect("lock fixture request log").clone();
    let request_lines: Vec<&str> = observed_requests
        .iter()
        .filter_map(|request| request.lines().next())
        .collect();
    let signed_head_observed = observed_requests.len() == 1
        && request_lines == ["HEAD /e2e-null-version/source.txt HTTP/1.1"]
        && observed_requests[0]
            .to_ascii_lowercase()
            .contains("authorization: aws4-hmac-sha256");
    let mutable_null_refused = result
        .as_ref()
        .err()
        .is_some_and(|err| err.contains("mutable null version ID"));
    let no_mutation_requests = observed_requests.iter().all(|request| {
        request
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("HEAD "))
    });
    record(
        "aws_null_version_http_fixture",
        "real AWS SDK HEAD parses literal null and rename refuses before any mutation request",
        signed_head_observed && mutable_null_refused && no_mutation_requests,
        serde_json::json!({
            "provider": "Aws",
            "endpoint": endpoint,
            "fixture_response_version_id": "null",
            "requests": request_lines,
            "signed_head_observed": signed_head_observed,
            "result": format!("{:?}", result),
            "no_mutation_requests": no_mutation_requests,
        }),
    );
}

#[derive(Clone)]
struct MoveSafetyObject {
    body: Vec<u8>,
    etag: String,
    content_length: u64,
    version_id: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MoveSafetyCopyMode {
    Ordinary,
    AmbiguousMultipart,
}

struct MoveSafetyState {
    source: Option<MoveSafetyObject>,
    destination: Option<MoveSafetyObject>,
    bucket_versioning: Option<String>,
    bucket_versioning_error: Option<String>,
    mode: MoveSafetyCopyMode,
    complete_attempts: u32,
    copy_part_requests: u32,
    consumed_upload_seen: bool,
    source_delete_requests: u32,
    requests: Vec<String>,
}

struct MoveSafetyHttpFixture {
    endpoint: String,
    state: std::sync::Arc<Mutex<MoveSafetyState>>,
    server: tokio::task::JoinHandle<()>,
}

impl MoveSafetyHttpFixture {
    async fn start(
        mode: MoveSafetyCopyMode,
        source_version_id: Option<&str>,
        bucket_versioning: Option<&str>,
        bucket_versioning_error: Option<&str>,
        source_size: u64,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind move-safety S3 HTTP fixture");
        let endpoint = format!("http://{}", listener.local_addr().expect("fixture address"));
        let source = MoveSafetyObject {
            body: b"source bytes".to_vec(),
            etag: "\"source-etag\"".to_string(),
            content_length: source_size,
            version_id: source_version_id.map(str::to_string),
        };
        let state = std::sync::Arc::new(Mutex::new(MoveSafetyState {
            source: Some(source),
            destination: None,
            bucket_versioning: bucket_versioning.map(str::to_string),
            bucket_versioning_error: bucket_versioning_error.map(str::to_string),
            mode,
            complete_attempts: 0,
            copy_part_requests: 0,
            consumed_upload_seen: false,
            source_delete_requests: 0,
            requests: Vec::new(),
        }));
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            let mut first_request = true;
            loop {
                let quiet_period = if first_request {
                    Duration::from_secs(20)
                } else {
                    Duration::from_secs(2)
                };
                let Ok(Ok((mut stream, _))) =
                    tokio::time::timeout(quiet_period, listener.accept()).await
                else {
                    break;
                };
                first_request = false;
                if let Err(err) = handle_move_safety_request(&mut stream, &server_state).await {
                    eprintln!("move-safety fixture request failed: {err}");
                }
            }
        });
        Self {
            endpoint,
            state,
            server,
        }
    }

    fn client(&self) -> aws_sdk_s3::Client {
        let creds = aws_sdk_s3::config::Credentials::new(
            "move-safety-access",
            "move-safety-secret",
            None,
            None,
            "move-safety-e2e",
        );
        let config = aws_sdk_s3::config::Builder::new()
            .endpoint_url(&self.endpoint)
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .credentials_provider(creds)
            .force_path_style(true)
            .behavior_version_latest()
            .build();
        aws_sdk_s3::Client::from_conf(config)
    }

    fn snapshot(&self) -> serde_json::Value {
        let state = self.state.lock().expect("lock move-safety fixture");
        let request_lines = state
            .requests
            .iter()
            .filter_map(|request| request.lines().next())
            .collect::<Vec<_>>();
        serde_json::json!({
            "requests": request_lines,
            "source_body": state.source.as_ref().map(|object| String::from_utf8_lossy(&object.body).to_string()),
            "destination_body": state.destination.as_ref().map(|object| String::from_utf8_lossy(&object.body).to_string()),
            "complete_attempts": state.complete_attempts,
            "copy_part_requests": state.copy_part_requests,
            "consumed_upload_seen": state.consumed_upload_seen,
            "source_delete_requests": state.source_delete_requests,
        })
    }

    async fn finish(self) {
        tokio::time::timeout(Duration::from_secs(25), self.server)
            .await
            .expect("move-safety HTTP fixture timed out")
            .expect("move-safety HTTP fixture panicked");
    }
}

async fn handle_move_safety_request(
    stream: &mut tokio::net::TcpStream,
    shared: &std::sync::Arc<Mutex<MoveSafetyState>>,
) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&bytes).into_owned();
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default().to_string();
    let path = target.split('?').next().unwrap_or_default();
    let query = target
        .split_once('?')
        .map(|(_, value)| value)
        .unwrap_or_default();
    let headers = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    shared
        .lock()
        .expect("lock move-safety fixture")
        .requests
        .push(request.clone());

    if method == "POST" && query.contains("uploads") {
        return move_safety_response(
            stream,
            "200 OK",
            "application/xml",
            b"<InitiateMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>destination.txt</Key><UploadId>move-safety-upload</UploadId></InitiateMultipartUploadResult>",
        )
        .await;
    }
    if method == "PUT" && query.contains("uploadId=") && query.contains("partNumber=") {
        shared
            .lock()
            .expect("lock move-safety fixture")
            .copy_part_requests += 1;
        return move_safety_response(
            stream,
            "200 OK",
            "application/xml",
            b"<CopyPartResult><ETag>\"copy-part-etag\"</ETag></CopyPartResult>",
        )
        .await;
    }
    if method == "POST" && query.contains("uploadId=") {
        let completion = {
            let mut state = shared.lock().expect("lock move-safety fixture");
            state.complete_attempts += 1;
            if state.mode == MoveSafetyCopyMode::AmbiguousMultipart && state.complete_attempts == 1
            {
                let mut copied = state.source.clone().expect("fixture source exists");
                copied.etag = "\"operation-copy-etag\"".to_string();
                state.destination = Some(copied);
                1
            } else if state.mode == MoveSafetyCopyMode::AmbiguousMultipart {
                state.destination = Some(MoveSafetyObject {
                    body: b"external replacement".to_vec(),
                    etag: "\"external-etag\"".to_string(),
                    content_length: b"external replacement".len() as u64,
                    version_id: None,
                });
                state.consumed_upload_seen = true;
                2
            } else {
                3
            }
        };
        return match completion {
            1 => Ok(()),
            2 => {
                // The server committed completion and dropped the response. The
                // SDK must retry; the fixture substitutes an external write
                // before responding to that retry.
                move_safety_response(
                    stream,
                    "412 Precondition Failed",
                    "application/xml",
                    b"<Error><Code>PreconditionFailed</Code><Message>Destination already exists</Message><RequestId>move-safety-e2e</RequestId></Error>",
                )
                .await
            }
            _ => {
                move_safety_error(
                    stream,
                    "501 Not Implemented",
                    "NotImplemented",
                    "ordinary copy must not use multipart completion",
                )
                .await
            }
        };
    }
    if method == "GET" && query.contains("uploadId=") {
        return move_safety_error(
            stream,
            "404 Not Found",
            "NoSuchUpload",
            "completion already consumed the upload",
        )
        .await;
    }
    if method == "GET" && query.to_ascii_lowercase().contains("versioning") {
        let (status, error) = {
            let state = shared.lock().expect("lock move-safety fixture");
            (
                state.bucket_versioning.clone(),
                state.bucket_versioning_error.clone(),
            )
        };
        if let Some(error) = error {
            return move_safety_error(stream, "403 Forbidden", "AccessDenied", &error).await;
        }
        let body = status.map_or_else(
            || "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>".to_string(),
            |status| format!("<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Status>{status}</Status></VersioningConfiguration>"),
        );
        return move_safety_response(stream, "200 OK", "application/xml", body.as_bytes()).await;
    }
    if method == "GET" && query.contains("acl") {
        return move_safety_error(
            stream,
            "501 Not Implemented",
            "NotImplemented",
            "object ACL API unavailable in fixture",
        )
        .await;
    }
    if method == "GET" && query.contains("tagging") {
        return move_safety_response(
            stream,
            "200 OK",
            "application/xml",
            b"<Tagging><TagSet/></Tagging>",
        )
        .await;
    }
    if method == "PUT" && headers.contains_key("x-amz-copy-source") {
        {
            let mut state = shared.lock().expect("lock move-safety fixture");
            let mut destination = state.source.clone().expect("fixture source exists");
            destination.etag = "\"destination-etag\"".to_string();
            destination.version_id = None;
            state.destination = Some(destination);
        }
        return move_safety_response(
            stream,
            "200 OK",
            "application/xml",
            b"<CopyObjectResult><ETag>\"destination-etag\"</ETag></CopyObjectResult>",
        )
        .await;
    }

    let object_key = path.strip_prefix("/fixture-bucket/").unwrap_or_default();
    if method == "HEAD" {
        let response_headers = {
            let state = shared.lock().expect("lock move-safety fixture");
            let object = match object_key {
                "source.txt" => state.source.as_ref(),
                "destination.txt" => state.destination.as_ref(),
                _ => None,
            };
            object.map(|object| {
                let mut headers = vec![
                    ("ETag", object.etag.clone()),
                    ("Content-Length", object.content_length.to_string()),
                    ("Last-Modified", "Tue, 01 Oct 2024 00:00:00 GMT".to_string()),
                    ("Content-Type", "text/plain".to_string()),
                ];
                if let Some(version_id) = object.version_id.as_ref() {
                    headers.push(("x-amz-version-id", version_id.clone()));
                }
                headers
            })
        };
        return match response_headers {
            Some(headers) => {
                move_safety_response_with_headers(stream, "200 OK", &headers, b"").await
            }
            None => move_safety_error(stream, "404 Not Found", "NoSuchKey", "missing object").await,
        };
    }
    if method == "DELETE" && object_key == "source.txt" {
        {
            let mut state = shared.lock().expect("lock move-safety fixture");
            state.source = None;
            state.source_delete_requests += 1;
        }
        return move_safety_response(stream, "204 No Content", "text/plain", b"").await;
    }
    if method == "GET" {
        let body = {
            let state = shared.lock().expect("lock move-safety fixture");
            match object_key {
                "source.txt" => state.source.as_ref(),
                "destination.txt" => state.destination.as_ref(),
                _ => None,
            }
            .map(|object| object.body.clone())
        };
        return match body {
            Some(body) => {
                move_safety_response(stream, "200 OK", "application/octet-stream", &body).await
            }
            None => move_safety_error(stream, "404 Not Found", "NoSuchKey", "missing object").await,
        };
    }

    eprintln!("unexpected move-safety fixture request: {request_line}");
    move_safety_error(
        stream,
        "501 Not Implemented",
        "NotImplemented",
        "unexpected request",
    )
    .await
}

async fn move_safety_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    move_safety_response_with_headers(
        stream,
        status,
        &[
            ("Content-Type", content_type.to_string()),
            ("Content-Length", body.len().to_string()),
        ],
        body,
    )
    .await
}

async fn move_safety_response_with_headers(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.as_str())
        .unwrap_or("0");
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nConnection: close\r\n"
            )
            .as_bytes(),
        )
        .await?;
    for (name, value) in headers {
        if !name.eq_ignore_ascii_case("content-length") {
            stream
                .write_all(format!("{name}: {value}\r\n").as_bytes())
                .await?;
        }
    }
    stream.write_all(b"\r\n").await?;
    stream.write_all(body).await?;
    stream.flush().await
}

async fn move_safety_error(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    code: &str,
    message: &str,
) -> std::io::Result<()> {
    let body = format!("<Error><Code>{code}</Code><Message>{message}</Message><RequestId>move-safety-e2e</RequestId></Error>");
    move_safety_response(stream, status, "application/xml", body.as_bytes()).await
}

fn record_move_safety(check: &str, passed: bool, observed: serde_json::Value) {
    if let Ok(path) = std::env::var("S3_SIDEKICK_E2E_REPORT") {
        use std::io::Write;
        let row = serde_json::json!({
            "test": "move_safety_http_fixture",
            "check": check,
            "passed": passed,
            "observed": observed,
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open move-safety E2E report");
        writeln!(file, "{row}").expect("write move-safety E2E report");
    }
    eprintln!("{} {check}", if passed { "PASS" } else { "FAIL" });
}

#[tokio::test]
#[ignore = "needs the local HTTP E2E runner (node scripts/e2e-move-safety.mjs)"]
async fn e2e_move_safety_receipts_http_fixture() {
    let source_size = 5_368_709_120_u64 + 1;

    let ambiguous = MoveSafetyHttpFixture::start(
        MoveSafetyCopyMode::AmbiguousMultipart,
        None,
        None,
        None,
        source_size,
    )
    .await;
    let ambiguous_client = ambiguous.client();
    let cancel: s3::CancelToken = Default::default();
    let ambiguous_copy = s3::e2e_copy_with_receipt(
        &ambiguous_client,
        "fixture-bucket",
        "source.txt",
        "destination.txt",
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let receipt_fingerprint = "a".repeat(64);
    let constructed_receipt_json = serde_json::json!({
        "source_key": "source.txt",
        "source_etag": "\"source-etag\"",
        "source_fingerprint": receipt_fingerprint,
        "source_acl_fingerprint": "b".repeat(64),
        "source_tag_fingerprint": "c".repeat(64),
        "source_version_id": null,
        "destination_key": "destination.txt",
        "destination_etag": "\"external-etag\"",
        "destination_fingerprint": "d".repeat(64),
        "destination_acl_fingerprint": "e".repeat(64),
        "destination_tag_fingerprint": "f".repeat(64),
        "destination_version_id": null,
        "ownership_ambiguous": true,
    });
    let constructed_receipt: s3::CopyReceipt =
        serde_json::from_value(constructed_receipt_json).expect("restore ambiguous receipt");
    let serialized_ambiguous_receipt =
        serde_json::to_value(&constructed_receipt).expect("serialize ambiguous receipt");
    let ambiguous_receipt =
        serde_json::from_value::<s3::CopyReceipt>(serialized_ambiguous_receipt.clone())
            .expect("restore ambiguous receipt after persisted JSON round trip");
    let ambiguous_delete = s3::e2e_delete_move_receipts_checked(
        &ambiguous_client,
        "fixture-bucket",
        "fixture-bucket",
        std::slice::from_ref(&ambiguous_receipt),
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let mut legacy_receipt_json = serialized_ambiguous_receipt.clone();
    legacy_receipt_json
        .as_object_mut()
        .expect("receipt serializes as an object")
        .remove("ownership_ambiguous");
    let legacy_receipt = serde_json::from_value::<s3::CopyReceipt>(legacy_receipt_json.clone())
        .expect("restore legacy receipt without ownership proof");
    let legacy_delete = s3::e2e_delete_move_receipts_checked(
        &ambiguous_client,
        "fixture-bucket",
        "fixture-bucket",
        std::slice::from_ref(&legacy_receipt),
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let ambiguous_source = read(&ambiguous_client, "fixture-bucket", "source.txt").await;
    let ambiguous_destination = read(&ambiguous_client, "fixture-bucket", "destination.txt").await;
    let ambiguous_snapshot = ambiguous.snapshot();
    let ambiguous_safe = ambiguous_copy
        .as_ref()
        .err()
        .is_some_and(|err| err.to_ascii_lowercase().contains("ambiguous"))
        && serialized_ambiguous_receipt["ownership_ambiguous"] == true
        && ambiguous_delete
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("ambiguous"))
        && legacy_delete
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("ambiguous"))
        && ambiguous_source.as_deref() == Some("source bytes")
        && ambiguous_destination.as_deref() == Some("external replacement")
        && ambiguous_snapshot["complete_attempts"] == 2
        && ambiguous_snapshot["consumed_upload_seen"] == true
        && ambiguous_snapshot["source_delete_requests"] == 0;
    record_move_safety(
        "ambiguous multipart recovery survives JSON receipt round trip and cannot delete the source",
        ambiguous_safe,
        serde_json::json!({
            "copy_error": format!("{:?}", ambiguous_copy),
            "serialized_ambiguous_receipt": serialized_ambiguous_receipt,
            "delete": format!("{:?}", ambiguous_delete),
            "legacy_receipt_without_ownership_claim": legacy_receipt_json,
            "legacy_delete": format!("{:?}", legacy_delete),
            "source_after": ambiguous_source,
            "destination_after": ambiguous_destination,
            "fixture": ambiguous_snapshot,
        }),
    );
    ambiguous.finish().await;

    let null_version = MoveSafetyHttpFixture::start(
        MoveSafetyCopyMode::Ordinary,
        Some("null"),
        Some("Suspended"),
        None,
        b"source bytes".len() as u64,
    )
    .await;
    let null_client = null_version.client();
    let null_copy = s3::e2e_copy_with_receipt(
        &null_client,
        "fixture-bucket",
        "source.txt",
        "destination.txt",
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let mut downgraded_json = null_copy
        .as_ref()
        .ok()
        .map(|receipt| serde_json::to_value(receipt).expect("serialize null-version copy receipt"));
    if let Some(receipt) = downgraded_json.as_mut() {
        receipt["source_version_id"] = serde_json::Value::Null;
    }
    let downgraded_receipt = downgraded_json
        .clone()
        .map(serde_json::from_value::<s3::CopyReceipt>)
        .transpose()
        .expect("restore downgraded persisted receipt");
    let null_delete = match downgraded_receipt {
        Some(receipt) => {
            s3::e2e_delete_move_receipts_checked(
                &null_client,
                "fixture-bucket",
                "fixture-bucket",
                std::slice::from_ref(&receipt),
                StorageProviderKind::Aws,
                &cancel,
            )
            .await
        }
        None => Err("ordinary copy did not return a receipt".to_string()),
    };
    let null_source = read(&null_client, "fixture-bucket", "source.txt").await;
    let null_destination = read(&null_client, "fixture-bucket", "destination.txt").await;
    let null_snapshot = null_version.snapshot();
    let null_safe = null_copy.is_ok()
        && null_delete
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("mutable null version"))
        && null_source.as_deref() == Some("source bytes")
        && null_destination.as_deref() == Some("source bytes")
        && null_snapshot["source_delete_requests"] == 0;
    record_move_safety(
        "JSON-null source version claim cannot retire a live suspended-bucket null version",
        null_safe,
        serde_json::json!({
            "copy": format!("{:?}", null_copy),
            "persisted_receipt": downgraded_json,
            "delete": format!("{:?}", null_delete),
            "source_after": null_source,
            "destination_after": null_destination,
            "fixture": null_snapshot,
        }),
    );
    null_version.finish().await;

    let omitted_version = MoveSafetyHttpFixture::start(
        MoveSafetyCopyMode::Ordinary,
        None,
        Some("Suspended"),
        None,
        b"source bytes".len() as u64,
    )
    .await;
    let omitted_client = omitted_version.client();
    let omitted_copy = s3::e2e_copy_with_receipt(
        &omitted_client,
        "fixture-bucket",
        "source.txt",
        "destination.txt",
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let omitted_receipt = omitted_copy
        .as_ref()
        .ok()
        .map(serde_json::to_value)
        .transpose()
        .expect("serialize omitted-version copy receipt")
        .map(serde_json::from_value::<s3::CopyReceipt>)
        .transpose()
        .expect("restore omitted-version receipt");
    let omitted_delete = match omitted_receipt {
        Some(receipt) => {
            s3::e2e_delete_move_receipts_checked(
                &omitted_client,
                "fixture-bucket",
                "fixture-bucket",
                std::slice::from_ref(&receipt),
                StorageProviderKind::Aws,
                &cancel,
            )
            .await
        }
        None => Err("ordinary copy did not return a receipt".to_string()),
    };
    let omitted_source = read(&omitted_client, "fixture-bucket", "source.txt").await;
    let omitted_destination = read(&omitted_client, "fixture-bucket", "destination.txt").await;
    let omitted_snapshot = omitted_version.snapshot();
    let versioning_probe_seen = omitted_snapshot["requests"]
        .as_array()
        .is_some_and(|requests| {
            requests.iter().any(|request| {
                request.as_str().is_some_and(|line| {
                    line.starts_with("GET /fixture-bucket/?")
                        && line.to_ascii_lowercase().contains("versioning")
                })
            })
        });
    let omitted_safe = omitted_copy.is_ok()
        && omitted_delete
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("versioned bucket"))
        && omitted_source.as_deref() == Some("source bytes")
        && omitted_destination.as_deref() == Some("source bytes")
        && omitted_snapshot["source_delete_requests"] == 0
        && versioning_probe_seen;
    record_move_safety(
        "missing HEAD version header triggers a live bucket-versioning check and refuses suspended-bucket deletion",
        omitted_safe,
        serde_json::json!({
            "copy": format!("{:?}", omitted_copy),
            "delete": format!("{:?}", omitted_delete),
            "source_after": omitted_source,
            "destination_after": omitted_destination,
            "versioning_probe_seen": versioning_probe_seen,
            "fixture": omitted_snapshot,
        }),
    );
    omitted_version.finish().await;

    let denied_versioning = MoveSafetyHttpFixture::start(
        MoveSafetyCopyMode::Ordinary,
        None,
        None,
        Some("fixture denies s3:GetBucketVersioning"),
        b"source bytes".len() as u64,
    )
    .await;
    let denied_client = denied_versioning.client();
    let denied_copy = s3::e2e_copy_with_receipt(
        &denied_client,
        "fixture-bucket",
        "source.txt",
        "destination.txt",
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let denied_receipt = denied_copy
        .as_ref()
        .ok()
        .map(|receipt| serde_json::to_value(receipt).expect("serialize denied-permission receipt"))
        .map(serde_json::from_value::<s3::CopyReceipt>)
        .transpose()
        .expect("restore denied-permission receipt");
    let denied_delete = match denied_receipt {
        Some(receipt) => {
            s3::e2e_delete_move_receipts_checked(
                &denied_client,
                "fixture-bucket",
                "fixture-bucket",
                std::slice::from_ref(&receipt),
                StorageProviderKind::Aws,
                &cancel,
            )
            .await
        }
        None => Err("ordinary copy did not return a receipt".to_string()),
    };
    let denied_source = read(&denied_client, "fixture-bucket", "source.txt").await;
    let denied_destination = read(&denied_client, "fixture-bucket", "destination.txt").await;
    let denied_snapshot = denied_versioning.snapshot();
    let denied_lookup_seen = denied_snapshot["requests"]
        .as_array()
        .is_some_and(|requests| {
            requests.iter().any(|request| {
                request.as_str().is_some_and(|line| {
                    line.starts_with("GET /fixture-bucket/?")
                        && line.to_ascii_lowercase().contains("versioning")
                })
            })
        });
    let denied_safe = denied_copy.is_ok()
        && denied_delete.as_ref().err().is_some_and(|err| {
            err.contains("s3:GetBucketVersioning")
                && err.contains("source deletion was refused")
                && err.contains("source was retained")
        })
        && denied_source.as_deref() == Some("source bytes")
        && denied_destination.as_deref() == Some("source bytes")
        && denied_snapshot["source_delete_requests"] == 0
        && denied_lookup_seen;
    record_move_safety(
        "denied bucket-versioning lookup names the needed permission and refuses source deletion",
        denied_safe,
        serde_json::json!({
            "copy": format!("{:?}", denied_copy),
            "delete": format!("{:?}", denied_delete),
            "source_after": denied_source,
            "destination_after": denied_destination,
            "versioning_lookup_seen": denied_lookup_seen,
            "fixture": denied_snapshot,
        }),
    );
    denied_versioning.finish().await;

    let ordinary = MoveSafetyHttpFixture::start(
        MoveSafetyCopyMode::Ordinary,
        None,
        None,
        None,
        b"source bytes".len() as u64,
    )
    .await;
    let ordinary_client = ordinary.client();
    let ordinary_copy = s3::e2e_copy_with_receipt(
        &ordinary_client,
        "fixture-bucket",
        "source.txt",
        "destination.txt",
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let ordinary_receipt = ordinary_copy
        .as_ref()
        .ok()
        .map(|receipt| serde_json::to_value(receipt).expect("serialize ordinary copy receipt"))
        .map(serde_json::from_value::<s3::CopyReceipt>)
        .transpose()
        .expect("restore ordinary persisted receipt");
    let ordinary_delete = match ordinary_receipt {
        Some(receipt) => {
            s3::e2e_delete_move_receipts_checked(
                &ordinary_client,
                "fixture-bucket",
                "fixture-bucket",
                std::slice::from_ref(&receipt),
                StorageProviderKind::Aws,
                &cancel,
            )
            .await
        }
        None => Err("ordinary copy did not return a receipt".to_string()),
    };
    let ordinary_source = read(&ordinary_client, "fixture-bucket", "source.txt").await;
    let ordinary_destination = read(&ordinary_client, "fixture-bucket", "destination.txt").await;
    let ordinary_snapshot = ordinary.snapshot();
    let ordinary_safe = ordinary_copy.is_ok()
        && ordinary_delete.as_ref().is_ok_and(|deleted| *deleted == 1)
        && ordinary_source.is_none()
        && ordinary_destination.as_deref() == Some("source bytes")
        && ordinary_snapshot["source_delete_requests"] == 1;
    record_move_safety(
        "normal unversioned copy receipt still permits a matching move and retains the copied destination",
        ordinary_safe,
        serde_json::json!({
            "copy": format!("{:?}", ordinary_copy),
            "delete": format!("{:?}", ordinary_delete),
            "source_after": ordinary_source,
            "destination_after": ordinary_destination,
            "fixture": ordinary_snapshot,
        }),
    );
    ordinary.finish().await;
    assert!(
        ambiguous_safe && null_safe && omitted_safe && denied_safe && ordinary_safe,
        "move-safety E2E failed; inspect the JSON report for each independent scenario"
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_unversioned_move_preflights_every_source_before_first_delete() {
    let test = "unversioned_source_set_preflight";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "source-set").await;
    put(&raw, &bucket, "src/a.txt", "source A").await;
    put(&raw, &bucket, "src/b.txt", "source B").await;
    let app = make_app();
    let session = connect(&app, &env.endpoint_minio, &env).await;
    let mut receipts = Vec::new();
    for key in ["src/a.txt", "src/b.txt"] {
        receipts.push(
            s3::copy_object_to(
                app.state::<AppState>(),
                session.connection_id.clone(),
                bucket.clone(),
                key.to_string(),
                bucket.clone(),
                key.replace("src/", "dst/"),
                Some(true),
                None,
                Some(false),
                Some(false),
            )
            .await
            .expect("seed move copy receipt"),
        );
    }
    put(&raw, &bucket, "src/b.txt", "external replacement B").await;
    let cancel: s3::CancelToken = Default::default();
    // This test-only provider override reaches the AWS-supported unversioned
    // classification path, but the changed B is detected before any DELETE.
    let result = s3::e2e_delete_move_receipts_checked(
        &raw,
        &bucket,
        &bucket,
        &receipts,
        StorageProviderKind::Aws,
        &cancel,
    )
    .await;
    let source_a = read(&raw, &bucket, "src/a.txt").await;
    let source_b = read(&raw, &bucket, "src/b.txt").await;
    record(
        test,
        "a conflict already present on later source B prevents deletion of source A",
        result
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("src/b.txt"))
            && source_a.as_deref() == Some("source A")
            && source_b.as_deref() == Some("external replacement B"),
        serde_json::json!({"result": format!("{:?}", result), "source_a": source_a, "source_b": source_b}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_unversioned_prefix_overwrite_refuses_before_mutation_without_conditional_delete() {
    let test = "prefix_failure_safe_rollback";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "prefix-rollback").await;
    put(&raw, &bucket, "src/a.txt", "new A").await;
    put(&raw, &bucket, "src/b.txt", "source B").await;
    put(&raw, &bucket, "dst/a.txt", "external original A").await;
    put(&raw, &bucket, "dst/b.txt", "external original B").await;
    let cancel: s3::CancelToken = Default::default();
    let result = s3::e2e_copy_prefix_with_failure_after_first(
        &raw,
        &bucket,
        &cancel,
        StorageProviderKind::Minio,
    )
    .await;
    let destination_a = read(&raw, &bucket, "dst/a.txt").await;
    let destination_b = read(&raw, &bucket, "dst/b.txt").await;
    let backups = raw
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(".s3-sidekick-rollback/")
        .send()
        .await
        .expect("list rollback backups")
        .contents()
        .iter()
        .filter_map(|object| object.key().map(str::to_string))
        .collect::<Vec<_>>();
    record(
        test,
        "unversioned overwrite prefix refuses before any destination or backup mutation when conditional DELETE is unsupported",
        result
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("versioned bucket"))
            && destination_a.as_deref() == Some("external original A")
            && destination_b.as_deref() == Some("external original B")
            && backups.is_empty()
            && read(&raw, &bucket, "src/a.txt").await.as_deref() == Some("new A")
            && read(&raw, &bucket, "src/b.txt").await.as_deref() == Some("source B"),
        serde_json::json!({"result": format!("{:?}", result), "destination_a": destination_a, "destination_b": destination_b, "backup_keys": backups}),
    );
}

#[tokio::test]
#[ignore = "needs the MinIO E2E runner (npm run test:e2e:minio)"]
async fn e2e_versioned_prefix_overwrite_rolls_back_with_exact_version_authority() {
    let test = "versioned_prefix_exact_version_rollback";
    let env = env();
    let raw = raw_client(&env.endpoint_minio, &env);
    let bucket = fresh_bucket(&raw, "versioned-prefix-rollback").await;
    raw.put_bucket_versioning()
        .bucket(&bucket)
        .versioning_configuration(
            aws_sdk_s3::types::VersioningConfiguration::builder()
                .status(aws_sdk_s3::types::BucketVersioningStatus::Enabled)
                .build(),
        )
        .send()
        .await
        .expect("enable versioning for exact-version rollback");
    put(&raw, &bucket, "src/a.txt", "new A").await;
    put(&raw, &bucket, "src/b.txt", "source B").await;
    put(&raw, &bucket, "dst/a.txt", "external original A").await;
    put(&raw, &bucket, "dst/b.txt", "external original B").await;
    let cancel: s3::CancelToken = Default::default();
    let result = s3::e2e_copy_prefix_with_failure_after_first(
        &raw,
        &bucket,
        &cancel,
        StorageProviderKind::Minio,
    )
    .await;
    let destination_a = read(&raw, &bucket, "dst/a.txt").await;
    let destination_b = read(&raw, &bucket, "dst/b.txt").await;
    let backups = raw
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(".s3-sidekick-rollback/")
        .send()
        .await
        .expect("list rollback backup keys")
        .contents()
        .iter()
        .filter_map(|object| object.key().map(str::to_string))
        .collect::<Vec<_>>();
    record(
        test,
        "a later source failure restores both originals and removes operation-owned backup versions",
        result
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("src/b.txt"))
            && destination_a.as_deref() == Some("external original A")
            && destination_b.as_deref() == Some("external original B")
            && backups.is_empty()
            && read(&raw, &bucket, "src/a.txt").await.as_deref() == Some("new A"),
        serde_json::json!({"result": format!("{:?}", result), "destination_a": destination_a, "destination_b": destination_b, "backup_keys": backups}),
    );
}
