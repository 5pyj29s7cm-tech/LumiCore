use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::collections::HashSet;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
#[cfg(not(test))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const WINDOW_TOGGLE_SHORTCUT: &str = "Alt+Space";
const COMMAND_CENTER_SHORTCUT: &str = "Ctrl+Shift+Enter";
const COMMAND_CENTER_EVENT: &str = "lumi:open-command-center";

struct SpawnConfig {
    exe: PathBuf,
    entry: PathBuf,
    work_dir: PathBuf,
}

struct BackendProcesses {
    node: Option<Child>,
    python: Option<Child>,
    node_restarts: u32,
    python_restarts: u32,
    node_config: Option<SpawnConfig>,
}

/// Track whether wallpaper (click-through) mode is active and where to restore
/// the main window afterward.
#[derive(Default)]
struct WallpaperState {
    enabled: bool,
    previous_size: Option<tauri::PhysicalSize<u32>>,
    previous_position: Option<tauri::PhysicalPosition<i32>>,
    was_fullscreen: bool,
    was_maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallpaperMode {
    pub enabled: bool,
}

#[derive(Default)]
struct ActiveDesktopCommands {
    pids: HashMap<String, u32>,
}

struct ResidentState {
    close_to_background: bool,
    started_in_background: bool,
    force_quit: bool,
}

#[derive(Default)]
struct DesktopWidgetState {
    enabled: bool,
    previous_size: Option<tauri::PhysicalSize<u32>>,
    previous_position: Option<tauri::PhysicalPosition<i32>>,
    was_fullscreen: bool,
    was_maximized: bool,
}

#[derive(Default)]
struct CompactWindowState {
    enabled: bool,
    previous_size: Option<tauri::PhysicalSize<u32>>,
    previous_position: Option<tauri::PhysicalPosition<i32>>,
    was_fullscreen: bool,
    was_maximized: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopWidgetMode {
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompactWindowMode {
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeResilienceStatus {
    pub platform: String,
    pub autostart_supported: bool,
    pub autostart_enabled: bool,
    pub autostart_entry: String,
    pub close_to_background: bool,
    pub started_in_background: bool,
    pub backend_node_running: bool,
    pub backend_python_running: bool,
    pub node_restarts: u32,
    pub python_restarts: u32,
    pub global_shortcut: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub platform: String,
    pub release: String,
    pub arch: String,
    pub hostname: String,
    pub total_memory: u64,
    pub free_memory: u64,
    pub home_dir: String,
    pub cpus: usize,
    pub logical_cpus: usize,
    pub cpu_model: String,
    pub memory_unit: String,
    pub uptime: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub output: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopCapabilityStatus {
    pub platform: String,
    pub shell_available: bool,
    pub app_discovery_available: bool,
    pub app_launch_available: bool,
    pub screen_capture_available: bool,
    pub input_available: bool,
    pub accessibility_permission: String,
    pub screen_recording_permission: String,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> MacCGRect;
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct MacCGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct MacCGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct MacCGRect {
    origin: MacCGPoint,
    size: MacCGSize,
}

#[cfg(target_os = "macos")]
fn mac_main_display_input_geometry() -> (i32, i32, u32, u32) {
    let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    (
        bounds.origin.x.round() as i32,
        bounds.origin.y.round() as i32,
        bounds.size.width.max(0.0).round() as u32,
        bounds.size.height.max(0.0).round() as u32,
    )
}

#[tauri::command]
fn get_desktop_capability_status() -> DesktopCapabilityStatus {
    #[cfg(target_os = "macos")]
    {
        let accessibility_granted = unsafe { AXIsProcessTrusted() };
        let screen_recording_granted = unsafe { CGPreflightScreenCaptureAccess() };
        return DesktopCapabilityStatus {
            platform: "macos".to_string(),
            shell_available: true,
            app_discovery_available: true,
            app_launch_available: true,
            screen_capture_available: screen_recording_granted,
            input_available: accessibility_granted,
            accessibility_permission: if accessibility_granted {
                "granted"
            } else {
                "required"
            }
            .to_string(),
            screen_recording_permission: if screen_recording_granted {
                "granted"
            } else {
                "required"
            }
            .to_string(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        DesktopCapabilityStatus {
            platform: "windows".to_string(),
            shell_available: true,
            app_discovery_available: true,
            app_launch_available: true,
            screen_capture_available: true,
            input_available: true,
            accessibility_permission: "not_required".to_string(),
            screen_recording_permission: "not_required".to_string(),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        DesktopCapabilityStatus {
            platform: std::env::consts::OS.to_string(),
            shell_available: true,
            app_discovery_available: false,
            app_launch_available: true,
            screen_capture_available: false,
            input_available: true,
            accessibility_permission: "unknown".to_string(),
            screen_recording_permission: "unknown".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NativeFile {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NativePathInfo {
    pub exists: bool,
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextFileWriteResult {
    pub success: bool,
    pub status: String,
    pub path: String,
    pub bytes_written: u64,
    pub encoding: String,
    pub overwrite_policy: String,
    pub overwritten: bool,
    pub read_back_matched: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextFileReadResult {
    pub success: bool,
    pub path: String,
    pub content: String,
    pub bytes_read: u64,
    pub encoding: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeAppEntry {
    pub app_id: String,
    pub label: String,
    pub path: String,
    pub source: String,
    pub aliases: Vec<String>,
    pub score: i32,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppLaunchHistoryEntry {
    app_id: String,
    path: String,
    args: Vec<String>,
    source: String,
    last_success_ms: u64,
}

fn system_time_to_ms(time: std::io::Result<SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
}

fn read_native_files(dir: &Path, limit: Option<usize>) -> Vec<NativeFile> {
    let entries = std::fs::read_dir(dir);
    let mut files: Vec<NativeFile> = match entries {
        Ok(iter) => iter
            .filter_map(|e| e.ok())
            .map(|e| {
                let path = e.path();
                let metadata = e.metadata().ok();
                let is_dir = metadata
                    .as_ref()
                    .map(|m| m.is_dir())
                    .unwrap_or_else(|| path.is_dir());
                let modified_ms = metadata
                    .as_ref()
                    .and_then(|m| system_time_to_ms(m.modified()));
                NativeFile {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    is_directory: is_dir,
                    size: metadata
                        .as_ref()
                        .filter(|m| !m.is_dir())
                        .map(|m| m.len())
                        .unwrap_or(0),
                    modified_ms,
                }
            })
            .collect(),
        Err(_) => vec![],
    };

    files.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    files.truncate(limit.unwrap_or(200).clamp(1, 1000));
    files
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    use sysinfo::System;
    let sys = System::new_all();
    let cpu_model = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .unwrap_or_default();
    SystemInfo {
        platform: std::env::consts::OS.to_string(),
        release: System::long_os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: System::host_name().unwrap_or_default(),
        total_memory: sys.total_memory(),
        free_memory: sys.available_memory(),
        home_dir: dirs_next::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        cpus: sys.physical_core_count().unwrap_or(1),
        logical_cpus: sys.cpus().len(),
        cpu_model,
        memory_unit: "bytes".to_string(),
        uptime: System::uptime(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TempReading {
    pub label: String,
    pub celsius: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LiveStats {
    pub cpu_percent: f32,
    pub memory_used_gb: f32,
    pub memory_total_gb: f32,
    pub memory_percent: f32,
    pub gpu_vendor: Option<String>,
    pub gpu_utilization: Option<f32>,
    pub temperatures: Vec<TempReading>,
    pub fan_speed_rpm: Option<f32>,
    pub hostname: String,
    pub uptime_seconds: u64,
}

fn detect_gpu() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut powershell = Command::new("powershell");
        powershell
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Idd|Indirect|Mirror|Virtual' } | Select-Object -First 1 -ExpandProperty Name",
            ])
            .creation_flags(0x08000000u32);
        if let Ok(out) = powershell.output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }

        // Older Windows images may still expose WMIC when PowerShell CIM fails.
        let mut cmd = Command::new("wmic");
        cmd.args([
            "path",
            "Win32_VideoController",
            "get",
            "name",
            "/format:csv",
        ]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000u32);
        }
        let output = cmd.output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines().skip(2) {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[1].trim();
                    // Skip virtual/indirect display adapters
                    if !name.is_empty()
                        && !name.contains("Idd")
                        && !name.contains("Indirect")
                        && !name.contains("Mirror")
                        && !name.contains("Virtual")
                    {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("sh")
            .args(["-c", "lspci | grep -i vga | head -1 | cut -d: -f3"])
            .output();
        if let Ok(out) = output {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_gpu_usage() -> Option<f32> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ])
            .creation_flags(0x08000000u32)
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Ok(val) = text.trim().parse::<f32>() {
                return Some(val);
            }
        }
    }
    None
}

#[tauri::command]
fn get_live_stats() -> LiveStats {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(100));
    sys.refresh_cpu_all();

    let cpu_percent = sys.global_cpu_usage();
    let total_mem = sys.total_memory() as f32;
    let used_mem = sys.used_memory() as f32;
    let mem_percent = if total_mem > 0.0 {
        (used_mem / total_mem) * 100.0
    } else {
        0.0
    };

    let gpu_vendor = detect_gpu();

    #[cfg(target_os = "windows")]
    let gpu_utilization = detect_gpu_usage();

    #[cfg(not(target_os = "windows"))]
    let gpu_utilization = None;

    let components = sysinfo::Components::new_with_refreshed_list();
    let temperatures: Vec<TempReading> = components
        .iter()
        .filter(|c| c.temperature().is_some())
        .map(|c| TempReading {
            label: c.label().to_string(),
            celsius: c.temperature().unwrap(),
        })
        .collect();

    LiveStats {
        cpu_percent: cpu_percent.min(100.0),
        memory_used_gb: used_mem / 1024.0 / 1024.0 / 1024.0,
        memory_total_gb: total_mem / 1024.0 / 1024.0 / 1024.0,
        memory_percent: mem_percent,
        gpu_vendor,
        gpu_utilization,
        temperatures,
        fan_speed_rpm: None,
        hostname: System::host_name().unwrap_or_default(),
        uptime_seconds: System::uptime(),
    }
}

#[tauri::command]
fn list_home_files() -> Vec<NativeFile> {
    let home = dirs_next::home_dir().unwrap_or_default();
    read_native_files(&home, None)
}

fn resolve_user_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    let home = dirs_next::home_dir().unwrap_or_default();
    if trimmed.is_empty() || trimmed == "~" {
        return home;
    }
    if let Some(relative) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home.join(relative);
    }
    PathBuf::from(trimmed)
}

#[cfg(test)]
mod user_path_tests {
    use super::resolve_user_path;

    #[test]
    fn expands_home_relative_desktop_paths() {
        let home = dirs_next::home_dir().unwrap_or_default();
        assert_eq!(resolve_user_path("~/Desktop"), home.join("Desktop"));
        assert_eq!(resolve_user_path("~\\Desktop"), home.join("Desktop"));
    }
}

#[tauri::command]
fn list_directory(path: String, limit: Option<usize>) -> Vec<NativeFile> {
    let dir = resolve_user_path(&path);
    read_native_files(&dir, limit)
}

#[tauri::command]
fn path_info(target: String) -> NativePathInfo {
    let path = resolve_user_path(&target);
    let metadata = std::fs::metadata(&path).ok();
    let is_directory = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    NativePathInfo {
        exists: metadata.is_some(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        is_directory,
        size: metadata
            .as_ref()
            .filter(|m| !m.is_dir())
            .map(|m| m.len())
            .unwrap_or(0),
        modified_ms: metadata
            .as_ref()
            .and_then(|m| system_time_to_ms(m.modified())),
    }
}

#[tauri::command]
fn write_text_file(
    path: String,
    content: String,
    encoding: Option<String>,
    overwrite_policy: Option<String>,
) -> NativeTextFileWriteResult {
    const MAX_TEXT_FILE_BYTES: usize = 500 * 1024;

    let target = resolve_user_path(&path);
    let resolved_path = target.to_string_lossy().to_string();
    let normalized_encoding = encoding
        .unwrap_or_else(|| "utf-8".to_string())
        .trim()
        .to_ascii_lowercase();
    let normalized_policy = overwrite_policy
        .unwrap_or_else(|| "fail_if_exists".to_string())
        .trim()
        .to_ascii_lowercase();

    let failure = |message: String| NativeTextFileWriteResult {
        success: false,
        status: "failed".to_string(),
        path: resolved_path.clone(),
        bytes_written: 0,
        encoding: normalized_encoding.clone(),
        overwrite_policy: normalized_policy.clone(),
        overwritten: false,
        read_back_matched: false,
        error: Some(message),
    };

    if path.trim().is_empty() {
        return failure("A non-empty text file path is required.".to_string());
    }
    if target.file_name().is_none() {
        return failure("The target must be an exact file path, not a root directory.".to_string());
    }
    if target.is_dir() {
        return failure("The target is a directory, not a text file.".to_string());
    }

    let bytes = match normalized_encoding.as_str() {
        "utf-8" | "utf8" => content.into_bytes(),
        "utf-8-bom" | "utf8-bom" => {
            let mut value = Vec::with_capacity(content.len() + 3);
            value.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            value.extend_from_slice(content.as_bytes());
            value
        }
        _ => {
            return failure(
                "Unsupported encoding. Use utf-8 or utf-8-bom for portable text files.".to_string(),
            );
        }
    };
    if bytes.len() > MAX_TEXT_FILE_BYTES {
        return failure(format!(
            "Text content is too large ({} bytes). Maximum is {} bytes.",
            bytes.len(),
            MAX_TEXT_FILE_BYTES
        ));
    }

    let replace_existing = match normalized_policy.as_str() {
        "fail_if_exists" => false,
        "replace" => true,
        _ => {
            return failure(
                "Unsupported overwrite policy. Use fail_if_exists or replace.".to_string(),
            );
        }
    };
    let existed_before = target.exists();
    let Some(parent) = target.parent() else {
        return failure("The target has no parent directory.".to_string());
    };
    if !parent.is_dir() {
        return failure(format!(
            "Parent directory does not exist: {}",
            parent.to_string_lossy()
        ));
    }

    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if replace_existing {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = match options.open(&target) {
        Ok(value) => value,
        Err(error) => return failure(error.to_string()),
    };
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        return failure(error.to_string());
    }
    drop(file);

    let read_back_matched = std::fs::read(&target)
        .map(|written| written == bytes)
        .unwrap_or(false);
    NativeTextFileWriteResult {
        success: read_back_matched,
        status: if read_back_matched {
            "verified"
        } else {
            "unverified"
        }
        .to_string(),
        path: resolved_path,
        bytes_written: bytes.len() as u64,
        encoding: if normalized_encoding == "utf8" {
            "utf-8".to_string()
        } else if normalized_encoding == "utf8-bom" {
            "utf-8-bom".to_string()
        } else {
            normalized_encoding
        },
        overwrite_policy: normalized_policy,
        overwritten: existed_before && replace_existing,
        read_back_matched,
        error: if read_back_matched {
            None
        } else {
            Some("The native read-back did not match the requested bytes.".to_string())
        },
    }
}

#[tauri::command]
fn read_text_file(path: String) -> NativeTextFileReadResult {
    const MAX_TEXT_FILE_BYTES: u64 = 100 * 1024;

    let target = resolve_user_path(&path);
    let resolved_path = target.to_string_lossy().to_string();
    let failure = |message: String| NativeTextFileReadResult {
        success: false,
        path: resolved_path.clone(),
        content: String::new(),
        bytes_read: 0,
        encoding: "utf-8".to_string(),
        error: Some(message),
    };
    if path.trim().is_empty() {
        return failure("A non-empty text file path is required.".to_string());
    }
    let metadata = match std::fs::metadata(&target) {
        Ok(value) => value,
        Err(error) => return failure(error.to_string()),
    };
    if !metadata.is_file() {
        return failure("The target is not a file.".to_string());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return failure(format!(
            "Text file is too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_TEXT_FILE_BYTES
        ));
    }
    let bytes = match std::fs::read(&target) {
        Ok(value) => value,
        Err(error) => return failure(error.to_string()),
    };
    let (text_bytes, encoding) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (&bytes[3..], "utf-8-bom")
    } else {
        (bytes.as_slice(), "utf-8")
    };
    let content = match std::str::from_utf8(text_bytes) {
        Ok(value) => value.to_string(),
        Err(_) => return failure("The native file is not valid UTF-8 text.".to_string()),
    };
    NativeTextFileReadResult {
        success: true,
        path: resolved_path,
        content,
        bytes_read: bytes.len() as u64,
        encoding: encoding.to_string(),
        error: None,
    }
}

fn sanitize_child_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name is required".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("Name contains characters that Windows cannot use".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
fn create_directory(parent: String, name: String) -> CommandResult {
    let folder_name = match sanitize_child_name(&name) {
        Ok(value) => value,
        Err(output) => {
            return CommandResult {
                success: false,
                output,
            };
        }
    };
    let parent_path = if parent.trim().is_empty() {
        dirs_next::home_dir().unwrap_or_default()
    } else {
        PathBuf::from(parent)
    };
    let target = parent_path.join(folder_name);
    match std::fs::create_dir(&target) {
        Ok(_) => CommandResult {
            success: true,
            output: format!("Created folder: {}", target.to_string_lossy()),
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
fn rename_item(target: String, new_name: String) -> CommandResult {
    let next_name = match sanitize_child_name(&new_name) {
        Ok(value) => value,
        Err(output) => {
            return CommandResult {
                success: false,
                output,
            };
        }
    };
    let current = PathBuf::from(&target);
    let parent = match current.parent() {
        Some(value) => value,
        None => {
            return CommandResult {
                success: false,
                output: "Cannot rename this location".to_string(),
            };
        }
    };
    let next = parent.join(next_name);
    if next.exists() {
        return CommandResult {
            success: false,
            output: "An item with that name already exists".to_string(),
        };
    }
    match std::fs::rename(&current, &next) {
        Ok(_) => CommandResult {
            success: true,
            output: format!("Renamed to: {}", next.to_string_lossy()),
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
fn delete_item(target: String) -> CommandResult {
    let path = PathBuf::from(&target);
    if !path.exists() {
        return CommandResult {
            success: false,
            output: "Item does not exist".to_string(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let script = r#"
          $p = $args[0]
          Add-Type -AssemblyName Microsoft.VisualBasic
          $item = Get-Item -LiteralPath $p -ErrorAction Stop
          if ($item.PSIsContainer) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          }
        "#;
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
            &target,
        ]);
        cmd.creation_flags(0x08000000u32);
        match cmd.output() {
            Ok(out) if out.status.success() => CommandResult {
                success: true,
                output: format!("Moved to Recycle Bin: {}", target),
            },
            Ok(out) => CommandResult {
                success: false,
                output: String::from_utf8_lossy(&out.stderr).to_string(),
            },
            Err(e) => CommandResult {
                success: false,
                output: e.to_string(),
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match result {
            Ok(_) => CommandResult {
                success: true,
                output: format!("Deleted: {}", target),
            },
            Err(e) => CommandResult {
                success: false,
                output: e.to_string(),
            },
        }
    }
}

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 120_000;
const MAX_COMMAND_TIMEOUT_MS: u64 = 10 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;

fn read_command_output(path: &Path) -> (String, bool) {
    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), false);
    };
    let mut bytes = Vec::new();
    let mut limited = file.take(MAX_COMMAND_OUTPUT_BYTES + 1);
    let _ = limited.read_to_end(&mut bytes);
    let truncated = bytes.len() as u64 > MAX_COMMAND_OUTPUT_BYTES;
    if truncated {
        bytes.truncate(MAX_COMMAND_OUTPUT_BYTES as usize);
    }
    (decode_command_bytes(&bytes), truncated)
}

fn decode_command_bytes(bytes: &[u8]) -> String {
    if let Ok(value) = std::str::from_utf8(bytes) {
        return value.to_string();
    }
    #[cfg(target_os = "windows")]
    {
        let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
        decoded.into_owned()
    }
    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn terminate_command_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid, "/T", "/F"]);
        taskkill.creation_flags(0x08000000u32);
        let _ = taskkill
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn run_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    command_id: Option<String>,
    active_commands: tauri::State<'_, Mutex<ActiveDesktopCommands>>,
) -> CommandResult {
    let now = SystemTime::now();
    let truncated: String = if command.chars().count() > 500 {
        let head: String = command.chars().take(500).collect();
        format!("{}... (truncated, {} bytes total)", head, command.len())
    } else {
        command.clone()
    };
    let cwd_path = cwd
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(path) = cwd_path.as_ref() {
        if !path.is_dir() {
            return CommandResult {
                success: false,
                output: format!("Working directory does not exist: {}", path.display()),
            };
        }
    }

    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS)
            .clamp(1_000, MAX_COMMAND_TIMEOUT_MS),
    );
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let output_base =
        std::env::temp_dir().join(format!("lumi-command-{}-{}", std::process::id(), unique));
    let stdout_path = output_base.with_extension("stdout");
    let stderr_path = output_base.with_extension("stderr");
    let stdout_file = match std::fs::File::create(&stdout_path) {
        Ok(file) => file,
        Err(error) => {
            return CommandResult {
                success: false,
                output: error.to_string(),
            }
        }
    };
    let stderr_file = match std::fs::File::create(&stderr_path) {
        Ok(file) => file,
        Err(error) => {
            let _ = std::fs::remove_file(&stdout_path);
            return CommandResult {
                success: false,
                output: error.to_string(),
            };
        }
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C"]);
        cmd.raw_arg(&command);
        cmd.creation_flags(0x08000000u32);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &command]);
        cmd
    };
    if let Some(path) = cwd_path.as_ref() {
        cmd.current_dir(path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let result = match cmd.spawn() {
        Ok(mut child) => {
            if let Some(id) = command_id.as_ref().filter(|value| !value.trim().is_empty()) {
                if let Ok(mut active) = active_commands.lock() {
                    active.pids.insert(id.clone(), child.id());
                }
            }
            let deadline = Instant::now() + timeout;
            let mut timed_out = false;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Ok(None) => {
                        timed_out = true;
                        terminate_command_tree(&mut child);
                        break child.try_wait().and_then(|status| {
                            status.ok_or_else(|| {
                                std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "command timed out",
                                )
                            })
                        });
                    }
                    Err(error) => break Err(error),
                }
            };
            let (stdout, stdout_truncated) = read_command_output(&stdout_path);
            let (stderr, stderr_truncated) = read_command_output(&stderr_path);
            let mut combined = if stderr.is_empty() {
                stdout
            } else if stdout.is_empty() {
                stderr
            } else {
                format!("{}\n{}", stdout, stderr)
            };
            if stdout_truncated || stderr_truncated {
                combined.push_str("\n[Output truncated at 1 MiB per stream]");
            }
            if timed_out {
                combined.push_str(&format!(
                    "\n[Command timed out after {} ms and was terminated]",
                    timeout.as_millis()
                ));
            }
            status.map(|status| (status.success() && !timed_out, combined))
        }
        Err(error) => Err(error),
    };
    if let Some(id) = command_id.as_ref() {
        if let Ok(mut active) = active_commands.lock() {
            active.pids.remove(id);
        }
    }
    let _ = std::fs::remove_file(&stdout_path);
    let _ = std::fs::remove_file(&stderr_path);

    match result {
        Ok((success, output)) => {
            eprintln!(
                "[LumiOS Audit] ts={:?} ok={} cwd={} cmd={}",
                now,
                success,
                cwd_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                truncated
            );
            CommandResult { success, output }
        }
        Err(e) => {
            eprintln!(
                "[LumiOS Audit] ts={:?} ok=false cmd={} err={}",
                now, truncated, e
            );
            CommandResult {
                success: false,
                output: e.to_string(),
            }
        }
    }
}

fn resolve_resource_dir(resource_dir: &Path, name: &str) -> PathBuf {
    let direct = resource_dir.join(name);
    if direct.exists() {
        return direct;
    }

    let staged = resource_dir.join("desktop-resources").join(name);
    if staged.exists() {
        return staged;
    }

    // NSIS bundles resources inside a _up_ subdirectory (update-ready layout)
    let nsis = resource_dir
        .join("_up_")
        .join("desktop-resources")
        .join(name);
    if nsis.exists() {
        return nsis;
    }

    // Fallback: check relative to the executable's directory (some install scenarios)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let exe_relative = exe_dir.join(name);
            if exe_relative.exists() {
                return exe_relative;
            }
            let exe_nsis = exe_dir.join("_up_").join("desktop-resources").join(name);
            if exe_nsis.exists() {
                return exe_nsis;
            }
        }
    }

    direct
}

/// Strip Windows extended-length path prefix (\\?\) that external tools (Node.js) can't handle
fn normalize_unc(path: &Path) -> &Path {
    if let Some(s) = path.to_str() {
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Path::new(stripped);
        }
    }
    path
}

/// Spawn a child process without showing a console window on Windows
fn spawn_hidden(cmd: &mut Command) -> std::io::Result<Child> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000u32); // CREATE_NO_WINDOW (no DETACHED_PROCESS — that creates new console)
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.spawn()
}

#[tauri::command]
fn cancel_command(
    command_id: String,
    active_commands: tauri::State<'_, Mutex<ActiveDesktopCommands>>,
) -> bool {
    let pid = active_commands
        .lock()
        .ok()
        .and_then(|mut active| active.pids.remove(command_id.trim()));
    let Some(pid) = pid else {
        return false;
    };

    #[cfg(target_os = "windows")]
    {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        taskkill.creation_flags(0x08000000u32);
        taskkill
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsAppDefinition {
    app_id: &'static str,
    label: &'static str,
    aliases: Vec<&'static str>,
    executable_names: Vec<&'static str>,
    fixed_paths: Vec<&'static str>,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsLaunchCandidate {
    app_id: String,
    label: String,
    path: PathBuf,
    args: Vec<String>,
    source: String,
    aliases: Vec<String>,
    score: i32,
}

#[cfg(target_os = "windows")]
fn windows_app_definitions() -> Vec<WindowsAppDefinition> {
    vec![
        WindowsAppDefinition {
            app_id: "wechat",
            label: "WeChat",
            aliases: vec![
                "wechat",
                "weixin",
                "wechat.exe",
                "weixin.exe",
                "\u{5fae}\u{4fe1}",
                "\u{7535}\u{8111}\u{5fae}\u{4fe1}",
                "\u{4e2a}\u{4eba}\u{5fae}\u{4fe1}",
                "\u{5fae}\u{4fe1}\u{5ba2}\u{6237}\u{7aef}",
                "\u{5fae}\u{4fe1}\u{591a}\u{5f00}",
            ],
            executable_names: vec![
                "Weixin.exe",
                "WeChat.exe",
                "\u{5fae}\u{4fe1}\u{591a}\u{5f00}.bat",
                "\u{5fae}\u{4fe1}.lnk",
            ],
            fixed_paths: vec![
                r"D:\Weixin\Weixin.exe",
                r"%ProgramFiles%\Tencent\Weixin\Weixin.exe",
                r"%ProgramFiles%\Tencent\WeChat\Weixin.exe",
                r"%ProgramFiles%\Tencent\WeChat\WeChat.exe",
                r"%ProgramFiles(x86)%\Tencent\Weixin\Weixin.exe",
                r"%ProgramFiles(x86)%\Tencent\WeChat\Weixin.exe",
                r"%ProgramFiles(x86)%\Tencent\WeChat\WeChat.exe",
                r"%LOCALAPPDATA%\Tencent\WeChat\Weixin.exe",
                r"%LOCALAPPDATA%\Tencent\WeChat\WeChat.exe",
                r"%USERPROFILE%\Desktop\微信多开.bat",
                r"%USERPROFILE%\Desktop\微信.lnk",
            ],
        },
        WindowsAppDefinition {
            app_id: "wecom",
            label: "WeCom",
            aliases: vec![
                "wecom",
                "wxwork",
                "wxwork.exe",
                "\u{4f01}\u{4e1a}\u{5fae}\u{4fe1}",
                "\u{4f01}\u{5fae}",
            ],
            executable_names: vec![
                "WXWork.exe",
                "WeCom.exe",
                "\u{4f01}\u{4e1a}\u{5fae}\u{4fe1}.lnk",
            ],
            fixed_paths: vec![
                r"%ProgramFiles%\Tencent\WXWork\WXWork.exe",
                r"%ProgramFiles(x86)%\Tencent\WXWork\WXWork.exe",
                r"%LOCALAPPDATA%\Tencent\WXWork\WXWork.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "wps",
            label: "WPS Office",
            aliases: vec![
                "wps",
                "wps office",
                "wps writer",
                "wps spreadsheets",
                "\u{91d1}\u{5c71}\u{529e}\u{516c}",
                "\u{6587}\u{5b57}",
                "\u{8868}\u{683c}",
                "\u{6f14}\u{793a}",
                "word",
                "excel",
                "ppt",
            ],
            executable_names: vec![
                "wps.exe",
                "et.exe",
                "wpp.exe",
                "ksolaunch.exe",
                "WPS Office.lnk",
            ],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Kingsoft\WPS Office\ksolaunch.exe",
                r"%ProgramFiles%\Kingsoft\WPS Office\ksolaunch.exe",
                r"%ProgramFiles(x86)%\Kingsoft\WPS Office\ksolaunch.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "browser",
            label: "Browser",
            aliases: vec![
                "browser",
                "web browser",
                "\u{6d4f}\u{89c8}\u{5668}",
                "edge",
                "microsoft edge",
                "chrome",
                "\u{8c37}\u{6b4c}\u{6d4f}\u{89c8}\u{5668}",
            ],
            executable_names: vec![
                "msedge.exe",
                "chrome.exe",
                "Microsoft Edge.lnk",
                "Google Chrome.lnk",
            ],
            fixed_paths: vec![
                r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
                r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
                r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
                r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
                r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "vscode",
            label: "Visual Studio Code",
            aliases: vec!["vscode", "vs code", "visual studio code", "code"],
            executable_names: vec!["Code.exe", "Visual Studio Code.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
                r"%ProgramFiles%\Microsoft VS Code\Code.exe",
                r"%ProgramFiles(x86)%\Microsoft VS Code\Code.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "workbuddy",
            label: "WorkBuddy",
            aliases: vec!["workbuddy", "work buddy"],
            executable_names: vec!["WorkBuddy.exe", "WorkBuddy.lnk"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "codex",
            label: "Codex",
            aliases: vec!["codex", "openai codex"],
            executable_names: vec!["Codex.exe", "Codex.lnk"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "chatgpt",
            label: "ChatGPT",
            aliases: vec!["chatgpt", "openai chatgpt"],
            executable_names: vec!["ChatGPT.exe", "ChatGPT.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\ChatGPT\ChatGPT.exe",
                r"%ProgramFiles%\ChatGPT\ChatGPT.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "claude",
            label: "Claude",
            aliases: vec!["claude", "anthropic claude"],
            executable_names: vec!["Claude.exe", "Claude.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\AnthropicClaude\Claude.exe",
                r"%LOCALAPPDATA%\Programs\Claude\Claude.exe",
                r"%ProgramFiles%\Claude\Claude.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "cursor",
            label: "Cursor",
            aliases: vec!["cursor", "cursor ai", "cursor editor"],
            executable_names: vec!["Cursor.exe", "Cursor.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe",
                r"%ProgramFiles%\Cursor\Cursor.exe",
                r"D:\cursor\Cursor.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "lmstudio",
            label: "LM Studio",
            aliases: vec!["lmstudio", "lm studio"],
            executable_names: vec!["LM Studio.exe", "LM Studio.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe",
                r"%ProgramFiles%\LM Studio\LM Studio.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "cherry-studio",
            label: "Cherry Studio",
            aliases: vec!["cherry studio", "cherrystudio", "cherry ai"],
            executable_names: vec!["Cherry Studio.exe", "CherryStudio.exe", "Cherry Studio.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\CherryStudio\CherryStudio.exe",
                r"%ProgramFiles%\Cherry Studio\Cherry Studio.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "anythingllm",
            label: "AnythingLLM",
            aliases: vec!["anythingllm", "anything llm"],
            executable_names: vec!["AnythingLLM.exe", "AnythingLLM.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Programs\AnythingLLM\AnythingLLM.exe",
                r"%ProgramFiles%\AnythingLLM\AnythingLLM.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "jianying",
            label: "Jianying",
            aliases: vec![
                "jianying",
                "capcut",
                "\u{526a}\u{6620}",
                "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}",
            ],
            executable_names: vec![
                "JianyingPro.exe",
                "CapCut.exe",
                "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}.lnk",
                "\u{526a}\u{6620}.lnk",
            ],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\JianyingPro\Apps\JianyingPro.exe",
                r"%ProgramFiles%\JianyingPro\JianyingPro.exe",
                r"%ProgramFiles(x86)%\JianyingPro\JianyingPro.exe",
                r"D:\JianyingPro\JianyingPro.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "autocad",
            label: "AutoCAD",
            aliases: vec![
                "autocad",
                "cad",
                "\u{5929}\u{6b63}",
                "\u{4e2d}\u{671b}cad",
                "\u{6d69}\u{8fb0}cad",
            ],
            executable_names: vec!["acad.exe", "AutoCAD.exe", "ZWCAD.exe", "GstarCAD.exe"],
            fixed_paths: vec![],
        },
        WindowsAppDefinition {
            app_id: "feishu",
            label: "Feishu",
            aliases: vec!["feishu", "lark", "\u{98de}\u{4e66}"],
            executable_names: vec!["Feishu.exe", "Lark.exe", "\u{98de}\u{4e66}.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\Feishu\Feishu.exe",
                r"%ProgramFiles%\Feishu\Feishu.exe",
                r"%ProgramFiles(x86)%\Feishu\Feishu.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "dingtalk",
            label: "DingTalk",
            aliases: vec!["dingtalk", "\u{9489}\u{9489}"],
            executable_names: vec!["DingTalk.exe", "\u{9489}\u{9489}.lnk"],
            fixed_paths: vec![
                r"%LOCALAPPDATA%\DingTalk\DingTalk.exe",
                r"%ProgramFiles%\DingDing\DingtalkLauncher.exe",
                r"%ProgramFiles(x86)%\DingDing\DingtalkLauncher.exe",
            ],
        },
        WindowsAppDefinition {
            app_id: "notepad",
            label: "Notepad",
            aliases: vec!["notepad", "notepad.exe", "\u{8bb0}\u{4e8b}\u{672c}"],
            executable_names: vec!["notepad.exe"],
            fixed_paths: vec![r"%WINDIR%\System32\notepad.exe"],
        },
        WindowsAppDefinition {
            app_id: "calculator",
            label: "Calculator",
            aliases: vec!["calculator", "calc", "calc.exe", "\u{8ba1}\u{7b97}\u{5668}"],
            executable_names: vec!["calc.exe", "CalculatorApp.exe"],
            fixed_paths: vec![r"%WINDIR%\System32\calc.exe"],
        },
        WindowsAppDefinition {
            app_id: "explorer",
            label: "File Explorer",
            aliases: vec![
                "explorer",
                "file explorer",
                "\u{6587}\u{4ef6}\u{8d44}\u{6e90}\u{7ba1}\u{7406}\u{5668}",
                "\u{8d44}\u{6e90}\u{7ba1}\u{7406}\u{5668}",
            ],
            executable_names: vec!["explorer.exe"],
            fixed_paths: vec![r"%WINDIR%\explorer.exe"],
        },
        WindowsAppDefinition {
            app_id: "powershell",
            label: "PowerShell",
            aliases: vec![
                "powershell",
                "pwsh",
                "\u{7ec8}\u{7aef}",
                "\u{547d}\u{4ee4}\u{884c}",
            ],
            executable_names: vec!["powershell.exe", "pwsh.exe", "Windows Terminal.lnk"],
            fixed_paths: vec![
                r"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe",
                r"%ProgramFiles%\PowerShell\7\pwsh.exe",
                r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe",
            ],
        },
    ]
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn compact_app_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn normalize_app_query(value: &str) -> String {
    let mut compact = compact_app_text(value);
    let prefixes = [
        "\u{5e2e}\u{6211}\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{5e2e}\u{6211}\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{8bf7}\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{8bf7}\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{6253}\u{5f00}\u{4e00}\u{4e0b}",
        "\u{542f}\u{52a8}\u{4e00}\u{4e0b}",
        "\u{5e2e}\u{6211}\u{6253}\u{5f00}",
        "\u{5e2e}\u{6211}\u{542f}\u{52a8}",
        "\u{8bf7}\u{6253}\u{5f00}",
        "\u{8bf7}\u{542f}\u{52a8}",
        "\u{6253}\u{5f00}",
        "\u{542f}\u{52a8}",
        "\u{8fd0}\u{884c}",
        "\u{8fdb}\u{5165}",
        "\u{6253}\u{5f00}",
        "pleaseopen",
        "launch",
        "start",
        "open",
        "run",
    ];
    for prefix in prefixes {
        let normalized_prefix = compact_app_text(prefix);
        if compact.starts_with(&normalized_prefix) {
            compact = compact[normalized_prefix.len()..].to_string();
            break;
        }
    }

    let location_prefixes = [
        "\u{684c}\u{9762}\u{4e0a}\u{7684}",
        "\u{684c}\u{9762}\u{91cc}\u{7684}",
        "\u{684c}\u{9762}\u{7684}",
        "\u{684c}\u{9762}\u{4e0a}",
        "\u{684c}\u{9762}\u{91cc}",
        "\u{684c}\u{9762}",
        "onthedesktop",
        "desktop",
    ];
    for prefix in location_prefixes {
        let normalized_prefix = compact_app_text(prefix);
        if compact.starts_with(&normalized_prefix) && compact.len() > normalized_prefix.len() {
            compact = compact[normalized_prefix.len()..].to_string();
            break;
        }
    }

    let suffixes = [
        "\u{5ba2}\u{6237}\u{7aef}",
        "\u{5e94}\u{7528}",
        "\u{8f6f}\u{4ef6}",
        "\u{7a0b}\u{5e8f}",
        "application",
        "client",
        "app",
    ];
    for suffix in suffixes {
        let normalized_suffix = compact_app_text(suffix);
        if compact.ends_with(&normalized_suffix) && compact.len() > normalized_suffix.len() {
            compact = compact[..compact.len() - normalized_suffix.len()].to_string();
            break;
        }
    }
    compact
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn unicode_edit_distance(left: &str, right: &str) -> usize {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left_chars.iter().enumerate() {
        let mut current = vec![left_index + 1; right_chars.len() + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current[right_index + 1] = std::cmp::min(
                std::cmp::min(current[right_index] + 1, previous[right_index + 1] + 1),
                previous[right_index] + usize::from(left_char != right_char),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn desktop_item_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs_next::home_dir() {
        roots.push(home.join("Desktop"));
    }
    #[cfg(target_os = "windows")]
    if let Ok(public_dir) = std::env::var("PUBLIC") {
        roots.push(PathBuf::from(public_dir).join("Desktop"));
    }
    roots
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn resolve_desktop_item_fuzzy(target: &str) -> Option<PathBuf> {
    let mut query = normalize_app_query(target);
    for suffix in [
        "\u{6587}\u{4ef6}\u{5939}",
        "\u{76ee}\u{5f55}",
        "folder",
        "directory",
    ] {
        let suffix = compact_app_text(suffix);
        if query.ends_with(&suffix) && query.len() > suffix.len() {
            query.truncate(query.len() - suffix.len());
            break;
        }
    }
    if query.is_empty() {
        return None;
    }

    let mut ranked: Vec<(usize, PathBuf)> = Vec::new();
    for root in desktop_item_roots() {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let label = path
                .file_stem()
                .or_else(|| path.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let candidate = compact_app_text(&label);
            if candidate.is_empty() {
                continue;
            }
            let distance = if candidate.contains(&query) || query.contains(&candidate) {
                0
            } else {
                unicode_edit_distance(&query, &candidate)
            };
            let threshold = std::cmp::max(1, query.chars().count() / 3);
            if distance <= threshold {
                ranked.push((distance, path));
            }
        }
    }
    ranked.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let best = ranked.first()?;
    if ranked.get(1).map(|next| next.0 == best.0).unwrap_or(false) {
        return None;
    }
    Some(best.1.clone())
}

#[cfg(all(test, target_os = "windows"))]
mod app_query_tests {
    use super::normalize_app_query;

    #[test]
    fn strips_desktop_location_words_without_shortening_the_app_name() {
        assert_eq!(normalize_app_query("打开桌面上的网易云音乐"), "网易云音乐");
        assert_eq!(normalize_app_query("桌面的网易云音乐软件"), "网易云音乐");
        assert_eq!(normalize_app_query("打开微信消息值守"), "微信消息值守");
    }
}

#[cfg(target_os = "macos")]
fn macos_app_roots() -> Vec<(PathBuf, &'static str, i32)> {
    let mut roots = vec![
        (PathBuf::from("/Applications"), "applications", 120),
        (
            PathBuf::from("/System/Applications"),
            "system_applications",
            90,
        ),
    ];
    if let Some(home) = dirs_next::home_dir() {
        roots.push((home.join("Applications"), "user_applications", 140));
    }
    roots
}

#[cfg(target_os = "macos")]
fn macos_app_aliases(label: &str) -> Vec<String> {
    let normalized = compact_app_text(label);
    let mut aliases = Vec::new();
    if [
        "safari",
        "googlechrome",
        "chrome",
        "firefox",
        "microsoftedge",
        "bravebrowser",
    ]
    .iter()
    .any(|name| normalized.contains(name))
    {
        aliases.extend(["browser".to_string(), "浏览器".to_string()]);
    }
    if normalized.contains("wechat") || normalized.contains("weixin") || normalized.contains("微信")
    {
        aliases.extend([
            "wechat".to_string(),
            "weixin".to_string(),
            "微信".to_string(),
        ]);
    }
    if normalized.contains("autocad")
        || normalized.contains("zwcad")
        || normalized.contains("gstarcad")
    {
        aliases.extend(["cad".to_string(), "CAD".to_string()]);
    }
    if normalized.contains("microsoftword") || normalized.contains("wpsoffice") {
        aliases.extend(["office".to_string(), "文档".to_string()]);
    }
    aliases
}

#[cfg(target_os = "macos")]
fn list_macos_native_apps(query: Option<&str>, limit: usize) -> Vec<NativeAppEntry> {
    let normalized_query = query.map(normalize_app_query).unwrap_or_default();
    let mut apps = Vec::new();
    let mut seen = HashSet::new();

    for (root, source, score) in macos_app_roots() {
        if !root.is_dir() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 3 || apps.len() >= 1500 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let is_bundle = path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| extension.eq_ignore_ascii_case("app"))
                    .unwrap_or(false);
                if is_bundle {
                    let label = path
                        .file_stem()
                        .map(|name| name.to_string_lossy().trim().to_string())
                        .unwrap_or_default();
                    if label.is_empty() {
                        continue;
                    }
                    let path_text = path.to_string_lossy().to_string();
                    let path_key = path_text.to_lowercase();
                    if !seen.insert(path_key) {
                        continue;
                    }
                    let aliases = macos_app_aliases(&label);
                    let label_key = compact_app_text(&label);
                    let matches_query = normalized_query.is_empty()
                        || label_key.contains(&normalized_query)
                        || normalized_query.contains(&label_key)
                        || aliases.iter().any(|alias| {
                            let alias_key = compact_app_text(alias);
                            alias_key == normalized_query || alias_key.contains(&normalized_query)
                        });
                    if matches_query {
                        apps.push(NativeAppEntry {
                            app_id: if label_key.is_empty() {
                                label.to_lowercase()
                            } else {
                                label_key
                            },
                            label,
                            path: path_text,
                            source: source.to_string(),
                            aliases,
                            score,
                        });
                    }
                    continue;
                }
                if depth < 3 && path.is_dir() {
                    stack.push((path, depth + 1));
                }
            }
        }
    }

    apps.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
    });
    apps.truncate(limit.clamp(1, 200));
    apps
}

#[cfg(target_os = "macos")]
fn should_try_macos_app_index(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.starts_with('.')
        || trimmed.contains("://")
        || trimmed.starts_with("mailto:")
    {
        return false;
    }
    true
}

#[cfg(target_os = "macos")]
fn try_launch_macos_app(target: &str) -> Option<CommandResult> {
    if !should_try_macos_app_index(target) {
        return None;
    }
    let app = list_macos_native_apps(Some(target), 1).into_iter().next()?;
    let output = Command::new("open").arg(&app.path).output();
    Some(match output {
        Ok(result) if result.status.success() => CommandResult {
            success: true,
            output: format!("Opened app {} ({})", app.label, app.path),
        },
        Ok(result) => CommandResult {
            success: false,
            output: String::from_utf8_lossy(&result.stderr).trim().to_string(),
        },
        Err(error) => CommandResult {
            success: false,
            output: error.to_string(),
        },
    })
}

#[cfg(target_os = "windows")]
fn looks_like_url(target: &str) -> bool {
    let lower = target.trim().to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || lower.starts_with("mailto:")
}

#[cfg(target_os = "windows")]
fn launchable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_lowercase().as_str(),
                "exe" | "bat" | "cmd" | "lnk" | "url"
            )
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn should_try_windows_app_index(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() || looks_like_url(trimmed) {
        return false;
    }

    let target_path = Path::new(trimmed);
    if target_path.exists() {
        return launchable_extension(target_path);
    }

    if trimmed.contains('\\')
        || trimmed.contains('/')
        || trimmed.contains(':')
        || trimmed.starts_with('.')
    {
        return false;
    }

    match target_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_lowercase().as_str(),
            "exe" | "bat" | "cmd" | "lnk" | "url"
        ),
        None => true,
    }
}

#[cfg(target_os = "windows")]
fn expand_windows_path_template(template: &str) -> Option<PathBuf> {
    let mut expanded = template.to_string();
    for (token, var) in [
        ("%ProgramFiles(x86)%", "ProgramFiles(x86)"),
        ("%ProgramFiles%", "ProgramFiles"),
        ("%LOCALAPPDATA%", "LOCALAPPDATA"),
        ("%APPDATA%", "APPDATA"),
        ("%USERPROFILE%", "USERPROFILE"),
        ("%PUBLIC%", "PUBLIC"),
        ("%WINDIR%", "WINDIR"),
    ] {
        if expanded.contains(token) {
            let value = std::env::var(var).ok()?;
            expanded = expanded.replace(token, &value);
        }
    }
    Some(PathBuf::from(expanded))
}

#[cfg(target_os = "windows")]
fn windows_app_search_roots() -> Vec<(PathBuf, &'static str, i32)> {
    let mut roots = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        roots.push((PathBuf::from(user_profile).join("Desktop"), "desktop", 130));
    }
    if let Ok(public_dir) = std::env::var("PUBLIC") {
        roots.push((
            PathBuf::from(public_dir).join("Desktop"),
            "public_desktop",
            110,
        ));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push((
            PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"),
            "user_start_menu",
            90,
        ));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        roots.push((
            PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "system_start_menu",
            80,
        ));
    }
    roots
}

#[cfg(target_os = "windows")]
fn filename_matches_app_definition(file_name: &str, def: &WindowsAppDefinition) -> bool {
    if def
        .executable_names
        .iter()
        .any(|name| file_name.eq_ignore_ascii_case(name))
    {
        return true;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    let name_norm = compact_app_text(file_name);
    let stem_norm = compact_app_text(stem);

    def.aliases.iter().any(|alias| {
        let alias_norm = normalize_app_query(alias);
        !alias_norm.is_empty()
            && (name_norm == alias_norm
                || stem_norm == alias_norm
                || (alias_norm.len() >= 3 && stem_norm.contains(&alias_norm)))
    })
}

#[cfg(target_os = "windows")]
fn app_query_matches_definition(query: &str, def: &WindowsAppDefinition) -> bool {
    let normalized = normalize_app_query(query);
    if normalized.is_empty() {
        return false;
    }
    if normalized == compact_app_text(def.app_id) || normalized == compact_app_text(def.label) {
        return true;
    }
    def.aliases
        .iter()
        .any(|alias| normalized == normalize_app_query(alias))
        || def
            .executable_names
            .iter()
            .any(|name| normalized == compact_app_text(name))
}

#[cfg(target_os = "windows")]
fn app_args_for_path(app_id: &str, path: &Path) -> Vec<String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if app_id == "wechat" && file_name.eq_ignore_ascii_case("weixin.exe") {
        vec!["--scene=desktop".to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn candidate_from_path(
    def: &WindowsAppDefinition,
    path: PathBuf,
    source: &str,
    score: i32,
) -> WindowsLaunchCandidate {
    WindowsLaunchCandidate {
        app_id: def.app_id.to_string(),
        label: def.label.to_string(),
        args: app_args_for_path(def.app_id, &path),
        path,
        source: source.to_string(),
        aliases: def.aliases.iter().map(|alias| alias.to_string()).collect(),
        score,
    }
}

#[cfg(target_os = "windows")]
fn app_launch_history_path() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("LOCALAPPDATA"))
        .ok()?;
    Some(
        PathBuf::from(base)
            .join("LumiOS")
            .join("app-launch-history.json"),
    )
}

#[cfg(target_os = "windows")]
fn read_app_launch_history() -> Vec<AppLaunchHistoryEntry> {
    let Some(path) = app_launch_history_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<AppLaunchHistoryEntry>>(&raw).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn write_app_launch_history(history: &[AppLaunchHistoryEntry]) {
    let Some(path) = app_launch_history_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(history) {
        let _ = std::fs::write(path, raw);
    }
}

#[cfg(target_os = "windows")]
fn record_app_launch(candidate: &WindowsLaunchCandidate) {
    let mut history = read_app_launch_history();
    let path = candidate.path.to_string_lossy().to_string();
    history.retain(|entry| {
        !(entry.app_id == candidate.app_id && entry.path.eq_ignore_ascii_case(&path))
    });
    let last_success_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    history.insert(
        0,
        AppLaunchHistoryEntry {
            app_id: candidate.app_id.clone(),
            path,
            args: candidate.args.clone(),
            source: candidate.source.clone(),
            last_success_ms,
        },
    );
    if history.len() > 120 {
        history.truncate(120);
    }
    write_app_launch_history(&history);
}

#[cfg(target_os = "windows")]
fn history_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    read_app_launch_history()
        .into_iter()
        .filter(|entry| entry.app_id == def.app_id)
        .filter_map(|entry| {
            let path = PathBuf::from(&entry.path);
            if !path.exists() {
                return None;
            }
            Some(WindowsLaunchCandidate {
                app_id: def.app_id.to_string(),
                label: def.label.to_string(),
                path,
                args: entry.args,
                source: "history".to_string(),
                aliases: def.aliases.iter().map(|alias| alias.to_string()).collect(),
                score: 220,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn shortcut_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    for (root, source, score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1600 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if filename_matches_app_definition(file_name, def) {
                    candidates.push(candidate_from_path(def, path, source, score));
                }
            }
        }
        if !candidates.is_empty() {
            break;
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn shortcut_candidates_for_definitions(
    defs: &[WindowsAppDefinition],
) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    for (root, source, score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1600 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if let Some(def) = defs
                    .iter()
                    .find(|def| filename_matches_app_definition(file_name, def))
                {
                    candidates.push(candidate_from_path(def, path, source, score));
                }
            }
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn generic_windows_launch_candidates(query: Option<&str>) -> Vec<WindowsLaunchCandidate> {
    let normalized_query = query.map(normalize_app_query).unwrap_or_default();
    if query.is_some() && normalized_query.is_empty() {
        return Vec::new();
    }
    let query_is_specific = normalized_query.chars().count() >= 2;
    let mut candidates = Vec::new();
    for (root, source, base_score) in windows_app_search_roots() {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![(root, 0usize)];
        let mut visited = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 7 || visited > 1800 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                if !launchable_extension(&path) {
                    continue;
                }
                let label = path
                    .file_stem()
                    .map(|value| value.to_string_lossy().trim().to_string())
                    .unwrap_or_default();
                let label_key = compact_app_text(&label);
                if label_key.is_empty() {
                    continue;
                }
                let exact_match = !normalized_query.is_empty() && label_key == normalized_query;
                let partial_match = query_is_specific && label_key.contains(&normalized_query);
                if !normalized_query.is_empty() && !exact_match && !partial_match {
                    continue;
                }
                candidates.push(WindowsLaunchCandidate {
                    app_id: label_key.clone(),
                    label: label.clone(),
                    path,
                    args: Vec::new(),
                    source: source.to_string(),
                    aliases: vec![label],
                    score: base_score
                        + if exact_match {
                            45
                        } else if partial_match {
                            15
                        } else {
                            0
                        },
                });
            }
        }
    }
    dedupe_windows_candidates(candidates)
}

#[cfg(target_os = "windows")]
fn fixed_candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    def.fixed_paths
        .iter()
        .filter_map(|template| expand_windows_path_template(template))
        .filter(|path| path.exists())
        .map(|path| candidate_from_path(def, path, "known_path", 170))
        .collect()
}

#[cfg(target_os = "windows")]
fn dedupe_windows_candidates(
    mut candidates: Vec<WindowsLaunchCandidate>,
) -> Vec<WindowsLaunchCandidate> {
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| {
            let key = candidate.path.to_string_lossy().to_lowercase();
            seen.insert(key)
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn candidates_for_definition(def: &WindowsAppDefinition) -> Vec<WindowsLaunchCandidate> {
    let mut candidates = Vec::new();
    candidates.extend(history_candidates_for_definition(def));
    candidates.extend(fixed_candidates_for_definition(def));
    if candidates.is_empty() {
        candidates.extend(shortcut_candidates_for_definition(def));
    }
    dedupe_windows_candidates(candidates)
}

#[cfg(target_os = "windows")]
fn resolve_app_definition(target: &str) -> Option<WindowsAppDefinition> {
    if !should_try_windows_app_index(target) {
        return None;
    }
    windows_app_definitions()
        .into_iter()
        .find(|def| app_query_matches_definition(target, def))
}

#[cfg(target_os = "windows")]
fn native_app_entry_from_candidate(candidate: WindowsLaunchCandidate) -> NativeAppEntry {
    NativeAppEntry {
        app_id: candidate.app_id,
        label: candidate.label,
        path: candidate.path.to_string_lossy().to_string(),
        source: candidate.source,
        aliases: candidate.aliases,
        score: candidate.score,
    }
}

#[cfg(target_os = "windows")]
fn list_windows_native_apps(query: Option<&str>, limit: usize) -> Vec<NativeAppEntry> {
    let definitions = windows_app_definitions();
    let mut candidates = Vec::new();
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        for def in definitions
            .iter()
            .filter(|def| app_query_matches_definition(q, def))
        {
            candidates.extend(candidates_for_definition(def));
        }
        candidates.extend(generic_windows_launch_candidates(Some(q)));
    } else {
        for def in &definitions {
            candidates.extend(history_candidates_for_definition(def));
            candidates.extend(fixed_candidates_for_definition(def));
        }
        candidates.extend(shortcut_candidates_for_definitions(&definitions));
        candidates.extend(generic_windows_launch_candidates(None));
    }
    dedupe_windows_candidates(candidates)
        .into_iter()
        .take(limit.clamp(1, 200))
        .map(native_app_entry_from_candidate)
        .collect()
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct RecentlyFocusedWindowsApp {
    hwnd: isize,
    pid: u32,
    title: String,
    recorded_at: Instant,
}

#[cfg(target_os = "windows")]
fn recently_focused_windows_app() -> &'static Mutex<Option<RecentlyFocusedWindowsApp>> {
    use std::sync::OnceLock;
    static RECENT: OnceLock<Mutex<Option<RecentlyFocusedWindowsApp>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn focus_running_windows_app(def: &WindowsAppDefinition) -> Option<CommandResult> {
    let executable_names: Vec<String> = def
        .executable_names
        .iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".exe"))
        .map(|name| name.to_ascii_lowercase())
        .collect();
    if executable_names.is_empty() {
        return None;
    }

    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let pids: Vec<u32> = sys
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let name = process.name().to_string_lossy().to_ascii_lowercase();
            if executable_names.iter().any(|expected| expected == &name) {
                Some(pid.as_u32())
            } else {
                None
            }
        })
        .collect();
    if pids.is_empty() {
        return None;
    }

    #[repr(C)]
    struct FocusSearch {
        pids: Vec<u32>,
        hwnd: isize,
        pid: u32,
        title: String,
    }

    extern "system" {
        fn EnumWindows(lpEnumFunc: extern "system" fn(isize, isize) -> i32, lParam: isize) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetWindowTextLengthW(hwnd: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, lpdwProcessId: *mut u32) -> u32;
        fn ShowWindow(hwnd: isize, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
    }

    extern "system" fn enum_window(hwnd: isize, lparam: isize) -> i32 {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }

            let state = &mut *(lparam as *mut FocusSearch);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if !state.pids.contains(&pid) {
                return 1;
            }

            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                return 1;
            }
            let mut buf: Vec<u16> = vec![0; title_len as usize + 1];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            state.hwnd = hwnd;
            state.pid = pid;
            state.title = String::from_utf16_lossy(&buf[..len as usize]);
            0
        }
    }

    let mut state = FocusSearch {
        pids,
        hwnd: 0,
        pid: 0,
        title: String::new(),
    };

    unsafe {
        EnumWindows(enum_window, &mut state as *mut FocusSearch as isize);
        if state.hwnd != 0 {
            const SW_RESTORE: i32 = 9;
            ShowWindow(state.hwnd, SW_RESTORE);
            if SetForegroundWindow(state.hwnd) == 0 {
                return Some(CommandResult {
                    success: false,
                    output: format!(
                        "Found running app {} (pid {}, window \"{}\") but Windows refused to focus it",
                        def.label, state.pid, state.title
                    ),
                });
            }
            if let Ok(mut recent) = recently_focused_windows_app().lock() {
                *recent = Some(RecentlyFocusedWindowsApp {
                    hwnd: state.hwnd,
                    pid: state.pid,
                    title: state.title.clone(),
                    recorded_at: Instant::now(),
                });
            }
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Focused running app {} (pid {}, window \"{}\")",
                    def.label, state.pid, state.title
                ),
            });
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn launch_windows_path(path: &Path, extra_args: &[String]) -> CommandResult {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    let spawned = if matches!(extension.as_str(), "bat" | "cmd" | "lnk" | "url") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", ""]);
        cmd.arg(path);
        for arg in extra_args {
            cmd.arg(arg);
        }
        spawn_hidden(&mut cmd)
    } else {
        let mut cmd = Command::new(path);
        for arg in extra_args {
            cmd.arg(arg);
        }
        spawn_hidden(&mut cmd)
    };

    match spawned {
        Ok(_) => CommandResult {
            success: true,
            output: format!("Opened: {}", path.display()),
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[cfg(target_os = "windows")]
fn open_target_in_windows_application(application: &str, target: &str) -> Option<CommandResult> {
    let mut candidates = generic_windows_launch_candidates(Some(application));
    if candidates.is_empty() {
        if let Some(definition) = resolve_app_definition(application) {
            candidates = candidates_for_definition(&definition);
        }
    }
    if candidates.is_empty() {
        return Some(CommandResult {
            success: false,
            output: format!("No installed application matched: {}", application),
        });
    }

    let mut last_error = None;
    for candidate in candidates {
        let mut args = candidate.args.clone();
        args.push(target.to_string());
        let result = launch_windows_path(&candidate.path, &args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened {} in {} via {}",
                    target,
                    candidate.label,
                    candidate.path.display()
                ),
            });
        }
        last_error = Some(result.output);
    }
    Some(CommandResult {
        success: false,
        output: last_error
            .unwrap_or_else(|| format!("Failed to open {} in {}", target, application)),
    })
}

#[cfg(target_os = "macos")]
fn open_target_in_macos_application(application: &str, target: &str) -> Option<CommandResult> {
    let app = list_macos_native_apps(Some(application), 1)
        .into_iter()
        .next();
    let mut command = Command::new("open");
    if let Some(ref matched) = app {
        command.arg("-a").arg(&matched.path).arg(target);
    } else {
        command.args(["-a", application, target]);
    }
    Some(match command.output() {
        Ok(result) if result.status.success() => CommandResult {
            success: true,
            output: format!(
                "Opened {} in {}",
                target,
                app.map(|matched| matched.label)
                    .unwrap_or_else(|| application.to_string())
            ),
        },
        Ok(result) => CommandResult {
            success: false,
            output: decode_command_bytes(&result.stderr).trim().to_string(),
        },
        Err(error) => CommandResult {
            success: false,
            output: error.to_string(),
        },
    })
}

#[cfg(target_os = "windows")]
fn try_launch_windows_app_alias(target: &str) -> Option<CommandResult> {
    let def = resolve_app_definition(target)?;
    if let Some(result) = focus_running_windows_app(&def) {
        return Some(result);
    }
    let candidates = candidates_for_definition(&def);
    if candidates.is_empty() {
        return Some(CommandResult {
            success: false,
            output: format!(
                "No local app entry found for {}. Checked launch history, Desktop, Start Menu, and known install paths.",
                def.label
            ),
        });
    }

    let mut last_error: Option<String> = None;
    for candidate in candidates {
        let result = launch_windows_path(&candidate.path, &candidate.args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened app {} via {} ({})",
                    candidate.label,
                    candidate.path.display(),
                    candidate.source
                ),
            });
        }
        last_error = Some(result.output);
    }

    Some(CommandResult {
        success: false,
        output: last_error.unwrap_or_else(|| format!("Failed to open {}", def.label)),
    })
}

#[cfg(target_os = "windows")]
fn try_launch_generic_windows_app(target: &str) -> Option<CommandResult> {
    if !should_try_windows_app_index(target) {
        return None;
    }
    let candidates = generic_windows_launch_candidates(Some(target));
    if candidates.is_empty() {
        return None;
    }
    let mut last_error = None;
    for candidate in candidates {
        let result = launch_windows_path(&candidate.path, &candidate.args);
        if result.success {
            record_app_launch(&candidate);
            return Some(CommandResult {
                success: true,
                output: format!(
                    "Opened app {} via {} ({})",
                    candidate.label,
                    candidate.path.display(),
                    candidate.source
                ),
            });
        }
        last_error = Some(result.output);
    }
    Some(CommandResult {
        success: false,
        output: last_error.unwrap_or_else(|| format!("Failed to open {}", target)),
    })
}

#[tauri::command]
async fn list_native_apps(query: Option<String>, limit: Option<usize>) -> Vec<NativeAppEntry> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            list_windows_native_apps(query.as_deref(), limit.unwrap_or(80))
        })
        .await
        .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            list_macos_native_apps(query.as_deref(), limit.unwrap_or(80))
        })
        .await
        .unwrap_or_default();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = query;
        let _ = limit;
        Vec::new()
    }
}

#[tauri::command]
fn open_item(
    target: String,
    application: Option<String>,
    window: tauri::WebviewWindow,
) -> CommandResult {
    // Open file, folder, app, or URL with the OS default handler
    let _ = window.set_always_on_top(false);

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let mut target = target;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if let Some(application) = application
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        #[cfg(target_os = "windows")]
        if let Some(result) = open_target_in_windows_application(&application, &target) {
            return result;
        }

        #[cfg(target_os = "macos")]
        if let Some(result) = open_target_in_macos_application(&application, &target) {
            return result;
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = application;

    #[cfg(target_os = "windows")]
    if let Some(result) = try_launch_windows_app_alias(&target) {
        return result;
    }

    #[cfg(target_os = "windows")]
    if let Some(result) = try_launch_generic_windows_app(&target) {
        return result;
    }

    #[cfg(target_os = "macos")]
    if let Some(result) = try_launch_macos_app(&target) {
        if result.success {
            return result;
        }
        eprintln!(
            "[LumiOS] indexed macOS app launch failed, keeping LaunchServices fallbacks: {}",
            result.output
        );
    }

    #[cfg(target_os = "macos")]
    if should_try_macos_app_index(&target) {
        // Ask LaunchServices by registered application name before retaining the
        // legacy direct `open <target>` behavior below. This also covers apps
        // installed outside the directories indexed by Lumi.
        if let Ok(output) = Command::new("open").args(["-a", &target]).output() {
            if output.status.success() {
                return CommandResult {
                    success: true,
                    output: format!("Opened registered app: {}", target),
                };
            }
        }
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if !Path::new(&target).exists() {
        if let Some(resolved) = resolve_desktop_item_fuzzy(&target) {
            target = resolved.to_string_lossy().to_string();
        }
    }

    if cfg!(target_os = "windows") && Path::new(&target).is_dir() {
        let mut cmd = Command::new("explorer.exe");
        cmd.arg(&target);
        return match spawn_hidden(&mut cmd) {
            Ok(_) => CommandResult {
                success: true,
                output: format!("Opened folder: {}", target),
            },
            Err(e) => CommandResult {
                success: false,
                output: e.to_string(),
            },
        };
    }

    let result = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &target]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000u32);
        }
        cmd.output()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&target).output()
    } else {
        Command::new("xdg-open").arg(&target).output()
    };
    match result {
        Ok(out) => {
            if out.status.success() {
                return CommandResult {
                    success: true,
                    output: format!("Opened: {}", target),
                };
            }

            let stderr = decode_command_bytes(&out.stderr).trim().to_string();
            let stdout = decode_command_bytes(&out.stdout).trim().to_string();
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("Open command failed for: {}", target)
            };
            CommandResult {
                success: false,
                output: detail,
            }
        }
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
#[cfg(not(test))]
fn pick_directory(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let _ = window.set_always_on_top(false);
    let picked = window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .transpose()?;
    Ok(picked)
}

#[tauri::command]
#[cfg(test)]
fn pick_directory(_window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
fn set_wallpaper_mode(
    enabled: bool,
    state: tauri::State<'_, Mutex<WallpaperState>>,
    window: tauri::WebviewWindow,
) -> Result<WallpaperMode, String> {
    let mode = apply_wallpaper_mode(enabled, state.inner(), &window)?;
    let _ = window.emit("lumi:wallpaper-mode-changed", mode.clone());
    Ok(mode)
}

#[tauri::command]
fn get_wallpaper_mode(
    state: tauri::State<'_, Mutex<WallpaperState>>,
) -> Result<WallpaperMode, String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    Ok(WallpaperMode { enabled })
}

fn apply_wallpaper_mode(
    enabled: bool,
    state: &Mutex<WallpaperState>,
    window: &tauri::WebviewWindow,
) -> Result<WallpaperMode, String> {
    let restore = {
        let mut wallpaper = state.lock().map_err(|e| e.to_string())?;
        if enabled {
            if !wallpaper.enabled {
                wallpaper.previous_size = window.outer_size().ok();
                wallpaper.previous_position = window.outer_position().ok();
                wallpaper.was_fullscreen = window.is_fullscreen().unwrap_or(false);
                wallpaper.was_maximized = window.is_maximized().unwrap_or(false);
            }
            wallpaper.enabled = true;
            None
        } else {
            wallpaper.enabled = false;
            Some((
                wallpaper.previous_size.take(),
                wallpaper.previous_position.take(),
                wallpaper.was_fullscreen,
                wallpaper.was_maximized,
            ))
        }
    };

    if enabled {
        let _ = window.show();
        let _ = window.set_fullscreen(false);
        let _ = window.unmaximize();
        let _ = window.set_resizable(true);
        let _ = window.set_decorations(false);
        let _ = window.set_shadow(false);
        // Keep the macOS Dock icon available as a guaranteed escape hatch. A
        // click-through NSWindow cannot receive its own on-screen exit click.
        #[cfg(target_os = "macos")]
        let _ = window.set_skip_taskbar(false);
        #[cfg(not(target_os = "macos"))]
        let _ = window.set_skip_taskbar(true);

        let maybe_monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = maybe_monitor {
            let pos = monitor.position();
            let size = monitor.size();
            let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
        } else {
            let _ = window.maximize();
        }

        match window.set_always_on_top(true) {
            Ok(_) => println!("[LumiOS] set_always_on_top(true) succeeded"),
            Err(e) => eprintln!("[LumiOS] set_always_on_top(true) FAILED: {}", e),
        }
        match window.set_ignore_cursor_events(true) {
            Ok(_) => println!("[LumiOS] set_ignore_cursor_events(true) succeeded"),
            Err(e) => eprintln!("[LumiOS] set_ignore_cursor_events(true) FAILED: {}", e),
        }
    } else {
        match window.set_ignore_cursor_events(false) {
            Ok(_) => println!("[LumiOS] set_ignore_cursor_events(false) succeeded"),
            Err(e) => eprintln!("[LumiOS] set_ignore_cursor_events(false) FAILED: {}", e),
        }
        match window.set_always_on_top(false) {
            Ok(_) => println!("[LumiOS] set_always_on_top(false) succeeded"),
            Err(e) => eprintln!("[LumiOS] set_always_on_top(false) FAILED: {}", e),
        }
        let _ = window.set_skip_taskbar(false);
        let _ = window.set_resizable(true);
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(
            DEFAULT_MAIN_MIN_WIDTH as f64,
            DEFAULT_MAIN_MIN_HEIGHT as f64,
        )));

        if let Some((previous_size, previous_position, was_fullscreen, was_maximized)) = restore {
            if was_fullscreen {
                let _ = window.set_fullscreen(true);
            } else {
                let _ = window.set_fullscreen(false);
                if let Some(size) = previous_size {
                    let _ = window.set_size(size);
                }
                if let Some(position) = previous_position {
                    let _ = window.set_position(position);
                } else {
                    let _ = window.center();
                }
                if was_maximized {
                    let _ = window.maximize();
                }
            }
        }
    }

