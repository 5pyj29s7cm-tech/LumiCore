use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

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
    python_config: Option<SpawnConfig>,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopWidgetMode {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeAppEntry {
    pub app_id: String,
    pub label: String,
    pub path: String,
    pub source: String,
    pub aliases: Vec<String>,
    pub score: i32,
}

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

fn detect_gpu_usage() -> Option<f32> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])
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

#[tauri::command]
fn list_directory(path: String, limit: Option<usize>) -> Vec<NativeFile> {
    let dir = if path.trim().is_empty() {
        dirs_next::home_dir().unwrap_or_default()
    } else {
        PathBuf::from(path)
    };
    read_native_files(&dir, limit)
}

#[tauri::command]
fn path_info(target: String) -> NativePathInfo {
    let path = if target.trim().is_empty() {
        dirs_next::home_dir().unwrap_or_default()
    } else {
        PathBuf::from(target)
    };
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
        return match cmd.output() {
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
        };
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

#[tauri::command]
fn run_command(command: String, cwd: Option<String>) -> CommandResult {
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

    let output = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.args(["/D", "/S", "/C"]);
            cmd.raw_arg(&command);
            cmd.creation_flags(0x08000000u32);
        }
        if let Some(path) = cwd_path.as_ref() {
            cmd.current_dir(path);
        }
        cmd.output()
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &command]);
        if let Some(path) = cwd_path.as_ref() {
            cmd.current_dir(path);
        }
        cmd.output()
    };

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let success = out.status.success();
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
            CommandResult {
                success,
                output: if stderr.is_empty() {
                    stdout
                } else if stdout.is_empty() {
                    stderr
                } else {
                    format!("{}\n{}", stdout, stderr)
                },
            }
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

fn spawn_python(python_exe: &std::path::Path, api_py: &std::path::Path, work_dir: &std::path::Path) -> Option<Child> {
    let normalized_python = normalize_unc(python_exe);
    let normalized_api = normalize_unc(api_py);
    let normalized_cwd = normalize_unc(work_dir);
    println!(
        "[LumiOS] Starting GPT-SoVITS API: {} {} (cwd: {})",
        normalized_python.display(),
        normalized_api.display(),
        normalized_cwd.display(),
    );
    let mut cmd = Command::new(normalized_python);
    cmd.arg(normalized_api)
        .arg("-a")
        .arg("127.0.0.1")
        .arg("-p")
        .arg("9880")
        .arg("-c")
        .arg("GPT_SoVITS/configs/tts_infer.yaml")
        .current_dir(normalized_cwd);
    match spawn_hidden(&mut cmd) {
        Ok(child) => {
            println!("[LumiOS] GPT-SoVITS API PID: {}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[LumiOS] Failed to start GPT-SoVITS API: {}", e);
            None
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
    let nsis = resource_dir.join("_up_").join("desktop-resources").join(name);
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
            executable_names: vec!["Weixin.exe", "WeChat.exe", "\u{5fae}\u{4fe1}\u{591a}\u{5f00}.bat", "\u{5fae}\u{4fe1}.lnk"],
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
            executable_names: vec!["WXWork.exe", "WeCom.exe", "\u{4f01}\u{4e1a}\u{5fae}\u{4fe1}.lnk"],
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
            executable_names: vec!["wps.exe", "et.exe", "wpp.exe", "ksolaunch.exe", "WPS Office.lnk"],
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
            executable_names: vec!["msedge.exe", "chrome.exe", "Microsoft Edge.lnk", "Google Chrome.lnk"],
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
            aliases: vec!["jianying", "capcut", "\u{526a}\u{6620}", "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}"],
            executable_names: vec!["JianyingPro.exe", "CapCut.exe", "\u{526a}\u{6620}\u{4e13}\u{4e1a}\u{7248}.lnk", "\u{526a}\u{6620}.lnk"],
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
            aliases: vec!["autocad", "cad", "\u{5929}\u{6b63}", "\u{4e2d}\u{671b}cad", "\u{6d69}\u{8fb0}cad"],
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
            aliases: vec!["powershell", "pwsh", "\u{7ec8}\u{7aef}", "\u{547d}\u{4ee4}\u{884c}"],
            executable_names: vec!["powershell.exe", "pwsh.exe", "Windows Terminal.lnk"],
            fixed_paths: vec![
                r"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe",
                r"%ProgramFiles%\PowerShell\7\pwsh.exe",
                r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe",
            ],
        },
    ]
}

