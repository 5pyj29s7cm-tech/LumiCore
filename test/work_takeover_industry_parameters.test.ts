import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { analyzeWechatIntake } from '../server/work_takeover/wechat_intake';
import { planWorkTakeoverExecution } from '../server/work_takeover/execution_planner';
import { verifyWorkTakeoverResult } from '../server/work_takeover/result_verifier';
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
  it('keeps legal takeover labels on semi-automatic filing collaboration', () => {
    const root = process.cwd();
    const sourcePaths = [
      'server/work_takeover/industry_standards.ts',
      'server/work_takeover/tasks.ts',
      'server/work_takeover/wechat_intake.ts',
      'server/work_takeover/execution_planner.ts',
    ];
    const sources = sourcePaths.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/(?:label|legal_case):\s*['"]\u81ea\u52a8\u7acb\u6848/);
    }
    expect(sources.join('\n')).toContain('\u534a\u81ea\u52a8\u7acb\u6848');
    expect(sources.join('\n')).toContain('\u534a\u81ea\u52a8\u7acb\u6848/\u6cd5\u5f8b\u6750\u6599\u5305');
  });

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
    expect(plan.capabilities.map(capability => capability.id)).toContain('ecommerce.operations');
    expect(plan.capabilities.flatMap(capability => capability.tools)).toEqual(expect.arrayContaining([
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_content-ops_short_video_script',
      'generate_video',
      'mcp_playwright_browser_snapshot',
    ]));
    expect(plan.capabilities.flatMap(capability => capability.tools).join('\n')).not.toMatch(/work_takeover_task_prepare_/);
  });

  it('does not treat a local scripted package as an ecommerce outcome', () => {
    const message = '客户微信：接管抖店账号，主推商品：空气炸锅，预算500元，目标今天完成短视频脚本、图文提示词、发布草稿和微信客服回复，先别正式发布。';
    const task: WorkTakeoverTask = {
      ...makeTaskFromIntake(message),
      result: '本地任务包和模板草稿已经生成。',
    };

    const scripted = verifyWorkTakeoverResult(task, {
      draftRequired: true,
      requireExternalOutcome: true,
      outcomeEvidence: [{
        id: 'legacy-package',
        name: 'legacy_scripted_ecommerce_package',
        arguments: { productName: '空气炸锅' },
        result: '{"artifactReady":true,"completionEligible":false}',
      }],
    });
    expect(scripted.checks.find(check => check.id === 'business_outcome_evidence')?.passed).toBe(false);
    expect(scripted.status).toBe('blocked');

    const realTools = verifyWorkTakeoverResult(task, {
      draftRequired: true,
      requireExternalOutcome: true,
      outcomeEvidence: [{
        id: 'listing',
        name: 'mcp_ecommerce-ops_product_listing_optimizer',
        arguments: { productName: '空气炸锅', platform: '抖店', constraints: '预算500元，先别正式发布' },
        result: '{"titleOptions":["空气炸锅 | 家庭快手餐"],"sellingPoints":["基于实际商品信息完善"]}',
      }, {
        id: 'script',
        name: 'mcp_content-ops_short_video_script',
        arguments: { topic: '空气炸锅真实使用场景', platform: '抖店' },
        result: '{"hook":"下班后十分钟完成晚餐","shots":["商品与食材实拍"],"caption":"先保存，发布前复核库存"}',
      }],
    });
    expect(realTools.checks.find(check => check.id === 'business_outcome_evidence')?.passed).toBe(true);
  });
});