    println!(
        "[LumiOS] Wallpaper mode: {}",
        if enabled {
            "ON (click-through fullscreen)"
        } else {
            "OFF"
        }
    );
    Ok(WallpaperMode { enabled })
}

const DESKTOP_WIDGET_WIDTH: u32 = 240;
const DESKTOP_WIDGET_HEIGHT: u32 = 285;
const DESKTOP_WIDGET_MIN_WIDTH: u32 = 210;
const DESKTOP_WIDGET_MIN_HEIGHT: u32 = 250;
const DESKTOP_WIDGET_MARGIN: i32 = 18;
const DEFAULT_MAIN_MIN_WIDTH: u32 = 520;
const DEFAULT_MAIN_MIN_HEIGHT: u32 = 460;

fn place_window_in_desktop_corner(window: &tauri::WebviewWindow) -> Result<(), String> {
    let maybe_monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = maybe_monitor {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let max_x = monitor_pos.x + monitor_size.width as i32
            - DESKTOP_WIDGET_WIDTH as i32
            - DESKTOP_WIDGET_MARGIN;
        let max_y = monitor_pos.y + monitor_size.height as i32
            - DESKTOP_WIDGET_HEIGHT as i32
            - DESKTOP_WIDGET_MARGIN;
        let x = max_x.max(monitor_pos.x + DESKTOP_WIDGET_MARGIN);
        let y = max_y.max(monitor_pos.y + DESKTOP_WIDGET_MARGIN);
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    } else {
        window.center().map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn apply_desktop_widget_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.show();
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    window
        .set_min_size(Some(tauri::PhysicalSize::new(
            DESKTOP_WIDGET_MIN_WIDTH,
            DESKTOP_WIDGET_MIN_HEIGHT,
        )))
        .map_err(|e| e.to_string())?;
    if let Err(e) = window.set_resizable(false) {
        eprintln!("[LumiOS] desktop widget set_resizable(false) failed: {}", e);
    }
    if let Err(e) = window.set_decorations(false) {
        eprintln!(
            "[LumiOS] desktop widget set_decorations(false) failed: {}",
            e
        );
    }
    if let Err(e) = window.set_shadow(false) {
        eprintln!("[LumiOS] desktop widget set_shadow(false) failed: {}", e);
    }
    let _ = window.set_skip_taskbar(true);
    if let Err(e) = window.set_always_on_top(true) {
        eprintln!(
            "[LumiOS] desktop widget set_always_on_top(true) failed: {}",
            e
        );
    }
    window
        .set_size(tauri::PhysicalSize::new(
            DESKTOP_WIDGET_WIDTH,
            DESKTOP_WIDGET_HEIGHT,
        ))
        .map_err(|e| e.to_string())?;
    place_window_in_desktop_corner(window)?;
    let _ = window.set_focus();
    Ok(())
}

fn enter_desktop_widget_impl(
    window: &tauri::WebviewWindow,
    state: &Mutex<DesktopWidgetState>,
) -> Result<DesktopWidgetMode, String> {
    {
        let mut widget = state.lock().map_err(|e| e.to_string())?;
        if !widget.enabled {
            widget.previous_size = window.outer_size().ok();
            widget.previous_position = window.outer_position().ok();
            widget.was_fullscreen = window.is_fullscreen().unwrap_or(false);
            widget.was_maximized = window.is_maximized().unwrap_or(false);
        }
        widget.enabled = true;
    }

    apply_desktop_widget_window(window)?;
    Ok(DesktopWidgetMode { enabled: true })
}

fn exit_desktop_widget_impl(
    window: &tauri::WebviewWindow,
    state: &Mutex<DesktopWidgetState>,
) -> Result<DesktopWidgetMode, String> {
    let (previous_size, previous_position, was_fullscreen, was_maximized) = {
        let mut widget = state.lock().map_err(|e| e.to_string())?;
        widget.enabled = false;
        (
            widget.previous_size.take(),
            widget.previous_position.take(),
            widget.was_fullscreen,
            widget.was_maximized,
        )
    };

    let _ = window.show();
    let _ = window.set_always_on_top(false);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_shadow(false);
    if let Err(e) = window.set_decorations(false) {
        eprintln!("[LumiOS] desktop widget restore decorations failed: {}", e);
    }
    if let Err(e) = window.set_resizable(true) {
        eprintln!("[LumiOS] desktop widget restore resizable failed: {}", e);
    }
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            DEFAULT_MAIN_MIN_WIDTH as f64,
            DEFAULT_MAIN_MIN_HEIGHT as f64,
        )))
        .map_err(|e| e.to_string())?;

    if was_fullscreen {
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    } else {
        let _ = window.set_fullscreen(false);
        if let Some(size) = previous_size {
            let _ = window.set_size(size);
        } else {
            let _ = window.set_size(tauri::PhysicalSize::new(1280, 820));
        }
        if let Some(position) = previous_position {
            let _ = window.set_position(position);
        } else {
            let _ = window.center();
        }
        if was_maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.set_focus();
    Ok(DesktopWidgetMode { enabled: false })
}

