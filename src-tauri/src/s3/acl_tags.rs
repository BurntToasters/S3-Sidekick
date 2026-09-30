//! ACL and tag fingerprints that bind copy receipts.

use super::*;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct CanonicalAclGrant {
    pub(super) permission: String,
    pub(super) grantee_type: String,
    pub(super) grantee_id: String,
    pub(super) grantee_uri: String,
    pub(super) grantee_email: String,
}

pub(super) struct SourceAclState {
    pub(super) canned_acl: Option<ObjectCannedAcl>,
    pub(super) fingerprint: String,
}

pub(super) struct SourceTagState {
    pub(super) encoded: Option<String>,
    pub(super) fingerprint: String,
}

pub(super) fn unsupported_attribute_fingerprint(attribute: &'static str) -> String {
    hash_generation_fields(vec![
        ("attribute", attribute.to_string()),
        ("support", "unsupported".to_string()),
    ])
}

pub(super) fn canonical_acl_fingerprint(owner_id: &str, grants: &[CanonicalAclGrant]) -> String {
    let mut fields = vec![
        ("attribute", "acl".to_string()),
        ("support", "supported".to_string()),
        ("owner_id", owner_id.to_string()),
    ];
    let mut grants = grants.to_vec();
    grants.sort();
    for grant in grants {
        fields.extend([
            ("grant_permission", grant.permission),
            ("grant_grantee_type", grant.grantee_type),
            ("grant_grantee_id", grant.grantee_id),
            ("grant_grantee_uri", grant.grantee_uri),
            ("grant_grantee_email", grant.grantee_email),
        ]);
    }
    hash_generation_fields(fields)
}

pub(super) fn canonical_tag_fingerprint(tags: &[(String, String)]) -> String {
    let mut fields = vec![
        ("attribute", "tags".to_string()),
        ("support", "supported".to_string()),
    ];
    let mut tags = tags.to_vec();
    tags.sort();
    for (key, value) in tags {
        fields.extend([("tag_key", key), ("tag_value", value)]);
    }
    hash_generation_fields(fields)
}

