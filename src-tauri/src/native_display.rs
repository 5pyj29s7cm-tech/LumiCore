use serde::{Deserialize, Serialize};

use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
use crate::mac_main_display_input_geometry;
use crate::native_activity::IdleInfo;
use crate::ActiveWindowInfo;

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
pub(crate) fn get_system_volume() -> f32 {
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
pub(crate) fn set_system_volume(level: f32) -> Result<f32, String> {
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
pub(crate) fn get_screen_brightness() -> f32 {
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
pub(crate) fn set_screen_brightness(level: f32) -> Result<f32, String> {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ActivitySnapshot {
    pub window: ActiveWindowInfo,
    pub idle: IdleInfo,
    pub running_process_count: usize,
}

#[tauri::command]
pub(crate) fn capture_screen() -> CaptureResult {
    #[cfg(target_os = "windows")]
    {
        // Write PNG to temp file (avoids stdout truncation for ~8 MB screenshots)
        static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let temp_path = std::env::temp_dir().join(format!(
            "lumi_scr_{}_{}.png",
            std::process::id(),
            CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
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