#[tauri::command]
fn enter_desktop_widget_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    enter_desktop_widget_impl(&window, &state)
}

#[tauri::command]
fn exit_desktop_widget_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    exit_desktop_widget_impl(&window, &state)
}

#[tauri::command]
fn toggle_desktop_widget_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    if enabled {
        exit_desktop_widget_impl(&window, &state)
    } else {
        enter_desktop_widget_impl(&window, &state)
    }
}

#[tauri::command]
fn get_desktop_widget_mode(
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    Ok(DesktopWidgetMode { enabled })
}

fn compact_window_metrics(window: &tauri::WebviewWindow) -> (u32, u32, u32, u32, i32) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (work_width, work_height) = monitor
        .as_ref()
        .map(|monitor| {
            let scale_factor = monitor.scale_factor().max(0.1);
            let work_area = monitor.work_area();
            (
                work_area.size.width as f64 / scale_factor,
                work_area.size.height as f64 / scale_factor,
            )
        })
        .unwrap_or((1920.0, 1040.0));
    let margin = ((work_width.min(work_height) * 0.02).round() as i32).clamp(12, 24);
    let available_width = (work_width - margin as f64 * 2.0).max(360.0);
    let available_height = (work_height - margin as f64 * 2.0).max(320.0);
    let min_width = 520.0_f64.min(available_width);
    let min_height = 460.0_f64.min(available_height);
    let preset_min_width = 680.0_f64.min(available_width);
    let preset_min_height = 560.0_f64.min(available_height);
    let width = 1280.0_f64.min(available_width).max(preset_min_width);
    let height = 820.0_f64.min(available_height).max(preset_min_height);
    (
        width.round() as u32,
        height.round() as u32,
        min_width.round() as u32,
        min_height.round() as u32,
        margin,
    )
}

