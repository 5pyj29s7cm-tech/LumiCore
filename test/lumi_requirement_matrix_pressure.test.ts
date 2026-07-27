import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import {
  buildLocalBodyLearningTaskDescription,
  buildPublicWebLearningTaskDescription,
} from '../server/autonomy/task_generator';
import { canAutoApproveAction, evaluateActionConstitution } from '../server/tools/action_constitution';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const MCP_DECLARATION_NAMES = [
  'mcp_playwright_browser_snapshot',
  'mcp_playwright_browser_navigate',
  'mcp_playwright_browser_click',
  'mcp_playwright_browser_fill_form',
  'mcp_playwright_browser_type',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_kline',
  'mcp_stockbot_market_index',
  'mcp_stockbot_hot_sectors',
  'mcp_stockbot_stock_news',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_portfolio',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
];

function mcpDeclaration(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name.replace(/_/g, ' '),
      parameters: { type: 'object', properties: {} },
    },
  };
}

function buildDeclarations() {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  const declarations = registry.getToolDeclarations();
  const existing = new Set(declarations.map(item => item.function.name));
  return [
    ...declarations,
    ...MCP_DECLARATION_NAMES.filter(name => !existing.has(name)).map(mcpDeclaration),
  ];
}

function evaluateTurn(input: {
  text: string;
  userId?: string;
  channel?: 'chat' | 'voice' | 'task';
  operationMode?: 'chat' | 'assistant' | 'autonomous';
}) {
  const dispatch = buildLumiTurnDispatch({
    userId: input.userId || 'requirement_matrix_user',
    text: input.text,
    channel: input.channel || 'chat',
    source: input.channel || 'chat',
    operationMode: input.operationMode || 'assistant',
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text: input.text,
    toolDeclarations: buildDeclarations(),
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text: input.text,
  });
  return {
    contract: buildActionContract(input.text),
    dispatch,
    execution,
    selection,
    route: execution.toolRoute,
  };
}

