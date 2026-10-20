mod native_activity;
mod native_apps;
mod native_display;
mod native_files;
mod native_input;
mod native_processes;
mod native_shell;
mod native_window_modes;
use crate::native_activity::get_clipboard_text;
use crate::native_activity::get_idle_time;
use crate::native_activity::poll_activity;
use crate::native_activity::set_clipboard_files;
use crate::native_activity::set_clipboard_text;
use crate::native_apps::list_native_apps;
use crate::native_apps::open_item;
use crate::native_apps::pick_directory;
use crate::native_display::capture_screen;
use crate::native_display::get_screen_brightness;
use crate::native_display::get_system_volume;
use crate::native_display::set_screen_brightness;
use crate::native_display::set_system_volume;
use crate::native_files::create_directory;
use crate::native_files::delete_item;
use crate::native_files::list_directory;
use crate::native_files::list_home_files;
use crate::native_files::path_info;
use crate::native_files::read_text_file;
use crate::native_files::rename_item;
use crate::native_files::write_text_file;
use crate::native_input::keyboard_press;
use crate::native_input::keyboard_type;
use crate::native_input::mouse_click;
use crate::native_input::mouse_click_at;
use crate::native_input::mouse_double_click_at;
use crate::native_input::mouse_drag;
use crate::native_input::mouse_move;
use crate::native_input::mouse_right_click_at;
use crate::native_processes::control_active_window;
use crate::native_processes::get_active_window_info;
use crate::native_processes::get_running_processes;
use crate::native_window_modes::apply_wallpaper_mode;
use crate::native_window_modes::close_window;
use crate::native_window_modes::enter_desktop_widget_mode;
use crate::native_window_modes::exit_compact_window_mode;
use crate::native_window_modes::exit_desktop_widget_mode;
use crate::native_window_modes::get_compact_window_mode;
use crate::native_window_modes::get_desktop_widget_mode;
use crate::native_window_modes::get_wallpaper_mode;
use crate::native_window_modes::hide_to_background;
use crate::native_window_modes::minimize_window;
use crate::native_window_modes::set_wallpaper_mode;
use crate::native_window_modes::toggle_compact_window_mode;
use crate::native_window_modes::toggle_desktop_widget_mode;
use crate::native_window_modes::toggle_maximize_window;

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
#[cfg(not(test))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

mod backend_shutdown;
mod desktop_command_ipc;
mod desktop_command_supervisor;
mod local_bootstrap;
use desktop_command_supervisor::CommandSupervisor;
mod native_identity;
mod window_activation;
use backend_shutdown::{request_backend_save, ShutdownBarrier};
use local_bootstrap::bootstrap_local_identity;
use native_identity::get_native_client_identity;
use window_activation::{execute_window_activation_steps, WindowActivationOps};

const WINDOW_TOGGLE_SHORTCUT: &str = "Alt+Space";
const COMMAND_CENTER_SHORTCUT: &str = "Ctrl+Shift+Enter";
const COMMAND_CENTER_EVENT: &str = "lumi:open-command-center";
const WINDOW_ACTIVATION_DIAGNOSTIC_EVENT: &str = "lumi:window-activation-diagnostic";
const MAX_WINDOW_ACTIVATION_DIAGNOSTICS: usize = 50;
static WINDOW_ACTIVATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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
    attached_pid: Option<u32>,
    startup_error: Option<String>,
}

