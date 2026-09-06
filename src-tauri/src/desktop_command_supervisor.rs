use super::CommandResult;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const RECEIPT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_COMMANDS: usize = 256;

pub struct CommandExecution {
    pub cancelled: AtomicBool,
    result: Mutex<Option<CommandResult>>,
    changed: Condvar,
    dispatch_state: AtomicU8,
}
impl CommandExecution {
    fn new(cancelled: bool) -> Self {
        Self {
            cancelled: AtomicBool::new(cancelled),
            result: Mutex::new(None),
            changed: Condvar::new(),
            dispatch_state: AtomicU8::new(if cancelled { 2 } else { 0 }),
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn dispatch<T>(&self, start: impl FnOnce() -> T) -> Option<T> {
        // The CAS is the dispatch admission boundary; cancellation never waits
        // on OS process creation or a worker-held lock on the IPC thread.
        if self
            .dispatch_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            Some(start())
        } else {
            None
        }
    }
    fn request_cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self
            .dispatch_state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
    }
    pub fn finish(&self, result: CommandResult) -> CommandResult {
        let mut saved = self
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if saved.is_none() {
            *saved = Some(result);
        }
        self.changed.notify_all();
        saved.as_ref().unwrap().clone()
    }
    pub fn wait(&self, timeout: Duration) -> Result<CommandResult, String> {
        let result = self.result.lock().map_err(|error| error.to_string())?;
        let (result, _) = self
            .changed
            .wait_timeout_while(result, timeout, |value| value.is_none())
            .map_err(|error| error.to_string())?;
        result.clone().ok_or_else(|| "[outcome_unknown] Native command has not confirmed its terminal result; query the original command ID.".into())
    }
    pub fn result(&self) -> Option<CommandResult> {
        self.result.lock().ok().and_then(|value| value.clone())
    }
}
struct Entry {
    fingerprint: Option<String>,
    execution: Arc<CommandExecution>,
    touched: Instant,
    stop_acknowledged: bool,
}
#[derive(Default)]
pub struct CommandSupervisor {
    entries: Mutex<HashMap<String, Entry>>,
    closing: AtomicBool,
    exit_gate: Mutex<()>,
}
impl CommandSupervisor {
    fn prune(entries: &mut HashMap<String, Entry>) {
        // Running commands never expire into permission to repeat. A receipt
        // or a cancellation that never reached run is retained longer than the
        // maximum native deadline and frontend reconciliation window.
        entries.retain(|_, entry| {
            entry.touched.elapsed() < RECEIPT_TTL
                || (entry.fingerprint.is_some()
                    && entry.execution.result().is_none_or(|result| {
                        result.output.contains("[outcome_unknown]") && !entry.stop_acknowledged
                    }))
        });
    }
    pub fn reserve(
        &self,
        id: &str,
        fingerprint: String,
    ) -> Result<(Arc<CommandExecution>, bool), String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Native command admission is closed while the app is saving.".into());
        }
        if id.is_empty()
            || id.len() > 200
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_:-".contains(c))
        {
            return Err("Invalid native command identity.".into());
        }
        let mut entries = self.entries.lock().map_err(|error| error.to_string())?;
        if self.closing.load(Ordering::Acquire) {
            return Err("Native command admission is closed while the app is saving.".into());
        }
        Self::prune(&mut entries);
        if let Some(entry) = entries.get_mut(id) {
            if entry
                .fingerprint
                .as_ref()
                .is_some_and(|original| original != &fingerprint)
            {
                return Err(
                    "Native command identity already belongs to different arguments.".into(),
                );
            }
            let start = entry.fingerprint.is_none();
            entry.fingerprint = Some(fingerprint);
            entry.touched = Instant::now();
            return Ok((entry.execution.clone(), start));
        }
        if entries.values().any(|entry| {
            entry.fingerprint.is_some()
                && !entry.stop_acknowledged
                && match entry.execution.result() {
                    Some(result) => result.output.contains("[outcome_unknown]"),
                    None => entry.execution.is_cancelled(),
                }
        }) {
            return Err("[outcome_unknown] A previous native command is awaiting physical stop confirmation.".into());
        }
        if entries.len() >= MAX_COMMANDS {
            return Err(
                "Native command receipt capacity is full; wait for existing commands to settle."
                    .into(),
            );
        }
        let execution = Arc::new(CommandExecution::new(false));
        entries.insert(
            id.into(),
            Entry {
                fingerprint: Some(fingerprint),
                execution: execution.clone(),
                touched: Instant::now(),
                stop_acknowledged: false,
            },
        );
        Ok((execution, true))
    }
    pub fn cancel(&self, id: &str) -> bool {
        if id.is_empty() || id.len() > 200 {
            return false;
        }
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        Self::prune(&mut entries);
        if let Some(entry) = entries.get_mut(id) {
            entry.execution.request_cancel();
            entry.touched = Instant::now();
            return true;
        }
        if entries.len() >= MAX_COMMANDS {
            return false;
        }
        // Cancellation may arrive before the async command's first poll.
        entries.insert(
            id.into(),
            Entry {
                fingerprint: None,
                execution: Arc::new(CommandExecution::new(true)),
                touched: Instant::now(),
                stop_acknowledged: false,
            },
        );
        true
    }
    pub fn result(&self, id: &str) -> Option<CommandResult> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(id).and_then(|entry| entry.execution.result()))
    }
    pub fn acknowledge_unknown_stop(&self, id: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(id) else {
            return false;
        };
        let Some(result) = entry.execution.result() else {
            return false;
        };
        if !result.output.contains("[outcome_unknown]") {
            return false;
        }
        // Explicit user stop acknowledgment is separate from execution evidence.
        // The unknown receipt remains byte-for-byte unchanged and not successful.
        entry.stop_acknowledged = true;
        entry.touched = Instant::now();
        true
    }
    pub fn lock_exit_attempt(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.exit_gate.lock().map_err(|error| error.to_string())
    }
    pub fn resume_after_failed_exit(&self) {
        self.closing.store(false, Ordering::Release);
    }
    pub fn cancel_all_and_wait(&self, timeout: Duration) -> Result<(), String> {
        self.closing.store(true, Ordering::Release);
        let outcome = (|| {
            let executions: Vec<_> = self
                .entries
                .lock()
                .map_err(|error| error.to_string())?
                .values()
                .filter(|entry| entry.fingerprint.is_some())
                .map(|entry| (entry.execution.clone(), entry.stop_acknowledged))
                .collect();
            for (execution, _) in &executions {
                execution.request_cancel();
            }
            let deadline = Instant::now() + timeout;
            for (execution, acknowledged) in executions {
                let result = execution.wait(deadline.saturating_duration_since(Instant::now()))?;
                if result.output.contains("[outcome_unknown]") && !acknowledged {
                    return Err(result.output);
                }
            }
            Ok(())
        })();
        if outcome.is_err() {
            self.resume_after_failed_exit();
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_admission_and_duplicate_receipts_are_not_reexecuted() {
        let supervisor = CommandSupervisor::default();
        assert!(supervisor.cancel("cancel-first"));
        let (execution, start) = supervisor.reserve("cancel-first", "same".into()).unwrap();
        assert!(start && execution.is_cancelled());
        execution.finish(CommandResult {
            success: false,
            output: "cancelled before start".into(),
        });
        let (again, start) = supervisor.reserve("cancel-first", "same".into()).unwrap();
        assert!(!start);
        assert_eq!(
            again.wait(Duration::ZERO).unwrap().output,
            "cancelled before start"
        );
        assert!(supervisor
            .reserve("cancel-first", "different".into())
            .is_err());
    }
    #[test]
    fn running_identity_is_shared_and_shutdown_waits_for_its_terminal() {
        let supervisor = Arc::new(CommandSupervisor::default());
        let (execution, _) = supervisor.reserve("active", "same".into()).unwrap();
        assert!(!supervisor.reserve("active", "same".into()).unwrap().1);
        assert!(supervisor
            .cancel_all_and_wait(Duration::from_millis(1))
            .is_err());
        assert!(execution.is_cancelled());
        assert!(supervisor.reserve("new", "new".into()).is_err());
        execution.finish(CommandResult {
            success: false,
            output: "terminated".into(),
        });
        assert!(supervisor.cancel_all_and_wait(Duration::ZERO).is_ok());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn unknown_stop_acknowledgment_preserves_receipt_and_failed_exit_can_resume_safely() {
        let supervisor = CommandSupervisor::default();
        let (execution, _) = supervisor.reserve("unknown", "args".into()).unwrap();
        assert!(!supervisor.acknowledge_unknown_stop("unknown"));
        assert!(supervisor.cancel_all_and_wait(Duration::ZERO).is_err());
        assert!(supervisor.reserve("blocked", "new".into()).is_err());
        execution.finish(CommandResult {
            success: false,
            output: "[outcome_unknown] worker terminal is uncertain".into(),
        });
        assert!(supervisor.cancel_all_and_wait(Duration::ZERO).is_err());
        assert!(supervisor.acknowledge_unknown_stop("unknown"));
        let original = supervisor.result("unknown").unwrap();
        assert!(!original.success && original.output.contains("[outcome_unknown]"));
        let (normal, _) = supervisor.reserve("normal", "normal".into()).unwrap();
        normal.finish(CommandResult {
            success: true,
            output: "done".into(),
        });
        assert!(!supervisor.acknowledge_unknown_stop("normal"));
        assert!(supervisor.cancel_all_and_wait(Duration::ZERO).is_ok());
        supervisor.resume_after_failed_exit();
        assert!(supervisor
            .reserve("after-backend-save-failure", "new".into())
            .is_ok());
    }
}
