//! Endpoint parsing, region inference and listing key decoding.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use aws_sdk_s3::types::EncodingType;

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
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = after_scheme[..authority_end].trim();
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
            let octets = v4.octets();
            if v4.is_link_local() {
                Some("IPv4 link-local")
            } else if v4.is_unspecified() {
                Some("unspecified")
            } else if v4.is_broadcast() {
                Some("broadcast")
            } else if v4.is_multicast() {
                Some("IPv4 multicast")
            } else if octets[0] == 100 && (64..=127).contains(&octets[1]) {
                // 100.64.0.0/10 is carrier-grade NAT, and several clouds host
                // instance metadata there (for example 100.100.100.200).
                Some("IPv4 carrier-grade NAT")
            } else if octets == [168, 63, 129, 16] {
                // Azure's wire-server / instance metadata address.
                Some("cloud instance metadata")
            } else if octets == [192, 0, 0, 192] {
                Some("cloud instance metadata")
            } else {
                None
            }
        }
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            if v6.is_unspecified() {
                Some("unspecified")
            } else if v6.is_multicast() {
                Some("IPv6 multicast")
            } else if (segments[0] & 0xffc0) == 0xfe80 {
                Some("IPv6 link-local")
            } else if segments[0] == 0xfd00 && segments[1] == 0x0ec2 {
                // AWS IPv6 instance metadata lives in `fd00:ec2::/32`.
                Some("IPv6 instance metadata")
            } else if segments[0] == 0xfd20 && segments[1] == 0x00ce {
                // Google Cloud IPv6 metadata (`fd20:ce::254`).
                Some("IPv6 instance metadata")
            } else {
                // Also catch IPv4-mapped/compatible forms such as
                // `::ffff:169.254.169.254`, which embed a blocked v4 address.
                v6.to_ipv4()
                    .and_then(|v4| blocked_ip_kind(std::net::IpAddr::V4(v4)))
            }
        }
    }
}

/// Reject numeric hosts that only *look* like an IPv4 literal.
///
/// Some resolvers accept `127.1`, `0177.0.0.1`, or `2852039166` and map them to
/// an address. Parsing only the canonical dotted-quad form keeps the address
/// classification below authoritative for every numeric host, instead of letting
/// a non-canonical spelling reach the resolver unclassified.
fn is_non_canonical_ipv4(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    if host.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return false;
    }
    if host.parse::<std::net::Ipv4Addr>().is_err() {
        return true;
    }
    host.split('.')
        .any(|segment| segment.len() > 1 && segment.starts_with('0'))
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
    } else if is_non_canonical_ipv4(ip_literal) {
        return Err(format!(
            "Endpoint '{endpoint}' uses a non-canonical IPv4 literal, which is not allowed; use the dotted-quad form."
        ));
    }
    Ok(())
}

/// Resolve a hostname and reject every address that names a metadata service.
///
/// Checking only the literal endpoint string misses a hostname whose DNS answer
/// points at `169.254.169.254`, `fd00:ec2::254`, or another metadata service.
/// All returned addresses are classified, not just the first, so a mixed or
/// rebinding answer cannot hide one unsafe target behind a safe one.
pub(super) async fn validate_endpoint_resolution(endpoint: &str) -> Result<(), String> {
    let host = parse_endpoint_host(endpoint).ok_or_else(|| {
        "Endpoint URL has no host; enter a full endpoint such as https://s3.amazonaws.com."
            .to_string()
    })?;
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    if is_non_canonical_ipv4(&host) {
        return Err(format!(
            "Endpoint '{endpoint}' uses a non-canonical IPv4 literal, which is not allowed; use the dotted-quad form."
        ));
    }

    let port = parse_endpoint_port(endpoint).unwrap_or_else(|| {
        if endpoint.trim().starts_with("http://") {
            80
        } else {
            443
        }
    });
    let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|err| format!("Endpoint '{endpoint}' could not be resolved: {err}"))?
        .collect();
    if resolved.is_empty() {
        return Err(format!(
            "Endpoint '{endpoint}' did not resolve to any address."
        ));
    }
    for address in resolved {
        if let Some(kind) = blocked_ip_kind(address.ip()) {
            return Err(format!(
                "Endpoint '{endpoint}' resolves to an unsafe {kind} address ({}), which is not allowed.",
                address.ip()
            ));
        }
    }
    Ok(())
}

