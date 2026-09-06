import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  sanitizeAgentResponseTextForDisplay,
  sanitizeAgentStreamingTextForDisplay,
} from '../src/lib/agentResponseDelivery';
import { containsInternalExecutionLanguage } from '../shared/public_execution_language';

const root = process.cwd();
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
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

  it('applies the shared sanitizer at every secondary assistant surface', () => {
    const surfaces = [
      'src/components/ChatPanel.tsx',
      'src/hooks/useMemoryAvatarConversation.ts',
      'src/components/org/CentralLumiChat.tsx',
      'src/hooks/useVoiceCall.ts',
      'src/components/ProactiveNotifications.tsx',
    ];

    for (const relativePath of surfaces) {
      expect(source(relativePath), relativePath).toContain('sanitizeAgentResponseTextForDisplay');
    }

    expect(source('src/components/ChatPanel.tsx')).toMatch(
      /onMessages[\s\S]*sanitizeAgentResponseTextForDisplay[\s\S]*onResponse[\s\S]*sanitizeAgentResponseTextForDisplay[\s\S]*onProgress[\s\S]*sanitizeAgentResponseTextForDisplay/,
    );
    expect(source('src/components/ChatPanel.tsx')).toContain(
      "const streamingPublicText = sanitizeAgentStreamingTextForDisplay(streamingText, isZh ? 'zh' : 'en')",
    );
    expect(source('src/components/AgentChatPage.tsx')).toMatch(
      /onChunk[\s\S]*streamingRawTextRef[\s\S]*sanitizeAgentStreamingTextForDisplay\(rawText[\s\S]*onError[\s\S]*sanitizeAgentResponseTextForDisplay/,
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
