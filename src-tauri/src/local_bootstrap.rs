use serde::Deserialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const MAX_PROOF_FILE_BYTES: u64 = 4096;
const MAX_HTTP_RESPONSE_BYTES: usize = 1024 * 1024;
const PRODUCT_DATA_DIRECTORY: &str = "LumiCore";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BootstrapProofFile {
    version: u8,
    proof: String,
    #[serde(rename = "createdAt")]
    _created_at: String,
    #[serde(rename = "expiresAt")]
    _expires_at: String,
}

fn configured_data_root(value: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let configured = PathBuf::from(trimmed);
    if !configured.is_absolute() {
        return Err(
            "LUMI_DATA_DIR must be absolute so native and Node runtimes share one data root"
                .to_string(),
        );
    }
    Ok(Some(configured))
}

fn desktop_data_root() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("LUMI_DATA_DIR") {
        if let Some(configured) = configured_data_root(&configured)? {
            return Ok(configured);
        }
    }
    dirs_next::home_dir()
        .map(|home| home.join(PRODUCT_DATA_DIRECTORY))
        .ok_or_else(|| "Unable to resolve the LumiCore data root".to_string())
}

fn desktop_bootstrap_proof_path() -> Result<PathBuf, String> {
    Ok(desktop_data_root()?
        .join("runtime")
        .join("desktop-bootstrap.json"))
}

fn is_base64url_secret(value: &str) -> bool {
    (32..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn read_bootstrap_proof() -> Result<String, String> {
    let data_root = desktop_data_root()?;
    let root_metadata = std::fs::symlink_metadata(&data_root)
        .map_err(|error| format!("Native Lumi data root is not ready: {error}"))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("Native Lumi data root must be a real directory".to_string());
    }
    let runtime_path = data_root.join("runtime");
    let runtime_metadata = std::fs::symlink_metadata(&runtime_path)
        .map_err(|error| format!("Native Lumi runtime directory is not ready: {error}"))?;
    if !runtime_metadata.is_dir() || runtime_metadata.file_type().is_symlink() {
        return Err("Native Lumi runtime path must be a real directory".to_string());
    }
    let proof_path = desktop_bootstrap_proof_path()?;
    let metadata = std::fs::symlink_metadata(&proof_path)
        .map_err(|error| format!("Native bootstrap handoff is not ready: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Native bootstrap handoff is not a regular file".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_PROOF_FILE_BYTES {
        return Err("Native bootstrap handoff has an invalid size".to_string());
    }

    let canonical_root = data_root
        .canonicalize()
        .map_err(|error| format!("Unable to verify the Lumi data root: {error}"))?;
    let canonical_proof = proof_path
        .canonicalize()
        .map_err(|error| format!("Unable to verify the native bootstrap handoff: {error}"))?;
    let canonical_runtime = runtime_path
        .canonicalize()
        .map_err(|error| format!("Unable to verify the Lumi runtime directory: {error}"))?;
    if canonical_runtime.parent() != Some(canonical_root.as_path())
        || canonical_proof.parent() != Some(canonical_runtime.as_path())
    {
        return Err("Native bootstrap handoff escaped the Lumi runtime directory".to_string());
    }

    let raw = std::fs::read_to_string(&canonical_proof)
        .map_err(|error| format!("Unable to read the native bootstrap handoff: {error}"))?;
    let parsed: BootstrapProofFile = serde_json::from_str(&raw)
        .map_err(|_| "Native bootstrap handoff is malformed".to_string())?;
    if parsed.version != 1 || !is_base64url_secret(&parsed.proof) {
        return Err("Native bootstrap handoff has an unsupported format".to_string());
    }
    Ok(parsed.proof)
}

fn backend_port() -> Result<u16, String> {
    match std::env::var("PORT") {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| "Configured Lumi backend port is invalid".to_string()),
        _ => Ok(3000),
    }
}

fn decode_chunked_body(mut input: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    loop {
        let line_end = input
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "Malformed chunked bootstrap response".to_string())?;
        let size_text = std::str::from_utf8(&input[..line_end])
            .map_err(|_| "Malformed chunk size".to_string())?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size =
            usize::from_str_radix(size_text, 16).map_err(|_| "Malformed chunk size".to_string())?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if size > input.len() || input.len() < size + 2 || &input[size..size + 2] != b"\r\n" {
            return Err("Truncated chunked bootstrap response".to_string());
        }
        if decoded.len().saturating_add(size) > MAX_HTTP_RESPONSE_BYTES {
            return Err("Native bootstrap response exceeded the size limit".to_string());
        }
        decoded.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
}

fn parse_http_response(raw: &[u8]) -> Result<(u16, Value), String> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Malformed native bootstrap HTTP response".to_string())?;
    let headers = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "Native bootstrap HTTP headers were not UTF-8".to_string())?;
    let mut lines = headers.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "Native bootstrap HTTP status is missing".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Native bootstrap HTTP status is invalid".to_string())?;
    let chunked = lines.any(|line| {
        line.split_once(':')
            .map(|(name, value)| {
                name.trim().eq_ignore_ascii_case("transfer-encoding")
                    && value.trim().eq_ignore_ascii_case("chunked")
            })
            .unwrap_or(false)
    });
    let encoded_body = &raw[header_end + 4..];
    let body = if chunked {
        decode_chunked_body(encoded_body)?
    } else {
        encoded_body.to_vec()
    };
    let parsed = serde_json::from_slice(&body)
        .map_err(|_| "Native bootstrap server returned invalid JSON".to_string())?;
    Ok((status, parsed))
}

