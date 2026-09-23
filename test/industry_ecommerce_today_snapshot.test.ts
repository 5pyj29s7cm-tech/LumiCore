import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeEcommerceTodaySnapshot } from '../server/industry/ecommerce_today_snapshot';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

describe('source-bound ecommerce today snapshot', () => {
  it('persists a verified snapshot without inventing absent profit inputs', () => {
    const userId = 'today_snapshot_' + Date.now();
    const receipt = executeEcommerceTodaySnapshot({
      userId,
      domain: 'personal',
      requestId: 'today_snapshot_request_' + Date.now(),
      conversationId: '',
      taskId: '',
      source: 'test',
      actionIntent: '请为“稳定性验收店”执行今日经营分析。数据期间是2026年8月15日，币种CNY：订单120单，销售额36000元，广告花费7200元，退款金额3600元，售后8单；SKU-A库存6件，SKU-B库存80件。只处理这组验收数据，不连接或修改真实店铺，不编造缺失指标。',
    } as any);

    expect(receipt).toMatchObject({
      ok: true,
      status: 'verified',
      persisted: true,
      sourceBound: true,
      externalMutation: false,
      snapshot: {
        revenue: 36000,
        orders: 120,
        averageOrderValue: 300,
        adSpend: 7200,
        adSpendRate: 20,
        roas: 5,
        refundAmount: 3600,
        refundAmountRate: 10,
        afterSalesCount: 8,
        afterSalesRate: 6.67,
      },
    });
    expect(receipt.missingMetrics).toEqual(expect.arrayContaining(['商品成本', '物流成本', '平台费/佣金']));
    expect(receipt.message).toContain('不计算毛利或贡献利润');
    expect(receipt.message).toContain('未连接、修改或向真实店铺提交任何操作');
    expect(receipt.message).not.toContain('-18,000');

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });
});
