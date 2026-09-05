import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCommandCenterTask } from '../src/components/CommandCenterPanel';
import { TaskCompletionFeedbackDetails } from '../src/components/TaskCompletionFeedbackDetails';
import { RuntimeEvidencePanel, runtimeReceiptPublicText } from '../src/components/RuntimeEvidencePanel';
import {
  customerVisibleTaskStatus,
  projectTaskCompletionFeedbackForCustomer,
} from '../src/components/workflowTypes';
import { resetLocaleForTests, setLocale } from '../src/i18n/runtime';
import type { StructuredRuntimeStatus } from '../src/hooks/useRuntimeStatus';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

afterEach(() => resetLocaleForTests());

describe('command-center customer projection', () => {
  it('maps machine lifecycle states to localized customer labels', () => {
    expect(customerVisibleTaskStatus('waiting_confirmation', 'en')).toBe('Awaiting confirmation');
    expect(customerVisibleTaskStatus('desktop_target_mismatch', 'en')).toBe('No status yet');
    expect(customerVisibleTaskStatus('paused', 'zh')).toBe('\u5df2\u6682\u505c');
  });

  it('summarizes completion feedback without tool, target, or verifier internals', () => {
    const projected = projectTaskCompletionFeedbackForCustomer({
      status: 'blocked',
      completed: ['desktop_open result=C:\\private\\customer.docx'],
      evidence: ['toolName=desktop_open taskId=task-private targetIdentity=C:\\private\\customer.docx'],
      incomplete: ['checkpoint=verify target_mismatch'],
      blockers: ['Desktop execution ended as target_mismatch.'],
      nextSteps: ['desktop_active_window arguments={"secret":"value"}'],
    }, 'en');

    expect(projected).toEqual(expect.objectContaining({
      status: 'blocked',
      evidence: ['1 result confirmed'],
    }));
    const rendered = JSON.stringify(projected);
    for (const internal of [
      'desktop_open',
      'desktop_active_window',
      'task-private',
      'targetIdentity',
      'target_mismatch',
      'customer.docx',
      '"secret"',
    ]) expect(rendered).not.toContain(internal);
  });

  it('projects command-center task copy while retaining lifecycle fields for controls', () => {
    const task = normalizeCommandCenterTask({
      taskId: 'task-private-id',
      title: 'Review customer report',
      status: 'running',
      phase: 'desktop_verification_checkpoint',
      blocker: 'desktop_open failed: target_mismatch',
      nextAction: 'desktop_active_window reason=target_mismatch',
      completionFeedback: {
        status: 'failed',
        evidence: ['toolName=desktop_open', 'toolName=desktop_active_window', 'toolName=desktop_read_text_file'],
        blockers: ['target_mismatch'],
      },
    }, 'en');

    expect(task).toMatchObject({
      id: 'task-private-id',
      status: 'running',
      phase: 'desktop_verification_checkpoint',
      title: 'Review customer report',
    });
    expect(JSON.stringify({
      blocker: task?.blocker,
      nextAction: task?.nextAction,
    })).not.toMatch(/desktop_|target_mismatch|toolName|task-private/iu);
    const feedbackMarkup = renderToStaticMarkup(<TaskCompletionFeedbackDetails feedback={task?.completionFeedback} locale="en" />);
    expect(feedbackMarkup).toContain('3 results confirmed');
    expect(feedbackMarkup).not.toMatch(/desktop_|target_mismatch|toolName|task-private/iu);
  });

  it('renders runtime evidence without task, target, tool, outcome, or raw blocker identifiers', () => {
    setLocale('en');
    const status: StructuredRuntimeStatus = {
      schemaVersion: 1,
      snapshotId: 'snapshot-private-id',
      generatedAt: '2026-09-05T00:00:00.000Z',
      scope: { domain: 'personal', orgId: '' },
      level: 'attention',
      attentionReasons: ['private_attention_reason'],
      counts: {
        activeTasks: 1,
        waitingConfirmation: 0,
        blockedTasks: 1,
        verifiedReceipts: 0,
        failedReceipts: 1,
        unknownReceipts: 0,
        backgroundActive: 0,
        autonomousActive: 0,
        durableBlocked: 0,
      },
      tasks: [{
        taskId: 'task-private-id',
        parentTaskId: '',
        goal: 'Review customer report',
        target: 'C:\\private\\customer.docx',
        intentKind: 'desktop_operation',
        operation: 'mutate',
        status: 'blocked',
        blocker: 'desktop_open failed: target_mismatch',
        activeRequest: false,
        completionSource: 'desktop_execution_plan_receipt',
        revision: 1,
        updatedAt: '2026-09-05T00:00:00.000Z',
        focus: {
          schemaVersion: 1,
          threadId: 'thread-private-id',
          taskId: 'task-private-id',
          evidenceTaskId: 'task-private-id',
          goal: 'Review customer report',
          status: 'blocked',
          commitment: 'Review customer report',
          nextAction: 'desktop_active_window checkpoint=verify',
          waitingFor: '',
          interruption: 'target_mismatch',
          resumePoint: 'desktop_active_window',
          dueAt: '',
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
        evidence: {
          total: 1,
          verified: 0,
          failed: 1,
          unknown: 0,
          latest: [{
            receiptId: 'receipt-private-id',
            taskId: 'task-private-id',
            toolName: 'desktop_open',
            targetIdentity: 'C:\\private\\customer.docx',
            outcome: 'target_mismatch',
            verification: 'failed',
            requestId: 'request-private-id',
            idempotencyRef: 'idempotency-private-id',
            createdAt: '2026-09-05T00:00:00.000Z',
          }],
        },
      }],
      durableWork: [],
      runtime: {},
      safety: {
        externalCommitConfirmationRequired: true,
        unknownExternalOutcomeReplayBlocked: true,
        legacyExternalFallbackDisabled: true,
        payloadsExcluded: true,
      },
    };

    const markup = renderToStaticMarkup(<RuntimeEvidencePanel status={status} />);
    expect(markup).toContain('Review customer report');
    expect(markup).toContain('window no longer matched the target');
    for (const internal of [
      'snapshot-private-id',
      'task-private-id',
      'receipt-private-id',
      'request-private-id',
      'desktop_open',
      'desktop_active_window',
      'target_mismatch',
      'customer.docx',
      'private_attention_reason',
      'desktop_execution_plan_receipt',
    ]) expect(markup).not.toContain(internal);
  });

  it('never echoes a receipt outcome directly', () => {
    const publicText = runtimeReceiptPublicText({
      receiptId: 'receipt', taskId: 'task', toolName: 'desktop_open', targetIdentity: 'private',
      outcome: 'target_mismatch', verification: 'failed', requestId: 'request', idempotencyRef: 'key', createdAt: '',
    }, 'en');
    expect(publicText).toContain('window no longer matched the target');
    expect(publicText).not.toContain('target_mismatch');
    expect(publicText).not.toContain('desktop_open');
  });
});

describe('command-center rendering contracts', () => {
  it('uses customer projections and avoids duplicate raw blocker cards', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const planner = source('src/components/CommandCenterPlanner.tsx');
    const evidence = source('src/components/RuntimeEvidencePanel.tsx');

    expect(panel).not.toContain('>{task.phase}<');
    expect(panel).not.toContain('task.progress?.checkpoint ?');
    expect(panel).toContain('task.blocker && !task.completionFeedback');
    expect(planner).toContain('normalizeTaskCompletionFeedback(task.completionFeedback)');
    expect(source('src/components/TaskCompletionFeedbackDetails.tsx')).toContain('projectTaskCompletionFeedbackForCustomer(normalizedInput, locale)');
    expect(planner).toContain('task.blocker && !task.completionFeedback');
    expect(evidence).not.toContain('{receipt.toolName}');
    expect(evidence).not.toContain('{receipt.outcome}');
    expect(evidence).not.toContain('font-mono">{task.taskId}');
    expect(evidence).not.toContain('{receipt.targetIdentity}');
  });
});
