//! Endpoint parsing, region inference and listing key decoding.

#[derive(serde::Serialize)]
pub(crate) struct PreviewResponse {
    pub(super) content_type: String,
    pub(super) data: String,
    pub(super) is_text: bool,
    pub(super) truncated: bool,
    pub(super) total_size: i64,
}

pub(super) fn is_text_content_type(ct: &str) -> bool {
    let media_type = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media_type.starts_with("text/")
        || media_type == "application/json"
        || media_type == "application/xml"
        || media_type == "application/javascript"
        || media_type == "image/svg+xml"
        || media_type == "application/x-yaml"
        || media_type == "application/toml"
}

pub(super) fn encode_copy_source(bucket: &str, key: &str) -> String {
    let encoded_bucket = urlencoding::encode(bucket);
    let encoded_key = if super::key_has_unsafe_url_segments(key) {
        // `bucket/key` is a path. Leaving a `..` segment or a `//` empty
        // segment raw lets an endpoint or proxy normalize it into a different
        // key. Encode the whole key, including its separators, so the server
        // decodes exactly the literal key and never sees a dot/empty path
        // segment. Ordinary keys keep readable slash separators.
        encode_copy_source_key_strict(key)
    } else {
        key.split('/')
            .map(|segment| urlencoding::encode(segment).to_string())
            .collect::<Vec<_>>()
            .join("/")
    };
    format!("{}/{}", encoded_bucket, encoded_key)
}

fn encode_copy_source_key_strict(key: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(key.len() * 3);
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

pub(super) fn parse_endpoint_host(endpoint: &str) -> Option<String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return None;
    }

    let after_scheme = match trimmed.split_once("://") {
        Some((_, rest)) => rest,
        None => trimmed,
    };
    let authority = after_scheme.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }

    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    // Bracketed IPv6 literals (`http://[::1]:9000`) are valid endpoint hosts;
    // strip the brackets instead of refusing to parse them.
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    }
    .trim()
    .trim_end_matches('.');
    if host.is_empty() {
        return None;
    }

    Some(host.to_ascii_lowercase())
}

