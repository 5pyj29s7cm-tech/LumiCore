import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ value: undefined as string | undefined, writes: 0, refuse: false }));
vi.mock('../server/persistence/settings_repository', () => ({
  readSettingRecord: (key: string) => state.value === undefined ? undefined : { key, value: state.value },
  writeSetting: (_key: string, value: string) => { if (state.refuse) throw new Error('storage refused'); state.value = value; state.writes++; },
}));
import { createWorkTakeoverTask, getWorkTakeoverTask, updateWorkTakeoverTask, recordWorkTakeoverStepExecution } from '../server/work_takeover/tasks';
import type { WorkTakeoverExecutionPlan, WorkTakeoverStepExecutionResult } from '../server/work_takeover/execution_planner';
beforeEach(() => { state.value = undefined; state.writes = 0; state.refuse = false; });
function fixture() {
  const task = createWorkTakeoverTask({ userId: 'owner', category: 'general_work', allowedNow: ['existing'] });
  const plan: WorkTakeoverExecutionPlan = { planId: 'plan', generatedAt: new Date().toISOString(), taskId: task.id,
    category: 'general_work', mode: 'prepare_work', objective: 'Prepare local evidence', contextSignals: [],
    safeActions: ['read'], steps: [], capabilities: [], confirmationRequired: [], blockers: [], verificationChecklist: [], handoffPrompt: '' };
  const execution: WorkTakeoverStepExecutionResult = {
    executionId: 'execution', executedAt: new Date().toISOString(), taskId: task.id, planId: plan.planId,
    step: {} as WorkTakeoverStepExecutionResult['step'], status: 'prepared', summary: 'Prepared local evidence',
    artifacts: [1, 2].map(id => ({ type: 'document', label: 'Artifact '+id, content: 'local data', status: 'prepared' })),
    draftReply: 'Prepared reply', suggestedToolCalls: [], confirmationRequired: ['Confirm sending'], blockers: [], nextInstruction: 'Review the packet',
  };
  state.writes = 0;
  return { task, plan, execution };
}
describe('one committed work takeover step', () => {
  it('commits metadata, artifacts and reply together in one revision and one storage write', () => {
    const { task, plan, execution } = fixture();
    const saved = recordWorkTakeoverStepExecution('owner', task, plan, execution);
    expect(state.writes).toBe(1); expect(saved.revision).toBe((task.revision || 0) + 1);
    expect(getWorkTakeoverTask('owner', task.id)).toMatchObject({
      status: 'in_progress', allowedNow: ['existing', 'read'], confirmationRequired: ['Confirm sending'],
      artifacts: [{ label: 'Artifact 1' }, { label: 'Artifact 2' }], drafts: [{ text: 'Prepared reply' }],
      metadata: { workTakeoverExecution: { lastExecution: { executionId: 'execution' }, history: [{ executionId: 'execution' }] } },
    });
  });
  it('does not publish a half-recorded step when its single storage write is refused', () => {
    const { task, plan, execution } = fixture(); const before = state.value; state.refuse = true;
    expect(() => recordWorkTakeoverStepExecution('owner', task, plan, execution)).toThrow('storage refused');
    expect(state.value).toBe(before); expect(state.writes).toBe(0);
    expect(getWorkTakeoverTask('owner', task.id)).toMatchObject({ status: 'queued', artifacts: [], drafts: [] });
  });
  it('merges current guard lists and avoids duplicating a reply added after planning', () => {
    const { task, plan, execution } = fixture();
    const current = updateWorkTakeoverTask('owner', task.id, { allowedNow: ['newer'], confirmationRequired: ['Newer guard'], draftReply: execution.draftReply })!;
    state.writes = 0;
    const saved = recordWorkTakeoverStepExecution('owner', task, plan, execution);
    expect(state.writes).toBe(1); expect(saved.revision).toBe(current.revision! + 1);
    expect(saved.allowedNow).toEqual(['newer', 'read']);
    expect(saved.confirmationRequired).toEqual(['Newer guard', 'Confirm sending']); expect(saved.drafts).toHaveLength(1);
  });
  it('rejects mismatched or cancelled tasks before adding execution artifacts', () => {
    const { task, plan, execution } = fixture();
    expect(() => recordWorkTakeoverStepExecution('other', task, plan, execution)).toThrow('owned task');
    expect(() => recordWorkTakeoverStepExecution('owner', task, plan, { ...execution, taskId: 'foreign' })).toThrow('owned task');
    updateWorkTakeoverTask('owner', task.id, { status: 'cancelled' }); const before = state.value;
    expect(() => recordWorkTakeoverStepExecution('owner', task, plan, execution)).toThrow('terminal');
    expect(state.value).toBe(before); expect(getWorkTakeoverTask('owner', task.id)?.artifacts).toEqual([]);
  });
});
