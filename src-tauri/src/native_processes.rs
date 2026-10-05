use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use std::io::Read;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use crate::native_apps::recently_focused_windows_app;
use crate::ActiveWindowInfo;

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
    /// First visible document window kept for legacy desktop consumers.
    pub window_title: String,
    /// All visible top-level document windows owned by this supported
    /// authoring process. The list is deliberately empty for other apps so a
    /// generic process snapshot does not become a broad window-title scrape.
    #[serde(default)]
    pub window_titles: Vec<String>,
    pub cpu_percent: f32,
    pub memory_mb: f32,
}

/// sysinfo reports a process relative to one logical CPU, so a multi-threaded
/// process can legitimately exceed 100. The desktop API exposes whole-machine
/// share instead because that is the percentage users expect in conversation.
fn normalize_process_cpu_percent(raw_percent: f32, logical_cpu_count: usize) -> f32 {
    (raw_percent / logical_cpu_count.max(1) as f32).clamp(0.0, 100.0)
}

fn is_supported_authoring_process_name(value: &str) -> bool {
    let normalized = value
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "wps"
            | "wps.exe"
            | "wpp"
            | "wpp.exe"
            | "et"
            | "et.exe"
            | "wpsoffice"
            | "wpsoffice.exe"
            | "wps office"
            | "winword"
            | "winword.exe"
            | "microsoft word"
            | "excel"
            | "excel.exe"
            | "microsoft excel"
            | "powerpnt"
            | "powerpnt.exe"
            | "microsoft powerpoint"
    )
}

fn normalize_visible_window_titles(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let clean = value
            .replace(['\r', '\n', '\t'], " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if clean.is_empty()
            || normalized
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&clean))
        {
            continue;
        }
        normalized.push(clean);
        if normalized.len() >= 12 {
            break;
        }
    }
    normalized
}

#[cfg(target_os = "windows")]
fn visible_window_titles_by_pid() -> HashMap<u32, Vec<String>> {
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(isize, isize) -> i32, parameter: isize) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn GetWindowTextLengthW(hwnd: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, text: *mut u16, max_count: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
    }

    extern "system" fn collect_window(hwnd: isize, parameter: isize) -> i32 {
        unsafe {
            if hwnd == 0 || parameter == 0 || IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let title_length = GetWindowTextLengthW(hwnd);
            if title_length <= 0 {
                return 1;
            }
            let capacity = (title_length as usize).min(1023) + 1;
            let mut title_buffer = vec![0u16; capacity];
            let copied = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), capacity as i32);
            if copied <= 0 {
                return 1;
            }
            let mut process_id = 0u32;
            GetWindowThreadProcessId(hwnd, &mut process_id);
            if process_id == 0 {
                return 1;
            }
            let title = String::from_utf16_lossy(&title_buffer[..copied as usize]);
            if title.trim().is_empty() {
                return 1;
            }
            let output = &mut *(parameter as *mut HashMap<u32, Vec<String>>);
            output.entry(process_id).or_default().push(title);
            1
        }
    }

    let mut output = HashMap::<u32, Vec<String>>::new();
    unsafe {
        EnumWindows(
            collect_window,
            &mut output as *mut HashMap<u32, Vec<String>> as isize,
        );
    }
    output
}

#[cfg(target_os = "macos")]
fn visible_window_titles_by_pid() -> HashMap<u32, Vec<String>> {
    // System Events exposes only user-visible accessibility windows. Failure
    // (including missing Accessibility permission) is a safe empty snapshot;
    // callers then ask the user to focus the document instead of guessing.
    let script = r#"
tell application "System Events"
  set outputText to ""
  repeat with targetProcess in application processes
    try
      set processName to name of targetProcess
      if processName is in {"WPS Office", "Microsoft Word", "Microsoft Excel", "Microsoft PowerPoint"} then
        set processPid to unix id of targetProcess
        repeat with targetWindow in windows of targetProcess
          try
            set windowTitle to name of targetWindow
            if windowTitle is not "" then set outputText to outputText & processPid & tab & windowTitle & linefeed
          end try
        end repeat
      end if
    end try
  end repeat
  return outputText
end tell
"#;
    let mut output = HashMap::<u32, Vec<String>>::new();
    if let Ok(result) = Command::new("osascript").args(["-e", script]).output() {
        if result.status.success() {
            for line in String::from_utf8_lossy(&result.stdout).lines() {
                let Some((pid, title)) = line.split_once('\t') else {
                    continue;
                };
                let Ok(pid) = pid.trim().parse::<u32>() else {
                    continue;
                };
                if !title.trim().is_empty() {
                    output.entry(pid).or_default().push(title.to_string());
                }
            }
        }
    }
    output
}

