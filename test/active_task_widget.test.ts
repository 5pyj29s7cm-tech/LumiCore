import { describe, expect, it } from 'vitest';
import { selectActiveTaskWidgetState } from '../src/components/ActiveTaskWidget';

function task(status: string) {
  return {
    taskId: 'task-1',
    goal: 'Prepare the client report',
    target: 'client-report.pdf',
    status,
    blocker: '',
    evidence: { total: 2, verified: 1, failed: 0, unknown: 0, latest: [] },
  } as any;
}

function select(input: Record<string, unknown> = {}) {
  return selectActiveTaskWidgetState({
    status: null,
    focusThreads: [],
    backgroundTasks: [],
    workflowActive: false,
    workflowStatus: 'idle',
    progressText: '',
    fallbackTitle: 'Lumi is working',
    ...input,
  } as any);
}

describe('active task widget', () => {
  it('stays hidden when there is no active task', () => {
    expect(select().visible).toBe(false);
    expect(select({ status: { tasks: [task('completed')] } }).visible).toBe(false);
    expect(select({ status: { tasks: [task('blocked')] } }).visible).toBe(false);
  });

  it('shows planning, executing, and confirmation tasks from the durable ledger', () => {
    for (const status of ['planning', 'executing', 'waiting_confirmation']) {
      const view = select({ status: { tasks: [task(status)] } });
      expect(view).toMatchObject({
        visible: true,
        title: 'Prepare the client report',
        status,
        receiptTotal: 2,
        verifiedReceipts: 1,
      });
    }
  });

  it('shows transient tool execution and hides ordinary chat thinking', () => {
    expect(select({ workflowActive: false, workflowStatus: 'thinking' }).visible).toBe(false);
    expect(select({
      workflowActive: true,
      workflowStatus: 'executing',
      progressText: 'Opening the requested application',
    })).toMatchObject({
      visible: true,
      status: 'executing',
      detail: 'Opening the requested application',
    });
  });

  it('shows active background work without keeping completed work visible', () => {
    expect(select({ backgroundTasks: [{ id: 'bg-1', title: 'Research', status: 'running' }] }).visible).toBe(true);
    expect(select({ backgroundTasks: [{ id: 'bg-1', title: 'Research', status: 'completed' }] }).visible).toBe(false);
  });

  it('deduplicates the same durable task across ledger and focus projections', () => {
    const view = select({
      status: { tasks: [task('executing')] },
      focusThreads: [{ taskId: 'task-1', goal: 'Prepare the client report', status: 'executing' }],
    });
    expect(view.activeCount).toBe(1);
  });
});