fn apply_compact_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let (width, height, min_width, min_height, _margin) = compact_window_metrics(window);
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let _ = window.show();
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    let _ = window.set_always_on_top(false);
    let _ = window.set_skip_taskbar(false);
    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            min_width as f64,
            min_height as f64,
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())?;

    if let Some(monitor) = monitor {
        let scale_factor = monitor.scale_factor().max(0.1);
        let work_area = monitor.work_area();
        let physical_width = (width as f64 * scale_factor).round() as i32;
        let physical_height = (height as f64 * scale_factor).round() as i32;
        let x = work_area.position.x + (work_area.size.width as i32 - physical_width) / 2;
        let y = work_area.position.y + (work_area.size.height as i32 - physical_height) / 2;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    } else {
        window.center().map_err(|e| e.to_string())?;
    }
    let _ = window.set_focus();
    Ok(())
}

fn enter_compact_window_impl(
    window: &tauri::WebviewWindow,
    state: &Mutex<CompactWindowState>,
) -> Result<CompactWindowMode, String> {
    let already_enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    let restore_snapshot = (!already_enabled).then(|| {
        (
            window.outer_size().ok(),
            window.outer_position().ok(),
            window.is_fullscreen().unwrap_or(false),
            window.is_maximized().unwrap_or(false),
        )
    });
    apply_compact_window(window)?;
    let mut compact = state.lock().map_err(|e| e.to_string())?;
    if let Some((size, position, fullscreen, maximized)) = restore_snapshot {
        compact.previous_size = size;
        compact.previous_position = position;
        compact.was_fullscreen = fullscreen;
        compact.was_maximized = maximized;
    }
    compact.enabled = true;
    Ok(CompactWindowMode { enabled: true })
}