#[cfg(target_os = "linux")]
fn visible_window_titles_by_pid() -> HashMap<u32, Vec<String>> {
    let mut output = HashMap::<u32, Vec<String>>::new();
    let Ok(result) = Command::new("wmctrl").arg("-lp").output() else {
        return output;
    };
    if !result.status.success() {
        return output;
    }
    for line in String::from_utf8_lossy(&result.stdout).lines() {
        let fields: Vec<&str> = line.splitn(5, char::is_whitespace).collect();
        let Some(pid) = fields
            .get(2)
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        let title = fields.get(4).map(|value| value.trim()).unwrap_or_default();
        if !title.is_empty() {
            output.entry(pid).or_default().push(title.to_string());
        }
    }
    output
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn visible_window_titles_by_pid() -> HashMap<u32, Vec<String>> {
    HashMap::new()
}

#[tauri::command]
pub(crate) fn get_active_window_info() -> ActiveWindowInfo {
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
pub(crate) fn control_active_window(action: String) -> WindowControlResult {
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
pub(crate) fn get_running_processes() -> Vec<ProcessInfo> {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(50));
    sys.refresh_all();

    let logical_cpu_count = sys.cpus().len().max(1);
    let mut visible_windows = visible_window_titles_by_pid();

    let mut processes: Vec<ProcessInfo> = Vec::new();
    for (pid, proc) in sys.processes() {
        let raw_cpu = proc.cpu_usage();
        let cpu = normalize_process_cpu_percent(raw_cpu, logical_cpu_count);
        let mem = proc.memory() as f32 / 1024.0 / 1024.0; // bytes -> MB
        let name = proc.name().to_string_lossy().to_string();
        let window_titles = if is_supported_authoring_process_name(&name) {
            normalize_visible_window_titles(
                visible_windows.remove(&pid.as_u32()).unwrap_or_default(),
            )
        } else {
            Vec::new()
        };
        // Retain every supported authoring process with a visible document
        // window even when it is idle; ordinary process noise remains bounded
        // by the historical CPU/memory filter.
        if raw_cpu > 0.1 || mem > 10.0 || !window_titles.is_empty() {
            processes.push(ProcessInfo {
                pid: pid.as_u32(),
                name,
                window_title: window_titles.first().cloned().unwrap_or_default(),
                window_titles,
                cpu_percent: cpu,
                memory_mb: mem,
            });
        }
    }
    processes.sort_by(|a, b| {
        let by_visible_authoring_window =
            (!b.window_titles.is_empty()).cmp(&(!a.window_titles.is_empty()));
        if by_visible_authoring_window != std::cmp::Ordering::Equal {
            return by_visible_authoring_window;
        }
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes.truncate(50); // top 50
    processes
}

#[cfg(test)]
mod authoring_window_snapshot_tests {
    use super::{is_supported_authoring_process_name, normalize_visible_window_titles};

    #[test]
    fn recognizes_only_supported_office_and_wps_processes() {
        for process in [
            "wps.exe",
            "wpp.exe",
            "et.exe",
            "C:\\Program Files\\WPS Office\\wpsoffice.exe",
            "WINWORD.EXE",
            "EXCEL.EXE",
            "POWERPNT.EXE",
            "Microsoft Word",
            "Microsoft Excel",
            "Microsoft PowerPoint",
        ] {
            assert!(is_supported_authoring_process_name(process), "{process}");
        }
        for process in ["chrome.exe", "Code.exe", "lumi-core.exe", "explorer.exe"] {
            assert!(!is_supported_authoring_process_name(process), "{process}");
        }
    }

    #[test]
    fn sanitizes_deduplicates_and_bounds_visible_window_titles() {
        let mut titles = vec![
            " Quarterly Review.pptx - WPS Office ".to_string(),
            "Quarterly\tReview.pptx  -  WPS Office".to_string(),
            "quarterly review.pptx - wps office".to_string(),
            "\r\n".to_string(),
        ];
        titles.extend((0..20).map(|index| format!("Document-{index}.docx - Microsoft Word")));
        let normalized = normalize_visible_window_titles(titles);
        assert_eq!(normalized[0], "Quarterly Review.pptx - WPS Office");
        assert_eq!(normalized.len(), 12);
    }
}
