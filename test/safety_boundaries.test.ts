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
    expect(classifyAction('desktop_ai_list_targets')).toBe('observe');
    expect(classifyAction('desktop_ai_discovery_plan')).toBe('observe');
    expect(classifyAction('desktop_ai_register_target')).toBe('local_write');
    expect(classifyAction('mouse_click')).toBe('desktop_control');
    expect(classifyAction('keyboard_type')).toBe('desktop_control');
    expect(classifyAction('cad_generate_dxf')).toBe('local_write');
    expect(classifyAction('cad_generate_autocad_draw_script', { launchAutoCAD: true })).toBe('desktop_control');
    expect(classifyAction('cad_run_autocad_draw_script')).toBe('desktop_control');
    expect(classifyAction('desktop_run_command', { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\me\\Desktop\\plan_run_autocad.ps1"' })).toBe('desktop_control');
  });

  it('uses the original task intent to classify a raw coordinate click', () => {
    const args = { x: 820, y: 640 };
    expect(classifyActionRisk('desktop_mouse_click_at', args)).toBe('medium');
    expect(classifyActionRisk('desktop_mouse_click_at', args, {
      actionIntent: '在券商客户端确认买入100股并提交订单',
    })).toBe('high');
    expect(canAutoApproveAction('desktop_mouse_click_at', args, {
      actionIntent: '在法院立案网提交立案材料',
    })).toBe(false);
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

  it('requires confirmation for package installs, git mutations, and high-consequence external commits', () => {
    const gitPush = evaluateActionConstitution('desktop_run_command', { command: 'git push origin main' }, 'safe');
    expect(gitPush.level).toBe('confirm');
    expect(classifyActionRisk('desktop_run_command', { command: 'git push origin main' })).toBe('high');

    const npmInstall = evaluateActionConstitution('run_command', { command: 'npm install left-pad' }, 'safe');
    expect(npmInstall.level).toBe('confirm');
    expect(classifyActionRisk('run_command', { command: 'npm install left-pad' })).toBe('high');

    const wechatOpen = evaluateActionConstitution('desktop_open', { target: 'wechat.exe' }, 'safe');
    expect(wechatOpen.level).toBe('safe');
    expect(classifyActionRisk('desktop_open', { target: 'wechat.exe' })).toBe('medium');

    const browserSubmit = evaluateActionConstitution('mcp_playwright_browser_click', { name: 'Submit payment' }, 'safe');
    expect(browserSubmit.level).toBe('confirm');
    expect(classifyActionRisk('mcp_playwright_browser_click', { name: 'Submit payment' })).toBe('high');

    const legalFile = evaluateActionConstitution('mcp_playwright_browser_click', { name: 'File case with court' }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(legalFile.level).toBe('confirm');
    expect(classifyActionRisk('mcp_playwright_browser_click', { name: 'File case with court' })).toBe('high');
  });

  it('keeps low and medium desktop control quiet unless the action is high-risk', () => {
    const openApp = evaluateActionConstitution('desktop_open', { target: 'calc.exe' }, 'safe');
    expect(openApp.level).toBe('safe');
    expect(openApp.requiresUserConfirmation).toBe(false);

    const mouseClick = evaluateActionConstitution('mouse_click', { button: 'left' }, 'safe');
    expect(mouseClick.level).toBe('safe');
    expect(mouseClick.requiresUserConfirmation).toBe(false);

    const uiType = evaluateActionConstitution('desktop_ui_type', { name: 'Search', text: 'hello' }, 'safe');
    expect(uiType.level).toBe('safe');
    expect(uiType.requiresUserConfirmation).toBe(false);

    const publishClick = evaluateActionConstitution('desktop_ui_click', { name: 'Publish' }, 'safe');
    expect(publishClick.level).toBe('confirm');
    expect(publishClick.requiresUserConfirmation).toBe(true);

    const supervisedPublishClick = evaluateActionConstitution('desktop_ui_click', { name: 'Publish comment' }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(supervisedPublishClick.level).toBe('safe');
    expect(supervisedPublishClick.requiresUserConfirmation).toBe(false);
  });

  it('does not prompt for messaging drafts or clipboard handoff before sending', () => {
    const draft = evaluateActionConstitution('wechat_prepare_reply', {
      context: 'Customer asked for the quote.',
      intent: 'prepare a helpful reply draft',
    }, 'safe');
    expect(draft.level).toBe('safe');
    expect(draft.requiresUserConfirmation).toBe(false);

    const copyDraft = evaluateActionConstitution('wechat_copy_reply_draft', {
      draft: 'Thanks, I will check and get back to you.',
      openWechat: true,
    }, 'safe');
    expect(copyDraft.level).toBe('safe');
    expect(copyDraft.requiresUserConfirmation).toBe(false);

    const send = evaluateActionConstitution('wechat_send_message', {
      text: 'Thanks, I will check this.',
    }, 'safe');
    expect(send.level).toBe('confirm');
    expect(send.requiresUserConfirmation).toBe(true);

    const supervisedSend = evaluateActionConstitution('wechat_send_message', {
      text: 'Thanks, I will check this.',
    }, 'safe', {
      source: 'voice',
      supervisedExternalCommits: true,
    });
    expect(supervisedSend.level).toBe('safe');
    expect(supervisedSend.requiresUserConfirmation).toBe(false);
    expect(classifyActionRisk('wechat_send_message', { text: 'Thanks' })).toBe('medium');
  });

  it('treats an explicit court-document transfer as messaging rather than a court filing', () => {
    const transfer = evaluateActionConstitution('wechat_send_file', {
      filePath: 'D:\\cases\\法院开庭通知.pdf',
    }, 'safe', {
      source: 'feishu_bot',
      actionIntent: '把这份法院开庭通知附件发给我的微信',
      supervisedExternalCommits: true,
    });
    expect(transfer).toMatchObject({
      level: 'safe',
      domain: 'messaging',
      requiresUserConfirmation: false,
    });

    const filing = evaluateActionConstitution('mcp_playwright_browser_click', {
      name: '提交法院立案',
    }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(filing.level).toBe('confirm');
  });

  it('allows supervised video comments while keeping payment submission gated', () => {
    const comment = evaluateActionConstitution('mcp_playwright_browser_click', {
      name: 'Submit comment',
      platform: 'youtube',
    }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(comment.level).toBe('safe');
    expect(comment.requiresUserConfirmation).toBe(false);
    expect(classifyActionRisk('mcp_playwright_browser_click', { name: 'Submit comment' })).toBe('medium');

    const payment = evaluateActionConstitution('mcp_playwright_browser_click', {
      name: 'Submit payment',
      platform: 'checkout',
    }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(payment.level).toBe('confirm');
    expect(payment.requiresUserConfirmation).toBe(true);
  });

  it('allows authorized web login reuse while keeping credential and verification boundaries', () => {
    const presets = evaluateActionConstitution('web_login_site_presets', { category: 'legal' }, 'safe');
    expect(presets.level).toBe('safe');
    expect(presets.requiresUserConfirmation).toBe(false);

    const presetProfile = evaluateActionConstitution('web_login_profile_save_from_preset', {
      presetId: 'court_cases',
    }, 'safe');
    expect(presetProfile.level).toBe('safe');
    expect(presetProfile.requiresUserConfirmation).toBe(false);

    const runSavedProfile = evaluateActionConstitution('web_login_run', {
      profileId: 'court_cases',
    }, 'safe');
    expect(runSavedProfile.level).toBe('safe');
    expect(runSavedProfile.requiresUserConfirmation).toBe(false);
    expect(classifyActionRisk('web_login_run', { profileId: 'court_cases' })).toBe('medium');
    expect(canAutoApproveAction('web_login_run', { profileId: 'court_cases' })).toBe(true);

    const authenticatedFetch = evaluateActionConstitution('url_fetch_logged_in', {
      profileId: 'court_cases',
      url: 'https://example.com/case',
    }, 'safe');
    expect(authenticatedFetch.level).toBe('safe');
    expect(authenticatedFetch.requiresUserConfirmation).toBe(false);

    const savePassword = evaluateActionConstitution('web_login_profile_save_from_preset', {
      presetId: 'court_cases',
      username: 'lawyer',
      password: 'secret',
    }, 'safe');
    expect(savePassword.level).toBe('confirm');
    expect(savePassword.requiresUserConfirmation).toBe(true);
    expect(canAutoApproveAction('web_login_profile_save_from_preset', {
      presetId: 'court_cases',
      password: 'secret',
    })).toBe(false);

    const learnNewSite = evaluateActionConstitution('web_login_learn_site', {
      url: 'https://example.com/login',
    }, 'safe');
    expect(learnNewSite.level).toBe('confirm');
    expect(learnNewSite.requiresUserConfirmation).toBe(true);
  });

  it('allows stock watching and paper trading while gating real brokerage orders', () => {
    const quote = evaluateActionConstitution('mcp_stockbot_stock_quote', {
      code: '600519',
    }, 'safe');
    expect(quote.level).toBe('safe');
    expect(quote.requiresUserConfirmation).toBe(false);
    expect(classifyActionRisk('mcp_stockbot_stock_quote', { code: '600519' })).toBe('low');

    const watchApp = evaluateActionConstitution('desktop_open', {
      target: 'stock watch app',
    }, 'safe');
    expect(watchApp.level).toBe('safe');
    expect(watchApp.requiresUserConfirmation).toBe(false);
    expect(classifyActionRisk('desktop_open', { target: 'stock watch app' })).toBe('medium');

    const paperTrade = evaluateActionConstitution('mcp_stockbot_paper_trade', {
      side: 'buy',
      code: '600519',
      quantity: 100,
    }, 'safe');
    expect(paperTrade.level).toBe('safe');
    expect(paperTrade.requiresUserConfirmation).toBe(false);

    const realBuy = evaluateActionConstitution('desktop_ui_click', {
      name: 'Buy order',
      target: 'brokerage trading screen',
    }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(realBuy.level).toBe('confirm');
    expect(realBuy.requiresUserConfirmation).toBe(true);
    expect(classifyActionRisk('desktop_ui_click', { name: 'Buy order' })).toBe('high');

    const cancelOrder = evaluateActionConstitution('desktop_ui_click', {
      name: '撤单',
    }, 'safe', {
      source: 'chat',
      supervisedExternalCommits: true,
    });
    expect(cancelOrder.level).toBe('confirm');
    expect(cancelOrder.requiresUserConfirmation).toBe(true);
  });

  it('allows explicit CAD file generation and visible CAD playback while keeping production review separate', () => {
    const dxf = evaluateActionConstitution('cad_generate_dxf', {
      title: 'draft_floor_plan',
      width: 12000,
      height: 8000,
    }, 'confirm', {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'User requested a DXF deliverable',
    });
    expect(dxf.level).toBe('safe');
    expect(dxf.requiresUserConfirmation).toBe(false);

    const runCad = evaluateActionConstitution('cad_generate_autocad_draw_script', {
      title: 'visible_playback',
      width: 12000,
      height: 8000,
      launchAutoCAD: true,
    }, 'safe', {
      allowLocalFileWrites: true,
    });
    expect(runCad.level).toBe('safe');
    expect(runCad.requiresUserConfirmation).toBe(false);

    const playback = evaluateActionConstitution('cad_run_autocad_draw_script', {
      scriptPath: 'C:\\Users\\me\\Desktop\\plan.scr',
      launch: true,
    }, 'safe');
    expect(playback.level).toBe('safe');
    expect(playback.requiresUserConfirmation).toBe(false);
  });

  it('limits trusted auto-approval to lower-risk actions', () => {
    expect(canAutoApproveAction('write_file', { path: 'notes.txt' })).toBe(true);
    expect(canAutoApproveAction('desktop_open', { target: 'calc.exe' })).toBe(true);
    expect(canAutoApproveAction('desktop_run_command', { command: 'git commit -m test' })).toBe(false);
    expect(canAutoApproveAction('wechat_copy_reply_draft', { openWechat: true })).toBe(true);
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

  it('does not execute high-risk constitution-confirmed tools when the user declines', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'desktop_ui_click',
      description: 'Click something',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async () => 'clicked',
    });

    await expect(registry.execute('desktop_ui_click', { name: 'Submit payment' }, {
      requestConfirmation: async () => false,
    })).resolves.toContain('requires user confirmation');
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

  it('uses an explicit foreground user request as authorization without a second popup', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'client_action',
      description: 'Client action',
      parameters: {},
      permission: 'user',
      securityLevel: 'safe',
      handler: async (_args, context) => context?.userConfirmed ? 'authorized' : 'explicit-intent',
    });

    await expect(registry.execute('client_action', {
      action: 'start_meeting_mode',
    }, {
      actionIntent: '开始会议模式，记录这次沟通',
      source: 'chat',
    })).resolves.toBe('explicit-intent');

    await expect(registry.execute('client_action', {
      action: 'set_wallpaper_mode',
      enabled: true,
    }, {
      actionIntent: '进入壁纸模式继续工作',
      source: 'voice',
    })).resolves.toBe('explicit-intent');
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
