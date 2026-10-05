use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

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
pub(crate) fn mouse_move(x: f64, y: f64) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .move_mouse(x as i32, y as i32, Coordinate::Abs)
        .map_err(|e| format!("mouse_move: {}", e))?;
    Ok(format!("Mouse moved to ({}, {})", x as i32, y as i32))
}

#[tauri::command]
pub(crate) fn mouse_click(button: String) -> Result<String, String> {
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
pub(crate) fn mouse_drag(
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
pub(crate) fn keyboard_type(text: String) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo init: {}", e))?;
    enigo
        .text(&text)
        .map_err(|e| format!("keyboard_type: {}", e))?;
    Ok(format!("Typed {} characters", text.len()))
}

fn keyboard_key_from_name(value: &str) -> Result<Key, String> {
    let main_key = value.trim();
    let normalized = main_key.to_ascii_lowercase();
    let key = match normalized.as_str() {
        "meta" | "win" | "cmd" | "super" => Key::Meta,
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
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
        "mediaplaypause"
        | "media_play_pause"
        | "media-play-pause"
        | "playpause"
        | "play_pause"
        | "play-pause" => Key::MediaPlayPause,
        "medianexttrack"
        | "media_next_track"
        | "media-next-track"
        | "medianext"
        | "media_next"
        | "media-next"
        | "nexttrack"
        | "next_track" => Key::MediaNextTrack,
        "mediaprevtrack"
        | "media_prev_track"
        | "media-prev-track"
        | "mediaprevious"
        | "media_previous"
        | "media-previous"
        | "prevtrack"
        | "previous_track" => Key::MediaPrevTrack,
        "volumeup" | "volume_up" | "volume-up" => Key::VolumeUp,
        "volumedown" | "volume_down" | "volume-down" => Key::VolumeDown,
        "volumemute" | "volume_mute" | "volume-mute" | "mute" => Key::VolumeMute,
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
                "Unknown key: {}. Use names (enter/escape/tab/up/down/media/volume) or a single character",
                main_key
            ))
        }
    };
    Ok(key)
}

#[tauri::command]
pub(crate) fn keyboard_press(key: String) -> Result<String, String> {
    let parts: Vec<&str> = key.split('+').map(|s| s.trim()).collect();
    // Validate every part before pressing any key or modifier.
    let main_key = *parts.last().unwrap_or(&"");
    let key_enum = keyboard_key_from_name(main_key).map_err(|e| format!("[not_started] {}", e))?;
    for &part in &parts[..parts.len().saturating_sub(1)] {
        if !matches!(
            part.to_ascii_lowercase().as_str(),
            "ctrl" | "control" | "shift" | "alt" | "meta" | "win" | "cmd" | "super"
        ) {
            return Err(format!("[not_started] Unknown modifier: {}", part));
        }
    }
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| format!("[not_started] enigo init: {}", e))?;
    // Parse modifiers first, then the main key
    for &part in &parts[..parts.len().saturating_sub(1)] {
        match part.to_ascii_lowercase().as_str() {
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

    let result = enigo
        .key(key_enum, Direction::Click)
        .map_err(|e| format!("key press '{}': {}", main_key, e));

    // Release modifiers in reverse order
    for &part in parts.iter().rev().skip(1) {
        match part.to_ascii_lowercase().as_str() {
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

    result?;
    Ok(format!("Pressed key: {}", key))
}

#[cfg(test)]
mod keyboard_key_mapping_tests {
    use super::keyboard_key_from_name;
    use enigo::Key;

    #[test]
    fn validates_system_keys_before_dispatch() {
        for alias in ["win", "meta", "cmd", "super"] {
            assert_eq!(keyboard_key_from_name(alias).unwrap(), Key::Meta);
        }
        assert!(super::keyboard_press("ctrl+unsupported-key".to_string())
            .unwrap_err()
            .starts_with("[not_started]"));
        assert!(super::keyboard_press("unsupported-modifier+a".to_string())
            .unwrap_err()
            .starts_with("[not_started]"));
    }

    #[test]
    fn maps_cross_platform_media_key_aliases() {
        for alias in [
            "mediaplaypause",
            "playpause",
            "media_play_pause",
            "media-play-pause",
        ] {
            assert_eq!(keyboard_key_from_name(alias).unwrap(), Key::MediaPlayPause);
        }
        for alias in ["medianexttrack", "media_next", "next_track"] {
            assert_eq!(keyboard_key_from_name(alias).unwrap(), Key::MediaNextTrack);
        }
        for alias in ["mediaprevtrack", "media_previous", "previous_track"] {
            assert_eq!(keyboard_key_from_name(alias).unwrap(), Key::MediaPrevTrack);
        }
    }

    #[test]
    fn maps_cross_platform_volume_key_aliases() {
        assert_eq!(keyboard_key_from_name("volume_up").unwrap(), Key::VolumeUp);
        assert_eq!(
            keyboard_key_from_name("volume-down").unwrap(),
            Key::VolumeDown
        );
        for alias in ["volumemute", "volume_mute", "mute"] {
            assert_eq!(keyboard_key_from_name(alias).unwrap(), Key::VolumeMute);
        }
    }
}

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
pub(crate) fn mouse_click_at(x: f64, y: f64, button: Option<String>) -> Result<String, String> {
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
pub(crate) fn mouse_double_click_at(x: f64, y: f64) -> Result<String, String> {
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
pub(crate) fn mouse_right_click_at(x: f64, y: f64) -> Result<String, String> {
    click_at_impl(x, y, Button::Right)?;
    Ok(format!(
        "Right-clicked at ({}, {}) [virtual cursor]",
        x as i32, y as i32
    ))
}
