import { describe, expect, it } from 'vitest';
import {
  buildTaskCapsuleV1,
  classifyTaskCapsuleTurn,
  formatTaskCapsuleForPrompt,
  updateTaskCapsuleV1,
  type DurableTaskCapsuleSource,
} from '../server/conversation/task_capsule';

const NOW = '2026-08-27T02:30:00.000Z';
const WRONG_PATH = 'C:\\Users\\Administrator\\Desktop\\旧版路演.pptx';

function wpsSource(overrides: Partial<DurableTaskCapsuleSource> = {}): DurableTaskCapsuleSource {
  return {
    taskId: 'task-wps-analysis',
    revision: 4,
    status: 'blocked',
    unfinished: true,
    goal: '分析桌面上的 Lumia 路演资料，并整理五项结论。',
    latestInstruction: '不是这份 PPT。',
    appTarget: 'WPS',
    sourcePaths: [WRONG_PATH],
    latestBlocker: '用户指出当前打开的文件不是目标文件。',
    toolSummaries: ['desktop_open | outcome=success | token=must-not-survive'],
    receipts: [
      {
        id: 'receipt-open-wrong',
        key: 'desktop_open:wrong',
        name: 'desktop_open',
        arguments: { target: WRONG_PATH, apiKey: 'not-a-target-field' },
        result: JSON.stringify({ ok: true, rawSecret: 'raw-result-must-not-survive' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'visual',
          reason: 'window matched the requested path',
        },
        recordedAt: '2026-08-27T02:28:00.000Z',
      },
      {
        id: 'receipt-read-page-count',
        key: 'wps_read_presentation:page-count',
        name: 'wps_read_presentation',
        arguments: { mode: 'page_count' },
        result: JSON.stringify({ ok: true, pages: 17, notes: 'large raw payload is omitted' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'page count returned',
        },
        recordedAt: '2026-08-27T02:29:00.000Z',
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

describe('TaskCapsuleV1', () => {
  it('rebuilds a stable corrected target from durable state without raw tool results', () => {
    const capsule = buildTaskCapsuleV1(wpsSource(), {
      currentTurnText: '文件在桌面，叫 Lumia_路演资料.ppt。',
      observedAt: NOW,
    });

    expect(capsule).not.toBeNull();
    expect(capsule).toMatchObject({
      schemaVersion: 1,
      taskId: 'task-wps-analysis',
      revision: 4,
      goal: '分析桌面上的 Lumia 路演资料，并整理五项结论。',
      currentInstruction: '文件在桌面，叫 Lumia_路演资料.ppt。',
      target: {
        label: 'Lumia_路演资料.ppt',
        path: 'Lumia_路演资料.ppt',
        application: 'WPS',
        location: 'desktop',
        status: 'candidate',
        source: 'user_correction',
      },
      latestCorrection: {
        previousTarget: WRONG_PATH,
        replacementTarget: 'Lumia_路演资料.ppt',
      },
    });
    expect(capsule?.rejectedTargets.map(item => item.identity)).toContain(WRONG_PATH);
    expect(capsule?.doNotRetry.map(item => item.fingerprint)).toContain(
      'target:c:/users/administrator/desktop/旧版路演.pptx',
    );
    expect(capsule?.completedSteps.map(step => step.toolName)).toEqual(['wps_read_presentation']);

    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain('raw-result-must-not-survive');
    expect(serialized).not.toContain('not-a-target-field');
    expect(serialized).not.toContain('must-not-survive');
    expect(serialized).toContain('[REDACTED]');
  });

  it('updates corrections, rejected targets, and exact do-not-retry routes immutably', () => {
    const initial = buildTaskCapsuleV1(wpsSource({
      latestInstruction: '分析这份 PPT。',
      toolSummaries: [],
    }))!;
    const updated = updateTaskCapsuleV1(initial, {
      instruction: '不是旧版路演.pptx，改成 Lumia_路演资料.ppt。',
      correction: {
        text: '不是旧版路演.pptx，改成 Lumia_路演资料.ppt。',
        target: 'Lumia_路演资料.ppt',
        path: 'Lumia_路演资料.ppt',
        rejectCurrentTarget: true,
        observedAt: NOW,
      },
      doNotRetry: [{
        fingerprint: 'desktop_open:wrong',
        reason: 'The exact wrong-file open route already succeeded on the wrong target.',
        observedAt: NOW,
      }],
      updatedAt: NOW,
    });

    expect(initial.target.path).toBe(WRONG_PATH);
    expect(updated.target.path).toBe('Lumia_路演资料.ppt');
    expect(updated.latestCorrection?.previousTarget).toBe(WRONG_PATH);
    expect(updated.rejectedTargets).toContainEqual(expect.objectContaining({ identity: WRONG_PATH }));
    expect(updated.doNotRetry).toContainEqual(expect.objectContaining({ fingerprint: 'desktop_open:wrong' }));
  });

  it('does not bind ordinary conversational negation to an unfinished task', () => {
    const state = wpsSource();
    expect(classifyTaskCapsuleTurn('不是这份 PPT。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('不是旧版路演.pptx，改成 Lumia_路演资料.ppt。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('不要用这份 PPT。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('文件在桌面，叫 Lumia_路演资料.ppt。', state)).toBe('target_detail');
    expect(classifyTaskCapsuleTurn('Lumia_路演资料.ppt', state)).toBe('target_detail');
    expect(classifyTaskCapsuleTurn('不是，我想问你今天怎么样？', state)).toBe('none');
    expect(classifyTaskCapsuleTurn('不对，我想问的是你自己的看法。', state)).toBe('none');
    expect(classifyTaskCapsuleTurn('Lumia_路演资料.ppt', { ...state, unfinished: false })).toBe('none');

    const rejectOnly = buildTaskCapsuleV1(state, {
      currentTurnText: '不要用这份 PPT。',
      observedAt: NOW,
    });
    expect(rejectOnly?.target).toMatchObject({ path: WRONG_PATH, status: 'rejected' });
    expect(rejectOnly?.latestCorrection?.replacementTarget).toBe('');
  });

  it('formats a bounded receipt-backed prompt capsule', () => {
    const capsule = buildTaskCapsuleV1(wpsSource(), {
      currentTurnText: '文件在桌面，叫 Lumia_路演资料.ppt。',
      observedAt: NOW,
    })!;
    const prompt = formatTaskCapsuleForPrompt(capsule);

    expect(prompt).toContain('Current task capsule (TaskCapsuleV1):');
    expect(prompt).toContain('- goal: 分析桌面上的 Lumia 路演资料，并整理五项结论。');
    expect(prompt).toContain('- target: Lumia_路演资料.ppt');
    expect(prompt).toContain('- completedSteps (receipt-backed only):');
    expect(prompt).toContain('- rejectedTargets:');
    expect(prompt).toContain('- doNotRetry:');
    expect(prompt).not.toContain('raw-result-must-not-survive');
    expect(prompt.length).toBeLessThan(10_000);
  });
});
