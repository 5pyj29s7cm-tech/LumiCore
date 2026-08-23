#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowActivationStepResult {
    pub(crate) stage: &'static str,
    pub(crate) error: Option<String>,
}

pub(crate) trait WindowActivationOps {
    fn show(&self) -> Result<(), String>;
    fn unminimize(&self) -> Result<(), String>;
    fn focus_window(&self) -> Result<(), String>;
    fn focus_webview(&self) -> Result<(), String>;
    fn is_visible(&self) -> Result<bool, String>;
    fn is_focused(&self) -> Result<bool, String>;
}

fn step(stage: &'static str, result: Result<(), String>) -> WindowActivationStepResult {
    WindowActivationStepResult {
        stage,
        error: result.err(),
    }
}

/// Runs every activation stage even when an earlier one fails. This makes the
/// resulting chain useful for diagnosis and still gives later recovery steps a
/// chance to put the window back on screen.
pub(crate) fn execute_window_activation_steps<O: WindowActivationOps>(
    restore_result: Result<(), String>,
    operations: &O,
) -> Vec<WindowActivationStepResult> {
    vec![
        step("restore_window_mode", restore_result),
        step("show", operations.show()),
        step("unminimize", operations.unminimize()),
        step("focus_window", operations.focus_window()),
        step("focus_webview", operations.focus_webview()),
        step(
            "verify_visible",
            operations.is_visible().and_then(|visible| {
                if visible {
                    Ok(())
                } else {
                    Err("window remained hidden after show".to_string())
                }
            }),
        ),
        step(
            "verify_focused",
            operations.is_focused().and_then(|focused| {
                if focused {
                    Ok(())
                } else {
                    Err("window did not become focused".to_string())
                }
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::{execute_window_activation_steps, WindowActivationOps};
    use std::cell::RefCell;

    struct FakeWindowActivationOps {
        calls: RefCell<Vec<&'static str>>,
        failing_stage: Option<&'static str>,
        visible: bool,
        focused: bool,
    }

    impl FakeWindowActivationOps {
        fn new(failing_stage: Option<&'static str>, visible: bool, focused: bool) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                failing_stage,
                visible,
                focused,
            }
        }

        fn operation(&self, stage: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(stage);
            if self.failing_stage == Some(stage) {
                Err(format!("injected {stage} failure"))
            } else {
                Ok(())
            }
        }
    }

    impl WindowActivationOps for FakeWindowActivationOps {
        fn show(&self) -> Result<(), String> {
            self.operation("show")
        }

        fn unminimize(&self) -> Result<(), String> {
            self.operation("unminimize")
        }

        fn focus_window(&self) -> Result<(), String> {
            self.operation("focus_window")
        }

        fn focus_webview(&self) -> Result<(), String> {
            self.operation("focus_webview")
        }

        fn is_visible(&self) -> Result<bool, String> {
            self.calls.borrow_mut().push("verify_visible");
            if self.failing_stage == Some("verify_visible") {
                Err("injected verify_visible failure".to_string())
            } else {
                Ok(self.visible)
            }
        }

        fn is_focused(&self) -> Result<bool, String> {
            self.calls.borrow_mut().push("verify_focused");
            if self.failing_stage == Some("verify_focused") {
                Err("injected verify_focused failure".to_string())
            } else {
                Ok(self.focused)
            }
        }
    }

    #[test]
    fn reports_success_without_a_real_window() {
        let operations = FakeWindowActivationOps::new(None, true, true);

        let steps = execute_window_activation_steps(Ok(()), &operations);

        assert_eq!(steps.len(), 7);
        assert!(steps.iter().all(|step| step.error.is_none()));
        assert_eq!(
            operations.calls.into_inner(),
            vec![
                "show",
                "unminimize",
                "focus_window",
                "focus_webview",
                "verify_visible",
                "verify_focused",
            ]
        );
    }

    #[test]
    fn preserves_the_attempt_chain_after_a_controlled_failure() {
        let operations = FakeWindowActivationOps::new(Some("focus_webview"), true, false);

        let steps = execute_window_activation_steps(Ok(()), &operations);

        assert_eq!(steps.len(), 7);
        assert_eq!(steps[4].stage, "focus_webview");
        assert_eq!(
            steps[4].error.as_deref(),
            Some("injected focus_webview failure")
        );
        assert_eq!(steps[6].stage, "verify_focused");
        assert_eq!(
            steps[6].error.as_deref(),
            Some("window did not become focused")
        );
        assert_eq!(
            operations.calls.into_inner(),
            vec![
                "show",
                "unminimize",
                "focus_window",
                "focus_webview",
                "verify_visible",
                "verify_focused",
            ]
        );
    }
}
