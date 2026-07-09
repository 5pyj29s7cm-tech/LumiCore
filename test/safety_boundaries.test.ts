import { describe, expect, it } from 'vitest';
import { evaluateMemoryFirewall } from '../server/memory/firewall';
import {
  canAutoApproveAction,
  classifyAction,
  classifyActionRisk,
  evaluateActionConstitution,
} from '../server/tools/action_constitution';
import { ToolRegistry } from '../server/tools/registry';

describe('global Memory Firewall', () => {
  it('tags ordinary personal memories as private long-term memories', () => {
    const decision = evaluateMemoryFirewall({
      userId: 'u1',
      content: 'User likes direct answers.',
      source: 'chat',
    });

    expect(decision.accepted).toBe(true);
    expect(decision.metadata.source).toBe('chat');
    expect(decision.metadata.privacyClass).toBe('private');
    expect(decision.metadata.retention).toBe('long_term');
  });

  it('blocks core identity without explicit approval', () => {
    const decision = evaluateMemoryFirewall({
      userId: 'u1',
      content: 'This should become permanent identity.',
      tier: 'core_identity',
      source: 'manual',
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('core_identity');
  });

  it('blocks external long-term memory without approval', () => {
    const decision = evaluateMemoryFirewall({
      userId: 'u1',
      content: 'A community Lumi says the user prefers a new workflow.',
      source: 'community',
      retention: 'long_term',
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('community');
  });
});

describe('Action Constitution', () => {
  it('classifies risky action domains', () => {
    expect(classifyAction('web_search')).toBe('network');
    expect(classifyAction('write_file')).toBe('local_write');
    expect(classifyAction('computer_use')).toBe('desktop_control');
    expect(classifyAction('wechat_send_message')).toBe('messaging');
    expect(classifyAction('install_skill')).toBe('local_write');
    expect(classifyAction('mcp_playwright_browser_click')).toBe('external_app');
    expect(classifyAction('desktop_run_command')).toBe('system');
    expect(classifyAction('desktop_show_lumi_window')).toBe('observe');
    expect(classifyAction('desktop_idle_time')).toBe('observe');
    expect(classifyAction('desktop_poll_activity')).toBe('observe');
    expect(classifyAction('mouse_click')).toBe('desktop_control');
    expect(classifyAction('keyboard_type')).toBe('desktop_control');
  });

  it('upgrades safe local writes to confirmation', () => {
    const decision = evaluateActionConstitution('write_file', { path: 'notes.txt' }, 'safe');
    expect(decision.level).toBe('confirm');
    expect(decision.requiresUserConfirmation).toBe(true);
  });

  it('forbids destructive generic commands', () => {
    const decision = evaluateActionConstitution('desktop_run_command', { command: 'rm -rf C:\\important' }, 'confirm');
    expect(decision.level).toBe('forbidden');
  });

  it('requires confirmation for package installs, git mutations, and external send surfaces', () => {
    const gitPush = evaluateActionConstitution('desktop_run_command', { command: 'git push origin main' }, 'safe');
    expect(gitPush.level).toBe('confirm');
    expect(classifyActionRisk('desktop_run_command', { command: 'git push origin main' })).toBe('high');

    const npmInstall = evaluateActionConstitution('run_command', { command: 'npm install left-pad' }, 'safe');
    expect(npmInstall.level).toBe('confirm');
    expect(classifyActionRisk('run_command', { command: 'npm install left-pad' })).toBe('high');

    const wechatOpen = evaluateActionConstitution('desktop_open', { target: 'wechat.exe' }, 'safe');
    expect(wechatOpen.level).toBe('confirm');
    expect(classifyActionRisk('desktop_open', { target: 'wechat.exe' })).toBe('high');

    const browserSubmit = evaluateActionConstitution('mcp_playwright_browser_click', { name: 'Submit payment' }, 'safe');
    expect(browserSubmit.level).toBe('confirm');
    expect(classifyActionRisk('mcp_playwright_browser_click', { name: 'Submit payment' })).toBe('high');
  });

  it('limits trusted auto-approval to lower-risk actions', () => {
    expect(canAutoApproveAction('write_file', { path: 'notes.txt' })).toBe(true);
    expect(canAutoApproveAction('desktop_open', { target: 'calc.exe' })).toBe(false);
    expect(canAutoApproveAction('desktop_run_command', { command: 'git commit -m test' })).toBe(false);
    expect(canAutoApproveAction('wechat_copy_reply_draft', { openWechat: true })).toBe(false);
    expect(canAutoApproveAction('install_skill', { directory: 'D:\\tmp\\skill' })).toBe(false);
  });

  it('does not execute constitution-upgraded tools without confirmation callback', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'Write a file',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => 'wrote',
    });

    await expect(registry.execute('write_file', { path: 'x.txt' })).rejects.toThrow(/requires user confirmation/);
  });

  it('does not execute default confirm tools without confirmation callback', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'desktop_run_command',
      description: 'Run a command',
      parameters: {},
      permission: 'user',
      securityLevel: 'confirm',
      handler: async () => 'ran',
    });

    await expect(registry.execute('desktop_run_command', { command: 'whoami' })).rejects.toThrow(/requires user confirmation/);
  });

  it('does not execute confirmed tools when the user declines', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'desktop_open',
      description: 'Open something',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => 'opened',
    });

    await expect(registry.execute('desktop_open', { target: 'calc.exe' }, {
      requestConfirmation: async () => false,
    })).resolves.toContain('declined by the user');
  });

  it('does not trust model-provided confirmation for sensitive client actions', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'client_action',
      description: 'Client action',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => 'opened',
    });

    await expect(registry.execute('client_action', {
      action: 'start_meeting_mode',
      confirmed: true,
    })).rejects.toThrow(/requires user confirmation/);
  });

  it('passes real registry confirmation to confirmed tools', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'client_action',
      description: 'Client action',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async (_args, context) => context?.userConfirmed ? 'confirmed' : 'unconfirmed',
    });

    await expect(registry.execute('client_action', {
      action: 'set_wallpaper_mode',
      enabled: true,
      confirmed: false,
    }, {
      requestConfirmation: async () => true,
    })).resolves.toBe('confirmed');
  });
});