pub(super) fn is_region_like_label(label: &str) -> bool {
    let parts: Vec<&str> = label.split('-').collect();
    if parts.len() < 3 || parts.iter().any(|p| p.is_empty()) {
        return false;
    }
    if parts[0].len() != 2 || !parts[0].chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    if !parts
        .last()
        .map(|p| p.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
    {
        return false;
    }
    parts[1..parts.len() - 1].iter().all(|segment| {
        segment
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

pub(super) fn infer_region_from_host(host: &str) -> Option<String> {
    if host == "s3.amazonaws.com" || host.ends_with(".s3.amazonaws.com") {
        return Some("us-east-1".to_string());
    }

    let do_suffix = ".digitaloceanspaces.com";
    if host.ends_with(do_suffix) {
        let prefix = host.trim_end_matches(do_suffix).trim_end_matches('.');
        if !prefix.is_empty() {
            return prefix.rsplit('.').next().map(|s| s.to_string());
        }
    }

    for label in host.split('.') {
        if is_region_like_label(label) {
            return Some(label.to_string());
        }
    }

    None
}

pub(super) fn resolve_region(endpoint: &str, region: &str) -> Result<String, String> {
    let provided = region.trim();
    if !provided.is_empty() {
        return Ok(provided.to_string());
    }

    let host = parse_endpoint_host(endpoint).ok_or_else(|| {
        "Region is required when endpoint host cannot be parsed. Enter region (for example: nyc3 or us-east-1)."
            .to_string()
    })?;

    infer_region_from_host(&host).ok_or_else(|| {
        "Region is required for this endpoint. Enter region manually (for example: nyc3 or us-east-1)."
            .to_string()
    })
}

/// Strip a virtual-hosted bucket label from a known AWS S3 host.
///
/// Accepts `<bucket>.s3.amazonaws.com`, `<bucket>.s3.<region>.amazonaws.com`,
/// `<bucket>.s3-<region>.amazonaws.com` and the dualstack forms, returning the
/// service endpoint and extracted bucket. Foreign hosts are left untouched:
/// stripping a label there would corrupt legitimate hostnames.
pub(super) fn strip_aws_virtual_host(host: &str) -> Option<(String, String)> {
    let suffix = [".amazonaws.com", ".amazonaws.com.cn"]
        .into_iter()
        .find(|suffix| host.ends_with(suffix))?;
    let labels: Vec<&str> = host.trim_end_matches(suffix).split('.').collect();
    let s3_index = labels
        .iter()
        .position(|label| *label == "s3" || label.starts_with("s3-"))?;
    // Only a single leading bucket label is a virtual-hosted address; an `s3`
    // label at position 0 means this is already the service endpoint.
    if s3_index != 1 {
        return None;
    }
    let bucket = labels[0].to_string();
    if bucket.is_empty() {
        return None;
    }
    Some((format!("{}{}", labels[1..].join("."), suffix), bucket))
}

/// Hostnames that resolve to a cloud instance metadata service. These are
/// never valid S3 endpoints, and following them would let a saved connection
/// reach credentials inside the user's cloud account.
const BLOCKED_METADATA_HOSTS: &[&str] = &[
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.azure.com",
];

fn is_blocked_metadata_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    BLOCKED_METADATA_HOSTS.iter().any(|blocked| {
        host == *blocked
            || host
                .strip_suffix(blocked)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

/// Describe why an IP literal is unsafe as an S3 endpoint host. Loopback and
/// private LAN ranges stay allowed because MinIO and local gateways use them.
fn blocked_ip_kind(ip: std::net::IpAddr) -> Option<&'static str> {
    match ip {
        std::net::IpAddr::V4(v4) => {
            if v4.is_link_local() {
                Some("IPv4 link-local")
            } else if v4.is_unspecified() {
                Some("unspecified")
            } else if v4.is_broadcast() {
                Some("broadcast")
            } else if v4.is_multicast() {
                Some("IPv4 multicast")
            } else {
                None
            }
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_unspecified() {
                Some("unspecified")
            } else if v6.is_multicast() {
                Some("IPv6 multicast")
            } else if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                Some("IPv6 link-local")
            } else {
                // Also catch IPv4-mapped/compatible forms such as
                // `::ffff:169.254.169.254`, which embed a blocked v4 address.
                v6.to_ipv4()
                    .and_then(|v4| blocked_ip_kind(std::net::IpAddr::V4(v4)))
            }
        }
    }
}

fn validate_endpoint_host(host: &str, endpoint: &str) -> Result<(), String> {
    let unbracketed = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host)
        .trim_end_matches('.');
    if is_blocked_metadata_host(unbracketed) {
        return Err(format!(
            "Endpoint '{endpoint}' uses a cloud metadata host, which is not allowed."
        ));
    }
    // A scoped IPv6 literal carries a zone identifier (`fe80::1%25eth0` in a
    // URL); drop it so the address is still classified as link-local.
    let ip_literal = unbracketed.split('%').next().unwrap_or(unbracketed);
    if let Ok(ip) = ip_literal.parse::<std::net::IpAddr>() {
        if let Some(kind) = blocked_ip_kind(ip) {
            return Err(format!(
                "Endpoint '{endpoint}' uses an unsafe {kind} address, which is not allowed."
            ));
        }
    }
    Ok(())
}

/// Normalize an endpoint string into a full URL suitable for the AWS SDK.
pub(super) fn normalize_endpoint(raw: &str) -> Result<(String, Option<String>), String> {
    let trimmed = raw.trim().trim_end_matches('/');

    // Ensure scheme is present.
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    // Infallible by construction above, but a panic here would abort the whole
    // app (panic = "abort"), so fail with a graceful error instead.
    let (scheme, after_scheme) = with_scheme.split_once("://").ok_or_else(|| {
        "Endpoint URL is malformed; include a scheme such as https://.".to_string()
    })?;
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let path = after_scheme
        .strip_prefix(authority)
        .unwrap_or("")
        .trim_matches('/');

    // Userinfo is not part of a host. Drop it before parsing so a value like
    // `user@169.254.169.254` cannot smuggle a blocked address past validation.
    let host_port = authority.rsplit('@').next().unwrap_or(authority);

    // Separate host from optional port. An unbracketed authority with more
    // than one colon is an IPv6 literal, not a host plus port.
    let (host, port) = if host_port.matches(':').count() > 1 && !host_port.starts_with('[') {
        (host_port, None)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
            _ => (host_port, None),
        }
    };

    let host_lower = host.to_ascii_lowercase();
    validate_endpoint_host(&host_lower, trimmed)?;

    // A single trailing path segment is accepted as a bucket hint (pasting a
    // bucket URL). Anything deeper is a reverse-proxy base path that
    // path-style request building cannot preserve, so reject it rather than
    // silently dropping segments.
    if path.contains('/') {
        return Err(
            "Endpoint URLs with a base path are not supported; use the service endpoint."
                .to_string(),
        );
    }

    let mut bucket_hint: Option<String> = if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    };

    let do_suffix = ".digitaloceanspaces.com";
    let normalized_host = if let Some((endpoint, bucket)) = strip_aws_virtual_host(&host_lower) {
        if bucket_hint.is_none() {
            bucket_hint = Some(bucket);
        }
        endpoint
    } else if host_lower.ends_with(do_suffix) {
        let prefix = host_lower.trim_end_matches(do_suffix);
        let parts: Vec<&str> = prefix.split('.').collect();
        if parts.len() >= 2 {
            if bucket_hint.is_none() {
                bucket_hint = Some(parts[0].to_string());
            }
            format!("{}{}", parts[parts.len() - 1], do_suffix)
        } else {
            host_lower
        }
    } else {
        host_lower
    };

    let url = match port {
        Some(p) => format!("{}://{}:{}", scheme, normalized_host, p),
        None => format!("{}://{}", scheme, normalized_host),
    };

    if normalized_host.is_empty() {
        return Err(
            "Endpoint URL has no host; enter a full endpoint such as https://s3.amazonaws.com."
                .to_string(),
        );
    }

    Ok((url, bucket_hint))
}

/// Decode a key or prefix returned by a listing requested with
/// `encoding-type=url`.
///
/// Without it S3 emits keys raw inside XML, and a key containing a character
/// XML 1.0 forbids (for example a control byte) makes the whole page
/// unparseable. Continuation tokens are opaque and must never be decoded.
///
/// S3 form-encodes these values: a space arrives as `+` and a literal plus as
/// `%2B`. Percent-decoding alone would turn the key `a b` into `a+b`, which
/// then addresses a different (or missing) object. Some S3-compatible servers
/// percent-encode instead (space as `%20`) and leave `+` raw, so the encoding
/// is judged per response: a `%20` anywhere proves a percent encoder, since a
/// form encoder never emits it and a literal `%` is always sent as `%25`.
#[derive(Clone, Copy, Debug)]
pub(super) struct ListedEncoding {
    pub(super) plus_is_space: bool,
}

impl ListedEncoding {
    pub(super) fn detect<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let percent_encoder = values.into_iter().any(|value| value.contains("%20"));
        Self {
            plus_is_space: !percent_encoder,
        }
    }

    pub(super) fn decode(self, value: &str) -> String {
        let value = if self.plus_is_space {
            value.replace('+', " ")
        } else {
            value.to_string()
        };
        match urlencoding::decode(&value) {
            Ok(decoded) => decoded.into_owned(),
            Err(_) => value,
        }
    }
}

/// Judge one listing response by every encoded value it carries: keys,
/// common prefixes, and the echoed request prefix and start-after.
pub(super) fn listed_encoding(
    output: &aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output,
) -> ListedEncoding {
    ListedEncoding::detect(
        output
            .contents()
            .iter()
            .filter_map(|object| object.key())
            .chain(output.common_prefixes().iter().filter_map(|p| p.prefix()))
            .chain(output.prefix())
            .chain(output.start_after()),
    )
}
