import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { executeEcommerceStoreDataSnapshot } from '../server/industry/ecommerce_store_data_snapshot';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

const prompt = '店铺数据实机验收：仅使用以下内联记录，不读取外部平台。平台=抖音小店；期间=2026-08-01至2026-08-07；币种=CNY；销售额=12000元；订单数=200单；广告花费=2400元；退款数=10单；退款金额=600元；SKU A01库存=30件，日均销量=6件；SKU B02库存=8件，日均销量=4件。请保留字段映射和计算公式，计算客单价、退款率、广告投入产出和库存可售天数，列出缺失字段、异常与风险，生成持久任务编号。只读分析，不修改店铺。';

describe('source-bound ecommerce store-data snapshot', () => {

  it('uses only current inline fields and settles the persistent workflow', () => {
    const userId = `store_data_snapshot_${Date.now()}`;
    const conversationTaskId = `conversation_task_${Date.now()}`;
    const receipt = executeEcommerceStoreDataSnapshot({
      userId,
      domain: 'personal',
      requestId: `store_data_request_${Date.now()}`,
      conversationId: '',
      taskId: conversationTaskId,
      source: 'test',
      actionIntent: prompt,
    } as any);

    expect(receipt).toMatchObject({
      ok: true,
      status: 'verified',
      persisted: true,
      sourceBound: true,
      externalMutation: false,
      snapshot: {
        platform: '抖音小店',
        reportingPeriod: '2026-08-01 至 2026-08-07',
        currency: 'CNY',
        revenue: 12000,
        orders: 200,
        averageOrderValue: 60,
        refundCount: 10,
        refundRate: 5,
        refundAmount: 600,
        refundAmountRate: 5,
        adSpend: 2400,
        roas: 5,
        inventory: [
          { sku: 'A01', stock: 30, dailySales: 6, daysCover: 5 },
          { sku: 'B02', stock: 8, dailySales: 4, daysCover: 2 },
        ],
      },
    });
    expect(receipt.conversationTaskId).toEqual(expect.any(String));
    expect(receipt.message).toContain('客单价 = 销售额 ÷ 订单数');
    expect(receipt.message).toContain('A01：30 ÷ 6.00 = 5.00 天');
    expect(receipt.message).toContain('B02：8 ÷ 4.00 = 2.00 天');
    expect(receipt.message).toContain('没有读取旧工作区');
    expect(receipt.message).not.toContain('稳定性验收店');
    expect(receipt.missingFields).toEqual(expect.arrayContaining(['时区', '商品成本', '物流成本', '平台费/佣金']));

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });

  it('replays the same request idempotently without duplicate runs, artifacts, or receipts', () => {
    const suffix = Date.now();
    const userId = `store_data_replay_${suffix}`;
    const requestId = `store_data_same_request_${suffix}`;
    const conversationTaskId = `conversation_task_replay_${suffix}`;
    const context = {
      userId,
      domain: 'personal',
      requestId,
      conversationId: '',
      taskId: conversationTaskId,
      source: 'test',
      actionIntent: prompt,
    } as any;

    const first = executeEcommerceStoreDataSnapshot(context);
    const firstTask = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, first.taskId)!;
    const firstRunCount = firstTask.metadata.workTakeoverToolRuns.filter((run: any) => (
      run.id === `industry-store-data-${requestId}`
    )).length;
    const firstArtifactCount = firstTask.artifacts.length;
    const firstVerificationId = firstTask.metadata.workTakeoverVerification.verificationId;
    const firstReceiptCount = readDB().conversationActionReceipts.filter((receipt: any) => (
      receipt.taskId === first.conversationTaskId
    )).length;

    const replayed = executeEcommerceStoreDataSnapshot({
      ...context,
      industryWorkflowTaskId: first.taskId,
    });
    const replayedTask = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, first.taskId)!;
    const replayedReceiptCount = readDB().conversationActionReceipts.filter((receipt: any) => (
      receipt.taskId === first.conversationTaskId
    )).length;

    expect(replayed.taskId).toBe(first.taskId);
    expect(replayed.status).toBe('verified');
    expect(firstRunCount).toBe(1);
    expect(firstArtifactCount).toBeGreaterThan(0);
    expect(firstReceiptCount).toBe(1);
    expect(replayedTask.metadata.workTakeoverToolRuns.filter((run: any) => (
      run.id === `industry-store-data-${requestId}`
    ))).toHaveLength(1);
    expect(replayedTask.artifacts).toHaveLength(firstArtifactCount);
    expect(replayedTask.metadata.workTakeoverVerification.verificationId).toBe(firstVerificationId);
    expect(replayedReceiptCount).toBe(firstReceiptCount);
  });
});
