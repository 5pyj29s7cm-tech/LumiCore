import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
