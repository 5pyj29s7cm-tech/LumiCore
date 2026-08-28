import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskCompletionFeedbackDetails } from '../src/components/TaskCompletionFeedbackDetails';
import { normalizeTaskCompletionFeedback } from '../src/components/workflowTypes';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('task completion feedback normalization', () => {
  it('keeps every bounded receipt-backed section and rejects unrelated payloads', () => {
    expect(normalizeTaskCompletionFeedback(null)).toBeUndefined();
    expect(normalizeTaskCompletionFeedback({ unrelated: true })).toBeUndefined();
    expect(normalizeTaskCompletionFeedback({
      status: 'blocked',
      completed: ['Saved draft', 'Saved draft'],
      evidence: ['tool:write_file'],
      incomplete: ['Publish remains incomplete'],
      blockers: ['Approval required'],
      nextSteps: ['Request approval'],
    })).toEqual({
      status: 'blocked',
      completed: ['Saved draft'],
      evidence: ['tool:write_file'],
      incomplete: ['Publish remains incomplete'],
      blockers: ['Approval required'],
      nextSteps: ['Request approval'],
    });
  });

  it('maps unknown backend statuses to an honest unknown state', () => {
    expect(normalizeTaskCompletionFeedback({ status: 'surprising', evidence: [] })?.status).toBe('unknown');
  });
});

describe('task completion feedback details', () => {
  it('renders completed items, machine evidence, incomplete items, blockers, and next steps', () => {
    const markup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="en"
        feedback={{
          status: 'blocked',
          completed: ['Draft saved'],
          evidence: ['Verified tool receipt: write_file'],
          incomplete: ['Publication not verified'],
          blockers: ['Approval required'],
          nextSteps: ['Ask the owner to approve publication'],
        }}
      />,
    );

    for (const section of ['completed', 'evidence', 'incomplete', 'blockers', 'nextSteps']) {
      expect(markup).toContain(`data-task-feedback-section="${section}"`);
    }
    expect(markup).toContain('Completed items');
    expect(markup).toContain('Machine evidence');
    expect(markup).toContain('Incomplete items');
    expect(markup).toContain('Blockers');
    expect(markup).toContain('Next steps');
    expect(markup).toContain('Verified tool receipt: write_file');
  });

  it('states missing evidence explicitly instead of implying verification', () => {
    const markup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="zh"
        feedback={{ status: 'working', completed: [], evidence: [], incomplete: [], blockers: [], nextSteps: [] }}
      />,
    );
    expect(markup).toContain('暂无机器证据。');
    expect(markup).toContain('执行中');
  });

  it('keeps successful task evidence out of the conversational surface', () => {
    const markup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="zh"
        variant="chat"
        feedback={{
          status: 'completed',
          completed: ['文件已保存'],
          evidence: ['Verified tool receipt: write_file request=req_internal_123'],
          incomplete: [],
          blockers: [],
          nextSteps: [],
        }}
      />,
    );

    expect(markup).toBe('');
    expect(markup).not.toContain('Verified tool receipt');
    expect(markup).not.toContain('req_internal_123');
  });

  it('keeps cancelled feedback out of the conversational surface', () => {
    const markup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="en"
        variant="chat"
        feedback={{
          status: 'cancelled',
          completed: [],
          evidence: ['internal cancellation receipt'],
          incomplete: [],
          blockers: [],
          nextSteps: [],
        }}
      />,
    );

    expect(markup).toBe('');
    expect(markup).not.toContain('internal cancellation receipt');
  });

  it('renders working feedback as one compact line without raw evidence', () => {
    const markup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="en"
        variant="chat"
        feedback={{
          status: 'working',
          completed: [],
          evidence: ['internal request req_private_456'],
          incomplete: ['A background step is still running'],
          blockers: [],
          nextSteps: [],
        }}
      />,
    );

    expect(markup).toContain('data-task-completion-feedback="working"');
    expect(markup).toContain('data-task-feedback-attention');
    expect(markup).not.toContain('req_private_456');
    expect(markup).not.toContain('<details');
  });

  it('keeps failed and confirmation-blocked chat outcomes visible in the compact summary', () => {
    const waitingMarkup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="zh"
        variant="chat"
        feedback={{
          status: 'blocked',
          completed: [],
          evidence: ['tool:publish'],
          incomplete: ['发布尚未完成'],
          blockers: ['User confirmation required before publication'],
          nextSteps: ['等待用户确认'],
        }}
      />,
    );
    const failedMarkup = renderToStaticMarkup(
      <TaskCompletionFeedbackDetails
        locale="en"
        variant="chat"
        feedback={{
          status: 'failed',
          completed: [],
          evidence: [],
          incomplete: [],
          blockers: ['The target application did not respond'],
          nextSteps: [],
        }}
      />,
    );

    expect(waitingMarkup).toContain('等待确认');
    expect(waitingMarkup).toContain('需要你确认后才能继续');
    expect(waitingMarkup).not.toContain('tool:publish');
    expect(failedMarkup).toContain('Failed');
    expect(failedMarkup).toContain('data-task-feedback-attention');
    expect(failedMarkup).toContain('The task needs attention');
    expect(failedMarkup).not.toContain('The target application did not respond');
    expect(failedMarkup).not.toContain('<details');
  });
});

describe('task feedback frontend wiring', () => {
  it('consumes structured feedback in autonomous and command-center details', () => {
    const feed = source('src/components/AutonomousFeed.tsx');
    const panel = source('src/components/CommandCenterPanel.tsx');
    const planner = source('src/components/CommandCenterPlanner.tsx');
    const chat = source('src/components/AgentChatPage.tsx');
    const desktop = source('src/components/DesktopUI.tsx');

    expect(feed).toContain('completionFeedback: normalizeTaskCompletionFeedback(data.completionFeedback)');
    expect(feed).toContain('<TaskCompletionFeedbackDetails');
    expect(panel).toContain('data-command-center-tasks');
    expect(panel).toContain('<TaskCompletionFeedbackDetails feedback={task.completionFeedback}');
    expect(planner).toContain('data-command-center-task-details');
    expect(planner).toContain('completionFeedback: normalizeTaskCompletionFeedback(task.completionFeedback)');
    expect(chat).toContain('normalizeTaskCompletionFeedback(data.completionFeedback)');
    expect(chat).toContain('variant="chat"');
    expect(desktop).toContain('normalizeTaskCompletionFeedback(raw?.completionFeedback || data?.completionFeedback)');
  });
});
