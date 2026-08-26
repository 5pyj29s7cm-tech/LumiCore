import { describe, expect, it } from 'vitest';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';
import type { ToolExecutionRecord } from '../server/tools/types';

function successfulRecord(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'internal_status_read',
    arguments: {},
    result: JSON.stringify({ ok: true, status: 'completed' }),
    ...overrides,
  };
}

describe('tool execution envelope terminal verification invariant', () => {
  it.each([
    ['without a capability', undefined],
    ['when verification is optional', {
      capabilityId: 'internal.status.read',
      lane: 'local',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'none',
        required: false,
        limitations: [],
      },
    }],
  ] as const)('does not promote an explicitly unverified result %s', (_description, capability) => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      capability,
      terminalVerification: {
        status: 'unverified',
        strategy: 'terminal_receipt',
        reason: 'The returned state could not be verified.',
      },
    }));

    expect(envelope.status).toBe('failed');
    expect(envelope.verification).toEqual({
      status: 'unverified',
      basis: 'terminal_verification',
      reason: 'The returned state could not be verified.',
    });
  });

  it.each([
    ['without a capability', undefined],
    ['when verification is optional', {
      capabilityId: 'internal.status.read',
      lane: 'local',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'none',
        required: false,
        limitations: [],
      },
    }],
  ] as const)('keeps compatibility success distinct from verified evidence when terminal verification is absent %s', (_description, capability) => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({ capability }));

    expect(envelope.status).toBe('verified_success');
    expect(envelope.verification).toEqual({
      status: 'unverified',
      basis: 'compatibility_inference',
      reason: 'Successful result recorded without explicit terminal verification.',
    });
  });

  it('marks an explicit verified terminal receipt as machine verification', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The live state was read back successfully.',
      },
    }));

    expect(envelope.status).toBe('verified_success');
    expect(envelope.verification).toEqual({
      status: 'verified',
      basis: 'terminal_verification',
      reason: 'The live state was read back successfully.',
    });
  });
});
