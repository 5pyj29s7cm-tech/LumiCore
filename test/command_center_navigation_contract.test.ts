import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('command center navigation contract', () => {
  it('keeps office chat visible without a floating-window toggle', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    expect(chat).not.toContain('officeChatOpen');
    expect(chat).not.toContain('setOfficeChatOpen');
    expect(chat).toContain("const isCommandCenterUtility = layout === 'command-center' && !isOfficeCommandCenter");
    expect(chat).toContain('isOfficeCommandCenter && (');
    expect(chat).toContain('startNewTextConversation');
    expect(chat).toContain('toggleConversationHistory');
    expect(chat).toContain('restoreTextConversation');
    expect(chat).toContain('<VoiceCallButton');
    expect(chat).toContain('setShowWeChatSettings(true)');
  });

  it('keeps utility views separate from chat and removes the Lumi network surface', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const types = source('src/components/commandCenterTypes.ts');
    expect(chat).toContain('{isCommandCenterUtility && (');
    expect(chat).toContain('{!isCommandCenterUtility && !isOfficeCommandCenter && (');
    expect(chat).not.toContain('lumi-command-center-rail');
    expect(chat).not.toContain('compactCommandCenterOpen');
    expect(panel).not.toContain("onViewChange('network')");
    expect(panel).not.toContain("view === 'network'");
    expect(types).not.toContain("'network'");
  });

  it('returns from an OS core opened by the command center back to the office', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    expect(desktop).toContain("setNexusReturnTarget('command-center')");
    expect(desktop).toContain("if (nexusReturnTarget === 'command-center') openCommandCenter('office')");
  });

  it('hands native window focus to the chat input when the command center opens or returns', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const chat = source('src/components/AgentChatPage.tsx');
    const rust = source('src-tauri/src/lib.rs');
    expect(desktop).toContain('await getCurrentWindow().setFocus()');
    expect(desktop).toContain('await getCurrentWebview().setFocus()');
    expect(desktop).toContain("window.dispatchEvent(new CustomEvent('lumi:focus-command-input'))");
    expect(desktop).toContain("listen('lumi:open-command-center'");
    expect(desktop).toContain("openCommandCenter('office')");
    expect(chat).toContain("window.addEventListener('focus', focusCommandInput)");
    expect(chat).toContain("document.addEventListener('visibilitychange', restoreVisibleCommandInput)");
    expect(chat).toContain("focus({ preventScroll: true })");
    expect(rust).toContain('const COMMAND_CENTER_SHORTCUT: &str = "Ctrl+Shift+Enter"');
    expect(rust).toContain('show_main_window_impl(app, "command_center_shortcut")');
    expect(rust).toContain('fn focus_webview(&self) -> Result<(), String>');
    expect(rust).toContain('webview.set_focus().map_err(|error| error.to_string())');
    expect(rust).toContain('WINDOW_ACTIVATION_DIAGNOSTIC_EVENT');
    expect(rust).toContain('app.emit(COMMAND_CENTER_EVENT, ())');
    expect(rust).toContain('app.global_shortcut().unregister_all()');
  });
});
