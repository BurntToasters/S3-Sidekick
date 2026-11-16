//! Remote path, child-name and SFTP endpoint validation.
//!
//! These are pure parsers, so their failure paths are unit-tested here rather
//! than through the E2E layers.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Longest remote path accepted, in bytes (not characters).
pub(crate) const MAX_SFTP_PATH_BYTES: usize = 4096;

/// Longest RFC 1123 hostname accepted, without a trailing dot.
const MAX_HOSTNAME_BYTES: usize = 253;

/// Longest RFC 1123 label accepted.
const MAX_LABEL_BYTES: usize = 63;

const ENDPOINT_SCHEME: &str = "sftp://";

// Failure modes, written before the implementation:
// - A relative, `~`, `.`, `..`, or empty-segment path resolves outside the
//   directory being browsed, or spells one path two ways.
// - A NUL byte truncates the path; an unbounded path exhausts memory or is cut.
// - A child name with `/`, `.`, or `..` becomes a multi-level or parent operation.
// - A host with a scheme, path, userinfo, whitespace, or port connects to a
//   different host than the one shown and forks the identity hash.
// - An unbracketed IPv6 literal is ambiguous with `host:port`.
// - Port 0, an out-of-range port, or non-canonical digits give one server
//   several identities.
// - A persisted endpoint without an explicit port silently changes identity.

/// Validate an absolute, `/`-separated remote path and return it unchanged.
///
/// Rejects an empty path, NUL, a path over [`MAX_SFTP_PATH_BYTES`], a relative
/// path, a trailing `/` (except `/` itself), an empty segment, and `.` or `..`
/// segments.
pub(crate) fn normalize_remote_path(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("Remote path is required".to_string());
    }
    if path.contains('\0') {
        return Err("Remote path must not contain NUL bytes".to_string());
    }
    if path.len() > MAX_SFTP_PATH_BYTES {
        return Err(format!(
            "Remote path exceeds the {} byte limit",
            MAX_SFTP_PATH_BYTES
        ));
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err("Remote path must be absolute".to_string());
    };
    if rest.is_empty() {
        return Ok(path.to_string());
    }
    if rest.ends_with('/') {
        return Err("Remote path must not end with '/'".to_string());
    }
    for segment in rest.split('/') {
        match segment {
            "" => return Err("Remote path must not contain empty segments".to_string()),
            "." | ".." => {
                return Err("Remote path must not contain '.' or '..' segments".to_string())
            }
            _ => {}
        }
    }
    Ok(path.to_string())
}

/// Reject a name that cannot be one child segment of a remote path.
fn validate_child_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if name == "." || name == ".." {
        return Err("Name must not be '.' or '..'".to_string());
    }
    if name.contains('/') {
        return Err("Name must not contain '/'".to_string());
    }
    if name.contains('\0') {
        return Err("Name must not contain NUL bytes".to_string());
    }
    Ok(())
}

/// Join one child name under a valid parent directory.
///
/// The name must be non-empty, contain no `/` or NUL, and must not be `.` or
/// `..`. The joined path must itself pass [`normalize_remote_path`].
pub(crate) fn join_remote(parent: &str, name: &str) -> Result<String, String> {
    let parent = normalize_remote_path(parent)?;
    validate_child_name(name)?;
    let joined = if parent == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", parent, name)
    };
    normalize_remote_path(&joined)
}

/// Split a valid, non-root path into its parent directory and leaf name.
///
/// `("/a/b", "c")` for `/a/b/c`, and `("/", "c")` for `/c`. The root has no
/// parent and is an error.
pub(crate) fn split_parent(path: &str) -> Result<(String, String), String> {
    let path = normalize_remote_path(path)?;
    if path == "/" {
        return Err("The root directory has no parent".to_string());
    }
    let (head, leaf) = path
        .rsplit_once('/')
        .ok_or_else(|| "Remote path must be absolute".to_string())?;
    let parent = if head.is_empty() { "/" } else { head };
    Ok((parent.to_string(), leaf.to_string()))
}

/// Parse an IPv6 literal, returning its canonical lowercase form.
fn canonical_ipv6(text: &str) -> Option<String> {
    text.parse::<Ipv6Addr>().ok().map(|ip| ip.to_string())
}