describe('Lumi requirement matrix pressure', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    await initDatabase();
    saveGateConfig({
      autonomyLevel: 'full',
      autoProcessEnabled: true,
      alwaysOnline: true,
      messagingSendRequiresConfirmation: false,
    });
  });

  it('promotes explicit Chat actions while keeping Assistant and Autonomy execution depths distinct', () => {
    const text = '微信给阿陆发晚安';
    const chat = evaluateTurn({ text, operationMode: 'chat' });
    const assistant = evaluateTurn({ text, operationMode: 'assistant' });
    const autonomous = evaluateTurn({ text, operationMode: 'autonomous' });

    expect(chat.dispatch.flow.autoPromoteToAssistant).toBe(true);
    expect(chat.dispatch.flow.effectiveOperationMode).toBe('assistant');
    expect(chat.dispatch.flow.allowToolUseForTurn).toBe(true);
    expect(chat.execution.allowToolUse).toBe(true);
    expect(chat.execution.toolRoute?.categories).toContain('messaging');
    expect(chat.execution.maxIterations).toBe(assistant.execution.maxIterations);

    for (const result of [chat, assistant, autonomous]) {
      expect(result.dispatch.boundary).toBe('tool_action');
      expect(result.execution.allowToolUse).toBe(true);
      expect(result.selection.lane).toBe('messaging');
      expect(result.route?.toolNames.slice(0, 6)).toContain('wechat_send_message');
      expect(result.selection.preferredTools).toEqual(expect.arrayContaining([
        'wechat_send_message',
        'desktop_mouse_click_at',
        'desktop_cursor_glow_show',
      ]));
      expect(result.execution.toolPolicy.requireConfirmation || []).not.toContain('wechat_send_message');
    }

    expect(assistant.execution.maxIterations).toBeGreaterThanOrEqual(80);
    expect(autonomous.execution.maxIterations).toBeGreaterThan(assistant.execution.maxIterations);
  });

  it('keeps relaxed ordinary actions and hard external boundaries in the same constitution', () => {
    const message = evaluateActionConstitution('wechat_send_message', {
      contact: '阿陆',
      message: '晚安',
    }, 'safe', { source: 'chat' } as any);
    const comment = evaluateActionConstitution('mcp_playwright_browser_click', {
      label: 'submit comment',
    }, 'safe', { source: 'chat' } as any);
    const courtSubmit = evaluateActionConstitution('mcp_playwright_browser_click', {
      label: 'submit court filing and pay fee',
    }, 'safe', { source: 'chat' } as any);
    const realTrade = evaluateActionConstitution('desktop_ui_click', {
      label: 'confirm real buy order with trading password',
    }, 'safe', { source: 'chat' } as any);

    expect(message.requiresUserConfirmation).toBe(true);
    expect(comment.requiresUserConfirmation).toBe(true);
    expect(canAutoApproveAction('wechat_send_message', { message: '晚安' })).toBe(false);

    expect(courtSubmit.requiresUserConfirmation).toBe(true);
    expect(courtSubmit.reason).toContain('High-consequence');
    expect(realTrade.requiresUserConfirmation).toBe(true);
    expect(canAutoApproveAction('desktop_ui_click', { label: 'confirm real buy order' })).toBe(false);
  });

  it('routes the legal work matrix through intake, triad, current-law, external-source, and delivery tools', () => {
    const cases = [
      {
        id: 'plaintiff-packet',
        text: '作为原告，根据身份信息和基础材料生成起诉状、要素式诉状、委托手续一套、立案材料一套、证据目录和证明目的',
        tools: [
          'legal_case_workflow_status',
          'legal_case_reasoning_matrix',
          'legal_generate_litigation_packet',
          'legal_prepare_filing_handoff',
          'legal_finalize_delivery_package',
        ],
      },
      {
        id: 'defendant-response',
        text: '作为被告，根据原告起诉状和证据材料生成答辩状、质证意见和应对策略',
        tools: [
          'legal_case_reasoning_matrix',
          'legal_generate_litigation_packet',
          'legal_generate_argument_or_opinion',
          'legal_finalize_delivery_package',
        ],
      },
      {
        id: 'external-authorities',
        text: '根据案件材料总结争议焦点，并按最高院、高院、中院、基层法院顺序连接人民法院案例库、裁判文书网、法蝉和 Alpha 查找有利案例',
        tools: [
          'legal_extract_dispute_focus',
          'legal_external_research_plan',
          'legal_search_external_authorities',
          'legal_prepare_external_browser_workspace',
        ],
      },
      {
        id: 'remote-notice-link',
        text: '微信/飞书发给 Lumi bot 的法院短信链接自动入案，下载 PDF 并归档到案件工作台',
        tools: [
          'legal_message_intake_to_case',
          'legal_process_notice_link',
          'legal_download_and_extract_document',
          'legal_case_workflow_status',
        ],
      },
      {
        id: 'contract-bid-company',
        text: '审查合同并修改，生成法律意见书，根据招标要求 PDF 自动生成标书，并调用企查查和国家企业信用查询公司股东和涉诉信息',
        tools: [
          'legal_review_contract',
          'legal_generate_bid',
          'legal_company_database_lookup',
          'legal_finalize_delivery_package',
        ],
      },
    ];

    for (const item of cases) {
      const result = evaluateTurn({ text: item.text, userId: `requirement_matrix_${item.id}` });
      expect(result.contract.kind, item.id).toBe('legal_document');
      expect(result.dispatch.boundary, item.id).toBe('tool_action');
      expect(result.selection.lane, item.id).toBe('legal_casework');
      expect(result.route?.categories, item.id).toContain('legal');
      expect(result.route?.toolNames, item.id).toEqual(expect.arrayContaining(item.tools));
      expect(result.execution.promptOverlay, item.id).toContain('Current-law gate');
      expect(result.execution.promptOverlay, item.id).toContain('major premise');
      expect(result.execution.promptOverlay, item.id).toContain('minor premise');
    }
  });

  it('blocks fake legal completion while allowing authorized handoff wording', () => {
    const formalWithoutGate = finalizeLumiResponse({
      taskText: '直接给我一份正式版起诉状',
      responseText: '正式版起诉状已生成，可以直接提交。',
      toolRecords: [],
      source: 'chat',
    });
    const courtFilingClaim = finalizeLumiResponse({
      taskText: '帮我在法院立案网自动立案并提交',
      responseText: '已经在法院立案网完成自动立案提交、签名和缴费。',
      toolRecords: [{
        name: 'legal_prepare_filing_handoff',
        arguments: { caseName: '立案测试案' },
        result: '半自动立案交接单：未自动提交、未签名、未缴费。',
      }],
      source: 'chat',
    });
    const handoff = finalizeLumiResponse({
      taskText: '生成法蝉、Alpha 和裁判文书网检索计划',
      responseText: '已生成授权协作检索行动单，待律师登录法蝉、Alpha 和裁判文书网核验并归档来源。',
      toolRecords: [{
        name: 'legal_external_research_plan',
        arguments: { caseName: '外部检索测试案' },
        result: '外部检索行动单\n授权网页登录协作\n来源登记表',
      }],
      source: 'chat',
    });

    expect(formalWithoutGate.blocked).toBe(true);
    expect(formalWithoutGate.reason).toBe('Missing legal document production evidence.');
    expect(courtFilingClaim.blocked).toBe(true);
    expect(courtFilingClaim.reason).toBe('External legal platform final action requires authorized collaboration.');
    expect(courtFilingClaim.text).toContain('授权协作');
    expect(handoff.blocked).toBe(false);
  });

  it('keeps desktop AI delegation generic instead of tied to WorkBuddy and Codex only', () => {
    const result = evaluateTurn({
      text: '把这个问题发给 WorkBuddy、Codex、ChatGPT、Claude、Gemini 和其它桌面 AI，把回答都拿回来总结',
      userId: 'requirement_matrix_desktop_ai',
    });

    expect(result.dispatch.boundary).toBe('tool_action');
    expect(result.selection.lane).toBe('desktop_control');
    expect(result.route?.categories).toContain('external_control');
    expect(result.route?.toolNames.slice(0, 8)).toEqual(expect.arrayContaining([
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
    ]));
    expect(result.route?.toolNames.indexOf('desktop_ai_ask')).toBeLessThan(
      result.route?.toolNames.indexOf('computer_use') ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps autonomous learning tied to industry habits and local body observation boundaries', () => {
    const web = buildPublicWebLearningTaskDescription([
      '使用者行业习惯画像: industry=legal_casework; commonTools=法蝉, Alpha, 裁判文书网; deliverables=代理词, 起诉状, 法律意见书',
      '用户最近反复提到: 其它桌面 AI/桌面工具目标、AI 客户端',
    ]);
    const localBody = buildLocalBodyLearningTaskDescription([
      '最近活跃应用: Weixin.exe, acad.exe, Code.exe',
      '用户明确要求把本地电脑当 Lumi 的身体学习摸索',
    ]);

    expect(web).toContain('使用者的行业习惯');
    expect(web).toContain('desktop_ai_list_targets');
    expect(web).toContain('desktop_ai_discovery_plan');
    expect(web).toContain('URL');
    expect(web).toContain('不要使用需要登录、付费、验证码、扫码、二次验证或账号授权的页面作为已完成来源');
    expect(web).toContain('不要调用 authority_research_save、desktop_ai_register_target');

    expect(localBody).toContain('本地电脑当作 Lumi 的身体');
    expect(localBody).toContain('desktop_list_apps');
    expect(localBody).toContain('desktop_running_processes');
    expect(localBody).toContain('不要读取文件正文');
    expect(localBody).toContain('不要打开应用');
    expect(localBody).toContain('不要点击');
    expect(localBody).toContain('不要运行命令');
  });
});
