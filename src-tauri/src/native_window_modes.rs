use std::sync::Mutex;

use tauri::Emitter;

use crate::CompactWindowMode;
use crate::CompactWindowState;
use crate::DesktopWidgetMode;
use crate::DesktopWidgetState;
use crate::ResidentState;
use crate::WallpaperMode;
use crate::WallpaperPresentation;
use crate::WallpaperState;
use crate::WallpaperWorkspace;

#[tauri::command]
pub(crate) fn set_wallpaper_mode(
    enabled: bool,
    presentation: Option<WallpaperPresentation>,
    workspace: Option<WallpaperWorkspace>,
    state: tauri::State<'_, Mutex<WallpaperState>>,
    window: tauri::WebviewWindow,
) -> Result<WallpaperMode, String> {
    let mode = apply_wallpaper_mode(enabled, presentation, workspace, state.inner(), &window)?;
    let _ = window.emit("lumi:wallpaper-mode-changed", mode.clone());
    Ok(mode)
}

#[tauri::command]
pub(crate) fn get_wallpaper_mode(
    state: tauri::State<'_, Mutex<WallpaperState>>,
) -> Result<WallpaperMode, String> {
    let wallpaper = state.lock().map_err(|e| e.to_string())?;
    Ok(WallpaperMode {
        enabled: wallpaper.enabled,
        presentation: wallpaper.presentation,
        workspace: wallpaper.workspace,
    })
}

pub(crate) fn apply_wallpaper_mode(
    enabled: bool,
    requested_presentation: Option<WallpaperPresentation>,
    requested_workspace: Option<WallpaperWorkspace>,
    state: &Mutex<WallpaperState>,
    window: &tauri::WebviewWindow,
) -> Result<WallpaperMode, String> {
    let (restore, presentation, workspace, previous_state) = {
        let mut wallpaper = state.lock().map_err(|e| e.to_string())?;
        let previous_state = wallpaper.clone();
        if enabled {
            if !wallpaper.enabled {
                wallpaper.previous_size = window.outer_size().ok();
                wallpaper.previous_position = window.outer_position().ok();
                wallpaper.was_fullscreen = window.is_fullscreen().unwrap_or(false);
                wallpaper.was_maximized = window.is_maximized().unwrap_or(false);
            }
            let presentation = requested_presentation.unwrap_or_default();
            let workspace = requested_workspace.unwrap_or(wallpaper.workspace);
            wallpaper.enabled = true;
            wallpaper.presentation = presentation;
            wallpaper.workspace = workspace;
            (None, presentation, workspace, previous_state)
        } else {
            wallpaper.enabled = false;
            let presentation = wallpaper.presentation;
            let workspace = requested_workspace.unwrap_or(wallpaper.workspace);
            wallpaper.workspace = workspace;
            (
                Some((
                    wallpaper.previous_size.take(),
                    wallpaper.previous_position.take(),
                    wallpaper.was_fullscreen,
                    wallpaper.was_maximized,
                )),
                presentation,
                workspace,
                previous_state,
            )
        }
    };

    let transition_result = (|| -> Result<(), String> {
        if enabled {
            window
                .show()
                .map_err(|e| format!("show wallpaper window: {e}"))?;
            // Always clear click-through before changing presentations so moving
            // from desktop control to the workbench cannot leave a dead window.
            window
                .set_ignore_cursor_events(false)
                .map_err(|e| format!("restore wallpaper pointer input: {e}"))?;
            let _ = window.set_fullscreen(false);
            let _ = window.unmaximize();
            let _ = window.set_resizable(true);
            let _ = window.set_decorations(false);
            let _ = window.set_shadow(false);

            match presentation {
                WallpaperPresentation::Workbench => {
                    // The supercomputer workbench is a real interactive full-screen
                    // application surface, not a click-through desktop overlay.
                    let _ = window.set_skip_taskbar(false);
                    window
                        .set_always_on_top(false)
                        .map_err(|e| format!("release workbench always-on-top: {e}"))?;
                    window
                        .set_fullscreen(true)
                        .map_err(|e| format!("enter wallpaper workbench fullscreen: {e}"))?;
                }
                WallpaperPresentation::DesktopControl => {
                    // Preserve the legacy transparent, always-on-top, click-through
                    // surface used while Lumi controls other desktop applications.
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

                    window
                        .set_always_on_top(true)
                        .map_err(|e| format!("raise desktop-control wallpaper: {e}"))?;
                    window
                        .set_ignore_cursor_events(true)
                        .map_err(|e| format!("enable desktop-control click-through: {e}"))?;
                }
            }
        } else {
            window
                .set_ignore_cursor_events(false)
                .map_err(|e| format!("disable wallpaper click-through: {e}"))?;
            window
                .set_always_on_top(false)
                .map_err(|e| format!("release wallpaper always-on-top: {e}"))?;
            let _ = window.set_skip_taskbar(false);
            let _ = window.set_resizable(true);
            let _ = window.set_min_size(Some(tauri::LogicalSize::new(
                DEFAULT_MAIN_MIN_WIDTH as f64,
                DEFAULT_MAIN_MIN_HEIGHT as f64,
            )));

            if let Some((previous_size, previous_position, was_fullscreen, was_maximized)) = restore
            {
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
        Ok(())
    })();

    if let Err(error) = transition_result {
        if let Ok(mut wallpaper) = state.lock() {
            *wallpaper = previous_state;
        }
        return Err(error);
    }

    println!(
        "[LumiCore] Wallpaper mode: {} ({:?})",
        if enabled { "ON" } else { "OFF" },
        presentation,
    );
    Ok(WallpaperMode {
        enabled,
        presentation,
        workspace,
    })
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
        eprintln!(
            "[LumiCore] desktop widget set_resizable(false) failed: {}",
            e
        );
    }
    if let Err(e) = window.set_decorations(false) {
        eprintln!(
            "[LumiCore] desktop widget set_decorations(false) failed: {}",
            e
        );
    }
    if let Err(e) = window.set_shadow(false) {
        eprintln!("[LumiCore] desktop widget set_shadow(false) failed: {}", e);
    }
    let _ = window.set_skip_taskbar(true);
    if let Err(e) = window.set_always_on_top(true) {
        eprintln!(
            "[LumiCore] desktop widget set_always_on_top(true) failed: {}",
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
        eprintln!(
            "[LumiCore] desktop widget restore decorations failed: {}",
            e
        );
    }
    if let Err(e) = window.set_resizable(true) {
        eprintln!("[LumiCore] desktop widget restore resizable failed: {}", e);
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
pub(crate) fn enter_desktop_widget_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    enter_desktop_widget_impl(&window, &state)
}

#[tauri::command]
pub(crate) fn exit_desktop_widget_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopWidgetState>>,
) -> Result<DesktopWidgetMode, String> {
    exit_desktop_widget_impl(&window, &state)
}

#[tauri::command]
pub(crate) fn toggle_desktop_widget_mode(
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
pub(crate) fn get_desktop_widget_mode(
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
pub(crate) fn toggle_compact_window_mode(
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
pub(crate) fn exit_compact_window_mode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<CompactWindowState>>,
) -> Result<CompactWindowMode, String> {
    exit_compact_window_impl(&window, &state)
}

#[tauri::command]
pub(crate) fn get_compact_window_mode(
    state: tauri::State<'_, Mutex<CompactWindowState>>,
) -> Result<CompactWindowMode, String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.enabled;
    Ok(CompactWindowMode { enabled })
}

#[tauri::command]
pub(crate) fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<(), String> {
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
pub(crate) fn close_window(
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

#[tauri::command]
pub(crate) fn hide_to_background(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}
