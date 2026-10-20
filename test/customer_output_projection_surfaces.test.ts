import { readImplementationSource } from './implementation_source';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  sanitizeAgentResponseTextForDisplay,
  sanitizeAgentStreamingTextForDisplay,
} from '../src/lib/agentResponseDelivery';
import { containsInternalExecutionLanguage } from '../shared/public_execution_language';
import { normalizeChatHistoryRecord } from '../server/socket/chat/history';
import { normalizeVoiceHistoryRecord } from '../server/socket/voice_history';

const root = process.cwd();
const source = (relativePath: string) => readImplementationSource(path.join(root, relativePath), 'utf8');
const code = (relativePath: string) => ts.createPrinter({ removeComments: true }).printFile(
  ts.createSourceFile(relativePath, source(relativePath), ts.ScriptTarget.Latest, true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
);

describe('customer-facing assistant output projection', () => {
  it('keeps ordinary Markdown intact and replaces runtime diagnostics', () => {
    const markdown = '### Result\n\n- **Ready**\n- [Open](https://example.com)';
    expect(sanitizeAgentResponseTextForDisplay(markdown, 'en')).toBe(markdown);

    const projected = sanitizeAgentResponseTextForDisplay([
      'Status: failed.',
      'Evidence: Desktop execution ended as target_mismatch.',
      'Concrete blocker: Desktop target application has not matched a fresh observation.',
    ].join('\n'), 'en');
    expect(projected).toContain('window no longer matched the target');
    expect(projected).not.toMatch(/Status:|Evidence:|Concrete blocker:|target_mismatch|Desktop execution/i);
  });

  it('does not mistake technical identifiers or desktop tool names for leaked status reports', () => {
    const technicalMarkdown = [
      '### 调试说明',
      '',
      '- `requestId` 用于关联同一次请求。',
      '- `taskId` 表示任务，`idempotencyKey` 用于防止重复提交。',
      '- 调用 `desktop_open` 后可以继续查询窗口。',
      '- `terminalVerification` 和 `verificationStatus` 是返回对象中的字段。',
    ].join('\n');

    expect(containsInternalExecutionLanguage(technicalMarkdown)).toBe(false);
    expect(sanitizeAgentResponseTextForDisplay(technicalMarkdown, 'zh')).toBe(technicalMarkdown);

    const codeExample = [
      '```ts',
      "const requestId = 'request-1';",
      "await callTool('desktop_open', { target: 'WPS', taskId, idempotencyKey });",
      '```',
    ].join('\n');
    expect(containsInternalExecutionLanguage(codeExample)).toBe(false);
    expect(sanitizeAgentResponseTextForDisplay(codeExample, 'en')).toBe(codeExample);
  });

  it('still projects explicit recovery codes and structured failure reports', () => {
    for (const diagnostic of [
      'Desktop execution ended as target_mismatch.',
      'Internal execution recovery: execution_recovery_incomplete.',
      '状态：受阻。\n证据：暂时没有可核验的执行结果。\n具体阻塞：后续窗口状态未确认。',
    ]) {
      expect(containsInternalExecutionLanguage(diagnostic), diagnostic).toBe(true);
      const projected = sanitizeAgentResponseTextForDisplay(diagnostic, 'zh');
      expect(projected).not.toBe(diagnostic);
      expect(projected).not.toMatch(/target_mismatch|execution_recovery_incomplete|状态：|证据：|具体阻塞：/u);
    }
  });

  it('buffers a short stream prefix and never flashes an internal report heading', () => {
    expect(sanitizeAgentStreamingTextForDisplay('状态：', 'zh')).toBe('');
    expect(sanitizeAgentStreamingTextForDisplay('Status:', 'en')).toBe('');
    expect(sanitizeAgentStreamingTextForDisplay('这是一条正常但还很短的回复', 'zh')).toBe('');
    expect(sanitizeAgentStreamingTextForDisplay('这是一条已经足够长、可以安全显示给用户阅读的普通流式回复。', 'zh'))
      .toContain('可以安全显示');
    expect(sanitizeAgentStreamingTextForDisplay('状态：受阻。\n证据：暂时没有可核验的执行结果。', 'zh'))
      .not.toMatch(/状态|证据|回执/u);
  });

  it.each(['zh', 'en'] as const)('hides old confirmation instructions in history and every stream prefix (%s)', locale => {
    const old = locale === 'zh'
      ? '这项操作还没有执行，需要你确认后才能继续。\n操作：computer_use\n内容摘要：' + 'a'.repeat(64) + '\n参数：{"task":"把WPS切到前台并等待下一步指令","max_steps":20}'
      : 'Confirmation is required before this action can run.\nAction: computer_use\nPayload digest: ' + 'a'.repeat(64) + '\nArguments: {"task":"Wait for the next model instruction","max_steps":20}';
    const history = sanitizeAgentResponseTextForDisplay(old, locale);
    expect(history).toMatch(/确认|confirm/u);
    expect(history).not.toMatch(/computer_use|max_steps|下一步指令|next model instruction|a{64}/u);
    for (let i = 1; i <= old.length; i += 1) {
      expect(sanitizeAgentStreamingTextForDisplay(old.slice(0, i), locale)).not.toMatch(/computer_use|max_steps|下一步指令|next model instruction|a{64}/u);
    }
  });

  it('projects old confirmation replies into public dialogue without their model instructions', () => {
    const leaked = '这项操作还没有执行，需要你确认后才能继续。\n参数：{"task":"读取WPS并等待下一步模型指令","max_steps":20}';
    for (const normalize of [normalizeChatHistoryRecord, normalizeVoiceHistoryRecord]) {
      expect(normalize({ role: 'assistant', message: leaked })).toEqual([{ role: 'assistant', content: '这项操作还未执行。请先查看本次操作的目标和内容，再回复“确认”或“取消”。' }]);
      expect(normalize({ role: 'user', message: '帮我打印会议安排', response: leaked }))
        .toEqual([{ role: 'user', content: '帮我打印会议安排' }]);
    }
  });

  it('hides tool markup after prose in final, history, voice, and every stream prefix', () => {
    const prose = '我先把客户端当前状态拉出来看一眼，按真实界面给你讲，不凭印象说。\n\n';
    for (const protocol of ['<client_get_state>\n</client_get_state>', '&lt;client_get_state&gt;&lt;/client_get_state&gt;']) {
      const leaked = prose + protocol;
      expect(containsInternalExecutionLanguage(leaked)).toBe(true);
      const projected = sanitizeAgentResponseTextForDisplay(leaked, 'zh');
      expect(projected).not.toMatch(/client_get_state|&lt;|<\//u);
      for (const normalize of [normalizeChatHistoryRecord, normalizeVoiceHistoryRecord]) {
        expect(JSON.stringify(normalize({ role: 'assistant', message: leaked }))).not.toContain('client_get_state');
      }
      for (let i = 1; i <= leaked.length; i += 1) {
        expect(sanitizeAgentStreamingTextForDisplay(leaked.slice(0, i), 'zh')).not.toMatch(/client_get|<client|&lt;client/u);
      }
    }
  });

  it('applies the shared sanitizer at every secondary assistant surface', () => {
    const surfaces = [
      'src/hooks/useMemoryAvatarConversation.ts',
      'src/components/org/CentralLumiChat.tsx',
      'src/hooks/useVoiceCall.ts',
      'src/components/ProactiveNotifications.tsx',
    ];

    for (const relativePath of surfaces) {
      expect(source(relativePath), relativePath).toContain('sanitizeAgentResponseTextForDisplay');
    }
    expect(source('src/components/agent_chat/chat_stream_receivers.ts')).toMatch(
      /onChunk[\s\S]*streamingRawTextRef[\s\S]*sanitizeAgentStreamingTextForDisplay\(rawText/,
    );
    expect(source('src/components/AgentChatPage.tsx')).toMatch(
      /onError[\s\S]*sanitizeAgentResponseTextForDisplay/,
    );
    const territoryConversation = code('src/hooks/useMemoryAvatarConversation.ts');
    expect(territoryConversation).toMatch(
      /memoryAvatarService\.history\(avatarId\)[\s\S]*sanitizeAgentResponseTextForDisplay\(row\.content, locale\)[\s\S]*const response[\s\S]*sanitizeAgentResponseTextForDisplay\(data\.text, locale\)/,
    );
    expect(territoryConversation).toMatch(
      /const chunk[\s\S]*raw\.current\s*\+=[\s\S]*sanitizeAgentStreamingTextForDisplay\(raw\.current, locale\)/,
    );
    expect(territoryConversation).toMatch(
      /const appendVoiceResponse[\s\S]*put\('assistant', sanitizeAgentResponseTextForDisplay\(text, locale\)/,
    );
    expect(source('src/components/org/CentralLumiChat.tsx')).toMatch(
      /normalizeHistoryMessage[\s\S]*sanitizeAgentResponseTextForDisplay[\s\S]*onResponse[\s\S]*sanitizeAgentResponseTextForDisplay/,
    );
    expect(source('src/components/org/CentralLumiChat.tsx')).toMatch(
      /onChunk[\s\S]*streamingRawTextRef[\s\S]*sanitizeAgentStreamingTextForDisplay/,
    );
    expect(source('src/hooks/useVoiceCall.ts')).toMatch(
      /onAgentResponse[\s\S]*sanitizeAgentResponseTextForDisplay[\s\S]*onAudioWorkProgress[\s\S]*sanitizeAgentResponseTextForDisplay/,
    );
    expect(source('src/components/ProactiveNotifications.tsx')).toMatch(
      /handleProactive[\s\S]*sanitizeAgentResponseTextForDisplay[\s\S]*handleAwaySummary[\s\S]*sanitizeAgentResponseTextForDisplay/,
    );
  });

  it('connects the territory UI and recovered private responses to the same projected message stream', () => {
    const territory = code('src/components/Sanctuary.tsx');
    const conversation = code('src/hooks/useMemoryAvatarConversation.ts');
    expect(territory).toMatch(/useMemoryAvatarConversation\(\{ socket, avatarId: avatar\.id, ownerId, locale \}\)/);
    expect(territory).toMatch(/onTranscript: conversation\.appendVoiceTranscript, onResponse: conversation\.appendVoiceResponse/);
    expect(territory).toContain('conversation.send(draft)');
    expect(territory).toMatch(/conversation\.messages\.map\(message[\s\S]*\{message\.text\}/);
    expect(conversation).toMatch(/ownedPendingChatExecutions\([\s\S]*owner\)/);
    expect(conversation).toMatch(/data\?\.requestId === active\.current\.requestId[\s\S]*data\.agentId === avatarId/);
    expect(conversation).toMatch(/socket\.emit\('agent:execution_resume',[\s\S]*requestId: execution\.requestId,[\s\S]*source: owner\.source/);
    expect(conversation).toContain("socket?.on('agent:response', response)");
    expect(conversation).toContain("socket?.off('agent:response', response)");
  });
});
