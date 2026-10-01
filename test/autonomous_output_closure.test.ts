import './helpers';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractSourceExpression } from './source_expression';
import { isCurrentScopeRequest } from '../src/components/scopeRequestGuard';
import { normalizeTaskCompletionFeedback } from '../src/components/workflowTypes';
import { describe, expect, it } from 'vitest';
import {
  evaluateAutonomousTaskOutcome,
  finalizeAutonomousTaskOutcomeForDelivery,
  isSuccessfulAutonomousToolRecord,
  projectAutonomousCompletionFeedback,
  projectAutonomousCustomerMessage,
} from '../server/autonomy/task_executor';
import { isVerifiedAutonomousHistoryItem } from '../server/socket/ambient';
import { finalizeScheduledDelivery } from '../server/scheduler';
import {
  autonomousTaskCustomerSummary,
  isVerifiedAutonomousCompletionPayload,
  normalizeAutonomousHistoryTask,
  mergeAutonomousTasks,
} from '../src/components/AutonomousFeed';

describe('remaining output bypass closure', () => {
  it.each(['completed', 'failed', 'cancelled', 'unverified'] as const)('keeps %s task feedback scoped while sharing terminal updates', status => {
    const file = fileURLToPath(new URL('../src/components/AutonomousFeed.tsx', import.meta.url));
    let tasks: any[] = [{ id: 'current', status: 'running' }, { id: 'other', status: 'running' }];
    let active = true; const notifications: any[] = [];
    const deps: any = { normalizeTaskCompletionFeedback, autonomousTaskCustomerSummary, isVerifiedAutonomousCompletionPayload,
      locale: 'en', uiMessage: (value: string) => value, eventIsCurrent: () => active,
      setTasks: (update: any) => { tasks = update(tasks); }, mergeAutonomousTasks, revisionRef: { current: 0 },
      addNotification: (value: any) => notifications.push(value) };
    for (const name of ['recordTask', 'recordTerminalTask', 'recordFailedTask', 'onCompleted', 'onCancelled']) deps[name] = extractSourceExpression(file, name, deps);
    const event = { taskId: 'current', title: 'Task', timestamp: '2026-10-01', result: 'Done', toolCallsCount: 1, tokensUsed: 2,
      finalized: true, blocked: false, verified: status !== 'unverified' };
    const handler = deps[status === 'cancelled' ? 'onCancelled' : status === 'failed' ? 'recordFailedTask' : 'onCompleted'];
    active = false; handler(event); expect(tasks.every(task => task.status === 'running')).toBe(true); expect(tasks).toHaveLength(2);
    active = true; handler(event); handler(event);
    expect(tasks.filter(task => task.status === 'running').map(task => task.id)).toEqual(['other']);
    expect(tasks).toHaveLength(2); expect(tasks.find(task => task.id === 'current').status).toBe(status === 'unverified' ? 'failed' : status);
    expect(notifications.length).toBe(status === 'cancelled' ? 0 : 2);
    if (status !== 'cancelled') expect(notifications[0].type).toBe(status === 'completed' ? 'success' : 'warning');
  });

  it('preserves terminal events over in-flight refreshes and rejects older refreshes and scopes', async () => {
    const file = fileURLToPath(new URL('../src/components/AutonomousFeed.tsx', import.meta.url));
    let tasks: any[] = [], loading = false;
    const requests: Array<(data: any) => void> = [], errors: string[] = [];
    const deps: any = { scopeKey: 'personal:', activeScopeKeyRef: { current: 'personal:' }, scopeGenerationRef: { current: 1 },
      revisionRef: { current: 0 }, loadSequenceRef: { current: 0 }, isCurrentScopeRequest, mergeAutonomousTasks, normalizeAutonomousHistoryTask,
      setTasks: (update: any) => { tasks = update(tasks); }, setLoading: (value: boolean) => { loading = value; },
      setLoadError: () => {}, toast: { error: (message: string) => errors.push(message) },
      apiFetch: () => new Promise(resolve => requests.push(data => resolve({ ok: true, json: async () => data }))) };
    const recordTask = extractSourceExpression(file, 'recordTask', deps), loadTasks = extractSourceExpression(file, 'loadTasks', deps);
    const live = { id: 'current', title: 'Task', status: 'running' }, completed = { ...live, status: 'completed', result: 'done',
      toolCallsCount: 1, finalized: true, verified: true, blocked: false };
    const pending = loadTasks();
    recordTask(completed);
    requests[0]({ queue: [live, { ...live, id: 'server-only' }] }); requests[1]({ tasks: [] }); await pending;
    expect(tasks.find(task => task.id === 'current').status).toBe('completed');
    expect(tasks.some(task => task.id === 'server-only')).toBe(true); expect(loading).toBe(false);
    // A delayed cancel acknowledgement must not replace a newer terminal event.
    recordTask({ ...live, status: 'cancelling' }, 0);
    expect(tasks.find(task => task.id === 'current').status).toBe('completed');
    const old = loadTasks(), fresh = loadTasks();
    requests[4]({ queue: [] }); requests[5]({ tasks: [completed] }); await fresh;
    requests[2]({ queue: [live] }); requests[3]({ tasks: [] }); await old;
    expect(tasks.map(task => task.id)).toEqual(['current']); expect(tasks[0].status).toBe('completed');
    const previousScope = loadTasks(); deps.activeScopeKeyRef.current = 'work:other'; deps.scopeGenerationRef.current++;
    tasks = []; requests[6]({ queue: [live] }); requests[7]({ tasks: [completed] }); await previousScope;
    expect(tasks).toEqual([]); expect(errors).toEqual([]);
  });

  it('does not mark autonomous model text complete without successful tool evidence', () => {
    const outcome = evaluateAutonomousTaskOutcome(
      'Open WPS and create a document.',
      'I opened WPS and created the document.',
      [],
    );

    expect(outcome.verified).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.successfulToolRecords).toHaveLength(0);
  });

  it('removes internal finalizer protocol from autonomous user-visible feedback', async () => {
    const internal = 'No successful current-turn tool execution was recorded for that execution-status claim.';
    const delivery = await finalizeAutonomousTaskOutcomeForDelivery(
      'Open WPS and create a document.',
      { text: internal, blocked: true, reason: internal },
      [],
    );

    expect(delivery).toMatchObject({
      blocked: true,
      reason: 'execution_capability_unavailable',
    });
    expect(JSON.stringify(delivery)).not.toMatch(
      /No successful current-turn tool execution|Missing verified in-app UI mutation evidence/u,
    );
    expect(delivery.text).toBe(
      'That step did not finish because no result confirmed the operation. The target can be checked again and work can continue from here.',
    );
    expect(delivery.text).not.toMatch(/Status:|Evidence:|receipt|target_mismatch/iu);
  });

  it('separates autonomous machine diagnostics from public socket copy', () => {
    const targetFailure = projectAutonomousCustomerMessage(
      'Desktop execution ended as target_mismatch. receipt=receipt_private_1 desktop_open failed.',
      { language: 'zh', state: 'failed' },
    );
    expect(targetFailure).toContain('窗口');
    expect(targetFailure).not.toMatch(/target_mismatch|receipt|desktop_open/iu);

    const rawException = projectAutonomousCustomerMessage(
      'Error: ECONNREFUSED 127.0.0.1 requestId=req_private_1',
      { language: 'zh', state: 'failed' },
    );
    expect(rawException).toBe('这项自主任务暂时没有完成。你可以稍后让我重试。');
    expect(rawException).not.toMatch(/ECONNREFUSED|requestId|127\.0\.0\.1/u);

    expect(projectAutonomousCustomerMessage('已整理今天的公开资料摘要。', {
      language: 'zh',
      state: 'completed',
      preserveCleanText: true,
    })).toBe('已整理今天的公开资料摘要。');

    expect(projectAutonomousCompletionFeedback({
      status: 'failed',
      completed: [],
      evidence: ['Verified tool receipt: desktop_open'],
      incomplete: ['Task is not verified complete.'],
      blockers: ['target_mismatch requestId=req_private_1'],
      nextSteps: ['Inspect the receipt ledger.'],
    })).toEqual({
      status: 'failed',
      completed: [],
      evidence: [],
      incomplete: [],
      blockers: [],
      nextSteps: [],
    });
  });

  it('renders one natural autonomous summary while retaining raw state fields', () => {
    const rawTask = {
      status: 'failed' as const,
      error: 'Error: target_mismatch after desktop_open; receipt=receipt_private_1',
      result: 'desktop_open failed',
    };
    expect(rawTask.error).toContain('receipt_private_1');

    const summary = autonomousTaskCustomerSummary(rawTask, 'zh');
    expect(summary).toContain('窗口');
    expect(summary).not.toMatch(/Error:|target_mismatch|desktop_open|receipt/iu);

    const source = fs.readFileSync(
      new URL('../src/components/AutonomousFeed.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('{task.error}');
    expect(source).not.toContain('task.result.slice');
    expect(source).not.toContain('{task.toolCallsCount} tools');
    expect(source).not.toContain('{task.tokensUsed} tokens');
    expect(source).not.toContain('Priority: {task.priority}');
    expect(source).not.toContain('Status: {task.status}');
    expect(source).toContain('autonomousTaskCustomerSummary(task, locale)');
    expect(source).toContain('variant="chat"');
  });

  it('requires successful structured tool receipts and an actually completed response', () => {
    const failedRecord = {
      name: 'web_search',
      arguments: { query: 'current standard' },
      result: JSON.stringify({ status: 'failed', error: 'network unavailable' }),
    };
    expect(isSuccessfulAutonomousToolRecord(failedRecord)).toBe(false);

    const successfulRecord = {
      name: 'web_search',
      arguments: { query: 'current standard' },
      result: JSON.stringify({ status: 'completed', items: [{ url: 'https://example.com' }] }),
    };
    const completed = evaluateAutonomousTaskOutcome(
      'Research the current public standard and summarize the result.',
      'Research completed with a current public source.',
      [successfulRecord],
    );
    expect(completed.verified).toBe(true);
    expect(completed.blocked).toBe(false);

    const incomplete = evaluateAutonomousTaskOutcome(
      'Research two current public standards.',
      'The task is incomplete because the second source was unavailable.',
      [successfulRecord],
    );
    expect(incomplete.verified).toBe(false);
    expect(incomplete.blocked).toBe(true);

    const wrongActionEvidence = evaluateAutonomousTaskOutcome(
      'Open WPS.',
      'I inspected the available desktop applications.',
      [{
        name: 'desktop_list_apps',
        arguments: {},
        result: JSON.stringify([{ name: 'WPS Office' }]),
      }],
    );
    expect(wrongActionEvidence.verified).toBe(false);
    expect(wrongActionEvidence.reason).toContain('desktop_operation');
  });

  it('treats the exact verified self-improvement stage as the autonomous terminal state', () => {
    const task = { id: 'auto-self-improvement-1', idempotencyKey: 'self-improvement:improvement_docs_1:3' };
    const shapedButUnverifiedRecord = {
      id: 'stage-receipt-1',
      name: 'self_improvement_stage_patch',
      arguments: { proposalId: 'improvement_docs_1' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        persisted: true,
        isolated: true,
        activated: false,
        pushed: false,
        proposal: { id: 'improvement_docs_1' },
      }),
    };

    const unverified = evaluateAutonomousTaskOutcome(
      'Improve the authorized static Markdown documentation path.',
      'The patch looks verified in isolation.',
      [shapedButUnverifiedRecord],
      task,
    );
    expect(unverified.verified).toBe(false);

    const commit = 'a'.repeat(40);
    const baseCommit = 'b'.repeat(40);
    const treeDigest = 'c'.repeat(64);
    const repositoryId = 'd'.repeat(64);
    const branch = 'lumi/self-improvement/improvement-docs-1';
    const stageRecord = {
      ...shapedButUnverifiedRecord,
      taskId: task.id,
      idempotencyKey: 'self-improvement-stage-call-1',
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'Exact isolated stage receipt verified.',
      },
      envelope: {
        version: 1 as const,
        status: 'verified_success' as const,
        toolName: 'self_improvement_stage_patch',
        taskId: task.id,
        turnId: 'turn-1',
        requestId: 'request-1',
        idempotencyKey: 'self-improvement-stage-call-1',
        targetIdentity: '',
        completedAt: new Date().toISOString(),
        verification: { status: 'verified' as const, reason: 'verified' },
      },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        persisted: true,
        isolated: true,
        activated: false,
        pushed: false,
        commit,
        treeDigest,
        repositoryId,
        baseCommit,
        branch,
        proposal: {
          id: 'improvement_docs_1',
          status: 'verified',
          stagingProtocol: 'static_git_plumbing_v1',
          taskId: task.id,
          programRevision: 3,
          stagedCommit: commit,
          stagedTreeDigest: treeDigest,
          repositoryId,
          baseCommit,
          stagedBranch: branch,
        },
      }),
    };

    const staged = evaluateAutonomousTaskOutcome(
      'Improve the authorized static Markdown documentation path.',
      'The patch is verified in isolation; activation requires user confirmation.',
      [stageRecord],
      task,
    );
    expect(staged).toMatchObject({ verified: true, blocked: false });

    const wrongProposal = evaluateAutonomousTaskOutcome(
      'Improve the authorized static Markdown documentation path.',
      'The patch is verified in isolation.',
      [{ ...stageRecord, arguments: { proposalId: 'improvement_other' } }],
      task,
    );
    expect(wrongProposal.verified).toBe(false);
    expect(wrongProposal.reason).toContain('exact verified isolated-stage receipt');
  });

  it('withholds model-authored scheduler claims that are not grounded', () => {
    const blocked = finalizeScheduledDelivery('daily_summary', {
      userId: 'scheduler-user',
      message: 'I have already opened WeChat and sent the message.',
      domain: 'personal',
      modelGenerated: true,
    });
    expect(blocked.finalized).toBe(true);
    expect(blocked.blocked).toBe(true);
    expect(blocked.delivery).toBeNull();
    expect(blocked.reason).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(blocked.reason).not.toMatch(/No successful|execution-status claim/u);

    const neutral = finalizeScheduledDelivery('daily_summary', {
      userId: 'scheduler-user',
      message: 'Good morning. It may rain today, so take an umbrella.',
      domain: 'personal',
      modelGenerated: true,
    });
    expect(neutral.finalized).toBe(true);
    expect(neutral.blocked).toBe(false);
    expect(neutral.delivery?.message).toContain('Good morning');
  });

  it('requires verified completion metadata before the autonomous feed shows success', () => {
    const base = {
      taskId: 'auto-1',
      title: 'Research',
      result: 'Verified research result',
      toolCallsCount: 1,
      tokensUsed: 100,
      timestamp: new Date().toISOString(),
    };

    expect(isVerifiedAutonomousCompletionPayload({
      ...base,
      finalized: true,
      blocked: false,
      verified: true,
    })).toBe(true);
    expect(isVerifiedAutonomousCompletionPayload({
      ...base,
      finalized: true,
      blocked: true,
      verified: false,
    })).toBe(false);
    expect(isVerifiedAutonomousCompletionPayload(base)).toBe(false);
  });

  it('keeps away summaries limited to completed tasks with persisted evidence', () => {
    const completedAt = new Date().toISOString();
    expect(isVerifiedAutonomousHistoryItem({
      status: 'completed',
      result: 'Verified research result',
      toolCallsCount: 1,
      completedAt,
      finalized: true,
      blocked: false,
      verified: true,
    })).toBe(true);
    expect(isVerifiedAutonomousHistoryItem({
      status: 'completed',
      result: 'Text-only result',
      toolCallsCount: 0,
      completedAt,
      finalized: true,
      blocked: false,
      verified: true,
    })).toBe(false);
    expect(isVerifiedAutonomousHistoryItem({
      status: 'completed',
      result: 'Legacy unverified result',
      toolCallsCount: 1,
      completedAt,
    })).toBe(false);

    expect(normalizeAutonomousHistoryTask({
      id: 'legacy',
      title: 'Legacy',
      description: '',
      status: 'completed',
      source: 'curiosity',
      priority: 5,
      mode: 'analysis',
      createdAt: completedAt,
      completedAt,
      result: 'Old completion',
      toolCallsCount: 1,
    }).status).toBe('failed');
  });

});
