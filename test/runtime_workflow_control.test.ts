import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { cancelRuntimeWork, getRuntimeWorkSnapshot, pauseRuntimeWork } from '../server/runtime/work_control';
import {
  createWorkflowDefinitionDraft, publishWorkflowDefinition, createWorkflowRun,
  getWorkflowRun, claimWorkflowRun, blockWorkflowRun, requestWorkflowCancel,
} from '../server/workflows/runtime';

describe('workflow runs share runtime work controls', () => {
  beforeAll(async () => { await initDatabase(); });
  const userId = 'workflow-runtime-controls';
  function createRun(title: string, domain: 'personal' | 'work' = 'personal') {
    const draft = createWorkflowDefinitionDraft({
      userId, title, scope: { domain, orgId: domain === 'work' ? 'org-a' : '' },
      steps: [{ stepId: 'observe', capabilityId: 'fake_read' }],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const definition = publishWorkflowDefinition({ userId, workflowId: draft.workflowId, version: draft.version, expectedHash: draft.hash });
    return createWorkflowRun({ userId, workflowId: definition.workflowId, version: definition.version });
  }

  it('shows the same run id and organization, and rejects cancellation from another scope', () => {
    const run = createRun('Organization workflow', 'work');
    expect(getRuntimeWorkSnapshot(userId, undefined, { domain: 'work', orgId: 'org-a' }).items)
      .toContainEqual(expect.objectContaining({ id: run.runId, kind: 'workflow', title: 'Organization workflow', phase: 'queued' }));
    expect(cancelRuntimeWork({ userId, taskId: run.runId, scope: { domain: 'personal' } }).targetResults)
      .toEqual([{ taskId: run.runId, status: 'not_found' }]);
    expect(cancelRuntimeWork({ userId, taskId: run.runId, scope: { domain: 'work', orgId: 'org-a' } }).cancelledTaskIds)
      .toEqual([run.runId]);
    expect(getWorkflowRun(run.runId, userId)?.status).toBe('cancelled');
  });

  it('distinguishes queued pause from a running cancellation waiting for its checkpoint', () => {
    const paused = createRun('Pause me');
    expect(pauseRuntimeWork({ userId, taskId: paused.runId })).toMatchObject({ ok: true, status: 'paused', pausedCount: 1 });
    const running = createRun('Cancel at checkpoint');
    claimWorkflowRun({ userId, runId: running.runId, expectedRevision: running.revision, owner: 'test-worker' });
    expect(cancelRuntimeWork({ userId, taskId: running.runId })).toMatchObject({ ok: true, cancellingCount: 1, cancelledCount: 0 });
    expect(getRuntimeWorkSnapshot(userId, ['workflow']).items.find(item => item.id === running.runId))
      .toMatchObject({ phase: 'cancelling', evidence: { terminal: false }, controls: { canCancel: false } });
  });
  it('keeps unresolved cancellation visible as blocked rather than permanently active', () => {
    let run = createRun('Unknown old result');
    run = blockWorkflowRun({ userId, runId: run.runId, expectedRevision: run.revision, actor: 'test', reason: 'Unknown receipt', kind: 'unknown_outcome' });
    requestWorkflowCancel({ userId, runId: run.runId, expectedRevision: run.revision, actor: 'test' });
    expect(getWorkflowRun(run.runId, userId)).toMatchObject({ status: 'blocked', reconciliationRequired: true });
    expect(getRuntimeWorkSnapshot(userId, ['workflow']).items.find(item => item.id === run.runId)).toMatchObject({ phase: 'blocked', cancellationRequested: true });
  });
});
