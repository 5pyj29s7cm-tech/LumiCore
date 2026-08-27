import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { isRecentActionExplanationQuestion } from '../server/socket/voice_action_history';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

let registry: ToolRegistry;

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registry = new ToolRegistry();
  registerAllTools(registry);
});

function build(text: string, channel: 'chat' | 'voice') {
  return buildLumiExecutionPipeline({
    dispatch: {
      userId: `august-replay-${channel}`,
      text,
      channel,
      source: channel,
      operationMode: 'assistant',
      targetIsLumi: true,
    },
    registry,
    source: channel,
  });
}

function expectTools(text: string, expectedTools: string[]) {
  const chat = build(text, 'chat');
  const voice = build(text, 'voice');

  for (const toolName of expectedTools) {
    expect(chat.execution.toolPolicy.allowedTools, `${text} chat missing ${toolName}`)
      .toContain(toolName);
    expect(voice.execution.toolPolicy.allowedTools, `${text} missing ${toolName}`)
      .toContain(toolName);
    expect(voice.execution.toolPolicy.forbiddenTools, `${text} forbids ${toolName}`)
      .not.toContain(toolName);
  }
}

describe('August 7-8 real voice replay', () => {
  it.each([
    '你现在能帮我做些什么呢？',
    '你现在可以帮我做些什么呢？',
    '我在问你：现在可以帮我做些什么。',
    '你对这份打开的文件有什么想法吗？',
    '我说你对这份打开的文件有什么看法吗？',
    '你昨天到今天为止做了什么事情？',
  ])('does not turn a capability/current-work question into an old-action complaint: %s', text => {
    expect(normalizeActionIntent(text).kind).not.toBe('correction_explanation');
    expect(isRecentActionExplanationQuestion(text)).toBe(false);
  });

  it('routes a desktop directory inspection to the exact read-only desktop tool', () => {
    expectTools('帮我检查下桌面的文件。', ['desktop_list_files']);
  });

  it('routes analysis of the currently open WPS file through exact foreground observation and document reading', () => {
    expectTools('帮我分析一下WPS现在打开的这份文件。', [
      'desktop_active_window',
      'search_files',
      'extract_document_text',
    ]);
    for (const channel of ['chat', 'voice'] as const) {
      const pipeline = build('帮我分析一下WPS现在打开的这份文件。', channel);
      expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('desktop_running_processes');
      expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('desktop_capture_screen');
    }
  });

  it('keeps open-and-present PDF work on desktop plus document tools', () => {
    expectTools('打开Lumi项目介绍文件夹里的Lumi标准介绍PDF，一页一页地向我介绍这个文件。', [
      'desktop_list_files',
      'desktop_open',
      'read_pdf',
      'extract_document_text',
    ]);
  });

  it('gives a requested learning check the real learning and health inspection tools', () => {
    expectTools('跑一轮学习检查。', [
      'capability_learning_list',
      'client_get_state',
      'client_health_check',
    ]);
  });

  it('keeps Lumi wallpaper navigation on the client action route', () => {
    const voice = build('进入壁纸模式。', 'voice');
    expect(voice.execution.toolPolicy.allowedTools).toEqual([
      'client_get_state',
      'client_action',
    ]);
  });

  it('blocks a learning-check promise when the turn produced no tool receipt', () => {
    const result = finalizeLumiResponse({
      taskText: '\u8dd1\u4e00\u8f6e\u5b66\u4e60\u68c0\u67e5\u3002',
      responseText: '\u597d\uff0c\u6211\u73b0\u5728\u8dd1\u4e00\u8f6e\u5b66\u4e60\u68c0\u67e5\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/(?:No successful .* tool execution|without a current-turn tool receipt)/i);
  });
});