fn exit_compact_window_impl(
    window: &tauri::WebviewWindow,
    state: &Mutex<CompactWindowState>,
) -> Result<CompactWindowMode, String> {
    let (previous_size, previous_position, was_fullscreen, was_maximized) = {
        let mut compact = state.lock().map_err(|e| e.to_string())?;
        if !compact.enabled {
            return Ok(CompactWindowMode { enabled: false });
        }
        compact.enabled = false;
        (
            compact.previous_size.take(),
            compact.previous_position.take(),
            compact.was_fullscreen,
            compact.was_maximized,
        )
    };

    let _ = window.show();
    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            DEFAULT_MAIN_MIN_WIDTH as f64,
            DEFAULT_MAIN_MIN_HEIGHT as f64,
        )))
        .map_err(|e| e.to_string())?;
    if was_fullscreen {
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    } else {
        let _ = window.set_fullscreen(false);
        if let Some(size) = previous_size {
            let _ = window.set_size(size);
        } else {
            let _ = window.set_size(tauri::LogicalSize::new(1280.0, 820.0));
        }
        if let Some(position) = previous_position {
            let _ = window.set_position(position);
        } else {
            let _ = window.center();
        }
        if was_maximized {
            let _ = window.maximize();
        }
    }
    let _ = window.set_focus();
    Ok(CompactWindowMode { enabled: false })
}

#[tauri::command]
fn toggle_compact_window_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<CompactWindowState>>,
) -> Result<CompactWindowMode, String> {
    if state.lock().map_err(|e| e.to_string())?.enabled {
        exit_compact_window_impl(&window, &state)
    } else {
        enter_compact_window_impl(&window, &state)
    }
}

#[tauri::command]
fn exit_compact_window_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<CompactWindowState>>,
) -> Result<CompactWindowMode, String> {
    exit_compact_window_impl(&window, &state)
}

#[tauri::command]
fn get_compact_window_mode(
    state: tauri::State<'_, Mutex<CompactWindowState>>,
) -> Result<CompactWindowMode, String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    Ok(CompactWindowMode { enabled })
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // NSWindowWithDecorations:false → native maximize/unmaximize broken.
        // Detect fill state by comparing window size to monitor size.
        let is_filling = match window.primary_monitor() {
            Ok(Some(m)) => {
                let ws = window
                    .outer_size()
                    .unwrap_or(tauri::PhysicalSize::new(0, 0));
                ws.width >= m.size().width.saturating_sub(80)
                    && ws.height >= m.size().height.saturating_sub(80)
            }
            _ => false,
        };
        if is_filling {
            let _ = window.center();
            return window
                .set_size(tauri::PhysicalSize::new(1280, 820))
                .map_err(|e| e.to_string());
        }
        if let Ok(Some(m)) = window.primary_monitor() {
            let _ =
                window.set_position(tauri::PhysicalPosition::new(m.position().x, m.position().y));
            return window
                .set_size(tauri::PhysicalSize::new(m.size().width, m.size().height))
                .map_err(|e| e.to_string());
        }
        return Err("no monitor".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let is_max = window.is_maximized().unwrap_or(false);
        if is_max {
            window.unmaximize().map_err(|e| e.to_string())
        } else {
            window.maximize().map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn close_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<ResidentState>>,
) -> Result<(), String> {
    let should_hide = state.lock().map_err(|e| e.to_string())?.close_to_background;
    if should_hide {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.close().map_err(|e| e.to_string())
    }
}

// ── Screen Monitoring Commands ──

#[tauri::command]
fn hide_to_background(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window_impl(&app)
}

#[tauri::command]
fn quit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<ResidentState>>,
) -> Result<(), String> {
    {
        let mut resident = state.lock().map_err(|e| e.to_string())?;
        resident.force_quit = true;
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn set_close_to_background(
    enabled: bool,
    state: tauri::State<'_, Mutex<ResidentState>>,
) -> Result<bool, String> {
    let mut resident = state.lock().map_err(|e| e.to_string())?;
    resident.close_to_background = enabled;
    Ok(enabled)
}

#[tauri::command]
fn get_autostart_enabled() -> Result<bool, String> {
    get_autostart_entry().map(|entry| entry.enabled)
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    set_autostart_entry(enabled)?;
    get_autostart_enabled()
}

#[tauri::command]
fn get_runtime_resilience_status(
    processes: tauri::State<'_, Mutex<BackendProcesses>>,
    resident: tauri::State<'_, Mutex<ResidentState>>,
) -> Result<RuntimeResilienceStatus, String> {
    let mut procs = processes.lock().map_err(|e| e.to_string())?;
    let resident = resident.lock().map_err(|e| e.to_string())?;
    let autostart = get_autostart_entry()?;

    let node_running = child_is_running(&mut procs.node);
    let python_running = child_is_running(&mut procs.python);
    let mut notes = vec![
        "Alt+Space shows or hides Lumi when it is running in the background.".to_string(),
        "Automatic work still depends on Lumi's safety gate, idle gate, and user-confirmed workflows.".to_string(),
    ];
    if !autostart.supported {
        notes.push(
            "Launch at login is currently implemented for Windows current-user installs."
                .to_string(),
        );
    }
    if cfg!(debug_assertions) {
        notes.push("Dev mode uses the development server; packaged release mode supervises the bundled backend process.".to_string());
    }

    Ok(RuntimeResilienceStatus {
        platform: std::env::consts::OS.to_string(),
        autostart_supported: autostart.supported,
        autostart_enabled: autostart.enabled,
        autostart_entry: autostart.value,
        close_to_background: resident.close_to_background,
        started_in_background: resident.started_in_background,
        backend_node_running: node_running,
        backend_python_running: python_running,
        node_restarts: procs.node_restarts,
        python_restarts: procs.python_restarts,
        global_shortcut: "Alt+Space".to_string(),
        notes,
    })
}

struct AutostartEntry {
    supported: bool,
    enabled: bool,
    value: String,
}

fn child_is_running(child: &mut Option<Child>) -> bool {
    match child.as_mut() {
        Some(process) => matches!(process.try_wait(), Ok(None)),
        None => false,
    }
}

#[cfg(target_os = "windows")]
const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_VALUE_NAME: &str = "LumiOS";

#[cfg(target_os = "windows")]
fn hidden_output(cmd: &mut Command) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000u32);
    cmd.output()
}

