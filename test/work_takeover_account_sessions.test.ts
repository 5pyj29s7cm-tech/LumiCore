import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeWechatIntake } from '../server/work_takeover/wechat_intake';
import { planWorkTakeoverExecution } from '../server/work_takeover/execution_planner';
import { verifyWorkTakeoverResult } from '../server/work_takeover/result_verifier';
import type { WorkTakeoverTask } from '../server/work_takeover/tasks';

function makeTask(overrides: Partial<WorkTakeoverTask> = {}): WorkTakeoverTask {
  const now = new Date('2026-07-03T00:00:00.000Z').toISOString();
  return {
    id: 'task_account_session',
    userId: 'user',
    domain: 'personal',
    orgId: 'personal',
    title: '接管店铺账号运营',
    category: 'account',
    source: 'wechat',
    status: 'queued',
    urgency: 'normal',
    priority: 50,
    sourceMessage: '客户说抖店后台和微信都已经登录着，先做短视频发布清单和客服回复草稿。',
    summary: '接管已登录的店铺账号，准备内容发布和客服承接。',
    recommendedWorkflow: 'account_operations_takeover',
    nextActions: ['恢复已登录抖店后台', '准备内容/投放执行清单', '生成微信回复草稿'],
    currentActionIndex: 0,
    drafts: [],
    artifacts: [],
    allowedNow: ['恢复已登录账号窗口', '准备草稿'],
    confirmationRequired: ['正式发布前确认'],
    blockedBy: [],
    risks: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    events: [],
    ...overrides,
  };
}

describe('work takeover account session reuse', () => {
  it('marks logged-in app sessions as usable while gating login and sending', () => {
    const intake = analyzeWechatIntake({
      message: '抖店和微信都已经登录在电脑上了，帮我接管账号运营，准备短视频发布和客服回复。',
      source: 'wechat',
      takeoverMode: 'account',
    });

    expect(intake.allowedNow).toEqual(expect.arrayContaining([
      '打开或恢复已经登录的微信、浏览器、店铺后台或创作平台窗口',
    ]));
    expect(intake.confirmationRequired.join('；')).toContain('首次登录');
    expect(intake.confirmationRequired.join('；')).toContain('验证码');
    expect(intake.draftReply).toContain('已登录');
    expect(intake.safety).toContain('already logged-in');
  });

  it('selects reusable account sessions in the execution plan', () => {
    const plan = planWorkTakeoverExecution(makeTask(), { mode: 'visible_external_work' });

    expect(plan.capabilities.map(capability => capability.id)).toContain('account.session_reuse');
    expect(plan.confirmationRequired.join('；')).toContain('首次登录');
    expect(plan.contextSignals.join('；')).toContain('industryStandard=账号运营接管');
    expect(plan.handoffPrompt).toContain('行业接管标准：账号运营接管');
    expect(plan.handoffPrompt).toContain('外部系统优先');
    expect(plan.handoffPrompt).toContain('优先恢复任务栏/后台已有窗口');
    expect(plan.verificationChecklist.join('；')).toContain('已优先复用已登录账号窗口');

    const externalStep = plan.steps.find(step => step.id === 'external_tool_handoff');
    expect(externalStep?.goal).toContain('优先恢复已登录会话');
    expect(externalStep?.suggestedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'web_login_profile_list',
    ]));
  });

  it('verifies real desktop result signals before claiming success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_wt_verify_'));
    try {
      const reportPath = path.join(dir, '账号运营清单.txt');
      fs.writeFileSync(reportPath, '内容/投放任务清单', 'utf8');
      const task = makeTask({
        result: '已准备账号运营清单和微信草稿。',
        drafts: [{
          id: 'draft_1',
          channel: 'wechat',
          text: '收到，我先准备账号运营清单。',
          status: 'draft',
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
        }],
        artifacts: [{
          id: 'artifact_1',
          type: 'document',
          label: '账号运营清单',
          path: reportPath,
          status: 'prepared',
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
        }],
      });

      const verification = verifyWorkTakeoverResult(task, {
        activeWindowRaw: JSON.stringify({ title: '微信', process_name: 'Weixin', pid: 51208 }),
        runningProcessesRaw: JSON.stringify([{ name: 'Weixin', pid: 51208 }]),
        expectedSurfaces: ['wechat'],
        draftRequired: true,
      });

      expect(verification.passed).toBe(true);
      expect(verification.detectedSurfaces).toContain('wechat');
      expect(verification.checks.every(check => check.passed)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
