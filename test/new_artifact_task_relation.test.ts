import './helpers';
import { describe, expect, it } from 'vitest';
import { classifyExecutionGuardIntent } from '../server/cognition/execution_guard_recovery';
import {
  resolveActiveTaskMessageRelation,
} from '../server/cognition/task_concurrency';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';

const artifactPath = 'C:\\isolated-lumi-test\\stale-live-owner.txt';
const artifactPrompts = [
  `[LUMI_REGRESSION:S4:LIVE] Write the exact text "stale receipt live-owner sentinel" to ${artifactPath}. Call write_file exactly once. Do not report task status. Stop when confirmation is required.`,
  `[LUMI_REGRESSION:S4:LIVE] Start a separate isolated task by creating ${artifactPath}. You must call write_file exactly once and stop at the confirmation boundary.`,
] as const;

const activeState: ConversationActionContinuationState = {
  version: 2,
  taskId: 'old-task',
  status: 'executing',
  latestInstruction: 'Finish the older task.',
  goal: 'Finish the older task.',
  appTarget: '',
  sourcePaths: [],
  latestBlocker: '',
  unfinished: true,
  evidenceTools: [],
  assistantState: '',
  toolSummaries: [],
  revision: 3,
  activeRequestId: 'old-request',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const completedState: ConversationActionContinuationState = {
  ...activeState,
  status: 'completed',
  unfinished: false,
  activeRequestId: undefined,
  revision: 4,
};

describe('new artifact task relation', () => {
  it.each(artifactPrompts)(
    'does not bind a concrete file mutation to an active older task: %s',
    text => {
      expect(resolveActiveTaskMessageRelation(text, activeState, {
        activeRequestId: 'old-request',
      })).toMatchObject({
        relation: 'queue',
        taskRelation: 'new',
        feedback: 'new_task',
        binding: 'new_task',
        operation: 'enqueue',
        preservesRootGoal: false,
      });
    },
  );

  it.each(artifactPrompts)(
    'does not turn a concrete file mutation into previous-task status after completion: %s',
    text => {
      expect(resolveActiveTaskMessageRelation(text, completedState)).toMatchObject({
        relation: 'queue',
        taskRelation: 'new',
        feedback: 'new_task',
        binding: 'new_task',
        operation: 'enqueue',
      });
    },
  );

  it('preserves genuine status and conditional continuation semantics', () => {
    expect(resolveActiveTaskMessageRelation("what's the result?", completedState)).toMatchObject({
      relation: 'status',
      taskRelation: 'status',
      feedback: 'status',
      binding: 'previous_task',
    });
    expect(resolveActiveTaskMessageRelation(
      'Check the task status; if unfinished, retry it.',
      activeState,
      { activeRequestId: 'old-request' },
    )).toMatchObject({
      relation: 'continue',
      taskRelation: 'continue',
      feedback: 'continue',
      binding: 'active_task',
    });
  });

  it('lets explicit side effects outrank status nouns only inside the execution guard', () => {
    expect(classifyExecutionGuardIntent(artifactPrompts[0])).toBe('action_execution');
    expect(classifyExecutionGuardIntent(artifactPrompts[1])).toBe('action_execution');
    expect(classifyExecutionGuardIntent('What is the task status?')).toBe('status_query');
    expect(classifyExecutionGuardIntent('Check the task status; if unfinished, retry it.'))
      .toBe('action_execution');
  });
});