#[cfg(target_os = "windows")]
fn get_autostart_entry() -> Result<AutostartEntry, String> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", WINDOWS_RUN_KEY, "/v", AUTOSTART_VALUE_NAME]);
    let output = hidden_output(&mut cmd).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(AutostartEntry {
            supported: true,
            enabled: false,
            value: String::new(),
        });
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let normalized = text.to_lowercase();
    Ok(AutostartEntry {
        supported: true,
        enabled: !exe.is_empty() && normalized.contains(&exe),
        value: text.trim().to_string(),
    })
}

#[cfg(not(target_os = "windows"))]
fn get_autostart_entry() -> Result<AutostartEntry, String> {
    Ok(AutostartEntry {
        supported: false,
        enabled: false,
        value: String::new(),
    })
}

#[cfg(target_os = "windows")]
fn set_autostart_entry(enabled: bool) -> Result<(), String> {
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let value = format!("\"{}\" --background", exe.to_string_lossy());
        let mut cmd = Command::new("reg");
        cmd.args([
            "add",
            WINDOWS_RUN_KEY,
            "/v",
            AUTOSTART_VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &value,
            "/f",
        ]);
        let output = hidden_output(&mut cmd).map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    } else {
        let mut cmd = Command::new("reg");
        cmd.args(["delete", WINDOWS_RUN_KEY, "/v", AUTOSTART_VALUE_NAME, "/f"]);
        let output = hidden_output(&mut cmd).map_err(|e| e.to_string())?;
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if output.status.success()
            || stderr.contains("unable to find")
            || stderr.contains("not found")
        {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn set_autostart_entry(_enabled: bool) -> Result<(), String> {
    Err("Launch at login is currently implemented for Windows builds.".to_string())
}

fn show_main_window_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let wallpaper_enabled = app
        .state::<Mutex<WallpaperState>>()
        .lock()
        .map(|state| state.enabled)
        .unwrap_or(false);
    let restore_result = if wallpaper_enabled {
        let state = app.state::<Mutex<WallpaperState>>();
        let result = apply_wallpaper_mode(false, state.inner(), &window);
        if result.is_ok() {
            let _ = window.emit(
                "lumi:wallpaper-mode-changed",
                WallpaperMode { enabled: false },
            );
        }
        result.map(|_| ())
    } else {
        Ok(())
    };
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())?;
    restore_result
}