/// Check an RFC 1123 hostname and return it lowercased.
fn validate_hostname(host: &str) -> Result<String, String> {
    if host.len() > MAX_HOSTNAME_BYTES {
        return Err(format!(
            "SFTP host exceeds the {} byte limit",
            MAX_HOSTNAME_BYTES
        ));
    }
    for label in host.split('.') {
        if label.is_empty() {
            return Err("SFTP host must not contain empty labels".to_string());
        }
        if label.len() > MAX_LABEL_BYTES {
            return Err(format!(
                "SFTP host label exceeds the {} byte limit",
                MAX_LABEL_BYTES
            ));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err("SFTP host labels must not start or end with '-'".to_string());
        }
        if !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("SFTP host may contain only letters, digits, '-' and '.'".to_string());
        }
    }
    Ok(host.to_ascii_lowercase())
}

/// Validate an SFTP host and return its canonical lowercase form, without
/// brackets.
///
/// Accepts an RFC 1123 hostname (labels of 1 to 63 ASCII letters, digits, or
/// hyphens, not starting or ending with a hyphen, at most 253 bytes), an IPv4
/// literal, or an IPv6 literal with or without brackets. Rejects a scheme,
/// path, userinfo, whitespace or control characters, an empty value, and an
/// embedded port.
pub(crate) fn validate_sftp_host(host: &str) -> Result<String, String> {
    if host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if host.contains("://") || host.contains('/') {
        return Err("SFTP host must not include a scheme or path".to_string());
    }
    if host.contains('@') {
        return Err("SFTP host must not include a username".to_string());
    }
    if host.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err("SFTP host must not contain whitespace".to_string());
    }
    if let Some(inner) = host.strip_prefix('[') {
        let Some(literal) = inner.strip_suffix(']') else {
            return Err("SFTP host has an unclosed IPv6 bracket".to_string());
        };
        return canonical_ipv6(literal)
            .ok_or_else(|| "Only an IPv6 address may be bracketed".to_string());
    }
    if host.contains(']') {
        return Err("SFTP host has an unmatched ']'".to_string());
    }
    if host.contains(':') {
        return canonical_ipv6(host).ok_or_else(|| {
            "SFTP host must not include a port; set the port separately".to_string()
        });
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip.to_string());
    }
    validate_hostname(host)
}

/// Parse a canonical decimal port: digits only, no leading zero, 1 to 65535.
fn parse_port(text: &str) -> Result<u16, String> {
    let canonical = !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    if !canonical {
        return Err("SFTP port must be a decimal number without leading zeros".to_string());
    }
    let port: u16 = text
        .parse()
        .map_err(|_| "SFTP port must be at most 65535".to_string())?;
    if port == 0 {
        return Err("SFTP port must be between 1 and 65535".to_string());
    }
    Ok(port)
}

/// Build the normalized `sftp://host:port` endpoint. IPv6 hosts are bracketed.
///
/// The port must be 1 to 65535. The host goes through [`validate_sftp_host`].
pub(crate) fn format_sftp_endpoint(host: &str, port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("SFTP port must be between 1 and 65535".to_string());
    }
    let host = validate_sftp_host(host)?;
    if host.contains(':') {
        Ok(format!("{}[{}]:{}", ENDPOINT_SCHEME, host, port))
    } else {
        Ok(format!("{}{}:{}", ENDPOINT_SCHEME, host, port))
    }
}

