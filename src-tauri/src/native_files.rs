use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use std::time::SystemTime;

use crate::CommandResult;
use crate::NativeFile;
use crate::NativePathInfo;
use crate::NativeTextFileReadResult;
use crate::NativeTextFileWriteResult;

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
pub(crate) fn list_home_files() -> Vec<NativeFile> {
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
pub(crate) fn list_directory(path: String, limit: Option<usize>) -> Vec<NativeFile> {
    let dir = resolve_user_path(&path);
    read_native_files(&dir, limit)
}

#[tauri::command]
pub(crate) fn path_info(target: String) -> NativePathInfo {
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
pub(crate) fn write_text_file(
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
pub(crate) fn read_text_file(path: String) -> NativeTextFileReadResult {
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
pub(crate) fn create_directory(parent: String, name: String) -> CommandResult {
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
pub(crate) fn rename_item(target: String, new_name: String) -> CommandResult {
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
pub(crate) fn delete_item(target: String) -> CommandResult {
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