fn hide_main_window_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Lumi", true, None::<&str>)?;
    let exit_wallpaper = MenuItem::with_id(
        app,
        "exit_wallpaper",
        "Exit Wallpaper Mode",
        true,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(app, "hide", "Hide to Background", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &exit_wallpaper, &hide, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Lumi OS is ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_main_window_impl(app);
            }
            "exit_wallpaper" => {
                let _ = show_main_window_impl(app);
            }
            "hide" => {
                let _ = hide_main_window_impl(app);
            }
            "quit" => {
                let state = app.state::<Mutex<ResidentState>>();
                if let Ok(mut resident) = state.lock() {
                    resident.force_quit = true;
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window_impl(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveWindowInfo {
    pub window_id: String,
    pub title: String,
    pub process_name: String,
    pub pid: u32,
    pub executable_path: String,
    pub publisher: String,
    pub product_name: String,
    pub product_version: String,
    pub window_class: String,
    pub signature_status: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WindowsBinaryIdentity {
    publisher: String,
    product_name: String,
    product_version: String,
    signature_status: String,
}

#[cfg(target_os = "windows")]
fn get_windows_binary_identity(executable_path: &str) -> WindowsBinaryIdentity {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<HashMap<String, WindowsBinaryIdentity>>> = OnceLock::new();
    let key = executable_path.trim().to_lowercase();
    if key.is_empty() {
        return WindowsBinaryIdentity::default();
    }
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(&key) {
            return cached.clone();
        }
    }

    let escaped_path = executable_path.replace('\'', "''");
    let script = format!(
        r#"$item = Get-Item -LiteralPath '{}'
$signature = Get-AuthenticodeSignature -LiteralPath '{}'
$publisher = if ($signature.SignerCertificate) {{ [string]$signature.SignerCertificate.Subject }} else {{ [string]$item.VersionInfo.CompanyName }}
[PSCustomObject]@{{
  publisher = $publisher
  product_name = [string]$item.VersionInfo.ProductName
  product_version = [string]$item.VersionInfo.ProductVersion
  signature_status = [string]$signature.Status
}} | ConvertTo-Json -Compress"#,
        escaped_path, escaped_path,
    );
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000u32);
    let mut identity = WindowsBinaryIdentity::default();
    if let Ok(mut child) = command.spawn() {
        let started = Instant::now();
        let completed = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if started.elapsed() < Duration::from_millis(2500) => {
                    std::thread::sleep(Duration::from_millis(15));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        if completed {
            let mut output = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                let _ = stdout.read_to_string(&mut output);
            }
            identity = serde_json::from_str(output.trim()).unwrap_or_default();
        }
    }
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, identity.clone());
    }
    identity
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub window_title: String,
    pub cpu_percent: f32,
    pub memory_mb: f32,
}

/// sysinfo reports a process relative to one logical CPU, so a multi-threaded
/// process can legitimately exceed 100. The desktop API exposes whole-machine
/// share instead because that is the percentage users expect in conversation.
fn normalize_process_cpu_percent(raw_percent: f32, logical_cpu_count: usize) -> f32 {
    (raw_percent / logical_cpu_count.max(1) as f32).clamp(0.0, 100.0)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureResult {
    pub image_base64: String,
    pub screen_x: i32,
    pub screen_y: i32,
    pub width: u32,
    pub height: u32,
    /// Coordinate-space size expected by native input APIs. On Retina macOS
    /// displays this can be smaller than the PNG pixel dimensions.
    pub input_width: u32,
    pub input_height: u32,
}

#[tauri::command]
fn get_active_window_info() -> ActiveWindowInfo {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let mut window_id = String::new();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let window_id = String::new();
    let mut title = String::new();
    let mut process_name = String::new();
    #[cfg(target_os = "windows")]
    let mut executable_path = String::new();
    #[cfg(not(target_os = "windows"))]
    let executable_path = String::new();
    #[cfg(target_os = "windows")]
    let mut publisher = String::new();
    #[cfg(not(target_os = "windows"))]
    let publisher = String::new();
    #[cfg(target_os = "windows")]
    let mut product_name = String::new();
    #[cfg(not(target_os = "windows"))]
    let product_name = String::new();
    #[cfg(target_os = "windows")]
    let mut product_version = String::new();
    #[cfg(not(target_os = "windows"))]
    let product_version = String::new();
    #[cfg(target_os = "windows")]
    let mut window_class = String::new();
    #[cfg(not(target_os = "windows"))]
    let window_class = String::new();
    #[cfg(target_os = "windows")]
    let mut signature_status = String::new();
    #[cfg(not(target_os = "windows"))]
    let signature_status = String::new();
    #[allow(unused_mut)]
    let mut pid: u32 = 0;
    #[allow(unused_mut)]
    let mut x: i32 = 0;
    #[allow(unused_mut)]
    let mut y: i32 = 0;
    #[allow(unused_mut)]
    let mut width: i32 = 0;
    #[allow(unused_mut)]
    let mut height: i32 = 0;

    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct Rect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        extern "system" {
            fn GetForegroundWindow() -> isize;
            fn IsWindow(hwnd: isize) -> i32;
            fn IsWindowVisible(hwnd: isize) -> i32;
            fn GetWindowTextW(hwnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
            fn GetWindowThreadProcessId(hwnd: isize, lpdwProcessId: *mut u32) -> u32;
            fn GetWindowRect(hwnd: isize, lpRect: *mut Rect) -> i32;
            fn GetClassNameW(hwnd: isize, lpClassName: *mut u16, nMaxCount: i32) -> i32;
        }
        unsafe {
            let mut hwnd = GetForegroundWindow();
            // Remote-control overlays and a few UWP focus transitions can leave
            // Windows without a foreground HWND even though SetForegroundWindow
            // just succeeded. In that narrow case, retain the exact visible
            // HWND/PID/title that the native app resolver focused. The fallback
            // expires quickly and is never used when Windows reports another
            // foreground window, so ordinary target-mismatch checks stay strict.
            if hwnd == 0 {
                if let Ok(mut recent) = recently_focused_windows_app().lock() {
                    let valid = recent.as_ref().is_some_and(|focused| {
                        focused.recorded_at.elapsed() <= Duration::from_secs(5)
                            && IsWindow(focused.hwnd) != 0
                            && IsWindowVisible(focused.hwnd) != 0
                    });
                    if valid {
                        if let Some(focused) = recent.as_ref() {
                            hwnd = focused.hwnd;
                        }
                    } else {
                        *recent = None;
                    }
                }
            }
            if hwnd != 0 {
                window_id = hwnd.to_string();
                let mut buf: [u16; 512] = [0; 512];
                let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 512);
                title = String::from_utf16_lossy(&buf[..len as usize]);
                let mut class_buf: [u16; 256] = [0; 256];
                let class_len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
                if class_len > 0 {
                    window_class = String::from_utf16_lossy(&class_buf[..class_len as usize]);
                }
                GetWindowThreadProcessId(hwnd, &mut pid);
                if let Ok(recent) = recently_focused_windows_app().lock() {
                    if let Some(focused) = recent.as_ref() {
                        if hwnd == focused.hwnd && (pid != focused.pid || title != focused.title) {
                            window_id.clear();
                            title.clear();
                            pid = 0;
                        }
                    }
                }
                let mut rect = Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if GetWindowRect(hwnd, &mut rect) != 0 {
                    x = rect.left;
                    y = rect.top;
                    width = (rect.right - rect.left).max(0);
                    height = (rect.bottom - rect.top).max(0);
                }
            }
        }
        if pid != 0 {
            use sysinfo::System;
            let sys = System::new_all();
            if let Some(process) = sys.process(sysinfo::Pid::from(pid as usize)) {
                process_name = process.name().to_string_lossy().to_string();
                executable_path = process
                    .exe()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_default();
            }
            let identity = get_windows_binary_identity(&executable_path);
            publisher = identity.publisher;
            product_name = identity.product_name;
            product_version = identity.product_version;
            signature_status = identity.signature_status;
        }
    }
    #[cfg(target_os = "linux")]
    {
        // xdotool getactivewindow getwindowname
        if let Ok(out) = Command::new("xdotool")
            .args(["getactivewindow", "getwindowname"])
            .output()
        {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                title = name.clone();
                process_name = name;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args(["-e", r#"
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set appName to name of frontProcess
  set appPid to unix id of frontProcess
  set windowTitle to ""
  set windowX to 0
  set windowY to 0
  set windowWidth to 0
  set windowHeight to 0
  if (count of windows of frontProcess) > 0 then
    set frontWindow to front window of frontProcess
    try
      set windowTitle to name of frontWindow
    end try
    try
      set windowPosition to position of frontWindow
      set windowX to item 1 of windowPosition
      set windowY to item 2 of windowPosition
    end try
    try
      set windowSize to size of frontWindow
      set windowWidth to item 1 of windowSize
      set windowHeight to item 2 of windowSize
    end try
  end if
  return appName & tab & appPid & tab & windowTitle & tab & windowX & tab & windowY & tab & windowWidth & tab & windowHeight
end tell
"#])
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let fields: Vec<&str> = text.split('\t').collect();
            if let Some(name) = fields
                .first()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                process_name = name.to_string();
                title = fields
                    .get(2)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| name.to_string());
                pid = fields
                    .get(1)
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                window_id = if pid > 0 {
                    pid.to_string()
                } else {
                    String::new()
                };
                x = fields
                    .get(3)
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                y = fields
                    .get(4)
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                width = fields
                    .get(5)
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                height = fields
                    .get(6)
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
            }
        }
    }
    ActiveWindowInfo {
        window_id,
        title,
        process_name,
        pid,
        executable_path,
        publisher,
        product_name,
        product_version,
        window_class,
        signature_status,
        x,
        y,
        width,
        height,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowControlResult {
    pub ok: bool,
    pub status: String,
    pub action: String,
    pub before: ActiveWindowInfo,
    pub after: ActiveWindowInfo,
    pub error: String,
}

#[tauri::command]
fn control_active_window(action: String) -> WindowControlResult {
    let normalized = action.trim().to_lowercase();
    let before = get_active_window_info();
    if !matches!(normalized.as_str(), "maximize" | "minimize" | "restore") {
        return WindowControlResult {
            ok: false,
            status: "invalid_action".to_string(),
            action: normalized,
            before: before.clone(),
            after: before,
            error: "Action must be maximize, minimize, or restore".to_string(),
        };
    }
    if before.window_id.is_empty() && before.pid == 0 {
        return WindowControlResult {
            ok: false,
            status: "no_active_window".to_string(),
            action: normalized,
            before: before.clone(),
            after: before,
            error: "No active desktop window was found".to_string(),
        };
    }

    let mut command_ok = false;
    let mut command_error = String::new();

    #[cfg(target_os = "windows")]
    unsafe {
        extern "system" {
            fn GetForegroundWindow() -> isize;
            fn ShowWindow(hwnd: isize, nCmdShow: i32) -> i32;
            fn SetForegroundWindow(hwnd: isize) -> i32;
        }
        const SW_MINIMIZE: i32 = 6;
        const SW_MAXIMIZE: i32 = 3;
        const SW_RESTORE: i32 = 9;
        let hwnd = GetForegroundWindow();
        if hwnd != 0 {
            let mode = match normalized.as_str() {
                "maximize" => SW_MAXIMIZE,
                "minimize" => SW_MINIMIZE,
                _ => SW_RESTORE,
            };
            ShowWindow(hwnd, mode);
            if normalized != "minimize" {
                SetForegroundWindow(hwnd);
            }
            command_ok = true;
        } else {
            command_error = "The foreground window disappeared before control".to_string();
        }
    }

    #[cfg(target_os = "macos")]
    {
        let script = match normalized.as_str() {
            "minimize" => {
                r#"tell application "System Events"
set frontProcess to first application process whose frontmost is true
if (count of windows of frontProcess) is 0 then error "No front window"
set value of attribute "AXMinimized" of front window of frontProcess to true
end tell"#
            }
            "maximize" => {
                r#"tell application "System Events"
set frontProcess to first application process whose frontmost is true
if (count of windows of frontProcess) is 0 then error "No front window"
set frontWindow to front window of frontProcess
try
perform action "AXZoomWindow" of frontWindow
on error
click button 2 of frontWindow
end try
end tell"#
            }
            _ => {
                r#"tell application "System Events"
set frontProcess to first application process whose frontmost is true
if (count of windows of frontProcess) is 0 then error "No front window"
set frontWindow to front window of frontProcess
try
set value of attribute "AXMinimized" of frontWindow to false
end try
try
perform action "AXZoomWindow" of frontWindow
end try
end tell"#
            }
        };
        match Command::new("osascript").args(["-e", script]).output() {
            Ok(output) if output.status.success() => command_ok = true,
            Ok(output) => {
                command_error = String::from_utf8_lossy(&output.stderr).trim().to_string()
            }
            Err(error) => command_error = error.to_string(),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let result = if normalized == "minimize" {
            Command::new("sh")
                .args(["-c", "xdotool getactivewindow windowminimize"])
                .output()
        } else {
            let mode = if normalized == "maximize" {
                "add"
            } else {
                "remove"
            };
            Command::new("wmctrl")
                .args([
                    "-r",
                    ":ACTIVE:",
                    "-b",
                    &format!("{},maximized_vert,maximized_horz", mode),
                ])
                .output()
        };
        match result {
            Ok(output) if output.status.success() => command_ok = true,
            Ok(output) => {
                command_error = String::from_utf8_lossy(&output.stderr).trim().to_string()
            }
            Err(error) => command_error = error.to_string(),
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(180));
    let after = get_active_window_info();
    let same_window = normalized == "minimize"
        || before.window_id == after.window_id
        || (before.pid != 0 && before.pid == after.pid);
    WindowControlResult {
        ok: command_ok && same_window,
        status: if command_ok && same_window {
            "verified"
        } else {
            "failed"
        }
        .to_string(),
        action: normalized,
        before,
        after,
        error: command_error,
    }
}

#[tauri::command]
fn get_running_processes() -> Vec<ProcessInfo> {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(50));
    sys.refresh_all();

    let logical_cpu_count = sys.cpus().len().max(1);

    let mut processes: Vec<ProcessInfo> = Vec::new();
    for (pid, proc) in sys.processes() {
        let raw_cpu = proc.cpu_usage();
        let cpu = normalize_process_cpu_percent(raw_cpu, logical_cpu_count);
        let mem = proc.memory() as f32 / 1024.0 / 1024.0; // bytes -> MB
        let name = proc.name().to_string_lossy().to_string();
        // Only include processes using >0.1% CPU or >10MB memory (reduce noise)
        if raw_cpu > 0.1 || mem > 10.0 {
            processes.push(ProcessInfo {
                pid: pid.as_u32(),
                name,
                window_title: String::new(),
                cpu_percent: cpu,
                memory_mb: mem,
            });
        }
    }
    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes.truncate(50); // top 50
    processes
}

// ── Clipboard Commands ──

#[tauri::command]
fn get_clipboard_text() -> String {
    use arboard::Clipboard;
    match Clipboard::new() {
        Ok(mut clipboard) => clipboard.get_text().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn set_clipboard_text(text: String) -> bool {
    use arboard::Clipboard;
    match Clipboard::new() {
        Ok(mut clipboard) => clipboard.set_text(text).is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
fn set_clipboard_files(paths: Vec<String>) -> Result<bool, String> {
    use arboard::Clipboard;
    let files: Vec<PathBuf> = paths
        .into_iter()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|value| !value.as_os_str().is_empty())
        .collect();
    if files.is_empty() {
        return Err("At least one file path is required".to_string());
    }
    for file in &files {
        if !file.is_file() {
            return Err(format!(
                "Clipboard file does not exist or is not a file: {}",
                file.display()
            ));
        }
    }
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set()
        .file_list(&files)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

// ── Idle Time ──

#[derive(Debug, Serialize, Deserialize)]
pub struct IdleInfo {
    pub idle_ms: u64,
    pub idle_seconds: u64,
}

#[tauri::command]
fn get_idle_time() -> IdleInfo {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct LastInputInfo {
            cb_size: u32,
            tick_count: u32,
        }
        extern "system" {
            fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
            fn GetTickCount() -> u32;
        }
        unsafe {
            let mut lii = LastInputInfo {
                cb_size: std::mem::size_of::<LastInputInfo>() as u32,
                tick_count: 0,
            };
            if GetLastInputInfo(&mut lii) != 0 {
                let tick = GetTickCount();
                let idle_ms = (tick.wrapping_sub(lii.tick_count)) as u64;
                return IdleInfo {
                    idle_ms,
                    idle_seconds: idle_ms / 1000,
                };
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // xprintidle returns idle time in ms
        if let Ok(out) = Command::new("xprintidle").output() {
            if let Ok(ms) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                return IdleInfo {
                    idle_ms: ms,
                    idle_seconds: ms / 1000,
                };
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    IdleInfo {
        idle_ms: 0,
        idle_seconds: 0,
    };
    IdleInfo {
        idle_ms: 0,
        idle_seconds: 0,
    }
}

// ── System Audio Volume (winmm.dll) ──

#[tauri::command]
fn get_system_volume() -> f32 {
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn waveOutGetVolume(hwo: u32, pdwVolume: *mut u32) -> u32;
        }
        unsafe {
            let mut vol: u32 = 0;
            if waveOutGetVolume(0xFFFFFFFFu32, &mut vol) == 0 {
                let left = (vol & 0xFFFF) as f32;
                let right = ((vol >> 16) & 0xFFFF) as f32;
                let avg = (left + right) / 2.0;
                return (avg / 65535.0 * 100.0).round();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = Command::new("pactl")
            .args(["get-sink-volume", "@DEFAULT_SINK@"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for part in text.split_whitespace() {
                if part.ends_with('%') {
                    if let Ok(v) = part.trim_end_matches('%').parse::<f32>() {
                        return v;
                    }
                }
            }
        }
    }
    50.0 // fallback
}

#[tauri::command]
fn set_system_volume(level: f32) -> Result<f32, String> {
    let clamped = if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 100.0)
    };
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn waveOutSetVolume(hwo: u32, dwVolume: u32) -> u32;
        }
        let raw = ((clamped / 100.0) * 65535.0) as u32;
        let vol = raw | (raw << 16); // both channels
        unsafe {
            if waveOutSetVolume(0xFFFFFFFFu32, vol) == 0 {
                return Ok(clamped);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("pactl")
            .args([
                "set-sink-volume",
                "@DEFAULT_SINK@",
                &format!("{}%", clamped as u32),
            ])
            .output();
    }
    Ok(clamped) // web fallback: just report the value
}

// ── Monitor Brightness (dxva2.dll + user32.dll) ──

#[cfg(target_os = "windows")]
mod brightness_ffi {
    #[repr(C)]
    pub struct PhysicalMonitor {
        pub h_physical_monitor: isize,
        pub description: [u16; 128],
    }

    extern "system" {
        pub fn MonitorFromPoint(x: i32, y: i32, dwFlags: u32) -> isize;
        pub fn GetPhysicalMonitorsFromHMONITOR(
            h_monitor: isize,
            array_size: u32,
            array: *mut PhysicalMonitor,
        ) -> i32;
        pub fn GetMonitorBrightness(
            h_monitor: isize,
            min_brightness: *mut u32,
            current: *mut u32,
            max_brightness: *mut u32,
        ) -> i32;
        pub fn SetMonitorBrightness(h_monitor: isize, new_brightness: u32) -> i32;
        pub fn DestroyPhysicalMonitors(array_size: u32, array: *mut PhysicalMonitor) -> i32;
    }
}

#[tauri::command]
fn get_screen_brightness() -> f32 {
    #[cfg(target_os = "windows")]
    unsafe {
        use brightness_ffi::*;
        // MONITOR_DEFAULTTONEAREST = 2
        let h_monitor = MonitorFromPoint(0, 0, 2);
        if h_monitor == 0 {
            return 50.0;
        }
        let mut monitors: [PhysicalMonitor; 1] = [PhysicalMonitor {
            h_physical_monitor: 0,
            description: [0u16; 128],
        }];
        if GetPhysicalMonitorsFromHMONITOR(h_monitor, 1, monitors.as_mut_ptr()) == 0 {
            return 50.0;
        }
        let h = monitors[0].h_physical_monitor;
        if h == 0 {
            return 50.0;
        }
        let mut min: u32 = 0;
        let mut cur: u32 = 0;
        let mut max: u32 = 0;
        let result = if GetMonitorBrightness(h, &mut min, &mut cur, &mut max) != 0 {
            if max > min {
                ((cur as f32 - min as f32) / (max as f32 - min as f32) * 100.0).round()
            } else {
                50.0
            }
        } else {
            50.0
        };
        DestroyPhysicalMonitors(1, monitors.as_mut_ptr());
        result
    }
    #[cfg(target_os = "linux")]
    {
        // Try brightnessctl first, then fall back to sysfs
        if let Ok(out) = Command::new("brightnessctl").arg("get").output() {
            if let Ok(cur) = String::from_utf8_lossy(&out.stdout).trim().parse::<f32>() {
                if let Ok(max_out) = Command::new("brightnessctl").arg("max").output() {
                    if let Ok(max) = String::from_utf8_lossy(&max_out.stdout)
                        .trim()
                        .parse::<f32>()
                    {
                        if max > 0.0 {
                            return ((cur / max) * 100.0).round();
                        }
                    }
                }
            }
        }
        // sysfs fallback
        if let Ok(entries) = std::fs::read_dir("/sys/class/backlight") {
            for entry in entries.flatten() {
                let base = entry.path();
                if let (Ok(max_str), Ok(cur_str)) = (
                    std::fs::read_to_string(base.join("max_brightness")),
                    std::fs::read_to_string(base.join("brightness")),
                ) {
                    if let (Ok(max), Ok(cur)) =
                        (max_str.trim().parse::<f32>(), cur_str.trim().parse::<f32>())
                    {
                        if max > 0.0 {
                            return ((cur / max) * 100.0).round();
                        }
                    }
                }
            }
        }
        50.0
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    50.0
}

#[tauri::command]
fn set_screen_brightness(level: f32) -> Result<f32, String> {
    let clamped = if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 100.0)
    };
    #[cfg(target_os = "windows")]
    unsafe {
        use brightness_ffi::*;
        let h_monitor = MonitorFromPoint(0, 0, 2);
        if h_monitor == 0 {
            return Ok(clamped);
        }
        let mut monitors: [PhysicalMonitor; 1] = [PhysicalMonitor {
            h_physical_monitor: 0,
            description: [0u16; 128],
        }];
        if GetPhysicalMonitorsFromHMONITOR(h_monitor, 1, monitors.as_mut_ptr()) == 0 {
            return Ok(clamped);
        }
        let h = monitors[0].h_physical_monitor;
        if h == 0 {
            return Ok(clamped);
        }
        let mut min: u32 = 0;
        let mut _cur: u32 = 0;
        let mut max: u32 = 0;
        if GetMonitorBrightness(h, &mut min, &mut _cur, &mut max) != 0 && max > min {
            let raw = (clamped / 100.0 * (max - min) as f32) as u32 + min;
            SetMonitorBrightness(h, raw.max(min).min(max));
        }
        DestroyPhysicalMonitors(1, monitors.as_mut_ptr());
    }
    #[cfg(target_os = "linux")]
    {
        // Try brightnessctl first, then sysfs
        let pct = format!("{}%", clamped as u32);
        let bctl = Command::new("brightnessctl").args(["set", &pct]).output();
        if bctl.is_ok() {
            return Ok(clamped);
        }
        // sysfs fallback
        if let Ok(entries) = std::fs::read_dir("/sys/class/backlight") {
            for entry in entries.flatten() {
                let base = entry.path();
                if let Ok(max_str) = std::fs::read_to_string(base.join("max_brightness")) {
                    if let Ok(max) = max_str.trim().parse::<f32>() {
                        if max > 0.0 {
                            let raw = (clamped / 100.0 * max) as u32;
                            let _ = std::fs::write(base.join("brightness"), raw.to_string());
                        }
                    }
                }
            }
        }
    }
    Ok(clamped)
}

// ── Activity Polling ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ActivitySnapshot {
    pub window: ActiveWindowInfo,
    pub idle: IdleInfo,
    pub running_process_count: usize,
}

#[tauri::command]
fn poll_activity() -> ActivitySnapshot {
    let window = get_active_window_info();
    let idle = get_idle_time();
    let processes = get_running_processes();
    ActivitySnapshot {
        window,
        idle,
        running_process_count: processes.len(),
    }
}

#[tauri::command]
fn capture_screen() -> CaptureResult {
    #[cfg(target_os = "windows")]
    {
        // Write PNG to temp file (avoids stdout truncation for ~8 MB screenshots)
        let temp_path = std::env::temp_dir().join(format!("lumi_scr_{}.png", std::process::id()));
        let temp_file = temp_path.to_string_lossy().replace('\\', "\\\\");

        let mut cmd = Command::new("powershell");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000u32);
        }
        let ps = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$s = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $s.X; $y = $s.Y; $w = $s.Width; $h = $s.Height
$b = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($x, $y, 0, 0, $b.Size)
$g.Dispose()
$b.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output "OK|$x|$y|$w|$h""#,
            temp_file
        );
        let output = cmd
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let parts: Vec<&str> = text.split('|').collect();
            if parts.len() >= 5 && parts[0] == "OK" {
                if let Ok(png) = std::fs::read(&temp_path) {
                    let _ = std::fs::remove_file(&temp_path);
                    if !png.is_empty() {
                        let b64 = base64_encode(&png);
                        return CaptureResult {
                            image_base64: b64,
                            screen_x: parts[1].parse().unwrap_or(0),
                            screen_y: parts[2].parse().unwrap_or(0),
                            width: parts[3].parse().unwrap_or(0),
                            height: parts[4].parse().unwrap_or(0),
                            input_width: parts[3].parse().unwrap_or(0),
                            input_height: parts[4].parse().unwrap_or(0),
                        };
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&temp_path);
    }
    #[cfg(target_os = "macos")]
    {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let temp_path =
            std::env::temp_dir().join(format!("lumi_scr_{}_{}.png", std::process::id(), unique));
        let output = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-m"])
            .arg(&temp_path)
            .output();
        if let Ok(result) = output {
            if result.status.success() {
                if let Ok(png) = std::fs::read(&temp_path) {
                    let _ = std::fs::remove_file(&temp_path);
                    if png.len() >= 24 && &png[0..8] == b"\x89PNG\r\n\x1a\n" {
                        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
                        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
                        let (screen_x, screen_y, input_width, input_height) =
                            mac_main_display_input_geometry();
                        return CaptureResult {
                            image_base64: base64_encode(&png),
                            screen_x,
                            screen_y,
                            width,
                            height,
                            input_width,
                            input_height,
                        };
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&temp_path);
    }
    #[cfg(target_os = "linux")]
    {
        for tool in &["maim", "import"] {
            let args: &[&str] = if *tool == "maim" {
                &["--format=png"]
            } else {
                &["-window", "root", "png:-"]
            };
            if let Ok(png) = Command::new(tool).args(args).output() {
                if png.status.success() && !png.stdout.is_empty() {
                    // shell pipe to base64
                    let pipe = Command::new("sh")
                        .arg("-c")
                        .arg(format!("{} {} | base64 -w0", tool, args.join(" ")))
                        .output();
                    let b64_str = pipe
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .unwrap_or_default();
                    return CaptureResult {
                        image_base64: b64_str,
                        screen_x: 0,
                        screen_y: 0,
                        width: 0,
                        height: 0,
                        input_width: 0,
                        input_height: 0,
                    };
                }
            }
        }
        // xrandr fallback for dimensions
        if let Ok(out) = Command::new("xrandr").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains(" connected") {
                    if let Some(mode) = line.split_whitespace().nth(3) {
                        let parts: Vec<&str> = mode.split('x').collect();
                        if parts.len() == 2 {
                            return CaptureResult {
                                image_base64: String::new(),
                                screen_x: 0,
                                screen_y: 0,
                                width: parts[0].parse().unwrap_or(0),
                                height: parts[1].parse().unwrap_or(0),
                                input_width: parts[0].parse().unwrap_or(0),
                                input_height: parts[1].parse().unwrap_or(0),
                            };
                        }
                    }
                }
            }
        }
    }
    CaptureResult {
        image_base64: String::new(),
        screen_x: 0,
        screen_y: 0,
        width: 0,
        height: 0,
        input_width: 0,
        input_height: 0,
    }
}

/// Simple base64 encoder — avoids pulling in a crate for one function.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[char] = &[
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
        'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
        'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1',
        '2', '3', '4', '5', '6', '7', '8', '9', '+', '/',
    ];
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 0x3F) as usize]);
        out.push(CHARS[((n >> 12) & 0x3F) as usize]);
        out.push(if chunk.len() > 1 {
            CHARS[((n >> 6) & 0x3F) as usize]
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[(n & 0x3F) as usize]
        } else {
            '='
        });
    }
    out
}

// ── Mouse & Keyboard Input Commands (enigo crate) ──

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

// Windows cursor save/restore for independent (virtual) cursor clicks.
// Saves real cursor pos, moves to target, clicks, restores — all within ~2 frames.
#[cfg(target_os = "windows")]
mod cursor_guard {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(lpPoint: *mut Point) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
    }
    pub fn get_pos() -> (i32, i32) {
        let mut pt = Point { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut pt);
        }
        (pt.x, pt.y)
    }
    pub fn restore(x: i32, y: i32) {
        unsafe {
            SetCursorPos(x, y);
        }
    }
}

#[tauri::command]
fn mouse_move(x: f64, y: f64) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .move_mouse(x as i32, y as i32, Coordinate::Abs)
        .map_err(|e| format!("mouse_move: {}", e))?;
    Ok(format!("Mouse moved to ({}, {})", x as i32, y as i32))
}

#[tauri::command]
fn mouse_click(button: String) -> Result<String, String> {
    let btn = match button.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return Err(format!("Unknown button: {}. Use left/right/middle", button)),
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("mouse_click: {}", e))?;
    Ok(format!("Mouse {} click", button))
}