/// Inverse of [`format_sftp_endpoint`]: return the canonical host and port.
///
/// Requires the lowercase `sftp://` scheme and an explicit canonical port
/// (decimal digits, no sign, no leading zero, 1 to 65535). An IPv6 host must be
/// bracketed. Nothing after the port is accepted.
pub(crate) fn parse_sftp_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let rest = endpoint
        .strip_prefix(ENDPOINT_SCHEME)
        .ok_or_else(|| "SFTP endpoint must start with sftp://".to_string())?;
    let (host, port_text) = if let Some(after_bracket) = rest.strip_prefix('[') {
        let (literal, after) = after_bracket
            .split_once(']')
            .ok_or_else(|| "SFTP endpoint has an unclosed IPv6 bracket".to_string())?;
        if literal.parse::<Ipv6Addr>().is_err() {
            return Err("Only an IPv6 address may be bracketed".to_string());
        }
        let port_text = after
            .strip_prefix(':')
            .ok_or_else(|| "SFTP endpoint must include an explicit port".to_string())?;
        (literal, port_text)
    } else {
        let (host, port_text) = rest
            .rsplit_once(':')
            .ok_or_else(|| "SFTP endpoint must include an explicit port".to_string())?;
        if host.contains(':') {
            return Err("An IPv6 SFTP host must be bracketed".to_string());
        }
        (host, port_text)
    };
    let port = parse_port(port_text)?;
    Ok((validate_sftp_host(host)?, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_absolute_paths_unchanged() {
        for path in [
            "/",
            "/a",
            "/a/b.txt",
            "/a b/c d",
            "/a/.hidden",
            "/a/..b",
            "/a/b..",
            "/ünï/€",
        ] {
            assert_eq!(normalize_remote_path(path).expect(path), path);
        }
    }

    #[test]
    fn normalize_rejects_empty_and_relative_paths() {
        for path in ["", "a", "a/b", "./a", "~/a", "../a"] {
            assert!(
                normalize_remote_path(path).is_err(),
                "{path:?} must be rejected"
            );
        }
    }

    #[test]
    fn normalize_rejects_trailing_slashes_and_empty_segments() {
        for path in ["/a/", "//", "//a", "/a//b", "/a/b//"] {
            assert!(
                normalize_remote_path(path).is_err(),
                "{path:?} must be rejected"
            );
        }
    }

    #[test]
    fn normalize_rejects_dot_and_dotdot_segments() {
        for path in ["/.", "/..", "/a/.", "/a/..", "/a/../b", "/./a"] {
            assert!(
                normalize_remote_path(path).is_err(),
                "{path:?} must be rejected"
            );
        }
    }

    #[test]
    fn normalize_rejects_nul_bytes() {
        assert!(normalize_remote_path("/a\0b").is_err());
        assert!(normalize_remote_path("/a/b\0").is_err());
    }

    #[test]
    fn normalize_enforces_the_byte_limit_inclusively() {
        let at_limit = format!("/{}", "a".repeat(MAX_SFTP_PATH_BYTES - 1));
        assert_eq!(at_limit.len(), MAX_SFTP_PATH_BYTES);
        assert!(normalize_remote_path(&at_limit).is_ok());

        let over = format!("/{}", "a".repeat(MAX_SFTP_PATH_BYTES));
        assert!(normalize_remote_path(&over).is_err());
    }

    #[test]
    fn byte_limit_counts_utf8_bytes_not_characters() {
        // 2049 two-byte characters plus the leading slash is 4099 bytes, but
        // only 2050 characters, so a character count would wrongly accept it.
        let path = format!("/{}", "é".repeat(2049));
        assert_eq!(path.len(), 4099);
        assert!(normalize_remote_path(&path).is_err());
    }

    #[test]
    fn join_builds_children_under_root_and_nested_parents() {
        assert_eq!(join_remote("/", "c").expect("root child"), "/c");
        assert_eq!(join_remote("/a/b", "c").expect("nested child"), "/a/b/c");
        assert_eq!(
            join_remote("/a", "b c.txt").expect("name with space"),
            "/a/b c.txt"
        );
    }

    #[test]
    fn join_rejects_names_that_are_not_a_single_child() {
        for name in ["", ".", "..", "a/b", "/a", "a/", "x\0y"] {
            assert!(
                join_remote("/a", name).is_err(),
                "{name:?} must be rejected"
            );
        }
    }

    #[test]
    fn join_rejects_an_invalid_parent() {
        for parent in ["a", "/a/", "//", "/a/../b", ""] {
            assert!(
                join_remote(parent, "c").is_err(),
                "{parent:?} must be rejected"
            );
        }
    }

    #[test]
    fn join_rejects_a_result_over_the_byte_limit() {
        // A parent of MAX - 2 bytes plus "/" and one byte fits exactly; two
        // bytes overflow.
        let parent = format!("/{}", "a".repeat(MAX_SFTP_PATH_BYTES - 3));
        assert_eq!(parent.len(), MAX_SFTP_PATH_BYTES - 2);
        assert!(join_remote(&parent, "b").is_ok());
        assert!(join_remote(&parent, "bc").is_err());
    }

    #[test]
    fn split_parent_returns_parent_and_leaf() {
        assert_eq!(
            split_parent("/a/b/c").expect("nested"),
            ("/a/b".to_string(), "c".to_string())
        );
        assert_eq!(
            split_parent("/c").expect("top level"),
            ("/".to_string(), "c".to_string())
        );
    }

    #[test]
    fn split_parent_rejects_root_and_invalid_paths() {
        for path in ["/", "a/b", "/a/", "", "/a//b"] {
            assert!(split_parent(path).is_err(), "{path:?} must be rejected");
        }
    }

    #[test]
    fn join_and_split_round_trip() {
        for (parent, name) in [("/", "x"), ("/a", "b"), ("/a/b c", "d.txt")] {
            let joined = join_remote(parent, name).expect("join");
            assert_eq!(
                split_parent(&joined).expect("split"),
                (parent.to_string(), name.to_string())
            );
        }
    }

    #[test]
    fn host_accepts_hostnames_and_lowercases_them() {
        assert_eq!(validate_sftp_host("example.com").unwrap(), "example.com");
        assert_eq!(validate_sftp_host("Example.COM").unwrap(), "example.com");
        assert_eq!(validate_sftp_host("localhost").unwrap(), "localhost");
        assert_eq!(
            validate_sftp_host("a-b.c1.example").unwrap(),
            "a-b.c1.example"
        );
        assert_eq!(
            validate_sftp_host("xn--bcher-kva.example").unwrap(),
            "xn--bcher-kva.example"
        );
    }

    #[test]
    fn host_accepts_labels_and_names_at_the_rfc_1123_limits() {
        let label = "a".repeat(MAX_LABEL_BYTES);
        let max_name = format!("{label}.{label}.{label}.{}", "a".repeat(61));
        assert_eq!(max_name.len(), MAX_HOSTNAME_BYTES);
        assert!(validate_sftp_host(&max_name).is_ok());

        let long_label = "a".repeat(MAX_LABEL_BYTES + 1);
        assert!(validate_sftp_host(&long_label).is_err());

        let long_name = format!("{label}.{label}.{label}.{}", "a".repeat(62));
        assert_eq!(long_name.len(), MAX_HOSTNAME_BYTES + 1);
        assert!(validate_sftp_host(&long_name).is_err());
    }

    #[test]
    fn host_accepts_ipv4_and_ipv6_literals() {
        assert_eq!(validate_sftp_host("192.168.1.10").unwrap(), "192.168.1.10");
        assert_eq!(validate_sftp_host("::1").unwrap(), "::1");
        assert_eq!(validate_sftp_host("[::1]").unwrap(), "::1");
        assert_eq!(validate_sftp_host("[2001:DB8::1]").unwrap(), "2001:db8::1");
        assert_eq!(validate_sftp_host("2001:db8::1").unwrap(), "2001:db8::1");
    }

    #[test]
    fn host_rejects_scheme_path_userinfo_whitespace_and_empty() {
        for host in [
            "",
            "sftp://example.com",
            "https://example.com",
            "example.com/path",
            "/example.com",
            "user@example.com",
            "bob@[::1]",
            "exa mple.com",
            " example.com",
            "example.com\t",
            "ex\nample.com",
            "ex\0ample",
        ] {
            assert!(
                validate_sftp_host(host).is_err(),
                "{host:?} must be rejected"
            );
        }
    }

    #[test]
    fn host_rejects_embedded_ports_and_broken_ipv6_forms() {
        for host in [
            "example.com:22",
            "1.2.3.4:22",
            "[::1]:22",
            "[::1",
            "::1]",
            "[example.com]",
            "[::1]]",
            "[[::1]]",
            "fe80::1%eth0",
            ":::",
            "::g",
        ] {
            assert!(
                validate_sftp_host(host).is_err(),
                "{host:?} must be rejected"
            );
        }
    }

    #[test]
    fn host_rejects_bad_hostname_labels() {
        for host in [
            "-lead.example",
            "trail-.example",
            "a..b",
            "host.",
            ".host",
            "under_score.example",
            "bad!.example",
            "a.-.b",
            "中文.example",
        ] {
            assert!(
                validate_sftp_host(host).is_err(),
                "{host:?} must be rejected"
            );
        }
    }

    #[test]
    fn format_builds_the_normalized_endpoint() {
        assert_eq!(
            format_sftp_endpoint("example.com", 22).expect("hostname"),
            "sftp://example.com:22"
        );
        assert_eq!(
            format_sftp_endpoint("Example.COM", 2222).expect("mixed case"),
            "sftp://example.com:2222"
        );
        assert_eq!(
            format_sftp_endpoint("192.168.1.10", 1).expect("ipv4"),
            "sftp://192.168.1.10:1"
        );
        assert_eq!(
            format_sftp_endpoint("::1", 22).expect("ipv6"),
            "sftp://[::1]:22"
        );
        assert_eq!(
            format_sftp_endpoint("[2001:DB8::1]", 65535).expect("bracketed ipv6"),
            "sftp://[2001:db8::1]:65535"
        );
    }

    #[test]
    fn format_rejects_port_zero_and_invalid_hosts() {
        assert!(format_sftp_endpoint("example.com", 0).is_err());
        for host in [
            "",
            "sftp://example.com",
            "example.com/x",
            "user@host",
            "host:22",
        ] {
            assert!(
                format_sftp_endpoint(host, 22).is_err(),
                "{host:?} must be rejected"
            );
        }
    }

    #[test]
    fn parse_reads_hostname_and_bracketed_ipv6_endpoints() {
        assert_eq!(
            parse_sftp_endpoint("sftp://example.com:22").expect("hostname"),
            ("example.com".to_string(), 22)
        );
        assert_eq!(
            parse_sftp_endpoint("sftp://192.168.1.10:2022").expect("ipv4"),
            ("192.168.1.10".to_string(), 2022)
        );
        assert_eq!(
            parse_sftp_endpoint("sftp://[::1]:22").expect("loopback ipv6"),
            ("::1".to_string(), 22)
        );
        assert_eq!(
            parse_sftp_endpoint("sftp://[2001:db8::1]:65535").expect("max port"),
            ("2001:db8::1".to_string(), 65535)
        );
    }

    #[test]
    fn parse_requires_the_lowercase_sftp_scheme() {
        for endpoint in [
            "example.com:22",
            "https://example.com:22",
            "SFTP://example.com:22",
            "s3://example.com:22",
            "//example.com:22",
        ] {
            assert!(
                parse_sftp_endpoint(endpoint).is_err(),
                "{endpoint:?} must be rejected"
            );
        }
    }

    #[test]
    fn parse_requires_an_explicit_canonical_port() {
        for endpoint in [
            "sftp://example.com",
            "sftp://example.com:",
            "sftp://example.com:0",
            "sftp://example.com:65536",
            "sftp://example.com:+22",
            "sftp://example.com:022",
            "sftp://example.com:2a",
            "sftp://example.com:-1",
            "sftp://[::1]",
            "sftp://[::1]:",
            "sftp://[::1]:0",
        ] {
            assert!(
                parse_sftp_endpoint(endpoint).is_err(),
                "{endpoint:?} must be rejected"
            );
        }
    }

    #[test]
    fn parse_rejects_userinfo_paths_and_extra_components() {
        for endpoint in [
            "sftp://user@example.com:22",
            "sftp://example.com:22/path",
            "sftp://example.com:22?x=1",
            "sftp://example.com:22#frag",
            "sftp://:22",
            "sftp://example.com:22:33",
            "sftp://[::1]:22x",
            "sftp://[::1]x22",
            "sftp://[::1",
            "sftp://[example.com]:22",
            "sftp://fe80::1:22",
        ] {
            assert!(
                parse_sftp_endpoint(endpoint).is_err(),
                "{endpoint:?} must be rejected"
            );
        }
    }

    #[test]
    fn parse_inverts_format_for_every_host_shape() {
        for (host, port) in [
            ("example.com", 22),
            ("192.168.1.10", 2022),
            ("::1", 22),
            ("2001:db8::1", 65535),
            ("localhost", 1),
        ] {
            let endpoint = format_sftp_endpoint(host, port).expect("format");
            let parsed = parse_sftp_endpoint(&endpoint).expect("parse");
            assert_eq!(parsed, (validate_sftp_host(host).expect("host"), port));
            assert_eq!(
                format_sftp_endpoint(&parsed.0, parsed.1).expect("reformat"),
                endpoint
            );
        }
    }

    #[test]
    fn canonical_endpoints_round_trip_through_parse_then_format() {
        for endpoint in [
            "sftp://example.com:22",
            "sftp://[::1]:22",
            "sftp://[2001:db8::1]:2022",
        ] {
            let (host, port) = parse_sftp_endpoint(endpoint).expect("parse");
            assert_eq!(format_sftp_endpoint(&host, port).expect("format"), endpoint);
        }
    }
}
