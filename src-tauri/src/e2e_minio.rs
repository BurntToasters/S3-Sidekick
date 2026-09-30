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
// - Provider claim alone is wrong: verify capabilities and resulting behavior.
// - Tests share state: give every test its own bucket and connection.
// - Skipped assertion looks like pass: record every check and reject empty sets.
// - Pre-registration cancel still commits: confirm error and object absence.

use std::sync::Mutex;

use aws_sdk_s3::primitives::ByteStream;
use tauri::Manager;

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

async fn connect(
    app: &tauri::App<tauri::test::MockRuntime>,
    endpoint: &str,
    env: &Env,
) -> s3::ConnectResult {
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
        "localhost:9000 is MinIO: create-only PUT and copy, no multipart completion",
        minio_caps
            == serde_json::json!({"put_object": true, "complete_multipart": false, "copy_object": true}),
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
        Some(false),
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
        "generic rename_prefix refuses create-only and leaves the source intact",
        rename_refused
            .as_ref()
            .err()
            .is_some_and(|err| err.contains("cannot enforce a create-only"))
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
    let old_gone = read(&raw, &bucket, "old/file.txt").await.is_none();
    record(
        test,
        "authorized rename_prefix moves the folder",
        renamed.is_ok() && moved.as_deref() == Some("rename-me") && old_gone,
        serde_json::json!({"result": format!("{:?}", renamed), "moved": moved, "old_gone": old_gone}),
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
