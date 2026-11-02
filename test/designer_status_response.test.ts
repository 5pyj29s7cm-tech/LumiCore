import { describe, expect, it } from 'vitest';
import { formatVerifiedDesignProjectStatus } from '../server/design/status_response';

describe('designer status response', () => {
  it('renders exact CAD ledger fields from a verified receipt without model reinterpretation', () => {
    const text = formatVerifiedDesignProjectStatus({
      name: 'interior_design_project_status',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        status: 'observed',
        persisted: true,
        project: { id: 'project-1', name: '\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85' },
        workflow: {
          nextStage: 'visualization',
          stages: {
            project: { status: 'completed', verificationStatus: 'passed' },
            cad: {
              status: 'completed',
              verificationStatus: 'passed',
              currentTaskId: 'wt_task_cad',
              blocker: '',
              artifacts: [{ path: 'D:\\evidence\\verified.dxf' }],
            },
            visualization: { status: 'not_started', verificationStatus: '' },
          },
        },
      }),
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'ledger read' },
    }, '\u67e5\u8be2 CAD \u65b9\u6848\u9636\u6bb5\u72b6\u6001\u3001\u5f53\u524d\u4efb\u52a1 ID\u548c\u4e0b\u4e00\u9636\u6bb5');

    expect(text).toContain('CAD \u65b9\u6848\uff1a\u5df2\u5b8c\u6210');
    expect(text).toContain('\u9a8c\u8bc1\u72b6\u6001\uff1a\u5df2\u901a\u8fc7');
    expect(text).toContain('wt_task_cad');
    expect(text).toContain('D:\\evidence\\verified.dxf');
    expect(text).toContain('\u4e0b\u4e00\u9636\u6bb5\uff1a\u6548\u679c\u56fe\uff08\u672a\u5f00\u59cb\uff09');
  });

  it('rejects an unverified status record', () => {
    expect(formatVerifiedDesignProjectStatus({
      name: 'interior_design_project_status',
      arguments: {},
      result: '{}',
      terminalVerification: { status: 'failed', strategy: 'measured', reason: 'failed' },
    }, 'CAD status')).toBeNull();
  });

  it('renders a provider billing blocker as concise Chinese without leaking an internal URL', () => {
    const text = formatVerifiedDesignProjectStatus({
      name: 'interior_design_project_status',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        persisted: true,
        project: { id: 'project-2', name: '\u9879\u76ee\u4e8c' },
        workflow: {
          nextStage: 'visualization',
          stages: {
            visualization: {
              status: 'blocked',
              verificationStatus: 'blocked',
              currentTaskId: 'wt_task_visual',
              blocker: 'Image generation failed: DashScope image error (Arrearage): Access denied, overdue payment. https://example.invalid/error',
              artifacts: [],
            },
          },
        },
      }),
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'ledger read' },
    }, '\u6548\u679c\u56fe\u9636\u6bb5\u72b6\u6001');

    expect(text).toContain('DashScope\uff08\u901a\u4e49\u4e07\u76f8\uff09\u8d26\u6237\u6b20\u8d39');
    expect(text).toContain('\u5df2\u505c\u6b62\u81ea\u52a8\u91cd\u8bd5');
    expect(text).not.toContain('https://');
  });

  it('renders a workflow prerequisite blocker as natural Chinese stage names', () => {
    const text = formatVerifiedDesignProjectStatus({
      name: 'interior_design_project_status',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        persisted: true,
        project: { id: 'project-3', name: '\u9879\u76ee\u4e09' },
        workflow: {
          nextStage: 'presentation',
          stages: {
            presentation: {
              status: 'blocked',
              verificationStatus: 'blocked',
              currentTaskId: 'wt_task_ppt',
              blocker: 'Design stage presentation is blocked until verified upstream stages complete: visualization.',
              artifacts: [],
            },
          },
        },
      }),
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'ledger read' },
    }, '\u63d0\u6848 PPT \u9636\u6bb5\u72b6\u6001');

    expect(text).toContain('\u63d0\u6848 PPT \u7684\u524d\u7f6e\u9636\u6bb5\u5c1a\u672a\u901a\u8fc7\uff1a\u6548\u679c\u56fe');
    expect(text).toContain('\u5f53\u524d\u5df2\u505c\u6b62\u6267\u884c');
    expect(text).not.toContain('Design stage');
  });

  it('does not insert an English-style space before the possessive marker for a Chinese-only stage label', () => {
    const text = formatVerifiedDesignProjectStatus({
      name: 'interior_design_project_status',
      arguments: {},
      result: JSON.stringify({
        ok: true,
        persisted: true,
        project: { id: 'project-4', name: '\u9879\u76ee\u56db' },
        workflow: {
          nextStage: 'visualization',
          stages: {
            handoff: {
              status: 'blocked',
              verificationStatus: 'blocked',
              blocker: 'Design stage handoff is blocked until verified upstream stages complete: visualization, presentation.',
              artifacts: [],
            },
          },
        },
      }),
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'ledger read' },
    }, '\u4ea4\u4ed8\u4e2d\u5fc3\u9636\u6bb5\u72b6\u6001');

    expect(text).toContain('\u4ea4\u4ed8\u4e2d\u5fc3\u7684\u524d\u7f6e\u9636\u6bb5');
    expect(text).not.toContain('\u4ea4\u4ed8\u4e2d\u5fc3 \u7684');
  });
});
