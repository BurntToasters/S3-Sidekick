//! Private key selection and inspection for SFTP key authentication.
//!
//! The native dialog grants the path, and the renderer never names one. The key
//! text is read here, checked by `inspect_private_key`, and handed to the
//! connect command, so the connect step never reads a second file.

use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use super::types::SshPrivateKeyInfo;
use crate::security;

/// Largest private key file accepted. Real keys are a few kilobytes.
pub(crate) const MAX_PRIVATE_KEY_BYTES: usize = 16 * 1024;

const DAMAGED_KEY_MESSAGE: &str = "The private key is damaged or incomplete.";
const KEY_TOO_LARGE_MESSAGE: &str = "The selected key is larger than 16 KiB.";
const UNSUPPORTED_KEY_TYPE_MESSAGE: &str = "Unsupported key type. Use an Ed25519 or ECDSA key.";
const OPENSSH_MAGIC: &[u8] = b"openssh-key-v1\0";
const TAG_INTEGER: u8 = 0x02;
const TAG_OID: u8 = 0x06;
const TAG_SEQUENCE: u8 = 0x30;
/// DER object identifiers, as their content bytes, for the algorithms accepted.
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_P521: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x23];

pub(crate) const PPK_MESSAGE: &str =
    "PuTTY .ppk keys are not supported. Convert the key to OpenSSH format with puttygen.";
pub(crate) const RSA_KEY_MESSAGE: &str =
    "RSA keys are not supported in this beta. Use an Ed25519 or ECDSA key.";
pub(crate) const UNSUPPORTED_KEY_FORMAT_MESSAGE: &str =
    "Unsupported private key format. Use an OpenSSH or PKCS#8 private key, or convert it with ssh-keygen.";

// Failure modes, written before the implementation:
// - A PuTTY file is parsed as OpenSSH and fails with an opaque decode error.
// - An RSA key is accepted, then fails at authentication with no explanation.
// - An encrypted key is reported as plain, so the passphrase is never asked.
// - A public key or arbitrary text is treated as a private key.
// - A truncated or multi-key OpenSSH container is read past its end.
// - A symlink, device, FIFO, or directory is read, so the read blocks or leaks
//   a file the user did not choose.
// - A file that grows between the check and the read is read past the limit.
// - A file that is not UTF-8 is lossily converted and then fails with a
//   misleading error.
// - The full path reaches the webview, which the dialog grant never needed.

/// Classify private key text without the passphrase.
///
/// Returns the OpenSSH algorithm name (or `"unknown"` for an encrypted PKCS#8
/// key, which hides it) and whether the key is encrypted. Refuses PuTTY files,
/// RSA keys, and anything that is not an OpenSSH or PKCS#8 private key.
pub(crate) fn inspect_private_key(text: &str) -> Result<(String, bool), String> {
    let text = text.trim_start_matches('\u{feff}');
    if text.trim_start().starts_with("PuTTY-User-Key-File-") {
        return Err(PPK_MESSAGE.to_string());
    }
    if text.contains("-----BEGIN RSA PRIVATE KEY-----") {
        return Err(RSA_KEY_MESSAGE.to_string());
    }
    if text.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return inspect_openssh(text);
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        // The envelope hides the algorithm, so only the structure is checked.
        let der = pem_body(text, "ENCRYPTED PRIVATE KEY")?;
        if der_element(&der).map(|(tag, _, _)| tag) != Some(TAG_SEQUENCE) {
            return Err(UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string());
        }
        return Ok(("unknown".to_string(), true));
    }
    if text.contains("-----BEGIN PRIVATE KEY-----") {
        return inspect_pkcs8(text);
    }
    Err(UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string())
}

