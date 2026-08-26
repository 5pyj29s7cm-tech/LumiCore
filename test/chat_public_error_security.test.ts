import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatPublicErrorCodeForException,
  sanitizeChatAgentErrorPayload,
} from '../server/socket/chat_public_error';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('chat public terminal errors', () => {
  it('replaces raw exception content and unknown codes with reviewed public fields', () => {
    const payload = sanitizeChatAgentErrorPayload({
      message: 'database failed api_key=sk-private-chat-secret at C:\\private\\db',
      code: 'UNREVIEWED_PRIVATE_CODE',
      stack: 'private stack',
      prompt: 'private prompt',
      toolArguments: { password: 'private-password' },
      sidecar: true,
    });

    expect(payload).toEqual({
      message: 'Lumi could not complete this chat turn. Check the task state before retrying.',
      code: 'CHAT_EXECUTION_FAILED',
      agentName: 'Lumi',
      finalized: true,
      blocked: true,
      reason: 'chat_execution_failed',
      sidecar: true,
    });
    const serialized = JSON.stringify(payload);
    for (const secret of ['sk-private-chat-secret', 'C:\\private\\db', 'private stack', 'private prompt', 'private-password']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps an allowlisted code while still replacing its caller-provided message', () => {
    const payload = sanitizeChatAgentErrorPayload({
      code: 'CHAT_CONTROL_CANCEL_FAILED',
      message: 'authorization: Bearer private-cancel-token',
    });
    expect(payload.code).toBe('CHAT_CONTROL_CANCEL_FAILED');
    expect(payload.message).toContain('could not confirm that cancellation settled');
    expect(JSON.stringify(payload)).not.toContain('private-cancel-token');
  });

  it('turns an exhausted model route into a specific reviewed recovery message', () => {
    const error = Object.assign(new Error('private provider detail'), {
      name: 'ModelRoutingDispatchError',
      routing: {
        attempts: [{ provider: 'deepseek', status: 'failed', error: 'private key detail' }],
      },
    });
    const code = chatPublicErrorCodeForException(error);
    const payload = sanitizeChatAgentErrorPayload({ code, message: error.message });

    expect(code).toBe('CHAT_MODEL_ROUTES_UNAVAILABLE');
    expect(payload.message).toContain('no model is currently available');
    expect(payload.message).toContain('provider balance or health');
    expect(JSON.stringify(payload)).not.toContain('private provider detail');
    expect(JSON.stringify(payload)).not.toContain('private key detail');
  });

  it('normalizes agent:error before durable recording or socket publication', () => {
    const chat = source('server/socket/chat.ts');
    expect(chat).toContain("event === 'agent:error'");
    expect(chat).toContain('sanitizeChatAgentErrorPayload(payload)');
    const terminalBoundary = chat.slice(
      chat.indexOf('const commitDeterministicTerminal'),
      chat.indexOf('const emitConversationUpdated'),
    );
    expect(terminalBoundary.indexOf('normalizeAgentPayload(terminalEvent, input.payload)'))
      .toBeLessThan(terminalBoundary.indexOf('recordChatExecutionTerminalEventDurably('));
  });
});
