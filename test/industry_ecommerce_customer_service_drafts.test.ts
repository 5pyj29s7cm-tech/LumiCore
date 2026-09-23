import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeEcommerceCustomerServiceDrafts } from '../server/industry/ecommerce_customer_service_drafts';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';

beforeAll(async () => {
  await initDatabase();
});

const prompt = '内容与客服实机验收：仅使用以下已脱敏事实，不发送消息、不发布内容、不退款、不承诺赔偿。客户代号=C-***17；订单代号=O-***88；商品=DESK-01桌面收纳架；客户问题=收到后发现尺寸放不下，询问能否退款并补偿运费；店铺规则=签收7天内、未安装且包装完整可申请退货，运费承担需人工审核；品牌语气=简洁、诚恳、不承诺未批准结果。请分类工单、验证规则和隐私、生成客服回复草稿与一条不含承诺的FAQ内容草稿，列出风险、升级条件、持久任务编号和审批边界。';

describe('masked ecommerce customer-service drafts', () => {

  it('persists conditional, privacy-safe drafts without an external action', () => {
    const userId = `customer_service_${Date.now()}`;
    const receipt = executeEcommerceCustomerServiceDrafts({
      userId,
      domain: 'personal',
      requestId: `customer_service_request_${Date.now()}`,
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
      draftOnly: true,
      privacyVerified: true,
      snapshot: {
        customerAlias: 'C-***17',
        orderAlias: 'O-***88',
        product: 'DESK-01桌面收纳架',
      },
    });
    expect(receipt.message).toContain('客服回复草稿（未发送）');
    expect(receipt.message).toContain('FAQ 内容草稿（未发布）');
    expect(receipt.message).toContain('运费由谁承担以及是否补偿，均需人工审核');
    expect(receipt.message).toContain('无法预先承诺结果');
    expect(receipt.message).toContain('不要在公开渠道发送姓名、电话、详细地址');
    expect(receipt.message).toContain('本轮未执行上述任何动作');
    expect(receipt.message).not.toContain('已退款');
    expect(receipt.message).not.toContain('保证补偿');

    const task = getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, receipt.taskId);
    expect(task?.status).toBe('delivered');
    expect(task?.metadata?.workTakeoverVerification?.passed).toBe(true);
  });
});