#[cfg(target_os = "windows")]
fn compact_app_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

#[cfg(target_os = "windows")]
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
        .map(|ext| matches!(ext.to_lowercase().as_str(), "exe" | "bat" | "cmd" | "lnk" | "url"))
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

    if trimmed.contains('\\') || trimmed.contains('/') || trimmed.contains(':') || trimmed.starts_with('.') {
        return false;
    }

    match target_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(ext.to_lowercase().as_str(), "exe" | "bat" | "cmd" | "lnk" | "url"),
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
        roots.push((PathBuf::from(public_dir).join("Desktop"), "public_desktop", 110));
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
    Some(PathBuf::from(base).join("LumiOS").join("app-launch-history.json"))
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
fn shortcut_candidates_for_definitions(defs: &[WindowsAppDefinition]) -> Vec<WindowsLaunchCandidate> {
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
                if let Some(def) = defs.iter().find(|def| filename_matches_app_definition(file_name, def)) {
                    candidates.push(candidate_from_path(def, path, source, score));
                }
            }
        }
    }
    candidates
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
fn dedupe_windows_candidates(mut candidates: Vec<WindowsLaunchCandidate>) -> Vec<WindowsLaunchCandidate> {
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
        for def in definitions.iter().filter(|def| app_query_matches_definition(q, def)) {
            candidates.extend(candidates_for_definition(def));
        }
    } else {
        for def in &definitions {
            candidates.extend(history_candidates_for_definition(def));
            candidates.extend(fixed_candidates_for_definition(def));
        }
        candidates.extend(shortcut_candidates_for_definitions(&definitions));
    }
    dedupe_windows_candidates(candidates)
        .into_iter()
        .take(limit.max(1).min(200))
        .map(native_app_entry_from_candidate)
        .collect()
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
            SetForegroundWindow(state.hwnd);
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

#[tauri::command]
async fn list_native_apps(query: Option<String>, limit: Option<usize>) -> Vec<NativeAppEntry> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            list_windows_native_apps(query.as_deref(), limit.unwrap_or(80))
        })
        .await
        .unwrap_or_default();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = query;
        let _ = limit;
        Vec::new()
    }
}

