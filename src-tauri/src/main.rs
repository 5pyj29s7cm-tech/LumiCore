// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Ensure WebView2Loader.dll is alongside the EXE before Tauri starts.
    // Tauri v2.11.0 NSIS bundler puts it in _up_\desktop-resources\ instead.
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let dll_dest = exe_dir.join("WebView2Loader.dll");
            if !dll_dest.exists() {
                for candidate in &[
                    exe_dir
                        .join("_up_")
                        .join("desktop-resources")
                        .join("WebView2Loader.dll"),
                    exe_dir.join("desktop-resources").join("WebView2Loader.dll"),
                ] {
                    if candidate.exists() {
                        let _ = std::fs::copy(candidate, &dll_dest);
                        break;
                    }
                }
            }
        }
    }

    lumi_core_lib::run()
}
