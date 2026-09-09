import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract } from '../server/tools/capability_contracts';
import { registerWorkTakeoverTools } from '../server/tools/definitions/work_takeover_tools';
import { createWorkTakeoverTask, getWorkTakeoverTask } from '../server/work_takeover/tasks';
import { listTaskEvidenceWorkflowEligibleReceipts, startTaskEvidenceWorkflow, transitionTaskEvidenceWorkflowStep } from '../server/work_takeover/evidence_workflow';
import { cancelRuntimeWork } from '../server/runtime/work_control';

vi.mock('../server/work_takeover/execution_planner', async original => ({
  ...await original<typeof import('../server/work_takeover/execution_planner')>(),
  planWorkTakeoverExecution: () => ({ steps: [{ id: 'observe', suggestedTools: ['synthetic_observe'] }], nextStep: { id: 'observe', suggestedTools: ['synthetic_observe'] } }),
}));
beforeAll(async () => { await initDatabase(); });

function fixture(id: string, handler?: (args: any) => Promise<string>) {
  const registry = new ToolRegistry(); registerWorkTakeoverTools(registry);
  registry.register({
    name: 'synthetic_observe', description: 'Synthetic isolated observation',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: handler || (async args => JSON.stringify({ ok: true, path: args.path })),
    securityLevel: 'safe', permission: 'user',
    capability: capabilityContract({ id: 'synthetic.observe', family: 'test', lane: 'system', operation: 'observe', risk: 'low', sideEffects: [], verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'path'], requiredValues: { ok: true }, successSignals: ['synthetic receipt'], limitations: ['Synthetic isolated receipt.'] } }),
  });
  const userId = `evidence-connection-${id}`;
  const task = createWorkTakeoverTask({ userId, category: 'general_work', title: 'Controlled observation' });
  startTaskEvidenceWorkflow({ userId, taskId: task.id, definitionId: 'observation', blueprints: [{ id: 'observe', stage: 'quick', order: 0, label: 'Observe exact resource', tool: 'synthetic_observe', executionMode: 'automatic', targetIdentity: 'expected-resource' }] });
  transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'observe', status: 'running' });
  return { registry, userId, task, run: registry.get('work_takeover_task_run_suggested_tool')!.handler };
}

describe('suggested tool to evidence ledger production connection', () => {
  it('persists a canonical nested receipt which can complete its exact evidence step', async () => {
    const { userId, task, run } = fixture('matching');
    await run({ id: task.id, toolName: 'synthetic_observe', toolArgs: { path: 'expected-resource' } }, { userId, domain: 'personal' });
    const receipts = listTaskEvidenceWorkflowEligibleReceipts({ userId, taskId: task.id, stepId: 'observe' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ taskId: task.id, targetIdentity: 'expected-resource', outcome: 'verified_success' });
    const completed = transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'observe', status: 'completed', receiptIds: [receipts[0].id] });
    expect(completed.workflow.status).toBe('completed');
    // A second real observation keeps both facts without rebinding the first.
    await run({ id: task.id, toolName: 'synthetic_observe', toolArgs: { path: 'another-resource' } }, { userId, domain: 'personal' });
    expect(listTaskEvidenceWorkflowEligibleReceipts({ userId, taskId: task.id, stepId: 'observe' }).map(receipt => receipt.id)).toEqual([receipts[0].id]);
  });

  it('keeps a same-task different-target result as fact without completing the intended step', async () => {
    const { userId, task, run } = fixture('wrong-target');
    await run({ id: task.id, toolName: 'synthetic_observe', toolArgs: { path: 'another-resource' } }, { userId, domain: 'personal' });
    expect(readDB().conversationActionReceipts.some((row: any) => row.taskId === task.id && row.targetIdentity === 'another-resource')).toBe(true);
    expect(listTaskEvidenceWorkflowEligibleReceipts({ userId, taskId: task.id, stepId: 'observe' })).toEqual([]);
    expect(() => transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'observe', status: 'completed' })).toThrow(/matching verified/);
  });

  it('does not revive a cancelled task when a real nested adapter settles late', async () => {
    let finish!: (value: string) => void;
    const { userId, task, run } = fixture('cancel', () => new Promise(resolve => { finish = resolve; }));
    const pending = run({ id: task.id, toolName: 'synthetic_observe', toolArgs: { path: 'expected-resource' } }, { userId, domain: 'personal' });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    cancelRuntimeWork({ userId, taskId: task.id, kinds: ['takeover'], scope: { domain: 'personal' } });
    finish(JSON.stringify({ ok: true, path: 'expected-resource' }));
    await rejected;
    expect(getWorkTakeoverTask(userId, task.id)).toMatchObject({ status: 'cancelled', artifacts: [] });
    expect(() => transitionTaskEvidenceWorkflowStep({ userId, taskId: task.id, stepId: 'observe', status: 'completed' })).toThrow(/terminal task/);
    const archive = readDB().conversationActionTasks.find((row: any) => row.id === task.id);
    expect(archive.status).toBe('created');
    expect(JSON.parse(archive.context)).toMatchObject({ executionOwner: 'work_takeover', ownerTaskId: task.id });
  });
});
