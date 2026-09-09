import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { isCapabilityLearningRecordVerified, isCapabilityLearningRecordUsable, upsertCapabilityLearningRecord, type CapabilityLearningRecord } from '../server/self_extension/capability_memory';

describe('learned routes reflect current failure and current tools', () => {
  beforeAll(async () => { await initDatabase(); });
  function learned(): Omit<CapabilityLearningRecord, 'id' | 'createdAt' | 'updatedAt'> {
    return { userId: 'learning-current', scopeDomain: 'personal', orgId: '', domain: 'synthetic', goal: 'read synthetic source',
      status: 'learned', selectedRoute: { id: 'synthetic.read', label: 'Synthetic reader', interfacePattern: 'native_api', preferredTools: ['synthetic_read'], fallbackTools: [], avoid: [], reason: 'test', confirmationRequired: [] },
      planReadiness: 'use_existing', existingTools: ['synthetic_read'],
      nextUse: { triggerHints: ['synthetic'], preferredTools: ['synthetic_read'], firstStep: 'read', reportRule: 'observed facts only' },
      experiment: { status: 'passed', summary: 'verified once', toolCalls: [], artifacts: [], verification: [{ label: 'result observed', passed: true, detail: 'synthetic receipt' }] }, safety: [] };
  }
  it('stops reusing a formerly verified route after the latest experiment fails', () => {
    const first = upsertCapabilityLearningRecord(learned());
    expect(isCapabilityLearningRecordVerified(first)).toBe(true);
    const failed = upsertCapabilityLearningRecord({ ...learned(), id: first.id, status: 'experiment_failed', experiment: { ...first.experiment, status: 'blocked', verification: [{ label: 'current attempt', passed: false, detail: 'adapter failed' }] } });
    expect(failed.id).toBe(first.id);
    expect(failed.status).toBe('experiment_failed');
    expect(isCapabilityLearningRecordVerified(failed)).toBe(false);
  });
  it('requires the route tools to be currently available', () => {
    const record = upsertCapabilityLearningRecord(learned());
    expect(isCapabilityLearningRecordUsable(record, [])).toBe(false);
    expect(isCapabilityLearningRecordUsable(record, ['unrelated'])).toBe(false);
    expect(isCapabilityLearningRecordUsable(record, ['synthetic_read'])).toBe(true);
  });
});