/// Read one granted private key file and return its metadata.
///
/// Refuses symlinks, non-regular files, files over [`MAX_PRIVATE_KEY_BYTES`],
/// non-UTF-8 content, and anything [`inspect_private_key`] refuses. The returned
/// `file_name` is the bare name, never the full path.
pub(crate) fn read_private_key_file(path: &Path) -> Result<SshPrivateKeyInfo, String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let before = std::fs::symlink_metadata(path)
        .map_err(|_| "The selected key file could not be read.".to_string())?;
    if before.file_type().is_symlink() {
        return Err("The selected key is a symbolic link. Select the key file itself.".to_string());
    }
    if !before.is_file() {
        return Err("The selected key is not a regular file.".to_string());
    }
    if before.len() > MAX_PRIVATE_KEY_BYTES as u64 {
        return Err(KEY_TOO_LARGE_MESSAGE.to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "The selected key file could not be read.".to_string())?;
    let opened = file
        .metadata()
        .map_err(|_| "The selected key file could not be read.".to_string())?;
    if !opened.is_file() {
        return Err("The selected key is not a regular file.".to_string());
    }
    // The path is checked before it is opened, so a swap in between is caught
    // by comparing the file identity the two checks saw.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(
                "The selected key changed while it was being read. Select it again.".to_string(),
            );
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_PRIVATE_KEY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The selected key file could not be read.".to_string())?;
    if bytes.len() > MAX_PRIVATE_KEY_BYTES {
        return Err(KEY_TOO_LARGE_MESSAGE.to_string());
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| "The selected key is not a UTF-8 text file.".to_string())?;
    let (algorithm, encrypted) = inspect_private_key(&text)?;
    Ok(SshPrivateKeyInfo {
        key_text: text,
        algorithm,
        encrypted,
        file_name,
    })
}

/// Show the native dialog for a private key file and return its metadata.
///
/// Returns `None` when the user cancels the dialog.
#[tauri::command]
pub(crate) async fn pick_ssh_private_key(
    app: tauri::AppHandle,
) -> Result<Option<SshPrivateKeyInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = security::run_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Select SSH private key")
            .blocking_pick_file())
    })
    .await?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "The selected key is not a local file.".to_string())?;
    read_private_key_file(&path).map(Some)
}

fn is_supported_algorithm(algorithm: &str) -> bool {
    matches!(
        algorithm,
        "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521"
    )
}

/// The PEM body between the BEGIN and END lines of `label`, base64-decoded.
fn pem_body(text: &str, label: &str) -> Result<Vec<u8>, String> {
    let begin = format!("-----BEGIN {}-----", label);
    let end = format!("-----END {}-----", label);
    let start = text
        .find(&begin)
        .map(|index| index + begin.len())
        .ok_or_else(|| UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string())?;
    let rest = text.get(start..).unwrap_or_default();
    let stop = rest
        .find(&end)
        .ok_or_else(|| DAMAGED_KEY_MESSAGE.to_string())?;
    let body: String = rest
        .get(..stop)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        // Headers such as `Proc-Type:` are not base64.
        .filter(|line| !line.is_empty() && !line.contains(':'))
        .collect();
    B64.decode(body.as_bytes())
        .map_err(|_| DAMAGED_KEY_MESSAGE.to_string())
}

/// Reads the fields of an OpenSSH container: big-endian u32 lengths and strings.
struct SshReader<'a> {
    rest: &'a [u8],
}

impl<'a> SshReader<'a> {
    fn new(rest: &'a [u8]) -> Self {
        Self { rest }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let (head, tail) = self
            .rest
            .split_at_checked(len)
            .ok_or_else(|| DAMAGED_KEY_MESSAGE.to_string())?;
        self.rest = tail;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| DAMAGED_KEY_MESSAGE.to_string())?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn string(&mut self) -> Result<&'a [u8], String> {
        let len = usize::try_from(self.u32()?).map_err(|_| DAMAGED_KEY_MESSAGE.to_string())?;
        self.take(len)
    }

    fn string_text(&mut self) -> Result<&'a str, String> {
        std::str::from_utf8(self.string()?).map_err(|_| DAMAGED_KEY_MESSAGE.to_string())
    }
}