#[tauri::command]
fn open_item(target: String, window: tauri::WebviewWindow) -> CommandResult {
    // Open file, folder, app, or URL with the OS default handler
    let _ = window.set_always_on_top(false);

    #[cfg(target_os = "windows")]
    if let Some(result) = try_launch_windows_app_alias(&target) {
        return result;
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

            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
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
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
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
fn set_wallpaper_mode(
    enabled: bool,
    state: tauri::State<'_, Mutex<WallpaperState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
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
        let _ = window.set_min_size(Some(tauri::PhysicalSize::new(
            DEFAULT_MAIN_MIN_WIDTH,
            DEFAULT_MAIN_MIN_HEIGHT,
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
        if enabled { "ON (click-through fullscreen)" } else { "OFF" }
    );
    Ok(())
}

const DESKTOP_WIDGET_WIDTH: u32 = 240;
const DESKTOP_WIDGET_HEIGHT: u32 = 285;
const DESKTOP_WIDGET_MIN_WIDTH: u32 = 210;
const DESKTOP_WIDGET_MIN_HEIGHT: u32 = 250;
const DESKTOP_WIDGET_MARGIN: i32 = 18;
const DEFAULT_MAIN_MIN_WIDTH: u32 = 960;
const DEFAULT_MAIN_MIN_HEIGHT: u32 = 640;

fn place_window_in_desktop_corner(window: &tauri::WebviewWindow) -> Result<(), String> {
    let maybe_monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = maybe_monitor {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let max_x = monitor_pos.x + monitor_size.width as i32 - DESKTOP_WIDGET_WIDTH as i32 - DESKTOP_WIDGET_MARGIN;
        let max_y = monitor_pos.y + monitor_size.height as i32 - DESKTOP_WIDGET_HEIGHT as i32 - DESKTOP_WIDGET_MARGIN;
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
        eprintln!("[LumiOS] desktop widget set_decorations(false) failed: {}", e);
    }
    if let Err(e) = window.set_shadow(false) {
        eprintln!("[LumiOS] desktop widget set_shadow(false) failed: {}", e);
    }
    let _ = window.set_skip_taskbar(true);
    if let Err(e) = window.set_always_on_top(true) {
        eprintln!("[LumiOS] desktop widget set_always_on_top(true) failed: {}", e);
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
        .set_min_size(Some(tauri::PhysicalSize::new(
            DEFAULT_MAIN_MIN_WIDTH,
            DEFAULT_MAIN_MIN_HEIGHT,
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
                let ws = window.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
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
            let _ = window.set_position(tauri::PhysicalPosition::new(m.position().x, m.position().y));
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
    let should_hide = state
        .lock()
        .map_err(|e| e.to_string())?
        .close_to_background;
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
        notes.push("Launch at login is currently implemented for Windows current-user installs.".to_string());
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
        if output.status.success() || stderr.contains("unable to find") || stderr.contains("not found") {
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
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn hide_main_window_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Lumi", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide to Background", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Lumi OS is ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ActiveWindowInfo {
    pub title: String,
    pub process_name: String,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub window_title: String,
    pub cpu_percent: f32,
    pub memory_mb: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureResult {
    pub image_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
fn get_active_window_info() -> ActiveWindowInfo {
    let mut title = String::new();
    let mut process_name = String::new();
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
        struct RECT {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        extern "system" {
            fn GetForegroundWindow() -> isize;
            fn GetWindowTextW(hwnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
            fn GetWindowThreadProcessId(hwnd: isize, lpdwProcessId: *mut u32) -> u32;
            fn GetWindowRect(hwnd: isize, lpRect: *mut RECT) -> i32;
        }
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd != 0 {
                let mut buf: [u16; 512] = [0; 512];
                let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 512);
                title = String::from_utf16_lossy(&buf[..len as usize]);
                GetWindowThreadProcessId(hwnd, &mut pid);
                let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
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
            process_name = sys
                .process(sysinfo::Pid::from(pid as usize))
                .map(|p| p.name().to_string_lossy().to_string())
                .unwrap_or_default();
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
            .args(["-e", r#"tell application "System Events" to get name of first application process whose frontmost is true"#])
            .output();
        if let Ok(out) = output {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                title = name.clone();
                process_name = name;
            }
        }
    }
    ActiveWindowInfo { title, process_name, pid, x, y, width, height }
}

#[tauri::command]
fn get_running_processes() -> Vec<ProcessInfo> {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(50));
    sys.refresh_all();

    let mut processes: Vec<ProcessInfo> = Vec::new();
    for (pid, proc) in sys.processes() {
        let cpu = proc.cpu_usage();
        let mem = proc.memory() as f32 / 1024.0 / 1024.0; // bytes -> MB
        let name = proc.name().to_string_lossy().to_string();
        // Only include processes using >0.1% CPU or >10MB memory (reduce noise)
        if cpu > 0.1 || mem > 10.0 {
            processes.push(ProcessInfo {
                pid: pid.as_u32(),
                name,
                window_title: String::new(),
                cpu_percent: cpu,
                memory_mb: mem,
            });
        }
    }
    processes.sort_by(|a, b| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap_or(std::cmp::Ordering::Equal));
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
            return Err(format!("Clipboard file does not exist or is not a file: {}", file.display()));
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
            let mut lii = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, tick_count: 0 };
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
                return IdleInfo { idle_ms: ms, idle_seconds: ms / 1000 };
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    IdleInfo { idle_ms: 0, idle_seconds: 0 };
    IdleInfo { idle_ms: 0, idle_seconds: 0 }
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
    let clamped = level.max(0.0).min(100.0);
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
            .args(["set-sink-volume", "@DEFAULT_SINK@", &format!("{}%", clamped as u32)])
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
        return result;
    }
    #[cfg(target_os = "linux")]
    {
        // Try brightnessctl first, then fall back to sysfs
        if let Ok(out) = Command::new("brightnessctl").arg("get").output() {
            if let Ok(cur) = String::from_utf8_lossy(&out.stdout).trim().parse::<f32>() {
                if let Ok(max_out) = Command::new("brightnessctl").arg("max").output() {
                    if let Ok(max) = String::from_utf8_lossy(&max_out.stdout).trim().parse::<f32>() {
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
                    if let (Ok(max), Ok(cur)) = (max_str.trim().parse::<f32>(), cur_str.trim().parse::<f32>()) {
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
    let clamped = level.max(0.0).min(100.0);
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
        let bctl = Command::new("brightnessctl")
            .args(["set", &pct])
            .output();
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
$s = [System.Windows.Forms.Screen]::PrimaryScreen
$w = $s.Bounds.Width; $h = $s.Bounds.Height
$b = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, $b.Size)
$g.Dispose()
$b.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output "OK|$w|$h""#,
            temp_file
        );
        let output = cmd
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let parts: Vec<&str> = text.split('|').collect();
            if parts.len() >= 3 && parts[0] == "OK" {
                if let Ok(png) = std::fs::read(&temp_path) {
                    let _ = std::fs::remove_file(&temp_path);
                    if !png.is_empty() {
                        let b64 = base64_encode(&png);
                        return CaptureResult {
                            image_base64: b64,
                            width: parts[1].parse().unwrap_or(0),
                            height: parts[2].parse().unwrap_or(0),
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
                        width: 0,
                        height: 0,
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
                                width: parts[0].parse().unwrap_or(0),
                                height: parts[1].parse().unwrap_or(0),
                            };
                        }
                    }
                }
            }
        }
    }
    CaptureResult { image_base64: String::new(), width: 0, height: 0 }
}

/// Simple base64 encoder — avoids pulling in a crate for one function.
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[char] = &[
        'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
        'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
        '0','1','2','3','4','5','6','7','8','9','+','/',
    ];
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 0x3F) as usize]);
        out.push(CHARS[((n >> 12) & 0x3F) as usize]);
        out.push(if chunk.len() > 1 { CHARS[((n >> 6) & 0x3F) as usize] } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(n & 0x3F) as usize] } else { '=' });
    }
    out
}

// ── Mouse & Keyboard Input Commands (enigo crate) ──

use enigo::{Enigo, Mouse, Settings, Coordinate, Direction, Button, Keyboard, Key};

// Windows cursor save/restore for independent (virtual) cursor clicks.
// Saves real cursor pos, moves to target, clicks, restores — all within ~2 frames.
#[cfg(target_os = "windows")]
mod cursor_guard {
    #[repr(C)]
    struct POINT { x: i32, y: i32 }
    extern "system" {
        fn GetCursorPos(lpPoint: *mut POINT) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
    }
    pub fn get_pos() -> (i32, i32) {
        let mut pt = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut pt); }
        (pt.x, pt.y)
    }
    pub fn restore(x: i32, y: i32) {
        unsafe { SetCursorPos(x, y); }
    }
}

#[tauri::command]
fn mouse_move(x: f64, y: f64) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo.move_mouse(x as i32, y as i32, Coordinate::Abs).map_err(|e| format!("mouse_move: {}", e))?;
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
    enigo.button(btn, Direction::Click).map_err(|e| format!("mouse_click: {}", e))?;
    Ok(format!("Mouse {} click", button))
}

#[tauri::command]
fn mouse_drag(from_x: f64, from_y: f64, to_x: f64, to_y: f64, button: String) -> Result<String, String> {
    let btn = match button.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return Err(format!("Unknown button: {}. Use left/right/middle", button)),
    };
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo.move_mouse(from_x as i32, from_y as i32, Coordinate::Abs).map_err(|e| format!("drag move to start: {}", e))?;
    enigo.button(btn, Direction::Press).map_err(|e| format!("drag press: {}", e))?;
    enigo.move_mouse(to_x as i32, to_y as i32, Coordinate::Abs).map_err(|e| format!("drag move to end: {}", e))?;
    enigo.button(btn, Direction::Release).map_err(|e| format!("drag release: {}", e))?;
    Ok(format!("Dragged from ({}, {}) to ({}, {})", from_x as i32, from_y as i32, to_x as i32, to_y as i32))
}

#[tauri::command]
fn keyboard_type(text: String) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo.text(&text).map_err(|e| format!("keyboard_type: {}", e))?;
    Ok(format!("Typed {} characters", text.len()))
}

