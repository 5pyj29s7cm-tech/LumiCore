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
    expect(panel).toContain('data-command-center-background-tasks');
    expect(panel).toContain('<TaskCompletionFeedbackDetails feedback={task.completionFeedback}');
    expect(planner).toContain('data-command-center-task-details');
    expect(planner).toContain('completionFeedback: normalizeTaskCompletionFeedback(task.completionFeedback)');
    expect(chat).toContain('normalizeTaskCompletionFeedback(raw?.completionFeedback || data?.completionFeedback)');
    expect(desktop).toContain('normalizeTaskCompletionFeedback(raw?.completionFeedback || data?.completionFeedback)');
  });
});
