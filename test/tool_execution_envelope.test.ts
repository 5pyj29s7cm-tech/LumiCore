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

  it('persists a verified active document identity when the observation has no target arguments', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        title: 'WPS-Quarterly-Review-Draft.pptx - WPS Office',
        processName: 'wps.exe',
        currentDocument: {
          name: 'WPS-Quarterly-Review-Draft.pptx',
          path: null,
          pathStatus: 'unknown',
        },
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The foreground window was observed.',
      },
    }));

    expect(envelope.status).toBe('verified_success');
    expect(envelope.targetIdentity).toBe('WPS-Quarterly-Review-Draft.pptx');
  });

  it('does not trust an unverified active-window result as a durable target identity', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'desktop_active_window',
      arguments: {},
      result: JSON.stringify({ title: 'Unverified private title' }),
      terminalVerification: {
        status: 'unverified',
        strategy: 'terminal_receipt',
        reason: 'No signed desktop observation was available.',
      },
    }));

    expect(envelope.targetIdentity).toBe('');
    expect(envelope.status).toBe('failed');
  });

  it('ignores caller-supplied targets for active-window observations', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'desktop_active_window',
      arguments: { target: 'Forged-Target.pptx' },
      result: JSON.stringify({
        ok: true,
        processName: 'wps.exe',
        currentDocument: {
          name: 'Observed-Target.pptx',
          path: null,
          pathStatus: 'unknown',
        },
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Native active-window result verified.',
      },
    }));

    expect(envelope.targetIdentity).toBe('Observed-Target.pptx');
  });

  it('does not persist an unknown or generic active-window path', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'get_active_window_info',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        path: 'D:\\lumiOS\\entry.cjs',
        documentPath: 'unknown',
        documentPathStatus: 'unknown',
        documentName: 'Observed-Target.pptx',
        title: 'Observed-Target.pptx - WPS Office',
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Native active-window result verified.',
      },
    }));

    expect(envelope.targetIdentity).toBe('Observed-Target.pptx');
  });

  it('does not derive an identity from a semantically failed active-window receipt', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'desktop_active_window',
      arguments: { target: 'Forged-Target.pptx' },
      result: JSON.stringify({
        ok: false,
        status: 'not_found',
        title: 'Stale-Target.pptx - WPS Office',
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Transport returned a signed terminal receipt.',
      },
    }));

    expect(envelope.targetIdentity).toBe('');
    expect(envelope.status).toBe('failed');
  });

  it('derives one deterministic target identity from the exact runtime cleanup task set', () => {
    const first = buildToolExecutionEnvelope(successfulRecord({
      name: 'runtime_work_cancel',
      arguments: { taskIds: ['task-b', 'task-a', 'task-b'] },
    }));
    const reordered = buildToolExecutionEnvelope(successfulRecord({
      name: 'runtime_work_cancel',
      arguments: { taskIds: ['task-a', 'task-b'] },
    }));

    expect(first.targetIdentity).toMatch(
      /^runtime_work_cancel:taskIds:sha256:[a-f0-9]{64}:count:2$/u,
    );
    expect(reordered.targetIdentity).toBe(first.targetIdentity);
  });

  it.each([
    { taskIds: [] },
    { taskIds: [''] },
    { taskIds: ['task-a', 7] },
    { taskIds: 'task-a' },
  ])('does not invent a runtime cleanup target for invalid or empty taskIds: %j', argumentsValue => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'runtime_work_cancel',
      arguments: argumentsValue as any,
    }));

    expect(envelope.targetIdentity).toBe('');
  });

  it('does not treat taskIds as a generic target for another tool', () => {
    const envelope = buildToolExecutionEnvelope(successfulRecord({
      name: 'runtime_work_status',
      arguments: { taskIds: ['task-a'] },
    }));

    expect(envelope.targetIdentity).toBe('');
  });
});