fn request_bootstrap(proof: &str, existing_token: Option<&str>) -> Result<(u16, Value), String> {
    if !is_base64url_secret(proof) {
        return Err("Native bootstrap proof is invalid".to_string());
    }
    if let Some(token) = existing_token {
        if token.len() > 16 * 1024 || token.contains(['\r', '\n']) {
            return Err("Existing authentication token is invalid".to_string());
        }
    }

    let port = backend_port()?;
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "Unable to resolve the Lumi loopback endpoint".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| format!("Unable to reach the Lumi backend: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;

    let authorization = existing_token
        .filter(|token| !token.trim().is_empty())
        .map(|token| format!("Authorization: Bearer {}\r\n", token.trim()))
        .unwrap_or_default();
    let request = format!(
        "POST /api/auth/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\nX-Lumi-Desktop-Bootstrap: {proof}\r\n{authorization}\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|error| format!("Unable to send the native bootstrap request: {error}"))?;

    let mut response = Vec::new();
    stream
        .take((MAX_HTTP_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| format!("Unable to read the native bootstrap response: {error}"))?;
    if response.len() > MAX_HTTP_RESPONSE_BYTES {
        return Err("Native bootstrap response exceeded the size limit".to_string());
    }
    parse_http_response(&response)
}

#[tauri::command]
pub fn bootstrap_local_identity(existing_token: Option<String>) -> Result<Value, String> {
    for attempt in 0..2 {
        let proof = read_bootstrap_proof()?;
        let (status, body) = request_bootstrap(&proof, existing_token.as_deref())?;
        if (200..300).contains(&status) {
            return Ok(body);
        }
        if attempt == 0 && matches!(status, 401 | 403 | 409) {
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Native identity bootstrap was rejected");
        return Err(format!(
            "Native identity bootstrap failed ({status}): {message}"
        ));
    }
    Err("Native identity bootstrap failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        configured_data_root, decode_chunked_body, is_base64url_secret, parse_http_response,
    };
    use std::path::PathBuf;

    #[test]
    fn configured_root_matches_node_whitespace_and_absolute_path_rules() {
        assert_eq!(
            configured_data_root("   ").expect("blank uses default"),
            None
        );
        assert!(configured_data_root("relative/root").is_err());
        let absolute = if cfg!(windows) {
            PathBuf::from(r"C:\LumiCore-test")
        } else {
            PathBuf::from("/tmp/lumi-core-test")
        };
        assert_eq!(
            configured_data_root(&format!("  {}  ", absolute.display()))
                .expect("absolute configured root"),
            Some(absolute),
        );
    }

    #[test]
    fn validates_expected_proof_alphabet_and_length() {
        assert!(is_base64url_secret(&"a".repeat(64)));
        assert!(is_base64url_secret(&format!("{}-_", "A".repeat(62))));
        assert!(!is_base64url_secret("short"));
        assert!(!is_base64url_secret(&format!("{}\r", "a".repeat(64))));
    }

    #[test]
    fn parses_content_length_json_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"success\":true}";
        let (status, body) = parse_http_response(raw).expect("response should parse");
        assert_eq!(status, 200);
        assert_eq!(body["success"], true);
    }

    #[test]
    fn decodes_chunked_json_response() {
        let decoded = decode_chunked_body(b"10\r\n{\"success\":true}\r\n0\r\n\r\n")
            .expect("chunked body should parse");
        assert_eq!(decoded, b"{\"success\":true}");
    }
}
