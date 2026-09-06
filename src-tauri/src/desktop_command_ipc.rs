use super::{run_command_blocking, CommandResult, CommandSupervisor, MAX_COMMAND_TIMEOUT_MS};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[tauri::command]
pub(super) async fn run_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    command_id: Option<String>,
    supervisor: tauri::State<'_, CommandSupervisor>,
) -> Result<CommandResult, String> {
    let id = command_id.unwrap_or_else(|| {
        format!(
            "local-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    });
    let fingerprint =
        serde_json::to_string(&(&command, &cwd, timeout_ms)).map_err(|error| error.to_string())?;
    let (execution, start) = supervisor.reserve(&id, fingerprint)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !start { return execution.wait(Duration::from_millis(MAX_COMMAND_TIMEOUT_MS + 30_000)); }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_command_blocking(command, cwd, timeout_ms, &execution)))
            .unwrap_or_else(|_| CommandResult { success: false, output: "[outcome_unknown] Native command worker failed; reconcile the original identity before continuing.".into() });
        Ok(execution.finish(result))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) fn cancel_command(
    command_id: String,
    supervisor: tauri::State<'_, CommandSupervisor>,
) -> bool {
    supervisor.cancel(command_id.trim())
}

#[tauri::command]
pub(super) fn get_command_result(
    command_id: String,
    supervisor: tauri::State<'_, CommandSupervisor>,
) -> Option<CommandResult> {
    supervisor.result(command_id.trim())
}

#[tauri::command]
pub(super) fn acknowledge_unknown_command_stop(
    command_id: String,
    supervisor: tauri::State<'_, CommandSupervisor>,
) -> bool {
    supervisor.acknowledge_unknown_stop(command_id.trim())
}
