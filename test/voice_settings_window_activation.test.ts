import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => fs
  .readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

describe('voice workflow interaction semantics', () => {
  it('renders progress-only cards as status content and keeps the appearance action interactive', () => {
    const panel = source('src/components/DesktopPersonalizationSoundPanel.tsx');

    expect(panel).toContain('<ol');
    expect(panel).toContain('aria-label={voiceIdentityCopy.workflow}');
    expect(panel).toContain("step.id === 'avatar' ? (");
    expect(panel).toContain('data-voice-workflow-action="appearance"');
    expect(panel).toContain('onClick={onOpenAppearance}');
    expect(panel).toContain('data-voice-workflow-status={step.id}');
    expect(panel).toContain('aria-label={`${step.label}: ${statusLabel}`}');
    expect(panel).toContain('`${voiceIdentityCopy.status}: ${statusLabel}`');
    expect(panel).not.toContain("disabled={step.id !== 'avatar'}");
  });
});

describe('native window activation diagnostics', () => {
  it('routes every show/focus entry point through an observable activation pipeline', () => {
    const rust = source('src-tauri/src/lib.rs');
    const pipeline = source('src-tauri/src/window_activation.rs');

    expect(rust).toContain('use window_activation::{execute_window_activation_steps, WindowActivationOps};');
    expect(rust).toContain('fn execute_window_activation<O: WindowActivationOps>');
    expect(pipeline).toContain('pub(crate) trait WindowActivationOps');
    expect(pipeline).toContain('pub(crate) fn execute_window_activation_steps<O: WindowActivationOps>');
    expect(pipeline).toContain('"verify_visible"');
    expect(pipeline).toContain('"verify_focused"');
    expect(rust).toContain('WINDOW_ACTIVATION_DIAGNOSTIC_EVENT');
    expect(rust).toContain('fn get_window_activation_diagnostics(');
    expect(rust).toContain('.manage(Mutex::new(WindowActivationDiagnosticsState::default()))');
    expect(rust).toContain('show_main_window_impl(webview.app_handle(), "page_load")');
    expect(rust).toContain('show_main_window_impl(app, "command_center_shortcut")');
    expect(rust).toContain('show_main_window_impl(app, "single_instance")');
    expect(rust).not.toContain('let _ = show_main_window_impl');
  });

  it('has an injected end-to-end harness that never needs the user window', () => {
    const pipeline = source('src-tauri/src/window_activation.rs');

    expect(pipeline).toContain('struct FakeWindowActivationOps');
    expect(pipeline).toContain('fn reports_success_without_a_real_window()');
    expect(pipeline).toContain('fn preserves_the_attempt_chain_after_a_controlled_failure()');
    expect(pipeline).toContain('Some("focus_webview")');
    expect(pipeline).toContain('assert_eq!(steps.len(), 7)');
  });
});
