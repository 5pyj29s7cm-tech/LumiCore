use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use crate::native_identity::{native_client_identity, NativeClientIdentity};

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

fn request_bootstrap(
    proof: &str,
    existing_token: Option<&str>,
    native_identity: &NativeClientIdentity,
    product_identifier: Option<&str>,
) -> Result<(u16, Value), String> {
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
    let body = serde_json::to_vec(&serde_json::json!({
        "nativeClientIdentity": native_identity,
        "sharedBackendReuse": product_identifier.is_some(),
        "nativeProductIdentifier": product_identifier,
    }))
    .map_err(|error| format!("Unable to serialize the native client identity: {error}"))?;
    let request = format!(
        "POST /api/auth/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Lumi-Desktop-Bootstrap: {proof}\r\n{authorization}\r\n",
        body.len(),
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendLease {
    version: u8,
    pid: u32,
    hostname: String,
    data_root: String,
    data_root_digest: String,
    owner_token: String,
    process_start_identity: String,
    lease_purpose: Option<String>,
}

fn read_backend_lease() -> Result<Option<BackendLease>, String> {
    read_backend_lease_at(&desktop_data_root()?)
}

fn read_backend_lease_at(root: &std::path::Path) -> Result<Option<BackendLease>, String> {
    let file = root.join("runtime").join("backend-instance.lock");
    let metadata = match std::fs::symlink_metadata(&file) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Unable to inspect the current backend lease".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("The current backend lease is not a bounded regular file".into());
    }
    let lease: BackendLease = serde_json::from_slice(
        &std::fs::read(&file).map_err(|_| "Unable to read the current backend lease")?,
    )
    .map_err(|_| "The current backend lease is malformed")?;
    let canonical = root
        .canonicalize()
        .map_err(|_| "Unable to resolve the current backend data root")?;
    if lease.version != 1
        || lease.pid == 0
        || !is_base64url_secret(&lease.owner_token)
        || sysinfo::System::host_name().map(|name| name.trim().to_lowercase())
            != Some(lease.hostname.to_lowercase())
        || lease.lease_purpose.as_deref().unwrap_or("backend") != "backend"
        || PathBuf::from(&lease.data_root).canonicalize().ok().as_ref() != Some(&canonical)
        || file.canonicalize().ok().and_then(|path| {
            path.parent()
                .and_then(|parent| parent.parent())
                .map(|p| p.to_path_buf())
        }) != Some(canonical)
    {
        return Err("The backend lease does not belong to this canonical Lumi data root".into());
    }
    let digest_path = if cfg!(windows) {
        lease.data_root.to_lowercase()
    } else {
        lease.data_root.clone()
    };
    if format!("{:x}", Sha256::digest(digest_path.as_bytes())) != lease.data_root_digest {
        return Err("The backend lease data-root digest is invalid".into());
    }
    Ok(Some(lease))
}

#[cfg(target_os = "windows")]
fn windows_process_start_identity(pid: u32) -> Result<String, String> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetProcessTimes(
            handle: *mut std::ffi::c_void,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    let handle = unsafe { OpenProcess(0x1000, 0, pid) };
    if handle.is_null() {
        return Err("Unable to inspect the leased backend process start identity".into());
    }
    let mut times = [
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
    ];
    let [created, exited, kernel, user] = &mut times;
    let ok = unsafe { GetProcessTimes(handle, created, exited, kernel, user) };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return Err("Unable to read the leased backend process start identity".into());
    }
    let ticks = (((times[0].high as u64) << 32) | times[0].low as u64)
        .checked_add(504911232000000000)
        .ok_or("The leased backend process start identity overflowed")?;
    Ok(format!("win-start-ticks:{ticks}"))
}

