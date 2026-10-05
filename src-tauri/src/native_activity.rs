use serde::{Deserialize, Serialize};

use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;

use crate::native_display::ActivitySnapshot;
use crate::native_processes::get_active_window_info;
use crate::native_processes::get_running_processes;

#[tauri::command]
pub(crate) fn get_clipboard_text() -> String {
    use arboard::Clipboard;
    match Clipboard::new() {
        Ok(mut clipboard) => clipboard.get_text().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

#[tauri::command]
pub(crate) fn set_clipboard_text(text: String) -> bool {
    use arboard::Clipboard;
    match Clipboard::new() {
        Ok(mut clipboard) => clipboard.set_text(text).is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
pub(crate) fn set_clipboard_files(paths: Vec<String>) -> Result<bool, String> {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct IdleInfo {
    pub idle_ms: u64,
    pub idle_seconds: u64,
}

#[tauri::command]
pub(crate) fn get_idle_time() -> IdleInfo {
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

#[tauri::command]
pub(crate) fn poll_activity() -> ActivitySnapshot {
    let window = get_active_window_info();
    let idle = get_idle_time();
    let processes = get_running_processes();
    ActivitySnapshot {
        window,
        idle,
        running_process_count: processes.len(),
    }
}
