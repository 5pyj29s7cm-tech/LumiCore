import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildForegroundWeChatSendArgs, shouldChainTask } from '../server/agents/nl_chainer';

describe('chat and voice tool-call stability', () => {
  it('keeps text and voice on the shared routing and desktop execution path', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const task = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');

    for (const source of [chat, voice, task]) {
      expect(source).toContain('buildLumiTurnDispatch');
      expect(source).toContain('buildLumiExecutionDecision');
      expect(source).toContain('buildLumiCapabilitySelection');
      expect(source).toContain('buildDesktopExecutionStabilityPolicy');
      expect(source).toContain('actuationTools: desktopExecutionPolicy.actuationTools');
      expect(source).toContain('toolPolicy');
      expect(source).toContain('requestConfirmation');
      expect(source).toContain('supervisedExternalCommits');
    }
  });

  it('keeps voice tool execution visible and aligned with chat permission behavior', () => {
    const voice = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');

    expect(voice).toContain('shouldAllowVoiceLocalFileWriteForTurn');
    expect(voice).toContain('allowLocalFileWrites');
    expect(voice).toContain('localWriteIntentReason');
    expect(voice).toContain('emitToolLifecycle');
    expect(voice).toContain('socket.emit("agent:tool"');
    expect(voice).toContain('onProgress');
  });

  it('routes short foreground WeChat send follow-ups into the task chain', () => {
    expect(shouldChainTask('\u76f4\u63a5\u53d1\u665a\u5b89')).toBe(true);
    expect(shouldChainTask('\u5fae\u4fe1\u5e2e\u6211\u7f16\u8f91\u4e00\u6761\u665a\u5b89\u53d1\u7ed9\u963f\u9646')).toBe(true);
  });

  it('keeps foreground WeChat sends on the dedicated chat fast path', () => {
    const args = buildForegroundWeChatSendArgs('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');
    expect(args).toMatchObject({
      contact: '\u963f\u9646',
      applicationTarget: 'wechat',
      useVirtualCursor: true,
    });
    expect(String(args?.message || '')).toContain('\u665a\u5b89');

    const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chat).toContain('buildForegroundWeChatSendArgs');
    expect(chat).toContain("const toolName = 'wechat_send_message'");
    expect(chat).toContain('buildRecentFailureExplanation');
    expect(chat).toContain('recent_failure_explanation');
  });
});