fn live_lease_owner(lease: &BackendLease) -> Result<bool, String> {
    let system = sysinfo::System::new_all();
    let Some(process) = system.process(sysinfo::Pid::from(lease.pid as usize)) else {
        return Ok(false);
    };
    #[cfg(target_os = "windows")]
    {
        let _ = process;
        return Ok(lease.process_start_identity == windows_process_start_identity(lease.pid)?);
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{}/stat", lease.pid))
            .map_err(|_| "Unable to verify the backend process")?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| "Unable to verify the backend boot identity")?;
        let fields = stat
            .rsplit_once(')')
            .ok_or("Invalid backend process state")?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        return Ok(lease.process_start_identity
            == format!(
                "linux:{}:{}",
                boot.trim(),
                fields.get(19).ok_or("Missing backend process start time")?
            ));
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = process;
        Err("Shared backend process identity is not supported on this platform".into())
    }
}

fn request_backend_version() -> Result<Value, String> {
    let port = backend_port()?;
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "Invalid Lumi loopback endpoint")?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "The leased Lumi backend is not reachable")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!(
                "GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|_| "Unable to request the leased backend version")?;
    let mut response = Vec::new();
    stream
        .take((MAX_HTTP_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|_| "Unable to read the leased backend version")?;
    if response.len() > MAX_HTTP_RESPONSE_BYTES {
        return Err("The backend version exceeded the size limit".into());
    }
    let (status, body) = parse_http_response(&response)?;
    if status != 200 {
        return Err("The leased Lumi backend version is unavailable".into());
    }
    Ok(body)
}

fn validate_reuse_version(pid: u32, version: &Value) -> Result<(), String> {
    if version.get("pid").and_then(Value::as_u64) != Some(pid as u64) {
        return Err("The loopback backend does not match the current data-root lease owner".into());
    }
    if version.get("sharedBackendProtocol").and_then(Value::as_u64) != Some(1) {
        return Err("The current Lumi backend must be updated before another edition can attach. It was left running.".into());
    }
    Ok(())
}

pub(crate) fn bootstrap_identity(
    existing_token: Option<&str>,
    product_identifier: Option<&str>,
) -> Result<Value, String> {
    let native_identity = native_client_identity()?;
    for attempt in 0..2 {
        let proof = read_bootstrap_proof()?;
        let (status, body) =
            request_bootstrap(&proof, existing_token, &native_identity, product_identifier)?;
        if (200..300).contains(&status) {
            if product_identifier.is_some() {
                let expected = serde_json::to_value(&native_identity)
                    .map_err(|_| "Unable to verify the native identity")?;
                if body.get("success").and_then(Value::as_bool) != Some(true)
                    || !body
                        .get("desktopSessionProof")
                        .and_then(Value::as_str)
                        .map(is_base64url_secret)
                        .unwrap_or(false)
                    || !expected
                        .as_object()
                        .map(|fields| {
                            fields.iter().all(|(key, value)| {
                                body.get("nativeClientIdentity")
                                    .and_then(|identity| identity.get(key))
                                    == Some(value)
                            })
                        })
                        .unwrap_or(false)
                    || read_bootstrap_proof()? == proof
                {
                    return Err("The shared backend did not verify and consume this exact native bootstrap proof".into());
                }
            }
            return Ok(body);
        }
        if attempt == 0
            && (matches!(status, 401 | 403) || (status == 409 && product_identifier.is_none()))
        {
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        return Err(format!(
            "Native identity bootstrap failed ({status}): {}",
            body.get("error")
                .and_then(Value::as_str)
                .unwrap_or("Native identity bootstrap was rejected")
        ));
    }
    Err("Native identity bootstrap failed".into())
}

/// Reuse requires the private canonical-root lease, its live process identity,
/// the exact loopback PID, and a consumed/rotated native proof. No process is stopped.
pub(crate) fn reuse_existing_backend(product_identifier: &str) -> Result<Option<u32>, String> {
    let Some(lease) = read_backend_lease()? else {
        return Ok(None);
    };
    if !live_lease_owner(&lease)? {
        return Ok(None);
    }
    validate_reuse_version(lease.pid, &request_backend_version()?)?;
    let _ = bootstrap_identity(None, Some(product_identifier))?;
    let current =
        read_backend_lease()?.ok_or("The shared backend lease disappeared during bootstrap")?;
    if current.pid != lease.pid
        || current.owner_token != lease.owner_token
        || !live_lease_owner(&current)?
    {
        return Err("The shared backend lease changed during bootstrap".into());
    }
    validate_reuse_version(lease.pid, &request_backend_version()?)?;
    Ok(Some(lease.pid))
}

#[tauri::command]
pub fn bootstrap_local_identity(
    app: tauri::AppHandle,
    existing_token: Option<String>,
) -> Result<Value, String> {
    let state = app.state::<Mutex<crate::BackendProcesses>>();
    let (attached_pid, error) = {
        let processes = state
            .lock()
            .map_err(|_| "Unable to inspect the backend startup result")?;
        (processes.attached_pid, processes.startup_error.clone())
    };
    if let Some(error) = error {
        return Err(error);
    }
    if let Some(pid) = attached_pid {
        let lease = read_backend_lease()?.ok_or("The attached backend lease is unavailable")?;
        if lease.pid != pid || !live_lease_owner(&lease)? {
            return Err("The attached backend process changed".into());
        }
        validate_reuse_version(pid, &request_backend_version()?)?;
        return bootstrap_identity(existing_token.as_deref(), Some(&app.config().identifier));
    }
    bootstrap_identity(existing_token.as_deref(), None)
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

    #[test]
    fn shared_protocol_never_substitutes_for_the_exact_lease_owner_pid() {
        assert!(super::validate_reuse_version(
            42,
            &serde_json::json!({"pid": 43, "sharedBackendProtocol": 1})
        )
        .is_err());
        assert!(super::validate_reuse_version(42, &serde_json::json!({"pid": 42})).is_err());
        // Different edition/build identifiers do not change this backend contract.
        assert!(super::validate_reuse_version(42, &serde_json::json!({"pid": 42, "sharedBackendProtocol": 1, "buildId": "different-edition"})).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_a_canonical_root_mismatch_before_authentication() {
        let root = std::env::temp_dir().join(format!("lumi-reuse-root-{}", std::process::id()));
        let other = root.join("other");
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let data_root = other.to_string_lossy().to_string();
        let digest = format!(
            "{:x}",
            <sha2::Sha256 as sha2::Digest>::digest(data_root.to_lowercase().as_bytes())
        );
        std::fs::write(root.join("runtime/backend-instance.lock"), serde_json::to_vec(&serde_json::json!({
            "version": 1, "pid": std::process::id(), "hostname": sysinfo::System::host_name().unwrap(),
            "dataRoot": data_root, "dataRootDigest": digest, "ownerToken": "a".repeat(64),
            "processStartIdentity": super::windows_process_start_identity(std::process::id()).unwrap(), "leasePurpose": "backend"
        })).unwrap()).unwrap();
        assert!(super::read_backend_lease_at(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shared_reuse_requires_live_identity_and_a_rotated_exact_native_proof() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        struct Fixture {
            root: PathBuf,
            previous_root: Option<std::ffi::OsString>,
            previous_port: Option<std::ffi::OsString>,
            stop: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<usize>>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                self.stop.store(true, Ordering::SeqCst);
                if let Some(thread) = self.thread.take() {
                    thread.join().unwrap();
                }
                match &self.previous_root {
                    Some(value) => std::env::set_var("LUMI_DATA_DIR", value),
                    None => std::env::remove_var("LUMI_DATA_DIR"),
                };
                match &self.previous_port {
                    Some(value) => std::env::set_var("PORT", value),
                    None => std::env::remove_var("PORT"),
                };
                std::fs::remove_dir_all(&self.root).unwrap();
            }
        }
        for rotate in [false, true] {
            let root = std::env::temp_dir()
                .join(format!("lumi-reuse-proof-{}-{rotate}", std::process::id()));
            std::fs::create_dir_all(root.join("runtime")).unwrap();
            let data_root = root.to_string_lossy().to_string();
            let digest = format!(
                "{:x}",
                <sha2::Sha256 as sha2::Digest>::digest(data_root.to_lowercase().as_bytes())
            );
            std::fs::write(root.join("runtime/backend-instance.lock"), serde_json::to_vec(&serde_json::json!({
                "version": 1, "pid": std::process::id(), "hostname": sysinfo::System::host_name().unwrap(),
                "dataRoot": data_root, "dataRootDigest": digest, "ownerToken": "a".repeat(64),
                "processStartIdentity": super::windows_process_start_identity(std::process::id()).unwrap(), "leasePurpose": "backend"
            })).unwrap()).unwrap();
            let proof = root.join("runtime/desktop-bootstrap.json");
            std::fs::write(&proof, serde_json::to_vec(&serde_json::json!({"version": 1, "proof": "a".repeat(64), "createdAt": "fixture", "expiresAt": "fixture"})).unwrap()).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let previous_root = std::env::var_os("LUMI_DATA_DIR");
            let previous_port = std::env::var_os("PORT");
            std::env::set_var("LUMI_DATA_DIR", &root);
            std::env::set_var("PORT", port.to_string());
            let stop = Arc::new(AtomicBool::new(false));
            let server_stop = stop.clone();
            let thread = std::thread::spawn(move || {
                let mut requests = 0;
                while !server_stop.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(value) => value,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("{error}"),
                    };
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut raw = Vec::new();
                    let mut buffer = [0_u8; 4096];
                    let (header_end, length) = loop {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0);
                        raw.extend_from_slice(&buffer[..count]);
                        if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&raw[..end]);
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            break (end + 4, length);
                        }
                    };
                    while raw.len() < header_end + length {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0);
                        raw.extend_from_slice(&buffer[..count]);
                    }
                    let headers = String::from_utf8_lossy(&raw[..header_end]);
                    let body = if headers.starts_with("GET /api/version ") {
                        serde_json::json!({"pid": std::process::id(), "sharedBackendProtocol": 1})
                    } else {
                        assert!(headers.starts_with("POST /api/auth/bootstrap "));
                        assert!(headers
                            .contains(&format!("X-Lumi-Desktop-Bootstrap: {}", "a".repeat(64))));
                        let input: serde_json::Value =
                            serde_json::from_slice(&raw[header_end..header_end + length]).unwrap();
                        assert_eq!(input["sharedBackendReuse"], true);
                        assert_eq!(input["nativeProductIdentifier"], "com.lumiai.legal");
                        if rotate {
                            std::fs::write(&proof, serde_json::to_vec(&serde_json::json!({"version": 1, "proof": "b".repeat(64), "createdAt": "fixture", "expiresAt": "fixture"})).unwrap()).unwrap();
                        }
                        serde_json::json!({"success": true, "desktopSessionProof": "c".repeat(64), "nativeClientIdentity": input["nativeClientIdentity"]})
                    };
                    let body = serde_json::to_vec(&body).unwrap();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).unwrap();
                    stream.write_all(&body).unwrap();
                    requests += 1;
                }
                requests
            });
            let mut fixture = Fixture {
                root,
                previous_root,
                previous_port,
                stop,
                thread: Some(thread),
            };
            let result = super::reuse_existing_backend("com.lumiai.legal");
            if rotate {
                assert_eq!(result.unwrap(), Some(std::process::id()));
            } else {
                assert!(result
                    .unwrap_err()
                    .contains("consume this exact native bootstrap proof"));
            }
            fixture.stop.store(true, Ordering::SeqCst);
            let count = fixture.thread.take().unwrap().join().unwrap();
            assert_eq!(count, if rotate { 3 } else { 2 });
        }
    }
}
