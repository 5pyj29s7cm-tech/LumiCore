import './helpers';
import { describe, expect, it } from 'vitest';
import {
  evaluateAutonomousTaskOutcome,
  isSuccessfulAutonomousToolRecord,
} from '../server/autonomy/task_executor';
import { isVerifiedAutonomousHistoryItem } from '../server/socket/ambient';
import { finalizeScheduledDelivery } from '../server/scheduler';
import {
  classifyToolNotification,
} from '../src/components/ProactiveNotifications';
import {
  isVerifiedAutonomousCompletionPayload,
  normalizeAutonomousHistoryTask,
} from '../src/components/AutonomousFeed';

describe('remaining output bypass closure', () => {
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

  it('does not convert every tool result into a success notification', () => {
    expect(classifyToolNotification({
      name: 'desktop_open',
      arguments: {},
      result: 'Opened request returned',
    }).state).toBe('result');
    expect(classifyToolNotification({
      name: 'desktop_open',
      arguments: {},
      result: JSON.stringify({ status: 'pending' }),
    }).state).toBe('blocked');
    expect(classifyToolNotification({
      name: 'desktop_open',
      arguments: {},
      result: JSON.stringify({ ok: true, status: 'verified' }),
    }).state).toBe('verified');
    expect(classifyToolNotification({
      name: 'desktop_open',
      arguments: {},
      error: 'not found',
    }).state).toBe('failed');
  });
});
