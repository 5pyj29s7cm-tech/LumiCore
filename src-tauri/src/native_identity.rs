use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::sync::OnceLock;

const NATIVE_IDENTITY_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeClientIdentity {
    pub schema_version: u8,
    pub client_kind: String,
    pub pid: u32,
    pub started_at_unix_ms: u64,
    pub executable_path: String,
    pub executable_sha256: Option<String>,
    pub binary_hash_unavailable: bool,
    pub build_id: String,
    pub build_id_semantics: String,
    pub source_fingerprint: String,
    pub source_dirty: bool,
    pub app_version: String,
}

static NATIVE_CLIENT_IDENTITY: OnceLock<Result<NativeClientIdentity, String>> = OnceLock::new();

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("Unable to open the native executable for hashing: {error}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut hash = Sha256::new();
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Unable to hash the native executable: {error}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn native_client_identity_impl() -> Result<NativeClientIdentity, String> {
    let pid = std::process::id();
    if pid == 0 {
        return Err("Native client PID is unavailable".to_string());
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve the native client executable: {error}"))?;
    if !executable.is_absolute() {
        return Err("Native client executable path is not absolute".to_string());
    }
    let executable_path = executable
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Native client executable path is not valid UTF-8".to_string())?
        .to_string();

    let system = sysinfo::System::new_all();
    let process = system
        .process(sysinfo::Pid::from(pid as usize))
        .ok_or_else(|| "Unable to inspect the native client process".to_string())?;
    let started_at_unix_ms = process
        .start_time()
        .checked_mul(1_000)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Native client process start time is unavailable".to_string())?;

    let build_id = env!("LUMI_BUILD_ID").trim().to_ascii_lowercase();
    if !is_git_build_id(&build_id) {
        return Err("Native client build id is invalid".to_string());
    }
    let source_fingerprint = env!("LUMI_SOURCE_FINGERPRINT").trim().to_ascii_lowercase();
    if source_fingerprint.len() != 64
        || !source_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Native client source fingerprint is invalid".to_string());
    }
    let source_dirty = match env!("LUMI_SOURCE_DIRTY") {
        "true" => true,
        "false" => false,
        _ => return Err("Native client source dirty state is invalid".to_string()),
    };
    let executable_sha256 = sha256_file(&executable).ok();

    Ok(NativeClientIdentity {
        schema_version: NATIVE_IDENTITY_SCHEMA_VERSION,
        client_kind: "tauri".to_string(),
        pid,
        started_at_unix_ms,
        executable_path,
        binary_hash_unavailable: executable_sha256.is_none(),
        executable_sha256,
        build_id,
        build_id_semantics: "baseline_commit".to_string(),
        source_fingerprint,
        source_dirty,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

fn is_git_build_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn native_client_identity() -> Result<NativeClientIdentity, String> {
    NATIVE_CLIENT_IDENTITY
        .get_or_init(native_client_identity_impl)
        .clone()
}

#[tauri::command]
pub fn get_native_client_identity() -> Result<NativeClientIdentity, String> {
    native_client_identity()
}

#[cfg(test)]
mod tests {
    use super::{is_git_build_id, native_client_identity_impl, sha256_file};
    use std::path::Path;

    #[test]
    fn compile_time_build_id_is_a_full_git_object_id() {
        assert!(is_git_build_id(env!("LUMI_BUILD_ID")));
        assert!(!is_git_build_id("development"));
        assert!(!is_git_build_id(&"a".repeat(39)));
        assert!(!is_git_build_id(&"g".repeat(40)));
    }

    #[test]
    fn reports_the_current_native_process_identity() {
        let identity = native_client_identity_impl().expect("current process identity");
        assert_eq!(identity.schema_version, 1);
        assert_eq!(identity.client_kind, "tauri");
        assert_eq!(identity.pid, std::process::id());
        assert!(identity.started_at_unix_ms > 946_684_800_000);
        assert!(Path::new(&identity.executable_path).is_absolute());
        assert_eq!(
            identity.build_id,
            env!("LUMI_BUILD_ID").to_ascii_lowercase()
        );
        assert_eq!(identity.build_id_semantics, "baseline_commit");
        assert_eq!(identity.source_fingerprint.len(), 64);
        assert_eq!(identity.source_dirty, env!("LUMI_SOURCE_DIRTY") == "true");
        assert_eq!(
            identity.binary_hash_unavailable,
            identity.executable_sha256.is_none()
        );
        if let Some(ref hash) = identity.executable_sha256 {
            assert_eq!(hash.len(), 64);
            assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
            let expected = sha256_file(&std::env::current_exe().expect("current executable"))
                .expect("test executable should be hashable");
            assert_eq!(hash, &expected);
        }
        assert_eq!(identity.app_version, env!("CARGO_PKG_VERSION"));

        let wire = serde_json::to_value(&identity).expect("identity should serialize");
        assert_eq!(wire["schemaVersion"], 1);
        assert_eq!(wire["clientKind"], "tauri");
        assert_eq!(wire["buildIdSemantics"], "baseline_commit");
        assert!(wire.get("startedAtUnixMs").is_some());
        assert!(wire.get("sourceFingerprint").is_some());
        assert!(wire.get("trustLevel").is_none());
        assert!(wire.get("osAttested").is_none());
    }
}
