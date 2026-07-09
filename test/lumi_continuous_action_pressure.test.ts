import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs } from '../server/agents/nl_chainer';
import { buildActionContract, type LumiActionContractKind } from '../server/cognition/action_contract';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';

function declaration(name: string, description = name) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

function buildDeclarations() {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return [
    ...registry.getToolDeclarations(),
    ...[
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'mcp_playwright_browser_fill_form',
      'mcp_playwright_browser_type',
      'desktop_mouse_click_at',
      'desktop_cursor_glow_show',
      'desktop_cursor_glow_update',
      'desktop_cursor_glow_click',
      'desktop_cursor_glow_hide',
      'desktop_keyboard_press',
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_kline',
      'mcp_stockbot_market_index',
      'mcp_stockbot_hot_sectors',
      'mcp_stockbot_stock_news',
      'mcp_stockbot_stock_trade_plan',
      'mcp_stockbot_paper_portfolio',
      'mcp_cad-drafting_cad_space_program',
      'mcp_cad-drafting_cad_renovation_folder_workflow',
    ].map(name => declaration(name)),
  ];
}

function evaluate(text: string, options: { channel?: 'chat' | 'voice' | 'task'; userId?: string } = {}) {
  const channel = options.channel || 'chat';
  const dispatch = buildLumiTurnDispatch({
    userId: options.userId || `continuous_${channel}`,
    text,
    channel,
    source: channel,
    operationMode: 'autonomous',
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text,
    toolDeclarations: buildDeclarations(),
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text,
  });
  return {
    contract: buildActionContract(text),
    dispatch,
    execution,
    selection,
    route: execution.toolRoute,
  };
}