/// Read the header of an OpenSSH private key container.
///
/// The public key blob names the algorithm and is stored in clear, so an
/// encrypted key is classified without the passphrase. The full container is
/// then parsed to refuse a damaged private section before any network work.
fn inspect_openssh(text: &str) -> Result<(String, bool), String> {
    let bytes = pem_body(text, "OPENSSH PRIVATE KEY")?;
    let mut reader = SshReader::new(&bytes);
    if reader.take(OPENSSH_MAGIC.len())? != OPENSSH_MAGIC {
        return Err(DAMAGED_KEY_MESSAGE.to_string());
    }
    let cipher = reader.string_text()?;
    reader.string()?; // KDF name
    reader.string()?; // KDF options
    if reader.u32()? != 1 {
        return Err(
            "This OpenSSH file holds more than one key. Export one key per file.".to_string(),
        );
    }
    let public_blob = reader.string()?;
    let algorithm = SshReader::new(public_blob).string_text()?;
    if algorithm == "ssh-rsa" || algorithm.starts_with("rsa-") {
        return Err(RSA_KEY_MESSAGE.to_string());
    }
    if !is_supported_algorithm(algorithm) {
        return Err(UNSUPPORTED_KEY_TYPE_MESSAGE.to_string());
    }
    russh::keys::ssh_key::PrivateKey::from_openssh(text)
        .map_err(|_| DAMAGED_KEY_MESSAGE.to_string())?;
    Ok((algorithm.to_string(), cipher != "none"))
}

fn inspect_pkcs8(text: &str) -> Result<(String, bool), String> {
    let der = pem_body(text, "PRIVATE KEY")?;
    let algorithm = pkcs8_algorithm(&der)?;
    if algorithm == "ssh-rsa" {
        return Err(RSA_KEY_MESSAGE.to_string());
    }
    Ok((algorithm.to_string(), false))
}

/// Read one DER element: its tag, its content, and the bytes after it.
fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 {
            return None;
        }
        let length_bytes = rest.get(..count)?;
        let len = length_bytes
            .iter()
            .fold(0usize, |acc, byte| (acc << 8) | usize::from(*byte));
        (len, rest.get(count..)?)
    };
    let content = rest.get(..len)?;
    let remaining = rest.get(len..)?;
    Some((tag, content, remaining))
}

