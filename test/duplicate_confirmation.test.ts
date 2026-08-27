import { describe, expect, it } from 'vitest';
import { findAdjacentVerifiedConfirmedAction } from '../server/conversation/duplicate_confirmation';
import type { ToolExecutionRecord } from '../server/tools/types';

function confirmedRecord(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'desktop_write_text_file',
    arguments: { path: 'D:/isolated/result.txt' },
    result: JSON.stringify({ ok: true, verified: true }),
    executionOrigin: 'confirmed_action_resume',
    capability: {
      capabilityId: 'desktop_write_text_file',
      lane: 'files',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'allowlisted file', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok'],
        successSignals: ['exact readback'],
        limitations: [],
      },
    },
    terminalVerification: {
      status: 'verified',
      strategy: 'artifact',
      reason: 'exact readback matched',
    },
    ...overrides,
  };
}

describe('duplicate confirmation transcript evidence', () => {
  it('accepts only the adjacent verified action resumed from confirmation', () => {
    const record = confirmedRecord();
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-repeat',
      messages: [
        { role: 'user', requestId: 'req-original' },
        {
          role: 'assistant',
          requestId: 'req-confirm',
          cognitiveIntent: 'confirmation',
          toolCalls: [record],
        },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBe(record);
  });

  it('rejects a waiting-confirmation record without terminal verification', () => {
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-repeat',
      messages: [
        {
          role: 'assistant',
          cognitiveIntent: 'confirmation',
          toolCalls: [confirmedRecord({
            result: JSON.stringify({ requiresConfirmation: true }),
            terminalVerification: {
              status: 'unverified',
              strategy: 'artifact',
              reason: 'not executed yet',
            },
          })],
        },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBeNull();
  });

  it('rejects model-selected work and non-confirmation assistant turns', () => {
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-repeat',
      messages: [
        {
          role: 'assistant',
          cognitiveIntent: 'confirmation',
          toolCalls: [confirmedRecord({ executionOrigin: 'model_selected' })],
        },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBeNull();
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-repeat',
      messages: [
        {
          role: 'assistant',
          cognitiveIntent: 'task_status',
          toolCalls: [confirmedRecord()],
        },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBeNull();
  });

  it('rejects non-adjacent evidence and a mismatched current request', () => {
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-repeat',
      messages: [
        {
          role: 'assistant',
          cognitiveIntent: 'confirmation',
          toolCalls: [confirmedRecord()],
        },
        { role: 'assistant', cognitiveIntent: 'conversation' },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBeNull();
    expect(findAdjacentVerifiedConfirmedAction({
      currentRequestId: 'req-other',
      messages: [
        {
          role: 'assistant',
          cognitiveIntent: 'confirmation',
          toolCalls: [confirmedRecord()],
        },
        { role: 'user', requestId: 'req-repeat' },
      ],
    })).toBeNull();
  });
});