fn parse_endpoint_port(endpoint: &str) -> Option<u16> {
    let trimmed = endpoint.trim();
    let after_scheme = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = after_scheme[..authority_end].trim();
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let port = if host_port.starts_with('[') {
        host_port.split_once("]:")?.1
    } else {
        host_port.rsplit_once(':')?.1
    };
    port.parse().ok()
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
    // Split authority, path, query, and fragment explicitly. Treating a query
    // or fragment as part of the host produced endpoints such as
    // `https://host?x=1`, which the SDK then failed to resolve.
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let remainder = after_scheme[authority_end..].trim_start_matches('/');
    let path_end = remainder.find(['?', '#']).unwrap_or(remainder.len());
    let path = remainder[..path_end].trim_matches('/');

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
        if let Some(path_bucket) = bucket_hint.as_ref() {
            if path_bucket != &bucket {
                return Err(format!(
                    "Endpoint names bucket '{}' in its host and '{}' in its path; remove one of them.",
                    bucket, path_bucket
                ));
            }
        }
        bucket_hint = Some(bucket);
        endpoint
    } else if host_lower.ends_with(do_suffix) {
        let prefix = host_lower.trim_end_matches(do_suffix);
        let parts: Vec<&str> = prefix.split('.').collect();
        if parts.len() >= 2 {
            let host_bucket = parts[0].to_string();
            if let Some(path_bucket) = bucket_hint.as_ref() {
                if path_bucket != &host_bucket {
                    return Err(format!(
                        "Endpoint names bucket '{}' in its host and '{}' in its path; remove one of them.",
                        host_bucket, path_bucket
                    ));
                }
            }
            bucket_hint = Some(host_bucket);
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
    decode_percent: bool,
}

impl ListedEncoding {
    /// A response that did not echo `encoding-type=url` carries raw keys.
    /// Decoding those would corrupt every key containing `%` or `+`.
    pub(super) fn raw() -> Self {
        Self {
            plus_is_space: false,
            decode_percent: false,
        }
    }

    pub(super) fn detect<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let percent_encoder = values.into_iter().any(|value| value.contains("%20"));
        Self {
            plus_is_space: !percent_encoder,
            decode_percent: true,
        }
    }

    pub(super) fn decode(self, value: &str) -> String {
        if !self.decode_percent {
            return value.to_string();
        }
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

/// Encoding style is a property of the server, learned from every listed value
/// the connection has returned. Judging each page independently made a page
/// without a `%20` fall back to form decoding, turning `a+b` into `a b` on the
/// next request even though the server had already shown itself to be a
/// percent encoder. The cache is keyed by endpoint URL so one connection's
/// behaviour cannot leak into another.
fn listed_encoding_cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn listed_values(
    output: &aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output,
) -> impl Iterator<Item = &str> {
    output
        .contents()
        .iter()
        .filter_map(|object| object.key())
        .chain(output.common_prefixes().iter().filter_map(|p| p.prefix()))
        .chain(output.prefix())
        .chain(output.start_after())
}

/// Judge one listing response by every encoded value it carries: keys,
/// common prefixes, and the echoed request prefix and start-after.
pub(super) fn listed_encoding(
    output: &aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output,
) -> ListedEncoding {
    if output.encoding_type() != Some(&EncodingType::Url) {
        return ListedEncoding::raw();
    }
    ListedEncoding::detect(listed_values(output))
}

/// Same decision, but remembers the encoding style observed for this bucket
/// across pages. The server's encoding behaviour does not change page to page,
/// so a page without `%20` must not flip the `+` interpretation established by
/// an earlier page.
pub(super) fn listed_encoding_for(
    bucket: &str,
    output: &aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output,
) -> ListedEncoding {
    if output.encoding_type() != Some(&EncodingType::Url) {
        return ListedEncoding::raw();
    }
    let mut page = listed_encoding(output);
    let key = bucket.to_string();
    if let Ok(mut cache) = listed_encoding_cache().lock() {
        match cache.get(&key) {
            Some(true) => page.plus_is_space = false,
            Some(false) => {}
            None => {
                cache.insert(key.clone(), !page.plus_is_space);
            }
        }
        if !page.plus_is_space {
            cache.insert(key, true);
        }
    }
    page
}