describe('Lumi continuous real-action pressure', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps consecutive real-action turns on specific high-level tools without cross-turn leakage', () => {
    const cases: Array<{
      id: string;
      text: string;
      kind: LumiActionContractKind;
      categories: string[];
      earlyTools: string[];
      forbiddenEarlyTools?: string[];
    }> = [
      {
        id: 'read-alu',
        text: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
        kind: 'messaging_read',
        categories: ['messaging'],
        earlyTools: ['wechat_read_recent_chat'],
        forbiddenEarlyTools: ['wechat_send_message'],
      },
      {
        id: 'send-zhangsan',
        text: '\u5fae\u4fe1\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a',
        kind: 'messaging_send',
        categories: ['messaging'],
        earlyTools: ['wechat_send_message', 'desktop_mouse_click_at'],
      },
      {
        id: 'send-lisi',
        text: '\u53d1\u7ed9\u674e\u56db\u300c\u6211\u5230\u4e86\u300d',
        kind: 'messaging_send',
        categories: ['messaging'],
        earlyTools: ['wechat_send_message'],
      },
      {
        id: 'browser-login',
        text: '\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55\u6dd8\u5b9d\u540e\u53f0',
        kind: 'browser_account',
        categories: ['authenticated_web'],
        earlyTools: ['web_login_run', 'browser_open_task'],
        forbiddenEarlyTools: ['wechat_send_message'],
      },
      {
        id: 'video-comment',
        text: '\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba\u8fd9\u4e2a\u89c6\u9891',
        kind: 'public_post',
        categories: ['public_post'],
        earlyTools: ['browser_open_task', 'mcp_playwright_browser_snapshot'],
        forbiddenEarlyTools: ['wechat_send_message'],
      },
      {
        id: 'cad',
        text: 'CAD\u81ea\u52a8\u753b\u56fe',
        kind: 'cad_drafting',
        categories: ['cad_design'],
        earlyTools: ['cad_generate_dxf', 'cad_generate_autocad_draw_script'],
      },
      {
        id: 'legal',
        text: '\u5f8b\u5e08\u7684\u4ee3\u7406\u8bcd',
        kind: 'legal_document',
        categories: ['legal'],
        earlyTools: ['legal_analyze_folder_and_draft_argument', 'legal_generate_argument_or_opinion'],
      },
      {
        id: 'stock-watch',
        text: '\u5e2e\u6211\u6301\u7eed\u76ef\u76d8 600519\uff0c\u6709\u5f02\u52a8\u63d0\u9192\u6211',
        kind: 'stock_monitor',
        categories: ['market_finance'],
        earlyTools: ['mcp_stockbot_stock_quote', 'autonomy_register_workflow'],
        forbiddenEarlyTools: ['wechat_send_message'],
      },
    ];

    for (const item of cases) {
      const result = evaluate(item.text, { userId: `continuous_${item.id}` });
      const early = result.route?.toolNames.slice(0, 10) || [];

      expect(result.contract.kind, item.id).toBe(item.kind);
      expect(result.dispatch.boundary, item.id).toBe('tool_action');
      expect(result.execution.allowToolUse, item.id).toBe(true);
      expect(result.selection.lane, item.id).not.toBe('conversation');
      expect(result.route?.categories, item.id).toEqual(expect.arrayContaining(item.categories));
      expect(early, item.id).toEqual(expect.arrayContaining(item.earlyTools));
      for (const tool of item.forbiddenEarlyTools || []) {
        expect(early, `${item.id}:${tool}`).not.toContain(tool);
      }
      expect(result.execution.toolPolicy.requireConfirmation || [], item.id).not.toContain('wechat_send_message');
    }

    expect(buildForegroundWeChatReadArgs(cases[0].text)).toMatchObject({
      contact: '\u963f\u9646',
      useSearch: true,
    });
    expect(buildForegroundWeChatSendArgs(cases[1].text)).toMatchObject({
      contact: '\u5f20\u4e09',
      message: '\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a',
      useVirtualCursor: true,
    });
    expect(buildForegroundWeChatSendArgs(cases[2].text)).toMatchObject({
      contact: '\u674e\u56db',
      message: '\u6211\u5230\u4e86',
    });
    expect(buildForegroundWeChatSendArgs('\u76f4\u63a5\u53d1\u660e\u5929\u89c1')).toMatchObject({
      contact: '',
      message: '\u660e\u5929\u89c1',
    });
  });

  it('keeps chat and voice on the same foreground send path', () => {
    const text = '\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89';
    const chat = evaluate(text, { channel: 'chat', userId: 'continuous_chat_send' });
    const voice = evaluate(text, { channel: 'voice', userId: 'continuous_voice_send' });

    expect(chat.contract.kind).toBe('messaging_send');
    expect(voice.contract.kind).toBe('messaging_send');
    expect(chat.selection.lane).toBe('messaging');
    expect(voice.selection.lane).toBe('messaging');
    expect(chat.route?.toolNames.slice(0, 6)).toEqual(expect.arrayContaining(['wechat_send_message', 'desktop_mouse_click_at']));
    expect(voice.route?.toolNames.slice(0, 6)).toEqual(expect.arrayContaining(['wechat_send_message', 'desktop_mouse_click_at']));
  });

  it('does not let one quote masquerade as an ongoing stock watch', () => {
    const quoteRecord = {
      id: 'quote_1',
      name: 'mcp_stockbot_stock_quote',
      arguments: { code: '600519' },
      result: '{"code":"600519","price":1182.19,"dataSource":"tencent","timestamp":"2026-07-10T03:50:00+08:00"}',
    };

    const blocked = finalizeLumiResponse({
      taskText: '\u5e2e\u6211\u6301\u7eed\u76ef\u76d8 600519\uff0c\u6709\u5f02\u52a8\u63d0\u9192\u6211',
      responseText: '\u5df2\u7ecf\u5f00\u59cb\u6301\u7eed\u76ef\u76d8 600519\u3002',
      source: 'chat',
      toolRecords: [quoteRecord],
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain('continuous stock watch');

    const oneShot = finalizeLumiResponse({
      taskText: '\u67e5\u4e00\u4e0b 600519 \u5f53\u524d\u884c\u60c5',
      responseText: '\u5df2\u7ecf\u67e5\u5230\u5f53\u524d\u884c\u60c5\u3002',
      source: 'chat',
      toolRecords: [quoteRecord],
    });
    expect(oneShot.blocked).toBe(false);

    const workflow = finalizeLumiResponse({
      taskText: '\u5e2e\u6211\u6301\u7eed\u76ef\u76d8 600519\uff0c\u6709\u5f02\u52a8\u63d0\u9192\u6211',
      responseText: '\u5df2\u7ecf\u5f00\u59cb\u6301\u7eed\u76ef\u76d8 600519\u3002',
      source: 'chat',
      toolRecords: [
        quoteRecord,
        {
          id: 'workflow_1',
          name: 'autonomy_register_workflow',
          arguments: { title: '600519 \u76ef\u76d8\u63d0\u9192' },
          result: '{"workflow":{"title":"600519 watch alert","enabled":true},"note":"monitoring workflow scheduled"}',
        },
      ],
    });
    expect(workflow.blocked).toBe(false);
  });
});
