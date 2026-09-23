import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeEcommerceListingActionQueue } from '../server/industry/ecommerce_listing_action_queue';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

const prompt = '商品管理实机验收：仅使用以下内联SKU事实，生成可审核动作队列，不执行上架、下架、改价或发布。SKU=DESK-01；售价=59元；单位成本=25元；单位运费=6元；平台费率=5%；库存=12件；日均销量=4件；供货提前期=5天；安全库存天数=3天；近30天订单=100单；退款=8单；主要退款原因=尺寸不符。请计算单位贡献毛利和退款率，判断断货与合规风险，给出标题/卖点草稿、动作优先级、证据缺口、持久任务编号和逐项审批边界。';

describe('source-bound ecommerce listing action queue', () => {

  it('calculates the SKU facts and persists a review-only verified queue', () => {
    const userId = `listing_queue_${Date.now()}`;
    const receipt = executeEcommerceListingActionQueue({
      userId,
      domain: 'personal',
      requestId: `listing_queue_request_${Date.now()}`,
      conversationId: '',
      taskId: '',
      source: 'test',
      actionIntent: prompt,
    } as any);

    expect(receipt).toMatchObject({
      ok: true,
      status: 'verified',
      persisted: true,
      sourceBound: true,
      externalMutation: false,
      actionQueueOnly: true,
      snapshot: {
        sku: 'DESK-01',
        price: 59,
        unitCost: 25,
        unitShipping: 6,
        platformFeeRate: 5,
        platformFee: 2.95,
        unitContributionProfit: 25.05,
        stock: 12,
        dailySales: 4,
        daysCover: 3,
        leadTimeDays: 5,
        safetyStockDays: 3,
        requiredCoverDays: 8,
        reorderPoint: 32,
        suggestedOrderQty: 20,
        orders: 100,
        refunds: 8,
        refundRate: 8,
        refundReason: '尺寸不符',
      },
    });
    expect(receipt.message).toContain('单位贡献毛利');
    expect(receipt.message).toContain('25.05 元');
    expect(receipt.message).toContain('退款率 8.00%');
    expect(receipt.message).toContain('所有动作均为待审核草稿');
    expect(receipt.message).toContain('未上架、下架、改价、发布');
    expect(receipt.evidenceGaps).toContain('实际长宽高/适配尺寸及测量证据');

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });
});