#[tauri::command]
fn keyboard_press(key: String) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;

    let parts: Vec<&str> = key.split('+').map(|s| s.trim()).collect();
    // Parse modifiers first, then the main key
    for &part in &parts[..parts.len().saturating_sub(1)] {
        match part {
            "ctrl" | "control" => enigo.key(Key::Control, Direction::Press).map_err(|e| format!("ctrl press: {}", e))?,
            "shift" => enigo.key(Key::Shift, Direction::Press).map_err(|e| format!("shift press: {}", e))?,
            "alt" => enigo.key(Key::Alt, Direction::Press).map_err(|e| format!("alt press: {}", e))?,
            "meta" | "win" | "cmd" | "super" => enigo.key(Key::Meta, Direction::Press).map_err(|e| format!("meta press: {}", e))?,
            _ => return Err(format!("Unknown modifier: {}. Use ctrl/shift/alt/meta", part)),
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
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4,
        "f5" => Key::F5, "f6" => Key::F6, "f7" => Key::F7, "f8" => Key::F8,
        "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        _ if main_key.len() == 1 => {
            let ch = main_key.chars().next().unwrap();
            if ch.is_ascii_alphanumeric() || ",./;'[]\\-=".contains(ch) {
                Key::Unicode(ch)
            } else {
                return Err(format!("Unknown key: {}. Use a single character or named key like enter/escape/tab", main_key));
            }
        }
        _ => return Err(format!("Unknown key: {}. Use names (enter/escape/tab/up/down/etc) or a single character", main_key)),
    };

    enigo.key(key_enum, Direction::Click).map_err(|e| format!("key press '{}': {}", main_key, e))?;

    // Release modifiers in reverse order
    for &part in parts.iter().rev().skip(1) {
        match part {
            "ctrl" | "control" => { let _ = enigo.key(Key::Control, Direction::Release); }
            "shift" => { let _ = enigo.key(Key::Shift, Direction::Release); }
            "alt" => { let _ = enigo.key(Key::Alt, Direction::Release); }
            "meta" | "win" | "cmd" | "super" => { let _ = enigo.key(Key::Meta, Direction::Release); }
            _ => {}
        }
    }

    Ok(format!("Pressed key: {}", key))
}