#[tauri::command]
fn mouse_drag(
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    button: String,
) -> Result<String, String> {
    let btn = match button.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return Err(format!("Unknown button: {}. Use left/right/middle", button)),
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .move_mouse(from_x as i32, from_y as i32, Coordinate::Abs)
        .map_err(|e| format!("drag move to start: {}", e))?;
    enigo
        .button(btn, Direction::Press)
        .map_err(|e| format!("drag press: {}", e))?;
    enigo
        .move_mouse(to_x as i32, to_y as i32, Coordinate::Abs)
        .map_err(|e| format!("drag move to end: {}", e))?;
    enigo
        .button(btn, Direction::Release)
        .map_err(|e| format!("drag release: {}", e))?;
    Ok(format!(
        "Dragged from ({}, {}) to ({}, {})",
        from_x as i32, from_y as i32, to_x as i32, to_y as i32
    ))
}

#[tauri::command]
fn keyboard_type(text: String) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .text(&text)
        .map_err(|e| format!("keyboard_type: {}", e))?;
    Ok(format!("Typed {} characters", text.len()))
}

#[tauri::command]
fn keyboard_press(key: String) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;

    let parts: Vec<&str> = key.split('+').map(|s| s.trim()).collect();
    // Parse modifiers first, then the main key
    for &part in &parts[..parts.len().saturating_sub(1)] {
        match part {
            "ctrl" | "control" => enigo
                .key(Key::Control, Direction::Press)
                .map_err(|e| format!("ctrl press: {}", e))?,
            "shift" => enigo
                .key(Key::Shift, Direction::Press)
                .map_err(|e| format!("shift press: {}", e))?,
            "alt" => enigo
                .key(Key::Alt, Direction::Press)
                .map_err(|e| format!("alt press: {}", e))?,
            "meta" | "win" | "cmd" | "super" => enigo
                .key(Key::Meta, Direction::Press)
                .map_err(|e| format!("meta press: {}", e))?,
            _ => {
                return Err(format!(
                    "Unknown modifier: {}. Use ctrl/shift/alt/meta",
                    part
                ))
            }
        }
    }

    let main_key = *parts.last().unwrap_or(&"");
    let key_enum = match main_key {
        "enter" | "return" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "pgup" => Key::PageUp,
        "pagedown" | "pgdn" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ if main_key.len() == 1 => {
            let ch = main_key.chars().next().unwrap();
            if ch.is_ascii_alphanumeric() || ",./;'[]\\-=".contains(ch) {
                Key::Unicode(ch)
            } else {
                return Err(format!(
                    "Unknown key: {}. Use a single character or named key like enter/escape/tab",
                    main_key
                ));
            }
        }
        _ => {
            return Err(format!(
                "Unknown key: {}. Use names (enter/escape/tab/up/down/etc) or a single character",
                main_key
            ))
        }
    };

    enigo
        .key(key_enum, Direction::Click)
        .map_err(|e| format!("key press '{}': {}", main_key, e))?;

    // Release modifiers in reverse order
    for &part in parts.iter().rev().skip(1) {
        match part {
            "ctrl" | "control" => {
                let _ = enigo.key(Key::Control, Direction::Release);
            }
            "shift" => {
                let _ = enigo.key(Key::Shift, Direction::Release);
            }
            "alt" => {
                let _ = enigo.key(Key::Alt, Direction::Release);
            }
            "meta" | "win" | "cmd" | "super" => {
                let _ = enigo.key(Key::Meta, Direction::Release);
            }
            _ => {}
        }
    }

    Ok(format!("Pressed key: {}", key))
}

// ── Independent cursor: click at coordinates without stealing the user's mouse ──

#[cfg(not(target_os = "windows"))]
fn save_cursor() -> (i32, i32) {
    (0, 0)
}
#[cfg(not(target_os = "windows"))]
fn restore_cursor(_x: i32, _y: i32) {}

#[cfg(target_os = "windows")]
fn save_cursor() -> (i32, i32) {
    cursor_guard::get_pos()
}
#[cfg(target_os = "windows")]
fn restore_cursor(x: i32, y: i32) {
    cursor_guard::restore(x, y);
}

fn click_at_impl(x: f64, y: f64, button: Button) -> Result<(), String> {
    let saved = save_cursor();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .move_mouse(x as i32, y as i32, Coordinate::Abs)
        .map_err(|e| format!("move: {}", e))?;
    enigo
        .button(button, Direction::Click)
        .map_err(|e| format!("click: {}", e))?;
    restore_cursor(saved.0, saved.1);
    Ok(())
}

#[tauri::command]
fn mouse_click_at(x: f64, y: f64, button: Option<String>) -> Result<String, String> {
    let b = button.unwrap_or_else(|| "left".to_string());
    let btn = match b.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return Err(format!("Unknown button: {}", b)),
    };
    click_at_impl(x, y, btn)?;
    Ok(format!(
        "Clicked {} at ({}, {}) [virtual cursor]",
        b, x as i32, y as i32
    ))
}

#[tauri::command]
fn mouse_double_click_at(x: f64, y: f64) -> Result<String, String> {
    let saved = save_cursor();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .move_mouse(x as i32, y as i32, Coordinate::Abs)
        .map_err(|e| format!("move: {}", e))?;
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| format!("click1: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(60));
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|e| format!("click2: {}", e))?;
    restore_cursor(saved.0, saved.1);
    Ok(format!(
        "Double-clicked at ({}, {}) [virtual cursor]",
        x as i32, y as i32
    ))
}

#[tauri::command]
fn mouse_right_click_at(x: f64, y: f64) -> Result<String, String> {
    click_at_impl(x, y, Button::Right)?;
    Ok(format!(
        "Right-clicked at ({}, {}) [virtual cursor]",
        x as i32, y as i32
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_in_background = std::env::args()
        .any(|arg| arg == "--background" || arg == "--hidden" || arg == "--minimized");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch is another native recovery path for a
            // click-through wallpaper window.
            let _ = show_main_window_impl(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(test))]
    let builder = builder.plugin(tauri_plugin_dialog::init());

    // Internal/unsigned builds must never contact the public update service.
    // The updater plugin is compiled into the command surface only for an
    // explicitly public build; the release-readiness gate validates its keys.
    let builder = if option_env!("LUMI_RELEASE_CHANNEL") == Some("public") {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };

    builder
        .manage(Mutex::new(BackendProcesses {
            node: None,
            python: None,
            node_restarts: 0,
            python_restarts: 0,
            node_config: None,
        }))
        .manage(Mutex::new(ActiveDesktopCommands::default()))
        .manage(Mutex::new(WallpaperState::default()))
        .manage(Mutex::new(ResidentState {
            close_to_background: started_in_background,
            started_in_background,
            force_quit: false,
        }))
        .manage(Mutex::new(DesktopWidgetState::default()))
        .manage(Mutex::new(CompactWindowState::default()))
        .on_page_load(move |webview, payload| {
            if !started_in_background
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let window = webview.window();
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = webview.set_focus();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            get_desktop_capability_status,
            get_live_stats,
            list_home_files,
            list_directory,
            path_info,
            write_text_file,
            read_text_file,
            list_native_apps,
            create_directory,
            rename_item,
            delete_item,
            run_command,
            cancel_command,
            open_item,
            pick_directory,
            set_wallpaper_mode,
            get_wallpaper_mode,
            enter_desktop_widget_mode,
            exit_desktop_widget_mode,
            toggle_desktop_widget_mode,
            get_desktop_widget_mode,
            toggle_compact_window_mode,
            exit_compact_window_mode,
            get_compact_window_mode,
            minimize_window,
            toggle_maximize_window,
            close_window,
            hide_to_background,
            show_main_window,
            quit_app,
            set_close_to_background,
            get_autostart_enabled,
            set_autostart_enabled,
            get_runtime_resilience_status,
            get_active_window_info,
            control_active_window,
            get_running_processes,
            capture_screen,
            get_clipboard_text,
            set_clipboard_text,
            set_clipboard_files,
            get_idle_time,
            poll_activity,
            get_system_volume,
            set_system_volume,
            get_screen_brightness,
            set_screen_brightness,
            mouse_move,
            mouse_click,
            mouse_drag,
            keyboard_type,
            keyboard_press,
            mouse_click_at,
            mouse_double_click_at,
            mouse_right_click_at,
        ])
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().unwrap_or_default();

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                if started_in_background {
                    let _ = window.hide();
                }
                #[cfg(target_os = "macos")]
                {
                    // macOS: fullscreen:true + decorations:false creates new Space.
                    // Exit native fullscreen, fill monitor manually.
                    let _ = window.set_fullscreen(false);
                    if let Ok(Some(monitor)) = window.primary_monitor() {
                        let s = monitor.size();
                        let p = monitor.position();
                        let _ = window.set_position(tauri::PhysicalPosition::new(p.x, p.y));
                        let _ = window.set_size(tauri::PhysicalSize::new(s.width, s.height));
                    }
                }
            }

            if let Err(e) = setup_tray(app) {
                eprintln!("[LumiOS] Failed to create tray icon: {}", e);
            }

            // Ensure WebView2Loader.dll is alongside the EXE (Windows only)
            #[cfg(target_os = "windows")]
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let dll_dest = exe_dir.join("WebView2Loader.dll");
                    if !dll_dest.exists() {
                        let dll_src = resource_dir
                            .join("desktop-resources")
                            .join("WebView2Loader.dll");
                        if dll_src.exists() {
                            println!("[LumiOS] Copying WebView2Loader.dll to EXE directory");
                            let _ = std::fs::copy(&dll_src, &dll_dest);
                        }
                    }
                }
            }

            // In dev mode, the backend is started by beforeDevCommand; skip spawning Node.js
            if cfg!(debug_assertions) {
                println!("[LumiOS] Dev mode — skipping bundled backend spawn");
            } else {
                // ... rest of spawn code unchanged

                // Spawn Node.js backend
                let dist_server = resolve_resource_dir(&resource_dir, "dist-server");
                #[cfg(target_os = "windows")]
                let node_bin = dist_server.join("node.exe");
                #[cfg(not(target_os = "windows"))]
                let node_bin = dist_server.join("node");
                let server_js = dist_server.join("entry.cjs");
                let server_bundle = dist_server.join("server.mjs");

                if node_bin.exists() && server_js.exists() && server_bundle.exists() {
                    let normalized_node = normalize_unc(&node_bin);
                    let normalized_entry = normalize_unc(&server_js);
                    let normalized_cwd = normalize_unc(&dist_server);
                    println!(
                        "[LumiOS] Starting backend: {} {} (cwd: {})",
                        normalized_node.display(),
                        normalized_entry.display(),
                        normalized_cwd.display(),
                    );
                    let mut node_cmd = Command::new(normalized_node);
                    node_cmd
                        .arg(normalized_entry)
                        .env("LUMI_DESKTOP", "1")
                        .env("HOST", "127.0.0.1")
                        .current_dir(normalized_cwd);
                    // Only set NODE_OPTIONS if hide-console.cjs exists (Windows only)
                    #[cfg(target_os = "windows")]
                    if normalized_cwd.join("hide-console.cjs").exists() {
                        node_cmd.env("NODE_OPTIONS", "--require ./hide-console.cjs");
                    }
                    match spawn_hidden(&mut node_cmd) {
                        Ok(child) => {
                            println!("[LumiOS] Backend PID: {}", child.id());
                            let app_state = app.state::<Mutex<BackendProcesses>>();
                            let mut state = app_state.lock().unwrap();
                            state.node_config = Some(SpawnConfig {
                                exe: normalized_node.to_path_buf(),
                                entry: normalized_entry.to_path_buf(),
                                work_dir: normalized_cwd.to_path_buf(),
                            });
                            state.node = Some(child);
                        }
                        Err(e) => {
                            eprintln!("[LumiOS] Failed to start backend: {}", e);
                        }
                    }
                } else {
                    eprintln!(
                        "[LumiOS] Backend not found. node.exe: {}, entry.cjs: {}, server.mjs: {}",
                        node_bin.exists(),
                        server_js.exists(),
                        server_bundle.exists()
                    );
                }

                // GPT-SoVITS is owned by the Node backend's supervised, on-demand
                // runtime. Starting it here would bypass its queue, memory budget,
                // restart backoff, and idle reclamation policy.
            } // end else (release mode spawns backend)

            // ── Child process health check (release mode, checks every 5s) ──
            if !cfg!(debug_assertions) {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let max_restarts: u32 = 30;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let app_state = app_handle.state::<Mutex<BackendProcesses>>();
                        let mut state = app_state.lock().unwrap();

                        // Check Node.js backend
                        let mut restart_node = false;
                        if let Some(ref mut child) = state.node {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    eprintln!(
                                        "[LumiOS] Node backend exited with status {:?}",
                                        status.code()
                                    );
                                    restart_node = true;
                                }
                                Ok(None) => { /* still running */ }
                                Err(e) => {
                                    eprintln!("[LumiOS] Node backend health check failed: {}", e);
                                    restart_node = true;
                                }
                            }
                        }
                        if restart_node && state.node_restarts < max_restarts {
                            if let Some(ref cfg) = state.node_config {
                                eprintln!(
                                    "[LumiOS] Restarting Node backend (attempt {}/{})",
                                    state.node_restarts + 1,
                                    max_restarts
                                );
                                let mut restart_cmd = Command::new(&cfg.exe);
                                restart_cmd
                                    .arg(&cfg.entry)
                                    .env("LUMI_DESKTOP", "1")
                                    .env("HOST", "127.0.0.1")
                                    .current_dir(&cfg.work_dir);
                                #[cfg(target_os = "windows")]
                                if cfg.work_dir.join("hide-console.cjs").exists() {
                                    restart_cmd.env("NODE_OPTIONS", "--require ./hide-console.cjs");
                                }
                                match spawn_hidden(&mut restart_cmd) {
                                    Ok(child) => {
                                        println!("[LumiOS] Backend restarted, PID: {}", child.id());
                                        state.node = Some(child);
                                        state.node_restarts += 1;
                                    }
                                    Err(e) => {
                                        eprintln!("[LumiOS] Failed to restart Node backend: {}", e);
                                    }
                                }
                            }
                        } else if restart_node {
                            eprintln!(
                                "[LumiOS] Node backend max restarts ({}) reached, giving up",
                                max_restarts
                            );
                            state.node = None;
                        }
                    }
                });
            }

            // Register the native window and command-center shortcuts. The
            // browser key handler remains a fallback when the webview is
            // already focused; this path also works while focus is elsewhere.
            let window = app.get_webview_window("main").unwrap();
            let reg = app.global_shortcut();
            if let Err(error) =
                reg.on_shortcut(WINDOW_TOGGLE_SHORTCUT, move |app, _shortcut, _event| {
                    let wallpaper_enabled = app
                        .state::<Mutex<WallpaperState>>()
                        .lock()
                        .map(|state| state.enabled)
                        .unwrap_or(false);
                    if wallpaper_enabled {
                        let _ = show_main_window_impl(app);
                    } else if window.is_visible().unwrap_or(true) {
                        let _ = window.hide();
                    } else {
                        let _ = show_main_window_impl(app);
                    }
                })
            {
                eprintln!(
                    "[LumiOS] Failed to register {WINDOW_TOGGLE_SHORTCUT} global shortcut: {error}"
                );
            }
            if let Err(error) =
                reg.on_shortcut(COMMAND_CENTER_SHORTCUT, move |app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let _ = show_main_window_impl(app);
                    if let Some(webview_window) = app.get_webview_window("main") {
                        let webview: &tauri::Webview<_> = webview_window.as_ref();
                        let _ = webview.set_focus();
                    }
                    let _ = app.emit(COMMAND_CENTER_EVENT, ());
                })
            {
                eprintln!(
                    "[LumiOS] Failed to register {COMMAND_CENTER_SHORTCUT} global shortcut: {error}"
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lumi OS")
        .run(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                let resident = app.state::<Mutex<ResidentState>>();
                let should_hide = resident
                    .lock()
                    .map(|state| state.close_to_background && !state.force_quit)
                    .unwrap_or(false);
                if label == "main" && should_hide {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                // Clicking the Dock icon must always recover a click-through
                // wallpaper window and restore its previous bounds.
                let _ = show_main_window_impl(app);
            }
            tauri::RunEvent::Exit => {
                if let Err(error) = app.global_shortcut().unregister_all() {
                    eprintln!("[LumiOS] Failed to unregister global shortcuts: {error}");
                }
                let state = app.state::<Mutex<BackendProcesses>>();
                let mut procs = state.lock().unwrap();
                if let Some(child) = procs.node.as_mut() {
                    println!("[LumiOS] Stopping Node backend...");
                    let _ = child.kill();
                }
                if let Some(child) = procs.python.as_mut() {
                    println!("[LumiOS] Stopping GPT-SoVITS API...");
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
