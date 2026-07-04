import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeWechatIntake } from '../server/work_takeover/wechat_intake';
import { planWorkTakeoverExecution } from '../server/work_takeover/execution_planner';
import { verifyWorkTakeoverResult } from '../server/work_takeover/result_verifier';
import { createEcommerceGrowthFiles } from '../server/skills/bundled/ecommerce-ops/workflows/ecommerce_growth_workflow';
import type { WorkTakeoverTask } from '../server/work_takeover/tasks';

function makeTaskFromIntake(message: string): WorkTakeoverTask {
  const intake = analyzeWechatIntake({
    message,
    source: 'wechat',
    takeoverMode: 'auto',
  });
  const now = new Date('2026-07-03T00:00:00.000Z').toISOString();
  return {
    id: 'task_industry_params',
    userId: 'user',
    domain: 'personal',
    orgId: 'personal',
    title: '接管电商短视频任务',
    category: intake.category,
    source: 'wechat',
    status: 'queued',
    urgency: intake.urgency,
    priority: 60,
    contact: intake.contact,
    sourceMessage: message,
    summary: intake.summary,
    recommendedWorkflow: intake.recommendedWorkflow,
    nextActions: intake.nextActions,
    currentActionIndex: 0,
    drafts: [{
      id: 'draft_1',
      channel: 'wechat',
      text: intake.draftReply,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }],
    artifacts: intake.artifactsToPrepare.map((label, index) => ({
      id: `artifact_${index}`,
      type: 'checklist',
      label,
      status: 'planned',
      createdAt: now,
      updatedAt: now,
    })),
    allowedNow: intake.allowedNow,
    confirmationRequired: intake.confirmationRequired,
    blockedBy: intake.blockedBy,
    risks: [],
    metadata: {
      industryParameters: intake.parameters,
    },
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

describe('work takeover industry parameterization', () => {
  it('extracts ecommerce and short-video parameters from a customer message', () => {
    const message = '客户微信：帮我接管抖店账号，主推商品：空气炸锅，预算500元，目标今天做短视频脚本、图文提示词、发布草稿和微信客服回复，先别正式发布。';
    const intake = analyzeWechatIntake({ message, source: 'wechat', takeoverMode: 'auto' });

    expect(['store', 'account', 'video_publish']).toContain(intake.category);
    expect(intake.parameters.productName).toContain('空气炸锅');
    expect(intake.parameters.platform).toBe('抖店');
    expect(intake.parameters.budgetLabel).toContain('500');
    expect(intake.parameters.deliverableFlags.needsVideo).toBe(true);
    expect(intake.parameters.deliverableFlags.needsImageText).toBe(true);
    expect(intake.parameters.deliverableFlags.needsPublishDraft).toBe(true);
    expect(intake.parameters.deliverableFlags.needsWechatReply).toBe(true);
    expect(intake.parameters.requiredArtifactLabels).toEqual(expect.arrayContaining([
      '短视频脚本',
      '图文/图片生成提示词',
      '发布草稿/发布确认项',
      '微信/客服回复草稿',
    ]));

    const task = makeTaskFromIntake(message);
    const plan = planWorkTakeoverExecution(task, { mode: 'visible_external_work' });
    expect(plan.contextSignals.join('；')).toContain('空气炸锅');
    expect(plan.verificationChecklist.join('；')).toContain('任务参数关键词');
    expect(plan.capabilities.map(capability => capability.id)).toContain('video.content_publish_pack');
    expect(plan.capabilities.flatMap(capability => capability.tools)).toContain('work_takeover_task_prepare_industry_package');
    expect(plan.capabilities.flatMap(capability => capability.tools)).not.toContain('work_takeover_task_prepare_ecommerce_growth');
  });

  it('creates and verifies a parameterized ecommerce growth package', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_ecommerce_params_'));
    try {
      const message = '客户微信：接管抖店账号，主推商品：空气炸锅，预算500元，目标今天完成短视频脚本、图文提示词、发布草稿和微信客服回复。';
      const task = makeTaskFromIntake(message);
      const files = createEcommerceGrowthFiles(message, { outputDirectory: dir });
      const updatedTask: WorkTakeoverTask = {
        ...task,
        result: `已生成电商交付包：${files.folder}`,
        artifacts: [
          ...task.artifacts,
          {
            id: 'artifact_pkg',
            type: 'file',
            label: '电商/短视频接管交付包',
            path: files.folder,
            content: `商品：${files.brief.productName}；平台：${files.brief.platform}`,
            status: 'prepared',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          {
            id: 'artifact_matrix',
            type: 'document',
            label: '内容矩阵',
            path: files.contentMatrixCsv,
            status: 'prepared',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          {
            id: 'artifact_script',
            type: 'video',
            label: '短视频脚本',
            path: files.videoScriptHtml,
            status: 'prepared',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
        ],
      };

      expect(files.verificationResult.passed).toBe(true);
      expect(fs.existsSync(files.contentMatrixCsv)).toBe(true);
      expect(fs.readFileSync(files.taskJson, 'utf8')).toContain('空气炸锅');

      const verification = verifyWorkTakeoverResult(updatedTask, {
        expectedContentTerms: updatedTask.metadata.industryParameters.expectedContentTerms,
        requiredArtifactLabels: ['内容矩阵', '短视频脚本'],
        draftRequired: true,
        requireScreenEvidence: false,
      });

      expect(verification.passed).toBe(true);
      expect(verification.checks.find(check => check.id === 'artifact_content_quality')?.passed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