// ── Independent cursor: click at coordinates without stealing the user's mouse ──

#[cfg(not(target_os = "windows"))]
fn save_cursor() -> (i32, i32) { (0, 0) }
#[cfg(not(target_os = "windows"))]
fn restore_cursor(_x: i32, _y: i32) {}

#[cfg(target_os = "windows")]
fn save_cursor() -> (i32, i32) { cursor_guard::get_pos() }
#[cfg(target_os = "windows")]
fn restore_cursor(x: i32, y: i32) { cursor_guard::restore(x, y); }

fn click_at_impl(x: f64, y: f64, button: Button) -> Result<(), String> {
    let saved = save_cursor();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo.move_mouse(x as i32, y as i32, Coordinate::Abs).map_err(|e| format!("move: {}", e))?;
    enigo.button(button, Direction::Click).map_err(|e| format!("click: {}", e))?;
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
    Ok(format!("Clicked {} at ({}, {}) [virtual cursor]", b, x as i32, y as i32))
}

#[tauri::command]
fn mouse_double_click_at(x: f64, y: f64) -> Result<String, String> {
    let saved = save_cursor();
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo.move_mouse(x as i32, y as i32, Coordinate::Abs).map_err(|e| format!("move: {}", e))?;
    enigo.button(Button::Left, Direction::Click).map_err(|e| format!("click1: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(60));
    enigo.button(Button::Left, Direction::Click).map_err(|e| format!("click2: {}", e))?;
    restore_cursor(saved.0, saved.1);
    Ok(format!("Double-clicked at ({}, {}) [virtual cursor]", x as i32, y as i32))
}

#[tauri::command]
fn mouse_right_click_at(x: f64, y: f64) -> Result<String, String> {
    click_at_impl(x, y, Button::Right)?;
    Ok(format!("Right-clicked at ({}, {}) [virtual cursor]", x as i32, y as i32))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_in_background = std::env::args()
        .any(|arg| arg == "--background" || arg == "--hidden" || arg == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(BackendProcesses { node: None, python: None, node_restarts: 0, python_restarts: 0, node_config: None, python_config: None }))
        .manage(Mutex::new(WallpaperState::default()))
        .manage(Mutex::new(ResidentState { close_to_background: started_in_background, started_in_background, force_quit: false }))
        .manage(Mutex::new(DesktopWidgetState::default()))
        .on_page_load(move |webview, payload| {
            if !started_in_background
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let _ = webview.window().show();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            get_live_stats,
            list_home_files,
            list_directory,
            path_info,
            list_native_apps,
            create_directory,
            rename_item,
            delete_item,
            run_command,
            open_item,
            pick_directory,
            set_wallpaper_mode,
            enter_desktop_widget_mode,
            exit_desktop_widget_mode,
            toggle_desktop_widget_mode,
            get_desktop_widget_mode,
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
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_default();

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
                let mut node_cmd = Command::new(&normalized_node);
                node_cmd.arg(&normalized_entry)
                    .env("LUMI_DESKTOP", "1")
                    .env("HOST", "127.0.0.1")
                    .current_dir(&normalized_cwd);
                // Only set NODE_OPTIONS if hide-console.cjs exists (Windows only)
                #[cfg(target_os = "windows")]
                if normalized_cwd.join("hide-console.cjs").exists() {
                    node_cmd.env("NODE_OPTIONS", "--require ./hide-console.cjs");
                }
                match spawn_hidden(&mut node_cmd)
                {
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

            // Spawn GPT-SoVITS Python API server
            let gpt_sovits_dir = resolve_resource_dir(&resource_dir, "gpt-sovits-src");
            let python_exe = gpt_sovits_dir.join("venv/Scripts/python.exe");
            let api_py = gpt_sovits_dir.join("api_v2.py");
            let dev_python = std::path::PathBuf::from("../gpt-sovits-src/venv/Scripts/python.exe");
            let dev_api = std::path::PathBuf::from("../gpt-sovits-src/api_v2.py");

            let python_child = if python_exe.exists() && api_py.exists() {
                spawn_python(&python_exe, &api_py, normalize_unc(&gpt_sovits_dir))
            } else if dev_python.exists() && dev_api.exists() {
                spawn_python(&dev_python, &dev_api, Path::new("../gpt-sovits-src"))
            } else {
                eprintln!(
                    "[LumiOS] GPT-SoVITS API not found at {} or {}",
                    python_exe.display(),
                    dev_python.display()
                );
                None
            };
            if let Some(child) = python_child {
                let app_state = app.state::<Mutex<BackendProcesses>>();
                let mut state = app_state.lock().unwrap();
                if python_exe.exists() && api_py.exists() {
                    state.python_config = Some(SpawnConfig {
                        exe: python_exe,
                        entry: api_py,
                        work_dir: gpt_sovits_dir,
                    });
                } else {
                    state.python_config = Some(SpawnConfig {
                        exe: dev_python,
                        entry: dev_api,
                        work_dir: PathBuf::from("../gpt-sovits-src"),
                    });
                }
                state.python = Some(child);
            }
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
                                    eprintln!("[LumiOS] Node backend exited with status {:?}", status.code());
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
                                eprintln!("[LumiOS] Restarting Node backend (attempt {}/{})", state.node_restarts + 1, max_restarts);
                                let mut restart_cmd = Command::new(&cfg.exe);
                                restart_cmd.arg(&cfg.entry)
                                    .env("LUMI_DESKTOP", "1")
                                    .env("HOST", "127.0.0.1")
                                    .current_dir(&cfg.work_dir);
                                #[cfg(target_os = "windows")]
                                if cfg.work_dir.join("hide-console.cjs").exists() {
                                    restart_cmd.env("NODE_OPTIONS", "--require ./hide-console.cjs");
                                }
                                match spawn_hidden(&mut restart_cmd)
                                {
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
                            eprintln!("[LumiOS] Node backend max restarts ({}) reached, giving up", max_restarts);
                            state.node = None;
                        }

                        // Check GPT-SoVITS Python API
                        let mut restart_python = false;
                        if let Some(ref mut child) = state.python {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    eprintln!("[LumiOS] Python API exited with status {:?}", status.code());
                                    restart_python = true;
                                }
                                Ok(None) => { /* still running */ }
                                Err(e) => {
                                    eprintln!("[LumiOS] Python API health check failed: {}", e);
                                    restart_python = true;
                                }
                            }
                        }
                        if restart_python && state.python_restarts < max_restarts {
                            if let Some(ref cfg) = state.python_config {
                                eprintln!("[LumiOS] Restarting Python API (attempt {}/{})", state.python_restarts + 1, max_restarts);
                                let mut restart_py_cmd = Command::new(&cfg.exe);
                                restart_py_cmd.arg(&cfg.entry)
                                    .arg("-a").arg("127.0.0.1")
                                    .arg("-p").arg("9880")
                                    .arg("-c").arg("GPT_SoVITS/configs/tts_infer.yaml")
                                    .current_dir(&cfg.work_dir);
                                match spawn_hidden(&mut restart_py_cmd)
                                {
                                    Ok(child) => {
                                        println!("[LumiOS] Python API restarted, PID: {}", child.id());
                                        state.python = Some(child);
                                        state.python_restarts += 1;
                                    }
                                    Err(e) => {
                                        eprintln!("[LumiOS] Failed to restart Python API: {}", e);
                                    }
                                }
                            }
                        } else if restart_python {
                            eprintln!("[LumiOS] Python API max restarts ({}) reached, giving up", max_restarts);
                            state.python = None;
                        }
                    }
                });
            }

            // Register Alt+Space global shortcut (hide/show window)
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let window = app.get_webview_window("main").unwrap();
            let reg = app.global_shortcut();
            let _ = reg.on_shortcut("Alt+Space", move |_app, _shortcut, _event| {
                if window.is_visible().unwrap_or(true) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lumi OS")
        .run(|app, event| {
            match event {
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
                tauri::RunEvent::Exit => {
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
            }
        });
}