/// Track whether a wallpaper presentation is active and where to restore the
/// main window afterward.
#[derive(Default, Clone)]
struct WallpaperState {
    enabled: bool,
    presentation: WallpaperPresentation,
    workspace: WallpaperWorkspace,
    previous_size: Option<tauri::PhysicalSize<u32>>,
    previous_position: Option<tauri::PhysicalPosition<i32>>,
    was_fullscreen: bool,
    was_maximized: bool,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WallpaperPresentation {
    #[default]
    Workbench,
    DesktopControl,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WallpaperWorkspace {
    #[default]
    Personal,
    CommandCenter,
    Organization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WallpaperMode {
    pub enabled: bool,
    pub presentation: WallpaperPresentation,
    pub workspace: WallpaperWorkspace,
}

struct ResidentState {
    close_to_background: bool,
    started_in_background: bool,
    force_quit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowActivationStepDiagnostic {
    pub stage: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowActivationDiagnostic {
    pub attempt_id: u64,
    pub attempted_at_ms: u64,
    pub source: String,
    pub window_label: String,
    pub ok: bool,
    pub failure_stage: Option<String>,
    pub error: Option<String>,
    pub steps: Vec<WindowActivationStepDiagnostic>,
}

#[derive(Default)]
struct WindowActivationDiagnosticsState {
    recent: Vec<WindowActivationDiagnostic>,
}

#[derive(Default)]
struct DesktopWidgetState {
    enabled: bool,
    transitioning: bool,
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
pub struct StorageDiskInfo {
    pub mount_point: String,
    pub total_space: u64,
    pub available_space: u64,
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
    pub disks: Vec<StorageDiskInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[tauri::command]
fn get_system_info() -> SystemInfo {
    use sysinfo::{Disks, System};
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
        disks: Disks::new_with_refreshed_list()
            .list()
            .iter()
            .map(|disk| StorageDiskInfo {
                mount_point: disk.mount_point().to_string_lossy().to_string(),
                total_space: disk.total_space(),
                available_space: disk.available_space(),
            })
            .collect(),
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

// ── Screen Monitoring Commands ──

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<WindowActivationDiagnostic, String> {
    let diagnostic = show_main_window_impl(&app, "ipc_command");
    if diagnostic.ok {
        Ok(diagnostic)
    } else {
        Err(serde_json::to_string(&diagnostic).unwrap_or_else(|error| {
            format!(
                r#"{{"ok":false,"failure_stage":"serialize_diagnostic","error":"{}"}}"#,
                error
            )
        }))
    }
}

fn save_before_app_exit(app: &tauri::AppHandle) -> Result<(), String> {
    let supervisor = app.state::<CommandSupervisor>();
    let _exit_attempt = supervisor.lock_exit_attempt()?;
    supervisor.cancel_all_and_wait(Duration::from_secs(30))?;
    let saved = app.state::<ShutdownBarrier>().run(|| {
        let owned_pid = {
            let state = app.state::<Mutex<BackendProcesses>>();
            let mut processes = state.lock().map_err(|error| error.to_string())?;
            match processes.node.as_mut() {
                // Development/attached backends remain running independently.
                None => None,
                Some(child) => match child.try_wait().map_err(|error| error.to_string())? {
                    None => Some(child.id()),
                    Some(_) => return Err("The owned backend exited before it confirmed saving. Closing was cancelled.".into()),
                },
            }
        };
        if let Some(pid) = owned_pid { request_backend_save(pid)?; }
        Ok(())
    });
    if let Err(error) = saved {
        app.state::<CommandSupervisor>().resume_after_failed_exit();
        return Err(error);
    }
    if let Ok(mut resident) = app.state::<Mutex<ResidentState>>().lock() {
        resident.force_quit = true;
    }
    app.exit(0);
    Ok(())
}

fn request_app_exit(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = save_before_app_exit(&handle) {
            eprintln!("[LumiCore] Shutdown cancelled: {error}");
            show_main_window_impl(&handle, "shutdown_failed");
            let _ = handle.emit("lumi:shutdown-failed", &error);
            #[cfg(not(test))]
            handle.dialog().message(format!("暂时无法退出：后台尚未确认保存。\n\n{error}\n\n数据仍保留在后台。请解决保存问题后重新退出。"))
                .title("LumiCore — 保存未完成")
                .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_before_app_exit(&app))
        .await
        .map_err(|error| error.to_string())?
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
const AUTOSTART_VALUE_NAME: &str = "LumiCore";
#[cfg(target_os = "windows")]
const LEGACY_AUTOSTART_VALUE_NAME: &str = "LumiOS";

#[cfg(target_os = "windows")]
fn hidden_output(cmd: &mut Command) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000u32);
    cmd.output()
}

#[cfg(target_os = "windows")]
fn get_autostart_entry() -> Result<AutostartEntry, String> {
    let mut text = String::new();
    for value_name in [AUTOSTART_VALUE_NAME, LEGACY_AUTOSTART_VALUE_NAME] {
        let mut cmd = Command::new("reg");
        cmd.args(["query", WINDOWS_RUN_KEY, "/v", value_name]);
        let output = hidden_output(&mut cmd).map_err(|e| e.to_string())?;
        if output.status.success() {
            text = String::from_utf8_lossy(&output.stdout).to_string();
            break;
        }
    }
    if text.is_empty() {
        return Ok(AutostartEntry {
            supported: true,
            enabled: false,
            value: String::new(),
        });
    }

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
            let mut legacy = Command::new("reg");
            legacy.args([
                "delete",
                WINDOWS_RUN_KEY,
                "/v",
                LEGACY_AUTOSTART_VALUE_NAME,
                "/f",
            ]);
            let _ = hidden_output(&mut legacy);
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    } else {
        for value_name in [AUTOSTART_VALUE_NAME, LEGACY_AUTOSTART_VALUE_NAME] {
            let mut cmd = Command::new("reg");
            cmd.args(["delete", WINDOWS_RUN_KEY, "/v", value_name, "/f"]);
            let output = hidden_output(&mut cmd).map_err(|e| e.to_string())?;
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            if !output.status.success()
                && !stderr.contains("unable to find")
                && !stderr.contains("not found")
            {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn set_autostart_entry(_enabled: bool) -> Result<(), String> {
    Err("Launch at login is currently implemented for Windows builds.".to_string())
}

struct TauriWindowActivationOps<'a> {
    window: &'a tauri::WebviewWindow,
}

impl WindowActivationOps for TauriWindowActivationOps<'_> {
    fn show(&self) -> Result<(), String> {
        self.window.show().map_err(|error| error.to_string())
    }

    fn unminimize(&self) -> Result<(), String> {
        self.window.unminimize().map_err(|error| error.to_string())
    }

    fn focus_window(&self) -> Result<(), String> {
        self.window.set_focus().map_err(|error| error.to_string())
    }

    fn focus_webview(&self) -> Result<(), String> {
        let webview: &tauri::Webview<_> = self.window.as_ref();
        webview.set_focus().map_err(|error| error.to_string())
    }

    fn is_visible(&self) -> Result<bool, String> {
        self.window.is_visible().map_err(|error| error.to_string())
    }

    fn is_focused(&self) -> Result<bool, String> {
        self.window.is_focused().map_err(|error| error.to_string())
    }
}

fn window_activation_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn execute_window_activation<O: WindowActivationOps>(
    source: &str,
    window_label: &str,
    restore_result: Result<(), String>,
    operations: &O,
) -> WindowActivationDiagnostic {
    let steps = execute_window_activation_steps(restore_result, operations)
        .into_iter()
        .map(|step| WindowActivationStepDiagnostic {
            stage: step.stage.to_string(),
            ok: step.error.is_none(),
            error: step.error,
        })
        .collect::<Vec<_>>();
    let first_failure = steps.iter().find(|step| !step.ok);
    WindowActivationDiagnostic {
        attempt_id: WINDOW_ACTIVATION_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        attempted_at_ms: window_activation_timestamp_ms(),
        source: source.to_string(),
        window_label: window_label.to_string(),
        ok: first_failure.is_none(),
        failure_stage: first_failure.map(|step| step.stage.clone()),
        error: first_failure.and_then(|step| step.error.clone()),
        steps,
    }
}

fn missing_main_window_diagnostic(source: &str) -> WindowActivationDiagnostic {
    WindowActivationDiagnostic {
        attempt_id: WINDOW_ACTIVATION_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        attempted_at_ms: window_activation_timestamp_ms(),
        source: source.to_string(),
        window_label: "main".to_string(),
        ok: false,
        failure_stage: Some("locate_window".to_string()),
        error: Some("main window not found".to_string()),
        steps: vec![WindowActivationStepDiagnostic {
            stage: "locate_window".to_string(),
            ok: false,
            error: Some("main window not found".to_string()),
        }],
    }
}

fn publish_window_activation_diagnostic(
    app: &tauri::AppHandle,
    diagnostic: &WindowActivationDiagnostic,
) {
    let state = app.state::<Mutex<WindowActivationDiagnosticsState>>();
    match state.lock() {
        Ok(mut diagnostics) => {
            diagnostics.recent.push(diagnostic.clone());
            let overflow = diagnostics
                .recent
                .len()
                .saturating_sub(MAX_WINDOW_ACTIVATION_DIAGNOSTICS);
            if overflow > 0 {
                diagnostics.recent.drain(0..overflow);
            }
        }
        Err(error) => eprintln!(
            "[LumiCore][window_activation] diagnostic_store_failed: {}",
            error
        ),
    }

    let serialized = serde_json::to_string(diagnostic)
        .unwrap_or_else(|error| format!(r#"{{"ok":false,"serialization_error":"{}"}}"#, error));
    if diagnostic.ok {
        println!("[LumiCore][window_activation] {}", serialized);
    } else {
        eprintln!("[LumiCore][window_activation] {}", serialized);
    }
    if let Err(error) = app.emit(WINDOW_ACTIVATION_DIAGNOSTIC_EVENT, diagnostic.clone()) {
        eprintln!(
            "[LumiCore][window_activation] diagnostic_emit_failed: {}",
            error
        );
    }
}

fn show_main_window_impl(app: &tauri::AppHandle, source: &str) -> WindowActivationDiagnostic {
    let Some(window) = app.get_webview_window("main") else {
        let diagnostic = missing_main_window_diagnostic(source);
        publish_window_activation_diagnostic(app, &diagnostic);
        return diagnostic;
    };
    let wallpaper_state = app.state::<Mutex<WallpaperState>>();
    let wallpaper_enabled = wallpaper_state
        .lock()
        .map(|state| state.enabled)
        .map_err(|error| format!("read wallpaper state: {error}"));
    let restore_result = match wallpaper_enabled {
        Ok(true) => {
            let result = apply_wallpaper_mode(false, None, None, wallpaper_state.inner(), &window);
            if result.is_ok() {
                if let Ok(mode) = &result {
                    let _ = window.emit("lumi:wallpaper-mode-changed", mode.clone());
                }
            }
            result.map(|_| ())
        }
        Ok(false) => Ok(()),
        Err(error) => Err(error),
    };
    let operations = TauriWindowActivationOps { window: &window };
    let diagnostic = execute_window_activation(source, "main", restore_result, &operations);
    publish_window_activation_diagnostic(app, &diagnostic);
    diagnostic
}

#[tauri::command]
fn get_window_activation_diagnostics(
    state: tauri::State<'_, Mutex<WindowActivationDiagnosticsState>>,
) -> Result<Vec<WindowActivationDiagnostic>, String> {
    state
        .lock()
        .map(|diagnostics| diagnostics.recent.clone())
        .map_err(|error| error.to_string())
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
        .tooltip("LumiCore is ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                show_main_window_impl(app, "tray_menu_show");
            }
            "exit_wallpaper" => {
                show_main_window_impl(app, "tray_exit_wallpaper");
            }
            "hide" => {
                let _ = hide_main_window_impl(app);
            }
            "quit" => {
                request_app_exit(app);
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
                show_main_window_impl(tray.app_handle(), "tray_left_click");
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

// ── Clipboard Commands ──

// ── Idle Time ──

// ── System Audio Volume (winmm.dll) ──

// ── Monitor Brightness (dxva2.dll + user32.dll) ──

// ── Activity Polling ──

// ── Mouse & Keyboard Input Commands (enigo crate) ──

// Windows cursor save/restore for independent (virtual) cursor clicks.
// Saves real cursor pos, moves to target, clicks, restores — all within ~2 frames.

// ── Independent cursor: click at coordinates without stealing the user's mouse ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_in_background = std::env::args()
        .any(|arg| arg == "--background" || arg == "--hidden" || arg == "--minimized");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch is another native recovery path for a
            // click-through wallpaper window.
            show_main_window_impl(app, "single_instance");
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
        .manage(ShutdownBarrier::default())
        .manage(Mutex::new(BackendProcesses {
            node: None,
            python: None,
            node_restarts: 0,
            python_restarts: 0,
            node_config: None,
            attached_pid: None,
            startup_error: None,
        }))
        .manage(CommandSupervisor::default())
        .manage(Mutex::new(WallpaperState::default()))
        .manage(Mutex::new(ResidentState {
            close_to_background: started_in_background,
            started_in_background,
            force_quit: false,
        }))
        .manage(Mutex::new(DesktopWidgetState::default()))
        .manage(Mutex::new(CompactWindowState::default()))
        .manage(Mutex::new(WindowActivationDiagnosticsState::default()))
        .on_page_load(move |webview, payload| {
            if !started_in_background
                && webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                show_main_window_impl(webview.app_handle(), "page_load");
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_local_identity,
            get_native_client_identity,
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
            desktop_command_ipc::run_command,
            desktop_command_ipc::cancel_command,
            desktop_command_ipc::get_command_result,
            desktop_command_ipc::acknowledge_unknown_command_stop,
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
            get_window_activation_diagnostics,
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
                eprintln!("[LumiCore] Failed to create tray icon: {}", e);
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
                            println!("[LumiCore] Copying WebView2Loader.dll to EXE directory");
                            let _ = std::fs::copy(&dll_src, &dll_dest);
                        }
                    }
                }
            }

            // Reuse a verified same-root owner before considering a bundled child.
            let reuse = local_bootstrap::reuse_existing_backend(&app.config().identifier);
            let spawn_backend = match reuse {
                Ok(Some(pid)) => {
                    app.state::<Mutex<BackendProcesses>>().lock().unwrap().attached_pid = Some(pid);
                    println!("[LumiCore] Attached to existing backend PID {pid}");
                    false
                }
                Ok(None) => true,
                Err(error) => {
                    app.state::<Mutex<BackendProcesses>>().lock().unwrap().startup_error = Some(error.clone());
                    eprintln!("[LumiCore] Existing backend was left running: {error}");
                    app.dialog().message(error).title("Lumi — Shared backend unavailable")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_| {});
                    false
                }
            };
            if !spawn_backend {
                // Attached/blocked clients own no child, restart loop or shutdown right.
            } else if cfg!(debug_assertions) {
                println!("[LumiCore] Dev mode — skipping bundled backend spawn");
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
                        "[LumiCore] Starting backend: {} {} (cwd: {})",
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
                            println!("[LumiCore] Backend PID: {}", child.id());
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
                            eprintln!("[LumiCore] Failed to start backend: {}", e);
                        }
                    }
                } else {
                    eprintln!(
                        "[LumiCore] Backend not found. node.exe: {}, entry.cjs: {}, server.mjs: {}",
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
            if !cfg!(debug_assertions) && app.state::<Mutex<BackendProcesses>>().lock().unwrap().node.is_some() {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let max_restarts: u32 = 30;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        // An acknowledged graceful shutdown must not be
                        // mistaken for a crash and immediately restarted.
                        if app_handle.state::<ShutdownBarrier>().prevents_restart() { continue; }
                        let app_state = app_handle.state::<Mutex<BackendProcesses>>();
                        let mut state = app_state.lock().unwrap();

                        // Check Node.js backend
                        let mut restart_node = false;
                        if let Some(ref mut child) = state.node {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    eprintln!(
                                        "[LumiCore] Node backend exited with status {:?}",
                                        status.code()
                                    );
                                    restart_node = true;
                                }
                                Ok(None) => { /* still running */ }
                                Err(e) => {
                                    eprintln!("[LumiCore] Node backend health check failed: {}", e);
                                    restart_node = true;
                                }
                            }
                        }
                        if restart_node && state.node_restarts < max_restarts {
                            if let Some(ref cfg) = state.node_config {
                                eprintln!(
                                    "[LumiCore] Restarting Node backend (attempt {}/{})",
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
                                        println!("[LumiCore] Backend restarted, PID: {}", child.id());
                                        state.node = Some(child);
                                        state.node_restarts += 1;
                                    }
                                    Err(e) => {
                                        eprintln!("[LumiCore] Failed to restart Node backend: {}", e);
                                    }
                                }
                            }
                        } else if restart_node {
                            eprintln!(
                                "[LumiCore] Node backend max restarts ({}) reached, giving up",
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
                reg.on_shortcut(WINDOW_TOGGLE_SHORTCUT, move |app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let wallpaper_enabled = app
                        .state::<Mutex<WallpaperState>>()
                        .lock()
                        .map(|state| state.enabled)
                        .unwrap_or(false);
                    if wallpaper_enabled {
                        show_main_window_impl(app, "global_toggle_wallpaper");
                    } else if window.is_visible().unwrap_or(true) {
                        let _ = window.hide();
                    } else {
                        show_main_window_impl(app, "global_toggle_hidden");
                    }
                })
            {
                eprintln!(
                    "[LumiCore] Failed to register {WINDOW_TOGGLE_SHORTCUT} global shortcut: {error}"
                );
            }
            if let Err(error) =
                reg.on_shortcut(COMMAND_CENTER_SHORTCUT, move |app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    show_main_window_impl(app, "command_center_shortcut");
                    let _ = app.emit(COMMAND_CENTER_EVENT, ());
                })
            {
                eprintln!(
                    "[LumiCore] Failed to register {COMMAND_CENTER_SHORTCUT} global shortcut: {error}"
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LumiCore")
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
                } else if label == "main" && !app.state::<ShutdownBarrier>().is_saved() {
                    api.prevent_close();
                    request_app_exit(app);
                }
            }
            tauri::RunEvent::ExitRequested { api, .. }
                if !app.state::<ShutdownBarrier>().is_saved() =>
            {
                api.prevent_exit();
                request_app_exit(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                // Clicking the Dock icon must always recover a click-through
                // wallpaper window and restore its previous bounds.
                show_main_window_impl(app, "macos_reopen");
            }
            tauri::RunEvent::Exit => {
                if let Err(error) = app.global_shortcut().unregister_all() {
                    eprintln!("[LumiCore] Failed to unregister global shortcuts: {error}");
                }
                let state = app.state::<Mutex<BackendProcesses>>();
                let mut procs = state.lock().unwrap();
                if let Some(child) = procs.node.as_mut() {
                    // The backend exited after its save receipt. Never kill
                    // an unacknowledged process from an OS close callback.
                    let _ = child.try_wait();
                }
                if let Some(child) = procs.python.as_mut() {
                    println!("[LumiCore] Stopping GPT-SoVITS API...");
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}
