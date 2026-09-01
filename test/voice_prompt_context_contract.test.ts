import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('voice provider prompt contract', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'server/socket/voice.ts'),
    'utf8',
  );

  it('uses chat personality for a pure conversation and task personality only for execution', () => {
    expect(source).toContain("mode: requestedToolSession ? 'task' : 'chat'");
    expect(source).not.toContain("{ mode: 'task', sensory: sensoryAudio, uiContext: 'voice' }");
  });

  it('keeps tool planning in the adapter instead of a stale voice tool manual', () => {
    expect(source).not.toContain('toolVoiceOverlay');
    expect(source).not.toContain('GENERIC_TOOL_PLANNING_PROMPT');
    expect(source).not.toContain('## Your Tools');
    expect(source).not.toContain('**desktop_run_command**');
  });

  it('binds sourceMessageId to only the durable user utterance', () => {
    expect(source).toContain("{ role: 'user', content: userText, sourceMessageId: voiceUserMessageId }");
    expect(source).not.toContain("{ role: 'user', content: routedUserText, sourceMessageId: voiceUserMessageId }");
    expect(source).toContain('actionContinuationOverlay');
    expect(source).toContain('pendingConfirmationOverlay');
  });

  it('uses the minimal required schema subset and buffers action candidates', () => {
    expect(source).toContain('resolveRequiredToolNamesForModel(');
    expect(source).toContain('protectedToolNames: requiredToolNames');
    expect(source).toContain('localRequiredToolNames: requiredToolNames');
    expect(source).toContain('bufferStreamUntilCandidateSuccess: toolSessionActive');
    expect(source).not.toContain('protectedToolNames: toolDeclarations.map');
    expect(source).not.toContain('localRequiredToolNames: toolDeclarations.map');
  });
});