pub(super) async fn get_object_acl_output(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<Option<aws_sdk_s3::operation::get_object_acl::GetObjectAclOutput>, String> {
    let mut request = client.get_object_acl().bucket(bucket).key(key);
    if let Some(version_id) = version_id {
        request = request.version_id(version_id);
    }
    match request.send().await {
        // MinIO (and other providers without object ACLs) answer with a stub
        // policy whose owner has no ID. There is no ACL identity to confirm or
        // carry, which is the same as a provider rejecting the call; treating
        // it as a hard error made every prefix copy, move and rename fail.
        Ok(output)
            if output
                .owner()
                .and_then(|owner| owner.id())
                .is_none_or(|id| id.is_empty()) =>
        {
            Ok(None)
        }
        Ok(output) => Ok(Some(output)),
        Err(err) => {
            let message = format!("{:?}", err);
            if acls_are_unavailable(&message) {
                return Ok(None);
            }
            Err(format!(
                "Failed to read the ACL for '{}'; refusing to continue without confirmed ACL \
                 identity. This operation needs the 's3:GetObjectAcl' permission: {}",
                key, err
            ))
        }
    }
}

pub(super) fn acl_fingerprint_from_output(
    output: Option<&aws_sdk_s3::operation::get_object_acl::GetObjectAclOutput>,
    key: &str,
) -> Result<String, String> {
    let Some(output) = output else {
        return Ok(unsupported_attribute_fingerprint("acl"));
    };
    let owner_id = output
        .owner()
        .and_then(|owner| owner.id())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("Object '{}' ACL has no owner identity", key))?;
    let grants = output
        .grants()
        .iter()
        .map(|grant| {
            let grantee = grant.grantee();
            CanonicalAclGrant {
                permission: grant
                    .permission()
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default(),
                grantee_type: grantee
                    .map(|value| value.r#type().as_str().to_string())
                    .unwrap_or_default(),
                grantee_id: grantee
                    .and_then(|value| value.id())
                    .unwrap_or_default()
                    .to_string(),
                grantee_uri: grantee
                    .and_then(|value| value.uri())
                    .unwrap_or_default()
                    .to_string(),
                grantee_email: grantee
                    .and_then(|value| value.email_address())
                    .unwrap_or_default()
                    .to_string(),
            }
        })
        .collect::<Vec<_>>();
    Ok(canonical_acl_fingerprint(owner_id, &grants))
}

pub(super) fn infer_canned_acl_from_output(
    output: &aws_sdk_s3::operation::get_object_acl::GetObjectAclOutput,
    key: &str,
) -> Result<ObjectCannedAcl, String> {
    let owner_id = output
        .owner()
        .and_then(|owner| owner.id())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("Object '{}' ACL has no owner identity", key))?;
    let mut owner_full_control = 0u8;
    let mut public_read = 0u8;
    let mut public_write = 0u8;
    let mut authenticated_read = 0u8;

    for grant in output.grants() {
        let permission = grant
            .permission()
            .map(|value| value.as_str())
            .unwrap_or_default();
        let grantee = grant.grantee();
        let uri = grantee
            .and_then(|value| value.uri())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let grantee_id = grantee.and_then(|value| value.id()).unwrap_or_default();

        if grantee_id == owner_id && permission.eq_ignore_ascii_case("FULL_CONTROL") {
            owner_full_control = owner_full_control.saturating_add(1);
            continue;
        }
        if uri.ends_with("/allusers") && permission.eq_ignore_ascii_case("READ") {
            public_read = public_read.saturating_add(1);
            continue;
        }
        if uri.ends_with("/allusers") && permission.eq_ignore_ascii_case("WRITE") {
            public_write = public_write.saturating_add(1);
            continue;
        }
        if uri.ends_with("/authenticatedusers") && permission.eq_ignore_ascii_case("READ") {
            authenticated_read = authenticated_read.saturating_add(1);
            continue;
        }

        return Err(format!(
            "Object '{}' uses a custom ACL that cannot be represented safely during copy",
            key
        ));
    }

    if owner_full_control != 1 {
        return Err(format!(
            "Object '{}' ACL does not contain exactly one owner FULL_CONTROL grant",
            key
        ));
    }

    match (public_read, public_write, authenticated_read) {
        (0, 0, 0) => Ok(ObjectCannedAcl::Private),
        (1, 0, 0) => Ok(ObjectCannedAcl::PublicRead),
        (1, 1, 0) => Ok(ObjectCannedAcl::PublicReadWrite),
        (0, 0, 1) => Ok(ObjectCannedAcl::AuthenticatedRead),
        _ => Err(format!(
            "Object '{}' ACL grant combination does not exactly match a supported canned ACL",
            key
        )),
    }
}

pub(super) async fn source_acl_state_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<SourceAclState, String> {
    let output = get_object_acl_output(client, bucket, key, version_id).await?;
    let fingerprint = acl_fingerprint_from_output(output.as_ref(), key)?;
    let canned_acl = output
        .as_ref()
        .map(|output| infer_canned_acl_from_output(output, key))
        .transpose()?;
    Ok(SourceAclState {
        canned_acl,
        fingerprint,
    })
}

pub(super) async fn acl_fingerprint_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<String, String> {
    let output = get_object_acl_output(client, bucket, key, version_id).await?;
    acl_fingerprint_from_output(output.as_ref(), key)
}

pub(super) async fn source_tag_state_for_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<SourceTagState, String> {
    let mut request = client.get_object_tagging().bucket(bucket).key(key);
    if let Some(version_id) = version_id {
        request = request.version_id(version_id);
    }
    let output = match request.send().await {
        Ok(output) => output,
        Err(err) => {
            // A provider that never implemented object tagging has no tag state
            // to preserve. Keep that state distinct from a supported empty set.
            if feature_is_unimplemented(&format!("{:?}", err)) {
                return Ok(SourceTagState {
                    encoded: None,
                    fingerprint: unsupported_attribute_fingerprint("tags"),
                });
            }
            return Err(format!(
                "Failed to read tags for '{}'; refusing to continue without confirmed tag \
                 identity. This operation needs the 's3:GetObjectTagging' permission: {}",
                key, err
            ));
        }
    };

    let mut tags = output
        .tag_set()
        .iter()
        .map(|tag| (tag.key().to_string(), tag.value().to_string()))
        .collect::<Vec<_>>();
    tags.sort();
    let fingerprint = canonical_tag_fingerprint(&tags);
    let encoded = (!tags.is_empty()).then(|| {
        tags.iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    urlencoding::encode(key),
                    urlencoding::encode(value)
                )
            })
            .collect::<Vec<_>>()
            .join("&")
    });
    Ok(SourceTagState {
        encoded,
        fingerprint,
    })
}
