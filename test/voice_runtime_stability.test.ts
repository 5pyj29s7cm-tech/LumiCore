import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS,
  estimateModelRequestInputTokens,
  prepareModelRequestContext,
} from '../server/llm/request_context_budget';
import {
  VOICE_DESKTOP_LEASE_WAIT_MS,
  VOICE_MODEL_INPUT_BUDGET_TOKENS,
  canReuseSpeculativeVoiceSpeech,
  resolveVoiceModelInputBudget,
} from '../server/socket/voice_runtime_policy';
import {
  VOICE_CAPTURE_STALL_MS,
  classifyVoiceCaptureHealth,
} from '../src/lib/voiceCaptureRecovery';

describe('live voice runtime stability policy', () => {
  it('recovers an ended, missing, or stalled microphone capture instead of staying silently active', () => {
    const now = 50_000;
    expect(classifyVoiceCaptureHealth({
      callActive: false,
      trackStates: [],
      audioContextState: null,
      lastFrameAt: 0,
      now,
    })).toBe('inactive');
    expect(classifyVoiceCaptureHealth({
      callActive: true,
      trackStates: ['live'],
      audioContextState: 'running',
      lastFrameAt: now - 100,
      now,
    })).toBe('healthy');
    expect(classifyVoiceCaptureHealth({
      callActive: true,
      trackStates: ['live'],
      audioContextState: 'suspended',
      lastFrameAt: now - 100,
      now,
    })).toBe('resume_context');
    expect(classifyVoiceCaptureHealth({
      callActive: true,
      trackStates: ['ended'],
      audioContextState: 'running',
      lastFrameAt: now - 100,
      now,
    })).toBe('restart_capture');
    expect(classifyVoiceCaptureHealth({
      callActive: true,
      trackStates: [],
      audioContextState: 'running',
      lastFrameAt: now - 100,
      now,
    })).toBe('restart_capture');
    expect(classifyVoiceCaptureHealth({
      callActive: true,
      trackStates: ['live'],
      audioContextState: 'running',
      lastFrameAt: now - VOICE_CAPTURE_STALL_MS - 1,
      now,
    })).toBe('restart_capture');
  });

  it('keeps spoken turns below the generic model budget and never waits 30 seconds for desktop control', () => {
    expect(VOICE_MODEL_INPUT_BUDGET_TOKENS).toBeGreaterThanOrEqual(8_192);
    expect(VOICE_MODEL_INPUT_BUDGET_TOKENS).toBeLessThan(DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS);
    expect(VOICE_DESKTOP_LEASE_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(VOICE_DESKTOP_LEASE_WAIT_MS).toBeLessThanOrEqual(5_000);
    expect(resolveVoiceModelInputBudget({ text: '你好', allowToolUse: false }))
      .toBeLessThan(VOICE_MODEL_INPUT_BUDGET_TOKENS);
    expect(resolveVoiceModelInputBudget({ text: '打开桌面文件', allowToolUse: true }))
      .toBe(VOICE_MODEL_INPUT_BUDGET_TOKENS);
    expect(resolveVoiceModelInputBudget({ text: '全面审计整个工作区', allowToolUse: true }))
      .toBe(DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS);
    expect(resolveVoiceModelInputBudget({ text: '仔细的核实主程序和子程序', allowToolUse: true }))
      .toBe(DEFAULT_MODEL_REQUEST_INPUT_BUDGET_TOKENS);
  });

  it('retains the current input, TaskCapsule, and safety boundary under the voice budget', () => {
    const prepared = prepareModelRequestContext({
      messages: [
        {
          role: 'system',
          content: [
            'SECURITY SAFETY execution boundary: never bypass confirmation. SAFETY_RULE_SENTINEL',
            ...Array.from({ length: 180 }, (_, index) => `Noncritical runtime inventory ${index}: ${'details '.repeat(30)}`),
          ].join('\n\n'),
        },
        { role: 'user', content: `obsolete history ${'old '.repeat(8_000)}` },
        {
          role: 'user',
          content: [
            'CURRENT_INPUT_SENTINEL 请继续刚才的任务。',
            'Current task capsule (TaskCapsuleV1): TASK_CAPSULE_SENTINEL; do not repeat receipt-7.',
          ].join('\n'),
        },
      ],
      toolDeclarations: [],
      inputTokenBudget: VOICE_MODEL_INPUT_BUDGET_TOKENS,
    });
    const payload = JSON.stringify(prepared.messages);

    expect(prepared.compacted).toBe(true);
    expect(payload).toContain('CURRENT_INPUT_SENTINEL');
    expect(payload).toContain('TASK_CAPSULE_SENTINEL');
    expect(payload).toContain('SAFETY_RULE_SENTINEL');
    expect(estimateModelRequestInputTokens(prepared.messages, prepared.toolDeclarations))
      .toBeLessThanOrEqual(VOICE_MODEL_INPUT_BUDGET_TOKENS);
  });

  it('does not reuse old speculative audio after a live voice switch', () => {
    expect(canReuseSpeculativeVoiceSpeech({
      preparedVoiceId: 'voice-a',
      currentVoiceId: 'voice-a',
      preparedSwitchGeneration: 4,
      currentSwitchGeneration: 4,
    })).toBe(true);
    expect(canReuseSpeculativeVoiceSpeech({
      preparedVoiceId: 'voice-a',
      currentVoiceId: 'voice-b',
      preparedSwitchGeneration: 4,
      currentSwitchGeneration: 5,
    })).toBe(false);
    expect(canReuseSpeculativeVoiceSpeech({
      preparedVoiceId: 'voice-a',
      currentVoiceId: 'voice-a',
      preparedSwitchGeneration: 4,
      currentSwitchGeneration: 5,
    })).toBe(false);
  });

  it('wires capture recovery, live input-device changes, bounded prompts, and the voice lease deadline', () => {
    const root = process.cwd();
    const hook = fs.readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const voice = fs.readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');

    expect(hook).toContain('classifyVoiceCaptureHealth');
    expect(hook).toContain('captureRecoveryTimerRef');
    expect(hook).toContain("detail?.kind === 'input'");
    expect(voice).toContain('inputTokenBudget: voiceInputTokenBudget');
    expect(voice).toContain('leaseTimeoutMs: VOICE_DESKTOP_LEASE_WAIT_MS');
    expect(voice).toContain('lockVoiceTurnTtsRoute');
    expect(voice).toContain('turnTtsSelection');
  });
});