/// The OpenSSH algorithm name of an unencrypted PKCS#8 private key.
fn pkcs8_algorithm(der: &[u8]) -> Result<&'static str, String> {
    let unsupported_format = || UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string();
    let unsupported_type = || UNSUPPORTED_KEY_TYPE_MESSAGE.to_string();
    let (tag, body, _) = der_element(der).ok_or_else(unsupported_format)?;
    if tag != TAG_SEQUENCE {
        return Err(unsupported_format());
    }
    let (tag, _version, rest) = der_element(body).ok_or_else(unsupported_format)?;
    if tag != TAG_INTEGER {
        return Err(unsupported_format());
    }
    let (tag, algorithm, _) = der_element(rest).ok_or_else(unsupported_format)?;
    if tag != TAG_SEQUENCE {
        return Err(unsupported_format());
    }
    let (tag, oid, params) = der_element(algorithm).ok_or_else(unsupported_format)?;
    if tag != TAG_OID {
        return Err(unsupported_format());
    }
    if oid == OID_ED25519 {
        return Ok("ssh-ed25519");
    }
    if oid == OID_RSA {
        return Ok("ssh-rsa");
    }
    if oid != OID_EC_PUBLIC_KEY {
        return Err(unsupported_type());
    }
    let (tag, curve, _) = der_element(params).ok_or_else(unsupported_type)?;
    if tag != TAG_OID {
        return Err(unsupported_type());
    }
    if curve == OID_P256 {
        Ok("ecdsa-sha2-nistp256")
    } else if curve == OID_P384 {
        Ok("ecdsa-sha2-nistp384")
    } else if curve == OID_P521 {
        Ok("ecdsa-sha2-nistp521")
    } else {
        Err(unsupported_type())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ED25519_PLAIN: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCRkyBZ92600rfExBMkwFrDDF0BAxqXHEgQKGYstxcqtQAAAJDqK6mo6iup
qAAAAAtzc2gtZWQyNTUxOQAAACCRkyBZ92600rfExBMkwFrDDF0BAxqXHEgQKGYstxcqtQ
AAAEAE8t1XXGt/u3ZreZV6XR+2fNANcdglt1cKg4PXmmgzF5GTIFn3brTSt8TEEyTAWsMM
XQEDGpccSBAoZiy3Fyq1AAAAB2ZpeHR1cmUBAgMEBQY=
-----END OPENSSH PRIVATE KEY-----
"#;

    const ECDSA_P256_PLAIN: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS
1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQTUViq1vyMegx63t9xZv0CXxK1InF5J
RaV3q/hfvsLWtBlj8hUFga0UE6MoHPJHFlbjCGw3OTzBtYsptTLPONPkAAAAoMHowhrB6M
IaAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNRWKrW/Ix6DHre3
3Fm/QJfErUicXklFpXer+F++wta0GWPyFQWBrRQToygc8kcWVuMIbDc5PMG1iym1Ms840+
QAAAAhAJG838CRT5KKWnYY71jVGaPHQXDPVCbQGSXbsQJsc1QvAAAAB2ZpeHR1cmU=
-----END OPENSSH PRIVATE KEY-----
"#;

    const ED25519_ENCRYPTED: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAyVT8oxb
t0122q6U3FPsBVAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIGZ4e87Bbp89EfaD
Wz5+fVUKnTPL+zt4jGnlhECvaA20AAAAkPUVwwyLZxQIyYN/jV+RLQh7fxmj4UpmxchuE0
uJfPiyFcZJiMRSe5J7iJL6VboroMRdkQOF+eFJSgPg96YzcGXGo/SNKRuxy8JCMZLBMWAb
3hslzGPRdkGth2jhIXTG2AHHOTwF5g3Wyl75J1ZmbRGNFECIdnv88VomVstHUFs0CmMUA2
Q/6GHwcjr9pMlOww==
-----END OPENSSH PRIVATE KEY-----
"#;

    const RSA_PLAIN: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAyYsTWyAKAKbYprtkbE7/YF1JwAtqth5A+dkxeyJz/Q445kJuSrld
kVcKKgsfE52UBAvHnPHqARjH9UoFGxSSOf1XYAQLYoYdrvY+4E6fCux8tT5h3MJIm6NBPy
b4Dsu2JmiROM7zZVtuhclJ1JY1qr6RE8c2jcEHAmMRGA78hvOzaFB0OncheY8MywVYx0os
9jybhYtqOPBsdCr4vQa1BKReS95l2V/KgrhB4zvPtWWgV0zme6Akh9PP16QsSBBJ/PUJwW
Nx064NMZCbEsSuNIWCG80wmtRuuLhaVqpg13g+fRZvG41tE1Sut1auIKVoUVBQeLV43ZL3
CKpZVJY0EwAAA8ACql4yAqpeMgAAAAdzc2gtcnNhAAABAQDJixNbIAoAptimu2RsTv9gXU
nAC2q2HkD52TF7InP9DjjmQm5KuV2RVwoqCx8TnZQEC8ec8eoBGMf1SgUbFJI5/VdgBAti
hh2u9j7gTp8K7Hy1PmHcwkibo0E/JvgOy7YmaJE4zvNlW26FyUnUljWqvpETxzaNwQcCYx
EYDvyG87NoUHQ6dyF5jwzLBVjHSiz2PJuFi2o48Gx0Kvi9BrUEpF5L3mXZX8qCuEHjO8+1
ZaBXTOZ7oCSH08/XpCxIEEn89QnBY3HTrg0xkJsSxK40hYIbzTCa1G64uFpWqmDXeD59Fm
8bjW0TVK63Vq4gpWhRUFB4tXjdkvcIqllUljQTAAAAAwEAAQAAAQEAu8Avm+hQ6SKFGW3g
s3U0OhUtqxX3pwiwBxDqI4eI/ejN4NNp43qjS84FzfzmSmO1i79diTtjfvoS7NKzxvJ29k
anqu6ZnILMDD2hfVxAlPCRjFY83GaxNSv0kFxBIadsXIN1JbLE01tFrqRBfyUfgZxdkks2
6v8zBGo9dmgfn6anjewPaDRXGD90rHfTM2SDddBLP/fOheHlYNtb/UsaEEee9BEJbbWfUo
001IB3bJLJgRA03vXVzaF2osQ+sSY/FXB1JddxJl6+LQPVQ1kCCMRM6q3CH2dPY4LHKGqg
NppjbR9GsZdzFKtkSKA1BUyPCMswbeSK4FSS2wOpuY55oQAAAIEAxCTiXZSeCaI3ji0qPj
Lg3ClItL+hygFKw9P9MbOSZx+CIX2zOLGcxtOrYogFCXmIIhHBEHPyIKwz7qCu9O0Cl5VV
mlsS9pr8MUVeF0vQzhHPEea3rtqAxmjgQoKtyKsf+2qzcnXkxADKLuuy3CAjfNouXv0t9W
wvd77r8Wb+bj0AAACBAO2ESWIY+2ySElVnq5P7Msnpj7jQXeozEElF0Jg4j3ZYxfOuNCwq
I83sr4iO0IKdBsNfXmnjY2JJWNlRZQeGrL7LRdTRNZcPDXndaL/LAtLsyPmYfTtLzPL1a3
43+8eAZCiIt116FwQcsilndF/+Zim057yBPchXgXES03Q4+mplAAAAgQDZOiPDXZjk1nxg
he8DOmObOlkeasMAH/jQIOGtjRuEqnyEoagn8cIlcYBMXizkArU3bHXZor4OMUzWVjs/CD
/ETlnF7XWg8gOqaKj+9YMA/oxBMz7dFY9ydYRD6XjOgQyhVjpjU4t9hq8pzP0Z1J3sp4lD
PFTqr/f7Z1iCqhdBFwAAAAdmaXh0dXJlAQI=
-----END OPENSSH PRIVATE KEY-----
"#;

    const PKCS8_ED25519: &str = r#"-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKJ1mZNvv91Ek0sTsEJo6D3jUtZkiyO0gbzA1sbUGlPO
-----END PRIVATE KEY-----
"#;

    const PKCS8_ED25519_ENCRYPTED: &str = r#"-----BEGIN ENCRYPTED PRIVATE KEY-----
MIGjMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBC5QuE1h95TdubnCH0T
4ZoLAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQPeRvxXTPaVfXOpjE
PoZbwwRAuoqFDg5JR+T6n53QvS3qSOCzFYwsVZcPBbjBfW4H0msdeEEEp9hlmm00
UgyoVi+rA4Tb6Ga8aKcH38Xqyzle2g==
-----END ENCRYPTED PRIVATE KEY-----
"#;

    const PKCS8_RSA: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDd9at/P4iAsrPd
4aYlQ12K8YDGTfdfGN7X3LUOld7YMh/tI9zvcuyHoseWR/yULZ8pNDGLWqJT65nr
HUxMfahM5Bou6i/fYVH2ph+C7ZUV3ZLjpDKw0sQjUsBhoKicTmNpjOpmDot5EQTp
vMCudvQeOEu3rQJuArYVMsypzcyiVkt4TMNbEUV4wz4OBoasgyVKJUQtrbTt/gfa
f852TIKhKbsB1fq9YRt0FyoP0gJELzrF5pu96UPnQSBGTs35gQa6tNoPEC0j7tiA
Dz4yvhTGuVnh/KauFx3YfSdUYqUvAC/jq9vBi/j0AB1PuNMKjlPWeZxK+Kor7ZL7
13MFmP1vAgMBAAECggEAEoymcXL40HCe0Ys7HGAd4C/AqFH5u2vTq8yZIQfrYLwH
qQTXQPekxs0WyvtnI2cQpxvijBfd+w90hI6lQrs5pntlqMgPiiaS9/74ITQDwpkK
3pVpWxeyJpWS2FXZ4X43lqmdKTxL8ak3dOU+YRY13pSr10TRMCpv1yOwsPwu/t35
eD+GYcAoVNipg24SRaIppd5XljacIRI9L6XNm/4C0PUPQgYM+RZM3iENci7s825L
GpPgFYStY5LSHakR/QGcGTkRgTq2thBErPpm+mib+naMtbzpvhGJrKbiTG7A9Y71
TRguVwoL9OURhLL6l1D84HI2UQYL8TIG+oZAzrK+gQKBgQD7gMQ+ywfV+Rk5ZliY
E1aTGqg9rLvIyROvpRPJ/DJ07QmtA7gggUylKREEA+14XYd0Cd3SnC+sTcs89NcD
WzmcxW6BA0rQ0GATsHp6+uCVdqT/YAcjkax8tzjTGlOxyGY77yZ/cuMD2k1kjohl
lblJZId6ZV/a9QnZ0Dt5B5RrwQKBgQDh7avTExK7r6rXu5BP7T2eSjmCnyFlK9zT
DJIlZGKOwbuNN6/fCuVNd9ovbivn4Vy7beJtXGVekFYSaRwyGV3YOk2m8vzwOZ4Q
tONt+LzOrO3UuMHLU5q84puksyljSLDoyBgzQil+wU9UyWRvx5VS64PJx3qR1Q/u
nb1hepp1LwKBgQCSfOHRITijLL/AaxhXG4xlijVMFvwZauUIfUIVd8t7x0THfU8V
v7oAyPacPB1o6jEnKUgGj+pElds22fUSg2P/KA/BHUXKclRDo5rzXoTJCZ35ENmX
ohWxXpa+fqsY9fx2FEl8GlKXv+MsGsjfQmH1mZQ/eiRmyCrAr0S0rfGJAQKBgQCR
9d6gSx47K06QeZjOSlMYxJNLFEua9S+BGgoBJk2WNQtaPLPewUdLOTc4lVDAShSC
8obqaFsFMPKqikWxCDpcy64HQcyv1kmMOZEFJ0GztH0ihQqOtcCubyhmy2jdv8Sr
XzpjQ0dToMgD2uiMXsDWBVnrLni9Zo0Yd8g2BeNr+QKBgBFp/Z7wBMa6xl4ZCAYG
1VigZgukZkVb8lNFB37jNcvAqhUj62GEY40JenbD3MAsi0NCzqNBHdiAx5J0zS+T
Vvcos54pYv65e8JZuELH942MHA/fMdyuvv/qa0oKpKcS7ZO8tfqBKrxaq/IX992g
nA4o4PeGit97sB//cSwGn9ai
-----END PRIVATE KEY-----
"#;

    const SEC1_EC_P256: &str = r#"-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIL3cLBA2TiPnK2NaP59/hgMyk1DEGteheItX54ErNEeoAoGCCqGSM49
AwEHoUQDQgAEAXYMtLli+as7rKBLiNSk6HU1Z78EvXQsfTfiCk7WMJAtN6DKaPmR
LteiRWwXABXTzJM8n+MBzAv/TNXUAokXAA==
-----END EC PRIVATE KEY-----
"#;

    const PUBLIC_KEY_LINE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGTIFn3brTSt8TEEyTAWsMMXQEDGpccSBAoZiy3Fyq1 fixture";

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "s3-sidekick-keyfile-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn refuses_putty_ppk_files_with_the_conversion_message() {
        let ppk = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n";
        assert_eq!(inspect_private_key(ppk), Err(PPK_MESSAGE.to_string()));
    }

    #[test]
    fn a_ppk_header_after_a_byte_order_mark_is_still_refused() {
        let ppk = "\u{feff}PuTTY-User-Key-File-2: ssh-ed25519\n";
        assert_eq!(inspect_private_key(ppk), Err(PPK_MESSAGE.to_string()));
    }

    #[test]
    fn refuses_pem_rsa_keys_with_the_rsa_message() {
        let pem =
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";
        assert_eq!(inspect_private_key(pem), Err(RSA_KEY_MESSAGE.to_string()));
    }

    #[test]
    fn refuses_openssh_rsa_keys_with_the_rsa_message() {
        assert_eq!(
            inspect_private_key(RSA_PLAIN),
            Err(RSA_KEY_MESSAGE.to_string())
        );
    }

    #[test]
    fn refuses_pkcs8_rsa_keys_with_the_rsa_message() {
        assert_eq!(
            inspect_private_key(PKCS8_RSA),
            Err(RSA_KEY_MESSAGE.to_string())
        );
    }

    #[test]
    fn reports_an_unencrypted_ed25519_openssh_key() {
        assert_eq!(
            inspect_private_key(ED25519_PLAIN),
            Ok(("ssh-ed25519".to_string(), false))
        );
    }

    #[test]
    fn reports_an_ecdsa_p256_openssh_key() {
        assert_eq!(
            inspect_private_key(ECDSA_P256_PLAIN),
            Ok(("ecdsa-sha2-nistp256".to_string(), false))
        );
    }

    #[test]
    fn reports_an_encrypted_openssh_key_without_needing_the_passphrase() {
        assert_eq!(
            inspect_private_key(ED25519_ENCRYPTED),
            Ok(("ssh-ed25519".to_string(), true))
        );
    }

    #[test]
    fn reports_an_unencrypted_pkcs8_ed25519_key() {
        assert_eq!(
            inspect_private_key(PKCS8_ED25519),
            Ok(("ssh-ed25519".to_string(), false))
        );
    }

    #[test]
    fn reports_an_encrypted_pkcs8_key_as_encrypted_with_an_unknown_algorithm() {
        assert_eq!(
            inspect_private_key(PKCS8_ED25519_ENCRYPTED),
            Ok(("unknown".to_string(), true))
        );
    }

    #[test]
    fn refuses_sec1_ec_pem_keys_as_an_unsupported_format() {
        assert_eq!(
            inspect_private_key(SEC1_EC_P256),
            Err(UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string())
        );
    }

    #[test]
    fn refuses_public_keys_and_plain_text_as_an_unsupported_format() {
        for text in [PUBLIC_KEY_LINE, "hello world\n", ""] {
            assert_eq!(
                inspect_private_key(text),
                Err(UNSUPPORTED_KEY_FORMAT_MESSAGE.to_string()),
                "text must be refused: {text:?}"
            );
        }
    }

    #[test]
    fn refuses_a_truncated_openssh_container() {
        let truncated: String = ED25519_PLAIN.lines().take(3).collect::<Vec<_>>().join("\n")
            + "\n-----END OPENSSH PRIVATE KEY-----\n";
        assert!(inspect_private_key(&truncated).is_err());
    }

    #[test]
    fn refuses_an_openssh_key_with_a_damaged_body() {
        // The base64 of "openssh-key-v1" starts the body; changing its last byte
        // breaks the magic, so the container is refused before any field is read.
        let damaged = ED25519_PLAIN.replacen("b3BlbnNzaC1rZXktdjE", "b3BlbnNzaC1rZXktdjI", 1);
        assert_ne!(damaged, ED25519_PLAIN, "the fixture must actually change");
        assert_eq!(
            inspect_private_key(&damaged),
            Err(DAMAGED_KEY_MESSAGE.to_string())
        );
    }

    #[test]
    fn reads_a_regular_key_file_and_returns_only_its_bare_name() {
        let dir = scratch_dir("regular");
        let path = dir.join("work-key");
        std::fs::write(&path, ED25519_PLAIN).expect("write key");
        let info = read_private_key_file(&path).expect("regular key is accepted");
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert!(!info.encrypted);
        assert_eq!(info.file_name, "work-key");
        assert!(info.key_text.contains("BEGIN OPENSSH PRIVATE KEY"));
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }

    #[test]
    fn refuses_a_directory_and_a_missing_file() {
        let dir = scratch_dir("nonregular");
        assert!(read_private_key_file(&dir).is_err());
        assert!(read_private_key_file(&dir.join("absent")).is_err());
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symbolic_link_even_when_it_points_at_a_valid_key() {
        let dir = scratch_dir("symlink");
        let target = dir.join("real-key");
        std::fs::write(&target, ED25519_PLAIN).expect("write key");
        let link = dir.join("linked-key");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        let err = read_private_key_file(&link).err().unwrap_or_default();
        assert!(err.contains("symbolic link"), "unexpected message: {err}");
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }

    #[test]
    fn refuses_a_file_over_the_size_limit() {
        let dir = scratch_dir("oversize");
        let path = dir.join("big-key");
        std::fs::write(&path, vec![b'A'; MAX_PRIVATE_KEY_BYTES + 1]).expect("write big file");
        assert!(read_private_key_file(&path).is_err());
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }

    #[test]
    fn refuses_non_utf8_content() {
        let dir = scratch_dir("binary");
        let path = dir.join("binary-key");
        std::fs::write(&path, [0xff_u8, 0xfe, 0x00, 0x81]).expect("write binary file");
        assert!(read_private_key_file(&path).is_err());
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }

    #[test]
    fn a_granted_ppk_file_is_refused_with_the_conversion_message() {
        let dir = scratch_dir("ppk");
        let path = dir.join("legacy.ppk");
        std::fs::write(&path, "PuTTY-User-Key-File-3: ssh-ed25519\n").expect("write ppk");
        assert_eq!(
            read_private_key_file(&path).err(),
            Some(PPK_MESSAGE.to_string())
        );
        std::fs::remove_dir_all(&dir).expect("remove scratch dir");
    }
}
