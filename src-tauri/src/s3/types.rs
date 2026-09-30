//! Serialized response types shared with the webview.

use super::*;

#[derive(serde::Serialize)]
pub(crate) struct BucketInfo {
    pub(super) name: String,
    pub(super) creation_date: String,
}

#[derive(serde::Serialize)]
pub(crate) struct ObjectInfo {
    pub(super) key: String,
    pub(super) size: i64,
    pub(super) last_modified: String,
    pub(super) is_folder: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct ListObjectsResponse {
    pub(super) objects: Vec<ObjectInfo>,
    pub(super) prefixes: Vec<String>,
    pub(super) truncated: bool,
    pub(super) next_continuation_token: String,
}

#[derive(serde::Serialize)]
pub(crate) struct HeadObjectResponse {
    pub(super) content_type: String,
    pub(super) content_length: i64,
    pub(super) last_modified: String,
    pub(super) etag: String,
    pub(super) storage_class: String,
    pub(super) cache_control: String,
    pub(super) content_disposition: String,
    pub(super) content_encoding: String,
    pub(super) server_side_encryption: String,
    pub(super) metadata: HashMap<String, String>,
}

#[derive(serde::Serialize)]
pub(crate) struct AclGrant {
    pub(super) grantee: String,
    pub(super) permission: String,
}

#[derive(serde::Serialize)]
pub(crate) struct AclResponse {
    pub(super) owner: String,
    pub(super) grants: Vec<AclGrant>,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct UploadProgress {
    pub(super) transfer_id: u32,
    pub(super) bytes_sent: u64,
    pub(super) total_bytes: u64,
    pub(super) attempt: u32,
    pub(super) phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) speed_bps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) completed_parts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) total_parts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) checkpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) resumable: Option<bool>,
}

pub(super) fn encode_copy_source_with_version(
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> String {
    let source = encode_copy_source(bucket, key);
    match version_id {
        Some(version) if !version.is_empty() => {
            format!("{}?versionId={}", source, urlencoding::encode(version))
        }
        _ => source,
    }
}
