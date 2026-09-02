import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { assessVoiceTranscriptForExecution } from '../server/cognition/voice_transcript_guard';

describe('voice transcript execution guard', () => {
  it('clarifies the repeated device-prompt contamination observed in the real voice log', () => {
    expect(assessVoiceTranscriptForExecution(
      'The terminal is set for recording on device. 请一组四组桌面操作。 The terminal.',
    )).toMatchObject({
      action: 'clarify',
      reason: 'device_prompt_contamination',
    });
  });

  it.each([
    '打开 Terminal，然后运行 npm test',
    '用 PowerShell 执行 git status 并告诉我结果',
    'Please open the terminal and run npm test',
    '把 “The terminal is set for recording on device” 翻译成中文',
    '解释一下 The terminal is set for recording on device. The terminal.',
  ])('allows legitimate bilingual or quoted terminal language: %s', text => {
    expect(assessVoiceTranscriptForExecution(text)).toEqual({ action: 'allow' });
  });

  it.each([
    '帮我打开',
    '请执行一下',
    '打开微信然后',
    'please delete',
  ])('asks for the missing target of an unmistakably incomplete action: %s', text => {
    expect(assessVoiceTranscriptForExecution(text)).toMatchObject({
      action: 'clarify',
      reason: 'truncated_action',
    });
  });

  it.each([
    '你',
    '桌面',
    '为什么失败',
    '帮我打开微信',
    '播放《秋天不回来》',
    '他不是。',
  ])('does not turn ordinary short speech into a false safety block: %s', text => {
    expect(assessVoiceTranscriptForExecution(text)).toEqual({ action: 'allow' });
  });

  it('wires clarification ahead of active-work routing and disables tool admission', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    const activeWorkGuard = source.indexOf("transcriptExecutionGuard.action === 'clarify'", source.indexOf('session.lastAcceptedCommandKey'));
    const activeWorkRouter = source.indexOf('classifyActiveVoiceWorkInput(', activeWorkGuard);
    expect(activeWorkGuard).toBeGreaterThan(0);
    expect(activeWorkRouter).toBeGreaterThan(activeWorkGuard);
    expect(source).toContain("cognitiveIntent: 'voice_transcript_clarification'");
    expect(source).toContain("const requestedToolSession = transcriptExecutionGuard.action === 'clarify'");
    expect(source).toContain("source: 'voice_transcript_guard'");

    const directClarification = source.indexOf("source: 'voice_transcript_guard'");
    const deterministicResponse = source.indexOf('const deterministicConversationResponse =', directClarification);
    const isolatedWorkflow = source.indexOf('const specialWorkflow =', directClarification);
    expect(directClarification).toBeGreaterThan(0);
    expect(deterministicResponse).toBeGreaterThan(directClarification);
    expect(isolatedWorkflow).toBeGreaterThan(directClarification);
  });

  it('binds voice execution-fact questions to the immediately preceding request and current task', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    const start = source.indexOf('const deterministicConversationResponse =');
    const end = source.indexOf('if (deterministicConversationResponse)', start);
    const block = source.slice(start, end);

    expect(block).toContain('getConversationExecutionFacts({');
    expect(block).toContain('currentRequestId: requestId');
    expect(block).toContain('taskId: actionTaskExecution.state?.taskId');
    expect(block).toContain('conversationTurn.conversation.actionContinuationState?.taskId');
  });
});
